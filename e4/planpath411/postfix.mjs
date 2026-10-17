// E4.11: what code can fix in a written clip, so that the repair call is left for what changes the picture. The findings come from the same validation the pipeline runs (hybrid46/validate.mjs);
// every fix here answers one finding code with the facts the film already holds (the dialogue ledger, the bible's voices and sides, the decided camera term, the carried state). Generic rules only.
// Each fix returns an edit { rule, ... }; the pipeline counts them by rule.
import { sentences } from '../hybrid3/lib.mjs';
import { protect, restore, segmentize, joinSegs, tidy, sentenceStillSound } from '../hybrid3/text.mjs';
import { negatedPresences } from './hybrid46/negation.mjs';
import { contentStems, stateContradictions } from './state.mjs';

const lcFirst = (t) => (t ? `${String(t).charAt(0).toLowerCase()}${String(t).slice(1)}` : t);
const tokenOf = (shot, id) => { const i = shot.references.findIndex((r) => r.id === id); return i === -1 ? null : `<Subject ${i + 1}>`; };
const tagsOf = (dd) => [...dd.matchAll(/<d>\[[^\]]*\]\s*[\s\S]*?<\/d>/g)];
const numOf = (f) => Number(/#(\d+)/.exec(f.message || '')?.[1] || 0);
const shotNo = (f) => Number(/\[Shot (\d+)\]/.exec(f.message || '')?.[1] || 0);

// a voice phrase short enough to sit in a sentence: its first sentence, cut at a comma when it runs long
export function voiceClause(voicePrompt) {
  let v = String(voicePrompt || '').replace(/\s+/g, ' ').trim().replace(/[.\s]+$/, '');
  if (!v) return '';
  v = v.split(/(?<=[.!?])\s+/)[0].replace(/[.\s]+$/, '');
  while (v.length > 150 && v.includes(',')) v = v.slice(0, v.lastIndexOf(',')).trim();
  return lcFirst(v);
}

// ---- 0. a line the writer split over two consecutive <d> tags (one per sentence): the tags are merged when together they spell exactly the ledger's line ----
const normT = (t) => String(t || '').replace(/\s+/g, ' ').trim();
function mergeSplitTags(dd, shot, edits) {
  const lines = shot.lines || [];
  let out = dd;
  for (let guard = 0; guard < 6; guard++) {
    const tags = [...out.matchAll(/<d>\[([^\]]*)\]\s*([\s\S]*?)<\/d>/g)];
    if (tags.length <= lines.length) break;
    let merged = false;
    for (let i = 0; i + 1 < tags.length && !merged; i++) {
      const a = tags[i], b = tags[i + 1], between = out.slice(a.index + a[0].length, b.index);
      if (between.length > 160 || /<d>/.test(between)) continue;
      const joined = normT(`${a[2]} ${b[2]}`);
      if (lines.some((l) => normT(l.text) === joined)) {
        out = `${out.slice(0, a.index)}<d>[${a[1]}] ${joined}</d>${out.slice(b.index + b[0].length)}`;
        edits.push({ rule: 'dialogue_tags_merged' });
        merged = true;
      }
    }
    if (!merged) break;
  }
  return out;
}

// ---- 1. a spoken line with no speaker id: the id goes after the speaker's own token nearest before the line (only when that token is in the window and no id stands after it) ----
function fixSpeakerId(dd, shot, f, edits) {
  const n = numOf(f), tag = tagsOf(dd)[n - 1], line = shot.lines[n - 1];
  if (!tag || !line) return dd;
  const tk = tokenOf(shot, line.speaker);
  if (!tk) return dd;
  const start = Math.max(0, tag.index - 400), win = dd.slice(start, tag.index), at = win.lastIndexOf(tk);
  if (at < 0 || /\(S\d+\)/.test(win.slice(at))) return dd;
  const pos = start + at + tk.length;
  edits.push({ rule: 'speaker_id_inserted_nearest_token', line: line.id });
  return `${dd.slice(0, pos)} (${line.sid})${dd.slice(pos)}`;
}

// ---- 2. a spoken line with no vocal identity: the speaker's own voice phrase (the bible's voicePrompt) goes after the (Sx) beside the line ----
function fixVocalIdentity(dd, shot, fix, f, edits) {
  const n = numOf(f), tag = tagsOf(dd)[n - 1], line = shot.lines[n - 1];
  if (!tag || !line) return dd;
  const voice = voiceClause(fix.film?.masters?.[line.speaker]?.voicePrompt || fix.voices?.[line.speaker]?.voicePrompt);
  if (!voice) return dd;
  const start = Math.max(0, tag.index - 300), win = dd.slice(start, tag.index);
  if (/voice of/i.test(win)) return dd;
  const marks = [...win.matchAll(/\(S\d+\)/g)];
  if (!marks.length) return dd;
  const m = marks[marks.length - 1], pos = start + m.index + m[0].length;
  const rest = dd.slice(pos), ins = `, in the voice of ${voice}`;
  edits.push({ rule: 'vocal_identity_inserted', line: line.id });
  return `${dd.slice(0, pos)}${ins}${/^\s*[,:]/.test(rest) ? '' : ','}${rest}`;
}

// ---- 3. a single or over-the-shoulder cut that does not say where the person stands, and where they look ----
function fixBlocking(dd, shot, fix, nShot, wantBlocking, wantEyeline, edits) {
  const marks = [...dd.matchAll(/\[Shot\s+(\d+)\]/g)];
  const at = marks.findIndex((m) => Number(m[1]) === nShot);
  if (at < 0) return dd;
  const segEnd = at + 1 < marks.length ? marks[at + 1].index : dd.length, seg = dd.slice(marks[at].index, segEnd);
  const sub = /<Subject (\d+)>/.exec(seg.slice(0, 300));
  if (!sub) return dd;
  const ref = shot.references[Number(sub[1]) - 1];
  if (!ref || ref.type !== 'character') return dd;
  const side = fix.continuity?.cast?.find((c) => c.id === ref.id)?.side === 'right' ? 'right' : 'left';
  const eye = side === 'left' ? 'RIGHT' : 'LEFT';
  const sent = sentences(seg)[0];
  if (!sent) return dd;
  const body = wantBlocking && wantEyeline ? `${sub[0]} holds frame ${side}, eyes toward off-frame ${eye}.` : wantBlocking ? `${sub[0]} holds frame ${side}.` : `${sub[0]} looks off-frame ${eye}.`;
  const pos = marks[at].index + seg.indexOf(sent) + sent.length;
  if (wantBlocking) edits.push({ rule: 'blocking_stated', cut: nShot });
  if (wantEyeline) edits.push({ rule: 'eyeline_stated', cut: nShot });
  return `${dd.slice(0, pos)} ${body}${dd.slice(pos)}`;
}

// ---- 4. a cut with no controlled camera term: the term the film decided for that cut ----
function fixCameraTerm(dd, nShot, term, edits) {
  const marks = [...dd.matchAll(/\[Shot\s+(\d+)\]/g)];
  const at = marks.findIndex((m) => Number(m[1]) === nShot);
  if (at < 0 || !term) return dd;
  const segEnd = at + 1 < marks.length ? marks[at + 1].index : dd.length, seg = dd.slice(marks[at].index, segEnd);
  const sent = sentences(seg)[0];
  if (!sent) return dd;
  const pos = marks[at].index + seg.indexOf(sent) + sent.length;
  edits.push({ rule: 'camera_term_added', cut: nShot, term });
  return `${dd.slice(0, pos)} The camera works as a ${term}.${dd.slice(pos)}`;
}

// ---- 5. a body-motion verb written as a negation ("the hands do not rise"): the positive form of the same thing ----
// [base verbs, plural, singular, past]
const NEG_VERBS = [
  [['move', 'stir', 'shift'], 'stay still', 'stays still', 'stayed still'],
  [['rise', 'lift'], 'stay low', 'stays low', 'stayed low'],
  [['waver', 'falter', 'tremble', 'shake'], 'hold steady', 'holds steady', 'held steady'],
  [['flinch'], 'stay steady', 'stays steady', 'stayed steady'],
  [['blink'], 'stay wide open', 'stays wide open', 'stayed wide open'],
  [['stop', 'pause'], 'keep going', 'keeps going', 'kept going'],
];
const NEG_RE = new RegExp(`\\b(do|does|did)(?:\\s+not|n['’]t)\\s+(${NEG_VERBS.flatMap((x) => x[0]).join('|')})(?=\\s*(?:[,.;:!?]|$)|\\s(?:and|but|as|while|until|when|even|at all)\\b)`, 'gi');
export function substituteNegation(sentence) {
  const P = protect(sentence);
  const out = P.text.replace(NEG_RE, (_, aux, verb) => {
    const row = NEG_VERBS.find((x) => x[0].includes(verb.toLowerCase()));
    return { do: row[1], does: row[2], did: row[3] }[aux.toLowerCase()];
  });
  if (out === P.text) return null;
  const text = restore(out, P.atoms);
  return negatedPresences(text).length < negatedPresences(sentence).length ? text : null;
}

// ---- 6. a sentence that states the opposite of a carried state in a clause of its own: the clause goes (never the main clause) ----
export function removeContradictingClause(sentence, option, carriedValue) {
  const P = protect(sentence), sg = segmentize(P.text);
  const mine = new Set(contentStems(carriedValue)), distinct = contentStems(option).filter((w) => !mine.has(w));
  if (!distinct.length || sg.segs.length < 2) return null;
  const hit = (s) => { const have = new Set(contentStems(restore(s, P.atoms))); return distinct.filter((w) => have.has(w)).length; };
  const need = Math.ceil(distinct.length / 2);
  const i = sg.segs.findIndex((s, k) => k > 0 && hit(s) >= need);
  if (i < 0 || (hit(sg.segs[0]) >= need)) return null;
  const next = { segs: [...sg.segs], delims: [...sg.delims], term: sg.term };
  next.segs.splice(i, 1); next.delims.splice(i - 1, 1);
  const text = tidy(restore(joinSegs(next), P.atoms));
  return sentenceStillSound(sentence, text) ? null : text;
}

function mapSentenceAt(prose, field, idx, fn) {
  const arr = sentences(prose[field]);
  if (arr[idx] === undefined) return null;
  const r = fn(arr[idx]);
  if (r === null || r === arr[idx]) return null;
  const at = String(prose[field]).indexOf(arr[idx]);
  if (at < 0) return null;
  return { ...prose, [field]: prose[field].slice(0, at) + r + prose[field].slice(at + arr[idx].length) };
}

// -> { prose, edits }
export function postFix({ fix, shot, prose, findings, moves = {} }) {
  const edits = [];
  let p = { ...prose };
  // sentence edits first (the findings carry sentence indices of the draft), then the insertions that add sentences
  for (const f of findings.filter((x) => x.src === 'lint' && x.code === 'negation' && x.idx !== undefined)) {
    const r = mapSentenceAt(p, f.field, f.idx, substituteNegation);
    if (r) { p = r; edits.push({ rule: 'negation_substituted', field: f.field }); }
  }
  const items = shot.state?.items || [];
  if (items.length) {
    for (const f of stateContradictions({ items, references: shot.references, prose: p })) {
      const it = items.find((x) => x.options.includes(f.match) && !x.planned);
      if (!it) continue;
      const r = mapSentenceAt(p, f.field, f.idx, (s) => removeContradictingClause(s, f.match, it.value));
      if (r) { p = r; edits.push({ rule: 'state_clause_removed', field: f.field }); }
    }
  }
  let dd = mergeSplitTags(String(p.detailedDescription || ''), shot, edits);
  const gate = (code) => findings.filter((f) => f.src === 'gate' && f.code === code);
  for (const f of gate('DIALOGUE_MISSING_SPEAKER_ID').sort((a, b) => numOf(b) - numOf(a))) dd = fixSpeakerId(dd, shot, f, edits);
  for (const f of gate('DIALOGUE_MISSING_VOCAL_IDENTITY').sort((a, b) => numOf(b) - numOf(a))) dd = fixVocalIdentity(dd, shot, fix, f, edits);
  const blocking = new Set(gate('BLOCKING_NOT_STATED').map(shotNo)), eyeline = new Set(gate('EYELINE_NOT_STATED').map(shotNo));
  for (const n of [...new Set([...blocking, ...eyeline])].sort((a, b) => b - a)) dd = fixBlocking(dd, shot, fix, n, blocking.has(n), eyeline.has(n), edits);
  for (const n of gate('CAMERA_MOTION_MISSING').map(shotNo).sort((a, b) => b - a)) dd = fixCameraTerm(dd, n, moves[n], edits);
  p.detailedDescription = dd;
  return { prose: p, edits };
}

// What a finding of each code means for the repair call (E4.11): only a finding that changes what the renderer shows or says is worth a model call; the rest are recorded as warnings.
export const WARN_ONLY = { lint: new Set(['negation', 'narration', 'label']), gate: new Set(['BLOCKING_NOT_STATED', 'EYELINE_NOT_STATED', 'DETAILED_DESCRIPTION_TOO_SHORT', 'DIALOGUE_MISSING_VOCAL_IDENTITY']) };
// A contradiction of a carried state changes the picture only when the sentence states (nearly) all the distinctive words of the other option: at least two, and at least three quarters of them.
// A sentence that shares one word with it ("open", "dry") is a coincidence of vocabulary and stays a warning. A speech-verb finding whose span is the dialogue line's own words is the line itself, not narration of speech.
export const strongContradiction = (f) => (f.hits ?? 0) >= 2 && (f.hits ?? 0) >= 0.75 * (f.distinct || 1);
const stripTags = (s) => normT(String(s || '').replace(/<\/?d>/g, ' ').replace(/\[[^\]]*\]/g, ' ').replace(/[."”]+$/g, ''));
export function isRepairWorthy(f, ctx = {}) {
  if (WARN_ONLY[f.src] && WARN_ONLY[f.src].has(f.code)) return false;
  if (f.code === 'state_contradiction') return strongContradiction(f);
  if (f.code === 'SPEECH_WITHOUT_WORDS') {
    const span = stripTags(f.span);
    if (span && (ctx.lineTexts || []).some((t) => normT(t).includes(span))) return false;
  }
  return true;
}
