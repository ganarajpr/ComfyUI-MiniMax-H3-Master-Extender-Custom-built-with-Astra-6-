// E4.2: code checks of the reference-image prompts. Every check is countable; none calls a model.
// A check returns issue objects { code, msg }; an empty list means the prompt passes.
import { mentions, shotText, entityWords } from './clip.mjs';
import { ZONES, PLANES } from './refslots.mjs';

export const wordCount = (s) => String(s).split(/\s+/).filter(Boolean).length;
const norm = (s) => String(s).toLowerCase().replace(/\s+/g, ' ').trim();

export const PLATE_WORDS = [400, 550];
export const PLATE_OBJECTS_MIN = 45;
export const PLANE_RANGE = [2, 5];

// evaluative and effect words the skills forbid: filler that names no material, plus glow-type effects (materials reflect, they do not glow)
const EVALUATIVE = /\b(stunning|stunningly|epic|beautiful|beautifully|gorgeous|handsome|pretty|flawless|perfect|breathtaking|majestic|magnificent|masterpiece|award-winning|hyper-?detailed|highly detailed|ultra-?detailed|amazing|incredible|photorealistic|glow|glows|glowing|glowed|radiant|luminous|ethereal|8k)\b/gi;
// words that are empty adjectives on a person and plain physics elsewhere (a cool blue sky)
const PERSON_FILLER = /\b(cool|stylish)\b/gi;
const NEGATIVE = /\b(no|not|without|never|none|nothing|nobody|neither|nor|cannot)\b|n['’]t\b/gi;
// a whole-frame mood of emptiness (the zone is "open", the frame is dense)
const FRAME_MOOD = /\b(empty|barren|deserted|desolate|lifeless)\b|\b(?:and|is|are|was|were|remains|stays|feels|lies)\s+(?:completely\s+|utterly\s+|totally\s+|perfectly\s+)?still\b/gi;
const FIGURES = /\b(person|people|man|men|woman|women|child|children|boy|girl|crowd|human|humans|someone)\b/gi;
// a prop plate may say whose object it is (a man's coat); it must not show or need a person
const PROP_PERSON = /\b(person|people|figure|figures|someone|wearer|crowd)\b|\b(?:held|carried|worn) by\b|\bin (?:a|the|his|her|their) hands?\b/gi;
const BASE_COLOURS = new Set('red blue green brown grey gray black white yellow orange purple pink'.split(' '));
const COLOUR_MODIFIERS = new Set('dark light bright pale deep plain dull soft'.split(' '));

const matches = (re, text) => [...new Set([...String(text).matchAll(re)].map((m) => m[0].toLowerCase()))];
export const evaluativeWords = (t, person = false) => [...matches(EVALUATIVE, t), ...(person ? matches(PERSON_FILLER, t) : [])];
export const negativeWords = (t) => matches(NEGATIVE, t);
export const frameMoodWords = (t) => matches(FRAME_MOOD, t);
export const figureWords = (t) => matches(FIGURES, t);
export const propPersonWords = (t) => matches(PROP_PERSON, t);

// a colour phrase that is only a base colour (optionally with a plain modifier)
export function isBaseColour(phrase) {
  const w = norm(phrase).replace(/[^a-z\s-]/g, '').split(/[\s-]+/).filter(Boolean).filter((x) => !COLOUR_MODIFIERS.has(x));
  return w.length === 1 && BASE_COLOURS.has(w[0]);
}

// the four-panel layout of the measured sheet: four panels side by side, the four views, "head to toe" for every full-body panel, clear gaps, identical lighting, one person and one costume
const PANEL = [/four panels side by side/i, /front view/i, /three-quarter view/i, /back view/i, /close-up/i, /clear gaps between (?:the )?panels/i, /identical lighting in all four panels/i, /the same person in the same costume in every panel/i];
export const panelLayoutMissing = (t) => [...PANEL.filter((re) => !re.test(t)).map((re) => re.source), ...((String(t).match(/head to toe/gi) || []).length >= 3 ? [] : ['head to toe, three times'])];

// ---- named-object count of a plate's slots: distinct phrases in the object slots ----
// Counted: the hero landmark, its parts, every plane object, the scale objects, the surface motifs and the zone-edge objects. Duplicates (same words, any case) count once.
// An item that names more than one object counts each object: every article-led or number-led noun phrase inside the item (a crooked chimney with a clay pot names two).
export function plateObjects(ref) {
  const seen = new Map();
  const add = (s) => { const k = norm(s).replace(/^(the|a|an)\s+/, ''); if (k && !seen.has(k)) seen.set(k, s); };
  if (ref?.landmark) { add(ref.landmark.name); (ref.landmark.parts || []).forEach(add); }
  for (const p of PLANES) (ref?.planes?.[p] || []).forEach(add);
  (ref?.scale || []).forEach(add);
  (ref?.surfaces || []).forEach((s) => add(s.motif));
  (ref?.zoneEdges || []).forEach(add);
  return [...seen.values()];
}

// share of the slot objects named in a written text: a phrase counts when at least half of its words of four letters or more occur in the text
export function objectCoverage(objects, text) {
  const t = new Set(norm(text).match(/[a-z]+/g) || []);
  const hit = objects.filter((o) => { const w = (norm(o).match(/[a-z]{4,}/g) || []); return !w.length || w.filter((x) => t.has(x)).length * 2 >= w.length; });
  return objects.length ? hit.length / objects.length : 1;
}

const issue = (code, msg) => ({ code, msg });

// the text of every clip of the plan, as the entity-candidate rule reads it
const clipText = (c) => [c.beat, ...c.shots.map(shotText), c.end_state?.location || '', c.end_state?.end_action || ''].join(' ');
const headNoun = (s) => { const w = (norm(s).split(/\b(?:with|of|that|which|in|on)\b|,/)[0].match(/[a-z]+/g) || []); return w[w.length - 1] || ''; };

// A prop is named in a text when all its distinctive words (at most three needed) occur in it, the cast's own name words not counted; a word matches a longer or shorter form of itself (button, buttons, buttoned).
const near = (a, b) => a === b || (Math.min(a.length, b.length) >= 5 && (a.startsWith(b) || b.startsWith(a)));
const hasWord = (words, w) => [...words].some((x) => near(x, w));
const wordsOf = (t) => new Set(norm(t).match(/[a-z]{3,}/g) || []);
export function propNamed(text, prop, bible) {
  const castWords = new Set(bible.cast.flatMap((c) => [...entityWords(c)]));
  const w = [...entityWords(prop)].filter((x) => !castWords.has(x));
  const t = wordsOf(text);
  return w.length > 0 && w.filter((x) => hasWord(t, x)).length >= Math.min(3, w.length);
}
// a prop that the character wears: every distinctive word of it, or its head noun, is in the character's wardrobe
export function propWorn(char, prop) {
  const worn = wordsOf((char.wardrobe || []).join(' '));
  const w = [...entityWords(prop)];
  return hasWord(worn, headNoun(prop.name)) || (w.length > 0 && w.every((x) => hasWord(worn, x)));
}

// A carried prop is listed in the character's slots; it must be named in every clip that names the character.
// Any bible prop named in the sheet text and not carried is reported (it would appear in every clip).
export function propIssues(char, bible, plan, text) {
  const out = [];
  const carried = (char.ref.carriedProps || []).filter((s) => String(s).trim());
  const ents = carried.map((s) => bible.props.find((p) => [...entityWords(p)].some((w) => new Set(norm(s).match(/[a-z]{3,}/g) || []).has(w))) || { id: headNoun(s), name: headNoun(s) });
  const clips = plan.clips.filter((c) => mentions(clipText(c), char));
  carried.forEach((s, i) => {
    const missing = clips.filter((c) => !mentions(clipText(c), ents[i])).map((c) => c.clip);
    if (missing.length) out.push(issue('prop_not_in_every_clip', `"${s}" is listed as carried in every clip, but clip ${missing.join(', ')} of the plan does not name it; list only props carried in every clip (usually none)`));
  });
  for (const p of bible.props) {
    if (ents.includes(p)) continue;
    if (propWorn(char, p)) continue;
    if (propNamed(text, p, bible)) out.push(issue('prop_on_sheet', `the sheet names the prop "${p.name}", which is not carried in every clip; whatever a sheet shows appears in every clip`));
  }
  return out;
}

// The plate must hold no cast: no figure word and no cast name (a name word that is also part of the location's own name is the place, not the person).
export function castIssues(loc, bible, text) {
  const own = new Set([...entityWords(loc)]);
  const out = [];
  const fig = figureWords(text);
  if (fig.length) out.push(issue('cast_in_plate', `the plate names people (${fig.join(', ')}); a plate stays empty of every person`));
  for (const c of bible.cast) {
    const hit = [...entityWords(c)].filter((w) => !own.has(w) && new RegExp(`\\b${w}\\b`, 'i').test(text));
    if (hit.length) out.push(issue('cast_in_plate', `the plate names the cast member "${c.name}" (${hit.join(', ')})`));
  }
  return out;
}

export function sharedTextIssues(text, person = false) {
  const out = [];
  const ev = evaluativeWords(text, person); if (ev.length) out.push(issue('evaluative_words', `evaluative or glow words: ${ev.join(', ')}; name materials and describe light physically`));
  const ng = negativeWords(text); if (ng.length) out.push(issue('negatives', `negative words: ${ng.join(', ')}; Qwen ignores negatives, state what IS there`));
  return out;
}

// ---- the three kinds ----
export function checkSheet(char, text, bible, plan) {
  const out = [];
  const miss = panelLayoutMissing(text);
  if (miss.length) out.push(issue('panel_layout', `the four-panel layout sentence is incomplete (${miss.length} part(s) missing)`));
  const r = char.ref;
  const zones = ZONES.filter((z) => !(r.garments || []).some((g) => g.zone === z));
  if (zones.length) out.push(issue('garment_zones', `no garment for: ${zones.join(', ')}`));
  if ((r.signsOfLife || []).filter((s) => String(s).trim()).length < 2) out.push(issue('signs_of_life', 'fewer than two signs of life'));
  const base = (r.garments || []).filter((g) => isBaseColour(g.colour)).map((g) => `${g.zone}: ${g.colour}`);
  if (base.length) out.push(issue('base_colour', `base colours instead of mixed colour names (${base.join('; ')})`));
  if (!String(r.accent?.colour || '').trim() || !String(r.accent?.place || '').trim()) out.push(issue('accent', 'no accent colour or place'));
  out.push(...sharedTextIssues(text, true), ...propIssues(char, bible, plan, text));
  return out;
}

export function wordCountIssue(text) {
  const w = wordCount(text);
  return w < PLATE_WORDS[0] || w > PLATE_WORDS[1] ? issue('word_count', `${w} words; the plate paragraph must be ${PLATE_WORDS[0]} to ${PLATE_WORDS[1]} words${w < PLATE_WORDS[0] ? `: add at least ${PLATE_WORDS[0] - w} words of named objects, materials and motifs to the slots` : `: remove at least ${w - PLATE_WORDS[1]} words by shortening the longest slot phrases (3 to 6 words per item)`}`) : null;
}
const NP = /\b(?:a|an|the|one|two|three|four|five|six|seven|eight|nine|ten|\d+)\s+(?!of\b)[a-z]/gi;
export const namedObjectCount = (ref) => plateObjects(ref).reduce((n, s) => n + Math.max(1, (String(s).match(NP) || []).length), 0);
export function objectCountIssue(ref) {
  const n = namedObjectCount(ref);
  return n < PLATE_OBJECTS_MIN ? issue('object_count', `${n} named objects in the slots; at least ${PLATE_OBJECTS_MIN} are needed (4 or 5 per plane)`) : null;
}

export function checkPlate(loc, text, bible) {
  const out = [];
  const wc = wordCountIssue(text); if (wc) out.push(wc);
  const oc = objectCountIssue(loc.ref); if (oc) out.push(oc);
  const bad = PLANES.filter((p) => (loc.ref.planes?.[p] || []).length < PLANE_RANGE[0] || (loc.ref.planes[p] || []).length > PLANE_RANGE[1]);
  if (bad.length) out.push(issue('plane_counts', `planes outside ${PLANE_RANGE[0]} to ${PLANE_RANGE[1]} objects: ${bad.join(', ')}`));
  if ((loc.ref.landmark?.parts || []).length < 3) out.push(issue('landmark_parts', 'the hero landmark has fewer than three parts'));
  const mood = frameMoodWords(text); if (mood.length) out.push(issue('frame_mood', `whole-frame emptiness words: ${mood.join(', ')}; the action zone is open, everything around it is dense`));
  const low = norm(text);
  for (const l of loc.landmarks || []) {
    const o = (loc.ref.landmarkObjects || []).find((x) => x.id === l.id)?.object;
    if (!o) out.push(issue('landmark_in_plate', `landmark "${l.id}" (${l.gloss}) has no entry in landmarkObjects`));
    else if (!low.includes(norm(o))) out.push(issue('landmark_in_plate', `landmark "${l.id}" (${l.gloss}): its object phrase "${o}" does not appear in the plate`));
  }
  out.push(...sharedTextIssues(text), ...castIssues(loc, bible, text));
  return out;
}

export function checkProp(p, text) {
  const out = [];
  if ((p.ref.parts || []).length < 3) out.push(issue('prop_parts', 'fewer than three parts'));
  const fig = propPersonWords(text); if (fig.length) out.push(issue('person_with_prop', `the prop plate names a person (${fig.join(', ')})`));
  out.push(...sharedTextIssues(text));
  return out;
}

export const checkEntity = (kind, ent, text, bible, plan) => (kind === 'character' ? checkSheet(ent, text, bible, plan) : kind === 'location' ? checkPlate(ent, text, bible) : checkProp(ent, text));

// ---- which entities get a reference image (founder rule 2026-10-07) ----
// A person or a prop appears in at least two clips to get an image; a place gets a plate when it appears in one clip (a place with no detected clip still gets its plate: every place of the film is set somewhere).
export const MIN_CLIPS = { character: 2, object: 2, location: 1 };
const APPEARS_AS_WORDS = 3;

// Clips of the plan an entity appears in. Cues, any one is enough: a distinctive word of its name or id in the clip's beat, shots (subject, action, speaker) or end state (location, action, characters, props);
// the planner's own state ledger lists the clip for the entity; a speaker string of the clip's lines that the bible maps to the entity; at least three distinctive words of its appearsAs phrase in the clip text.
export function appearances(plan, bible) {
  const out = {};
  const ents = [...bible.cast.map((e) => ({ e, kind: 'character' })), ...bible.props.map((e) => ({ e, kind: 'object' })), ...bible.locations.map((e) => ({ e, kind: 'location' }))];
  const stop = new Set('the and with from that this into onto over under their there here have been were was are his her its our out who what which will would could about each other some such only just also very more most less much many one two'.split(' '));
  const words = (t) => new Set((norm(t).match(/[a-z]{4,}/g) || []).filter((w) => !stop.has(w)));
  for (const { e } of ents) out[e.id] = [];
  for (const clip of [...plan.clips].sort((a, b) => a.clip - b.clip)) {
    const text = [clipText(clip), ...(clip.end_state?.characters || []).flatMap((c) => [c.name, c.props, c.position])].join(' ');
    const tw = words(text);
    const ledger = new Set((plan.ledger?.entities || []).filter((x) => (x.clip_ids || []).includes(clip.clip)).map((x) => x.id));
    const speakers = new Set(clip.shots.filter((s) => s.dialogue?.line).map((s) => bible.speakers?.[s.dialogue.speaker]).filter(Boolean));
    for (const { e } of ents) {
      const aw = [...words(e.appearsAs)];
      if (mentions(text, e) || ledger.has(e.id) || speakers.has(e.id) || aw.filter((w) => tw.has(w)).length >= APPEARS_AS_WORDS) out[e.id].push(clip.clip);
    }
  }
  return out;
}
export const needsRef = (kind, clips) => (kind === 'location' ? true : clips.length >= MIN_CLIPS[kind]);
