// Deterministic-first validation / repair / finish for one drafted shot. v3: cuts are legitimate (production cut rules), so there is no marker strip.
import { join } from 'node:path';
import { wr } from '../../hybrid3/lib.mjs';
import { applyRules } from './deterministic.mjs';
import { finishShot } from './finish2.mjs';
import { runValidation, mapFindings } from './validate.mjs';
import { repairOnce } from './repair.mjs';

export const count = (fs) => fs.reduce((a, f) => { a[f.code] = (a[f.code] || 0) + 1; return a; }, {});
export const summarize = (fs) => ({ total: fs.length, lint: fs.filter((f) => f.src === 'lint').length, gate: fs.filter((f) => f.src === 'gate' && f.code !== 'DETAILED_DESCRIPTION_TOO_SHORT').length, byCode: count(fs) });
const tally = (edits) => edits.reduce((a, e) => { a[e.rule] = (a[e.rule] || 0) + 1; return a; }, {});

// One deterministic stage: ledger finish first, then the word-level rules, then the finish again (rules may move text into the 400-char speaker window).
export function deterministicStage(fix, shot, prose) {
  const fin1 = finishShot(fix, shot, prose);
  const rules = applyRules(fin1.prose);
  const fin2 = finishShot(fix, shot, rules.prose);
  return { prose: fin2.prose, finish: [...fin1.log, ...fin2.log.filter((l) => !fin1.log.some((x) => JSON.stringify(x) === JSON.stringify(l)))], edits: rules.edits, declined: rules.declined };
}

export async function processDraft({ fix, shot, sceneId, facts, raw, dir, maxRounds = 2, budget }) {
  const rec = { shotId: shot.id, cost: 0, repairs: 0, rejected: 0, rounds: [], finish: [], edits: [], declined: [] };
  const note = (c, name) => { rec.cost += c.cost; budget.spent += c.cost; wr(join(dir, `${name}.request.json`), c.body); wr(join(dir, `${name}.response.raw.txt`), c.raw || c.error || ''); wr(join(dir, `${name}.meta.json`), { usage: c.usage, cost: c.cost, finish: c.finish, secs: c.secs, status: c.status, attempt: c.attempt }); };
  let prose = JSON.parse(JSON.stringify(raw));
  const v0 = runValidation(fix, shot, prose);
  rec.before = { strict: summarize(v0.strict), v2: summarize(v0.findings) };
  wr(join(dir, 'round0.findings.json'), v0);
  let lastNote = '';
  for (let round = 0; round <= maxRounds; round++) {
    const st = deterministicStage(fix, shot, prose);
    prose = st.prose;
    rec.finish.push(...st.finish); rec.edits.push(...st.edits); rec.declined.push(...st.declined);
    const v = runValidation(fix, shot, prose);
    if (round === 0) rec.afterDeterministic = { strict: summarize(v.strict), v2: summarize(v.findings) };
    const map = mapFindings(v.findings, prose, shot);
    if (!map.targets.length && !map.expand) break;
    if (round === maxRounds || budget.spent > budget.cap) { if (budget.spent > budget.cap) rec.capStop = true; break; }
    const rr = await repairOnce(prose, sceneId, map, facts, lastNote);
    note(rr.call, `round${round + 1}.repair`);
    rec.repairs += 1;
    const entry = { round: round + 1, targets: map.targets.map((t) => ({ field: t.field, idx: t.idx, rules: t.rules })), expand: !!map.expand, unmapped: map.unmapped.map((f) => f.code), accepted: rr.accepted, problems: rr.problems };
    wr(join(dir, `round${round + 1}.targets.json`), { targets: map.targets.map((t) => ({ ...t, sentence: (t.field === 'overallSoundscape' ? map.ss : t.field === 'summary' ? map.su : map.dd)[t.idx] })), unmapped: map.unmapped });
    if (rr.newProse) wr(join(dir, `round${round + 1}.proposed.json`), rr.newProse);
    if (rr.accepted) { prose = rr.newProse; lastNote = ''; } else {
      rec.rejected += 1;
      lastNote = `the previous attempt was REJECTED because it changed text outside the listed sentences (${rr.problems.slice(0, 3).join('; ')}). Rewrite only the listed sentences and copy everything else exactly.`;
    }
    rec.rounds.push(entry);
  }
  const st = deterministicStage(fix, shot, prose);
  prose = st.prose;
  rec.finish.push(...st.finish); rec.edits.push(...st.edits); rec.declined.push(...st.declined);
  const fin = runValidation(fix, shot, prose);
  rec.after = { strict: summarize(fin.strict), v2: summarize(fin.findings) };
  rec.editCounts = tally([...rec.edits, ...rec.finish]);
  wr(join(dir, 'final.findings.json'), fin);
  wr(join(dir, 'raw.prose.json'), raw);
  wr(join(dir, 'deterministic.edits.json'), { edits: rec.edits, finish: rec.finish, declined: rec.declined });
  return { rec, prose };
}

export function totals(results, extra = {}) {
  const sum = (f) => results.reduce((a, r) => a + (f(r) || 0), 0);
  const edits = {};
  for (const r of results) for (const [k, v] of Object.entries(r.editCounts || {})) edits[k] = (edits[k] || 0) + v;
  const declined = {};
  for (const r of results) for (const d of r.declined || []) declined[d.rule + ':' + d.reason] = (declined[d.rule + ':' + d.reason] || 0) + 1;
  return {
    shots: results.length, cost: Number(sum((r) => r.cost).toFixed(5)), repairCalls: sum((r) => r.repairs), rejectedRepairs: sum((r) => r.rejected),
    strictBefore: { total: sum((r) => r.before.strict.total), lint: sum((r) => r.before.strict.lint), gate: sum((r) => r.before.strict.gate) },
    v2Before: { total: sum((r) => r.before.v2.total), lint: sum((r) => r.before.v2.lint), gate: sum((r) => r.before.v2.gate) },
    v2AfterDeterministic: { total: sum((r) => r.afterDeterministic.v2.total), lint: sum((r) => r.afterDeterministic.v2.lint), gate: sum((r) => r.afterDeterministic.v2.gate) },
    strictAfter: { total: sum((r) => r.after.strict.total), lint: sum((r) => r.after.strict.lint), gate: sum((r) => r.after.strict.gate) },
    v2After: { total: sum((r) => r.after.v2.total), lint: sum((r) => r.after.v2.lint), gate: sum((r) => r.after.v2.gate) },
    deterministicEdits: edits, declined, ...extra,
  };
}
