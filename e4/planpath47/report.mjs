#!/usr/bin/env node
// Objective report of an E4 run, computed from the stored artifacts only (no model call).
//   node planpath43/report.mjs <outDir> [reportFile]      writes <outDir>/report.json (or reportFile; use it to measure a run of another version without touching its directory) and prints a table
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { runValidation, strictValidation } from './hybrid46/validate.mjs';
import { segments } from '../hybrid3/cuts.mjs';
import { rj, wr } from './lib.mjs';
import { CAMERA_MOVES } from './decide.mjs';
import { planContinuity, stagingOpening, stagingOpeningDetail, stagingVsPlan, proseContinuity, dialogueReport } from './checks.mjs';
import { planConformance } from './writer.mjs';
import { cutGeometry } from './clip.mjs';
import { speakerAttribution, voicesOf } from './speakers.mjs';

const count = (arr) => arr.reduce((a, x) => { if (x) a[x] = (a[x] || 0) + 1; return a; }, {});

// the reference-image prompts of the story: how many pass every check on the first draft and at the end, repairs applied
function refSummary(dir) {
  const f = join(dir, 'refs', 'refs.json');
  if (!existsSync(f)) return null;
  const r = JSON.parse(readFileSync(f, 'utf8'));
  const e = Object.entries(r.entities);
  const by = (t) => e.filter(([, x]) => x.type === t);
  return { mode: r.mode, rule: r.rule, clipCounts: r.clipCounts, skipped: r.skipped, entities: e.length, passFirstDraft: e.filter(([, x]) => !x.checks.firstDraft.length).length, passFinal: e.filter(([, x]) => x.checks.pass).length, repairCalls: e.filter(([, x]) => x.checks.repairCall).length, repairsApplied: e.filter(([, x]) => x.checks.repaired).length, failing: e.filter(([, x]) => !x.checks.pass).map(([id, x]) => ({ id, issues: x.checks.final })), plateWords: by('location').map(([id, x]) => ({ id, words: x.words, objects: x.namedObjectsInSlots })), sheetWords: by('character').map(([id, x]) => ({ id, words: x.words })) };
}

// E4.3 staging answers: how many position and holder questions were answered "stays" (the carried default) and how many named a change, plus the schema-constrained call share.
function stagingStats(decs, state) {
  const A = decs.flatMap((d) => Object.entries(d.answers || {}).filter(([k]) => /^c\d+\./.test(k)));
  const of = (re) => A.filter(([k]) => re.test(k)).map(([, v]) => v);
  const zone = of(/\.zone$/), held = of(/\.held_by$/), moves = of(/\.moves$/);
  const n = (a, f) => a.filter(f).length;
  const cuts = (decs.flatMap((d) => d.framing || [])).filter((f) => f.rules?.length);
  return {
    e43: decs.some((d) => d.answers), zoneQuestions: zone.length, zoneStays: n(zone, (v) => v === 'stays'), zoneNewPlace: n(zone, (v) => v !== 'stays' && v !== 'unstated'), zoneUnstated: n(zone, (v) => v === 'unstated'),
    holderQuestions: held.length, holderStays: n(held, (v) => v === 'stays'), holderChanges: n(held, (v) => v !== 'stays' && v !== 'unstated'),
    moves: moves.reduce((a, v) => { a[v.replace(/ .*/, '')] = (a[v.replace(/ .*/, '')] || 0) + 1; return a; }, {}),
    constrainedClips: `${decs.filter((d) => d.constrained).length}/${decs.length}`,
    cameraRuleCuts: cuts.map((f) => ({ cut: f.cut, planned: f.planned, final: f.final, rules: f.rules })),
  };
}

export function reportStory(outDir, name) {
  const dir = join(outDir, name);
  const { plan, planMeta } = rj(join(dir, 'plan.json'));
  const { bible } = rj(join(dir, 'bible.json'));
  const fixRaw = rj(join(dir, 'fix.json'));
  const shots = rj(join(dir, 'shots.json'));
  const fix = { ...fixRaw, granted: new Set(fixRaw.granted), film: { shots, masters: fixRaw.masters } };
  const state = rj(join(dir, '_state.json')).recs;
  const summary = rj(join(dir, '_summary.json'));
  const decs = state.map((s) => rj(join(dir, 'clips', `clip${String(s.clip).padStart(2, '0')}`, 'decisions.json')));
  const calls = readFileSync(join(outDir, 'calls.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((c) => c.story === name);
  const byKind = {}, costByKind = {};
  for (const c of calls) { byKind[c.kind] = (byKind[c.kind] || 0) + 1; costByKind[c.kind] = (costByKind[c.kind] || 0) + (c.cost || 0); }
  const clips = [...plan.clips].sort((a, b) => a.clip - b.clip);
  const proseByClip = {}, rows = [], attRows = [];
  for (const [i, clip] of clips.entries()) {
    const shot = shots[i];
    const f = join(dir, 'clips', `clip${String(clip.clip).padStart(2, '0')}`, 'final.prose.json');
    if (!existsSync(f)) { rows.push({ clip: clip.clip, present: false }); continue; }
    const prose = JSON.parse(readFileSync(f, 'utf8'));
    proseByClip[clip.clip] = prose.detailedDescription;
    attRows.push(...speakerAttribution({ plan, bible, shot, prose }));
    const refShot = fix.refs.shots.find((s) => s.id === shot.id);
    const gateFindings = strictValidation(fix, shot, prose).filter((f) => f.src === 'gate');
    const gate = { ok: !gateFindings.length, findings: gateFindings };
    const v = runValidation(fix, shot, prose);
    const by = count(v.findings.filter((x) => x.src !== 'gate').map((x) => x.code));
    const segs = segments(prose.detailedDescription);
    const motions = segs.map((s) => CAMERA_MOVES.find((m) => new RegExp(`\\b${m}\\b`, 'i').test(s.text)) || null);
    rows.push({ clip: clip.clip, present: true, gateOk: gate.ok, gateCodes: gate.findings.map((x) => x.code), v3: by, v3Total: Object.values(by).reduce((a, b) => a + b, 0), words: String(prose.detailedDescription).split(/\s+/).filter(Boolean).length, markers: segs.length, plannedCuts: clip.shots.length, planConformance: planConformance(prose, cutGeometry(clip)), writtenMotions: motions, duration: prose.duration });
  }
  const ledgerLines = rj(join(dir, 'dialogue_ledger.json'));
  const refsByClip = Object.fromEntries(state.map((s) => [s.clip, s.refs]));
  const present = rows.filter((r) => r.present);
  const planned = clips.flatMap((c) => c.shots.map((s) => s.camera));
  const framingFinal = state.flatMap((s) => s.framing.map((f) => f.final)), framingPlanned = state.flatMap((s) => s.framing.map((f) => f.planned));
  const moveDecided = decs.flatMap((d) => Object.entries(d.picks).filter(([k]) => /^move\.\d+$/.test(k)).map(([, v]) => v));
  const written = present.flatMap((r) => r.writtenMotions);
  const dlg = dialogueReport(ledgerLines, proseByClip);
  const sumSecs = calls.reduce((a, c) => a + (c.secs || 0), 0);
  const consecutiveSame = (arr, sizes) => { let n = 0, at = 0; for (const sz of sizes) { for (let i = 1; i < sz; i++) if (arr[at + i] && arr[at + i] === arr[at + i - 1]) n++; at += sz; } return n; };
  const sizes = clips.map((c) => c.shots.length);
  const out = {
    story: name, clips: clips.length, plannedShots: planned.length,
    calls: { byKind, planner: byKind.planner || 0, plannerRetries: calls.filter((c) => c.name === 'plan.retry').length, bible: byKind.bible || 0, bibleRetries: calls.filter((c) => c.name === 'bible.retry').length, decisions: byKind.decision || 0, decisionRetries: calls.filter((c) => c.name === 'decide.retry').length, writers: byKind.writer || 0, repairs: byKind.repair || 0, refRepairs: byKind.refrepair || 0, refWriters: byKind.refwriter || 0, total: calls.length },
    decisionQuestions: state.reduce((a, s) => a + s.questions, 0), decisionInvalid: state.reduce((a, s) => a + s.invalid.length, 0),
    cost: { total: Number(calls.reduce((a, c) => a + (c.cost || 0), 0).toFixed(5)), byKind: Object.fromEntries(Object.entries(costByKind).map(([k, v]) => [k, Number(v.toFixed(5))])) },
    time: { wallSecs: summary.wallSecs, planBibleSecs: summary.planBibleSecs, decideSecs: summary.decideSecs, writeSecs: summary.writeSecs, sumCallSecs: Number(sumSecs.toFixed(1)) },
    gates: { pass: `${present.filter((r) => r.gateOk).length}/${present.length}`, codes: count(present.flatMap((r) => r.gateCodes)) },
    dialogue: { plannedLines: ledgerLines.length, unresolvedSpeakers: ledgerLines.filter((l) => !l.resolved).length, perClip: dlg, allVerbatimInOrder: dlg.every((d) => d.verbatimInOrder), reinserted: summary.perClip.reduce((a, r) => a + (r.linesReinserted || 0), 0) },
    speakerAttribution: { lines: attRows.length, ok: attRows.filter((r) => r.ok).length, voices: voicesOf(bible).map((v) => v.id), voiceLines: attRows.filter((r) => voicesOf(bible).some((v) => v.id === r.expected)).length, repairedClips: summary.perClip.filter((r) => r.attribution?.repaired).length, retaggedClips: summary.perClip.filter((r) => r.attribution?.retagged).length, rows: attRows },
    planPlanChecks: { remainingIssues: planMeta.issues.length, issues: planMeta.issues, attempts: planMeta.attempts.length },
    cutPlan: { exactMarkers: `${present.filter((r) => r.markers === r.plannedCuts).length}/${present.length}`, conformance: `${present.filter((r) => r.planConformance.ok).length}/${present.length}`, resampled: summary.perClip.filter((r) => r.resampled).length },
    continuity: { plan: planContinuity(plan, bible), stagingOpening: stagingOpening(state.map((s, i) => ({ clip: { clip: s.clip }, ledgerBefore: decs[i].ledgerBefore, picks: decs[i].picks }))), stagingOpeningDetail: stagingOpeningDetail(plan, bible, state, decs), stagingVsPlan: stagingVsPlan(plan, bible, state, decs), prose: proseContinuity(plan, bible, proseByClip, refsByClip) },
    camera: {
      plannerTerms: count(planned), finalFraming: count(framingFinal), framingChanged: `${framingFinal.filter((f, i) => f !== framingPlanned[i]).length}/${framingFinal.length}`,
      motionDecided: count(moveDecided), motionWritten: count(written), staticShareDecided: moveDecided.length ? Number((moveDecided.filter((m) => m === 'Static Shot').length / moveDecided.length).toFixed(2)) : null,
      adjacentRepeatsDecided: consecutiveSame(moveDecided, sizes), adjacentRepeatsPlanner: consecutiveSame(planned, sizes), distinctMotionDecided: new Set(moveDecided).size,
    },
    staging: stagingStats(decs, state),
    hybrid3: { findingsBeforeRepair: summary.perClip.reduce((a, r) => a + (r.before?.v2.total || 0), 0), byCodeBeforeRepair: summary.perClip.reduce((a, r) => { for (const [k, v] of Object.entries(r.before?.v2.byCode || {})) a[k] = (a[k] || 0) + v; return a; }, {}), findingsAfterDeterministic: summary.perClip.reduce((a, r) => a + (r.afterDeterministic?.v2.total || 0), 0), repairCallsHybrid3: summary.perClip.reduce((a, r) => a + (r.repairs || 0), 0), findingsAfterRepair: present.reduce((a, r) => a + r.v3Total, 0), byCode: present.reduce((a, r) => { for (const [k, v] of Object.entries(r.v3)) a[k] = (a[k] || 0) + v; return a; }, {}), cleanClips: `${present.filter((r) => r.v3Total === 0).length}/${present.length}` },
    film46: existsSync(join(dir, 'film_checks.json')) ? rj(join(dir, 'film_checks.json')) : null,
    refPrompts: refSummary(dir),
    refs: { forced: state.reduce((a, s) => a + s.forced.length, 0), dropped: state.reduce((a, s) => a + s.dropped.length, 0) },
    words: { mean: present.length ? Number((present.reduce((a, r) => a + r.words, 0) / present.length).toFixed(0)) : 0 },
    clipsDetail: rows,
  };
  return out;
}

export function reportAll(outDir, outFile = join(outDir, 'report.json')) {
  const names = readdirSync(outDir).filter((d) => existsSync(join(outDir, d, '_summary.json'))).sort();
  const all = Object.fromEntries(names.map((n) => [n, reportStory(outDir, n)]));
  wr(outFile, all);
  return all;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const outDir = resolve(process.argv[2] || '');
  const all = reportAll(outDir, process.argv[3] ? resolve(process.argv[3]) : undefined);
  for (const [n, r] of Object.entries(all)) {
    console.log(`\n== ${n}: ${r.clips} clips, ${r.plannedShots} planned shots`);
    console.log(`calls ${JSON.stringify(r.calls.byKind)} (planner retries ${r.calls.plannerRetries}, bible retries ${r.calls.bibleRetries}, decision retries ${r.calls.decisionRetries}); decision questions ${r.decisionQuestions}, invalid ${r.decisionInvalid}`);
    console.log(`cost $${r.cost.total} ${JSON.stringify(r.cost.byKind)}; wall ${r.time.wallSecs.toFixed(0)}s (plan+bible ${r.time.planBibleSecs.toFixed(0)}s, decide ${r.time.decideSecs.toFixed(0)}s, write ${r.time.writeSecs.toFixed(0)}s)`);
    console.log(`speaker attribution ${r.speakerAttribution.ok}/${r.speakerAttribution.lines} lines match the plan (voices ${JSON.stringify(r.speakerAttribution.voices)}, voice lines ${r.speakerAttribution.voiceLines}, repaired clips ${r.speakerAttribution.repairedClips}, retagged ${r.speakerAttribution.retaggedClips})`);
    if (r.film46) console.log(`E4.6 speaker ids ${r.film46.speakerIds.ok ? 'ok' : r.film46.speakerIds.issues.join(' | ')} ${JSON.stringify(r.film46.speakers)}; sequence ${r.film46.sequence.ok ? 'ok' : r.film46.sequence.issues.join(' | ')}; per clip off-screen framing ${Object.values(r.film46.clips).filter((c) => c.offscreenFraming.ok).length}/${Object.keys(r.film46.clips).length}, sound words clean ${Object.values(r.film46.clips).filter((c) => c.soundVocab.ok).length}, speech without a line clean ${Object.values(r.film46.clips).filter((c) => c.speechWithoutLine.ok).length}, voice form ok ${Object.values(r.film46.clips).filter((c) => c.voiceForm.ok).length}`);
    console.log(`gates ${r.gates.pass} ${JSON.stringify(r.gates.codes)}; dialogue verbatim in order ${r.dialogue.allVerbatimInOrder} (${r.dialogue.plannedLines} lines, ${r.dialogue.reinserted} reinserted); cut plan markers ${r.cutPlan.exactMarkers}, conformance ${r.cutPlan.conformance}`);
    console.log(`hybrid3 findings first draft ${r.hybrid3.findingsBeforeRepair} ${JSON.stringify(r.hybrid3.byCodeBeforeRepair)} -> after code ${r.hybrid3.findingsAfterDeterministic} -> after repair ${r.hybrid3.findingsAfterRepair} ${JSON.stringify(r.hybrid3.byCode)} clean ${r.hybrid3.cleanClips}`);
    console.log(`camera planner ${JSON.stringify(r.camera.plannerTerms)}; final framing changed ${r.camera.framingChanged}; motion decided ${JSON.stringify(r.camera.motionDecided)}; static share ${r.camera.staticShareDecided}; adjacent repeats ${r.camera.adjacentRepeatsDecided}`);
    console.log(`continuity plan issues ${r.continuity.plan.reduce((a, x) => a + x.issues.length, 0)}; staging opening mismatches ${r.continuity.stagingOpening.reduce((a, x) => a + x.mismatched, 0)}/${r.continuity.stagingOpening.reduce((a, x) => a + x.checked, 0)}; staging vs plan end state ${r.continuity.stagingVsPlan.reduce((a, x) => a + x.mismatched, 0)}/${r.continuity.stagingVsPlan.reduce((a, x) => a + x.checked, 0)}`);
  }
}
