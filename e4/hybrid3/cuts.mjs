// Cut structure, following the production shot_prose prompt: a bare [Shot 1], later cuts written "[Shot N] At MM:SS.mmm, ...",
// strictly increasing, none later than the duration. The format gates (timed cuts, increasing times, per-cut camera term, word floor
// scaled by the marker count, silent speech-free cut) are enforced by the production audit (auditShot); this module adds the part the
// audit cannot know: the cut plan that the shot's own spec licenses.

// Closed film-grammar class: a spec that describes its own coverage as one uninterrupted take.
const CONTINUOUS = /\b(?:continuous|single[- ]take|one[- ]take|unbroken|uncut|long take|oner|sustained take|without (?:a |any )?cuts?)\b/i;

const CUT_RE = /\[Shot\s+(\d+)\](?:\s+At\s+(\d{1,2}):(\d{2}(?:\.\d+)?))?/g;

export function segments(dd) {
  const text = String(dd || '');
  const marks = [...text.matchAll(CUT_RE)].map((m) => ({ n: Number(m[1]), at: m[2] !== undefined ? Number(m[2]) * 60 + Number(m[3]) : null, index: m.index }));
  return marks.map((m, i) => {
    const end = i + 1 < marks.length ? marks[i + 1].index : text.length;
    const start = i === 0 ? 0 : m.index;
    return { ...m, start, end, text: text.slice(start, end), hasDialogue: /<d>/.test(text.slice(start, end)) };
  });
}

// The cut plan the spec supports, or null when it supports none (the writer then follows the production prompt on its own).
//   - two characters in the shot and at least one ledger line, no continuous-take wording in the shot's own function / cameraAngle
//     -> two cuts (the production default for two-character dialogue); with exactly one licensed line the second cut is silent
//   - the shot's own function / cameraAngle asks for one continuous take -> a single bare [Shot 1]
export function derivePlan(shot) {
  const characters = (shot.references || []).filter((r) => r.type === 'character').length;
  const lines = (shot.lines || []).length;
  const own = `${shot.direction?.function || ''} ${shot.direction?.cameraAngle || ''}`;
  if (CONTINUOUS.test(own)) return { cuts: 1, why: 'continuous' };
  if (characters >= 2 && lines >= 1) return { cuts: 2, silentSecond: lines === 1, lines, why: 'two_character_dialogue' };
  return null;
}

// Findings against the plan. Only a shortfall (fewer cuts than planned) or an extra cut on a continuous plan is a finding:
// the production default allows more cuts than two.
export function planFindings(prose, plan) {
  if (!plan) return [];
  const segs = segments(prose.detailedDescription);
  if (plan.cuts === 1 && segs.length > 1) return [{ src: 'lint', code: 'cut_plan', field: 'detailedDescription', match: `${segs.length} cuts for a continuous take`, extra: true }];
  if (plan.cuts >= 2 && segs.length < plan.cuts) return [{ src: 'lint', code: 'cut_plan', field: 'detailedDescription', match: `${segs.length} cut for a planned ${plan.cuts}`, missing: plan.cuts - segs.length }];
  return [];
}

export const fmtTime = (s) => `${String(Math.floor(s / 60)).padStart(2, '0')}:${(s % 60).toFixed(3).padStart(6, '0')}`;
