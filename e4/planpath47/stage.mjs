// E4.3 staging: continuity is STRUCTURAL.
//   - The state of every person and prop is carried by CODE (the ledger at the clip's opening, then cut by cut). A cut opens in the state the previous cut left;
//     the decision never re-decides it. Every position and holder question offers "stays" as the first option, and the question text says "name another place only
//     when the planned cut jumps there". What the decision answers is what CHANGES in a cut (a move, a hand-off, a jump).
//   - Only valid targets are offered: every option is built by code from this film's own entity ids and landmarks, and the reply is constrained to those options
//     by a JSON-schema enum (decide.mjs), so an answer outside the set cannot occur.
// E4.5 (draft) option-builder fixes over E4.4, from the gold2 expressibility flags (classes in stage-classes.mjs, never story strings):
//   - faces / moves / points_at targets include every cast member and prop of the clip or scene, not only those the cut names;
//   - zone: furniture and seating surfaces (derived from the set dressing), "on" a linear landmark whose class has a top, "with its wearer" for a worn prop;
//   - moves: descends / ascends, dances or sways in place, circles X, lies down / sits down / rises, exits / enters through X;
//   - held: a prop shared or worn by two characters (start and end semantics unchanged); wearables detected by noun class and the verb relation;
//   - faces: up, down, the way ahead, down into X (a pit, shaft, well, stair well or water body below), along X; camera: a two-subject side (side-on to both A and B).
// Option fixes over staging/options.mjs (learned from the staging test's gold labels, 2026-10-07):
//   - a wall or any linear landmark offers only its sides, never "near" (the two overlap and both are true);
//   - "turns in place", "moves along L", "lifted or carried by X";
//   - a prop has a start holder (carried) and an end holder: held by X, worn by X, lifted by X, passed to X, put down, held by nobody;
//   - the camera side may be side-on, with no left or right fixed.
import { DIRECTIONAL_PROP_RE } from '../staging/vocab.mjs';
import { humanId } from './lib.mjs';
import { traits, isWearable as classWearable } from './stage-classes.mjs';

export const UNSTATED = 'unstated';
export const STAYS = 'stays';
export const WEARER = 'with its wearer';
export const HEIGHTS = ['below eye', 'eye', 'above eye', 'overhead'];
export const WEARABLE_RE = /\b(?:hat|cap|coat|jacket|scarf|shawl|glasses|spectacles|ring|necklace|watch|mask|helmet|gloves?|boots?|shoes?|apron|veil|cloak|belt|bracelet|earrings?|crown|tie|vest|robe|dress|shirt|sweater|badge|pendant)\b/i;

const lv = (n) => (n > 0 ? `+${n}` : String(n));
const stripLevel = (s) => String(s).replace(/\s*\(level [+-]?\d+\)/, '');
export const isWearable = (id, info, text = '') => classWearable(id, info, text) || WEARABLE_RE.test(`${String(id).replace(/_/g, ' ')} ${(info && info.appearsAs) || ''}`);
export const isDirectional = (id, info) => DIRECTIONAL_PROP_RE.test(`${String(id).replace(/_/g, ' ')} ${(info && info.appearsAs) || ''}`);
const o = (key, gloss) => ({ key, gloss });

export function zoneOptions(landmarks, who, { wearable = false } = {}) {
  const out = [];
  for (const l of landmarks) {
    if (l.id === who) continue;
    const t = traits(l);
    if (l.walkable || t.surface || t.top) out.push(o(`on ${l.id} (level ${lv(l.level)})`, `${who} is on the ${humanId(l.id)}`));
    if (l.kind !== 'linear') out.push(o(`near ${l.id} (level ${lv(l.level)})`, `${who} is near the ${humanId(l.id)}`));
    else for (const raw of l.sides) { const s = String(raw).replace(/\s+side$/i, ''); out.push(o(`${s} side of ${l.id} (level ${lv(l.level)})`, `${who} is on the ${s} side of the ${humanId(l.id)}`)); }
    if (t.wide) for (const s of ['left', 'right']) out.push(o(`${s} side of ${l.id} (level ${lv(l.level)})`, `${who} is on the ${s} half of the ${humanId(l.id)}`));
  }
  if (wearable) out.push(o(WEARER, `${who} is on its wearer's body, wherever the wearer is`));
  out.push(o('open floor (level 0)', `${who} is on open floor away from any landmark`));
  return out;
}

// The zone key a "toward L" move ends in; a linear landmark has no single end place (which side is not known), so it leaves the zone as it is.
export function arrivalZone(l) {
  if (!l || l.kind === 'linear') return null;
  return `${l.walkable ? 'on' : 'near'} ${l.id} (level ${lv(l.level)})`;
}
export const arrivalOn = (l) => (l ? `on ${l.id} (level ${lv(l.level)})` : null);

// Builds the staging questions of ONE cut. `carried` = the state this cut opens in ({zone, holder, worn}, from the ledger) for the first cut of a clip, else null;
// `established` = the entity ids whose state is already known when this cut opens (so "stays" is a meaningful answer).
// `sceneChars` / `sceneProps` = the cast and props of the clip or scene that this cut does not ask about: they are still valid targets to face, move toward or point at. `text` = the cut's own planned text (wearing is read from it).
export function stageQuestions({ prefix = '', cut = 1, chars, props, propInfo = {}, landmarks, carried = null, established = new Set(), cameraAngle = '', withCamera = false, sceneChars = [], sceneProps = [], text = '' }) {
  const qs = [];
  const zkeys = new Set(zoneOptions(landmarks, 'x', { wearable: true }).map((x) => x.key));
  const knownZone = (id) => (carried ? !!carried.zone[id] && zkeys.has(carried.zone[id]) : false) || established.has(id);
  const knownHolder = (id) => (carried ? carried.holder[id] !== undefined : false) || established.has(id);
  const add = (id, type, subject, text, options) => qs.push({ id: `${prefix}${id}`, kind: 'stage', cut, type, subject, text, options });
  const lmOf = Object.fromEntries(landmarks.map((l) => [l.id, l]));
  const others = [...new Set([...chars, ...sceneChars])];
  const things = [...new Set([...props, ...sceneProps])];
  const targets = (self) => [...new Set([...others, ...things, ...landmarks.map((l) => l.id)])].filter((x) => x !== self);
  const moveTargets = (self) => [...new Set([...others, ...props, ...landmarks.map((l) => l.id)])].filter((x) => x !== self);
  const first = !carried ? 'the previous cut' : 'the previous clip';
  const wears = Object.fromEntries(props.map((p) => [p, isWearable(p, propInfo[p], text)]));
  const pairs = chars.flatMap((a, i) => chars.slice(i + 1).map((b) => [a, b]));
  const sharedOpts = (p) => [
    ...pairs.map(([a, b]) => o(`shared between ${a} and ${b}`, `${a} and ${b} both hold ${p} (carried between them, a cloth over both)`)),
    ...(wears[p] ? pairs.map(([a, b]) => o(`worn by both ${a} and ${b}`, `${a} and ${b} both wear ${p}`)) : []),
  ];

  for (const id of [...chars, ...props]) {
    const known = knownZone(id);
    const opts = zoneOptions(landmarks, id, { wearable: !!wears[id] });
    const where = carried && carried.zone[id] && zkeys.has(carried.zone[id]) ? stripLevel(carried.zone[id]) : null;
    add(`${id}.zone`, 'zone', id,
      `Where is ${id} when this cut opens? ${known ? `"${STAYS}" keeps ${id} exactly where it stands now${where ? ` (${where})` : ` (where ${first} left it)`}; name another place only when the planned cut itself puts ${id} there.` : `${id} has no established position yet: pick where the plan puts it.`}`,
      [...(known ? [o(STAYS, `unchanged${where ? `: ${where}` : ''}`)] : []), ...opts, o(UNSTATED, 'the plan does not say')]);
  }

  for (const c of chars) {
    const ts = targets(c), ms = moveTargets(c);
    add(`${c}.faces`, 'faces', c, `What is ${c} facing or looking toward in this cut?`, [
      o('camera', `${c} faces the camera`), o('away from camera', `${c} faces away from the camera`),
      ...ts.map((t) => o(t, `${c} looks at ${t} itself`)),
      o('the way ahead', `${c} faces straight ahead, along the way ${c} is travelling or heading, with no named thing in view`), o('up', `${c} looks up at the ceiling, the sky or a place above, not at a named thing`), o('down', `${c} looks down at the floor, the ground or ${c}'s own hands, not at a named thing`),
      ...ts.flatMap((t) => {
        const l = lmOf[t], tr = l ? traits(l) : null;
        if (!tr) return [];
        return [
          ...(tr.depth ? [o(`down into ${t}`, `${c} looks down into the depth or interior of the ${humanId(t)} below, not at the ${humanId(t)} itself`)] : []),
          ...(l.kind === 'linear' ? [o(`along ${t}`, `${c} looks along the length of the ${humanId(t)}`)] : []),
        ];
      }),
      o(UNSTATED, 'the plan does not say'),
    ]);
    add(`${c}.moves`, 'moves', c, `How does ${c} move during this cut? This is where a change of place is answered.`, [
      o('still', `${c} stays still`), o('turns in place', `${c} turns on the spot without changing place`),
      o('lies down in place', `${c} settles or lies down where ${c} is`), o('sits down in place', `${c} sits down where ${c} is`), o('rises or sits up in place', `${c} stands up or sits up where ${c} is`),
      o('dances or sways in place', `${c} dances or sways on the spot`),
      ...ms.flatMap((t) => {
        const l = lmOf[t], tr = l ? traits(l) : null;
        return [
          o(`toward ${t}`, `${c} moves toward ${t}`), o(`away from ${t}`, `${c} moves away from ${t}`),
          ...(l && l.kind !== 'point' ? [o(`along ${t}`, `${c} moves along the length of ${t}`)] : []),
          ...(!l ? [o(`circles ${t}`, `${c} walks a circle around ${t}`)] : []),
          ...(tr && tr.stepway ? [o(`descends ${t}`, `${c} goes down ${t}`), o(`ascends ${t}`, `${c} goes up ${t}`)] : []),
          ...(tr && tr.opening ? [o(`exits through ${t}`, `${c} leaves through ${t}`), o(`enters through ${t}`, `${c} comes in through ${t}`)] : []),
          ...(tr && tr.sittable ? [o(`sits down on ${t}`, `${c} sits down on ${t}`), o(`lies down on ${t}`, `${c} lies down on ${t}`)] : []),
        ];
      }),
      o('toward camera', `${c} moves toward the camera`), o('away from camera', `${c} moves away from the camera`), o('across frame', `${c} moves across the frame`),
      ...others.filter((x) => x !== c).map((x) => o(`lifted or carried by ${x}`, `${c} is lifted or carried by ${x}`)),
      o(UNSTATED, 'the plan does not say'),
    ]);
  }

  for (const p of props) {
    const hk = knownHolder(p);
    const who = (carried && carried.holder[p] !== undefined) ? (carried.holder[p] === 'none' ? 'held by nobody' : `${carried.worn && carried.worn[p] ? 'worn' : 'held'} by ${humanId(carried.holder[p])}`) : null;
    if (!hk) add(`${p}.held_start`, 'held_start', p, `Who holds ${p} when this cut opens?`, [
      ...chars.map((c) => o(`held by ${c}`, `${c} holds ${p}`)), ...(wears[p] ? chars.map((c) => o(`worn by ${c}`, `${c} wears ${p}`)) : []), ...sharedOpts(p), o('held by nobody', `nobody holds ${p}`), o(UNSTATED, 'the plan does not say'),
    ]);
    add(`${p}.held_by`, 'held_by', p, `Who holds ${p} when this cut ends? Hold, wear, lift, pass and put down are the changes; "${STAYS}" keeps what it is now${who ? ` (${who})` : ''}.`, [
      o(STAYS, `unchanged${who ? `: ${who}` : ''}`),
      ...chars.map((c) => o(`held by ${c}`, `${c} holds ${p}`)),
      ...(wears[p] ? chars.map((c) => o(`worn by ${c}`, `${c} wears ${p}`)) : []),
      ...sharedOpts(p),
      ...chars.map((c) => o(`lifted by ${c}`, `${c} picks ${p} up from where it lies during this cut`)),
      ...chars.map((c) => o(`passed to ${c}`, `${p} is handed to ${c} by whoever holds it now`)),
      o('put down', `its holder sets ${p} down during this cut; nobody holds it afterwards`),
      o('held by nobody', `nobody holds ${p}`), o(UNSTATED, 'the plan does not say'),
    ]);
    if (isDirectional(p, propInfo[p])) add(`${p}.points_at`, 'points_at', p, `What is ${p} pointed at in this cut?`, [
      ...targets(p).map((t) => o(t, `${p} points at ${t}`)), o('down', `${p} points down`), o('at camera', `${p} points at the camera`), o('away from camera', `${p} points away from the camera`),
      ...chars.map((c) => o(`along ${c}'s movement`, `${p} points along the direction ${c} is moving`)), o(UNSTATED, 'the plan does not say'),
    ]);
  }

  if (withCamera && chars.length) {
    const t = String(cameraAngle || '');
    let sides = null;
    if (/\bfrom behind\b|\bbehind (?:her|him|them|the)\b|over[- ]the[- ]shoulder|\bOTS\b/i.test(t)) sides = ['behind'];
    else if (/\bahead of (?:her|him|them)\b|\bin front of\b|\bfrom the front\b|\bhead[- ]on\b|\bfrontal\b/i.test(t)) sides = ['front'];
    else if (/\bprofile\b|\bside[- ]on\b|\bfrom the side\b/i.test(t)) sides = ['left', 'right', 'side-on'];
    const kinds = [['front', 'in front of'], ['behind', 'behind'], ['left', 'to the left of'], ['right', 'to the right of'], ['side-on', 'side-on to']];
    const sideOpts = kinds.filter(([n]) => !sides || sides.includes(n)).flatMap(([n, phrase]) => chars.map((c) => o(n === 'side-on' ? `side-on to ${c}` : `${n === 'front' ? 'in front of' : n === 'behind' ? 'behind' : `${n} of`} ${c}`, n === 'side-on' ? `the camera is side-on to ${c}; use this ONLY when the shot is described as from the side or in profile and says neither left nor right` : `the camera is ${phrase} ${c}`)));
    const both = [['front', 'in front of both', 'in front of'], ['behind', 'behind both', 'behind'], ['side-on', 'side-on to both', 'side-on to']].filter(([n]) => !sides || sides.includes(n))
      .flatMap(([, key, phrase]) => pairs.map(([a, b]) => o(`${key} ${a} and ${b}`, `the camera frames both at once, ${phrase} ${a} and ${b}${key.startsWith('side') ? ' (a two-shot from the side)' : ''}`)));
    if (sideOpts.length >= 2) add('camera.side', 'camera', 'camera', 'Where is the camera relative to the characters (relative to the way each faces)?', [...sideOpts, ...both, o(UNSTATED, 'the plan does not say')]);
    add('camera.height', 'camera', 'camera', 'How high is the camera relative to eye level?', [...HEIGHTS.map((h) => o(h, `camera height: ${h}`)), o(UNSTATED, 'the plan does not say')]);
  }
  return qs;
}

// ---- the ledger carried clip to clip, folded cut by cut by CODE ----
export const emptyLedger = () => ({ zone: {}, holder: {}, worn: {}, notes: [] });
const clone = (x) => JSON.parse(JSON.stringify(x));

export function ledgerText(L) {
  const z = Object.entries(L.zone).map(([id, v]) => `  - ${humanId(id)} is ${stripLevel(v)}`);
  const h = Object.entries(L.holder).map(([id, v]) => `  - ${humanId(id)} is ${v === 'none' ? 'held by nobody' : `${L.worn?.[id] ? 'worn' : 'held'} by ${humanId(v)}${L.shared?.[id] ? ` and ${humanId(L.shared[id])}` : ''}`}`);
  if (!z.length && !h.length && !L.notes.length) return 'STAGING LEDGER at the start of this clip: empty (nothing carried over; this is the first clip).';
  return ['STAGING LEDGER at the start of this clip (carried over from the previous clips):', ...z, ...h, ...(L.notes.length ? ['Notable changes so far:', ...L.notes.slice(-8).map((n) => `  - ${n}`)] : [])].join('\n');
}

const parseHolder = (a) => {
  const sh = /^(?:shared between|worn by both) (\S+) and (\S+)$/.exec(String(a));
  if (sh) return { mode: /^worn/.test(a) ? 'worn' : 'shared', who: sh[1], also: sh[2] };
  const m = /^(held|worn|lifted|passed) (?:by|to) (.+)$/.exec(String(a));
  return m ? { mode: m[1], who: m[2] } : null;
};
const setHolder = (cur, prop, h) => {
  cur.holder[prop] = h.who;
  if (h.also) { cur.shared ??= {}; cur.shared[prop] = h.also; } else if (cur.shared) delete cur.shared[prop];
  if (h.mode === 'worn') cur.worn[prop] = true; else delete cur.worn[prop];
};

// Walks the cuts in order. `answers`: question id -> chosen option key (every question of the clip). Returns the resolved absolute picks (what the writer is told), the ledger after the clip and the changes.
export function resolveStaging({ clipNumber, ledger, questions, answers, cutCount, landmarks }) {
  const cur = clone(ledger);
  cur.worn ??= {};
  const lm = Object.fromEntries(landmarks.map((l) => [l.id, l]));
  const picks = {}, changes = [];
  const set = (id, k, v) => { if (v !== undefined && v !== null) picks[`c${k}.${id}`] = v; };
  for (let k = 1; k <= cutCount; k++) {
    const qs = questions.filter((q) => q.kind === 'stage' && q.cut === k);
    const ofType = (t) => qs.filter((q) => q.type === t);
    for (const q of ofType('held_start')) {
      const a = answers[q.id] ?? UNSTATED, h = a === 'held by nobody' ? { mode: 'held', who: 'none' } : parseHolder(a);
      picks[q.id] = a;
      if (h) setHolder(cur, q.subject, h);
    }
    for (const q of ofType('zone')) {
      const a = answers[q.id] ?? UNSTATED;
      if (a === STAYS) picks[q.id] = cur.zone[q.subject] ?? UNSTATED;
      else if (a === UNSTATED) picks[q.id] = UNSTATED;
      else if (a === WEARER) picks[q.id] = WEARER;
      else { picks[q.id] = a; cur.zone[q.subject] = a; }
    }
    for (const q of qs.filter((x) => ['faces', 'points_at', 'camera'].includes(x.type))) picks[q.id] = answers[q.id] ?? UNSTATED;
    for (const q of ofType('moves')) {
      const a = answers[q.id] ?? UNSTATED;
      picks[q.id] = a;
      const t = /^toward (.+)$/.exec(a), by = /^lifted or carried by (.+)$/.exec(a), on = /^(?:sits|lies) down on (.+)$/.exec(a), through = /^enters through (.+)$/.exec(a);
      if (t && lm[t[1]]) { const z = arrivalZone(lm[t[1]]); if (z) cur.zone[q.subject] = z; }
      if (on && lm[on[1]]) cur.zone[q.subject] = arrivalOn(lm[on[1]]);
      if (through && lm[through[1]]) { const z = arrivalZone(lm[through[1]]); if (z) cur.zone[q.subject] = z; }
      if (by && cur.zone[by[1]]) cur.zone[q.subject] = cur.zone[by[1]];
    }
    for (const q of ofType('held_by')) {
      const a = answers[q.id] ?? UNSTATED, before = cur.holder[q.subject];
      if (a === STAYS) { picks[q.id] = before ?? UNSTATED; if (before !== undefined) picks[`${q.id}.mode`] = cur.worn[q.subject] ? 'worn' : 'held'; continue; }
      if (a === UNSTATED) { picks[q.id] = UNSTATED; continue; }
      if (a === 'held by nobody') { picks[q.id] = 'none'; picks[`${q.id}.mode`] = 'held'; cur.holder[q.subject] = 'none'; delete cur.worn[q.subject]; if (cur.shared) delete cur.shared[q.subject]; continue; }
      if (a === 'put down') {
        picks[q.id] = 'none'; picks[`${q.id}.mode`] = 'put down'; if (before && before !== 'none') { picks[`${q.id}.from`] = before; if (cur.zone[before]) cur.zone[q.subject] = cur.zone[before]; }
        cur.holder[q.subject] = 'none'; delete cur.worn[q.subject]; if (cur.shared) delete cur.shared[q.subject]; continue;
      }
      const h = parseHolder(a);
      if (!h) { picks[q.id] = UNSTATED; continue; }
      picks[q.id] = h.who; picks[`${q.id}.mode`] = h.mode;
      if (h.also) picks[`${q.id}.also`] = h.also;
      if (h.mode === 'lifted') picks[`${q.id}.from`] = 'none';
      else if (h.mode === 'passed' && before && before !== h.who) picks[`${q.id}.from`] = before;
      else if (h.mode === 'held' && before !== undefined && before !== h.who) picks[`${q.id}.from`] = before;
      else if (h.also && before !== undefined && before !== 'none' && before !== h.who && before !== h.also) picks[`${q.id}.from`] = before;
      setHolder(cur, q.subject, h);
      if (cur.zone[h.who]) cur.zone[q.subject] = cur.zone[h.who];
    }
    // a prop in someone's hands or worn is where its holder is when the cut opens
    for (const q of ofType('zone')) {
      const holder = cur.holder[q.subject], hz = holder && holder !== 'none' ? picks[`c${k}.${holder}.zone`] : null;
      if (hz && hz !== UNSTATED && (answers[q.id] === STAYS || answers[q.id] === UNSTATED || answers[q.id] === WEARER || answers[q.id] === undefined)) { picks[q.id] = hz; cur.zone[q.subject] = hz; }
    }
  }
  // at the end of the clip a prop in someone's hands is where its holder is, whether or not the clip's cuts named it
  for (const [prop, holder] of Object.entries(cur.holder)) if (holder !== 'none' && cur.zone[holder]) cur.zone[prop] = cur.zone[holder];
  for (const [id, v] of Object.entries(cur.zone)) if (ledger.zone[id] && ledger.zone[id] !== v) changes.push(`clip ${clipNumber}: ${humanId(id)} goes from ${stripLevel(ledger.zone[id])} to ${stripLevel(v)}`);
  for (const [id, v] of Object.entries(cur.holder)) if (ledger.holder[id] !== undefined && ledger.holder[id] !== v) changes.push(`clip ${clipNumber}: ${humanId(id)} changes hands from ${humanId(ledger.holder[id])} to ${humanId(v)}`);
  cur.notes = [...ledger.notes, ...changes];
  return { picks, ledgerAfter: cur, changes };
}

// A carried position names a landmark of one location; in a clip set elsewhere it no longer applies and is dropped from what is carried in.
export function pruneLedger(L, landmarks) {
  const valid = new Set(zoneOptions(landmarks, 'x').map((x) => x.key));
  const next = clone(L);
  for (const [id, z] of Object.entries(next.zone)) if (!valid.has(z)) delete next.zone[id];
  return next;
}

// ---- strict reply schema: one enum per question; an out-of-set answer cannot be produced ----
export function replySchema(questions, optionsOf) {
  const properties = {};
  for (const q of questions) properties[q.id] = { type: 'string', enum: optionsOf(q).map((x) => x.key) };
  return { type: 'object', properties, required: questions.map((q) => q.id), additionalProperties: false };
}
