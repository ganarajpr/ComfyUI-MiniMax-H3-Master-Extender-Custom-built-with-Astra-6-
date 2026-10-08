// Decisions (E4.3): ONE GLM call per clip. The model picks from option lists BUILT BY CODE, and the reply is constrained to them by a strict JSON-schema enum per question:
//   - references: yes / no per bible entity
//   - per planned shot: the H3 camera-motion term (20 terms) and the staging CHANGES of the entities named in that shot (stage.mjs: the state is carried by code,
//     the decision answers "stays" or what changes), tactic (45 verbs) and Laban effort per character in the shot (SHAPING: never named in prose)
//   - per clip: the camera side and height of the opening cut, and one tic from each character's own acting master (or none)
// The planner's camera term is no longer a question (E4.2 measured 0 overrides in 274 cuts); code applies one concrete rule instead (checks.mjs cameraRules).
// Nothing here is written per shot or per story: options are templates filled with ids, landmark ids and the bible's own words.
import { stageQuestions, replySchema, resolveStaging, emptyLedger as stageEmptyLedger, ledgerText as stageLedgerText, UNSTATED, STAYS } from './stage.mjs';
import { TACTICS } from '../templater/decide.mjs';
import { call, DECISION_SETTINGS, parseJsonReply, wr, humanId } from './lib.mjs';
import { cutEntities, shotText } from './clip.mjs';
import { join } from 'node:path';

export const CAMERA_MOVES = ['Zoom In', 'Zoom Out', 'Push In', 'Pull Out', 'Pan Left', 'Pan Right', 'Truck Left', 'Truck Right', 'Tilt Up', 'Tilt Down', 'Pedestal Up', 'Pedestal Down', 'Arc Shot', 'Tracking Shot', 'Static Shot', 'Shake Slightly', 'Shake Strongly', 'POV', 'Roll Clockwise', 'Roll Counterclockwise'];
export const EFFORTS = { press: 'strong, sustained, direct', flick: 'light, quick, indirect', punch: 'strong, quick, direct', float: 'light, sustained, indirect', wring: 'strong, sustained, indirect', dab: 'light, quick, direct', slash: 'strong, quick, indirect', glide: 'light, sustained, direct' };
export { UNSTATED };
const LISTS = { MOVES: CAMERA_MOVES.map((key) => ({ key })), TACTICS: TACTICS.map((key) => ({ key })), EFFORTS: Object.entries(EFFORTS).map(([key, gloss]) => ({ key, gloss })) };
// the staging ledger carried clip to clip lives in stage.mjs (kept under the old names for the callers)
export const emptyLedger = stageEmptyLedger;
export const ledgerText = stageLedgerText;

// ---- questions ----
export function buildClipQuestions({ plan, bible, clip, cand, landmarks, lines, ledger }) {
  const qs = [];
  const entities = [...bible.cast.map((c) => ({ ...c, type: 'character' })), ...bible.props.map((p) => ({ ...p, type: 'object' })), ...bible.locations.map((l) => ({ ...l, type: 'location' }))];
  for (const e of entities.filter((x) => x.refImage !== false)) qs.push({ id: `ref.${e.id}`, kind: 'ref', text: `Is ${e.name} (${e.type}) on screen at any point in this clip?`, options: [{ key: 'yes' }, { key: 'no' }] });
  const established = new Set();
  const castIds = new Set(bible.cast.map((c) => c.id));
  const sceneChars = [...new Set([...cand.chars.map((c) => c.id), ...Object.keys(ledger?.zone || {}), ...Object.keys(ledger?.holder || {}), ...Object.values(ledger?.holder || {})].filter((id) => castIds.has(id)))];
  const sceneProps = cand.props.map((p) => p.id);
  clip.shots.forEach((s, i) => {
    const k = i + 1;
    qs.push({ id: `move.${k}`, kind: 'move', list: 'MOVES', text: `Which camera-movement term does cut ${k} use? Consecutive cuts of this clip use different terms; pick the movement the action and the beat motivate.` });
    const speakerId = lines.find((l) => l.clip === clip.clip && l.cut === k)?.speaker;
    const ents = cutEntities(s, cand, speakerId);
    const propInfo = Object.fromEntries(ents.props.map((p) => [p.id, { appearsAs: p.appearsAs }]));
    if (ents.chars.length || ents.props.length) {
      qs.push(...stageQuestions({ prefix: `c${k}.`, cut: k, chars: ents.chars.map((c) => c.id), props: ents.props.map((p) => p.id), propInfo, landmarks, carried: k === 1 ? ledger : null, established: new Set(established), withCamera: k === 1, sceneChars, sceneProps, text: shotText(s) }));
      for (const e of [...ents.chars, ...ents.props]) established.add(e.id);
    }
    for (const c of ents.chars) {
      qs.push({ id: `tactic.${k}.${c.id}`, kind: 'tactic', list: 'TACTICS', text: `Cut ${k}: what is ${c.name} doing to whatever stands in ${c.name}'s way? Pick the verb that names the action.` });
      qs.push({ id: `effort.${k}.${c.id}`, kind: 'effort', list: 'EFFORTS', text: `Cut ${k}: how is ${c.name}'s movement performed (Laban's eight effort actions)?` });
    }
  });
  for (const c of cand.chars) {
    const tics = c.acting?.signatureTics || [];
    qs.push({ id: `tic.${c.id}`, kind: 'tic', text: `Which of ${c.name}'s own signature habits does this clip's performance use? Pick "none" when the clip's moments give none of them a trigger.`, options: [...tics.map((t, i) => ({ key: `tic ${i + 1}`, gloss: `${t.tic} (when: ${t.trigger})` })), { key: 'none', gloss: 'no signature habit in this clip' }] });
  }
  return qs;
}

function matchOpt(options, v) {
  const s = String(v ?? '').trim();
  const exact = options.find((o) => o.key === s) || options.find((o) => o.key.toLowerCase() === s.toLowerCase());
  if (exact) return exact;
  return options.filter((o) => s.toLowerCase().startsWith(o.key.toLowerCase()) && /^(?:\s|\(|—|-|$)/.test(s.slice(o.key.length))).sort((a, b) => b.key.length - a.key.length)[0] || null;
}
const optionsOf = (q) => (q.list ? LISTS[q.list] : q.options);

export function decisionPrompt({ plan, bible, clip, rawAsk, cand, landmarks, ledger, questions, geom }) {
  const ents = [...bible.cast.map((c) => `- ${c.id} (character): ${c.appearsAs}`), ...bible.props.map((p) => `- ${p.id} (object): ${p.appearsAs}`), ...bible.locations.map((l) => `- ${l.id} (location): ${l.appearsAs}`)].join('\n');
  const lm = landmarks.map((l) => `- ${l.id}: ${l.gloss}; level ${l.level > 0 ? '+' : ''}${l.level}${l.kind === 'linear' ? `; separates ${l.sides.join(' / ')}` : ''}`).join('\n');
  const listText = Object.entries(LISTS).filter(([name]) => questions.some((q) => q.list === name)).map(([name, items]) => `${name}: ${items.map((o) => (o.gloss ? `${o.key} (${o.gloss})` : o.key)).join(' | ')}`).join('\n\n');
  const qText = questions.map((q) => `${q.id}: ${q.text}${q.list ? `\n  options: the list ${q.list}` : `\n${q.options.map((o) => `  - ${o.key}${o.gloss ? ` — ${o.gloss}` : ''}`).join('\n')}`}`).join('\n\n');
  return `You decide the filmmaking choices for ONE clip of a short film: one video generation of ${geom.duration} seconds made of ${geom.cuts.length} planned cuts. You do not write prose and you invent no content: you pick options from closed lists, using only the story, the planned cuts, the cast and the carried state below.

THE FILM'S SPINE
${plan.chapter}

THE PLANNED CLIP (what happens; copied from the plan)
${rawAsk}

CUT TIMING
${geom.cuts.map((c) => `- cut ${c.n}: ${c.seconds}s${c.label ? `, opens at ${c.label}` : ', opens the clip'}`).join('\n')}

ENTITIES THAT EXIST IN THE FILM (reference questions cover all of them)
${ents}
Language of the dialogue: ${bible.language}

FIXED FEATURES OF THE LOCATION (staging options point at these)
${lm}
Levels: 0 = base floor, +1 = above it, -1 = below it.

${ledgerText(ledger)}

SHARED OPTION LISTS (a question that names a list takes exactly one entry of it, copied verbatim)
${listText}

QUESTIONS
For each question pick exactly ONE option, copied verbatim from its list. The carried state is DEFAULT, and the questions ask only what CHANGES: every position and holder question offers "stays" first, and a cut opens in the state the previous cut left (the first cut: the ledger above). Pick another option only when the planned cut itself does that (a move, a hand-off, a jump to another place). If the plan and the carried state do not settle a question, pick "unstated". Answer only with options that are listed under that question.

${qText}

Reply with ONLY a JSON object mapping each question id to the chosen option string.`;
}

// The strict reply schema needs a provider that enforces response_format; when the router has none, the call is made without it and the same option check runs afterwards.
const replyFormat = (qs) => ({ response_format: { type: 'json_schema', json_schema: { name: 'decisions', strict: true, schema: replySchema(qs, optionsOf) } }, provider: { require_parameters: true } });

export async function decideClip({ ctx, outRoot, dir, story, plan, bible, clip, rawAsk, cand, landmarks, ledger, geom, lines }) {
  const questions = buildClipQuestions({ plan, bible, clip, cand, landmarks, lines, ledger });
  const calls = [], answers = {};
  let todo = questions, constrained = true;
  for (let attempt = 0; attempt < 2 && todo.length; attempt++) {
    const prompt = decisionPrompt({ plan, bible, clip, rawAsk, cand, landmarks, ledger, questions: todo, geom });
    let c = await call({ outRoot, dir, name: attempt === 0 ? 'decide' : 'decide.retry', kind: 'decision', story, clip: clip.clip, messages: [{ role: 'user', content: prompt }], settings: { ...DECISION_SETTINGS, ...(constrained ? replyFormat(todo) : {}) } });
    if (constrained && !(c.status >= 200 && c.status < 300 && c.content)) {
      constrained = false;
      calls.push({ cost: c.cost, secs: c.secs, schemaRefused: true });
      c = await call({ outRoot, dir, name: `${attempt === 0 ? 'decide' : 'decide.retry'}.unconstrained`, kind: 'decision', story, clip: clip.clip, messages: [{ role: 'user', content: prompt }], settings: DECISION_SETTINGS });
    }
    calls.push({ cost: c.cost, secs: c.secs });
    const p = parseJsonReply(c.content);
    const bad = [];
    for (const q of todo) {
      const o = p.ok ? matchOpt(optionsOf(q), p.value[q.id]) : null;
      if (o) answers[q.id] = o.key; else bad.push(q);
    }
    todo = bad;
  }
  const invalid = todo.map((q) => q.id);
  for (const q of todo) {
    if (q.kind === 'ref') answers[q.id] = cand.chars.concat(cand.props, cand.locs).some((e) => `ref.${e.id}` === q.id) ? 'yes' : 'no';
    else if (q.kind === 'tic') answers[q.id] = 'none';
    else if (q.kind === 'stage') answers[q.id] = q.options.some((x) => x.key === STAYS) ? STAYS : UNSTATED;
    else answers[q.id] = null;
  }
  const staged = resolveStaging({ clipNumber: clip.clip, ledger, questions, answers, cutCount: clip.shots.length, landmarks });
  const picks = { ...Object.fromEntries(Object.entries(answers).filter(([id]) => !/^c\d+\./.test(id))), ...staged.picks };
  return { picks, answers, invalid, questions, calls, ledgerAfter: staged.ledgerAfter, changes: staged.changes, constrained, cost: calls.reduce((a, c) => a + c.cost, 0), secs: calls.reduce((a, c) => a + c.secs, 0) };
}
