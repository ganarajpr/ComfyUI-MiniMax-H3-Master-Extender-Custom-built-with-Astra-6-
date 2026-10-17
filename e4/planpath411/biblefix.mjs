// E4.11: the deterministic fixes of a parsed bible, and the split of what is left into HARD issues (the film cannot be built from the bible: a missing or malformed entity, a speaker with no
// cast id, a bad reference slot) and SOFT ones (the opening state, the wording of the base line: the subject line strips those itself, so they are warnings). Generic rules only.
import { resolveSpeaker } from './speakers.mjs';
import { traceAxes, bibleTarget, BIBLE_GROUP, norm, openingOf, showsLaterState, stripOpeningWording, contentStems, isOpeningIssue, isBaseWordingIssue } from './state.mjs';
import { plannedSpeakers } from './bible.mjs';

const lcFirstOf = (t) => { const x = String(t ?? '').trim().replace(/[.\s]+$/, ''); return /^(?:A|An|The) /.test(x) ? x[0].toLowerCase() + x.slice(1) : x; };
const UNIT_SPLIT = /(,\s+and\s+|;\s+|,\s+|\s+and\s+|\s+with\s+)/i;

// A string that shows a later state: the units (split at commas, "and", "with") that show it go, never the first unit (the subject's own noun phrase).
export function dropLaterStateUnits(text, option, opening, entity) {
  const parts = String(text).split(UNIT_SPLIT), units = parts.filter((_, i) => i % 2 === 0), delims = parts.filter((_, i) => i % 2 === 1);
  if (units.length < 2) return null;
  const keep = units.map((u, i) => i === 0 || !showsLaterState(u, option, opening, entity));
  if (keep.every(Boolean)) return null;
  let out = units[0], pending = null;
  for (let i = 1; i < units.length; i++) {
    if (!keep[i]) { if (/^\s+with\s+$/i.test(delims[i - 1]) && !pending) pending = delims[i - 1]; continue; }
    out += (pending || delims[i - 1]) + units[i];
    pending = null;
  }
  return contentStems(out).length >= 2 ? out : null;
}

function setLeaves(node, fn) {
  if (Array.isArray(node)) node.forEach((x, i) => { if (typeof x === 'string') node[i] = fn(x); else setLeaves(x, fn); });
  else if (node && typeof node === 'object') for (const [k, v] of Object.entries(node)) { if (typeof v === 'string') node[k] = fn(v); else setLeaves(v, fn); }
}

export function applyBibleFixes(bible, plan, story = '') {
  const fixes = [];
  const note = (kind, detail = {}) => fixes.push({ kind, ...detail });
  if (!bible || typeof bible !== 'object') return fixes;
  if ((typeof bible.language !== 'string' || !bible.language.trim())) {
    const m = /DIALOGUE LANGUAGE:\s*([^.\n]+)/i.exec(String(story));
    if (m) { bible.language = m[1].trim(); note('language_set', { language: bible.language }); }
  }
  const cast = Array.isArray(bible.cast) ? bible.cast : [];
  cast.forEach((c, i) => { if (c && !['left', 'right'].includes(c.side)) { c.side = i % 2 === 0 ? 'left' : 'right'; note('side_set', { id: c.id, side: c.side }); } });
  if (bible.speakers && typeof bible.speakers === 'object' && !Array.isArray(bible.speakers) || bible.speakers === undefined) {
    bible.speakers = bible.speakers || {};
    const ids = new Set([...cast, ...(Array.isArray(bible.voices) ? bible.voices : [])].map((e) => e?.id));
    for (const s of plannedSpeakers(plan)) {
      if (ids.has(bible.speakers[s])) continue;
      const own = bible.speakers[s];
      delete bible.speakers[s];
      const id = resolveSpeaker(bible, s);
      if (id) { bible.speakers[s] = id; note('speaker_mapped', { speaker: s, id }); } else if (own !== undefined) bible.speakers[s] = own;
    }
  }
  for (const { entity, axis } of traceAxes(plan)) {
    const t = bibleTarget(entity, bible), spec = t && BIBLE_GROUP[t.type];
    if (!spec) continue;
    const list = Array.isArray(bible[spec[0]]) ? bible[spec[0]] : [], e = list.find((x) => x?.id === t.id);
    if (!e) continue;
    const opening = openingOf(entity, axis), later = axis.options.filter((o) => norm(o) !== norm(opening));
    if (typeof e.appearsAs === 'string' && e.appearsAs.trim()) {
      const lead = lcFirstOf(e.appearsAs), cut = stripOpeningWording(lead, [{ entity: entity.id, name: entity.name, options: axis.options, opening }]);
      if (cut.text !== lead && contentStems(cut.text).length >= 3) {
        e.appearsAs = /^(?:A|An|The) /.test(String(e.appearsAs).trim()) ? cut.text[0].toUpperCase() + cut.text.slice(1) : cut.text;
        note('base_wording_stripped', { id: e.id, axis: `${entity.id}.${axis.axis}`, removed: [...cut.removed.map((x) => x.unit), ...cut.reworded.map((x) => x.from)] });
      }
    }
    for (const k of spec.slice(1)) {
      if (e[k] === undefined) continue;
      const fix = (v) => { for (const o of later) { if (!showsLaterState(v, o, opening, entity)) continue; const r = dropLaterStateUnits(v, o, opening, entity); if (r) { note('opening_state_stripped', { id: e.id, axis: `${entity.id}.${axis.axis}`, removed: v }); return r; } } return v; };
      if (typeof e[k] === 'string') e[k] = fix(e[k]); else setLeaves(e[k], fix);
    }
  }
  return fixes;
}

export const isSoftBibleIssue = (x) => isOpeningIssue(x) || isBaseWordingIssue(x);
export const splitBibleIssues = (issues) => ({ hard: issues.filter((x) => !isSoftBibleIssue(x)), soft: issues.filter(isSoftBibleIssue) });
