// LLM call 2: the film bible, one call per film. From the story and the plan it produces
//   - the entities (cast, props, locations with 2-6 staging landmarks each, a linear landmark's two sides),
//   - structured reference-image SLOTS per entity ("ref", E4.2; refslots.mjs), from which code assembles the image prompt with the stored skills' templates,
//   - each character's ACTING MASTER (the schema and the contract text of h3_film's acting_master stage).
// The reference images themselves are not generated here. Every clip's references later are a decision over this entity list.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { HERE } from './lib.mjs';
import { speakerIssues, voiceFieldIssues, voicesOf } from './speakers.mjs';
import { slotInstructions, slotIssues, normalizeRef } from './refslots.mjs';

const read = (rel) => readFileSync(join(HERE, rel), 'utf8').replace(/\r\n/g, '\n');
export const ACTING_SCHEMA = JSON.parse(read('vendor/schemas/acting_master.schema.json'));

function actingContract() {
  const t = read('vendor/prompts/acting_master.md');
  const a = t.indexOf('## ACTING contract');
  const b = t.indexOf('Set `characterId`');
  return t.slice(a, b).trim();
}

// ---- a small JSON-schema validator: type, required, additionalProperties:false, minLength, maxLength, minItems, items, properties ----
export function validateSchema(value, schema, path = '$') {
  const errs = [];
  const t = schema.type;
  const isObj = value && typeof value === 'object' && !Array.isArray(value);
  if (t === 'object') {
    if (!isObj) return [`${path}: expected an object`];
    for (const k of schema.required || []) if (!(k in value)) errs.push(`${path}.${k}: missing`);
    if (schema.additionalProperties === false) for (const k of Object.keys(value)) if (!(k in (schema.properties || {}))) errs.push(`${path}.${k}: not allowed`);
    for (const [k, sub] of Object.entries(schema.properties || {})) if (k in value) errs.push(...validateSchema(value[k], sub, `${path}.${k}`));
  } else if (t === 'string') {
    if (typeof value !== 'string') return [`${path}: expected a string`];
    if (schema.minLength && value.length < schema.minLength) errs.push(`${path}: ${value.length} characters, minimum ${schema.minLength}`);
    if (schema.maxLength && value.length > schema.maxLength) errs.push(`${path}: ${value.length} characters, maximum ${schema.maxLength}`);
  } else if (t === 'array') {
    if (!Array.isArray(value)) return [`${path}: expected an array`];
    if (schema.minItems && value.length < schema.minItems) errs.push(`${path}: needs at least ${schema.minItems} item(s)`);
    value.forEach((v, i) => errs.push(...validateSchema(v, schema.items || {}, `${path}[${i}]`)));
  }
  return errs;
}

export const SLUG = /^[a-z][a-z0-9_]*$/;

export function plannedSpeakers(plan) {
  const out = new Set();
  for (const c of plan.clips) for (const s of c.shots) if (s.dialogue?.line) out.add(s.dialogue.speaker || '');
  return [...out];
}

const SCORE_ITEM = `9. "score": the film's non-diegetic score as ONE paragraph in the form of the official guide: its instrumentation, tempo and dynamic development, chosen to suit the story's genre and mood (for example a restrained solo-piano score at a slow tempo, with sustained low cello underneath). 25 to 70 words, instrumental only (no lyrics, no voices, nothing sung or chanted), written only as what is played and never as what is absent. It is the same for every clip of the film.

`;

export function buildBibleMessages(story, plan, rawAsks, { score = 'off' } = {}) {
  const speakers = plannedSpeakers(plan);
  const ledger = plan.ledger.entities.map((e) => ({ id: e.id, name: e.name, kind: e.kind }));
  const actingShape = JSON.stringify({ characterId: 'same as the cast id', masterProfile: '150-220 words, 750-1800 characters', voicePrompt: '...', objectiveEngine: '...', physicalBaseline: '...', eyeLife: '...', signatureTics: [{ tic: 'a visible habit', trigger: 'the concrete situation' }], mask: '...', crackTrigger: '...', softeningTarget: 'optional' });
  const text = `You are building the FILM BIBLE for a short film that has already been planned. Return ONE JSON object and nothing else. You invent no plot: every entity, wardrobe item and location detail must come from the story or the plan below, or be the most ordinary reading of them.

THE STORY
${String(story).trim()}

THE PLAN (every clip, in order, as the planner wrote it)
${rawAsks.join('\n\n')}

THE PLANNER'S STATE LEDGER ENTITIES (reuse these ids for the same thing; do not duplicate)
${JSON.stringify(ledger)}

DISTINCT SPEAKER STRINGS IN THE PLAN (each must be mapped to a cast id)
${JSON.stringify(speakers)}

WHAT TO RETURN

1. "language": the language of the planned dialogue lines (for example "English"); one word or name. It is the language named in the story text's DIALOGUE LANGUAGE line when there is one.
2. "speakers": an object mapping EVERY speaker string above, exactly as written, to the id of whoever speaks it: a cast id, or a voice id (item 7). A speaker that is heard but not seen in its shot (an off-screen or unseen voice, a narrator or voice-over, a voice on a phone, radio, speaker or intercom, a voice from behind a door or wall, from below, above or another room) and whom the speaker string does not name as one of the cast maps to its OWN entry in "voices", never to a cast member who is on screen. A cast member's own voice-over, where the speaker string names that character, maps to that character.
3. "cast": every recurring character who appears on screen. Each entry: "id" (lowercase snake_case slug), "name", "side" ("left" or "right": the side of the frame the character usually holds in a two-shot; with one character use "right"), "wardrobe" (array of short garment phrases, from the story; when the story says nothing use a plain, ordinary outfit that fits the setting), "appearsAs" (one short phrase, the way a reference list names the person: age, build, one or two visible traits, the outfit), "ref" (item 8) and "acting".
4. "props": every recurring object the story handles or that matters in the picture. Each: "id", "name", "appearsAs" (one short phrase), "ref" (item 8). An empty array when there are none.
5. "locations": every place the film is set. Each: "id", "name", "appearsAs" (one short phrase), "description" (one sentence of the physical set), "ref" (item 8) and "landmarks".
6. "landmarks": for each location, 2 to 6 FIXED physical features that a person could stand on, near or beside. Cover every fixed feature the planned shots name or imply (read the shot list for words such as behind her, the far end, the exit, the wall, the stairs). Never a person, a movable prop, or the surface everyone already walks or wades through (that is the base floor). Generic examples of how to describe them: a flight of steps or a ladder is a "point", walkable, level 1 (it rises above the base floor); a table or a bed is an "area"; a doorway is a "point", walkable, level 0; a wall, a rail or a counter run is "linear" with two sides; a drop below the base floor is level -1. Each landmark: "id" (lowercase snake_case, unique across the WHOLE film and different from every entity id), "gloss" (one short phrase saying what it is), "kind" ("point", "area" or "linear"), "walkable" (true when a person can stand ON it), "level" (the height of the place a person stands on it, relative to the base floor: -1 below it, 0 at it, 1 above it). A "linear" landmark is a line that separates two sides (a wall, a rail, a counter run): it also carries "sides", an array of exactly two short words naming the two sides it separates. A landmark that is not linear has no "sides".

7. "voices": every speaker of the plan who is heard but never shown on screen as a character (see item 2). Each entry: "id" (lowercase snake_case slug, unique across the whole film and different from every cast, prop, location and landmark id), "name" (a short label for the voice), "appearsAs" (one short phrase: what the voice is and where it is heard from, for example the place it carries from or the device it comes through), and "voicePrompt" (a short noun phrase of at most 25 words that completes "in the voice of ...": age and gender when the story gives them, register, pace, accent and texture, for example "a man in his fifties, gravelly and slow, with a light accent"). Write both fields as positive statements of what the voice sounds like and where it is heard from; never with the words unseen, invisible, off-screen, no, not, never or without. Describe a voice by age, register, pace, accent and the physical place or device it carries from; use no word a listener hears as music (hum, drone, resonance, resonant, tone, chord, swell, pulse). A voice has no image, no acting master and no <Subject> number in the prompt: it is written as its voice description followed by its speaker id. An empty array when every speaker is a cast member.

8. "ref": the reference-image slots of every cast member, prop and location, as follows.
${slotInstructions()}

ACTING MASTER ("acting", one per cast member). The permanent acting profile of that one character, written once and cited by every clip they appear in. It must match this shape exactly, with no extra fields:
${actingShape}
${actingContract()}
Set "characterId" to the cast member's id, verbatim. Wardrobe, camera, framing and lighting never appear in the acting master.

${score === 'on' ? SCORE_ITEM : ''}CHECK BEFORE YOU REPLY. A reply that fails any of these is rejected and asked for again: every id (entities, landmarks, voices) is lowercase snake_case with underscores only (no hyphen, space or capital); every location has 2 to 6 landmarks, each with "kind", "walkable" and "level"; every cast member's face has all nine keys, including "expression"; every cast member's garments has all six keys (neck, torso, arms, waist, legs, feet), each with all six fields (colour, item, material, weave, construction, wear), the feet too; every "acting.characterId" equals the cast id; every voicePrompt is a short noun phrase without the words unseen, invisible, off-screen, no, not, never or without and without a music-like word (hum, drone, resonant, chord, swell, pulse);${score === 'on' ? ' "score" is one instrumental paragraph of 25 to 70 words;' : ''} the reply is ONE JSON object with every bracket closed, every string quoted and no trailing comma.

Return only the JSON object: { "language": "...", "speakers": { ... },${score === 'on' ? ' "score": "...",' : ''} "cast": [ { "id", "name", "side", "wardrobe", "appearsAs", "acting", "ref" } ], "props": [ { "id", "name", "appearsAs", "ref" } ], "locations": [ { "id", "name", "appearsAs", "description", "landmarks": [ 2 to 6 of { "id", "gloss", "kind", "walkable", "level" (only -1, 0 or 1), "sides" (linear only) } ], "ref" } ], "voices": [ ... ] }. Every location carries BOTH its "landmarks" array of objects (item 6) AND its "ref" (item 8). No Markdown, no commentary.`;
  return [{ role: 'user', content: text }];
}

const MAX_REFS = 9;
export { MAX_REFS };

// Empty placeholders for optional fields are the same as an absent field: dropped before validation.
const toSlug = (x) => String(x).trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
export function normalizeBible(b) {
  if (!b || typeof b !== 'object') return b;
  // formal slips only: an id written with a hyphen, space or capital becomes the snake_case slug (every reference to it follows); a numeric field written as text becomes the number or boolean
  const rename = {};
  const fixId = (o) => { if (o && typeof o.id === 'string' && !SLUG.test(o.id)) { const t = toSlug(o.id); if (t && SLUG.test(t)) { rename[o.id] = t; o.id = t; } } };
  for (const l of Array.isArray(b.locations) ? b.locations : []) for (const m of Array.isArray(l?.landmarks) ? l.landmarks : []) {
    fixId(m);
    if (typeof m?.level === 'string' && /^[+-]?[01]$/.test(m.level.trim())) m.level = Number(m.level);
    if (m?.walkable === 'true' || m?.walkable === 'false') m.walkable = m.walkable === 'true';
  }
  for (const k of ['cast', 'props', 'locations', 'voices']) for (const e of Array.isArray(b[k]) ? b[k] : []) fixId(e);
  if (Object.keys(rename).length) {
    for (const [k, v] of Object.entries(b.speakers && typeof b.speakers === 'object' ? b.speakers : {})) if (rename[v]) b.speakers[k] = rename[v];
    for (const l of Array.isArray(b.locations) ? b.locations : []) for (const x of Array.isArray(l?.ref?.landmarkObjects) ? l.ref.landmarkObjects : []) if (x && rename[x.id]) x.id = rename[x.id];
  }
  // a landmark id that is already an entity id (a prop or place of the same name), or a landmark id used twice, is made unique with a suffix; the location's own landmarkObjects follow
  const taken = new Set(['cast', 'props', 'locations', 'voices'].flatMap((k) => (Array.isArray(b[k]) ? b[k] : []).map((e) => e?.id).filter((x) => typeof x === 'string')));
  for (const l of Array.isArray(b.locations) ? b.locations : []) {
    const local = {};
    for (const m of Array.isArray(l?.landmarks) ? l.landmarks : []) {
      if (typeof m?.id !== 'string') continue;
      if (taken.has(m.id)) { let t = `${m.id}_spot`, n = 2; while (taken.has(t)) t = `${m.id}_spot${n++}`; local[m.id] = t; m.id = t; }
      taken.add(m.id);
    }
    for (const x of Array.isArray(l?.ref?.landmarkObjects) ? l.ref.landmarkObjects : []) if (x && local[x.id]) x.id = local[x.id];
  }
  for (const c of Array.isArray(b.cast) ? b.cast : []) { if (c?.acting && typeof c.acting === 'object' && typeof c.id === 'string') { c.acting.characterId = c.id; for (const k of Object.keys(c.acting)) if (!(k in ACTING_SCHEMA.properties)) delete c.acting[k]; } if (c?.ref) normalizeRef(c.ref); if (c?.acting && c.acting.softeningTarget !== undefined && (typeof c.acting.softeningTarget !== 'string' || !c.acting.softeningTarget.trim())) delete c.acting.softeningTarget; }
  for (const c of Array.isArray(b.cast) ? b.cast : []) if (c?.acting && typeof c.acting.softeningTarget === 'string' && !c.acting.softeningTarget.trim()) delete c.acting.softeningTarget;
  for (const l of Array.isArray(b.locations) ? b.locations : []) for (const m of Array.isArray(l?.landmarks) ? l.landmarks : []) if (m && m.kind !== 'linear' && Array.isArray(m.sides) && !m.sides.length) delete m.sides;
  return b;
}

// The score of a film that wants one: an instrumental paragraph in the official form, with no absence word and no vocal part.
export function scoreIssues(text) {
  const t = String(text ?? '').trim();
  const issues = [];
  const n = t.split(/\s+/).filter(Boolean).length;
  if (!t) return ['"score" is missing'];
  if (n < 12 || n > 90) issues.push(`"score" is ${n} words, needs 25 to 70`);
  const bad = /\b(?:no|not|never|without|none|nothing|nobody|unseen|invisible|silent|silence)\b|n't\b/i.exec(t);
  if (bad) issues.push(`"score" uses the absence word "${bad[0]}"; write only what is played`);
  const vocal = /\b(?:lyrics?|vocals?|voices?|sung|sing|sings|singing|chant\w*|choir|hummed|humming)\b/i.exec(t);
  if (vocal) issues.push(`"score" names a vocal part ("${vocal[0]}"); the score is instrumental`);
  if (!/\b(?:piano|strings?|cello|violin|viola|bass|synth\w*|pad|drums?|percussion|guitar|orchestra\w*|brass|woodwinds?|flute|clarinet|harp|organ|bells?|marimba|drone|tempo|bpm|ensemble)\b/i.test(t)) issues.push('"score" names no instrument or tempo');
  return issues;
}

export function validateBible(b, plan, { score = 'off' } = {}) {
  const issues = [];
  if (!b || typeof b !== 'object') return ['the reply is not a JSON object'];
  if (typeof b.language !== 'string' || !b.language.trim()) issues.push('"language" is missing');
  const cast = Array.isArray(b.cast) ? b.cast : [], props = Array.isArray(b.props) ? b.props : [], locs = Array.isArray(b.locations) ? b.locations : [];
  const needsCast = plan.ledger.entities.some((e) => e.kind === 'character') || plannedSpeakers(plan).length > 0 || plan.clips.some((c) => c.end_state?.characters?.length);
  if (needsCast && !cast.length) issues.push('"cast" has no entries although the plan has characters');
  if (!locs.length) issues.push('"locations" has no entries');
  const seen = new Map();
  const claim = (id, where) => {
    if (typeof id !== 'string' || !SLUG.test(id)) { issues.push(`${where}: id ${JSON.stringify(id)} is not a lowercase snake_case slug`); return; }
    if (seen.has(id)) issues.push(`${where}: id "${id}" is already used by ${seen.get(id)}; every id (entities and landmarks) must be unique across the film`);
    else seen.set(id, where);
  };
  const needText = (o, keys, where) => { for (const k of keys) if (typeof o[k] !== 'string' || !o[k].trim()) issues.push(`${where}: "${k}" is missing or empty`); };
  cast.forEach((c, i) => {
    const w = `cast[${i}]`;
    claim(c.id, w); needText(c, ['name', 'appearsAs'], w); issues.push(...slotIssues('character', c.ref, w));
    if (!['left', 'right'].includes(c.side)) issues.push(`${w}: "side" must be "left" or "right"`);
    if (!Array.isArray(c.wardrobe) || !c.wardrobe.length || c.wardrobe.some((x) => typeof x !== 'string' || !x.trim())) issues.push(`${w}: "wardrobe" must be a non-empty array of strings`);
    const errs = validateSchema(c.acting, ACTING_SCHEMA, `${w}.acting`);
    issues.push(...errs);
    if (c.acting && c.acting.characterId !== c.id) issues.push(`${w}.acting.characterId must equal "${c.id}"`);
  });
  props.forEach((p, i) => { const w = `props[${i}]`; claim(p.id, w); needText(p, ['name', 'appearsAs'], w); issues.push(...slotIssues('object', p.ref, w)); });
  locs.forEach((l, i) => {
    const w = `locations[${i}]`;
    claim(l.id, w); needText(l, ['name', 'appearsAs', 'description'], w); issues.push(...slotIssues('location', l.ref, w));
    const lm = Array.isArray(l.landmarks) ? l.landmarks : [];
    if (lm.length < 2 || lm.length > 6) issues.push(`${w}: has ${lm.length} landmarks, needs 2 to 6`);
    lm.forEach((m, j) => {
      const x = `${w}.landmarks[${j}]`;
      claim(m.id, x); needText(m, ['gloss'], x);
      if (!['point', 'area', 'linear'].includes(m.kind)) issues.push(`${x}: "kind" must be point, area or linear`);
      if (typeof m.walkable !== 'boolean') issues.push(`${x}: "walkable" must be true or false`);
      if (![-1, 0, 1].includes(m.level)) issues.push(`${x}: "level" must be -1, 0 or 1`);
      if (m.kind === 'linear' && !(Array.isArray(m.sides) && m.sides.length === 2 && m.sides.every((s) => typeof s === 'string' && s.trim()))) issues.push(`${x}: a linear landmark needs "sides" with exactly two words`);
      if (m.kind !== 'linear' && m.sides !== undefined) issues.push(`${x}: only a linear landmark has "sides"`);
    });
  });
  const voices = voicesOf(b);
  if (b.voices !== undefined && !Array.isArray(b.voices)) issues.push('"voices" must be an array');
  voices.forEach((v, i) => { const w = `voices[${i}]`; claim(v.id, w); needText(v, ['name', 'appearsAs', 'voicePrompt'], w); issues.push(...voiceFieldIssues(v, w)); });
  const castIds = new Set([...cast.map((c) => c.id), ...voices.map((v) => v.id)]);
  const map = b.speakers && typeof b.speakers === 'object' && !Array.isArray(b.speakers) ? b.speakers : {};
  for (const s of plannedSpeakers(plan)) {
    if (!(s in map)) issues.push(`"speakers" has no entry for the planned speaker ${JSON.stringify(s)}`);
    else if (!castIds.has(map[s])) issues.push(`"speakers"[${JSON.stringify(s)}] = ${JSON.stringify(map[s])} is not a cast id or a voice id`);
  }
  issues.push(...speakerIssues(plan, b));
  if (score === 'on') issues.push(...scoreIssues(b.score));
  return issues;
}

// -> normalised bible with typed entity list: [{id, type, name, appearsAs, imagePrompt, ...}]
export function entityList(b) {
  const out = [];
  for (const c of b.cast) out.push({ id: c.id, type: 'character', name: c.name, appearsAs: c.appearsAs, imagePrompt: c.imagePrompt });
  for (const p of b.props) out.push({ id: p.id, type: 'object', name: p.name, appearsAs: p.appearsAs, imagePrompt: p.imagePrompt });
  for (const l of b.locations) out.push({ id: l.id, type: 'location', name: l.name, appearsAs: l.appearsAs, imagePrompt: l.imagePrompt, description: l.description });
  return out;
}

export async function makeBible(chat, story, plan, rawAsks, { score = 'off' } = {}) {
  const messages = buildBibleMessages(story, plan, rawAsks, { score });
  let parsed = null, issues = [];
  const attempts = [];
  for (let attempt = 0; attempt < 2; attempt++) {
    const msgs = attempt && issues.length ? [{ role: 'user', content: `${messages[0].content}\n\nYOUR PREVIOUS REPLY FAILED THESE CHECKS — CORRECT EXACTLY THESE AND KEEP EVERYTHING ELSE:\n${issues.slice(0, 25).join('\n')}` }] : messages;
    const reply = await chat(msgs, attempt);
    parsed = reply.ok ? normalizeBible(reply.value) : null;
    issues = parsed ? validateBible(parsed, plan, { score }) : [reply.cut ? `the reply was not one valid JSON object: ${reply.cut.note}; write the SAME structure with shorter field values and close every brace` : 'the reply was not one valid JSON object'];
    attempts.push({ attempt: attempt + 1, issues: [...issues], ...(reply.repaired ? { repaired: reply.repaired } : {}) });
    if (!issues.length) break;
  }
  return { bible: parsed, issues, attempts };
}
