// E4.11: a long story is planned in PARALLEL. A planner that plans a long story part after part needs the end of part N-1 before it can start part N. Here ONE fast call (the skeleton) decides the
// global things first: the ledger (entities, axes, options, the starting values), and for every part of the story how many clips it takes, one beat per clip, the ledger values at the part's first frame
// and the last frame of the part. Then every part is planned in its own call at the same time, from the skeleton, as a short film that opens where the skeleton says. The parts are merged by
// code, the plan fixes of fixes.mjs run on the merged plan (that is where the boundaries are reconciled: the folded ledger is the authority on every end_state), and only a part with a HARD issue is planned again, once.
// A story of about SINGLE_MAX clips or fewer keeps the one-call planner of planner.mjs. Any failure of the skeleton or of a part falls back to that one-call planner, so a story that E4.10 could plan is never lost.
import { buildUserContent, parseBreakdown, renumber, rebalanceDialogue, rawAskForClip, classifyPlanIssues, planStory, formatEndState, coerceEntity, coerceEndState, extractJsonObject, VISIBLE_STATE_RULE, BOOKKEEPING_RULE, CLIP_SECONDS, PlanError } from './planner.mjs';
import { AFTERMATH_CHECKLIST } from './aftermath.mjs';
import { applyPlanFixes } from './fixes.mjs';

const envNumber = (name, fallback) => { const v = Number(process.env[name]); return Number.isFinite(v) && v > 0 ? v : fallback; };
export const LATIN_CHARS_PER_CLIP = 700, WIDE_CHARS_PER_CLIP = 380;
export const SINGLE_MAX_CLIPS = envNumber('E4_PLAN_SINGLE_MAX', 14);
export const SEG_CLIPS = envNumber('E4_PLAN_SEG_CLIPS', 7);

export function weightOf(text) {
  let latin = 0, wide = 0;
  for (const ch of String(text ?? '')) { if (ch.codePointAt(0) >= 0x250) wide += 1; else latin += 1; }
  return latin / LATIN_CHARS_PER_CLIP + wide / WIDE_CHARS_PER_CLIP;
}
export const estimateClips = (story) => Math.max(1, Math.ceil(weightOf(story)));

// the story cut into `parts` runs of whole sentences of about equal weight
export function splitStory(story, parts) {
  const sentences = String(story).split(/(?<=[.!?।॥])\s+|\n{2,}/).map((s) => s.trim()).filter(Boolean);
  const target = weightOf(story) / Math.max(1, parts), out = [];
  let cur = [], w = 0;
  for (const s of sentences) {
    cur.push(s); w += weightOf(s);
    if (w >= target * 0.98 && out.length < parts - 1) { out.push(cur.join(' ')); cur = []; w = 0; }
  }
  if (cur.length) out.push(cur.join(' '));
  return out;
}

const SKELETON_SHAPE = `OUTPUT FORMAT — reply with ONE JSON object and nothing else (no prose, no code fence), in exactly this shape:
{
  "chapter": "the story's own spine, one line",
  "ledger": {"entities": [
    {"id": "short_slug", "name": "...", "kind": "character|prop|creature|environment",
     "axes": [{"axis": "name_of_the_thing_it_is_on", "options": ["least", "...", "most"], "progressive": false, "plate_visible": true, "visible_trace": false}],
     "initial": [{"axis": "...", "value": "one of that axis's options"}]}
  ]},
  "parts": [
    {"part": 1, "clips": 7, "beats": ["one line per clip of this part, in order"],
     "start_state": [{"entity": "an entity id", "axis": "one of its axes", "value": "its value at the first frame of this part"}],
     "end_state": {"location": "...", "time_light": "...", "end_action": "the last action of the part", "characters": [{"name": "...", "position": "...", "wardrobe": "the full outfit, or: as on the reference", "props": "...", "state": "..."}]}}
  ]
}`;

export function skeletonPrompt(story, pieces, seconds = CLIP_SECONDS) {
  const list = pieces.map((p, i) => `PART ${i + 1} (about ${Math.max(1, Math.round(weightOf(p)))} clips of ${seconds} seconds):\n${p}`).join('\n\n');
  return `You plan the SKELETON of a film that will be cut into ${seconds}-second clips. The story has been cut into ${pieces.length} parts; each part is planned afterwards by someone who sees only that part, your ledger and the state at its start, all at the same time. So write down, for the whole film, what they need to agree on.

THE STORY
${String(story).trim()}

THE PARTS
${list}

${VISIBLE_STATE_RULE}

${BOOKKEEPING_RULE}

${AFTERMATH_CHECKLIST}

For every part: "clips" is how many ${seconds}-second clips it genuinely needs (one clip per distinct dramatic beat, never padded), "beats" has one line per clip, "start_state" lists the ledger value of every axis at the first frame of the part (a value changed by an earlier part is already changed), and "end_state" is the last frame of the part (position, wardrobe and state of every character on screen). The ledger lists every person, prop and place whose state changes anywhere in the film, with every option of every axis; "initial" is the state at the first frame of the film.

${SKELETON_SHAPE}`;
}

export function parseSkeleton(text, partCount) {
  const obj = extractJsonObject(text);
  if (!obj || !Array.isArray(obj.parts) || !obj.parts.length) return null;
  const entities = (Array.isArray(obj.ledger?.entities) ? obj.ledger.entities : []).map((e) => coerceEntity({ ...e, clip_ids: [] })).filter(Boolean);
  const parts = obj.parts.map((p, i) => ({
    part: i + 1, clips: Math.max(1, Math.round(Number(p.clips) || 0)) || 1,
    beats: (Array.isArray(p.beats) ? p.beats : []).filter((b) => typeof b === 'string'),
    start: (Array.isArray(p.start_state) ? p.start_state : []).filter((x) => x && typeof x.entity === 'string' && typeof x.axis === 'string' && typeof x.value === 'string'),
    end: coerceEndState(p.end_state),
  }));
  if (parts.length !== partCount) return null;
  return { chapter: typeof obj.chapter === 'string' ? obj.chapter.trim() : '', entities, parts };
}

// the user turn of one part: the ordinary planner prompt on the part's excerpt, plus what the skeleton fixed
export function partPrompt({ excerpt, skeleton, k, seconds = CLIP_SECONDS, total }) {
  const part = skeleton.parts[k], prev = k > 0 ? skeleton.parts[k - 1] : null, next = skeleton.parts[k + 1] || null;
  const startOf = Object.fromEntries(part.start.map((x) => [`${x.entity}\u0000${x.axis}`, x.value]));
  const entities = skeleton.entities.map((e) => ({ id: e.id, name: e.name, kind: e.kind, axes: e.axes.map((a) => ({ axis: a.axis, options: a.options, progressive: a.progressive, plate_visible: a.plate_visible, visible_trace: a.visible_trace })), initial: e.axes.map((a) => ({ axis: a.axis, value: startOf[`${e.id}\u0000${a.axis}`] ?? e.initial.find((i) => i.axis === a.axis)?.value ?? a.options[0] })) }));
  const block = `THIS IS PART ${k + 1} OF ${total} OF A LONGER FILM. Plan ONLY the story above, as its own short film whose clips are numbered from 1; the other parts are planned at the same time by others, so rely on this and on nothing else:
- The film's ledger (use these ids, axes and options verbatim; add no option and no axis; list in "ledger.entities" only the entities that appear in your clips; "initial" is the state at this part's first frame): ${JSON.stringify(entities)}
- How this part opens: ${prev?.end ? `the previous part ended like this, so your first clip opens exactly there.\n${formatEndState(prev.end)}` : 'the film opens here.'}
- The plan of this part (${part.clips} clip${part.clips === 1 ? '' : 's'}): ${part.beats.length ? part.beats.map((b, i) => `clip ${i + 1}: ${b}`).join(' | ') : 'one clip per distinct dramatic beat.'}
- How this part ends: ${part.end ? `your last clip's end_state is this, with every state change of your own clips applied.\n${formatEndState(part.end)}` : 'at the last beat of the story above.'}${next ? '' : ' It is the end of the film.'}
`;
  const user = buildUserContent(excerpt, null, seconds);
  const at = user.indexOf('\nOUTPUT FORMAT');
  return at < 0 ? `${user}\n\n${block}` : `${user.slice(0, at)}\n\n${block}${user.slice(at)}`;
}

// parts (each a parsed breakdown with local clip numbers) -> one plan with global numbers; the skeleton's ledger is the base, a part may add an entity or an option
export function mergeParts(skeleton, parts) {
  const clips = [], byId = new Map(skeleton.entities.map((e) => [e.id, { ...e, axes: e.axes.map((a) => ({ ...a, options: [...a.options] })), initial: e.initial.map((i) => ({ ...i })), clip_ids: [] }]));
  let offset = 0;
  for (const part of parts) {
    const ordered = [...part.clips].sort((a, b) => a.clip - b.clip);
    for (const c of ordered) clips.push({ ...c, clip: c.clip + offset });
    for (const e of part.ledger.entities) {
      let g = byId.get(e.id);
      if (!g) { g = { id: e.id, name: e.name, kind: e.kind, axes: [], initial: e.initial.map((i) => ({ ...i })), clip_ids: [] }; byId.set(e.id, g); }
      for (const a of e.axes) {
        const ga = g.axes.find((x) => x.axis === a.axis);
        if (!ga) g.axes.push({ ...a, options: [...a.options] });
        else for (const o of a.options) if (!ga.options.includes(o)) ga.options.push(o);
      }
      for (const i of e.initial) if (!g.initial.some((x) => x.axis === i.axis)) g.initial.push({ ...i });
      g.clip_ids = [...new Set([...g.clip_ids, ...e.clip_ids.map((n) => n + offset)])].sort((a, b) => a - b);
    }
    offset += ordered.length;
  }
  return { chapter: skeleton.chapter || parts[0]?.chapter || '', ledger: { entities: [...byId.values()] }, clips };
}

// `chatFor(stem)` -> async (messages, attempt) => reply text, one stem per call family ('plan.skeleton', 'plan.part3'); `fallback()` plans the whole story in one call.
export async function planParallel(chatFor, rawStory, { seconds = CLIP_SECONDS, parts: wanted = null, wrap = (x) => x, log = () => {} } = {}) {
  const story = wrap(rawStory), est = estimateClips(rawStory), P = Math.max(2, wanted || Math.ceil(est / SEG_CLIPS));
  const pieces = splitStory(rawStory, P);
  const out = { mode: 'skeleton', parts: pieces.length, estimatedClips: est, attempts: [], events: [] };
  const fallback = async (why) => { log(`skeleton planner: ${why}; planning the whole story in one call`); const r = await planStory(chatFor('plan'), story, { seconds, log }); return { ...r, parallel: { ...out, mode: 'single-fallback', why } }; };
  if (pieces.length < 2) return fallback('the story did not split');
  const sk = parseSkeleton(await chatFor('plan.skeleton')([{ role: 'user', content: skeletonPrompt(story, pieces, seconds) }], 0), pieces.length);
  if (!sk) return fallback('the skeleton reply was not usable');
  out.skeleton = { chapter: sk.chapter, entities: sk.entities.length, parts: sk.parts.map((p) => ({ part: p.part, clips: p.clips })) };

  const planPart = async (k, complaint = []) => {
    const stem = complaint.length ? `plan.part${k + 1}.retry` : `plan.part${k + 1}`;
    const user = partPrompt({ excerpt: wrap(pieces[k]), skeleton: sk, k, seconds, total: pieces.length });
    const content = complaint.length ? `${user}\n\nYOUR PREVIOUS REPLY FAILED THESE CHECKS — CORRECT EXACTLY THIS AND NOTHING ELSE:\n${complaint.join('\n')}` : user;
    const parsed = parseBreakdown(await chatFor(stem)([{ role: 'user', content }], 0));
    if (!parsed) return null;
    renumber(parsed); rebalanceDialogue(parsed);
    const { fixes } = applyPlanFixes(parsed, { story: pieces[k], seconds });
    const { hard, soft } = classifyPlanIssues(parsed, pieces[k], seconds);
    return { parsed, hard, soft, fixes };
  };
  let results = await Promise.all(sk.parts.map((_, k) => planPart(k)));
  out.attempts.push(results.map((r, k) => ({ part: k + 1, parsed: !!r, hard: r?.hard || ['not parseable'], soft: r?.soft || [], fixes: r?.fixes || [] })));
  const need = results.map((r, k) => (!r || r.hard.length ? k : -1)).filter((k) => k >= 0);
  if (need.length) {
    const again = await Promise.all(need.map((k) => planPart(k, results[k] ? results[k].hard : ['Your reply was not one valid JSON object in the OUTPUT FORMAT above (or had no clips). Reply with that JSON object only.'])));
    need.forEach((k, j) => { if (again[j] && (!results[k] || again[j].hard.length < results[k].hard.length)) results[k] = again[j]; });
    out.attempts.push(need.map((k, j) => ({ part: k + 1, parsed: !!again[j], hard: again[j]?.hard || ['not parseable'], soft: again[j]?.soft || [] })));
  }
  if (results.some((r) => !r)) return fallback('a part could not be planned');
  const plan = mergeParts(sk, results.map((r) => r.parsed));
  renumber(plan);
  const { fixes, warnings } = applyPlanFixes(plan, { story, seconds });
  const { hard, soft } = classifyPlanIssues(plan, story, seconds);
  const ordered = [...plan.clips].sort((a, b) => a.clip - b.clip);
  return {
    breakdown: plan, issues: hard, warnings: [...warnings, ...soft], fixes: [...results.flatMap((r, k) => r.fixes.map((f) => ({ ...f, part: k + 1 }))), ...fixes], kept: 1,
    attempts: [{ attempt: 1, parsed: true, issues: [...hard, ...soft], hard, soft, fixes, merged: true }], rawAsks: ordered.map((c) => rawAskForClip(plan, c.clip)), parallel: out,
  };
}
void PlanError;
