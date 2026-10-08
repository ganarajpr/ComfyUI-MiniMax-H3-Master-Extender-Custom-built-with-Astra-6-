// Speaker attribution in code (E4.1). A planned speaker that is heard but not seen in its shot (an off-screen or unseen voice, a narrator,
// a voice-over, a voice on a phone, radio, speaker or intercom, a voice from behind a door or from below) is its own entity, a "voice", with its own
// dialogue-ledger id and its own subject definition. It is never mapped to a cast member who is on screen. This file holds the class rule,
// the plan -> entity resolution, the plan-versus-prompt attribution check and the deterministic re-tag fallback.
import { tokensOf } from './lib.mjs';
import { musicLikeHits } from './soundvocab.mjs';

// Terms that mark a speaker STRING as heard-but-not-seen.
const SPEAKER_CUE = /\b(?:voice|voices|voice-?over|v\.?o\.?|off-?screen|off-?camera|off-?stage|unseen|narrat\w*|announcer|caller|dispatcher|radio|phone|telephone|intercom|loudspeaker|tannoy|speakerphone|broadcast|recording|answering machine)\b/i;
// Phrases in a planned shot's text that put the source of a line out of frame.
const SOURCE_CUE = /\b(?:unseen|off-?screen|off-?camera|out of (?:frame|sight|view)|from (?:below|behind|above|beyond|outside|within|the dark|the next room|another room|the other (?:side|end|room))|through (?:a|the) (?:door|wall|floor|ceiling|speaker|receiver|phone|radio|line)|over (?:a|the) (?:phone|radio|intercom|speaker|line|loudspeaker|tannoy|wire)|on the (?:phone|line|radio|intercom)|voice-?over|narrat\w+)\b|\b(?:a|an|another|some)\s+(?:[a-z-]+\s+){0,3}voices?\b/i;
const STOP = new Set('the and for with from that this into onto over under after before while where when then than they them their there here have has had been were was are his her its our out off who whom will would could should about above each other some such only just also very more most one two not but nor yet'.split(' '));
const words = (s) => tokensOf(s, 3).filter((w) => !STOP.has(w));
const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim();

export const voicesOf = (bible) => (Array.isArray(bible?.voices) ? bible.voices : []);
const castWords = (c) => new Set([...words(c.name), ...words(String(c.id).replace(/_/g, ' ')), ...words(c.appearsAs)]);

// True when the speaker string itself names the cast member (name, id or the words that describe the person).
export function namesCast(speakerString, cast) {
  const w = new Set(words(speakerString));
  for (const x of castWords(cast)) if (w.has(x)) return true;
  return false;
}

// The heard-but-not-seen cue of a planned line: the speaker string's own cue, else a source cue in the shot's text when no cast member is named.
export function offscreenCue(speakerString, shotText, bible) {
  const own = SPEAKER_CUE.exec(String(speakerString || ''));
  if (own) return own[0];
  const src = SOURCE_CUE.exec(String(shotText || ''));
  if (src && !(bible?.cast || []).some((c) => namesCast(speakerString, c))) return src[0];
  return null;
}

// A line is off-screen when its speaker is a voice, or when it is a cast member the shot's subject does not name and the shot's text puts the source out of frame.
// The subject field of a planned shot is what is on screen, so a cast member named there is visible even when the line comes from a phone or a radio.
export function lineOffscreen(shot, speakerId, bible) {
  if (voicesOf(bible).some((v) => v.id === speakerId)) return { offscreen: true, voice: true };
  const cast = (bible?.cast || []).find((c) => c.id === speakerId);
  if (!cast) return { offscreen: false, voice: false };
  const named = namesCast(shot.subject || '', cast);
  return { offscreen: !named && SOURCE_CUE.test(`${shot.subject || ''} ${shot.action || ''}`), voice: false };
}

// Plan speaker string -> entity id (a cast id or a voice id), or null. The bible's map first, then a name match.
export function resolveSpeaker(bible, speakerString) {
  const cast = bible?.cast || [], voices = voicesOf(bible);
  const ids = new Set([...cast, ...voices].map((e) => e.id));
  const mapped = bible?.speakers?.[speakerString];
  if (ids.has(mapped)) return mapped;
  const n = norm(speakerString).toLowerCase();
  const byName = (list) => list.find((c) => c.id === n || String(c.name).toLowerCase() === n || tokensOf(c.name, 3).includes(n))?.id || null;
  return byName(cast) || byName(voices);
}

export const plannedLines = (plan) => [...plan.clips].sort((a, b) => a.clip - b.clip).flatMap((clip) => clip.shots.flatMap((s, idx) => (s.dialogue?.line ? [{ clip: clip.clip, cut: idx + 1, speakerString: s.dialogue.speaker || '', text: s.dialogue.line, shotText: `${s.subject || ''} ${s.action || ''}` }] : [])));

// Class rule over the plan and the bible: a line whose speaker is heard-but-not-seen must not map to a cast member the speaker string does not name.
export function speakerIssues(plan, bible) {
  const issues = [];
  const castById = new Map((bible.cast || []).map((c) => [c.id, c]));
  const seen = new Set();
  for (const l of plannedLines(plan)) {
    const id = resolveSpeaker(bible, l.speakerString);
    const cue = offscreenCue(l.speakerString, l.shotText, bible);
    const key = `${l.speakerString}|${id}`;
    if (!cue || !castById.has(id) || namesCast(l.speakerString, castById.get(id)) || seen.has(key)) continue;
    seen.add(key);
    issues.push(`"speakers"[${JSON.stringify(l.speakerString)}] = ${JSON.stringify(id)} but the plan marks this speaker as heard and not seen ("${cue}"). A speaker that is heard but not seen gets its OWN entry in "voices" and maps to that voice id; it never maps to the on-screen cast member ${JSON.stringify(id)}`);
  }
  return issues;
}

// A voice's fields go into the subject definition and the writer's entity list: a word that asserts an absence there is read as something to draw or is cut by the lint.
export const MAX_VOICE_CHARS = 260;
const ABSENCE = /\b(?:unseen|invisible|off-?screen|no|not|never|without|none|nothing|nobody)\b|n't\b/i;
export function voiceFieldIssues(v, where) {
  const musical = ['appearsAs', 'voicePrompt'].flatMap((k) => { const h = musicLikeHits(String(v?.[k] || ''), 'detailedDescription').filter((x) => !/^tones?$/i.test(x.word))[0]; return h ? [`${where}.${k}: uses the music-like word "${h.word}", which H3 hears as a score; describe the voice by age, register, pace and accent, and where it is heard from by its physical source`] : []; });
  const long = String(v?.voicePrompt || '').length > MAX_VOICE_CHARS ? [`${where}.voicePrompt: ${String(v.voicePrompt).length} characters, maximum ${MAX_VOICE_CHARS}; keep it short so the speaker id and the voice phrase fit in the stretch before the line`] : [];
  return [...long, ...musical, ...['appearsAs', 'voicePrompt'].flatMap((k) => { const m = ABSENCE.exec(String(v?.[k] || '')); return m ? [`${where}.${k}: uses the absence word "${m[0]}"; describe the voice only by what it sounds like and where it is heard from`] : []; })];
}

// ---- the check: every planned line's speaker in the final prompt is the plan's speaker ----
// E4.6 (issues #8, #9 of the horror review): (Sx) identifies the SPEAKER (one id per voice for the whole film, the order of first speaking), not the line.
// A speaker with a picture is written "<Subject N> (Sx)"; a voice with no picture is "a voice description (Sx), off-screen, says:" with no <Subject N>
// (ref guide 5.4); a pictured character who speaks from out of frame keeps "<Subject N> (Sx)" and is marked off-screen.
const tagsOf = (dd) => [...String(dd || '').matchAll(/<d>\[[^\]]*\]\s*([\s\S]*?)<\/d>/g)].map((m) => ({ index: m.index, end: m.index + m[0].length, text: norm(m[1]) }));
const WINDOW = 400;
export const OFFSCREEN_MARK = /\boff-?screen\b/i;
export const sidOf = (line) => line.sid || line.id;
const SENTENCE_END = /[.!?]["\u201d\u2019)]*\s+(?=[A-Z<\["(\u201c])/g;

// The tag of each planned line, in order: index for index when the counts agree (two speakers may say the same words), else the next unused tag with the line's text.
function alignTags(tags, lines) {
  if (tags.length === lines.length) return lines.map((_, i) => i);
  let from = 0;
  return lines.map((l) => { const k = tags.findIndex((t, i) => i >= from && t.text === norm(l.text)); if (k >= 0) from = k + 1; return k; });
}

// the stretch before a line that names its speaker: at most WINDOW characters, never reaching back into the previous line
const winStart = (tags, k) => Math.max(0, tags[k].index - WINDOW, k > 0 ? tags[k - 1].end : 0);

// the words of the sentence that holds the line, up to the tag
export function sentenceBefore(dd, tags, k) {
  const seg = dd.slice(winStart(tags, k), tags[k].index);
  const m = [...seg.matchAll(SENTENCE_END)].pop();
  return m ? seg.slice(m.index + m[0].length) : seg;
}

function speakerAt(dd, tags, k) {
  const tag = tags[k];
  const win = dd.slice(winStart(tags, k), tag.index);
  const sids = [...win.matchAll(/\(S(\d+)\)/g)];
  const sid = sids.length ? sids[sids.length - 1] : null;
  const upto = sid ? win.slice(0, sid.index) : win;
  const tok = [...upto.matchAll(/<Subject (\d+)>/g)].pop() || null;
  return { sid: sid ? `S${sid[1]}` : null, subject: tok ? Number(tok[1]) : null };
}

// One row per planned line of the clip: what the plan says, what the ledger says, what the written prompt says.
export function speakerAttribution({ plan, bible, shot, prose }) {
  const dd = String(prose.detailedDescription || '');
  const tags = tagsOf(dd);
  const planned = plannedLines(plan).filter((l) => l.clip === shot.clipNumber);
  const castById = new Map((bible.cast || []).map((c) => [c.id, c]));
  const slot = alignTags(tags, shot.lines);
  return shot.lines.map((line, i) => {
    const p = planned[i] || {};
    const expected = resolveSpeaker(bible, p.speakerString);
    const k = slot[i];
    const at = k >= 0 ? speakerAt(dd, tags, k) : { sid: null, subject: null };
    const tokenEntity = at.subject ? shot.references[at.subject - 1]?.id || null : null;
    const isVoice = !!line.voice;
    const problems = [];
    if (!expected) problems.push('the plan speaker does not resolve to a cast member or a voice');
    else if (line.speaker !== expected) problems.push(`the ledger speaker ${line.speaker} is not the plan speaker ${expected}`);
    else if (!isVoice && !shot.references.some((r) => r.id === expected)) problems.push(`${expected} is not a reference of this clip`);
    const cue = expected ? offscreenCue(p.speakerString, p.shotText, bible) : null;
    if (cue && castById.has(expected) && !namesCast(p.speakerString, castById.get(expected)) && !line.offscreen) problems.push(`the plan speaker is heard and not seen ("${cue}") but is attributed to the on-screen character ${expected}`);
    if (k < 0) problems.push('the line is not in the prompt');
    else {
      const prefix = sentenceBefore(dd, tags, k);
      if (isVoice) { if (/<Subject \d+>/.test(prefix)) problems.push('the line of a voice names a <Subject> in its sentence; a voice has no picture and is written as a voice description followed by its speaker id'); }
      else if (expected && tokenEntity !== expected) problems.push(`the prompt attributes the line to ${tokenEntity || 'nobody'}, the plan says ${expected}`);
      if (at.sid !== sidOf(line)) problems.push(`the prompt marks the line ${at.sid || 'with no speaker id'}, the speaker id is ${sidOf(line)}`);
      if (line.offscreen && !OFFSCREEN_MARK.test(prefix)) problems.push('the line is spoken off-screen but its sentence does not say off-screen');
    }
    return { line: line.id, sid: sidOf(line), clip: shot.clipNumber, cut: line.cut, planSpeaker: p.speakerString ?? null, expected, ledgerSpeaker: line.speaker, voice: isVoice, offscreen: !!line.offscreen, promptSubject: at.subject, promptEntity: tokenEntity, promptId: at.sid, ok: !problems.length, problems };
  });
}

// Findings in the audit's own shape, so the existing targeted repair (mapFindings -> repairOnce) takes them unchanged.
export function attributionFindings(rows, shot, prose) {
  const tags = tagsOf(prose.detailedDescription);
  const slot = alignTags(tags, shot.lines);
  return rows.filter((r) => !r.ok && r.expected).flatMap((r) => {
    const n = slot[shot.lines.findIndex((l) => l.id === r.line)] + 1;
    if (!n) return [];
    const idx = shot.references.findIndex((x) => x.id === r.expected);
    if (r.voice) return [{ src: 'gate', code: 'DIALOGUE_VOICE_FORM', message: `<d> #${n} (ledger id "${r.line}") is a voice line written wrongly: ${r.problems.join('; ')}`, hint: `write it as "a <voice description> (${r.sid}), off-screen, says: <d>...</d>" in one sentence that holds no <Subject N> token; the voice is not a Subject` }];
    return [{ src: 'gate', code: 'DIALOGUE_SPEAKER_MISMATCH', message: `<d> #${n} (ledger id "${r.line}") is attributed to ${r.promptEntity || 'nobody'} and the plan's speaker is "${r.expected}"`, hint: `write ${idx >= 0 ? `<Subject ${idx + 1}>` : `the subject "${r.expected}"`} (${r.sid})${r.offscreen ? ', off-screen,' : ''} as the speaker of this line; nobody else speaks it` }];
  });
}

// Deterministic fallback: put the planned speaker's token (a picture's subject) or its voice phrase, the speaker id and, when the line is off-screen, the word off-screen in front of the line.
export function retagSpeakers(prose, shot, rows) {
  let dd = String(prose.detailedDescription || '');
  const log = [];
  for (const r of [...rows].reverse()) {
    if (r.ok || !r.expected) continue;
    const idx = shot.references.findIndex((x) => x.id === r.expected);
    const line = shot.lines.find((l) => l.id === r.line);
    const tags = tagsOf(dd);
    const k = alignTags(tags, shot.lines)[shot.lines.findIndex((l) => l.id === r.line)];
    if ((idx < 0 && !line.voice) || k < 0 || k === undefined) continue;
    const tag = tags[k];
    const tk = line.voice ? null : `<Subject ${idx + 1}>`;
    const start = winStart(tags, k);
    let win = dd.slice(start, tag.index);
    const off = line.offscreen ? ', off-screen,' : '';
    const sids = [...win.matchAll(/\(S\d+\)/g)];
    if (sids.length) {
      const sd = sids[sids.length - 1];
      let head = win.slice(0, sd.index), rest = win.slice(sd.index + sd[0].length);
      const t = [...head.matchAll(/<Subject \d+>/g)].pop();
      if (tk) head = t ? `${head.slice(0, t.index)}${tk}${head.slice(t.index + t[0].length)}` : `${head}${tk} `;
      else if (t) head = `${head.slice(0, t.index)}${(line.voicePhrase || 'a voice').trim()}${head.slice(t.index + t[0].length)}`;
      if (off && !OFFSCREEN_MARK.test(`${head}${rest}`)) rest = `${off}${rest.replace(/^\s*,/, '')}`;
      win = `${head}(${sidOf(line)})${rest}`;
    } else {
      const says = [...win.matchAll(/\b(?:says?|said)\b/gi)].pop();
      const lead = tk ? `${tk} (${sidOf(line)})${off}` : `${(line.voicePhrase || 'a voice').trim()} (${sidOf(line)})${off}`;
      win = says ? `${win.slice(0, says.index)}${lead} ${win.slice(says.index)}` : `${win.replace(/\s+$/, '')} ${lead} says: `;
    }
    dd = `${dd.slice(0, start)}${win}${dd.slice(tag.index)}`;
    log.push({ rule: 'speaker_retag', line: r.line, to: r.expected });
  }
  return { prose: { ...prose, detailedDescription: dd }, log };
}

// Check, then the existing targeted repair for a mismatch, then the deterministic re-tag. `repair` is hybrid3's repairOnce (injected so it can be stubbed).
export async function enforceAttribution({ plan, bible, shot, prose, sceneId, facts, repair, mapFindings, budget }) {
  const before = speakerAttribution({ plan, bible, shot, prose });
  const out = { before, after: before, prose, repairCalls: [], repaired: false, retagged: [] };
  if (before.every((r) => r.ok)) return out;
  let cur = prose, rows = before;
  const findings = attributionFindings(rows, shot, cur);
  const map = findings.length ? mapFindings(findings, cur, shot) : { targets: [] };
  if (map.targets.length && !(budget && budget.spent > budget.cap)) {
    const rr = await repair(cur, sceneId, map, facts, '');
    out.repairCalls.push(rr.call);
    if (rr.accepted) { cur = rr.newProse; out.repaired = true; }
    rows = speakerAttribution({ plan, bible, shot, prose: cur });
  }
  if (!rows.every((r) => r.ok)) {
    const t = retagSpeakers(cur, shot, rows);
    cur = t.prose; out.retagged = t.log;
    rows = speakerAttribution({ plan, bible, shot, prose: cur });
  }
  return { ...out, prose: cur, after: rows };
}

// ---- one id per speaker, the same in every clip (E4.6) ----
// lines: the film's ledger lines ({id, sid, speaker}); written: attribution rows of every clip ({expected, promptId, ok}); both are optional halves of the same check.
export function speakerIdIssues({ lines = [], written = [] }) {
  const issues = [];
  const bySpeaker = new Map(), bySid = new Map();
  const note = (speaker, sid, where) => { if (!speaker || !sid) return; (bySpeaker.get(speaker) || bySpeaker.set(speaker, new Map()).get(speaker)).set(sid, where); (bySid.get(sid) || bySid.set(sid, new Map()).get(sid)).set(speaker, where); };
  for (const l of lines) note(l.speaker, sidOf(l), `ledger line ${l.id}`);
  const first = [...new Set(lines.map((l) => l.speaker))];
  first.forEach((sp, i) => { const sids = [...(bySpeaker.get(sp)?.keys() || [])]; if (sids.length === 1 && sids[0] !== `S${i + 1}`) issues.push(`speaker ${sp} is ${sids[0]} but is number ${i + 1} to speak, so it must be S${i + 1}`); });
  for (const w of written) note(w.expected, w.promptId, `the prompt line ${w.line} of clip ${w.clip}`);
  for (const [sp, m] of bySpeaker) if (m.size > 1) issues.push(`speaker ${sp} carries more than one id: ${[...m.keys()].join(', ')}`);
  for (const [sid, m] of bySid) if (m.size > 1) issues.push(`id ${sid} is shared by speakers ${[...m.keys()].join(' and ')}`);
  return issues;
}
