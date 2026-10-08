// Derive step: everything that follows from the spec by a table or a rule.
// No model is involved. Camera move, shot size, eyeline, escalation tier,
// duration and the acting-master entries each shot draws on are all decided here.

import { DURATION_GRID } from './lexicon.mjs';
import { REGIONS, regionOf } from './vocab.mjs';
import { contentWords, wordCount } from './clean.mjs';

export function fnv(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}
export const pick = (list, key) => list[fnv(String(key)) % list.length];

// ── camera ────────────────────────────────────────────────────────────────
// Exactly one H3 term per shot, read from the spec's cameraAngle. First match
// wins, so an explicit move beats a general adjective ("handheld ... spins" is
// an Arc Shot: the visible motion is the turn). Angles ("high angle looking
// down") are not moves and fall through to Static Shot.
const MOVES = [
  [/\bpush(?:es|ing)?[- ]?in\b|\bdolly(?:ing)? in\b|\bmoves? in\b|\bclos(?:es|ing) in\b/i, 'Push In'],
  [/\bpull(?:s|ing)?[- ]?(?:out|back)\b|\bdolly(?:ing)? out\b|\bwidens?\b/i, 'Pull Out'],
  [/\bzoom(?:s|ing)? in\b/i, 'Zoom In'],
  [/\bzoom(?:s|ing)? out\b/i, 'Zoom Out'],
  [/\btilt(?:s|ing)? up\b/i, 'Tilt Up'],
  [/\btilt(?:s|ing)? down\b/i, 'Tilt Down'],
  [/\bpan(?:s|ning)? left\b/i, 'Pan Left'],
  [/\bpan(?:s|ning)? right\b/i, 'Pan Right'],
  [/\btrack(?:s|ing)?\b|\bfollow(?:s|ing)?\b|\bdolly(?:ing)? (?:with|alongside)\b/i, 'Tracking Shot'],
  [/\bhand-?held\b|\bshaky\b|\bshake\w*\b/i, 'Shake Slightly'],
  [/\borbit\w*|\barc(?:s|ing)?\b|\bcircl\w+|\bswings?\b/i, 'Arc Shot'],
  [/\bstatic\b|\blocked\b|\bfixed\b|\block-?off\b|\bholds?\b|\bstill\b/i, 'Static Shot'],
];

export function deriveCamera(cameraAngle) {
  const text = String(cameraAngle || '');
  let term = 'Static Shot';
  for (const [re, t] of MOVES) {
    if (re.test(text)) { term = t; break; }
  }
  let suffix = '';
  if (term === 'Shake Slightly') suffix = ' with small amplitude';
  else if (term !== 'Static Shot') {
    if (/\bslow(?:ly)?\b/i.test(text)) suffix = ' at slow speed';
    else if (/\b(?:fast|rapid|quick|whip)\w*\b/i.test(text)) suffix = ' at fast speed';
  }
  return { term, suffix };
}

// An object insert: a close-up whose target is not the character's face/head/eyes.
export function deriveSize(cameraAngle, names = []) {
  const t = String(cameraAngle || '').toLowerCase();
  const m = /(?:close[- ]?up|insert|tight)\s+on\s+(.*)$/i.exec(String(cameraAngle || ''));
  if (m && !/over[- ]the[- ]shoulder/.test(t)) {
    const who = ['his', 'her', 'their', ...names.map((n) => n.toLowerCase())].join('|');
    const face = new RegExp(`\\b(?:${who})(?:'s)?\\s+(?:face|eyes|head|profile)\\b`, 'i');
    if (!face.test(m[1])) return 'insert';
  }
  if (/over[- ]the[- ]shoulder/.test(t)) return 'ots';
  if (/extreme close|big close|tight on/.test(t)) return 'close';
  if (/medium close/.test(t)) return 'mcu';
  if (/close[- ]?up/.test(t)) return 'close';
  if (/\bwide\b|establishing|\blong shot\b|full shot/.test(t)) return 'wide';
  if (/\bmedium\b|waist/.test(t)) return 'medium';
  return null;
}

// Strip the move adjective that the term already says ("Static wide shot" ->
// "wide shot") so the camera sentence does not state it twice.
export function describeAngle(cameraAngleFragment) {
  let t = String(cameraAngleFragment || '').trim();
  t = t.replace(/^(?:static|locked(?:-off)?|slow|fast|steady|handheld|hand-held)\s+(?:push-in\s+|pull-out\s+)?/i, '');
  if (/^(?:medium|wide|close|long)\b/i.test(t) && !/\b(?:shot|close-up|angle)\b/i.test(t)) {
    t = t.replace(/^(\w+)/, '$1 shot');
  }
  return t.charAt(0).toUpperCase() + t.slice(1);
}

// ── geometry ──────────────────────────────────────────────────────────────
export function opposite(side) {
  return String(side).toLowerCase() === 'left' ? 'RIGHT' : 'LEFT';
}

// An eyeline is stated only when the shot's own lookingAt gives a horizontal side.
export function eyelineFromLooking(lookingAt) {
  const m = /\b(?:off-?frame |toward |to |at )?(?:frame )?(left|right)\b/i.exec(String(lookingAt || ''));
  return m ? m[1].toUpperCase() : null;
}

// ── duration ──────────────────────────────────────────────────────────────
// Speech at 2.6 words/s + 1 s lead-in + 0.35 s between lines + 1.5 s tail; a
// silent shot gets 4.5 s plus 1 s per gaze target and 0.8 s for a state change.
export function deriveDuration({ lines, gazeTargets, hasChange }) {
  let need;
  if (lines.length) {
    const words = lines.reduce((n, l) => n + wordCount(l.text), 0);
    need = 1 + words / 2.6 + 0.35 * Math.max(0, lines.length - 1) + 1.5 + 1.0 * Math.max(0, gazeTargets - 1) + (hasChange ? 0.8 : 0);
  } else {
    need = 4.5 + 1.0 * gazeTargets + (hasChange ? 0.8 : 0);
  }
  const d = DURATION_GRID.find((g) => g >= need) ?? DURATION_GRID[DURATION_GRID.length - 1];
  return Math.max(d, DURATION_GRID[0]);
}

// ── acting-master entries ────────────────────────────────────────────────
// Which body regions a framing can show. A region is also visible when the
// shot's own acting text names it (a thumb on a control in a close-up).
export const VISIBLE = {
  insert: ['hands'],
  wide: ['posture', 'hands'],
  medium: ['posture', 'hands', 'breath', 'eyes'],
  mcu: ['eyes', 'jaw', 'breath', 'posture'],
  close: ['eyes', 'jaw', 'breath', 'posture'],
  ots: ['posture', 'hands', 'jaw'],
};

const STANDING_RE = /\b(?:stand\w*|walk\w*|step\w*|climb\w*|moves? toward|rises?|strides?)\b/i;
const LEGS_RE = /\b(?:foot|feet|step|steps|stride|walk|knees?|legs?)\b/i;

// An entry that needs the character on their feet is not used in a shot whose
// own spec never has them stand, walk or climb.
export function feasible(entry, specText) {
  return !LEGS_RE.test(entry.text) || STANDING_RE.test(specText);
}

// A roaming-gaze entry does not belong in a shot whose spec holds the gaze fixed.
const HOLD_RE = /\b(?:fixed|locked|frozen|still)\b/i;
const ROAM_RE = /\b(?:slid\w*|slides|roam\w*|dart\w*|wander\w*|jump\w*|lead\w*)\b/i;
export function conflicts(entry, specText) {
  return HOLD_RE.test(specText) && ROAM_RE.test(entry.text);
}

// An entry that names a direction the spec contradicts ("eyes going fixed upward" in a shot that
// looks down) keeps its action and loses the direction.
export function adaptEntry(entry, specText) {
  if (/\bup(?:ward)?\b/i.test(entry.text) && /\bdown(?:ward)?\b/i.test(specText)) {
    return { ...entry, text: entry.text.replace(/\s+(?:and\s+)?(?:slightly\s+)?up(?:ward)?\b/gi, '').trim() };
  }
  return entry;
}

export function shotSpecText(shot, per = {}) {
  const d = shot.direction;
  return [d.whatItShows, d.microAction, d.soundAnchor, per.behaviours, per.lookingAt, per.interactingWith].join(' ');
}

// Regions the spec already gives an action for: a second behaviour on the same
// body part would contradict or crowd it, so entries for those regions are skipped.
// interactingWith "nothing" also closes the hands (no pocket tap, no hand business).
export function excludedRegions(shot, per = {}) {
  const d = shot.direction;
  const own = [per.behaviours, d.microAction, d.whatItShows].join(' ');
  const out = new Set(Object.entries(REGIONS).filter(([, re]) => re.test(own)).map(([r]) => r));
  if (per.lookingAt) out.add('eyes');
  if (/^\s*(?:nothing|none)\b/i.test(String(per.interactingWith || ''))) out.add('hands');
  return out;
}

export function triggerScore(entry, text) {
  if (entry.kind !== 'tic' || !entry.trigger) return 0;
  const trig = contentWords(entry.trigger);
  const have = contentWords(text);
  let shared = 0;
  for (const w of trig) if (have.has(w)) shared++;
  return shared >= 2 && shared / trig.size >= 0.4 ? shared / trig.size : 0;
}

const GENERIC_COND = new Set(['take', 'over', 'when', 'whenev', 'once', 'body', 'under', 'tempo', 'doubl', 'crack', 'break', 'hi', 'her']);

// A crack entry is tied to a condition ("when the voice takes over", "on playback");
// it is only on offer when a distinctive word of that condition is in the shot's own text.
export function conditionMet(entry, text) {
  if (entry.kind === 'tic') return triggerScore(entry, text) > 0;
  if (entry.kind !== 'crack') return true;
  const have = contentWords(text);
  return [...contentWords(entry.condText || '')].some((w) => !GENERIC_COND.has(w) && have.has(w));
}

// Entries Jev may choose a tell from for this shot: the character's own vocabulary,
// minus body parts the spec already gave an action, minus legs for a seated shot,
// and cracks/tics only for a real stateChange whose condition is present.
export function tellCandidates(vocab0, shot, per, hasChange) {
  const text = shotSpecText(shot, per);
  const vocab = vocab0.map((e) => adaptEntry(e, text));
  const excluded = excludedRegions(shot, per);
  return vocab.filter((e) => {
    if (e.kind === 'mask') return false;
    if (e.region === 'hands' && excluded.has('hands') && /^\s*(?:nothing|none)\b/i.test(String(per.interactingWith || ''))) return false;
    if ((e.kind === 'crack' || e.kind === 'tic') && excluded.has(e.region)) return false;
    if (!feasible(e, text) || conflicts(e, text)) return false;
    if ((e.kind === 'crack' || e.kind === 'tic') && (!hasChange || !conditionMet(e, text))) return false;
    return true;
  });
}

// Steady carriage entries (no condition) the shot can show; at most `max`, one per region.
export function carriageEntries({ vocab: vocab0, size, shot, per, hasChange, max = 2, skip = new Set(), avoid = new Set() }) {
  const text = shotSpecText(shot, per);
  const vocab = vocab0.map((e) => adaptEntry(e, text));
  const excluded = excludedRegions(shot, per);
  const visible = new Set(VISIBLE[size] || ['posture', 'hands', 'breath', 'eyes', 'jaw']);
  const out = [];
  const used = new Set();
  const pool = vocab
    .filter((e) => ['baseline', 'eyes', 'profile'].includes(e.kind) || false)
    .filter((e) => !skip.has(e.id) && !excluded.has(e.region) && visible.has(e.region) && feasible(e, text) && !conflicts(e, text))
    .map((e) => ({ e, score: (fnv(`${shot.id}:${e.id}`) % 100) / 100 - (avoid.has(e.id) ? 10 : 0) }))
    .sort((a, b) => b.score - a.score);
  for (const { e } of pool) {
    if (out.length >= max) break;
    if (used.has(e.region)) continue;
    used.add(e.region);
    out.push(e);
  }
  return out;
}

export { regionOf };
