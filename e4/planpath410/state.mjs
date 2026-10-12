// E4.10 adds to this module: the name rule of an option reads the phrase's head noun (nameRedundancy), the carried state strips the opening wording of a traced axis from the base line
// (stripOpeningWording, withCarriedState) and the bible check behind it (bibleBaseWordingIssues, baseContradictions).
// E4.9 adds to this module: the "now with ..." grammar of an option (nowWithIssue), the subject-line strip (trimSubjectLead, carryText), the bible's opening-state check
// (bibleOpeningIssues) and the aftermath check in planStateIssues (aftermath.mjs).
// E4.8: visible state carries into the next clip's subject_definitions (founder rule 2026-10-08, memory/feedback_state_carries_into_subject_definitions.md).
// The planner's ledger declares an axis with "visible_trace": true when a story event leaves a VISIBLE physical trace on a person, an object or a place
// (tears, a wound, a torn garment, a lit lamp). This module (1) checks that every option of such an axis is a visible physical description,
// (2) folds the state in code: the state at the START of clip N is the opening values plus every state change of clips 1..N-1, in order, reconciled with each clip's end_state,
// (3) writes the current non-opening state onto that subject's line, its retention marker and the writer's facts, and (4) checks the prose against it.
// It imports only lib.mjs and hybrid3/lib.mjs, so planner.mjs can use it without a cycle.
import { tokensOf, humanId } from './lib.mjs';
import { sentences } from '../hybrid3/lib.mjs';
import { aftermathIssues } from './aftermath.mjs';

const GENERIC = new Set('the and with from that this into onto over under after before while where when then than they them their there here have has had been were was are his her its our out off who whom will would could should about above each other some such only just also very more most one two not but nor yet now still both all any'.split(' '));
// Words that name a feeling or a mental condition, never something a camera can see. An option holding one of them is a description of the emotion, not of the body.
export const EMOTION_WORDS = new Set(['sad', 'sadness', 'upset', 'happy', 'happiness', 'angry', 'anger', 'afraid', 'scared', 'fear', 'fearful', 'nervous', 'anxious', 'anxiety', 'tense', 'calm', 'relaxed', 'distraught', 'heartbroken', 'devastated', 'grief', 'grieving', 'sorrow', 'sorrowful', 'joy', 'joyful', 'shame', 'ashamed', 'embarrassed', 'guilty', 'guilt', 'excited', 'stressed', 'emotional', 'emotion', 'emotions', 'mood', 'feeling', 'feelings', 'feels', 'felt', 'distressed', 'miserable', 'depressed', 'lonely', 'worried', 'worry', 'frightened', 'terrified', 'panicked', 'panic', 'hurt', 'shaken', 'rattled', 'overwhelmed', 'shocked', 'dejected', 'despair', 'despairing', 'hopeless', 'furious', 'irritated', 'annoyed', 'content', 'peaceful', 'serene', 'condition', 'state']);
const NEGATION = /\b(?:no|not|never|none|nothing|without|nor|neither|cannot|absent|lacking)\b|n't\b/i;

// light stemmer: enough to make "eyes" and "eyed", "tears" and "tear", "trails" and "trail" one word
const stem = (w) => { for (const suf of ['ing', 'ed', 'es', 's']) if (w.length > suf.length + 1 && w.endsWith(suf)) return w.slice(0, -suf.length); return w; };
export const contentStems = (s) => [...new Set(tokensOf(s, 3).filter((w) => !GENERIC.has(w)).map(stem))];
const lc = (t) => { const x = String(t || '').trim().replace(/[.\s]+$/, ''); return x ? x[0].toLowerCase() + x.slice(1) : x; };
const norm = (s) => String(s || '').toLowerCase().replace(/\s+/g, ' ').trim().replace(/[.\s]+$/, '');
const keyOf = (n) => tokensOf(n, 3).join(' ');

// ---- 1. the option check: a visible physical description, never an emotion word, never a negation, never an id; with the entity and axis it must also name what it is on ----
// Nouns of what a camera sees on a person: the body, the clothes and what an event leaves on them. An object or a place is named by its own name or its axis instead.
export const VISIBLE_NOUNS = new Set(`cheek cheeks eye eyes face hair brow forehead lip lips mouth nose jaw chin neck throat shoulder shoulders arm arms forearm elbow hand hands palm palms finger fingers thumb nail nails wrist chest back stomach waist hip hips leg legs thigh knee knees shin ankle foot feet toe toes skin scalp temple ear ears lash lashes
shirt blouse jacket coat raincoat sweater cardigan vest tunic shawl scarf dress gown skirt trousers pants jeans shorts apron uniform robe cloak cape hood collar sleeve sleeves cuff hem pocket belt strap button buttons zip bra sock socks shoe shoes boot boots sandal sandals glove gloves hat cap veil turban helmet mask glasses ring bracelet necklace earring watch bandage bandaged gauze plaster cloth fabric garment clothes clothing outfit
tear tears trail trails sweat blood mud dirt dust soot ash grime water rain wound wounds gash cut cuts scratch scratches graze bruise bruises scar welt blister stain stains smudge smudges streak streaks splatter splash drop drops puddle spill makeup mascara lipstick eyeliner
`.split(/\s+/).filter(Boolean).map((w) => stem(w)));
// ---- E4.9: the option must read as a noun phrase after "now with" ----
const FINITE = new Set('has have had is are was were am does did gets got becomes became seems appears remains'.split(' '));
const DETERMINER = new Set('the a an his her its their my our this that these those'.split(' '));
const PREPOSITION = new Set('on in at across down along over under around beside between through from into onto with of by against along behind beneath above'.split(' '));
const PARTICIPLE_END = /(?:ed|en)$|^(?:lit|wet|dry|open|shut|off|out|on|up|bare|torn|raw|swollen|ablaze|alight|burning|dark|red|damp|loose)$/;
const rawWords = (s) => String(s || '').toLowerCase().match(/[a-zÀ-ɏ]+(?:['’][a-z]+)?/g) || [];
const nameHeads = (entity) => {
  const caps = String(entity.name || '').match(/[A-Z][\p{L}]+/gu) || [], toks = tokensOf(entity.name, 3), idToks = tokensOf(humanId(entity.id), 3);
  return new Set([toks[toks.length - 1], idToks[idToks.length - 1], ...caps.map((c) => c.toLowerCase())].filter((w) => w && !GENERIC.has(w)));
};
// E4.10: a subject whose name is generic or collective (a place, a plural thing, a mass of weather or light) is named by its noun in every natural value ("all electric lights blazing",
// "heavy rain pooling across the yard"), so the name rule does not apply to it.
const COLLECTIVE = new Set('light lights crowd crowds crew flock herd swarm group staff audience family team rain sky weather air water smoke fog mist snow dust ground yard street road field garden clouds cloud wind storm sea river people guests'.split(' '));
const isGenericSubject = (entity) => {
  if (entity.kind === 'environment') return true;
  const heads = [...nameHeads(entity)];
  return heads.some((h) => COLLECTIVE.has(h)) || (entity.kind !== 'character' && heads.some((h) => /[^su]s$/.test(h) && h.length > 3));
};
const CLAUSE_START = new Set('and but or as while when after before because if so then that which who where until she he it they we you there'.split(' '));
const GROUP_END = new Set([...PREPOSITION, 'and', 'but', 'or', 'as', 'while', 'when', 'that', 'which']);
// The head noun of the value's first noun group: the last word before the first preposition, conjunction, comma or "-ing" participle ("rumpled quilt" -> quilt, "all electric lights blazing" -> lights).
function firstHead(option) {
  const t = String(option || '').toLowerCase().match(/[a-zÀ-ɏ]+(?:['’][a-z]+)?|[,;]/g) || [];
  let i = 0;
  while (i < t.length - 1 && DETERMINER.has(t[i])) i += 1;
  let k = i;
  while (k < t.length && !(k > i && (t[k] === ',' || t[k] === ';' || GROUP_END.has(t[k]) || /^[a-z]{4,}ing$/.test(t[k])))) k += 1;
  return { start: t[i], head: (t[k - 1] || '').replace(/['’]s$/, ''), lead: t.slice(0, i + 1).join(' ') };
}
export function nowWithIssue(option, ctx = null) {
  const w = rawWords(option);
  const fin = w.find((x) => FINITE.has(x));
  if (fin) return `contains the verb "${fin}", so it is a sentence, not a phrase; write a noun phrase that reads correctly after "now with" (for example "a fresh oil sheen along the hull")`;
  if (CLAUSE_START.has(w[0])) return `begins with "${w[0]}", so it does not read after "now with"; start with the visible thing (a part, a garment, a mark)`;
  if (ctx && !isGenericSubject(ctx.entity)) {
    const heads = nameHeads(ctx.entity), f = firstHead(option);
    if (heads.has(f.start.replace(/['’]s$/, ''))) return `starts with the subject itself ("${f.lead}"); the subject is already named before "now with", so start with the visible thing (the part, the garment, the mark)`;
    if (heads.has(f.head)) return `is the subject itself ("${f.head}") with a modifier; the subject is already named before "now with", so name the visible part or mark instead (for example "rumpled folds across the surface")`;
  }
  const last = w[w.length - 1];
  if (w.length <= 3 && last && PARTICIPLE_END.test(last) && !w.some((x) => PREPOSITION.has(x))) return `is a bare participle phrase ("${w.join(' ')}"), which does not read after "now with"; write a noun phrase that names the visible thing (for example "a steady flame on the wick")`;
  return null;
}

// "the <subject>'s ..." and "<subject> has ..." in front of an option are removed when the subject line is assembled; nothing else is touched, and an option that would be left with
// fewer than two content words is kept as it is.
export function trimSubjectLead(value, names = []) {
  const v = String(value ?? '').trim(), esc = (x) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const DET = '(?:(?:the|a|an|his|her|its|their)\\s+)?';
  const keep = (r) => (r && contentStems(r).length >= 2 ? r : null);
  for (const n of names.filter(Boolean).map((x) => String(x).trim()).filter(Boolean).sort((a, b) => b.length - a.length)) {
    const r = keep(v.replace(new RegExp(`^${DET}${esc(n)}(?:['’]s\\s+(?:(?:has|have|had|is|are|was|were)\\s+)?|\\s+(?:has|have|had|is|are|was|were)\\s+)`, 'i'), ''));
    if (r && r !== v) return r;
  }
  const own = new Set(names.flatMap((n) => tokensOf(n, 3)).filter((x) => !GENERIC.has(x)).map(stem));
  const m = /^((?:[\w'’-]+\s+){1,4}?)(?:has|have|had|is|are|was|were)\s+(?=\S)/i.exec(v);
  if (m && contentStems(m[1]).some((x) => own.has(x))) { const r = keep(v.slice(m[0].length)); if (r) return r; }
  const p = /^(?:(?:the|a|an|his|her|its|their)\s+)?((?:[\w-]+\s+){0,3}?[\w-]+)['’]s\s+(?=\S)/i.exec(v);
  if (p && contentStems(p[1]).some((x) => own.has(x))) { const r = keep(v.slice(p[0].length)); if (r) return r; }
  return v;
}
// the base line as assemble references (clip.mjs lcFirst) writes it
const lcFirstOf = (t) => { const x = String(t ?? '').trim().replace(/[.\s]+$/, ''); return /^(?:A|An|The) /.test(x) ? x[0].toLowerCase() + x.slice(1) : x; };
export const carryText = (item) => lc(trimSubjectLead(item.value, [item.name, humanId(item.entity || '')]));

export function visibleOptionIssue(option, ctx = null) {
  const s = String(option ?? '').trim();
  if (!s) return 'is empty';
  if (/^[A-Za-z0-9]+(?:_[A-Za-z0-9]+)+$/.test(s)) return 'is an id, not a description of what shows';
  const feelings = tokensOf(s, 2).filter((w) => EMOTION_WORDS.has(w));
  if (feelings.length) return `uses the emotion or condition word "${feelings[0]}"; describe what the body or the object shows instead`;
  if (NEGATION.test(s)) return 'is written as a negation; write what IS there';
  const stems = contentStems(s);
  if (stems.length < 2) return 'names no visible thing together with how it looks (requires a noun and a visible word, for example "wet tear trails down both cheeks")';
  const g = nowWithIssue(s, ctx);
  if (g) return g;
  if (ctx && ['character', 'creature'].includes(ctx.entity.kind)) {
    const own = new Set([...tokensOf(ctx.entity.name, 3), ...tokensOf(humanId(ctx.entity.id), 3), ...tokensOf(humanId(ctx.axis.axis), 3)].filter((w) => !GENERIC.has(w)).map(stem));
    if (!stems.some((w) => own.has(w) || VISIBLE_NOUNS.has(w))) return 'does not say what it is on (name the body part or the garment, for example "the left shin grazed raw")';
  }
  return null;
}

// ---- the ledger: which axes are visible traces ----
export const isTraceAxis = (axis) => axis?.visible_trace === true;
export function traceAxes(plan) {
  const out = [];
  for (const e of plan.ledger?.entities || []) for (const a of e.axes || []) if (isTraceAxis(a)) out.push({ entity: e, axis: a });
  return out;
}
const openingOf = (entity, axis) => entity.initial.find((i) => i.axis === axis.axis)?.value ?? axis.options[0] ?? '';

// ---- entity -> the film's bible entity (a ledger id is the bible id when the bible took it over; otherwise the name decides) ----
const entityWords = (e) => new Set([...tokensOf(e.name, 3), ...tokensOf(humanId(e.id), 3)].filter((w) => !GENERIC.has(w)));
export function bibleTarget(entity, bible) {
  if (!bible) return null;
  const groups = { character: [['cast', 'character'], ['props', 'object']], prop: [['props', 'object'], ['cast', 'character']], creature: [['cast', 'character'], ['props', 'object']], environment: [['locations', 'location'], ['props', 'object']] }[entity.kind] || [['cast', 'character'], ['props', 'object'], ['locations', 'location']];
  const all = groups.flatMap(([k, type]) => (bible[k] || []).map((e) => ({ ...e, type })));
  const byId = all.find((e) => e.id === entity.id);
  if (byId) return { id: byId.id, type: byId.type };
  const byName = all.filter((e) => keyOf(e.name) && keyOf(e.name) === keyOf(entity.name));
  if (byName.length === 1) return { id: byName[0].id, type: byName[0].type };
  const w = entityWords(entity);
  const hits = all.filter((e) => [...entityWords(e)].some((x) => w.has(x)));
  if (hits.length) { const first = hits.filter((e) => e.type === hits[0].type); if (first.length === 1) return { id: first[0].id, type: first[0].type }; }
  return null;
}

// ---- 2. the fold ----
// share of an option's words that the text shows; words every option of the axis shares ("cheeks", "eyes") say nothing about WHICH option holds, so only the option's own words count
const coverage = (option, poolStems, options = []) => {
  const all = contentStems(option), shared = new Set(all.filter((w) => options.length > 1 && options.every((x) => contentStems(x).includes(w))));
  const o = all.filter((w) => !shared.has(w)).length ? all.filter((w) => !shared.has(w)) : all;
  return o.length ? o.filter((w) => poolStems.has(w)).length / o.length : 0;
};

// What the planner's end_state says about this entity at the last frame of a clip: a character's own entry (state, wardrobe, props, position); for anything else the whole end_state.
function endStatePool(entity, es) {
  if (!es) return null;
  if (entity.kind === 'character') {
    const mine = (es.characters || []).find((c) => keyOf(c.name) === keyOf(entity.name) || [...entityWords(entity)].some((w) => tokensOf(c.name, 3).includes(w)));
    return mine ? new Set(contentStems([mine.state, mine.wardrobe, mine.props, mine.position].join(' '))) : null;
  }
  return new Set(contentStems([es.location, es.end_action, ...(es.characters || []).flatMap((c) => [c.state, c.wardrobe, c.props, c.position])].join(' ')));
}

export const COVER_STATED = 0.5, COVER_OTHER = 0.6;

// Per clip: the state at the START of the clip (every trace axis whose value differs from its opening value), and the disagreements between the changes and the end_state.
// RULE (documented): the ledger's own changes build the state; a clip's end_state is the authority on the LAST FRAME. If the end_state names (>= 60% of the words of) another option
// of the axis and does not name the folded value (< 50%), that other option is the state from there on (kind end_state_names_other). If it is silent about the axis, nothing changes:
// a state persists until a later change resets it, with no decay. A change the end_state does not show is reported (kind change_not_in_end_state) and the change stands.
export function foldState(plan, bible = null) {
  const clips = [...plan.clips].sort((a, b) => a.clip - b.clip);
  const trace = traceAxes(plan);
  const running = new Map(trace.map(({ entity, axis }) => [`${entity.id}\u0000${axis.axis}`, openingOf(entity, axis)]));
  const byClip = {}, conflicts = [], changesByClip = {};
  for (const clip of clips) {
    byClip[clip.clip] = trace.map(({ entity, axis }) => {
      const value = running.get(`${entity.id}\u0000${axis.axis}`);
      return norm(value) === norm(openingOf(entity, axis)) ? null : { entity: entity.id, name: entity.name, kind: entity.kind, axis: axis.axis, value, opening: openingOf(entity, axis), options: axis.options, planned: (clip.state_changes || []).some((c) => c.entity === entity.id && c.axis === axis.axis), target: bibleTarget(entity, bible) };
    }).filter(Boolean);
    changesByClip[clip.clip] = [];
    const last = new Map();
    for (const ch of clip.state_changes || []) {
      const t = trace.find((x) => x.entity.id === ch.entity && x.axis.axis === ch.axis);
      if (!t) continue;
      const k = `${ch.entity}\u0000${ch.axis}`;
      changesByClip[clip.clip].push({ entity: ch.entity, name: t.entity.name, kind: t.entity.kind, axis: ch.axis, from: running.get(k), to: ch.to, shot: ch.shot, target: bibleTarget(t.entity, bible) });
      running.set(k, ch.to);
      last.set(k, ch.to);
    }
    for (const { entity, axis } of trace) {
      const k = `${entity.id}\u0000${axis.axis}`;
      const pool = endStatePool(entity, clip.end_state);
      if (!pool) continue;
      const v = running.get(k), cv = coverage(v, pool, axis.options);
      if (last.has(k) && cv < COVER_STATED && norm(v) !== norm(openingOf(entity, axis))) conflicts.push({ clip: clip.clip, entity: entity.id, axis: axis.axis, kind: 'change_not_in_end_state', value: v });
      if (cv >= COVER_STATED) continue;
      const other = axis.options.filter((o) => norm(o) !== norm(v)).map((o) => ({ o, c: coverage(o, pool, axis.options) })).filter((x) => x.c >= COVER_OTHER).sort((a, b) => b.c - a.c)[0];
      if (other) { conflicts.push({ clip: clip.clip, entity: entity.id, axis: axis.axis, kind: 'end_state_names_other', carriedValue: v, endState: other.o }); running.set(k, other.o); }
    }
  }
  return { byClip, conflicts, changesByClip };
}

// The plan-level issues (plain strings, for the planner retry): bad options of a trace axis, and a plan whose state_changes and end_state disagree.
export function planStateIssues(plan, { story = null } = {}) {
  const issues = [];
  for (const { entity, axis } of traceAxes(plan)) {
    // the opening value is the plain look the reference picture shows: it is never written onto a subject line, so only the other options must be descriptions
    for (const o of axis.options.filter((x) => norm(x) !== norm(openingOf(entity, axis)))) { const why = visibleOptionIssue(o, { entity, axis }); if (why) issues.push(`ledger ${entity.id}.${axis.axis} (visible_trace) option "${o}" ${why}.`); }
    if (!axis.options.some((o) => norm(o) === norm(openingOf(entity, axis)))) issues.push(`ledger ${entity.id}.${axis.axis}: the opening value "${openingOf(entity, axis)}" is not one of its options.`);
  }
  for (const c of foldState(plan).conflicts) {
    if (c.kind === 'change_not_in_end_state') issues.push(`clip ${c.clip} end_state does not show ${c.entity}.${c.axis} = "${c.value}", which a state change of this clip sets: write it, in the option's own words, in that character's state, wardrobe or props (or in the location for a place).`);
    else issues.push(`clip ${c.clip} end_state shows ${c.entity}.${c.axis} as "${c.endState}" but the ledger holds "${c.carriedValue}" at that point: make the state changes and the end_state say the same.`);
  }
  issues.push(...aftermathIssues(plan, story));
  return issues;
}


// ---- E4.9: the bible describes every subject in its OPENING state only ----
// Value words of a later state that a base description must not hold: the nouns and adjectives that name a visible aftermath. A base description that has one of them in
// common with a later option (and the opening option does not) already shows the later state in the reference picture and on every subject line.
const TRACE_WORDS = `wet soaked drenched damp soaking tear tears sweat sweaty blood bloody bleeding bleed wound wounded gash bruise bruised mud muddy dirt dirty soot stain stained smudge smudged smear smeared torn ripped shredded lit flame flames burning ablaze alight extinguished broken shattered cracked spilled flooded disheveled dishevelled tousled flushed swollen bandaged bandage scorched singed`.split(/\s+/).map(stem);
const TRACE_STEMS = new Set(TRACE_WORDS);
const STATE_NOUNS = new Set('tear tears trail trails sweat blood mud dirt dust soot ash grime water rain wound wounds gash cut cuts scratch scratches graze bruise bruises scar welt blister stain stains smudge smudges streak streaks splatter splash drop drops puddle spill makeup mascara lipstick eyeliner bandage gauze'.split(' ').map(stem));
const BIBLE_GROUP = { character: ['cast', 'wardrobe', 'appearsAs', 'ref'], object: ['props', 'appearsAs', 'ref'], location: ['locations', 'appearsAs', 'description', 'ref'] };
const leaves = (v, path, out = []) => { if (typeof v === 'string') out.push([path, v]); else if (Array.isArray(v)) v.forEach((x, i) => leaves(x, `${path}[${i}]`, out)); else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) leaves(x, `${path}.${k}`, out); return out; };

// Does `text` show the later `option` of an axis whose opening value is `opening`? Verbatim, or by the option's own distinctive words (those the opening value and the subject's name do not hold).
export function showsLaterState(text, option, opening, entity) {
  const t = norm(text);
  if (t.includes(norm(lc(option)))) return true;
  const own = new Set([...contentStems(opening), ...tokensOf(entity.name, 3).map(stem), ...tokensOf(humanId(entity.id), 3).map(stem)]);
  const distinct = contentStems(option).filter((w) => !own.has(w) && (!VISIBLE_NOUNS.has(w) || STATE_NOUNS.has(w)));
  if (!distinct.length) return false;
  const have = new Set(contentStems(text)), hits = distinct.filter((w) => have.has(w));
  if (hits.some((w) => TRACE_STEMS.has(w))) return true;
  return hits.length >= 2 && hits.length >= Math.ceil(distinct.length / 2);
}

// Plain strings for the bible's retry: a base description (appearsAs, description, wardrobe, the reference slots) of a subject with a visible_trace axis that already shows a later state.
export function bibleOpeningIssues(bible, plan) {
  const out = [];
  if (!bible || typeof bible !== 'object') return out;
  for (const { entity, axis } of traceAxes(plan)) {
    const t = bibleTarget(entity, bible), spec = t && BIBLE_GROUP[t.type];
    if (!spec) continue;
    const list = Array.isArray(bible[spec[0]]) ? bible[spec[0]] : [], idx = list.findIndex((e) => e?.id === t.id);
    if (idx < 0) continue;
    const opening = openingOf(entity, axis), later = axis.options.filter((o) => norm(o) !== norm(opening));
    const texts = spec.slice(1).flatMap((k) => (list[idx][k] === undefined ? [] : leaves(list[idx][k], `${spec[0]}[${idx}].${k}`)));
    for (const [path, text] of texts) {
      const hit = later.find((o) => showsLaterState(text, o, opening, entity));
      if (hit) out.push(`OPENING STATE: ${path} "${text}" already shows a later state of ${entity.id}.${axis.axis} ("${hit}"). The bible describes every subject in its OPENING state only ("${opening}"); rewrite this without any word of that later state.`);
    }
  }
  return out;
}
export const isOpeningIssue = (s) => /^OPENING STATE:/.test(s);

// E4.10: the base line (appearsAs) of a subject whose axis is carried later must not name what that axis changes: its opening value, or the part the axis is about. The film strips such wording
// when it writes a subject line that carries a later value (withCarriedState); this finding sends the bible back so the line does not rely on the strip.
export function bibleBaseWordingIssues(bible, plan) {
  const out = [];
  if (!bible || typeof bible !== 'object') return out;
  for (const { entity, axis } of traceAxes(plan)) {
    const t = bibleTarget(entity, bible), spec = t && BIBLE_GROUP[t.type];
    if (!spec) continue;
    const list = Array.isArray(bible[spec[0]]) ? bible[spec[0]] : [], idx = list.findIndex((e) => e?.id === t.id);
    const text = idx >= 0 ? list[idx].appearsAs : null;
    if (typeof text !== 'string' || !text.trim()) continue;
    const r = stripOpeningWording(lcFirstOf(text), [{ entity: entity.id, name: entity.name, options: axis.options, opening: openingOf(entity, axis) }]);
    const names = [...r.removed.map((x) => x.unit), ...r.reworded.map((x) => x.from)];
    if (names.length) out.push(`BASE WORDING: ${spec[0]}[${idx}].appearsAs "${text}" names ${names.map((x) => `"${x}"`).join(', ')}, which ${entity.id}.${axis.axis} changes later in the film. The film adds the current state of that part to the subject line itself, so leave it out of appearsAs entirely (no opening value, no word for that part), and keep the rest.`);
  }
  return out;
}
export const isBaseWordingIssue = (s) => /^BASE WORDING:/.test(s);

// The block the bible prompt gets when the plan has visible traces (nothing is added for a plan without them, so its request is unchanged).
export function openingStateBlock(plan) {
  const items = traceAxes(plan).map(({ entity, axis }) => {
    const opening = openingOf(entity, axis), shared = axisWording({ entity: entity.id, name: entity.name, options: axis.options, opening }).parts;
    const leaveOut = [...new Set(axis.options.flatMap((o) => String(o).toLowerCase().match(/[\p{L}]+/gu) || []).filter((w) => shared.includes(rootOf(w))))];
    return { id: entity.id, axis: axis.axis, opening, later: axis.options.filter((o) => norm(o) !== norm(opening)), leave_out: leaveOut };
  });
  if (!items.length) return '';
  return `OPENING STATE ONLY. These subjects show a visible aftermath LATER in the film (the "later" values below). In every field of the bible describe each of them exactly as it looks in its "opening" state, and use no word of any "later" value: a candle that is lit only later is described unlit, a face that is tear-stained only later is described dry, a garment that is torn only later is described whole. In "appearsAs", which is the base line the film writes for the subject, go one step further: do not write a phrase about the parts named in "leave_out" and do not state the opening value there at all. The film adds the subject's current state to that line itself, so naming the part in appearsAs would put the opening state and the later state in one line (describe the subject by what stays the same: its build, its clothes, its material, its colour).\n${JSON.stringify(items)}\n\n`;
}

// ---- E4.10: the base line never holds the opening wording of an axis whose later value is carried ----
// A base description is read as units split at commas, "and" and "with". The first unit (the subject's own noun phrase) is never removed. For one carried axis a later unit is dropped when it
// is the opening value (or a part of it), or when it names a part of the axis (a word every option of the axis shares: cheeks, eyes, hair, seam) in four content words or fewer; a unit that
// only holds a word of the opening value that no later option has ("dry", "unlit", "whole") loses that word. Everything else in the line is kept.
const UNIT_SPLIT = /(,\s+and\s+|,\s+|\s+and\s+|\s+with\s+)/i;
const isWith = (d) => /^\s+with\s+$/i.test(d);
// the parts rule reaches only what a camera sees on a body or a garment (VISIBLE_NOUNS); a prop's own part word ("glass", "wick") is not stripped for being a part
const VISIBLE_ROOTS = new Set([...VISIBLE_NOUNS].map((x) => x.replace(/e$/, '')));
const rstems = (s) => [...new Set(contentStems(s).map((x) => x.replace(/e$/, '')))];
const rootOf = (t) => stem(String(t).toLowerCase().replace(/[^\p{L}'-]/gu, '')).replace(/e$/, '');
function axisWording(item) {
  const options = item.options || [], opening = item.opening ?? options[0] ?? '';
  const later = options.filter((o) => norm(o) !== norm(opening)), laterStems = new Set(later.flatMap(rstems));
  const own = new Set([...tokensOf(item.name, 3), ...tokensOf(humanId(item.entity || ''), 3)].map(rootOf));
  const open = rstems(opening);
  return {
    opening: norm(opening),
    distinct: open.filter((w) => !laterStems.has(w) && !own.has(w)),
    parts: options.length > 1 ? open.filter((w) => !own.has(w) && options.every((o) => rstems(o).includes(w))) : [],
  };
}
function unitAction(unit, head, wordings) {
  const n = norm(unit), have = new Set(rstems(unit));
  if (!have.size) return { keep: true };
  let text = unit, reworded = false;
  for (const a of wordings) {
    if (!head && a.opening && n.length >= 4 && (a.opening.includes(n) || n.includes(a.opening))) return { keep: false, why: `the opening value of the axis ("${a.opening}")` };
  }
  for (const a of wordings) {
    const named = a.parts.filter((w) => have.has(w) && VISIBLE_ROOTS.has(w));
    if (!head && named.length && have.size <= 4) return { keep: false, why: `a part of the axis ("${named.join('", "')}")` };
  }
  for (const a of wordings) {
    if (!a.distinct.length) continue;
    const hit = a.distinct.filter((w) => rstems(text).includes(w));
    if (hit.length < Math.min(2, a.distinct.length)) continue;
    const next = text.split(/(\s+)/).filter((t) => !hit.includes(rootOf(t))).join('').replace(/\s{2,}/g, ' ').trim();
    if (rstems(next).length >= (head ? 1 : 2)) { text = next; reworded = true; } else if (!head) return { keep: false, why: `the opening value of the axis ("${a.opening}")` };
  }
  return reworded ? { keep: true, text, reworded: unit } : { keep: true };
}
export function stripOpeningWording(description, items) {
  const text = String(description ?? ''), wordings = (items || []).map(axisWording);
  if (!text || !wordings.length) return { text, removed: [], reworded: [] };
  const parts = text.split(UNIT_SPLIT), units = parts.filter((_, i) => i % 2 === 0), delims = parts.filter((_, i) => i % 2 === 1);
  const removed = [], reworded = [], acts = units.map((u, i) => { const a = unitAction(u, i === 0, wordings); if (!a.keep) removed.push({ unit: u, why: a.why }); else if (a.reworded) reworded.push({ from: u, to: a.text }); return a; });
  if (!removed.length && !reworded.length) return { text, removed, reworded };
  let out = acts[0].text ?? units[0], pending = null;
  for (let i = 1; i < units.length; i++) {
    if (!acts[i].keep) { if (isWith(delims[i - 1]) && !pending) pending = delims[i - 1]; continue; }
    out += (pending || delims[i - 1]) + (acts[i].text ?? units[i]);
    pending = null;
  }
  return { text: out, removed, reworded };
}
// the description of a subject paragraph: what stands after "is <name>," up to the carried clause
const baseOf = (para) => { const m = /^<Subject \d+> is [^,]*?, (.*)$/s.exec(String(para)); return m ? m[1].split(/, now with /)[0].replace(/;.*$/s, '') : null; };

// Check of one clip: a carried subject whose base description still holds the opening wording of a carried axis. { subject, id, axis, units }
export function baseContradictions({ carried, references, subjectDefinitions }) {
  const { lines } = attachState(carried, references), paras = String(subjectDefinitions).split('\n\n'), out = [];
  lines.forEach((items, i) => {
    if (!items.length) return;
    const base = baseOf(paras[i]);
    if (!base) return;
    const r = stripOpeningWording(base, items);
    for (const x of r.removed) out.push({ subject: i + 1, id: references[i].id, axes: items.map((it) => `${it.entity}.${it.axis}`), unit: x.unit, why: x.why });
    for (const x of r.reworded) out.push({ subject: i + 1, id: references[i].id, axes: items.map((it) => `${it.entity}.${it.axis}`), unit: x.from, why: 'a word of the opening value' });
  });
  return out;
}

// ---- 3. the subject line, the retention marker ----
export const REF_PIC = 'its reference picture';
const UNCHANGED = { character: 'face shape, build and hair', object: 'material, scale and form', location: 'layout and surfaces', described: 'face shape, build and clothes' };

export function stateClause(values) {
  const v = values.map(lc).filter(Boolean);
  if (!v.length) return '';
  return `now with ${v[0]}${v.slice(1).map((x) => `, and with ${x}`).join('')}`;
}

// The carried state of one clip's references. `carried` is foldState().byClip[clip]. An item attaches to the subject of its bible target; an unmatched environment item attaches to the
// clip's first location; an item whose subject is not in this clip stays in the ledger (it appears when the subject does).
export function attachState(carried, references) {
  const lines = references.map(() => []);
  const unattached = [];
  for (const it of carried) {
    let i = it.target ? references.findIndex((r) => r.id === it.target.id) : -1;
    if (i < 0 && !it.target && it.kind === 'environment') i = references.findIndex((r) => r.type === 'location');
    if (i >= 0) lines[i].push(it); else unattached.push(it);
  }
  return { lines, unattached };
}

// refPack = clip.mjs assembleReferences(); returns it unchanged when no subject of the clip carries a state (so every other request stays byte-identical).
export function withCarriedState(refPack, carried, changes = []) {
  const { lines, unattached } = attachState(carried, refPack.references);
  const subjects = refPack.references.map((r, i) => ({ subject: i + 1, id: r.id, type: r.type, values: lines[i].map(carryText), items: lines[i] })).filter((s) => s.values.length);
  const mine = changes.filter((c) => (c.target ? refPack.references.some((r) => r.id === c.target.id) : c.kind === 'environment' && refPack.references.some((r) => r.type === 'location')));
  if (!subjects.length && !mine.length) return refPack;
  if (!subjects.length) return { ...refPack, state: { carried: [], items: carried, unattached, changes: mine } };
  const paras = String(refPack.subjectDefinitions).split('\n\n'), ret = String(refPack.retentionAnalysis).split('\n');
  for (const s of subjects) {
    const r = refPack.references[s.subject - 1], clause = stateClause(s.values);
    const tail = `; ${r.job}.`;
    const lead = lcFirstOf(r.appearsAs), cut = stripOpeningWording(lead, s.items);
    if (cut.text !== lead && paras[s.subject - 1].includes(lead)) paras[s.subject - 1] = paras[s.subject - 1].replace(lead, () => cut.text);
    paras[s.subject - 1] = paras[s.subject - 1].endsWith(tail) ? `${paras[s.subject - 1].slice(0, -tail.length)}, ${clause}${tail}` : `${paras[s.subject - 1].replace(/[.\s]+$/, '')}, ${clause}.`;
    const kind = r.noPicture ? 'described' : r.type;
    ret[s.subject - 1] = `<Subject ${s.subject}>: partially_preserved - identity and ${UNCHANGED[kind] || UNCHANGED.object} from ${r.noPicture ? 'its description above' : REF_PIC}; ${s.values.map(lc).join('; ')} from the previous clip`;
  }
  return { ...refPack, subjectDefinitions: paras.join('\n\n'), retentionAnalysis: ret.join('\n'), state: { carried: subjects.map((s) => ({ subject: s.subject, id: s.id, values: s.values, axes: s.items.map((x) => `${x.entity}.${x.axis}`) })), items: carried, unattached, changes: mine } };
}

// export time: the retention line cites the subject's own picture (ref_guide 2: a label keeps its meaning in every section)
export function citeRetention(retentionAnalysis, references, pictures) {
  const lines = String(retentionAnalysis).split('\n');
  return lines.map((l, i) => { const p = pictures.find((x) => x.subject === i + 1); return p ? l.replace(`from ${REF_PIC};`, `from <Picture ${p.picture}>;`) : l; }).join('\n');
}

// ---- 6. the writer's facts ----
export function stateFacts({ shot, rec }) {
  const st = rec?.refPack?.state;
  if (!st) return [];
  const tok = (id, name) => { const i = shot.references.findIndex((r) => r.id === id); return i === -1 ? name : `<Subject ${i + 1}>`; };
  const out = [];
  for (const c of st.carried) out.push(`- ${tok(c.id)} arrives in this clip already showing ${c.values.map(lc).join('; and ')}. It is true at the first frame and in every cut of this clip until a change listed below replaces it: write it as what is visible whenever ${tok(c.id)} is seen in positive words that name the state, never as something recalled from an earlier event.`);
  for (const ch of st.changes) out.push(`- Changes in this clip at [Shot ${ch.shot}]: ${tok(ch.target?.id, ch.name)} goes from "${carryText({ value: ch.from, name: ch.name, entity: ch.entity })}" to "${carryText({ value: ch.to, name: ch.name, entity: ch.entity })}". Write the change as a visible event inside [Shot ${ch.shot}]'s own sentences, then show the new state in every later cut of this clip where ${tok(ch.target?.id, ch.name)} is seen.`);
  return out.length ? ['- VISIBLE STATE (the subject definitions already carry the state that holds at the first frame):', ...out] : [];
}

// ---- 5. the checks ----
// every carried visible state appears in that clip's subject line (verbatim, lower-cased first letter)
export function carriedInSubjectLines({ carried, references, subjectDefinitions }) {
  const { lines, unattached } = attachState(carried, references);
  const paras = String(subjectDefinitions).split('\n\n');
  const out = [];
  lines.forEach((items, i) => { for (const it of items) out.push({ subject: i + 1, id: references[i].id, axis: `${it.entity}.${it.axis}`, value: it.value, ok: norm(paras[i]).includes(norm(carryText(it))) }); });
  for (const it of unattached) out.push({ subject: null, id: it.target?.id || it.entity, axis: `${it.entity}.${it.axis}`, value: it.value, ok: true, absent: true });
  return out;
}

// prose against the carried state: a sentence about the subject that states another option of the axis (its distinctive words, plus a word the options share) while the clip plans no change on that axis.
// `items` are foldState().byClip[clip] (they carry the axis options and whether a change of the axis is planned in this clip).
export function stateContradictions({ items, references, prose }) {
  const out = [];
  const fields = [['summary', sentences(prose.summary)], ['detailedDescription', sentences(prose.detailedDescription)]];
  for (const it of items) {
    if (it.planned) continue;
    const refIdx = it.target ? references.findIndex((r) => r.id === it.target.id) : -1;
    const own = new Set(contentStems(it.value)), who = [...entityWords({ id: it.entity, name: it.name })].map(stem);
    for (const o of it.options.filter((x) => norm(x) !== norm(it.value))) {
      const os = contentStems(o), distinct = os.filter((w) => !own.has(w)), anchors = os.filter((w) => own.has(w));
      if (!distinct.length) continue;
      for (const [field, arr] of fields) arr.forEach((s, idx) => {
        const st = new Set(contentStems(s));
        const aboutIt = (refIdx >= 0 && s.includes(`<Subject ${refIdx + 1}>`)) || who.some((w) => st.has(w));
        if (!aboutIt) return;
        // a sentence that also states the carried value affirms it (the words of the other option are then a different thing in the same sentence)
        const mine = contentStems(it.value).filter((w) => !os.includes(w)), affirms = (mine.length ? mine : contentStems(it.value)).filter((w) => st.has(w)).length;
        if (affirms >= Math.ceil((mine.length || 1) / 2)) return;
        const hitD = distinct.filter((w) => st.has(w)).length, hitA = anchors.filter((w) => st.has(w)).length;
        if (hitD >= Math.ceil(distinct.length / 2) && (!anchors.length || hitA >= 1) && hitD + hitA >= 2) out.push({ src: 'lint', code: 'state_contradiction', field, idx, match: o, message: `the subject carries "${it.value}" into this clip (no change of it is planned here), and this sentence says "${o}"` });
      });
    }
  }
  return out;
}

// the carried state of the clip named in the prose at all (reported, never repaired): share of carried items whose words show up in the clip's prose
export function stateMentioned({ carried, prose }) {
  const st = new Set(contentStems(`${prose.summary || ''} ${prose.detailedDescription || ''}`));
  return carried.map((it) => ({ axis: `${it.entity}.${it.axis}`, value: it.value, coverage: coverage(it.value, st) }));
}

// The report of one film: per clip what is carried, whether each carried state is in the subject line, whether the written prose contradicts it, and whether the prose shows it.
export function stateReport({ fold, shots, fix, proseByClip }) {
  const lines = shots.map((shot, i) => {
    const items = shot.state?.items || [];
    const ref = fix.refs.shots.find((s) => s.id === shot.id);
    const prose = proseByClip[shot.clipNumber];
    return {
      clip: shot.clipNumber, carried: fold.byClip[shot.clipNumber]?.map((x) => ({ entity: x.entity, axis: x.axis, value: x.value })) || [],
      changesHere: (fold.changesByClip[shot.clipNumber] || []).map((c) => ({ entity: c.entity, axis: c.axis, from: c.from, to: c.to, shot: c.shot })),
      inSubjectLine: carriedInSubjectLines({ carried: fold.byClip[shot.clipNumber] || [], references: shot.references, subjectDefinitions: ref.subjectDefinitions }),
      baseContradictions: baseContradictions({ carried: fold.byClip[shot.clipNumber] || [], references: shot.references, subjectDefinitions: ref.subjectDefinitions }),
      contradictions: prose ? stateContradictions({ items, references: shot.references, prose }).map((f) => ({ field: f.field, idx: f.idx, match: f.match })) : null,
      shownInProse: prose ? stateMentioned({ carried: items, prose }) : null,
      retention: ref.retentionAnalysis.split('\n').filter((l) => /partially_preserved/.test(l)),
      index: i,
    };
  });
  const carriedLines = lines.flatMap((r) => r.inSubjectLine.filter((x) => !x.absent));
  return { clipsWithCarriedState: lines.filter((r) => r.carried.length).length, carriedItems: carriedLines.length, inSubjectLine: `${carriedLines.filter((x) => x.ok).length}/${carriedLines.length}`, proseContradictions: lines.reduce((a, r) => a + (r.contradictions?.length || 0), 0), baseContradictions: lines.reduce((a, r) => a + r.baseContradictions.length, 0), conflicts: fold.conflicts, lines };
}
