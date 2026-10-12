// Code checks of E4 that need no model: ledger continuity across clips (plan level, decision level, prose level) and dialogue licensing.
import { tokensOf } from './lib.mjs';
import { mentions, shotText, withSurfaces } from './clip.mjs';
import { dialogueTags } from './writer.mjs';
import { foldState } from './state.mjs';

const GENERIC = new Set('the and with from that this into onto over under after before while where when then than they them their there here have has had been were was are his her its our out off who whom will would could should about above each other some such only just also very more most one two not but nor yet'.split(' '));
const content = (s) => new Set(tokensOf(s, 3).filter((w) => !GENERIC.has(w)));
const jaccard = (a, b) => { const A = content(a), B = content(b); if (!A.size && !B.size) return 1; let n = 0; for (const w of A) if (B.has(w)) n++; return n / (A.size + B.size - n); };
const NONE = /^\s*(none|n\/a|nothing|-)?\s*\.?\s*$/i;
const SAME = /^\s*as on the reference\.?\s*$/i;
// Time or place cut vocabulary: the beat itself may name a jump (the planner's continuity rule allows exactly that).
const JUMP = /\b(later|earlier|next (?:day|morning|night|evening)|cut to|hours?|minutes?|days?|weeks?|morning|dawn|dusk|meanwhile|flashback|elsewhere|following|afterwards?|that night|the next)\b/i;
const nameKey = (n) => tokensOf(n, 3).join(' ');

// The bible locations a place description names. Drift = both name some, and they share none (moving about inside one place is not drift).
const placesIn = (text, bible) => new Set((bible?.locations || []).filter((l) => mentions(text, { id: l.id, name: l.name })).map((l) => l.id));
export function placeDrift(a, b, bible) {
  const A = placesIn(a, bible), B = placesIn(b, bible);
  if (!A.size || !B.size) return false;
  for (const x of A) if (B.has(x)) return false;
  return true;
}

// clip N+1 opens where clip N ended: plan-level check over consecutive end_states
export function planContinuity(plan, bible) {
  const out = [];
  const clips = [...plan.clips].sort((a, b) => a.clip - b.clip);
  for (let i = 1; i < clips.length; i++) {
    const prev = clips[i - 1].end_state, cur = clips[i];
    const row = { clip: cur.clip, issues: [] };
    if (!prev || !cur.end_state) { row.issues.push('end_state_missing'); out.push(row); continue; }
    const jump = JUMP.test(cur.beat);
    if (prev.location && cur.end_state.location && !jump && placeDrift(prev.location, cur.end_state.location, bible)) row.issues.push(`location_drift: "${prev.location}" -> "${cur.end_state.location}"`);
    if (prev.time_light && cur.end_state.time_light && jaccard(prev.time_light, cur.end_state.time_light) < 0.15 && !jump) row.issues.push(`time_light_drift: "${prev.time_light}" -> "${cur.end_state.time_light}"`);
    for (const c of prev.characters) {
      const k = nameKey(c.name);
      const n = cur.end_state.characters.find((x) => nameKey(x.name) === k);
      if (!n) continue;
      const changed = cur.state_changes.some((ch) => plan.ledger.entities.some((e) => e.id === ch.entity && nameKey(e.name) === k));
      if (!SAME.test(c.wardrobe) && !SAME.test(n.wardrobe) && jaccard(c.wardrobe, n.wardrobe) < 0.5 && !changed) row.issues.push(`wardrobe_drift ${c.name}: "${c.wardrobe}" -> "${n.wardrobe}"`);
      if (!NONE.test(c.props) && !SAME.test(c.props)) {
        const lost = [...content(c.props)].filter((w) => !content(n.props).has(w));
        if (lost.length / Math.max(1, content(c.props).size) > 0.5 && !changed && !jump) row.issues.push(`props_dropped ${c.name}: "${c.props}" -> "${n.props}"`);
      }
    }
    out.push(row);
  }
  // E4.8: the plan's state_changes and the end_state of the same clip say the same (state.mjs foldState)
  for (const c of foldState(plan, bible).conflicts) {
    let row = out.find((r) => r.clip === c.clip);
    if (!row) { row = { clip: c.clip, issues: [] }; out.unshift(row); }
    row.issues.push(c.kind === 'change_not_in_end_state' ? `state_end_disagree ${c.entity}.${c.axis}: the clip's change sets "${c.value}" and its end_state does not show it` : `state_end_disagree ${c.entity}.${c.axis}: the ledger holds "${c.carriedValue}" and the end_state shows "${c.endState}"`);
  }
  return out;
}

// the first cut's OPENING state agrees with the ledger carried out of the previous clip. A prop that is lifted, passed or put down in the first cut opens with the holder it had before
// (picks `.from`), so the check compares what the cut opens with, not what it ends with.
export function stagingOpening(recs) {
  const rows = [];
  for (let i = 1; i < recs.length; i++) {
    const L = recs[i].ledgerBefore, picks = recs[i].picks;
    let checked = 0, mismatched = 0;
    for (const [id, v] of Object.entries(L.zone)) {
      const p = picks[`c1.${id}.zone`];
      if (!p || p === 'unstated') continue;
      checked += 1;
      if (p !== v) mismatched += 1;
    }
    for (const [id, v] of Object.entries(L.holder)) {
      const p = picks[`c1.${id}.held_by.from`] ?? picks[`c1.${id}.held_by`];
      if (!p || p === 'unstated') continue;
      checked += 1;
      if (p !== v) mismatched += 1;
    }
    rows.push({ clip: recs[i].clip.clip, checked, mismatched });
  }
  return rows;
}

// Which of those opening mismatches are justified by the plan: the first planned cut of the clip (or its beat) names the landmark the decided zone sits on, or names the new holder.
// An unjustified mismatch is a contradiction with the carried state that nothing in the plan asks for.
export function stagingOpeningDetail(plan, bible, state, decs) {
  const clips = [...plan.clips].sort((a, b) => a.clip - b.clip);
  const rows = [];
  for (let i = 1; i < clips.length; i++) {
    const L = decs[i].ledgerBefore, P = decs[i].picks;
    const first = content(`${clips[i].beat} ${shotText(clips[i].shots[0])}`);
    const lms = withSurfaces(bible.locations.filter((l) => (state[i].cand.locs || []).includes(l.id)), bible.props.filter((p) => (state[i].cand.props || []).includes(p.id)), bible).flatMap((l) => l.landmarks || []);
    const row = { clip: clips[i].clip, checked: 0, mismatched: 0, justified: 0, unjustified: 0 };
    for (const [id, v] of Object.entries(L.zone)) {
      const p = P[`c1.${id}.zone`];
      if (!p || p === 'unstated') continue;
      row.checked += 1;
      if (p === v) continue;
      row.mismatched += 1;
      const at = /^(?:on|near|[^()]*? side of) ([a-z0-9_]+)(?: \(|$)/.exec(p)?.[1];
      const lm = lms.find((l) => l.id === at);
      if (lm && [...lmWords(lm)].some((w) => first.has(w))) row.justified += 1; else row.unjustified += 1;
    }
    for (const [id, v] of Object.entries(L.holder)) {
      const p = P[`c1.${id}.held_by.from`] ?? P[`c1.${id}.held_by`];
      if (!p || p === 'unstated') continue;
      row.checked += 1;
      if (p === v) continue;
      row.mismatched += 1;
      const who = bible.cast.find((c) => c.id === p);
      if (who && mentions(`${clips[i].beat} ${shotText(clips[i].shots[0])}`, who)) row.justified += 1; else row.unjustified += 1;
    }
    rows.push(row);
  }
  return rows;
}

// Independent of the carried ledger: the first cut's decided position of a character against the PLANNER's own end_state of the clip before ("position": where in the set, facing which way).
// Checked only when that position text names a landmark of the clip's location (a landmark id word or a word of its gloss); the decided zone must then be on or near one of the landmarks named.
const lmWords = (l) => new Set([...tokensOf(String(l.id).replace(/_/g, ' '), 3), ...tokensOf(l.gloss, 4)].filter((w) => !GENERIC.has(w)));
export function stagingVsPlan(plan, bible, state, decs) {
  const clips = [...plan.clips].sort((a, b) => a.clip - b.clip);
  const rows = [];
  for (let i = 1; i < clips.length; i++) {
    const prev = clips[i - 1].end_state;
    const locs = withSurfaces(bible.locations.filter((l) => (state[i].cand.locs || []).includes(l.id)), bible.props.filter((p) => (state[i].cand.props || []).includes(p.id)), bible);
    const landmarks = locs.flatMap((l) => l.landmarks || []);
    let checked = 0, mismatched = 0;
    for (const c of prev?.characters || []) {
      const cast = bible.cast.find((x) => nameKey(x.name) === nameKey(c.name) || mentions(c.name, { id: x.id, name: x.name }));
      const zone = cast && decs[i].picks[`c1.${cast.id}.zone`];
      if (!zone || zone === 'unstated') continue;
      const text = content(c.position);
      const named = landmarks.filter((l) => [...lmWords(l)].some((w) => text.has(w)));
      if (!named.length) continue;
      checked += 1;
      const at = /^(?:on|near|[^()]*? side of) ([a-z0-9_]+)(?: \(|$)/.exec(zone)?.[1];
      if (!named.some((l) => l.id === at)) mismatched += 1;
    }
    rows.push({ clip: clips[i].clip, checked, mismatched });
  }
  return rows;
}

// Camera rule (code, no model). E4.2 asked the model whether each planned camera term fits; it never changed one (0 of 274 cuts). The one concrete rule that remains:
// a spoken line of an on-screen cast member is never in a framing from which H3 loses the face (a wide establishing or a top-down shot); the cut is raised to a medium.
// Advisory flags (no change): an over-the-shoulder cut that names fewer than two people; the same term in two consecutive cuts.
export const FACE_LOSING = ['wide_establishing', 'top_down_overhead'];
export function cameraRules(clip, lines, bible) {
  const castIds = new Set((bible?.cast || []).map((c) => c.id));
  const out = [];
  clip.shots.forEach((s, i) => {
    const cut = i + 1;
    const spoken = lines.filter((l) => l.clip === clip.clip && l.cut === cut && castIds.has(l.speaker));
    if (spoken.length && FACE_LOSING.includes(s.camera)) out.push({ cut, rule: 'line_in_face_losing_framing', from: s.camera, to: 'medium' });
    if (i && clip.shots[i - 1].camera === s.camera) out.push({ cut, rule: 'adjacent_repeat', from: s.camera, to: null });
  });
  return out;
}

// prose level: a character that is in clip N+1 keeps the wardrobe the plan's end_state of clip N gives (when it names one)
export function proseContinuity(plan, bible, proseByClip, refsByClip) {
  const rows = [];
  const clips = [...plan.clips].sort((a, b) => a.clip - b.clip);
  for (let i = 1; i < clips.length; i++) {
    const prev = clips[i - 1].end_state, text = proseByClip[clips[i].clip];
    if (!prev || !text) continue;
    for (const c of prev.characters) {
      const cast = bible.cast.find((x) => nameKey(x.name) === nameKey(c.name) || x.id === nameKey(c.name).replace(/ /g, '_'));
      if (!cast || !refsByClip[clips[i].clip]?.includes(cast.id) || SAME.test(c.wardrobe) || !c.wardrobe) continue;
      const want = content(c.wardrobe), have = content(text);
      let hit = 0; for (const w of want) if (have.has(w)) hit++;
      rows.push({ clip: clips[i].clip, character: cast.id, wardrobeCoverage: want.size ? hit / want.size : 1 });
    }
  }
  return rows;
}

// every planned line appears once, verbatim, in plan order, inside the clip that carries it
export function dialogueReport(lines, proseByClip) {
  const rows = [];
  const byClip = {};
  for (const l of lines) (byClip[l.clip] ??= []).push(l);
  for (const [clip, ls] of Object.entries(byClip)) {
    const tags = dialogueTags(proseByClip[clip] || '');
    const want = ls.map((l) => l.text.replace(/\s+/g, ' ').trim());
    rows.push({ clip: Number(clip), planned: want.length, written: tags.length, verbatimInOrder: JSON.stringify(want) === JSON.stringify(tags) });
  }
  return rows;
}
