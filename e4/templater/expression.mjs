// Expression layer (v5): FACS (face) + BAP (body/posture) as CLOSED taxonomies.
//
//   candidates   = (state-word prior  U  the character's signature codes  U  units the spec text names)
//                  filtered by what the shot size can show
//   Jev          = one positively phrased `noul` per candidate + one `score` A-E for the strongest
//   rendering    = the top <= 3 candidates with p > 0.5, as physical prose attached to the key event
//
// The taxonomy files in ./taxonomy carry the citations. Codes never reach the prose.

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { contained } from './clean.mjs';
import { shotSpecText, feasible, conflicts, fnv } from './derive.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const load = (f) => JSON.parse(readFileSync(join(here, 'taxonomy', f), 'utf8'));
export const FACS = load('facs.json');
export const BAP = load('bap.json');
export const PRIORS = load('priors.json');
export const SIGNATURES = load('signatures.json');

export const UNITS = new Map([...FACS.units, ...BAP.units].map((u) => [u.code, u]));
export const CLOSENESS = { wide: 0, medium: 1, ots: 1, mcu: 2, close: 3, insert: 4 };
export const MAX_RENDERED = 3;
export const P_THRESHOLD = 0.5;
export const INTENSITY_LEVELS = ['A trace', 'B slight', 'C marked', 'D strong', 'E extreme'];

export function visibleAt(unit, size) {
  if (size === 'insert') return unit.region === 'hand';
  const c = size ? CLOSENESS[size] : 1;
  return c >= unit.minCloseness && c <= unit.maxCloseness;
}

// "the corners of his mouth sink" -- {adv} is dropped when empty.
export function unitText(unit, pron, adv = '') {
  return unit.render
    .replace(/\{poss\}/g, pron.poss).replace(/\{obj\}/g, pron.obj).replace(/\{subj\}/g, pron.subj)
    .replace(/\s*\{adv\}/g, adv ? ` ${adv}` : '').replace(/\s+/g, ' ').trim();
}

export function advFor(letter, shotId, i) {
  const levels = FACS.intensity[letter] && FACS.intensity[letter].render;
  if (!levels) return null;
  return levels[fnv(`${shotId}:adv${i}`) % levels.length];
}

export function priorCodes(stateTarget) {
  const out = [];
  const t = String(stateTarget || '');
  for (const s of PRIORS.states) {
    if (new RegExp(`\\b(?:${s.words})\\b`, 'i').test(t)) for (const c of s.units) if (!out.includes(c)) out.push(c);
  }
  for (const [emo, codes] of Object.entries(PRIORS.emotions)) {
    if (new RegExp(`\\b${emo}\\b`, 'i').test(t)) for (const c of codes) if (!out.includes(c)) out.push(c);
  }
  return out;
}

export function signatureFor(entry) {
  const codes = [];
  let cat = null;
  for (const r of SIGNATURES.rules) {
    if (new RegExp(r.match, 'i').test(entry.text)) {
      for (const c of r.codes) if (!codes.includes(c)) codes.push(c);
      if (r.cat && !cat) cat = r.cat;
    }
  }
  return { codes, cat };
}

const systemOf = (code) => (UNITS.get(code) ? UNITS.get(code).system : /^(AU|AD)\d/.test(code) ? 'FACS' : 'BAP');

// Candidate set for one character in one shot.
//  eligibleEntries: master entries the shot may use (derive.tellCandidates filters)
export function buildCandidates({ shot, per, size, pron, stateTarget, eligibleEntries, events }) {
  const text = shotSpecText(shot, per);
  const nothing = /^\s*(?:nothing|none)\b/i.test(String(per.interactingWith || ''));
  const specText = [text, ...(events || []).map((e) => e.text)].join(' ');
  const out = [];
  const seen = new Set();
  const ok = (u) => visibleAt(u, size) && !(u.region === 'hand' && nothing) && !(u.region === 'legs' && !feasible({ text: 'steps' }, specText)) && !conflicts({ text: unitText(u, pron) }, specText);
  const add = (u, source) => {
    if (!u || seen.has(u.code) || !ok(u)) return;
    seen.add(u.code);
    out.push({ key: u.code, codes: [u.code], source, unit: u, desc: unitText(u, pron) });
  };
  // signature entries first, as composites (one question per tell)
  const mapping = [];
  for (const e of eligibleEntries || []) {
    // a roaming-gaze tell is not offered when the spec already gives this shot's gaze path
    if (e.region === 'eyes' && per.lookingAt && !/\b(?:widen\w*|jump\w*|catchlight\w*)\b/i.test(e.text) && !/\b(?:fixed|locked|frozen|still)\b/i.test(text)) continue;
    const { codes, cat } = signatureFor(e);
    mapping.push({ entryId: e.id, text: e.text, kind: e.kind, codes, category: cat });
    if (!codes.length) continue;
    const vis = codes.filter((c) => !UNITS.get(c) || visibleAt(UNITS.get(c), size));
    if (!vis.length) continue;
    if (out.some((c) => c.entry && c.entry.id === e.id)) continue;
    out.push({ key: `sig:${e.id}`, codes: vis, source: 'signature', entry: e, desc: e.text.replace(/^(?:a|an)\s+/i, '') });
    vis.forEach((c) => seen.add(c));
  }
  for (const code of priorCodes(stateTarget)) add(UNITS.get(code), 'prior');
  for (const u of UNITS.values()) if (u.lexical && new RegExp(`\\b(?:${u.lexical})`, 'i').test(specText)) add(u, 'spec');
  return { candidates: out.slice(0, 16), mapping };
}

// Decide-side: the questions. Positive, literal, one claim each.
export function expressionQuestions({ name, stateTarget, keyEvent, candidates }) {
  const at = keyEvent ? ` At the moment when ${keyEvent},` : ' At the key moment of the shot,';
  const q = {};
  candidates.forEach((c, i) => {
    q[`x_${i}`] = {
      type: 'noul',
      instructions: `${name}'s state in this shot is "${stateTarget || 'steady'}".${at} does ${name} show this: ${c.desc}?`,
    };
  });
  q.x_intensity = {
    type: 'score',
    instructions: `How strong is the strongest facial or body expression ${name} shows at that moment?`,
    criteria: INTENSITY_LEVELS,
  };
  return q;
}

export function readExpressionAnswers(candidates, answers) {
  const ps = candidates.map((c, i) => {
    const a = answers && answers[`x_${i}`];
    return typeof (a && a.noul) === 'number' ? a.noul : null;
  });
  const sc = answers && answers.x_intensity;
  let letter = null;
  if (sc) {
    // probabilities are keyed by level index "0".."4" (legend: A trace .. E extreme); the argmax is the level
    if (sc.probabilities) {
      const best = Object.entries(sc.probabilities).sort((a, b) => b[1] - a[1])[0];
      if (best) letter = 'ABCDE'[Number(best[0])] || (/^[A-E]/.test(best[0]) ? best[0][0] : null);
    }
    if (!letter && typeof sc.score === 'number') letter = 'ABCDE'[Math.max(0, Math.min(4, Math.round(sc.score)))];
  }
  return { ps, intensity: letter };
}

// Which candidates get written: p over the threshold, best first, one per body region, none repeated
// from the previous shot unless nothing else qualifies.
export function selectRendered(candidates, ps, prevKeys = new Set(), saidText = '', pMin = P_THRESHOLD) {
  const ranked = candidates.map((c, i) => ({ c, p: ps[i] })).filter((x) => x.p != null && x.p > pMin && !(saidText && contained(x.c.desc.replace(/\s+(?:slightly|a fraction|faintly)\b/g, ''), saidText) >= 0.6)).sort((a, b) => b.p - a.p);
  const fresh = ranked.filter((x) => !prevKeys.has(x.c.key));
  const pool = fresh.length ? fresh : ranked;
  const picked = [];
  const regions = new Set();
  for (const x of pool) {
    const r = x.c.unit ? x.c.unit.region : (x.c.entry ? x.c.entry.region : 'x');
    if (regions.has(r)) continue;
    // a unit already stated by a picked signature composite is not repeated
    if (picked.some((y) => y.c.codes.some((k) => x.c.codes.includes(k)))) continue;
    regions.add(r);
    picked.push(x);
    if (picked.length >= MAX_RENDERED) break;
  }
  return picked;
}

export const cap = (letter) => (['B', 'C', 'D'].includes(letter) ? letter : letter === 'E' ? 'D' : letter === 'A' ? 'B' : 'B');
export { contained };
