// The Prompt Studio chapter-breakdown planner, ported function for function from vendor/story_planner.py (the extender's own port).
// The prompt is vendor/prompts/planner.md used verbatim. Differences from the Python module, all deliberate:
//   - AUTO mode only (RUNTIME - AUTO: the clip count follows the story), so there is no target clip count and no `more` / plan-around paths;
//   - the REFS rule and reference-picture parts are ported (buildUserContent takes `refs`) but dormant: E4 plans before the bible exists,
//     so no entity has a reference picture or caption at plan time.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { HERE } from './lib.mjs';
import { sequenceIssues } from './sequence.mjs';
import { planSpeechIssues } from './utterance.mjs';
import { planStateIssues } from './state.mjs';

export const CAMERA_SHOTS = ['wide_establishing', 'medium', 'medium_close', 'close_up', 'extreme_close_up_macro', 'tracking_following', 'over_the_shoulder', 'top_down_overhead', 'low_angle', 'high_angle'];
export const CAMERA_LABELS = {
  wide_establishing: 'Wide', medium: 'Medium', medium_close: 'Medium Close', close_up: 'Close Up', extreme_close_up_macro: 'Extreme Close Up / Macro',
  tracking_following: 'Tracking', over_the_shoulder: 'Over-the-shoulder', top_down_overhead: 'Top Down / Overhead', low_angle: 'Low Angle', high_angle: 'High Angle',
};
export const SHOT_MIN = 3, SHOT_MAX = 6, CLIP_SECONDS = 15, SECONDS_TOLERANCE = 0.5, DIALOGUE_WORDS_PER_SECOND_MAX = 2.2;

export function loadPrompt(name) {
  let text = readFileSync(join(HERE, 'vendor/prompts', `${name}.md`), 'utf8').replace(/\r\n/g, '\n');
  if (text.startsWith('<!--')) { text = text.slice(text.indexOf('-->') + 3); if (text.startsWith('\n')) text = text.slice(1); }
  return text;
}

export function runtimeInstruction(mode = 'auto', targetClips = null, seconds = CLIP_SECONDS) {
  if (mode === 'target' && targetClips > 0) {
    const n = targetClips;
    return `RUNTIME — TARGET, NOT A CEILING OR A FLOOR: this chapter must become EXACTLY ${n} clip${n === 1 ? '' : 's'} of ${seconds} seconds each (${n * seconds}s total) — not one more, not one fewer. Reach EXACTLY ${n} by covering the SAME events at a finer or coarser grain — more or fewer clips, longer or shorter dwell on each beat — never by inventing events the chapter does not contain, and never by compressing two distinct dramatic beats into one clip or stretching one beat thin across several just to fill the count.`;
  }
  return `RUNTIME — AUTO: decide how many ${seconds}-second clips this chapter genuinely needs, one clip per distinct dramatic beat. Do not compress two beats into one clip, and do not pad a single beat across several clips just to run longer. The clip count follows the STORY, not a target.`;
}

export function fillTemplate(template, chapter, mode = 'auto', targetClips = null, seconds = CLIP_SECONDS) {
  return template.replace('{{runtimeInstruction}}', () => runtimeInstruction(mode, targetClips, seconds)).replace('{{chapter}}', () => String(chapter).trim());
}

export const OUTPUT_SHAPE = `
OUTPUT FORMAT — reply with ONE JSON object and nothing else (no prose, no code fence), in exactly this shape and key order:
{
  "chapter": "the chapter's own spine, one line",
  "ledger": {"entities": [
    {"id": "short_slug", "name": "...", "kind": "character|prop|creature|environment",
     "clip_ids": [1, 2],
     "axes": [{"axis": "wardrobe", "options": ["least", "...", "most"], "progressive": false, "plate_visible": true, "visible_trace": false}],
     "initial": [{"axis": "wardrobe", "value": "one of that axis's options"}]}
  ]},
  "clips": [
    {"clip": 1, "beat": "the dramatic beat this clip covers, one line, no camera",
     "shots": [
       {"shot": 1, "seconds": 4, "camera": "one of the camera terms above, verbatim",
        "subject": "who or what is on screen, no camera language", "action": "the one physical action",
        "has_dialogue": false, "dialogue_speaker": "", "dialogue_line": ""}
     ],
     "forward_pull": "the tension, question or forward pull this clip closes on",
     "state_changes": [{"entity": "an entity id", "axis": "one of its axes", "to": "one of that axis's options", "shot": 2}],
     "end_state": {"location": "where the last frame is, with the spot in the set", "time_light": "time of day and light at the last frame",
                   "end_action": "the exact physical action or pose of the last shot's last second",
                   "characters": [{"name": "...", "position": "where in the set, facing which way", "wardrobe": "the full outfit, or: as on the reference",
                                   "props": "held, worn or carried objects, or: none", "state": "visible emotion or condition"}]}}
  ]
}
Each clip has 3-6 shots whose seconds sum to 15. "ledger.entities" may be an empty array when nothing visibly changes.`;

export const CONTINUITY_RULE = 'CONTINUITY STATE — these rules sit on top of the template and win over its \'visually self-contained\' line. The clips play back to back as ONE continuous film: clip N opens exactly where clip N-1 ended. For EVERY clip add "end_state": the state at that clip\'s FINAL frame — location (the spot inside the set), time_light, end_action (the exact physical action or pose of the last shot\'s last second) and, for every character on screen at that moment, position (where in the set, facing which way), wardrobe, props and state. Carry every field forward unchanged into the next clip unless a shot of that clip changes it: nobody changes clothes, loses a prop, heals, or moves between clips off screen. Only an explicit time or location cut that the beat itself names may open a clip somewhere else, and then say so in the beat. WARDROBE comes from the STORY, never from a reference picture: when the story says what a character wears at that point (or changes into), write the full outfit — garment, colour, fabric, trim, accessories — in every clip\'s end_state until the story changes it; when the story says nothing about that character\'s clothing, write exactly: as on the reference. A reference picture tells you who a character is (face, build, hair), not what they wear in the film.';

// E4.6 (issue #7): the one planner prompt addition. The plan carries every audible utterance as exact words, because the renderer improvises any speech the prose only describes,
// and a count or a list must continue the same way across every clip.
export const UTTERANCE_RULE = 'UTTERANCE RULE — everything a character or a voice says aloud in the story, and everything the story implies is said aloud (counting, reciting, chanting, calling out, repeating another speaker, reading aloud), is written as the EXACT WORDS in that shot\'s dialogue_line, with has_dialogue true and the speaker in dialogue_speaker. Never describe speech in subject or action ("she counts aloud", "her mouth moves in a steady count", "the voice calls back"): write the words themselves ("One. Two. Three."). A sequence (numbers, a list, a chant) is written out in full, by the speaker the story names, in the order the story gives. When the story relates what two speakers say (one repeats the other, one is a beat behind, one is a number later, the next number), the words must show exactly that relation: a repeat is the same word, "one number later" is the following number, "the next number" continues the sequence. A count goes one way (up or down) by one each time across all clips unless the story says it restarts.';

// E4.8: the one planner prompt addition of the state rule (founder 2026-10-08): a visible physical trace is a ledger axis, written as what shows, and it carries into the next clips' subject lines.
export const VISIBLE_STATE_RULE = 'VISIBLE STATE RULE — when a story event leaves a VISIBLE physical trace on a person or an object (tears, sweat, wet or muddy clothing, smudged makeup, disheveled hair, a torn or removed garment, a wound, blood, dirt, a lamp lit, a door broken, water spilled), declare it in the ledger as an axis with "visible_trace": true, and list the change in state_changes in the clip and shot where it happens. Every option of such an axis is a visible physical description that names the thing it is on (the body part, the garment or the object) and completes the words "with ..." (for example "wet tear trails down both cheeks, eyes red-rimmed", "the left sleeve torn open at the shoulder", "the left shin grazed raw, a thin line of blood", "the candle lit, a small flame on the table"), never an emotion word ("sad", "upset", "angry"), never a bare word ("lit", "unlit", "wet", "on") and never a negation. The opening value is the plain look (for example "dry cheeks, clear eyes"). A trace stays until a later state change removes it. The end_state of every clip names each trace that holds at its last frame, in the option\'s own words, in the character\'s state, wardrobe or props (or in the location for a place). Posture, position, location and mood are not traces: leave visible_trace false for them.';

export const OPENS_MARK = (n) => `CONTINUITY — THIS CLIP OPENS EXACTLY WHERE CLIP ${n} ENDED:`;
export const ENDS_MARK = 'AT THE END OF THIS CLIP (the next clip opens exactly here):';

export function outputShape(start = 1, second = null, seconds = CLIP_SECONDS) {
  second = second ?? start + 1;
  const shape = seconds !== CLIP_SECONDS ? OUTPUT_SHAPE.replace('sum to 15.', `sum to ${seconds}.`) : OUTPUT_SHAPE;
  if (start === 1 && second === 2) return shape;
  return shape.replace('{"clip": 1,', `{"clip": ${start},`).replace('"clip_ids": [1, 2]', `"clip_ids": [${start}, ${second}]`);
}

export function buildUserMessage(story, seconds = CLIP_SECONDS) {
  return `${fillTemplate(loadPrompt('planner'), story, 'auto', null, seconds)}\n\n${CONTINUITY_RULE}\n\n${UTTERANCE_RULE}\n\n${VISIBLE_STATE_RULE}${outputShape(1, null, seconds)}`;
}

export const REFS_RULE = 'REFERENCE RULE — These are the only characters, props and locations that have a reference picture. Stage the story with them: a character keeps the face, build and hair of their picture, a prop or location keeps its material and layout. A character\'s clothing comes from the story, not from the picture (the picture\'s outfit is only the fallback when the story is silent). Anything without a picture stays off screen or unseen. Name a subject by its Picture number the first time it appears in a clip\'s shots.';
export const REFS_HEADER = 'REFERENCES — the only subjects that have a reference (labelled in slot order):';

// refs = { pictures: [{label, caption}] }: caption-only references (no pixels in E4). Without refs the user turn is the plain text.
export function buildUserContent(story, refs = null, seconds = CLIP_SECONDS) {
  const body = buildUserMessage(story, seconds);
  const pictures = refs?.pictures || [];
  if (!pictures.length) return body;
  const lines = pictures.map((p) => `${p.label}: ${p.caption}`.trimEnd());
  return `${[REFS_HEADER, ...lines].join('\n')}\n\n${REFS_RULE}\n\n${body}`;
}

// Python's f"{x:.1f}" rounds an exact tie to even where toFixed rounds it up; only multiples of a quarter are exact ties at one decimal.
export function f1(x) {
  if (Number.isInteger(x * 4) && (x * 4) % 2 !== 0) { const t = x * 10, lo = Math.floor(t); return ((lo % 2 === 0 ? lo : lo + 1) / 10).toFixed(1); }
  return x.toFixed(1);
}

// ---- parse (lenient, never throws) ----
export function extractJsonObject(raw) {
  const s = String(raw || '').trim().replace(/```(?:json)?/gi, '');
  const a = s.indexOf('{'), b = s.lastIndexOf('}');
  if (a < 0 || b <= a) return null;
  try { const v = JSON.parse(s.slice(a, b + 1)); return v && typeof v === 'object' && !Array.isArray(v) ? v : null; } catch { return null; }
}
const num = (v, d = 0) => { const x = typeof v === 'boolean' ? NaN : parseFloat(v); return Number.isFinite(x) ? x : d; };
const txt = (v) => (typeof v === 'string' ? v.trim() : '');
const int = (v, d = 0) => Math.trunc(num(v, d));

function coerceShot(v, fallback) {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  const speaker = txt(v.dialogue_speaker), line = txt(v.dialogue_line);
  const camera = v.camera;
  return {
    shot: int(v.shot, fallback), seconds: num(v.seconds, 0) || 0, camera: CAMERA_SHOTS.includes(camera) ? camera : 'medium', camera_raw: typeof camera === 'string' ? camera : '',
    subject: txt(v.subject), action: txt(v.action), dialogue: v.has_dialogue === true && (speaker || line) ? { speaker, line } : null,
  };
}
const coerceChange = (v) => (v && typeof v === 'object' && ['entity', 'axis', 'to'].every((k) => typeof v[k] === 'string') ? { entity: v.entity.trim(), axis: v.axis.trim(), to: v.to.trim(), shot: int(v.shot, 0) } : null);
function coerceEndState(v) {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  const characters = [];
  for (const c of Array.isArray(v.characters) ? v.characters : []) {
    if (c && typeof c === 'object' && txt(c.name)) characters.push(Object.fromEntries(['name', 'position', 'wardrobe', 'props', 'state'].map((k) => [k, txt(c[k])])));
  }
  const state = { location: txt(v.location), time_light: txt(v.time_light), end_action: txt(v.end_action), characters };
  return state.end_action || characters.length || state.location ? state : null;
}
function coerceClip(v, fallback) {
  if (!v || typeof v !== 'object' || !Array.isArray(v.shots) || !v.shots.length) return null;
  const shots = v.shots.map((s, i) => coerceShot(s, i + 1)).filter(Boolean);
  if (!shots.length) return null;
  const changes = (Array.isArray(v.state_changes) ? v.state_changes : []).map(coerceChange).filter(Boolean);
  return { clip: int(v.clip, fallback), beat: txt(v.beat), shots, forward_pull: txt(v.forward_pull), state_changes: changes, end_state: coerceEndState(v.end_state) };
}
const coerceAxis = (v) => (v && typeof v === 'object' && typeof v.axis === 'string' ? { axis: v.axis.trim(), options: (Array.isArray(v.options) ? v.options : []).filter((o) => typeof o === 'string'), progressive: v.progressive === true, plate_visible: v.plate_visible === true, visible_trace: v.visible_trace === true } : null);
function coerceEntity(v) {
  if (!v || typeof v !== 'object' || typeof v.id !== 'string' || !v.id.trim()) return null;
  const kind = ['character', 'prop', 'creature', 'environment'].includes(v.kind) ? v.kind : 'character';
  const clip_ids = (Array.isArray(v.clip_ids) ? v.clip_ids : []).map((x) => num(x, null)).filter((n) => n !== null).map(Math.trunc);
  const axes = (Array.isArray(v.axes) ? v.axes : []).map(coerceAxis).filter(Boolean);
  const initial = (Array.isArray(v.initial) ? v.initial : []).filter((i) => i && typeof i.axis === 'string' && typeof i.value === 'string').map((i) => ({ axis: i.axis.trim(), value: i.value.trim() }));
  return { id: v.id.trim(), name: txt(v.name) || v.id.trim(), kind, clip_ids, axes, initial };
}

export function parseBreakdown(raw) {
  const obj = extractJsonObject(raw);
  if (!obj || typeof obj.chapter !== 'string' || !Array.isArray(obj.clips) || !obj.clips.length) return null;
  const clips = obj.clips.map((c, i) => coerceClip(c, i + 1)).filter(Boolean);
  if (!clips.length) return null;
  const ledger = obj.ledger && typeof obj.ledger === 'object' && !Array.isArray(obj.ledger) ? obj.ledger : {};
  const entities = (Array.isArray(ledger.entities) ? ledger.entities : []).map(coerceEntity).filter(Boolean);
  return { chapter: obj.chapter.trim(), ledger: { entities }, clips };
}

// ---- state ledger ----
const initialState = (ledger) => Object.fromEntries(ledger.entities.map((e) => [e.id, Object.fromEntries(e.initial.map((i) => [i.axis, i.value]))]));
const cloneState = (s) => Object.fromEntries(Object.entries(s).map(([k, v]) => [k, { ...v }]));

// clip number -> state (entity -> axis -> value) as of the START of that clip
export function foldLedger(ledger, clips) {
  const byClip = {};
  let running = initialState(ledger);
  for (const c of [...clips].sort((a, b) => a.clip - b.clip)) {
    byClip[c.clip] = cloneState(running);
    const nxt = cloneState(running);
    for (const ch of c.state_changes) { nxt[ch.entity] ??= {}; nxt[ch.entity][ch.axis] = ch.to; }
    running = nxt;
  }
  return byClip;
}

export function formatStateBlocks(ledger, startState, clipChanges, clip) {
  const byId = Object.fromEntries(ledger.entities.map((e) => [e.id, e]));
  const onScreen = ledger.entities.filter((e) => e.clip_ids.includes(clip));
  if (!onScreen.length) return '';
  const startLines = [];
  for (const entity of onScreen) {
    if (!entity.axes.length) continue;
    const axisMap = startState[entity.id] || {};
    const parts = entity.axes.map((a) => {
      let value = axisMap[a.axis];
      if (value === undefined || value === null) value = entity.initial.find((i) => i.axis === a.axis)?.value ?? '';
      return `${a.axis}=${value}`;
    });
    startLines.push(`${entity.name} (${entity.kind}): ${parts.join(', ')}`);
  }
  const changeLines = clipChanges.filter((c) => byId[c.entity]).map((c) => `${byId[c.entity].name}.${c.axis} -> ${c.to} (shot ${c.shot})`);
  const parts = [];
  if (startLines.length) parts.push(['STATE AT THE START OF THIS CLIP:', ...startLines].join('\n'));
  if (changeLines.length) parts.push(['CHANGES DURING THIS CLIP:', ...changeLines].join('\n'));
  return parts.join('\n\n');
}

// ---- raw-ask formatting ----
const fmtSeconds = (s) => (Number.isInteger(s) ? String(s) : f1(s));

export function formatShotLine(s) {
  const camera = CAMERA_LABELS[s.camera] || s.camera;
  const subject = s.subject.trim(), action = s.action.trim();
  let body;
  if (subject && action) {
    const newSentence = /^[A-Z]/.test(action);
    const sep = newSentence ? `${/[.!?]$/.test(subject) ? '' : '.'} ` : ' ';
    body = `${subject}${sep}${action}`;
  } else body = subject || action;
  if (s.dialogue?.line) {
    const sep = /[.!?,]$/.test(body) ? '' : ',';
    const speaker = s.dialogue.speaker ? `${s.dialogue.speaker} says` : 'says';
    body = body ? `${body}${sep} ${speaker} "${s.dialogue.line}"` : `${speaker} "${s.dialogue.line}"`;
  }
  if (!/[.!?]$/.test(body)) body += '.';
  return `Shot ${s.shot} – ${camera} as ${body} (${fmtSeconds(s.seconds)}s)`;
}

export function formatClipRawAsk(clip) {
  const lines = [`Clip ${clip.clip}:`, '', ...clip.shots.map(formatShotLine)];
  if (clip.forward_pull.trim()) lines.push('', clip.forward_pull.trim());
  return lines.join('\n');
}

export function formatEndState(es) {
  const lines = [];
  if (es.location) lines.push(`Location: ${es.location}`);
  if (es.time_light) lines.push(`Time and light: ${es.time_light}`);
  if (es.end_action) lines.push(`Last action: ${es.end_action}`);
  for (const c of es.characters) {
    const parts = [['position', 'position'], ['wardrobe', 'wardrobe'], ['props', 'props'], ['state', 'state']].filter(([k]) => c[k]).map(([k, label]) => `${label}: ${c[k]}`);
    lines.push(parts.length ? `${c.name} — ${parts.join('; ')}` : c.name);
  }
  return lines.join('\n');
}

export function rawAskForClip(b, clipNumber) {
  const clip = b.clips.find((c) => c.clip === clipNumber);
  if (!clip) return null;
  let text = formatClipRawAsk(clip);
  const ordered = [...b.clips].sort((x, y) => x.clip - y.clip);
  const at = ordered.indexOf(clip);
  const before = at > 0 ? ordered[at - 1] : null;
  const head = [];
  if (b.ledger.entities.length) {
    const start = foldLedger(b.ledger, b.clips)[clipNumber];
    if (start) { const blocks = formatStateBlocks(b.ledger, start, clip.state_changes, clipNumber); if (blocks) head.push(blocks); }
  }
  if (before?.end_state && before.clip === clip.clip - 1) head.push(`${OPENS_MARK(before.clip)}\n${formatEndState(before.end_state)}`);
  if (clip.end_state) text = `${text}\n\n${ENDS_MARK}\n${formatEndState(clip.end_state)}`;
  return [...head, text].join('\n\n');
}

// ---- checks (plain strings, never throw) ----
export function checkRawAsksDistinct(b) {
  const issues = [], seen = new Map();
  for (const clip of b.clips) {
    const text = rawAskForClip(b, clip.clip);
    if (!text) issues.push(`clip ${clip.clip}: could not build a raw ask at all.`);
    else if (seen.has(text)) issues.push(`clip ${clip.clip}'s raw ask is byte-identical to clip ${seen.get(text)}'s.`);
    else seen.set(text, clip.clip);
  }
  return issues;
}

export function checkBreakdown(b, seconds = CLIP_SECONDS) {
  const issues = [];
  const entityById = Object.fromEntries(b.ledger.entities.map((e) => [e.id, e]));
  for (const clip of b.clips) {
    const n = clip.shots.length;
    if (n < SHOT_MIN || n > SHOT_MAX) issues.push(`clip ${clip.clip} has ${n} shot${n === 1 ? '' : 's'} — outside the ${SHOT_MIN}-${SHOT_MAX} range.`);
    const total = clip.shots.reduce((a, s) => a + s.seconds, 0);
    const drift = Math.abs(total - seconds);
    if (drift > SECONDS_TOLERANCE) issues.push(`clip ${clip.clip}'s shots sum to ${f1(total)}s — ${f1(drift)}s off the ${seconds}s target.`);
    for (const s of clip.shots) if (!CAMERA_SHOTS.includes(s.camera_raw)) issues.push(`clip ${clip.clip} shot ${s.shot}: camera '${s.camera_raw}' is not one of ${CAMERA_SHOTS.join(', ')}.`);
    for (let i = 1; i < n; i++) {
      if (clip.shots[i].camera === clip.shots[i - 1].camera) issues.push(`clip ${clip.clip}, shots ${clip.shots[i - 1].shot}-${clip.shots[i].shot} repeat the same camera (${CAMERA_LABELS[clip.shots[i].camera]}) back-to-back.`);
    }
    for (const s of clip.shots) {
      const line = s.dialogue?.line;
      if (!line) continue;
      const words = line.split(/\s+/).filter(Boolean).length;
      const wps = s.seconds > 0 ? words / s.seconds : Infinity;
      if (wps > DIALOGUE_WORDS_PER_SECOND_MAX) issues.push(`clip ${clip.clip} shot ${s.shot}: ${words} words in ${f1(s.seconds)}s is ${f1(wps)} words/s — over the ${DIALOGUE_WORDS_PER_SECOND_MAX} words/s ceiling H3 dialogue tends to mangle past.`);
    }
    const shotNumbers = new Set(clip.shots.map((s) => s.shot));
    for (const ch of clip.state_changes) {
      const entity = entityById[ch.entity];
      if (!entity) { issues.push(`clip ${clip.clip} state_changes cites entity '${ch.entity}', which is not in ledger.entities[].id.`); continue; }
      const axis = entity.axes.find((a) => a.axis === ch.axis);
      if (!axis) { issues.push(`clip ${clip.clip} state_changes: entity '${ch.entity}' has no axis '${ch.axis}' declared in the ledger.`); continue; }
      if (!axis.options.includes(ch.to)) issues.push(`clip ${clip.clip} state_changes: '${ch.to}' is not one of ${entity.id}.${axis.axis}'s declared options (${axis.options.join(', ')}).`);
      if (!shotNumbers.has(ch.shot)) issues.push(`clip ${clip.clip} state_changes cites shot ${ch.shot}, which is not one of this clip's own shots (${[...shotNumbers].sort((a, b) => a - b).join(', ')}).`);
    }
  }
  for (const clip of b.clips) {
    const end = clip.end_state;
    if (!end || !end.end_action) issues.push(`clip ${clip.clip} has no usable end_state (needs location, time_light, end_action and every on-screen character's position, wardrobe, props and state).`);
  }
  const ordered = [...b.clips].sort((x, y) => x.clip - y.clip);
  for (const entity of b.ledger.entities) {
    for (const axis of entity.axes) {
      if (!axis.progressive) continue;
      const options = axis.options;
      const start = entity.initial.find((i) => i.axis === axis.axis)?.value ?? '';
      let last = options.indexOf(start);
      for (const clip of ordered) {
        const change = clip.state_changes.find((c) => c.entity === entity.id && c.axis === axis.axis);
        if (!change || !options.includes(change.to)) continue;
        const idx = options.indexOf(change.to);
        if (last !== -1 && idx < last) issues.push(`${entity.id}.${axis.axis} moves backwards at clip ${clip.clip} (from '${options[last]}' to '${change.to}') — this axis is progressive and its options are ordered least to most.`);
        last = idx;
      }
    }
  }
  issues.push(...checkRawAsksDistinct(b));
  return issues;
}

// E4.3: the checks that failed most often are arithmetic slips, not content: a line planned into too few seconds (the 2.2 words per second ceiling), and shots that add up to 12 or 17 seconds
// instead of 15. The words, the shots and their order are right; only the split of the clip's seconds is off. Before the checks, code (1) raises a shot that is too short for its own line to what the
// line needs, then (2) takes the excess from, or adds the shortfall to, the other shots in half seconds, so that the clip is 15 seconds again. A donor never goes below MIN_SHOT_SECONDS or below what its
// own line needs; the shot with the most slack gives first. A clip whose total is more than MAX_TOTAL_DRIFT seconds off, or whose slack cannot cover the excess, is left exactly as the model wrote it and the check
// then asks the model for the retry, as in E4.2.
export const MIN_SHOT_SECONDS = 2, MAX_TOTAL_DRIFT = 3;
export const wordCount = (line) => String(line || '').split(/\s+/).filter(Boolean).length;
export const secondsNeeded = (line) => Math.ceil((wordCount(line) / DIALOGUE_WORDS_PER_SECOND_MAX) * 2 - 1e-9) / 2;
export function rebalanceSeconds(b, seconds = CLIP_SECONDS) {
  const changes = [];
  for (const clip of b.clips) {
    const need = clip.shots.map((s) => (s.dialogue?.line ? Math.max(secondsNeeded(s.dialogue.line), MIN_SHOT_SECONDS) : MIN_SHOT_SECONDS));
    const before = clip.shots.map((s) => s.seconds);
    const sum = before.reduce((a, x) => a + x, 0);
    const short = clip.shots.map((s, i) => !!s.dialogue?.line && s.seconds < need[i]);
    if (!short.some(Boolean) && Math.abs(sum - seconds) <= SECONDS_TOLERANCE) continue;
    if (Math.abs(sum - seconds) > MAX_TOTAL_DRIFT) continue;
    const next = before.map((x, i) => (short[i] ? need[i] : x));
    let excess = next.reduce((a, x) => a + x, 0) - seconds;
    if (Math.abs(excess) > 1e-9) {
      const slack = next.map((x, i) => Math.max(0, Math.floor((x - need[i]) * 2) / 2));
      if (excess > 0 && slack.reduce((a, x) => a + x, 0) < excess - SECONDS_TOLERANCE) continue;
      const order = next.map((_, i) => i).filter((i) => !short[i]).sort((x, y) => (excess > 0 ? slack[y] - slack[x] : next[y] - next[x]) || x - y);
      if (excess < 0 && !order.length) continue;
      for (let guard = 0; Math.abs(excess) > 1e-9 && guard < 200; guard++) {
        const i = order[guard % order.length];
        if (excess > 0) { const take = Math.min(slack[i], 0.5, excess); if (take <= 0) { if (order.every((j) => slack[j] <= 0)) break; continue; } next[i] -= take; slack[i] -= take; excess -= take; } else { const add = Math.min(0.5, -excess); next[i] += add; excess += add; }
      }
      if (Math.abs(excess) > SECONDS_TOLERANCE) continue;
    }
    clip.shots.forEach((s, i) => { if (next[i] !== before[i]) { s.seconds = next[i]; changes.push({ clip: clip.clip, shot: s.shot, from: before[i], to: next[i] }); } });
  }
  return changes;
}
export const rebalanceDialogue = rebalanceSeconds;

export function renumber(b) {
  const ordered = [...b.clips].sort((x, y) => x.clip - y.clip);
  const numbers = ordered.map((_, i) => i + 1);
  const claimed = ordered.map((c) => c.clip);
  const mapping = JSON.stringify(claimed) === JSON.stringify(numbers) ? Object.fromEntries(claimed.map((n) => [n, n])) : Object.fromEntries(ordered.map((c, i) => [c.clip, numbers[i]]));
  for (const c of ordered) c.clip = mapping[c.clip] ?? c.clip;
  for (const e of b.ledger.entities) e.clip_ids = [...new Set(e.clip_ids.filter((n) => n in mapping).map((n) => mapping[n]))].sort((x, y) => x - y);
  b.clips = ordered;
  return b;
}

const plannedLines = (b) => [...b.clips].sort((x, y) => x.clip - y.clip).flatMap((c) => c.shots.flatMap((s) => (s.dialogue?.line ? [{ clip: c.clip, cut: s.shot, speaker: s.dialogue.speaker || '', text: s.dialogue.line }] : [])));

export class PlanError extends Error {}

// One call; on an unparseable reply or any failed check, exactly one retry with the complaint appended (the Studio's own discipline).
// After the retry soft issues are kept (and returned); an unparseable reply twice raises PlanError.
// `chat(messages, attempt) -> reply text`.
export async function planStory(chat, story, { seconds = CLIP_SECONDS, log = () => {} } = {}) {
  const user = buildUserContent(story, null, seconds);
  let complaint = [], parsed = null, issues = [];
  const attempts = [];
  // E4.6: the plan checks of issue #7 (speech in prose, sequence continuity) get one more retry, and so do E4.8's visible-state checks (option wording, state changes against end_state); every other failure keeps the single retry of E4.2.
  for (let attempt = 0; attempt < 3; attempt++) {
    const content = complaint.length ? `${user}\n\nYOUR PREVIOUS REPLY FAILED THESE CHECKS — CORRECT EXACTLY THIS AND NOTHING ELSE:\n${complaint.join('\n')}` : user;
    const reply = await chat([{ role: 'user', content }], attempt);
    parsed = parseBreakdown(reply);
    let rebalanced = [];
    if (parsed) { renumber(parsed); rebalanced = rebalanceDialogue(parsed); }
    if (!parsed) {
      if (attempt >= 1) { attempts.push({ attempt: attempt + 1, parsed: false, issues: ['not parseable'] }); break; }
      complaint = ['Your reply was not one valid JSON object in the OUTPUT FORMAT above (or had no clips). Reply with that JSON object only.'];
      issues = [...complaint];
      attempts.push({ attempt: attempt + 1, parsed: false, issues });
      log(`attempt ${attempt + 1}: reply not parseable`);
      continue;
    }
    const base = checkBreakdown(parsed, seconds), utter = [...planSpeechIssues(parsed), ...sequenceIssues(plannedLines(parsed), story).issues, ...planStateIssues(parsed)];
    issues = [...base, ...utter];
    attempts.push({ attempt: attempt + 1, parsed: true, issues: [...issues], rebalanced });
    if (!issues.length) break;
    if (attempt >= 1 && base.length) break;
    complaint = issues;
    log(`attempt ${attempt + 1}: ${issues.length} issue(s): ${issues.slice(0, 4).join(' | ')}`);
  }
  if (!parsed) throw new PlanError('the story planner returned no usable JSON twice');
  return { breakdown: parsed, issues, attempts, rawAsks: [...parsed.clips].sort((a, b) => a.clip - b.clip).map((c) => rawAskForClip(parsed, c.clip)) };
}
