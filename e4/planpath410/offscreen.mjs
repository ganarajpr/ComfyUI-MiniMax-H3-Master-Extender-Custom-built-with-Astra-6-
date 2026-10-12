// E4.6 (issue #8): H3 lip-syncs the visible face. A line whose speaker is not on screen in that cut is framed either (a) with no visible face (the source of
// the voice, the empty space) or (b) with every visible character's lips stated pressed shut, in positive words. This file decides the framing from the plan
// (code, no model), and checks the written cut.
import { namesCast, OFFSCREEN_MARK } from './speakers.mjs';

// The off-screen cuts of one clip. lines: the clip's ledger lines (with offscreen, sid, speaker, cut). A cut whose planned subject names no cast member can be framed with no face (mode no_face);
// otherwise the named characters are on screen and their lips are stated pressed shut (mode lips_shut).
export function offscreenCuts(clip, lines, bible) {
  const out = [];
  for (const [i, s] of clip.shots.entries()) {
    const here = lines.filter((l) => l.cut === i + 1 && l.offscreen);
    if (!here.length) continue;
    const speakers = new Set(here.map((l) => l.speaker));
    const visible = (bible?.cast || []).filter((c) => !speakers.has(c.id) && namesCast(s.subject || '', c)).map((c) => c.id);
    out.push({ cut: i + 1, lineIds: here.map((l) => l.id), sids: here.map((l) => l.sid), speakers: [...speakers], mode: visible.length ? 'lips_shut' : 'no_face', visible, source: String(s.subject || '').trim() });
  }
  return out;
}

export function cutSegments(dd) {
  const text = String(dd || '');
  const marks = [...text.matchAll(/\[Shot\s+(\d+)\]/g)].map((m) => ({ n: Number(m[1]), index: m.index }));
  return marks.map((m, i) => ({ n: m.n, start: m.index, end: i + 1 < marks.length ? marks[i + 1].index : text.length, text: text.slice(m.index, i + 1 < marks.length ? marks[i + 1].index : text.length) }));
}

// Lips stated shut: a mouth word near a closing word, in either order, in one sentence. Positive phrasing only.
const LIPS = /\b(?:lips?|mouth|jaw)\b[^.<]{0,60}\b(?:pressed|closed|shut|sealed|clamped|tight|together)\b|\b(?:pressed|closed|shut|sealed|clamped|tight)\b[^.<]{0,24}\b(?:lips?|mouth)\b/i;
const sentencesOf = (t) => String(t).replace(/<d>[\s\S]*?<\/d>/g, ' ').split(/(?<=[.!?])\s+/).filter(Boolean);

// -> one row per off-screen cut: the characters in the written cut and which of them have the lips clause.
export function offscreenFramingRows({ shot, prose }) {
  const segs = cutSegments(prose.detailedDescription);
  const charAt = (k) => (shot.references[k - 1]?.type === 'character' ? shot.references[k - 1].id : null);
  return (shot.offscreen || []).map((c) => {
    const seg = segs.find((s) => s.n === c.cut);
    const body = seg ? seg.text : '';
    const sents = sentencesOf(body);
    const shown = new Map();
    for (const s of sents) for (const m of s.matchAll(/<Subject (\d+)>/g)) { const id = charAt(Number(m[1])); if (id && !c.speakers.includes(id)) shown.set(id, [...(shown.get(id) || []), s]); }
    const lipsClause = sents.filter((s) => LIPS.test(s));
    const unsealed = [...shown.keys()].filter((id) => {
      const own = lipsClause.some((s) => shown.get(id).includes(s) || new RegExp(`<Subject ${shot.references.findIndex((r) => r.id === id) + 1}>`).test(s));
      return !(own || (shown.size === 1 && lipsClause.length > 0));
    });
    const problems = [];
    if (!seg) problems.push(`[Shot ${c.cut}] is not in the prompt`);
    for (const id of unsealed) problems.push(`${id} is on screen in [Shot ${c.cut}] where ${c.sids.join(', ')} is spoken off-screen, and no sentence states ${id}'s lips pressed shut`);
    return { cut: c.cut, sids: c.sids, mode: c.mode, source: c.source, visible: [...shown.keys()], lipsShut: [...shown.keys()].filter((id) => !unsealed.includes(id)), ok: !problems.length, problems };
  });
}

// Findings in the validator's shape; idx is the first sentence of the cut that shows a character whose lips are not stated shut.
export function offscreenFindings({ shot, prose, sents }) {
  const dd = String(prose.detailedDescription || '');
  const rows = offscreenFramingRows({ shot, prose });
  const spans = [];
  let at = 0;
  for (const s of sents) { const i = dd.indexOf(s, at); spans.push({ start: i < 0 ? at : i }); at = (i < 0 ? at : i) + s.length; }
  const out = [];
  for (const r of rows.filter((x) => !x.ok)) {
    const seg = cutSegments(dd).find((x) => x.n === r.cut);
    const idx = seg ? sents.findIndex((s, i) => spans[i].start >= seg.start && spans[i].start < seg.end && /<Subject \d+>/.test(s) && !/<d>/.test(s)) : -1;
    out.push({ src: 'lint', code: 'offscreen_framing', field: 'detailedDescription', idx: idx >= 0 ? idx : sents.findIndex((s, i) => seg && spans[i].start >= seg.start), match: `[Shot ${r.cut}]`, message: `${r.problems.join('; ')}. ${r.mode === 'no_face' ? `The plan frames this cut on ${r.source}: show only that place, with no character's face` : "State the character's lips pressed shut in the sentence about them"}` });
  }
  return out;
}

export { OFFSCREEN_MARK };
