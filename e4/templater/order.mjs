// Event ORDER as a decision.
//
// For every pair of events in a shot, Jev answers a noul question ("in this
// shot, does A happen before B?") read off the shot's own spec text. The
// answers are ranked Copeland-style into one sequence. Separately, explicit
// textual cues are extracted from the spec ("... before his thumb reaches the
// crown", "a beat after the voice names the motion", "before anything else
// happens"); where a cue and Jev disagree the cue wins (it is the literal
// text) and the disagreement is logged.

import { contained, contentWords } from './clean.mjs';

const SRC = '(?:voice|line|static|whisper\\w*|narrat\\w*|speaker)';
const AFTER_SRC = new RegExp(`\\b(?:after|behind|following)\\s+(?:the |his |her |its )?(?:own )?${SRC}`, 'i');
const SRC_BEFORE = new RegExp(`${SRC}\\b[^,;.]*?\\b(?:before|ahead of)\\b([^;.]*)`, 'i');
const SRC_AFTER = new RegExp(`${SRC}\\b[^,;.]*?\\b(?:after|behind)\\b([^;.]*)`, 'i');
const AS_SRC = new RegExp(`\\bas\\s+(?:his |the |her )?(?:own )?${SRC}`, 'i');
const REACT_RE = /\b(?:recogni[sz]es?|reali[sz]es?|reacts?|notices?)\b/i;
const FIRST_RE = /\bbefore anything else\b|\bbefore anything\b/i;

export function orderQuestions(events) {
  const q = {};
  for (let i = 0; i < events.length; i++) {
    for (let j = i + 1; j < events.length; j++) {
      q[`ord_${events[i].id}_${events[j].id}`] = {
        type: 'noul',
        instructions: `In this shot, does this happen BEFORE the next thing? First: "${events[i].text}". Next: "${events[j].text}".`,
      };
    }
  }
  return q;
}

// Copeland ranking of pairwise answers; ties keep the textual order.
export function orderFromAnswers(events, answers) {
  const wins = Object.fromEntries(events.map((e) => [e.id, 0]));
  const detail = {};
  for (let i = 0; i < events.length; i++) {
    for (let j = i + 1; j < events.length; j++) {
      const a = answers[`ord_${events[i].id}_${events[j].id}`];
      const p = a && typeof a.noul === 'number' ? a.noul : 0.5;
      detail[`${events[i].id}<${events[j].id}`] = p;
      if (p > 0.5) wins[events[i].id] += 1;
      else if (p < 0.5) wins[events[j].id] += 1;
      else wins[events[i].id] += 0.5, wins[events[j].id] += 0.5;
    }
  }
  const idx = new Map(events.map((e, i) => [e.id, i]));
  const ids = [...events].sort((a, b) => wins[b.id] - wins[a.id] || idx.get(a.id) - idx.get(b.id)).map((e) => e.id);
  return { ids, detail };
}

// Cues from the spec text. For each non-line event: +1 when the line should come
// BEFORE it, -1 when AFTER it. `first` marks events the spec says happen before
// anything else.
export function cueVotes(events, specText) {
  const clauses = String(specText).split(/[.;]/).map((c) => c.trim()).filter(Boolean);
  const votes = {};
  const first = new Set();
  // A narration tied to an event ("the voice narrates X as Y happens") puts the line after Y's event.
  const tieWords = new Set();
  for (const e of events) {
    const m = e.kind === 'sound' && e.narrates ? /\b(?:as|while)\s+(.+)$/i.exec(e.text) : null;
    if (m) for (const w of contentWords(m[1])) tieWords.add(w);
  }
  for (const e of events) {
    if (e.kind === 'line') continue;
    let v = 0;
    if (e.kind !== 'sound' && tieWords.size && [...contentWords(e.text)].some((w) => tieWords.has(w))) v -= 1;
    if (FIRST_RE.test(e.text) || clauses.some((c) => FIRST_RE.test(c) && contained(c, e.text) >= 0.5)) first.add(e.id);
    if (AFTER_SRC.test(e.text) || AS_SRC.test(e.text) || REACT_RE.test(e.text)) v += 1;
    for (const c of clauses) {
      const b = SRC_BEFORE.exec(c);
      if (b && contained(b[1], e.text) >= 0.5) v += 1;
      const a = SRC_AFTER.exec(c);
      if (a && !AFTER_SRC.test(e.text) && contained(a[1], e.text) >= 0.5) v -= 1;
    }
    votes[e.id] = Math.sign(v);
  }
  return { votes, first };
}

// Order used when Jev is not consulted: textual order, each line placed by its cues
// (after anything it must follow, else before anything it must precede, else last).
export function defaultOrder(events, cues) {
  const base = events.filter((e) => e.kind !== 'line').map((e) => e.id);
  const lines = events.filter((e) => e.kind === 'line').map((e) => e.id);
  let out = [...base];
  for (const l of lines) {
    const after = out.map((id, i) => (cues.votes[id] === -1 ? i : -1)).filter((i) => i >= 0);
    const before = out.map((id, i) => (cues.votes[id] === 1 ? i : -1)).filter((i) => i >= 0);
    let at = out.length;
    if (after.length) at = Math.max(...after) + 1;
    else if (before.length) at = Math.min(...before);
    out.splice(at, 0, l);
  }
  for (const id of cues.first) out = [id, ...out.filter((x) => x !== id)];
  return out;
}

// Applies cues to a Jev order. Returns { ids, disagreements }.
export function reconcile(shotId, events, jevIds, cues) {
  let ids = [...jevIds];
  const disagreements = [];
  const byId = new Map(events.map((e) => [e.id, e]));
  const lineIds = events.filter((e) => e.kind === 'line').map((e) => e.id);
  for (const l of lineIds) {
    const must = (sign) => ids.filter((id) => cues.votes[id] === sign);
    const li = ids.indexOf(l);
    const wrongBefore = must(1).filter((id) => ids.indexOf(id) < li);
    const wrongAfter = must(-1).filter((id) => ids.indexOf(id) > li);
    for (const id of wrongBefore) disagreements.push({ shot: shotId, event: byId.get(id).text, jev: 'event-before-line', cue: 'line-before-event', resolvedBy: 'cue' });
    for (const id of wrongAfter) disagreements.push({ shot: shotId, event: byId.get(id).text, jev: 'line-before-event', cue: 'event-before-line', resolvedBy: 'cue' });
    if (wrongBefore.length || wrongAfter.length) {
      const moved = new Set([...wrongBefore, ...wrongAfter]);
      const rest = ids.filter((id) => !moved.has(id));
      const at = rest.indexOf(l);
      ids = [...rest.slice(0, at), ...wrongAfter, l, ...wrongBefore, ...rest.slice(at + 1)];
    }
  }
  for (const id of cues.first) {
    if (ids[0] !== id) {
      disagreements.push({ shot: shotId, event: byId.get(id).text, jev: `position-${ids.indexOf(id)}`, cue: 'first', resolvedBy: 'cue' });
      ids = [id, ...ids.filter((x) => x !== id)];
    }
  }
  return { ids, disagreements };
}
