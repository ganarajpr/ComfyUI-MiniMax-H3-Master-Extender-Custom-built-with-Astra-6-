// E4.2: the reference-image SLOTS of the film bible, and the code that assembles each image prompt from them.
// The bible (LLM call 2) fills structured slots per entity; no free "imagePrompt" text. Code writes the prompt with the wording and
// templates of the stored skills (character-sheet-lite-h3, intricate-location-plate incl. its "Character references" section);
// the object anchor has no skill and keeps its own discipline (the object alone, part by part, plain backdrop).
// Skill files: ~/.claude/skills/character-sheet-lite-h3/SKILL.md, ~/.claude/skills/intricate-location-plate/SKILL.md (+ examples/, scripts/render.py).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { HERE } from './lib.mjs';

export const ZONES = ['neck', 'torso', 'arms', 'waist', 'legs', 'feet'];
export const PLANES = ['foreground', 'nearMid', 'mid', 'farMid', 'horizon', 'sky'];
export const FACE_KEYS = ['cheekbones', 'eyes', 'brows', 'noseBridge', 'jaw', 'lips', 'asymmetry', 'mark', 'expression'];

// image size and seeds per kind (the skills' measured sizes; seeds the skills measured clean)
export const KINDS = {
  character: { w: 2304, h: 1312, seeds: [814952494, 21], skill: 'character-sheet-lite-h3 + intricate-location-plate (Character references)' },
  location: { w: 1664, h: 928, seeds: [2811, 21], skill: 'intricate-location-plate' },
  object: { w: 1408, h: 1408, seeds: [21, 814952494], skill: 'none stored: object anchor discipline (the object alone, part by part, plain backdrop)' },
};

// ---- worked examples: an invented ferry landing, keeper and boat hook, written in the compact style the checks need (they pass every check) ----
const arr = (...a) => a;
export const EXAMPLE_LOC = {
  interior: false,
  viewpoint: 'a low camera on the landing stage looking toward the headland',
  landmark: { name: 'a whitewashed signal mast with a rope ladder', parts: arr('a slate-grey tapered mast with iron hoops', 'a salt-bleached rope ladder', 'a copper-green weather vane shaped like a gull', 'a faded orange pennant on a short yard') },
  planes: {
    foreground: arr('a coiled hemp hawser', 'a rust-brown iron mooring ring', 'a cracked clay oil jar', 'a tarred wooden bollard', 'a frayed straw mat'),
    nearMid: arr('an upturned clinker rowing boat', 'a stack of pale cedar oars', 'a rusted anchor with a weed-green fluke', 'a barrel of grey fish netting', 'a wicker eel trap'),
    mid: arr('a low stone boat shed with a mossy slate roof', 'a pair of sagging oak doors', 'a hand-painted ochre sign board', 'a drying rack of brown nets', 'a wooden slipway'),
    farMid: arr('a row of chalk-white terraced cottages', 'a crooked chimney with a clay pot', 'a rain barrel under a drainpipe', 'a washing line with blue-grey sheets', 'a low drystone wall'),
    horizon: arr('a rocky headland with a stone beacon', 'a line of dark pines on the ridge', 'a wooden jetty reaching into the bay', 'a small red-sailed fishing smack', 'a distant lighthouse'),
    sky: arr('towering pearl-grey cumulus lit pink at the base', 'a flock of gulls over the mast', 'a thin crescent moon', 'a band of amber cloud'),
  },
  surfaces: arr({ on: 'the oak doors', motif: 'iron strap hinges with hammered fleur-de-lis ends' }, { on: 'the rowing boat', motif: 'a painted band of repeating white waves' }, { on: 'the sign board', motif: 'a carved border of rope knots' }, { on: 'the signal mast', motif: 'carved spiral grooves' }),
  scale: arr('a standard doorway in the shed wall', 'six worn stone steps', 'a three-legged milking stool', 'a tin mug on the bollard'),
  atmosphere: arr('Thick bands of sea mist drift between the boat shed and the terraced cottages', 'Thin wood smoke rises from the crooked chimney and flattens against the ridge'),
  skyEvent: 'the low sun breaks under a cloud edge and throws one shaft of amber light across the bay',
  light: { key: 'Warm low sunlight from the left', fill: 'a cool blue skylight fills the shadows from above', effect: 'the raking light picks out every plank grain, rope strand and carved groove with long soft shadows' },
  optics: { lens: 'a 28 mm lens', gradeA: 'warm amber', gradeB: 'teal blue' },
  actionZone: { surface: 'smooth swept planks of the landing', for: 'a face-to-face conversation', where: 'centre' },
  zoneEdges: arr('a row of lashed oak crates', 'a tarred rope fender on a post', 'a hanging iron lantern with amber panes', 'a chalked tally board'),
  landmarkObjects: arr({ id: 'mast', object: 'a whitewashed signal mast with a rope ladder' }, { id: 'landing', object: 'a wooden slipway' }),
};
export const EXAMPLE_CHAR = {
  gender: 'female', age: 'late fifties', build: 'tall and wiry', skin: 'weathered olive skin with a warm undertone',
  face: { cheekbones: 'high flat cheekbones', eyes: 'deep-set almond eyes with grey-green irises', brows: 'straight heavy brows with a grey streak', noseBridge: 'a straight nose bridge with a slight bump', jaw: 'a narrow square jaw', lips: 'thin lips, the lower one cracked', asymmetry: 'the left eye sits slightly lower', mark: 'a small white scar across the right chin', expression: 'watchful' },
  hair: { architecture: 'a long braid pinned in a coil at the nape', colour: 'iron grey with dark brown roots and a white forelock', holds: 'two bone pins and a strip of waxed cord' },
  headOrnament: 'a knitted wool cap in charcoal violet with a zig-zag border',
  garments: [
    { zone: 'neck', colour: 'faded indigo', item: 'a knotted scarf', material: 'coarse cotton', weave: 'a fine check weave', construction: 'raw hemmed edges', wear: 'bleached along the folds' },
    { zone: 'torso', colour: 'rust brown', item: 'a buttoned work jacket', material: 'waxed canvas', weave: 'a tight twill weave', construction: 'double-stitched seams and four horn buttons', wear: 'patched at the left elbow' },
    { zone: 'arms', colour: 'oatmeal cream', item: 'long knitted sleeves', material: 'lambswool', weave: 'a cable-knit pattern', construction: 'ribbed cuffs', wear: 'pilled at the wrists' },
    { zone: 'waist', colour: 'bark brown', item: 'a wide belt', material: 'cracked leather', weave: 'a stamped rope border', construction: 'a brass buckle and riveted loops', wear: 'darkened with sweat' },
    { zone: 'legs', colour: 'slate green', item: 'loose trousers', material: 'heavy linen', weave: 'a plain slub weave', construction: 'knee patches and a drawstring waist', wear: 'frayed at the hems' },
    { zone: 'feet', colour: 'tar black', item: 'ankle boots', material: 'oiled leather', weave: 'a stitched toe cap', construction: 'hobnailed soles and rawhide laces', wear: 'scuffed pale at the toes' },
  ],
  accent: { colour: 'saffron yellow', place: 'on the inner lining of the jacket collar' },
  signsOfLife: arr('a patched left elbow', 'frayed trouser hems', 'a smear of tar on the right sleeve'),
  accessory: { item: 'a brass whistle on a cord', story: 'its mouthpiece worn smooth from years of use' },
  hands: 'Rope-calloused hands with cracked nails and a tar stain across the right thumb',
  backDetail: 'the coiled braid, the patched back of the jacket and the knotted cord',
  carriedProps: [], renderStyle: 'live-action photoreal film still',
};
export const EXAMPLE_PROP = { object: 'a hand-forged iron boat hook', scale: 'about the length of a forearm', parts: arr({ part: 'hook', colour: 'rust brown', material: 'forged iron', motif: 'a twisted barb', wear: 'pitted with rust' }, { part: 'shaft', colour: 'weathered grey', material: 'ash wood', motif: 'a spiral of bound cord', wear: 'polished by hands' }, { part: 'ferrule', colour: 'dull gold', material: 'brass', motif: 'three engraved rings', wear: 'dented at the rim' }) };

const str = (v) => typeof v === 'string' && v.trim().length > 0;
const strs = (v) => Array.isArray(v) && v.every((x) => typeof x === 'string');
const obj = (v) => v && typeof v === 'object' && !Array.isArray(v);

// ---- structure only (presence and types): a malformed reply must not pass; content minimums are the checks of refchecks.mjs ----
export function slotIssues(kind, ref, where) {
  const e = [];
  if (!obj(ref)) return [`${where}.ref: missing or not an object`];
  const need = (o, keys, w) => { for (const k of keys) if (!str(o?.[k])) e.push(`${w}.${k}: missing or empty`); };
  if (kind === 'character') {
    need(ref, ['gender', 'age', 'build', 'skin', 'headOrnament', 'hands', 'backDetail', 'renderStyle'], `${where}.ref`);
    if (!obj(ref.face)) e.push(`${where}.ref.face: missing`); else need(ref.face, FACE_KEYS, `${where}.ref.face`);
    if (!obj(ref.hair)) e.push(`${where}.ref.hair: missing`); else need(ref.hair, ['architecture', 'colour', 'holds'], `${where}.ref.hair`);
    if (!Array.isArray(ref.garments)) e.push(`${where}.ref.garments: missing`);
    else for (const z of ZONES) {
      const g = ref.garments.find((x) => x?.zone === z);
      if (!g) e.push(`${where}.ref.garments: no entry for the zone "${z}"`); else need(g, ['colour', 'item', 'material', 'weave', 'construction', 'wear'], `${where}.ref.garments[${z}]`);
    }
    if (!obj(ref.accent)) e.push(`${where}.ref.accent: missing`); else need(ref.accent, ['colour', 'place'], `${where}.ref.accent`);
    if (!obj(ref.accessory)) e.push(`${where}.ref.accessory: missing`); else need(ref.accessory, ['item', 'story'], `${where}.ref.accessory`);
    if (!strs(ref.signsOfLife)) e.push(`${where}.ref.signsOfLife: must be an array of strings`);
    if (!strs(ref.carriedProps)) e.push(`${where}.ref.carriedProps: must be an array of strings (empty when nothing is carried in every clip)`);
  } else if (kind === 'location') {
    if (typeof ref.interior !== 'boolean') e.push(`${where}.ref.interior: must be true or false`);
    need(ref, ['viewpoint', 'skyEvent'], `${where}.ref`);
    if (!obj(ref.landmark) || !str(ref.landmark.name) || !strs(ref.landmark.parts)) e.push(`${where}.ref.landmark: needs "name" and an array "parts"`);
    if (!obj(ref.planes)) e.push(`${where}.ref.planes: missing`); else for (const p of PLANES) if (!strs(ref.planes[p])) e.push(`${where}.ref.planes.${p}: must be an array of strings`);
    if (!Array.isArray(ref.surfaces) || ref.surfaces.some((s) => !str(s?.on) || !str(s?.motif))) e.push(`${where}.ref.surfaces: array of {on, motif}`);
    for (const k of ['scale', 'atmosphere', 'zoneEdges']) if (!strs(ref[k])) e.push(`${where}.ref.${k}: must be an array of strings`);
    if (!obj(ref.light)) e.push(`${where}.ref.light: missing`); else need(ref.light, ['key', 'fill', 'effect'], `${where}.ref.light`);
    if (!obj(ref.optics)) e.push(`${where}.ref.optics: missing`); else need(ref.optics, ['lens', 'gradeA', 'gradeB'], `${where}.ref.optics`);
    if (!obj(ref.actionZone)) e.push(`${where}.ref.actionZone: missing`); else need(ref.actionZone, ['surface', 'for', 'where'], `${where}.ref.actionZone`);
    if (!Array.isArray(ref.landmarkObjects) || ref.landmarkObjects.some((x) => !str(x?.id) || !str(x?.object))) e.push(`${where}.ref.landmarkObjects: array of {id, object}`);
  } else {
    need(ref, ['object', 'scale'], `${where}.ref`);
    if (!Array.isArray(ref.parts) || ref.parts.some((p) => !str(p?.part) || !str(p?.colour) || !str(p?.material) || !str(p?.motif) || !str(p?.wear))) e.push(`${where}.ref.parts: array of {part, colour, material, motif, wear}`);
  }
  return e;
}

// E4.3: the model writes garments as an object keyed by zone (one key per zone cannot repeat or skip a "zone" field); the rest of the code keeps the array of {zone, ...}.
export const refForPrompt = (ref) => (ref && Array.isArray(ref.garments) ? { ...ref, garments: Object.fromEntries(ref.garments.map(({ zone, ...rest }) => [zone, rest])) } : ref);
export function normalizeRef(ref) {
  if (ref && ref.garments && typeof ref.garments === 'object' && !Array.isArray(ref.garments)) ref.garments = Object.entries(ref.garments).filter(([, v]) => v && typeof v === 'object').map(([zone, v]) => ({ zone, ...v })).sort((a, b) => ZONES.indexOf(a.zone) - ZONES.indexOf(b.zone));
  return ref;
}

// ---- the instruction block of the bible call (and of a targeted repair) ----
const RULES = `REFERENCE-IMAGE SLOTS ("ref"). No image is generated now. Every cast member, prop and location carries a "ref" object of structured slots, and CODE assembles the image prompt from your slots with the stored skills' templates. So every slot is a short, concrete, visible, physical fact, never an opinion. Rules for every slot:
- Name the material, the motif and the colour of every object. Colour is bound to its noun ("faded indigo wool coat"), never a detached palette.
- Use mixed colour names (faded indigo, rust brown, charcoal violet, bone white), never a bare base colour such as red, blue, green, brown, grey, black, white, yellow, orange, purple or pink.
- No evaluative words (beautiful, handsome, pretty, stunning, epic, perfect, cool, stylish, flawless, amazing, glowing, radiant). Describe light physically: surfaces reflect, catch and absorb light.
- Write only positive statements of what IS there. Never write the words no, not, without, never, none, nothing or nor, and never a contraction such as isn't.
- Every list item (planes, parts, scale, surfaces, edges, carried props) and every garment item is a noun phrase that starts with an article (a, an, the) or a number and holds no comma. The prompt is assembled by joining the items into sentences, so write each as a part of a sentence, not a note.
- Original faces and figures only, never a real person. Everything comes from the story or the plan, or is the most ordinary reading of them; an added detail (a mark, a stitch, a motif) must not contradict them.`;

const CAST_SLOTS = `For a CAST member, "ref" is (all values are short phrases; the shape is exact):
{
 "gender": "female, male or nonbinary",
 "age": "a phrase such as mid-fifties",
 "build": "height and frame in a few words",
 "skin": "the skin tone with its undertone, for example warm olive with a golden undertone",
 "face": { "cheekbones": "concrete bone structure, for example high and flat", "eyes": "eye shape plus iris colour", "brows": "shape, thickness and colour", "noseBridge": "...", "jaw": "...", "lips": "...", "asymmetry": "one natural asymmetry", "mark": "ONE specific mark (a scar, a mole, freckles, a burn) and where", "expression": "default expression in one or two words" }. The code writes each face value after its label ("Cheekbones: ...").
 "hair": { "architecture": "length, texture and how it is arranged", "colour": "multi-tone colour", "holds": "what holds it (a pin, a cord, a clip, a cap)" },
 "headOrnament": "the head or face item with named motifs and materials (spectacles, a cap, earrings, a headscarf, a beard trim...)",
 "garments": an object with exactly six keys, in this order: neck, torso, arms, waist, legs, feet. Each key holds { "colour": "mixed colour name", "item": "the garment", "material": "the fabric or material", "weave": "weave or named motif", "construction": "stitching, seams, pleats, buttons, rivets", "wear": "visible wear" }. For the key feet the item is the footwear, its weave is the pattern of its upper or toe cap and its construction is its sole and fastening. All six keys are required, including legs, and every key holds all six fields, the feet too.
 "accent": { "colour": "ONE high-contrast colour", "place": "ONE small place, starting with a preposition, for example on the lining of the collar" },
 "signsOfLife": ["at least two: a patch, fraying, a scar, an asymmetry, dirt"],
 "accessory": { "item": "ONE worn accessory", "story": "what its visible wear says about its history" },
 "hands": "what the hands show (calluses, stains, nails, rings)",
 "backDetail": "what is visible only from behind: the back of the hair and of the garments",
 "carriedProps": ["ONLY objects this character carries in EVERY clip of the plan, each described part by part. Usually an empty array. An object used in only some clips is NOT listed: anything drawn on a reference sheet appears in every clip."],
 "renderStyle": "live-action photoreal film still"
}
Every item of the cast member's "wardrobe" list appears among the garments, and no garment contradicts it. A cast member's ref never contains a place, a second person or a scene.
Worked example (an invented ferry keeper; it shows the format and the level of detail only; use only facts of THIS film): ${JSON.stringify(refForPrompt(EXAMPLE_CHAR))}`;

const LOC_SLOTS = `For a LOCATION, "ref" is a plate that stays EMPTY of the cast and dense with named objects (all values are short phrases; the shape is exact):
{
 "interior": true or false,
 "viewpoint": "camera height and where it looks, for example a low camera at the doorway looking along the length of the room",
 "landmark": { "name": "ONE hero landmark: the dominant structure or object of the place", "parts": ["3 to 6 parts, each of 3 to 6 words with colour, material and its feature"] },
 "planes": { "foreground": [...], "nearMid": [...], "mid": [...], "farMid": [...], "horizon": [...], "sky": [...] } with 2 to 5 NAMED physical objects in each plane, each a phrase of 3 to 6 words with colour and material bound to it. For an interior, horizon is the far wall or far end of the room and sky is the ceiling zone.
 "surfaces": [ { "on": "an object named in the planes", "motif": "technique and named motif, for example a repeating band of carved petals" } ] (at least 4),
 "scale": ["3 to 5 objects of a known size (a door, steps, a stool, a cup), never people or animals"],
 "atmosphere": ["1 to 3 short sentences with a verb, each naming haze, smoke, dust or steam in bands that pass between two NAMED planes or objects"],
 "skyEvent": "one short sentence with a verb: the sky (for an interior, the ceiling and its light) does something: lit clouds, a beam, birds, weather, a pattern of light",
 "light": { "key": "ONE motivated key source with its direction", "fill": "the fill", "effect": "what the key does to the texture of named surfaces" },
 "optics": { "lens": "for example a 24 mm lens", "gradeA": "first colour of the grade", "gradeB": "second colour of the grade" },
 "actionZone": { "surface": "the floor or ground material of the open zone, starting with an article", "for": "the action of the plan that happens there, as a noun phrase that names no person (a conversation, a chase, a dance, a duel)", "where": "one or two words: its position in the frame, for example centre or left third" },
 "zoneEdges": ["at least 4 named objects, with colour and material, that surround the open zone"],
 "landmarkObjects": [ { "id": "<the id of one landmark of this location>", "object": "the exact phrase of the plane object that IS that landmark" } ] (one entry per landmark)
}
The open action zone is the only open area; everything around it is dense. Never describe the whole place as empty, barren, deserted or still. Together the planes, the landmark parts, the scale objects, the surface motifs and the zone-edge objects name at least 45 distinct physical objects; an item that names two objects (a crooked chimney with a clay pot) counts two, an item with no article counts one. Most planes carry 4 or 5 items. The assembled paragraph must be 400 to 550 words and the assembly adds about 90 words of fixed wording, so ALL the slot phrases together total about 310 to 450 words: keep every list item to 3 to 6 words. Worked budget: 50 objects of 5 words each is 250 words, the landmark parts add 25, and the viewpoint, atmosphere, sky, light, optics and action-zone sentences add about 100. Every landmark of the location (item 6) appears as a named object in the planes, and landmarkObjects says which phrase it is. Every place the plan's action needs a person to stand (the staging landmarks) is a named object of the plate.
A quota that reaches 45 even with one object per item: 5 + 5 + 5 + 5 + 5 + 4 items in the six planes, 4 landmark parts, 4 surface motifs, 4 scale items, 4 zone-edge items, plus the landmark itself.
Worked example (an invented ferry landing; it shows the format, the length and the quota only; it assembles to 516 words and counts 60 named objects; use only facts of THIS film): ${JSON.stringify(EXAMPLE_LOC)}`;

const PROP_SLOTS = `For a PROP, "ref" is an object anchor: the object alone, part by part (all values are short phrases; the shape is exact):
{
 "object": "the object, for example a hand-forged iron key",
 "parts": [ { "part": "a part of the object", "colour": "mixed colour name", "material": "...", "motif": "surface motif or construction", "wear": "visible wear" } ] (at least 3, covering the whole object),
 "scale": "its size relative to a hand or a common object"
}
Worked example (an invented boat hook; format only): ${JSON.stringify(EXAMPLE_PROP)}`;

export const slotInstructions = () => [RULES, CAST_SLOTS, LOC_SLOTS, PROP_SLOTS].join('\n\n');
export const slotInstructionsFor = (kind) => [RULES, { character: CAST_SLOTS, location: LOC_SLOTS, object: PROP_SLOTS }[kind]].join('\n\n');

// ---- assembly ----
const clean = (s) => String(s ?? '').replace(/\s+/g, ' ').trim().replace(/[.,;:\s]+$/, '');
const lc = (s) => { const t = clean(s); return t ? t.charAt(0).toLowerCase() + t.slice(1) : t; };
const cap = (s) => { const t = clean(s); return t ? t.charAt(0).toUpperCase() + t.slice(1) : t; };
export const list = (a) => { const x = a.map(clean).filter(Boolean); return x.length < 2 ? x.join('') : `${x.slice(0, -1).join(', ')} and ${x[x.length - 1]}`; };
const NOUN = { female: 'woman', male: 'man' };

const ZONE_LEAD = { neck: 'At the neck', torso: 'On the torso', arms: 'On the arms', waist: 'At the waist', legs: 'On the legs', feet: 'On the feet' };

// busy costume: the costume paragraph is long enough that a fifth limb is a risk (character skill: "exactly two arms" when the costume is busy)
export const BUSY_WORDS = 90;

export function costumeText(ref) {
  const rows = ZONES.map((z) => ref.garments.find((g) => g.zone === z)).filter(Boolean);
  return rows.map((g) => `${ZONE_LEAD[g.zone]}, ${lc(g.item)} in ${lc(g.colour)} ${lc(g.material)} with ${lc(g.weave)}, ${lc(g.construction)}, ${lc(g.wear)}.`).join(' ');
}

export function assembleSheet(ref) {
  const noun = NOUN[String(ref.gender).toLowerCase()] || 'person';
  const f = ref.face, h = ref.hair;
  const costume = costumeText(ref);
  const busy = costume.split(/\s+/).length >= BUSY_WORDS;
  const props = (ref.carriedProps || []).filter((p) => clean(p));
  const carried = props.length ? `In the hands: ${list(props.map(lc))}.` : 'Both hands hang open at the sides.';
  return [
    `Character reference sheet, ${lc(ref.renderStyle)}, of one ${noun}, ${lc(ref.age)}, ${lc(ref.build)}, four panels side by side in one wide image on a plain seamless light-grey studio backdrop, the same person in the same costume in every panel, evenly spaced with clear gaps between panels.`,
    `Panel 1 at far left: full-body front view, head to toe, standing upright with relaxed arms. Panel 2: full-body three-quarter view turned to the left, head to toe. Panel 3: full-body back view, head to toe, showing ${lc(ref.backDetail)}. Panel 4 at far right: head-and-shoulders close-up of the face, a ${lc(f.expression)} gaze into the lens, filling the panel.`,
    `The face is identical in every panel. Skin: ${lc(ref.skin)}, with real pores and fine texture. Cheekbones: ${lc(f.cheekbones)}. Eyes: ${lc(f.eyes)}. Brows: ${lc(f.brows)}. Nose bridge: ${lc(f.noseBridge)}. Jaw: ${lc(f.jaw)}. Lips: ${lc(f.lips)}. Asymmetry: ${lc(f.asymmetry)}. Mark: ${lc(f.mark)}.`,
    `Hair: ${lc(h.architecture)}, ${lc(h.colour)}, held by ${lc(h.holds)}. ${cap(ref.headOrnament)}.`,
    costume,
    `One small accent of ${lc(ref.accent.colour)} sits ${lc(ref.accent.place)}; every other colour of the costume is a mixed tone.`,
    `Signs of life: ${list((ref.signsOfLife || []).map(lc))}. Accessory: ${lc(ref.accessory.item)}, ${lc(ref.accessory.story)}. ${cap(ref.hands)}. ${carried}${busy ? ' The figure has exactly two arms.' : ''}`,
    'Soft large key light from the front left and a subtle rim light from behind, identical lighting in all four panels, even exposure head to toe, deep focus so every thread, button and stitch stays sharp, natural colour, fine film grain.',
    'The backdrop is one plain seamless light-grey sheet, the image holds only these four views of this one person, the skin shows visible pores and fine hair, and the costume stays identical in all four panels.',
  ].join(' ');
}

const PLANE_LEAD = {
  outdoor: { foreground: 'In the near foreground', nearMid: 'In the near middle ground', mid: 'In the middle ground', farMid: 'In the far middle ground', horizon: 'At the horizon', sky: 'In the sky' },
  indoor: { foreground: 'In the near foreground', nearMid: 'In the near middle ground', mid: 'In the middle ground', farMid: 'In the far middle ground', horizon: 'At the far end of the space', sky: 'Overhead' },
};

export function assemblePlate(ref, name) {
  const lead = PLANE_LEAD[ref.interior ? 'indoor' : 'outdoor'];
  const L = ref.landmark, P = ref.planes, Z = ref.actionZone, O = ref.optics, Lt = ref.light;
  const surfaces = (ref.surfaces || []).map((s) => `on ${lc(s.on)}, ${lc(s.motif)}`);
  return [
    `A wide 16:9 live-action photoreal film still of the ${lc(clean(name).replace(/^the\s+/i, ''))}, seen from ${lc(ref.viewpoint)}.`,
    `The hero landmark of the frame is ${lc(L.name)}, built from ${list(L.parts.map(lc))}.`,
    ...PLANES.map((k) => `${lead[k]}: ${list(P[k].map(lc))}.`),
    `Crafted surfaces: ${surfaces.join('; ')}.`,
    `For scale, ${list(ref.scale.map(lc))} give known sizes.`,
    ...ref.atmosphere.map((a) => `${cap(a)}.`),
    `${cap(ref.skyEvent)}.`,
    `The ${lc(Z.where).replace(/^(?:in |at |on )?(?:the )?/, '').replace(/ (?:of|in) the frame$/, '')} of the frame holds an open action zone of ${lc(Z.surface).replace(/^(?:the|a|an)\s+/, '')}, wide enough for ${lc(Z.for)}; the zone holds only that surface and is clear of any structure. Everything around that open ground is dense with detail: ${list(ref.zoneEdges.map(lc))}.`,
    `${cap(Lt.key)}. ${cap(Lt.fill)}. ${cap(Lt.effect)}.`,
    `Shot on ${lc(O.lens)} with deep focus from the nearest foreground object to the far end of the frame, fine film grain, a two-colour grade of ${lc(O.gradeA)} and ${lc(O.gradeB)}, extremely intricate material detail on every surface.`,
  ].join(' ');
}

export function assembleProp(ref) {
  const parts = ref.parts.map((p) => `The ${lc(p.part).replace(/^(?:the|a|an)\s+/, '')} is ${lc(p.colour)} ${lc(p.material)} with ${lc(p.motif)}, ${lc(p.wear)}.`);
  return [
    `Product reference photograph, live-action photoreal film still, of ${lc(ref.object)}, the object alone, centred on a plain seamless light-grey backdrop and resting upright by itself.`,
    ...parts,
    `Its size is ${lc(ref.scale)}.`,
    'Soft large key light from the front left with a gentle fill from the right, deep focus so every detail of the object stays sharp, natural colour, fine film grain.',
  ].join(' ');
}

export const assemble = (kind, ref, name) => (kind === 'character' ? assembleSheet(ref) : kind === 'location' ? assemblePlate(ref, name) : assembleProp(ref));

// ---- comparison mode: the extra LLM call that writes the image prompt instead of the code ----
// Location: the system prompt of the intricate-location-plate skill, verbatim (vendor/prompts/plate_skill_system.md).
export const PLATE_SYSTEM = readFileSync(join(HERE, 'vendor/prompts/plate_skill_system.md'), 'utf8').replace(/\r\n/g, '\n').trim();

// Character and object: the equivalent, built from the rules of character-sheet-lite-h3 and the plate skill's "Character references" section.
export const CHARACTER_SYSTEM = `You write prompts for Qwen Image 2.1 character reference sheets. Given a brief, output ONE English paragraph of 380-560 words describing the finished image as if observing it, and nothing else. The canvas is 2304x1312 with four panels side by side, left to right: (1) full-body front view, (2) full-body three-quarter view, (3) full-body back view, (4) head-and-shoulders face close-up; say "head to toe" for every full-body panel, put clear gaps between the panels, and say the lighting is identical in all four panels. Use a plain seamless light-grey studio backdrop. Write the dense costume paragraph ONCE and say "the same person in the same costume in every panel". Face in concrete bone structure (cheekbones, eye shape plus iris colour, brows, nose bridge, jaw, lips) with real skin texture, natural asymmetry and ONE specific mark. Hair architecture and what holds it, with multi-tone colour. Head or face ornament with named motifs. Then neck, torso, arms, waist, legs and feet top to bottom, each garment with material, weave or motif, construction and wear. Use mixed colour names, never a base colour, plus exactly ONE high-contrast accent at one small place. At least two signs of life, one accessory with a story, hands doing something specific. Density goes on the body, never around it: put only the props the brief lists as carried in every clip on the sheet, and no other prop. Say "exactly two arms" when the costume is busy. End with the light, "deep focus so every thread stays sharp", and film grain. Qwen runs at cfg 1.0 and ignores negative prompts, so state every exclusion affirmatively: never use the words no, not, without or never. No evaluative words (beautiful, handsome, stunning, epic, perfect, flawless, glowing), no empty adjectives. Original faces only. Keep every fact of the brief unchanged.`;

export const OBJECT_SYSTEM = `You write prompts for Qwen Image 2.1 object reference plates. Given a brief, output ONE English paragraph of 120-220 words describing the finished image as if observing it, and nothing else. The object alone, centred on a plain seamless light-grey backdrop, resting upright by itself, described part by part with the colour, material, surface motif and wear of each part, its size relative to a hand or a common object, one soft key light with its direction, deep focus and film grain. Bind colour to each noun. Qwen runs at cfg 1.0 and ignores negative prompts, so state every exclusion affirmatively: never use the words no, not, without or never. No evaluative words (beautiful, stunning, epic, perfect, glowing). Keep every fact of the brief unchanged.`;

export const refwriterSystem = (kind) => (kind === 'location' ? PLATE_SYSTEM : kind === 'character' ? CHARACTER_SYSTEM : OBJECT_SYSTEM);

// The brief handed to the writer: the same slots the code template uses, as a labelled list, plus the facts the skill says to keep.
export function refwriterBrief(kind, ent, loc) {
  const out = [`ENTITY: ${ent.name} (${kind}); ${ent.appearsAs}`];
  if (kind === 'character') out.push('SIZE: 2304x1312, four panels.', `WARDROBE (all of it appears): ${ent.wardrobe.join('; ')}`, `PROPS CARRIED IN EVERY CLIP (the only props on the sheet): ${ent.ref.carriedProps.length ? ent.ref.carriedProps.join('; ') : 'none, the hands are free'}`);
  if (kind === 'location') out.push('SIZE: 1664x928 (16:9).', `PLACE: ${ent.description}`, `LANDMARKS (keep each of these object phrases verbatim as a named object of the plate): ${ent.ref.landmarkObjects.map((x) => x.object).join('; ')}`, 'The plate stays empty of every person and animal.');
  if (kind === 'object') out.push('SIZE: 1408x1408.');
  out.push('SLOTS (every value is a fixed fact of the brief):', JSON.stringify(ent.ref, null, 1));
  void loc;
  return out.join('\n');
}

const wc = (x) => String(Array.isArray(x) ? x.join(' ') : typeof x === 'object' ? JSON.stringify(Object.values(x)) : x).split(/\s+/).filter(Boolean).length;
// where the words of a plate's slots are (a repair that must cut words needs to see them)
export function slotWordTable(ref) {
  const rows = [['landmark', wc([ref.landmark.name, ...ref.landmark.parts])], ...PLANES.map((k) => [`planes.${k} (${ref.planes[k].length} objects)`, wc(ref.planes[k])]), ['surfaces', wc(ref.surfaces.map((x) => `${x.on} ${x.motif}`))], ['scale', wc(ref.scale)], ['atmosphere and skyEvent', wc([...ref.atmosphere, ref.skyEvent])], ['light and optics', wc([ref.light, ref.optics])], ['actionZone and zoneEdges', wc([ref.actionZone, ...ref.zoneEdges])], ['viewpoint', wc(ref.viewpoint)]];
  return rows.map(([k, n]) => `${k}: ${n} words`).join('\n');
}

export const repairPrompt = ({ kind, ent, story, rawAsks, issues, landmarks }) => `You are correcting the reference-image slots of ONE entity of a film bible. The film's story and plan are below for grounding; change only what the failed checks need and keep every other slot value unchanged.

THE STORY
${String(story).trim()}

THE PLAN (every clip, in order)
${rawAsks.join('\n\n')}

THE ENTITY: ${ent.name} (${kind}); ${ent.appearsAs}${kind === 'character' ? `\nWARDROBE: ${JSON.stringify(ent.wardrobe)}` : ''}${kind === 'location' ? `\nPLACE: ${ent.description}\nLANDMARKS (ids and glosses): ${JSON.stringify(landmarks)}` : ''}

ITS CURRENT "ref" SLOTS
${JSON.stringify(refForPrompt(ent.ref), null, 1)}${kind === 'location' ? `\n\nWHERE THE WORDS OF THE SLOTS ARE (the assembled paragraph is these words plus about 90 fixed words; it must be 400 to 550 words)\n${slotWordTable(ent.ref)}` : ''}

THE ASSEMBLED PROMPT FAILED THESE CHECKS
${issues.map((i) => `- ${i}`).join('\n')}

${slotInstructionsFor(kind)}

Return only the corrected "ref" JSON object for this one entity, in the exact shape above. No Markdown, no commentary.`;
