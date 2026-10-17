// E4.11: the deterministic fixes of a parsed plan. E4.10 sent the plan back to the planner for state-ledger bookkeeping (an option's grammar, an end_state that disagrees with the ledger,
// an axis that moves backwards, a shot too short for its line); every one of those is mechanical, so code fixes it first and only what code cannot fix is left over.
// Generic rules only: no story word appears here. Every fix is recorded ({ kind, ... }) so a run can count them by kind.
// The ledger is the authority: where the end_state and the folded ledger disagree, the end_state is rewritten from the ledger.
import { tokensOf, humanId } from './lib.mjs';
import { visibleOptionIssue, trimSubjectLead, foldState, contentStems, EMOTION_WORDS, norm, lc, openingOf, nameHeads, traceAxes, entityWords } from './state.mjs';
import { aftermathMissing, TRACE_TEMPLATE, traceAxisName, CUES } from './aftermath.mjs';
import { CAMERA_SHOTS, DIALOGUE_WORDS_PER_SECOND_MAX, MIN_SHOT_SECONDS, CLIP_SECONDS, SECONDS_TOLERANCE, secondsNeeded, wordCount } from './planner.mjs';

const slugOf = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
const words = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/\p{M}/gu, '').match(/\p{L}+/gu) || [];
const lcFirst = (t) => { const x = String(t || '').trim(); return x ? x[0].toLowerCase() + x.slice(1) : x; };

// ---- 1. the camera term: a spelling variant of one of the planner's terms ----
const CAMERA_SYNONYM = { wide: 'wide_establishing', establishing: 'wide_establishing', wide_shot: 'wide_establishing', establishing_shot: 'wide_establishing', medium_shot: 'medium', mid: 'medium', mid_shot: 'medium', medium_close_up: 'medium_close', medium_closeup: 'medium_close', close: 'close_up', closeup: 'close_up', close_up_shot: 'close_up', extreme_close_up: 'extreme_close_up_macro', extreme_closeup: 'extreme_close_up_macro', macro: 'extreme_close_up_macro', tracking: 'tracking_following', tracking_shot: 'tracking_following', following: 'tracking_following', ots: 'over_the_shoulder', over_shoulder: 'over_the_shoulder', overhead: 'top_down_overhead', top_down: 'top_down_overhead', birds_eye: 'top_down_overhead', low: 'low_angle', high: 'high_angle' };
export function canonicalCamera(raw) {
  const k = slugOf(raw);
  if (CAMERA_SHOTS.includes(k)) return k;
  return CAMERA_SYNONYM[k] || null;
}
function fixCameras(plan, note) {
  for (const clip of plan.clips) for (const s of clip.shots) {
    if (CAMERA_SHOTS.includes(s.camera_raw)) continue;
    const c = canonicalCamera(s.camera_raw);
    if (c) { note('camera_term', { clip: clip.clip, shot: s.shot, from: s.camera_raw, to: c }); s.camera = c; s.camera_raw = c; }
  }
}

// ---- 2. state_changes that cite something the ledger does not hold ----
const stemSet = (s) => new Set(contentStems(s));
function matchOption(axis, to) {
  const n = norm(to), exact = axis.options.find((o) => norm(o) === n);
  if (exact) return exact;
  const stripped = (x) => norm(x).replace(/[^\p{L}\p{N} ]/gu, '').replace(/\s+/g, ' ');
  const same = axis.options.find((o) => stripped(o) === stripped(to));
  if (same) return same;
  const a = stemSet(to);
  if (!a.size) return null;
  const scored = axis.options.map((o) => { const b = stemSet(o); const common = [...a].filter((x) => b.has(x)).length; return { o, f: common / Math.max(a.size, b.size), g: common / Math.min(a.size, b.size) }; }).sort((x, y) => y.f - x.f);
  return scored[0] && scored[0].f >= 0.75 && (!scored[1] || scored[0].f > scored[1].f) ? scored[0].o : null;
}
function fixStateChanges(plan, note) {
  const ents = plan.ledger.entities;
  for (const clip of plan.clips) {
    const shotNumbers = clip.shots.map((s) => s.shot);
    const kept = [];
    for (const ch of clip.state_changes) {
      let e = ents.find((x) => x.id === ch.entity);
      if (!e) { e = ents.find((x) => slugOf(x.id) === slugOf(ch.entity) || slugOf(x.name) === slugOf(ch.entity)); if (e) { note('change_entity_matched', { clip: clip.clip, from: ch.entity, to: e.id }); ch.entity = e.id; } }
      if (!e) { note('change_dropped', { clip: clip.clip, entity: ch.entity, axis: ch.axis, why: 'entity not in the ledger', warning: `clip ${clip.clip}: a state change of "${ch.entity}" was dropped (no such ledger entity)` }); continue; }
      let a = e.axes.find((x) => x.axis === ch.axis);
      if (!a) { a = e.axes.find((x) => slugOf(x.axis) === slugOf(ch.axis)); if (a) { note('change_axis_matched', { clip: clip.clip, from: ch.axis, to: a.axis }); ch.axis = a.axis; } }
      if (!a) { note('change_dropped', { clip: clip.clip, entity: e.id, axis: ch.axis, why: 'axis not on the entity', warning: `clip ${clip.clip}: a state change of ${e.id}.${ch.axis} was dropped (no such axis)` }); continue; }
      if (!a.options.includes(ch.to)) {
        const m = matchOption(a, ch.to);
        if (m) { note('change_option_matched', { clip: clip.clip, entity: e.id, axis: a.axis, from: ch.to, to: m }); ch.to = m; } else if (a.visible_trace && !visibleOptionIssue(ch.to, { entity: e, axis: a })) { a.options.push(ch.to); note('change_option_added', { clip: clip.clip, entity: e.id, axis: a.axis, option: ch.to }); } else { note('change_dropped', { clip: clip.clip, entity: e.id, axis: a.axis, why: 'value is not an option', warning: `clip ${clip.clip}: the change of ${e.id}.${a.axis} to "${ch.to}" was dropped (not one of its options)` }); continue; }
      }
      if (!shotNumbers.includes(ch.shot)) {
        const to = shotNumbers.length ? shotNumbers.reduce((best, n) => (Math.abs(n - ch.shot) < Math.abs(best - ch.shot) ? n : best), shotNumbers[0]) : ch.shot;
        note('change_shot_clamped', { clip: clip.clip, entity: e.id, axis: a.axis, from: ch.shot, to });
        ch.shot = to;
      }
      kept.push(ch);
    }
    clip.state_changes = kept;
  }
}

// ---- 3. the grammar of a state option ----
const AXIS_STATE_WORDS = new Set('state status condition trace visible look looks appearance level'.split(' '));
const GROUP_SPLIT = /\s*(?:,|;|\band\b)\s*/;
function renameOption(plan, entity, axis, from, to, note) {
  const i = axis.options.findIndex((o) => o === from);
  if (i < 0) return;
  axis.options[i] = to;
  for (const it of entity.initial) if (it.axis === axis.axis && it.value === from) it.value = to;
  for (const c of plan.clips) {
    for (const ch of c.state_changes) if (ch.entity === entity.id && ch.axis === axis.axis && ch.to === from) ch.to = to;
    const es = c.end_state;
    if (es) {
      const re = new RegExp(from.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
      for (const ch of es.characters || []) for (const k of ['state', 'wardrobe', 'props', 'position']) if (re.test(ch[k] || '')) ch[k] = ch[k].replace(re, () => to);
      for (const k of ['location', 'end_action']) if (re.test(es[k] || '')) es[k] = es[k].replace(re, () => to);
    }
  }
  note('option_grammar', { entity: entity.id, axis: axis.axis, from, to });
}

// The candidates, in order of how little they change the planner's words. The first one the planner's own check accepts is used.
export function repairOption(option, ctx) {
  if (!visibleOptionIssue(option, ctx)) return null;
  const { entity, axis } = ctx;
  const heads = nameHeads(entity);
  const bases = [option];
  const lead = trimSubjectLead(option, [entity.name, humanId(entity.id)]);
  if (lead !== option) bases.push(lead);
  // a leading subject noun with its determiner or possessive: "the candle burning low" -> "burning low" is only kept when the rest still reads after "now with"
  const toks = option.trim().split(/\s+/);
  let k = 0;
  while (k < toks.length - 1 && /^(?:the|a|an|his|her|its|their)$/i.test(toks[k])) k += 1;
  const first = (toks[k] || '').toLowerCase().replace(/['’]s$/, '');
  if (heads.has(first) && toks.length - k - 1 >= 1) bases.push(toks.slice(k + 1).join(' '));
  // an emotion word is dropped with the comma unit that holds it
  const units = option.split(GROUP_SPLIT).filter(Boolean);
  const calm = units.filter((u) => !tokensOf(u, 2).some((w) => EMOTION_WORDS.has(w)));
  if (calm.length && calm.length < units.length) bases.push(calm.join(', '));
  const noun = tokensOf(humanId(axis.axis), 2).filter((w) => !AXIS_STATE_WORDS.has(w) && !heads.has(w)).join(' ');
  const cands = [];
  cands.push(...bases);
  if (noun) for (const b of bases) cands.push(`the ${noun} ${lcFirst(b)}`);
  for (const c of cands) { const t = c.trim(); if (t && t !== option && !visibleOptionIssue(t, ctx)) return t; }
  return null;
}
function fixOptions(plan, note) {
  for (const { entity, axis } of traceAxes(plan)) {
    const open = openingOf(entity, axis);
    if (!axis.options.some((o) => norm(o) === norm(open))) { axis.options.unshift(open); note('opening_added', { entity: entity.id, axis: axis.axis, option: open }); }
    for (const o of [...axis.options]) {
      if (norm(o) === norm(open)) continue;
      const better = repairOption(o, { entity, axis });
      if (better && !axis.options.some((x) => x !== o && norm(x) === norm(better))) renameOption(plan, entity, axis, o, better, note);
    }
  }
}

// ---- 4. a progressive axis that moves backwards stays where it was ----
function fixProgressive(plan, note) {
  const ordered = [...plan.clips].sort((a, b) => a.clip - b.clip);
  for (const e of plan.ledger.entities) for (const a of e.axes) {
    if (!a.progressive) continue;
    let last = a.options.indexOf(e.initial.find((i) => i.axis === a.axis)?.value ?? '');
    for (const clip of ordered) {
      const keep = [];
      for (const ch of clip.state_changes) {
        if (ch.entity !== e.id || ch.axis !== a.axis) { keep.push(ch); continue; }
        const idx = a.options.indexOf(ch.to);
        if (idx !== -1 && last !== -1 && idx < last) { note('progressive_clamped', { clip: clip.clip, entity: e.id, axis: a.axis, from: ch.to, held: a.options[last], warning: `${e.id}.${a.axis} would move backwards at clip ${clip.clip} (to "${ch.to}"); it stays at "${a.options[last]}"` }); continue; }
        if (idx !== -1) last = idx;
        keep.push(ch);
      }
      clip.state_changes = keep;
    }
  }
}

// ---- 5. an aftermath the story gives a person and the ledger does not hold: an axis of that kind, from the checklist's own vocabulary ----
function placeCue(plan, person, cue) {
  const clips = [...plan.clips].sort((a, b) => a.clip - b.clip);
  const re = CUES[cue.category];
  const hits = [];
  for (const clip of clips) for (const s of clip.shots) {
    const w = words(`${s.subject} ${s.action} ${s.dialogue?.line ? '' : ''}`), beat = words(clip.beat);
    const has = w.some((x) => x === cue.word || (re && re.test(x))) || beat.some((x) => x === cue.word);
    if (has) hits.push({ clip: clip.clip, shot: s.shot, named: w.some((x) => person.tokens.includes(x)) });
  }
  const pick = hits.find((h) => h.named) || hits[0];
  if (pick) return pick;
  const n = clips.length, i = Math.min(Math.max(0, n - 2), Math.floor(cue.share * n));
  return { clip: clips[i].clip, shot: clips[i].shots[clips[i].shots.length - 1].shot };
}
function fixAftermath(plan, story, note) {
  if (!story) return;
  for (const { person, cue } of aftermathMissing(plan, story)) {
    const tpl = TRACE_TEMPLATE[cue.category];
    if (!tpl) continue;
    let entity = plan.ledger.entities.find((e) => ['character', 'creature'].includes(e.kind) && [...entityWords(e)].some((w) => person.tokens.includes(w)));
    if (!entity) {
      let id = slugOf(person.name) || 'person';
      while (plan.ledger.entities.some((e) => e.id === id)) id += '_x';
      entity = { id, name: person.name, kind: 'character', clip_ids: plan.clips.filter((c) => (c.end_state?.characters || []).some((x) => tokensOf(x.name, 3).some((t) => person.tokens.includes(t)))).map((c) => c.clip), axes: [], initial: [] };
      plan.ledger.entities.push(entity);
    }
    let name = traceAxisName(cue.category);
    while (entity.axes.some((a) => a.axis === name)) name += '_trace';
    const at = placeCue(plan, person, cue);
    const ctx = { entity, axis: { axis: name } };
    if (visibleOptionIssue(tpl.later, ctx)) continue;
    entity.axes.push({ axis: name, options: [tpl.opening, tpl.later], progressive: false, plate_visible: false, visible_trace: true });
    entity.initial.push({ axis: name, value: tpl.opening });
    const clip = plan.clips.find((c) => c.clip === at.clip);
    clip.state_changes.push({ entity: entity.id, axis: name, to: tpl.later, shot: at.shot });
    if (!entity.clip_ids.includes(clip.clip)) entity.clip_ids = [...entity.clip_ids, clip.clip].sort((a, b) => a - b);
    note('axis_added', { entity: entity.id, axis: name, trace: cue.category, clip: clip.clip, shot: at.shot, cue: cue.word });
  }
}

// ---- 6. the folded ledger is the authority on the end_state ----
const personOf = (es, entity) => {
  const mine = new Set([...tokensOf(entity.name, 3), ...tokensOf(humanId(entity.id), 3)]);
  return (es.characters || []).find((c) => tokensOf(c.name, 3).some((t) => mine.has(t)));
};
function writeValue(plan, clip, entity, value, other) {
  const es = clip.end_state;
  if (!es) return false;
  const text = lc(value);
  let host = es;
  let keys = ['location', 'end_action'];
  if (entity.kind === 'character' || entity.kind === 'creature') {
    let c = personOf(es, entity);
    if (!c) { c = { name: entity.name, position: '', wardrobe: 'as on the reference', props: 'none', state: '' }; es.characters = [...(es.characters || []), c]; }
    host = c; keys = ['state', 'wardrobe', 'props', 'position'];
  }
  if (other) {
    const re = new RegExp(lc(other).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    for (const k of keys) if (re.test(host[k] || '')) { host[k] = host[k].replace(re, () => text); return 'rewritten'; }
    const key = keys[0], unitsOf = (t) => String(t || '').split(/\s*;\s*/).filter(Boolean);
    const os = new Set(contentStems(other));
    const kept = unitsOf(host[key]).filter((u) => { const us = contentStems(u); return !(us.length && us.filter((x) => os.has(x)).length / us.length >= 0.6); });
    host[key] = [...kept, text].join('; ');
    return 'rewritten';
  }
  const key = keys[0];
  host[key] = host[key] && norm(host[key]) !== 'none' ? `${String(host[key]).replace(/[.\s]+$/, '')}; ${text}` : text;
  return 'added';
}
function syncEndStates(plan, note) {
  for (let pass = 0; pass < 6; pass++) {
    const f = foldState(plan);
    if (!f.conflicts.length) return;
    let wrote = false;
    for (const c of f.conflicts) {
      const e = plan.ledger.entities.find((x) => x.id === c.entity), clip = plan.clips.find((x) => x.clip === c.clip);
      if (!e || !clip) continue;
      const value = c.kind === 'change_not_in_end_state' ? c.value : c.carriedValue;
      const how = writeValue(plan, clip, e, value, c.kind === 'end_state_names_other' ? c.endState : null);
      if (how) { wrote = true; note(how === 'added' ? 'end_state_added' : 'end_state_rewritten', { clip: clip.clip, entity: e.id, axis: c.axis, value }); }
    }
    if (!wrote) return;
  }
}

// ---- 7. a shot too short for its line: the clip's seconds are shared out again ----
export function fitSeconds(plan, seconds, note) {
  for (const clip of plan.clips) {
    const orig = clip.shots.map((s) => s.seconds);
    const need = clip.shots.map((s) => (s.dialogue?.line ? Math.max(secondsNeeded(s.dialogue.line), MIN_SHOT_SECONDS) : MIN_SHOT_SECONDS));
    const over = clip.shots.some((s) => s.dialogue?.line && s.seconds > 0 && wordCount(s.dialogue.line) / s.seconds > DIALOGUE_WORDS_PER_SECOND_MAX);
    const sum = orig.reduce((a, x) => a + x, 0);
    if (!over && Math.abs(sum - seconds) <= SECONDS_TOLERANCE) continue;
    if (need.reduce((a, x) => a + x, 0) > seconds + 1e-9) continue;
    const next = orig.map((x, i) => Math.max(x, need[i]));
    let excess = next.reduce((a, x) => a + x, 0) - seconds;
    let guard = 0;
    while (Math.abs(excess) > 1e-9 && guard++ < 400) {
      if (excess > 0) {
        const donors = next.map((x, i) => ({ i, slack: x - need[i] })).filter((d) => d.slack > 1e-9).sort((a, b) => b.slack - a.slack || a.i - b.i);
        if (!donors.length) break;
        const take = Math.min(0.5, donors[0].slack, excess);
        next[donors[0].i] -= take; excess -= take;
      } else {
        const order = next.map((x, i) => ({ i, x, d: clip.shots[i].dialogue?.line ? 1 : 0 })).sort((a, b) => a.d - b.d || a.x - b.x || a.i - b.i);
        const add = Math.min(0.5, -excess);
        next[order[0].i] += add; excess += add;
      }
    }
    if (Math.abs(excess) > SECONDS_TOLERANCE) continue;
    if (next.every((x, i) => x === orig[i])) continue;
    clip.shots.forEach((s, i) => { s.seconds = next[i]; });
    note('shot_seconds', { clip: clip.clip, from: orig, to: next });
  }
}

// ---- all of it ----
export function applyPlanFixes(plan, { story = null, seconds = CLIP_SECONDS } = {}) {
  const fixes = [];
  const note = (kind, detail) => fixes.push({ kind, ...detail });
  fixCameras(plan, note);
  fixStateChanges(plan, note);
  fixOptions(plan, note);
  fixProgressive(plan, note);
  fixAftermath(plan, story, note);
  fixOptions(plan, note);
  syncEndStates(plan, note);
  fitSeconds(plan, seconds, note);
  return { fixes, warnings: fixes.filter((f) => f.warning).map((f) => f.warning) };
}

export const countByKind = (fixes) => (fixes || []).reduce((a, f) => { a[f.kind] = (a[f.kind] || 0) + 1; return a; }, {});
