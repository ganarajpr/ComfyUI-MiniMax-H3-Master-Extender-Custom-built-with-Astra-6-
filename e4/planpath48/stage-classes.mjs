// E4.5 staging option classes. Every class here is a DEFINITION by noun class and verb relation; none is a list of one story's items.
//   surface   : furniture and supports a person sits, lies or stands on, or a thing rests on (bed, bench, seat, table, shelf)
//   sittable  : a surface to sit or lie on (bed, couch, bench, chair); a table or shelf is a surface but not sittable
//   wide      : a surface that holds two people side by side (bed, bench, sofa)
//   top       : a linear landmark whose top can be stood on or set things on (parapet, wall top, railing, a burner run)
//   stepway   : a way up and down (steps, ladder, slope)
//   depth     : a hole or drop one looks down into (shaft, well, pit)
//   opening   : a way through (door, gate, threshold, hatch, a flap in a tent or curtain)
//   wearable  : jewellery, garments, headwear, footwear, eyewear, bands and watches, or any prop the text puts on a body (wears, tied around the neck, on the wrist)
const words = (s) => String(s || '').toLowerCase().match(/[a-z]+/g) || [];
export const stem = (w) => (w.length > 4 && /ies$/.test(w) ? `${w.slice(0, -3)}y` : w.length > 4 && /ves$/.test(w) ? `${w.slice(0, -3)}f` : /(?:ss|us|is)$/.test(w) ? w : /(?:[sx]|ch|sh)es$/.test(w) ? w.slice(0, -2) : w.length > 3 && /s$/.test(w) ? w.slice(0, -1) : w);
const cls = (list) => new Set(list.split(/\s+/).filter(Boolean).map(stem));

const FAMILIES = [
  cls('bed cot bunk mattress'),
  cls('couch sofa settee divan'),
  cls('bench pew'),
  cls('chair armchair stool seat'),
  cls('table desk counter sideboard dresser'),
  cls('shelf bookshelf bookcase cabinet wardrobe'),
];
const SURFACE = new Set([...FAMILIES.flatMap((f) => [...f]), stem('furniture')]);
const WIDE = cls('bed cot bunk mattress couch sofa settee divan bench pew');
const TOP_NOUN = cls('parapet wall railing rail balustrade ledge beam fence kerb curb stove burner hob cooker');
const NOT_SOLID = cls('glass window canvas tent curtain screen net mesh fog');
const STEPWAY = cls('steps stairs staircase stairway ladder rungs slope ramp incline escalator');
const DEPTH = cls('shaft well pit hole hatch trench ravine gorge chasm drop pond lake canal moat');
const OPENING = cls('door doorway gate gateway threshold entrance exit opening hatch mouth archway arch portal flap passage');
const FLEXIBLE = cls('canvas tent curtain veil drape flap');

// the head of a landmark: its id words and the first noun phrase of its gloss (a preposition or a semicolon ends it)
const HEAD_CUT = /[;,]|\b(?:against|around|beside|behind|inside|outside|from|to|at|into|leading|rising|holding|separating|where|that|with|beyond|below|above|under|along|across|over|hanging|hung|strung|draped|stretched)\b/i;
const PROP_CUT = /\b(?:on|in|of|for|holding|made)\b|[;,]|\b(?:against|around|beside|behind|inside|outside|from|to|at|into|with|where|that)\b/i;
export const headWords = (l) => words(`${String(l.id).replace(/_/g, ' ')} ${String(l.gloss || '').split(HEAD_CUT)[0]}`).map(stem);
// a compound names its class by its last element (a wristwatch is a watch, a workbench is a bench)
const SUFFIX = cls('watch glove shirt coat boot shoe scarf jacket necklace bracelet earring anklet pendant wristband headband bench table chair stool shelf couch');
const isMember = (w, set, suffixable) => set.has(w) || (suffixable && w.length > 5 && [...suffixable].some((n) => n.length >= 4 && w.endsWith(n) && set.has(n))) || (set === SURFACE && w.length > 5 && w.endsWith('bed'));
const has = (ws, set, suffixable = null) => ws.some((w) => isMember(w, set, suffixable));

export function traits(l) {
  const ws = headWords(l);
  const linear = l.kind === 'linear';
  const solid = !has(ws, NOT_SOLID);
  const surface = !!l.surface || (!linear && has(ws, SURFACE, SUFFIX));
  return {
    surface,
    sittable: surface && ws.some((w) => FAMILIES.slice(0, 4).some((f) => f.has(w) || (w.length > 5 && [...f].some((n) => n.length >= 3 && w.endsWith(n))))),
    wide: surface && ws.some((w) => WIDE.has(w) || (w.length > 5 && [...WIDE].some((n) => n.length >= 3 && w.endsWith(n)))),
    top: linear && solid && has(ws, TOP_NOUN),
    stepway: has(ws, STEPWAY),
    depth: has(ws, DEPTH),
    opening: has(ws, OPENING) || (linear && has(ws, FLEXIBLE)),
  };
}

// ---- furniture and seating derived from the bible's set dressing (or a fixture's location text) ----
const FURN_RE = new RegExp(`((?:[a-z-]+\\s+){0,2})\\b(${[...SURFACE].filter((w) => w !== stem('furniture')).map((n) => n.replace(/f$/, '(?:f|ves)')).join('|')})(?:es|s)?\\b`, 'gi');
const familyOf = (w) => FAMILIES.findIndex((f) => f.has(stem(w)));
const leaves = (v, out = []) => { if (typeof v === 'string') out.push(v); else if (Array.isArray(v)) v.forEach((x) => leaves(x, out)); else if (v && typeof v === 'object') Object.values(v).forEach((x) => leaves(x, out)); return out; };
const DET = /^(?:a|an|the|this|that|his|her|its|their|some)$/;

export function locationTexts(loc) {
  const ref = loc && loc.ref ? { ...loc.ref } : {};
  return [loc && loc.description, loc && loc.appearsAs, ...leaves(ref)].filter(Boolean);
}

// texts: plain strings in priority order; props: [{id, appearsAs}]; existing: the landmarks the location already has; reserved: ids that may not be reused
export function surfaceLandmarks({ texts = [], props = [], existing = [], reserved = new Set(), cap = 3 }) {
  const taken = new Set();
  for (const l of existing) for (const w of headWords(l)) { const f = familyOf(w); if (f >= 0) taken.add(f); }
  const out = [];
  const add = (l, f) => { if (out.length >= cap || taken.has(f)) return; taken.add(f); out.push(l); };
  for (const p of props) {
    const head = [words(String(p.id).replace(/_/g, ' ')), words(String(p.appearsAs || '').split(PROP_CUT)[0])].map((ws) => ws.map(stem).at(-1));
    const w = head.find((x) => x && familyOf(x) >= 0);
    if (w) add({ id: p.id, gloss: String(p.appearsAs || String(p.id).replace(/_/g, ' ')), kind: 'area', walkable: false, surface: true, level: 0, derived: true }, familyOf(w));
  }
  for (const t of texts) {
    for (const m of String(t).matchAll(FURN_RE)) {
      const noun = stem(m[2].toLowerCase());
      const f = familyOf(noun);
      if (f < 0 || taken.has(f)) continue;
      const pre = words(m[1]).filter((w) => !DET.test(w));
      let id = noun.replace(/[^a-z]/g, '');
      if (reserved.has(id)) id = `${id}_surface`;
      if (out.some((x) => x.id === id) || reserved.has(id)) continue;
      add({ id, gloss: [...pre, noun].join(' '), kind: 'area', walkable: false, surface: true, level: 0, derived: true }, f);
    }
  }
  return out;
}

// ---- wearables: a noun class, or the verb relation that puts a thing on a body ----
const WEAR_NOUN = cls(`ring necklace bracelet bangle anklet earring pendant chain brooch locket amulet jewellery jewelry bead
 garment clothing clothes outfit costume uniform robe gown dress skirt trousers pants jeans shorts shirt blouse tunic vest jacket coat cloak cape shawl scarf stole suit sweater hoodie apron tie belt sash
 hat cap helmet turban hood veil crown mask headband shoe boot sandal slipper sock glove mitten glasses spectacles sunglasses goggles watch wristband`);
const BODY = 'ankle|wrist|neck|ear|finger|toe|waist|arm|head|hair|hip|shoulder|throat|leg|foot|feet|hand|cheek|lip|chest';
const AMBIGUOUS = cls('bell band strap chain bead ribbon thread cord string');
const BODY_RE = new RegExp(`\\b(?:${BODY})s?\\b`, 'i');
const ATTACH = 'tied|ties|tying|retied|strapped|straps|fastened|fastens|buckled|pinned|sewn|slung|sheathed|holstered|tucked|draped|hung';
const WORN_REL = new RegExp(`\\b(?:wears?|wearing|wore|dons?|donned|puts? on|putting on|worn (?:by|on|over|under|around|across|at|with))\\b|\\b(?:${ATTACH})\\b[^.;]{0,40}\\b(?:her|his|their|its) (?:${BODY}|pocket|sleeve|belt|waistband|side)s?\\b|\\baround (?:her|his|their|its) (?:${BODY})s?\\b|\\bon (?:her|his|their) (?:wrist|ankle|finger|toe|neck|head|ear|waist)s?\\b`, 'i');

const idWords = (id) => words(String(id).replace(/_/g, ' ')).filter((w) => w.length >= 3).map(stem);
export const wornRelation = (id, text) => {
  const ws = idWords(id);
  if (!ws.length) return false;
  return String(text || '').split(/(?<=[.;!?])\s+|\n+/).some((s) => WORN_REL.test(s) && words(s).map(stem).some((w) => ws.includes(w)));
};

export function isWearable(id, info, text = '') {
  const own = String((info && info.appearsAs) || '');
  const job = String((info && info.job) || '');
  const idText = String(id).replace(/_/g, ' ');
  const head = words(`${idText} ${own.split(HEAD_CUT)[0]}`).map(stem);
  if (has(head, WEAR_NOUN, SUFFIX)) return true;
  if (has(head, AMBIGUOUS) && BODY_RE.test(`${idText} ${own}`)) return true;
  if (words(job).map(stem).some((w) => WEAR_NOUN.has(w) || w === stem('garment')) && !has(head, SURFACE)) return true;
  return (WORN_REL.test(own) || WORN_REL.test(job) || wornRelation(id, text)) && !has(head, SURFACE);
}
