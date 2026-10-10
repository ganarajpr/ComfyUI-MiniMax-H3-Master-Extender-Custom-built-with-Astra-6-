// A long film must not fail. Everything in E4.8 that grows with the length of the story is bounded here, and a call that still fails is split smaller instead of raised:
//   - planFilm:   a story whose estimated clip count fits one reply is planned in ONE call exactly as E4.8 does (same request, same file names). A longer one is split at paragraph /
//                 sentence boundaries into parts of about SEG_CLIPS clips; each part is its own planner call that is told how the film so far ended, which ledger entities and speaker
//                 strings exist, and is checked by the planner's own checks; the parts are merged with global clip numbers and the film-level checks run on the merged plan. A part
//                 whose planner reply cannot be used (cut twice at the largest cap, or not JSON twice) is split in two and each half planned in its own call, down to MIN_PART_WEIGHT.
//                 Every part is stored (plan_parts/) and a resumed run does not plan a stored part again.
//   - bibleFilm:  a plan made in parts gets its bible in the same groups (story slice + that part's asks + the entities already defined), merged and validated as one bible.
//   - writerContext / refContext: the writer's and the reference repair's prompts quote every clip's ask and the whole story; past a budget they quote the nearby clips in full, the
//                 others by beat, and the story part the clip belongs to.
// A short story takes the same path and makes the same requests as before (the tests prove it).
import { join } from 'node:path';
import { existsSync, mkdirSync } from 'node:fs';
import { call, wr, rj, parseJsonReply, parseJsonLoose, cutNote } from '../planpath48/lib.mjs';
import { planStory, parseBreakdown, PlanError, checkBreakdown, rawAskForClip, formatEndState, foldLedger } from '../planpath48/planner.mjs';
import { planSpeechIssues } from '../planpath48/utterance.mjs';
import { sequenceIssues } from '../planpath48/sequence.mjs';
import { planStateIssues } from '../planpath48/state.mjs';
import { repairJson } from '../planpath48/jsonrepair.mjs';
import { makeBible, buildBibleMessages, normalizeBible, validateBible, plannedSpeakers } from '../planpath48/bible.mjs';
import { estimatePromptTokens } from '../planpath48/transport.mjs';

export const LATIN_CHARS_PER_CLIP = 700, WIDE_CHARS_PER_CLIP = 380;   // measured: 5,273 Devanagari-heavy characters were planned as 12 clips (about 440 a clip)
const envNumber = (name, fallback) => { const v = Number(process.env[name]); return Number.isFinite(v) && v > 0 ? v : fallback; };
export const SINGLE_MAX_CLIPS = envNumber('E4_PLAN_SINGLE_MAX', 14);   // up to this estimate the story is planned in one call, as E4.8 does
export const SEG_CLIPS = envNumber('E4_PLAN_SEG_CLIPS', 8);           // a part of a longer story is about this many clips
export const MIN_PART_WEIGHT = 1.5;     // a part is never split below this many estimated clips
export const WRITER_CONTEXT_TOKENS = 14000;   // past this the writer's story + film plan are windowed
export const NEAR_CLIPS = 3;            // clips this near the one being written are quoted in full

const isWide = (cp) => cp >= 0x250;
export function weightOf(text) {
  let latin = 0, wide = 0;
  for (const ch of String(text ?? '')) { if (isWide(ch.codePointAt(0))) wide += 1; else latin += 1; }
  return latin / LATIN_CHARS_PER_CLIP + wide / WIDE_CHARS_PER_CLIP;
}
export const estimateClips = (story) => Math.max(1, Math.ceil(weightOf(story)));
const tokens = (text) => estimatePromptTokens([{ role: 'user', content: String(text ?? '') }]);

// ---- cutting a story into parts ----
// Units are paragraphs; a paragraph heavier than half a part is cut into sentences. Parts are runs of units of about equal weight. Offsets are into `story`.
export function splitStory(story, parts) {
  const text = String(story);
  const units = [];
  const paragraph = /[^\n]+(?:\n(?!\s*\n)[^\n]*)*/g;
  let m;
  const target = weightOf(text) / Math.max(1, parts);
  while ((m = paragraph.exec(text))) {
    const start = m.index, body = m[0];
    if (weightOf(body) <= target * 0.5) { units.push({ start, end: start + body.length }); continue; }
    const sentence = /[^.!?।॥\n]+(?:[.!?।॥]+["”’')\]]*|\n|$)\s*/g;
    let s, last = 0;
    while ((s = sentence.exec(body))) { if (!s[0]) { sentence.lastIndex += 1; continue; } units.push({ start: start + s.index, end: start + s.index + s[0].length }); last = s.index + s[0].length; }
    if (last < body.length) units.push({ start: start + last, end: start + body.length });
  }
  if (!units.length) return [{ start: 0, end: text.length, text }];
  const ends = [];
  let total = 0;
  for (const u of units) { total += weightOf(text.slice(u.start, u.end)); ends.push(total); }
  const cuts = [];
  for (let k = 1; k < parts; k++) {
    const want = (total * k) / parts;
    let best = -1;
    for (let i = (cuts.at(-1) ?? -1) + 1; i < units.length - (parts - k); i++) if (best < 0 || Math.abs(ends[i] - want) < Math.abs(ends[best] - want)) best = i;
    if (best < 0) break;
    cuts.push(best);
  }
  const out = [];
  let from = 0;
  for (const c of [...cuts, units.length - 1]) { out.push({ start: units[from].start, end: units[c].end }); from = c + 1; }
  return out.map((p) => ({ ...p, text: text.slice(p.start, p.end).trim() }));
}

// ---- merging the parts' plans ----
const unionOptions = (a, b) => [...a, ...b.filter((o) => !a.includes(o))];
export function mergePlans(parts) {
  const clips = [], byId = new Map();
  let offset = 0;
  for (const part of parts) {
    const b = part.breakdown;
    for (const c of [...b.clips].sort((x, y) => x.clip - y.clip)) clips.push({ ...c, clip: c.clip + offset });
    for (const e of b.ledger.entities) {
      const ids = e.clip_ids.map((n) => n + offset);
      const have = byId.get(e.id);
      if (!have) { byId.set(e.id, { ...e, clip_ids: [...ids], axes: e.axes.map((a) => ({ ...a, options: [...a.options] })), initial: e.initial.map((i) => ({ ...i })) }); continue; }
      have.clip_ids = [...new Set([...have.clip_ids, ...ids])].sort((x, y) => x - y);
      for (const a of e.axes) {
        const own = have.axes.find((x) => x.axis === a.axis);
        if (!own) have.axes.push({ ...a, options: [...a.options] });
        else { own.options = unionOptions(own.options, a.options); own.plate_visible = own.plate_visible || a.plate_visible; own.visible_trace = own.visible_trace || a.visible_trace; }
      }
      for (const i of e.initial) if (!have.initial.some((x) => x.axis === i.axis)) have.initial.push({ ...i });
    }
    offset += b.clips.length;
  }
  return { chapter: parts[0].breakdown.chapter, ledger: { entities: [...byId.values()] }, clips };
}

const plannedLines = (b) => [...b.clips].sort((x, y) => x.clip - y.clip).flatMap((c) => c.shots.flatMap((s) => (s.dialogue?.line ? [{ clip: c.clip, cut: s.shot, speaker: s.dialogue.speaker || '', text: s.dialogue.line }] : [])));

// what the planner of the next part is told about the film so far
function endValues(merged) {
  const ordered = [...merged.clips].sort((a, b) => a.clip - b.clip);
  const last = ordered[ordered.length - 1];
  const start = foldLedger(merged.ledger, merged.clips)[last.clip] || {};
  const now = JSON.parse(JSON.stringify(start));
  for (const ch of last.state_changes) { now[ch.entity] ??= {}; now[ch.entity][ch.axis] = ch.to; }
  return now;
}
export function partContext({ index, total, merged }) {
  const last = [...merged.clips].sort((a, b) => a.clip - b.clip).pop();
  const now = endValues(merged);
  const entities = merged.ledger.entities.map((e) => ({ id: e.id, name: e.name, kind: e.kind, axes: e.axes.map((a) => ({ axis: a.axis, options: a.options, progressive: a.progressive, plate_visible: a.plate_visible, visible_trace: a.visible_trace })), now: now[e.id] || Object.fromEntries(e.initial.map((i) => [i.axis, i.value])) }));
  const speakers = [...new Set(plannedLines(merged).map((l) => l.speaker))];
  const closing = index === total - 1
    ? 'This is the LAST part: the film ends with it.'
    : 'This is NOT the last part: end on the last beat of the text above, with no ending, no moral and no summary of the film; later parts continue from your last clip.';
  return [
    `THIS IS PART ${index + 1} OF ${total} OF ONE LONG FILM. The chapter text above is part ${index + 1} only. The ${merged.clips.length} clips before it are already planned; plan ONLY the events of the text above, never an event of an earlier or a later part, and number your clips from 1 (they are renumbered after the parts are joined). ${closing}`,
    `THE FILM SO FAR ENDS LIKE THIS (end of clip ${last.clip}). The first clip of this part opens exactly here, so its first shot continues this place, light, pose and outfit:\n${last.end_state ? formatEndState(last.end_state) : last.shots[last.shots.length - 1].action}`,
    `THE LEDGER SO FAR (reuse these ids, axes and options for the same character, prop or place; add an entity only for something new; "now" is each axis's value at the end of clip ${last.clip}, so write that value as "initial" for a reused entity):\n${JSON.stringify(entities)}`,
    speakers.length ? `SPEAKER STRINGS ALREADY USED in dialogue_speaker (write exactly the same string for the same speaker): ${JSON.stringify(speakers)}` : '',
  ].filter(Boolean).join('\n\n');
}

// ---- the planner calls ----
// A reply that stops with open brackets or an open string is a cut reply even when the server called it a normal stop (a real reply ended in the middle of a key at stop_reason
// end_turn): jsonrepair would close it and silently hand back a plan with fewer clips.
export function unclosed(text) {
  let depth = 0, inStr = false;
  const t = String(text ?? '');
  if (!/^\s*(?:```(?:json)?\s*)?\{/.test(t)) return false;
  for (let i = 0; i < t.length; i++) {
    const c = t[i];
    if (inStr) { if (c === '\\') i++; else if (c === '"') inStr = false; continue; }
    if (c === '"') inStr = true;
    else if (c === '{' || c === '[') depth++;
    else if (c === '}' || c === ']') depth--;
  }
  return inStr || depth > 0;
}
const plannerChat = ({ outRoot, dir, name, label }) => async (messages, attempt) => {
  const c = await call({ outRoot, dir: join(dir, 'planner'), name: `plan${label}${attempt ? '.retry' : ''}`, kind: 'planner', story: name, messages });
  const text = c.content;
  if (c.cut) return { text, cut: { note: cutNote(c.cut), max_tokens: c.cut.max_tokens } };
  if (parseBreakdown(text)) return text;
  if (unclosed(text)) return { text, cut: { note: `reply ended before its JSON was closed (${c.usage?.completion_tokens ?? '?'} output tokens, stop ${c.finish})`, max_tokens: c.body?.max_tokens } };
  const r = repairJson(text);
  return r.ok ? JSON.stringify(r.value) : text;
};

const pad = (n, w = 2) => String(n).padStart(w, '0');

// -> { plan, planMeta } as film.mjs stores them. `wrap(text)` adds the language line.
export async function planFilm({ name, story, wrap, outRoot, dir, resume, log = () => {} }) {
  const est = estimateClips(story);
  let cutNotes = [];
  if (est <= SINGLE_MAX_CLIPS) {
    try {
      const r = await planStory(plannerChat({ outRoot, dir, name, label: '' }), wrap(story));
      return { plan: r.breakdown, planMeta: { issues: r.issues, attempts: r.attempts, rawAsks: r.rawAsks } };
    } catch (e) {
      if (!(e instanceof PlanError)) throw e;
      cutNotes.push(e.message);
      log(`one call could not plan the story (${e.message}); planning it in parts`);
    }
  }
  const total = est <= SINGLE_MAX_CLIPS ? Math.max(2, Math.ceil(est / (SEG_CLIPS / 2))) : Math.ceil(est / SEG_CLIPS);
  const partsDir = join(dir, 'plan_parts');
  mkdirSync(partsDir, { recursive: true });
  const done = [];
  const attempts = [];
  const units = splitStory(story, total);
  const planUnit = async (unit, depth) => {
    const key = `part_${pad(unit.start, 6)}_${pad(unit.end, 6)}`;
    const file = join(partsDir, `${key}.json`), splitFile = join(partsDir, `${key}.split.json`);
    if (resume && existsSync(file)) { const stored = rj(file); done.push({ breakdown: stored.breakdown, start: unit.start, end: unit.end }); attempts.push(...stored.attempts.map((a) => ({ ...a, part: key }))); return; }
    if (resume && existsSync(splitFile)) { for (const half of rj(splitFile).halves) await planUnit(half, depth + 1); return; }
    const merged = done.length ? mergePlans(done) : null;
    const extra = merged ? partContext({ index: done.length, total: Math.max(total, done.length + 1), merged }) : '';
    const label = `.${key.slice(5)}`;
    try {
      const r = await planStory(plannerChat({ outRoot, dir, name, label }), wrap(unit.text), { extra: extra || (total > 1 ? `THIS IS PART 1 OF ${total} OF ONE LONG FILM. The chapter text above is part 1 only; plan ONLY its events and end on its last beat, with no ending and no summary of the film; later parts continue from your last clip.` : '') });
      wr(file, { breakdown: r.breakdown, issues: r.issues, attempts: r.attempts });
      done.push({ breakdown: r.breakdown, start: unit.start, end: unit.end });
      attempts.push(...r.attempts.map((a) => ({ ...a, part: key })));
    } catch (e) {
      if (!(e instanceof PlanError)) throw e;
      const halves = weightOf(unit.text) > MIN_PART_WEIGHT ? splitStory(unit.text, 2).map((h) => ({ start: unit.start + h.start, end: unit.start + h.end, text: h.text })) : [];
      if (halves.length < 2) throw new PlanError(`part ${key} of the story could not be planned even in its smallest piece: ${e.message}`);
      cutNotes.push(`${key}: ${e.message}`);
      log(`part ${key} failed (${e.message}); planning its two halves`);
      wr(splitFile, { reason: e.message, halves });
      for (const half of halves) await planUnit(half, depth + 1);
    }
  };
  for (const unit of units) await planUnit(unit, 0);
  const plan = mergePlans(done);
  let first = 1;
  plan.parts = done.map((d) => { const part = { first, last: first + d.breakdown.clips.length - 1, start: d.start, end: d.end }; first = part.last + 1; return part; });
  const full = wrap(story);
  const issues = [...checkBreakdown(plan), ...planSpeechIssues(plan), ...sequenceIssues(plannedLines(plan), full).issues, ...planStateIssues(plan)];
  const rawAsks = [...plan.clips].sort((a, b) => a.clip - b.clip).map((c) => rawAskForClip(plan, c.clip));
  return { plan, planMeta: { issues, attempts, rawAsks, parts: plan.parts, splitFrom: cutNotes } };
}

// ---- the bible ----
const sliceOf = (story, part) => String(story).slice(part.start, part.end).trim();
const subPlan = (plan, part) => ({
  chapter: plan.chapter,
  ledger: { entities: plan.ledger.entities.filter((e) => e.clip_ids.some((n) => n >= part.first && n <= part.last)) },
  clips: plan.clips.filter((c) => c.clip >= part.first && c.clip <= part.last),
});
const ids = (b) => new Set(['cast', 'props', 'locations', 'voices'].flatMap((k) => (Array.isArray(b?.[k]) ? b[k] : []).flatMap((e) => [e?.id, ...(Array.isArray(e?.landmarks) ? e.landmarks.map((m) => m?.id) : [])])).filter(Boolean));
export function mergeBible(acc, part) {
  const out = acc ? JSON.parse(JSON.stringify(acc)) : { language: part.language, speakers: {}, cast: [], props: [], locations: [], voices: [] };
  const have = ids(out);
  for (const k of ['cast', 'props', 'locations', 'voices']) {
    out[k] ||= [];
    for (const e of Array.isArray(part[k]) ? part[k] : []) if (e && !have.has(e.id)) { out[k].push(e); have.add(e.id); }
  }
  for (const [k, v] of Object.entries(part.speakers && typeof part.speakers === 'object' ? part.speakers : {})) if (!(k in out.speakers)) out.speakers[k] = v;
  if (part.score && !out.score) out.score = part.score;
  if (!out.language && part.language) out.language = part.language;
  return out;
}
const rosterNote = (acc, index, total) => `PART ${index + 1} OF ${total} OF THE FILM BIBLE. The story and the plan above are only part ${index + 1} of one long film; the entities below are ALREADY DEFINED from the earlier parts. Do NOT return them again (not in cast, props, locations or voices): return only the entities that are NEW in this part (a new character, prop, place or voice), each complete as described above, plus "language" and a "speakers" entry for every speaker string of THIS part (map it to an id below or to a new entity of yours).\nALREADY DEFINED: ${JSON.stringify({ cast: acc.cast.map((c) => ({ id: c.id, name: c.name, appearsAs: c.appearsAs })), props: acc.props.map((p) => ({ id: p.id, name: p.name })), locations: acc.locations.map((l) => ({ id: l.id, name: l.name, landmarks: (l.landmarks || []).map((m) => m.id) })), voices: (acc.voices || []).map((v) => ({ id: v.id, name: v.name })) })}`;

const bibleChat = ({ outRoot, dir, name, label }) => async (messages, attempt) => {
  const c = await call({ outRoot, dir: join(dir, 'bible'), name: `bible${label}${attempt ? '.retry' : ''}`, kind: 'bible', story: name, messages });
  if (c.cut) return { ...parseJsonReply(c.content), cut: { note: cutNote(c.cut), max_tokens: c.cut.max_tokens } };
  return parseJsonLoose(c.content);
};

// -> { bible, issues, attempts }, the shape makeBible returns
export async function bibleFilm({ name, story, plan, planMeta, outRoot, dir, score, resume = false }) {
  if (!plan.parts) return makeBible(bibleChat({ outRoot, dir, name, label: '' }), story, plan, planMeta.rawAsks, { score });
  const attempts = [];
  let acc = null;
  const total = plan.parts.length;
  for (let g = 0; g < total; g++) {
    const part = plan.parts[g];
    const sub = subPlan(plan, part);
    const raws = planMeta.rawAsks.slice(part.first - 1, part.last);
    const groupScore = g === 0 ? score : 'off';
    const base = buildBibleMessages(sliceOf(story, part), sub, raws, { score: groupScore })[0].content;
    const content = acc ? `${base}\n\n${rosterNote(acc, g, total)}` : base;
    const chat = bibleChat({ outRoot, dir, name, label: `.${pad(g + 1)}` });
    const stored = join(dir, 'bible_parts', `g${pad(g + 1)}.json`);
    if (resume && existsSync(stored)) { const r = rj(stored); acc = mergeBible(acc, r.parsed); attempts.push(...r.attempts); continue; }
    let parsed = null, issues = [];
    const mine = [];
    for (let attempt = 0; attempt < 2; attempt++) {
      const msgs = [{ role: 'user', content: attempt && issues.length ? `${content}\n\nYOUR PREVIOUS REPLY FAILED THESE CHECKS — CORRECT EXACTLY THESE AND KEEP EVERYTHING ELSE:\n${issues.slice(0, 25).join('\n')}` : content }];
      const reply = await chat(msgs, attempt);
      parsed = reply.ok ? normalizeBible(reply.value) : null;
      issues = parsed ? validateBible(mergeBible(acc, parsed), sub, { score: groupScore }) : [reply.cut ? `the reply was not one valid JSON object: ${reply.cut.note}; write the SAME structure with shorter field values and close every brace` : 'the reply was not one valid JSON object'];
      mine.push({ part: g + 1, attempt: attempt + 1, issues: [...issues], ...(reply.repaired ? { repaired: reply.repaired } : {}) });
      if (!issues.length) break;
    }
    attempts.push(...mine);
    if (parsed) { acc = mergeBible(acc, parsed); if (!issues.length) wr(stored, { parsed, attempts: mine }); }
    if (issues.length && !parsed) return { bible: acc, issues, attempts };
  }
  const issues = validateBible(acc, plan, { score });
  return { bible: acc, issues, attempts };
}

// ---- the writer's and the reference repair's context ----
// -> null when the full context fits the budget (the caller then builds exactly what E4.8 builds), else { screenplay, storyText }
export function writerContext({ plan, rawAsks, story, clipNumber }) {
  const asks = rawAsks.join('\n\n');
  if (tokens(asks) + tokens(story) <= WRITER_CONTEXT_TOKENS) return null;
  const part = (plan.parts || []).find((p) => clipNumber >= p.first && clipNumber <= p.last);
  const storyText = part ? sliceOf(story, part) : String(story).trim();
  const ordered = [...plan.clips].sort((a, b) => a.clip - b.clip);
  const items = ordered.map((c, i) => {
    const near = Math.abs(c.clip - clipNumber) <= NEAR_CLIPS;
    if (c.clip === clipNumber) return `>>> THIS CLIP <<<\n${rawAsks[i]}`;
    return near ? rawAsks[i] : `Clip ${c.clip}: ${String(c.beat || '').trim()}`;
  });
  const screenplay = `The film is told in ${plan.clips.length} clips that play back to back as one continuous film. Only clip ${clipNumber} is yours to write; the others are written separately (do not write them, do not import their action). Clips more than ${NEAR_CLIPS} away from yours are given by their beat only.\n\n${items.join('\n\n---\n\n')}`;
  return { screenplay, storyText };
}

// the story and the plan quoted in a reference-slot repair for ONE entity
export function refContext({ story, rawAsks, plan, ent }) {
  if (tokens(rawAsks.join('\n\n')) + tokens(story) <= WRITER_CONTEXT_TOKENS) return { story, rawAsks };
  const entity = plan?.ledger?.entities?.find((e) => e.id === ent.id);
  const wanted = entity?.clip_ids?.length ? entity.clip_ids : [];
  const hit = (plan?.clips || []).map((c, i) => ({ c, i })).filter(({ c, i }) => wanted.includes(c.clip) || String(rawAsks[i] || '').toLowerCase().includes(String(ent.name || ent.id).toLowerCase()));
  const picked = (hit.length ? hit : (plan?.clips || []).map((c, i) => ({ c, i }))).slice(0, 6).map(({ i }) => rawAsks[i]);
  const first = hit[0]?.c?.clip;
  const part = (plan?.parts || []).find((p) => first >= p.first && first <= p.last);
  return { story: part ? sliceOf(story, part) : String(story).slice(0, 6000), rawAsks: picked };
}
