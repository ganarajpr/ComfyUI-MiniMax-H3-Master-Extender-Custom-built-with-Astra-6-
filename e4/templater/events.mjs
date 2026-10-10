// Event extraction. A shot is a small sequence of things that happen: the
// acting clauses, the micro-action, any further clauses of whatItShows, each
// ledger line. This module lists them (cleaned, de-duplicated, still carrying
// character NAMES, not tokens) so that order.mjs can ask Jev for their order and
// render.mjs can write them in that order.

import { REGIONS } from './vocab.mjs';
import { cleanFragments, contained, sharesNgram, lowerFirst, wordCount } from './clean.mjs';

const MAX_EVENTS = 6;

export function cleanFor(shot, text) {
  return cleanFragments(text, { allowVocal: shot.lines.length > 0, names: [] });
}

// Drops a clause already said, and any comma-separated tail already said.
function makeTake(said) {
  return (text) => {
    if (!text || said.some((t) => contained(text, t) >= 0.6)) return null;
    const parts = text.split(/,\s+/);
    const kept = parts.filter((p, i) => i === 0 || p.split(' ').length < 3 || said.every((t) => contained(p, t) < 0.8));
    const out = kept.join(', ');
    said.push(out);
    return out;
  };
}

// Actions a framing cannot show: legs and turns in anything tighter than a medium; head,
// face and eyes in an object insert.
const NOT_VISIBLE_TIGHT = /\b(?:stands?|stand up|walks?|steps?|turns? (?:back|away|around)|spins?|strides?)\b/i;
const FACE_PARTS = /\b(?:head|face|eyes?|lips|jaw|mouth)\b/i;
export function visibleAt(size, text) {
  if (!size || size === 'wide' || size === 'medium') return true;
  if (NOT_VISIBLE_TIGHT.test(text)) return false;
  if (size === 'insert' && FACE_PARTS.test(text) && !REGIONS.hands.test(text)) return false;
  return true;
}

const REPORT_START = /\b(?:the|his|her)?\s*(?:own\s+)?(?:voice|static|whisper|narrator|speaker|radio|broadcast|tape|recording)\s+(?:narrates?|whispers?|reads|recites?|carries the line)\b/i;

// "the voice narrates the climb as the rung beneath his boot locks into place" ->
// "the rung beneath his boot locks into place, and the voice narrates the climb with it":
// the visible event first, the sound arriving on it.
const ANCHOR_AS = /^(?:the |his |her )?(?:own )?(voice|static|whisper|speaker|radio|narrator)\s+(narrates?|whispers?)\s+(.+?)\s+(?:as|while)\s+(.+)$/i;
export function restructureAnchor(text) {
  const m = ANCHOR_AS.exec(text);
  if (!m) return text;
  const event = m[4];
  if (event.split(' ').length < 4 || !/\b(?:\w+(?:s|ed)|hit|lock|find|fall|rise|open|close|sit|stand|come|go)\b/i.test(event.split(' ').slice(1).join(' '))) return text;
  return `${event}, and the ${m[1]} ${m[2]} ${m[3]} with it`;
}

export function buildEvents(film, shot, chars, size = null, opts = {}) {
  const d = shot.direction;
  const hasLines = shot.lines.length > 0;
  const take = makeTake([]);
  const events = [];
  let n = 0;
  const add = (ev) => events.push({ id: `e${++n}`, ...ev });

  for (const c of chars) {
    for (const f of cleanFor(shot, c.act.behaviours)) {
      const t = take(f);
      if (t) add({ kind: 'beh', text: t, charId: c.id });
    }
  }
  const primary = chars[0];
  for (const f of cleanFor(shot, d.microAction)) {
    const t = take(f);
    if (t) add({ kind: 'micro', text: t, charId: primary && primary.id });
  }

  // whatItShows: the first clause opens the shot unless the acting clauses already say it.
  const evText = events.map((e) => e.text).join(' ');
  const showsAll = cleanFor(shot, d.whatItShows);
  let opening = null;
  showsAll.forEach((f, i) => {
    if (contained(f, evText) >= 0.8 || sharesNgram(f, evText, 4)) return;
    const t = take(f);
    if (!t) return;
    if (i === 0) opening = t;
    else add({ kind: 'show', text: t, charId: primary && primary.id });
  });

  const snd = cleanFragments(d.soundAnchor, { allowVocal: hasLines, names: [], keepNarration: !!opts.restructure }).map((t) => (opts.restructure ? restructureAnchor(t) : t));
  if (snd.length) add({ kind: 'sound', text: snd.join('; '), narrates: REPORT_START.test(snd.join('; ')) });
  for (const line of shot.lines) add({ kind: 'line', text: `the voice is heard saying "${line.text}"`, line });
  for (let i = events.length - 1; i >= 0; i--) {
    if (events[i].kind !== 'line' && events[i].kind !== 'sound' && !visibleAt(size, events[i].text)) {
      // an object insert cannot show the turn itself: the part that is in frame is pulled toward it
      const turn = opts.rewriteInvisible && size === 'insert' ? /\bturns? (?:back )?(?:toward|towards|to) the (\w+)/i.exec(events[i].text) : null;
      if (turn) events[i].text = `the wrist pulls toward the ${turn[1]} at the edge of the frame`;
      else events.splice(i, 1);
    }
  }

  // A "the voice narrates ..." clause inside a show event is the line's delivery, already written
  // once: strip it and keep what else the clause says.
  const REPORT_ONLY = /\b(?:the|his|her)?\s*(?:own\s+)?(?:voice|static|whisper|narrator|speaker|radio|broadcast|tape|recording)\s+(?:narrates?|whispers?|reads|recites?|carries the line)\b/gi;
  if (hasLines || events.some((x) => x.kind === 'sound')) {
    for (let i = events.length - 1; i >= 0; i--) {
      const e = events[i];
      if (e.kind !== 'show') continue;
      const rest = e.text.replace(REPORT_ONLY, '').replace(/^[\s,]*(?:and|as|then)?\s*/i, '').trim();
      if (wordCount(rest) <= 3) events.splice(i, 1);
      else e.text = rest;
    }
  }
  // Overlapping spec fields (whatItShows / behaviours / microAction / soundAnchor): each fact once.
  const kept = [];
  for (const e of events) {
    const dup = e.kind !== 'line' && kept.some((k) => k.kind !== 'line' && contained(e.text, k.text) >= 0.5);
    const dupAnchor = e.kind === 'sound' && kept.some((k) => k.anchor && contained(e.text, k.anchor) >= 0.5);
    if (!dup && !dupAnchor) kept.push(e);
  }
  events.splice(0, events.length, ...kept);
  if (opening && (!visibleAt(size, opening) || events.some((e) => e.kind !== 'line' && contained(opening, e.text) >= 0.6))) opening = null;
  // trim to the cap: shows first, then the last acting clause; a ledger line is never dropped
  while (events.length > MAX_EVENTS) {
    let i = events.findIndex((e) => e.kind === 'show');
    if (i === -1) for (let k = events.length - 1; k >= 0; k--) if (events[k].kind !== 'line' && events[k].kind !== 'sound') { i = k; break; }
    if (i === -1) break;
    events.splice(i, 1);
  }
  return { opening, events };
}

export const eventLabel = (e) => lowerFirst(e.text);
