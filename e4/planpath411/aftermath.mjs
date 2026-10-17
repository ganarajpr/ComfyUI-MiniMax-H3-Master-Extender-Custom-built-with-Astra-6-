// E4.10: the axis must be of the cue's KIND (KIND_WORDS): crying needs an axis whose options show tears, eyes or cheeks, not any axis of the character.
// E4.9: aftermath on people. The planner prompt carries a generic checklist (AFTERMATH_CHECKLIST), and this module is the code check behind it: when the story text uses a
// generic cue of an aftermath (crying, sweating, soaking, tearing, bleeding, smudging, dishevelling, dirtying) next to a character, that character must have a visible_trace axis in
// the plan's ledger; otherwise the planner gets the issue back through its existing retry budget. Generic words only; no story-specific word, and the lexicon is plain
// vocabulary of the effect, with a few words of other languages for crying, sweating, bleeding and wetting. It imports nothing, so state.mjs can use it without a cycle.

export const AFTERMATH_CHECKLIST = 'AFTERMATH CHECKLIST — after EVERY beat, scan each person and each prop for what the beat leaves behind, and declare each one you find as a visible_trace axis (a change in state_changes at the shot where it happens, a trace in every later end_state): tears and red or swollen eyes; sweat; flushed skin; smudged eyeliner, kajal or lipstick; disheveled, loosened or wet hair; garments loosened, wet, torn, stained or removed; wounds, bruises and blood; dirt and mud; and, for a prop, a state such as lit or extinguished, whole or broken, open or shut. A person who cries, sweats, is soaked, is struck, has a garment torn or is undressed in one clip shows that trace in the clips after it, so never leave such a person without a visible_trace axis, and make it an axis of the matching kind (crying: an axis whose options show tears, eyes or cheeks; sweating: sweat or skin; soaked: wet, soaked or damp; torn: torn, ripped or a seam; mud or dust: mud, dust or dirt; blood or a wound; flushed skin; hair).';

const lex = (re) => new RegExp(`^(?:${re})$`);
// category -> single-token cue (lower case, diacritics removed)
export const CUES = {
  tears: lex('cry|cries|cried|crying|weep|weeps|weeping|wept|sob|sobs|sobbed|sobbing|bawl\\w*|wail\\w*|tearful|teary|weinen|weint|weinte|llor\\w+|lagrima\\w*|pleur\\w+|larme\\w*|trane\\w*|piang\\w+|lacrim\\w+|aansu|ansu|ashru|kanneeru|kannir|roya|royi|roye|rone'),
  sweat: lex('sweat|sweats|sweated|sweating|sweaty|perspir\\w*|pasina|sudor|sudar\\w*|sueur|schweiss'),
  blood: lex('blood|bloody|bloodied|bleed|bleeds|bleeding|bled|wounded|wounds|gash|gashed|bruise|bruised|bruises|khoon|lahu|sangre|injured'),
  wet: lex('wet|soaked|drenched|soaking|sodden|damp|dripping|bheega|bheegi|bheeg\\w*|mojado|mouille|nass'),
  smudge: lex('smudged|smeared|smudge|smear|smudges|mascara|lipstick|eyeliner|kajal|makeup'),
  hair: lex('disheveled|dishevelled|tousled|mussed|ruffled|unkempt|rumpled|unpinned|tangled'),
  flush: lex('flushed|blushed|blushing|reddened|swollen|puffy'),
  dirt: lex('mud|muddy|dirt|dirty|soot|sooty|grime|grimy|filthy|dusty|scorched|singed'),
};
// category -> the words an axis (its name or any option) must hold to show that kind of trace (lower case, diacritics removed)
export const KIND_WORDS = {
  tears: lex('tears?|tearful|teary|cry\\w*|wept|weep\\w*|sobb?\\w*|eyes?|eyed|eyelids?|lashes|cheeks?'),
  sweat: lex('sweat\\w*|perspir\\w*|skin|brow|forehead|glistening|beaded'),
  blood: lex('blood\\w*|bleed\\w*|wound\\w*|gash\\w*|cuts?|bruis\\w*|scratch\\w*|grazed?|scars?|bandag\\w*|injur\\w*|welts?'),
  wet: lex('wet|soaked|soaking|drenched|damp|dripping|sodden|saturated|rain\\w*|water\\w*'),
  smudge: lex('smudg\\w*|smear\\w*|mascara|eyeliner|kajal|lipstick|makeup|streak\\w*|stain\\w*'),
  hair: lex('hair\\w*|disheveled|dishevelled|tousled|mussed|ruffled|loose|strands?|unpinned|tangled|unkempt'),
  flush: lex('flush\\w*|blush\\w*|reddened|red|swollen|puffy|skin|cheeks?'),
  dirt: lex('mud\\w*|dirt\\w*|dust\\w*|soot\\w*|grim\\w*|filth\\w*|caked|stain\\w*|scorch\\w*|singed'),
  garment: lex('torn|ripped|rip|seams?|shredd?\\w*|tattered|hem|unbutton\\w*|loosen\\w*|undone|removed|stripped|unfasten\\w*|stain\\w*|bare|open|opened|off'),
};
const HINT = { tears: 'tears, eyes or cheeks', sweat: 'sweat or skin', blood: 'blood, a wound or a bruise', wet: 'wet, soaked or damp', smudge: 'smudged make-up', hair: 'hair', flush: 'flushed or swollen skin', dirt: 'mud, dust or dirt', garment: 'a torn, ripped or loosened garment' };
const axisShows = (axis, category) => [axis.axis, ...(axis.options || [])].some((t) => words(String(t).replace(/_/g, ' ')).some((x) => KIND_WORDS[category].test(x)));

// a cue that counts only next to a garment word in the same sentence
export const GARMENT_CUES = lex('torn|ripped|tore|shredded|unbuttoned|unbuttoning|undid|undone|loosened|removed|removing|stripped|unfastened|discarded|stained');
export const GARMENT_WORDS = new Set('shirt blouse jacket coat sweater cardigan vest tunic shawl scarf dress gown skirt trousers pants jeans shorts apron uniform robe cloak cape hood collar sleeve sleeves cuff hem veil turban garment garments clothes clothing cloth outfit gloves socks shoes boots'.split(' '));
const OFF = /\b(?:took|take|takes|taking|pulled|pulls|slipped|slips|peeled|peels|pushed|tugged)\b[^.!?]{0,24}\boff\b/;
const NEGATORS = new Set('no not never without nor didnt doesnt dont cant couldnt wouldnt wont isnt wasnt hadnt hasnt cannot nobody neither'.split(' '));
const TEARS_NOT_CRYING = new Set('up open apart into at the a an off through out it them her his their its'.split(' '));
const PRONOUNS = new Set('she he her his him hers they their them'.split(' '));
const NOT_A_NAME = new Set('the and old young little small big tall his her their this that of in on at with'.split(' '));

const plain = (s) => String(s || '').normalize('NFD').replace(/\p{M}/gu, '').replace(/ß/g, 'ss').toLowerCase().replace(/['’]/g, '');
const words = (s) => plain(s).match(/\p{L}+/gu) || [];
const nameTokens = (name) => (String(name || '').toLowerCase().match(/\p{L}+/gu) || []).filter((w) => w.length >= 3 && !NOT_A_NAME.has(w));

// The characters of a plan: ledger entities of kind character or creature, and every name an end_state lists, merged by shared name word.
export function planCharacters(plan) {
  const people = [];
  const add = (name, axes) => {
    const toks = nameTokens(name);
    if (!toks.length) return;
    const p = people.find((x) => x.tokens.some((t) => toks.includes(t)));
    if (p) { p.tokens = [...new Set([...p.tokens, ...toks])]; p.axes.push(...axes); p.hasTrace = p.axes.length > 0; return; }
    people.push({ name: String(name).trim(), tokens: toks, axes: [...axes], hasTrace: axes.length > 0 });
  };
  for (const e of plan.ledger?.entities || []) if (['character', 'creature'].includes(e.kind)) add(e.name || String(e.id).replace(/_/g, ' '), (e.axes || []).filter((a) => a.visible_trace === true));
  for (const c of plan.clips || []) for (const ch of c.end_state?.characters || []) add(ch.name, []);
  return people;
}

// Every aftermath cue of the story: { category, word, sentence, share }. `share` is the position of the sentence in the story (0 to 1).
export function aftermathCues(story) {
  const sents = String(story || '').split(/(?<=[.!?…।])\s+|\n+/).map((s) => s.trim()).filter(Boolean);
  const out = [];
  sents.forEach((s, i) => {
    const w = words(s);
    const negated = (k) => w.slice(Math.max(0, k - 3), k).some((x) => NEGATORS.has(x));
    const hit = (category, word, k) => { if (!negated(k)) out.push({ category, word, sentence: i, share: i / sents.length }); };
    w.forEach((x, k) => {
      for (const [category, re] of Object.entries(CUES)) if (re.test(x)) hit(category, x, k);
      if (x === 'tears' && !TEARS_NOT_CRYING.has(w[k + 1])) hit('tears', x, k);
      if (x === 'tear' && ['a', 'one', 'single', 'first', 'lone'].includes(w[k - 1])) hit('tears', x, k);
    });
    if (w.some((x) => GARMENT_WORDS.has(x))) {
      w.forEach((x, k) => { if (GARMENT_CUES.test(x)) hit('garment', x, k); });
      if (OFF.test(plain(s)) && !negated(w.indexOf('off'))) out.push({ category: 'garment', word: 'off', sentence: i, share: i / sents.length });
    }
  });
  return { cues: out, sentences: sents };
}

const EXAMPLE = { tears: 'wet tear trails down both cheeks, eyes red-rimmed', sweat: 'sweat beaded on the forehead and temples', blood: 'a bleeding gash across the left forearm', wet: 'the clothes soaked through and clinging', smudge: 'smudged eyeliner under both eyes', hair: 'disheveled hair, loose strands across the forehead', flush: 'flushed cheeks and a reddened neck', dirt: 'mud caked on both knees', garment: 'the left sleeve torn open at the shoulder' };
const LABEL = { tears: 'crying', sweat: 'sweating', blood: 'a wound or blood', wet: 'soaking', smudge: 'smudged make-up', hair: 'disordered hair', flush: 'flushed or swollen skin', dirt: 'dirt', garment: 'a garment torn, loosened or removed' };

// Plan issues (plain strings for the planner retry): a character the story gives an aftermath cue and who has no visible_trace axis. A cue in the last stretch of the story has no later clip to
// carry into, and a one-clip plan carries nothing, so neither is checked.
export function aftermathMissing(plan, story) {
  if (!story || (plan.clips || []).length < 2) return [];
  const people = planCharacters(plan);
  if (!people.length) return [];
  const { cues, sentences } = aftermathCues(story);
  const nClips = plan.clips.length;
  const namesIn = (i) => people.filter((p) => words(sentences[i]).some((w) => p.tokens.includes(w)));
  const pronounIn = (i) => words(sentences[i]).some((w) => PRONOUNS.has(w));
  const out = [], seen = new Set();
  // one sentence that cues several kinds for the same person (a cry "drenched in sweat") is satisfied by an axis of any of those kinds
  const groups = new Map();
  for (const c of cues) {
    if (c.share >= 1 - 1 / nClips) continue;
    let who = namesIn(c.sentence);
    if (!who.length && pronounIn(c.sentence)) for (let j = c.sentence - 1; j >= 0 && j >= c.sentence - 2 && !who.length; j--) who = namesIn(j);
    if (!who.length && people.length === 1) who = people;
    for (const p of who) { const k = `${p.name}\u0000${c.sentence}`; if (!groups.has(k)) groups.set(k, { p, cues: [] }); groups.get(k).cues.push(c); }
  }
  for (const { p, cues: cs } of groups.values()) {
    if (cs.some((c) => p.axes.some((a) => axisShows(a, c.category)))) continue;
    const c = cs.find((x) => !seen.has(`${p.name}\u0000${x.category}`));
    if (!c) continue;
    seen.add(`${p.name}\u0000${c.category}`);
    out.push({ person: p, cue: c });
  }
  return out;
}

export function aftermathIssues(plan, story) {
  return aftermathMissing(plan, story).map(({ person: p, cue: c }) => `the story shows ${LABEL[c.category]} ("${c.word}") at ${p.name}, but the ledger has no visible_trace axis for ${p.name} that shows it (an axis whose name or options name ${HINT[c.category]}${p.axes.length ? `; the axes it has, ${p.axes.map((a) => a.axis).join(', ')}, do not` : ''}): declare one (an axis with "visible_trace": true on ${p.name}, for example the option "${EXAMPLE[c.category]}"), put the change in state_changes at the shot where it happens, and name the trace in every later end_state.`);
}

// E4.11: what a trace of each kind looks like before and after, for the axis the code adds when the planner left one out (the later value is the checklist's own example).
export const TRACE_TEMPLATE = Object.fromEntries(Object.keys(EXAMPLE).map((k) => [k, { opening: { tears: 'dry cheeks, clear eyes', sweat: 'dry skin', blood: 'unmarked skin', wet: 'dry clothes', smudge: 'clean unsmudged makeup', hair: 'neat hair', flush: 'an even skin tone', dirt: 'clean hands and clothes', garment: 'garments neat and fastened' }[k], later: EXAMPLE[k] }]));
export const traceAxisName = (category) => ({ tears: 'cheeks_and_eyes', sweat: 'skin_sweat', blood: 'wound', wet: 'clothes_wetness', smudge: 'makeup', hair: 'hair', flush: 'skin_flush', dirt: 'dirt', garment: 'garment' }[category]);
