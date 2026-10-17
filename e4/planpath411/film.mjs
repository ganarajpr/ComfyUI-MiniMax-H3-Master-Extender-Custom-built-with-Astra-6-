// E4 for one story: story -> plan (LLM 1) -> bible (LLM 2) -> per-clip decisions + code ledger -> clip writer (LLM 3, + repair only when a check fails).
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { call, parseJsonReply, parseJsonLoose, wr, rj, SETTINGS, MODEL, exists, limiterStats, CONCURRENCY, cutNote } from './lib.mjs';
import { planStory, CAMERA_LABELS, parseBreakdown } from './planner.mjs';
import { planParallel, estimateClips, SINGLE_MAX_CLIPS } from './planparallel.mjs';
import { repairJson } from './jsonrepair.mjs';
import { makeBible, entityList } from './bible.mjs';
import { buildRefs } from './refs.mjs';
import { buildLedgerLines, candidates, cutGeometry, assembleReferences, makeShot, makeFix } from './clip.mjs';
import { decideFree, decideStaged, mergeDecision, emptyLedger, ledgerText, UNSTATED } from './decide.mjs';
import { resolveStaging } from './stage.mjs';
import { pruneLedger } from './stage.mjs';
import { cameraRules } from './checks.mjs';
import { factsFor, writerPrompt, shotId, ensureLines, planConformance } from './writer.mjs';
import { withFacts } from '../hybrid3/facts.mjs';
import { processDraft, deterministicStage, summarize } from './hybrid46/pipeline.mjs';
import { repairOnce } from './hybrid46/repair.mjs';
import { runValidation, mapFindings } from './hybrid46/validate.mjs';
import { enforceAttribution, speakerAttribution } from './speakers.mjs';
import { offscreenCuts } from './offscreen.mjs';
import { soundVocabFindings, dropItems } from './soundvocab.mjs';
import { filmChecks, clipChecks } from './filmchecks.mjs';
import { foldState, withCarriedState } from './state.mjs';
import { isRepairWorthy } from './postfix.mjs';
import { countByKind } from './fixes.mjs';

const pad = (n) => String(n).padStart(2, '0');

export const withLanguage = (story, language) => `${String(story).trim()}\n\nDIALOGUE LANGUAGE: ${language}. Every spoken line is written in ${language}.`;

export async function planAndBible({ name, story, outRoot, resume, language = 'English', refwriter = 'default', score = 'off', bindPictures = null }) {
  const dir = join(outRoot, name);
  let plan, planMeta, bible, bibleMeta;
  const pf = join(dir, 'plan.json');
  if (resume && existsSync(pf)) ({ plan, planMeta } = rj(pf));
  else {
    const chatFor = (stem) => async (messages, attempt) => {
      const c = await call({ outRoot, dir: join(dir, 'planner'), name: attempt ? `${stem}.retry` : stem, kind: 'planner', story: name, priority: 0, messages });
      const text = c.content;
      if (c.cut && stem === 'plan') return { text, cut: { note: cutNote(c.cut), max_tokens: c.cut.max_tokens } };
      if (stem === 'plan.skeleton' || parseBreakdown(text)) return text;
      const r = repairJson(text);
      return r.ok ? JSON.stringify(r.value) : text;
    };
    const mode = process.env.E4_PLAN_MODE || 'auto';
    const skeleton = mode === 'skeleton' || (mode === 'auto' && estimateClips(story) > SINGLE_MAX_CLIPS);
    const r = skeleton ? await planParallel(chatFor, story, { wrap: (t) => withLanguage(t, language) }) : await planStory(chatFor('plan'), withLanguage(story, language));
    plan = r.breakdown; planMeta = { issues: r.issues, warnings: r.warnings, fixes: r.fixes, kept: r.kept, attempts: r.attempts, rawAsks: r.rawAsks, ...(r.parallel ? { parallel: r.parallel } : {}) };
    wr(pf, { plan, planMeta });
  }
  const bf = join(dir, 'bible.json');
  if (resume && existsSync(bf) && rj(bf).bible && !rj(bf).bibleMeta?.issues?.length) ({ bible, bibleMeta } = rj(bf));
  else {
    const chat = async (messages, attempt) => {
      const c = await call({ outRoot, dir: join(dir, 'bible'), name: attempt ? 'bible.retry' : 'bible', kind: 'bible', story: name, priority: 0, messages });
      if (c.cut) return { ...parseJsonReply(c.content), cut: { note: cutNote(c.cut), max_tokens: c.cut.max_tokens } };
      return parseJsonLoose(c.content);
    };
    const r = await makeBible(chat, story, plan, planMeta.rawAsks, { score });
    bible = r.bible; bibleMeta = { issues: r.issues, warnings: r.warnings, fixes: r.fixes, attempts: r.attempts };
    wr(bf, { bible, bibleMeta });
    if (!bible || r.issues.length) throw new Error(`bible failed validation after retry: ${r.issues.slice(0, 5).join(' | ')}`);
  }
  if (bindPictures) { const refs = await bindPictures({ name, story, outRoot, bible, plan, planMeta }); wr(bf, { bible, bibleMeta }); return { plan, planMeta, bible, bibleMeta, refs }; }
  const rf = join(dir, 'refs', 'refs.json');
  const done = resume && existsSync(rf) && rj(rf).mode === refwriter && bible.cast.every((c) => c.imagePrompt);
  const refs = done ? rj(rf) : await buildRefs({ name, story, outRoot, bible, plan, planMeta, mode: refwriter });
  if (!done) wr(bf, { bible, bibleMeta });
  return { plan, planMeta, bible, bibleMeta, refs };
}

// E4.11: the decisions of the clips run in parallel. Part A of every clip (references, camera movement, tactic, effort, habit) is independent of the staging ledger and is asked for all clips at once;
// part B (staging) is a chain from clip to clip (each clip opens from the ledger the previous one left), asked at the front of the queue. `rec` of a clip is built as soon as its two parts are in.
const decisionFile = (cdir) => join(cdir, 'decisions.json');
function decFromDisk(cdir) {
  const f = decisionFile(cdir);
  if (!existsSync(f)) return null;
  const d = rj(f);
  return { picks: d.picks, answers: d.answers, invalid: d.invalid, constrained: d.constrained, changes: d.changes, calls: d.calls, questions: new Array(d.questions || 0).fill(null), ledgerIn: d.ledgerBefore, ledgerAfter: d.ledgerAfter, cost: d.calls.reduce((a, c) => a + c.cost, 0), secs: d.calls.reduce((a, c) => a + c.secs, 0) };
}

export function clipPlanning({ plan, bible, ledgerLines }) {
  const clips = [...plan.clips].sort((a, b) => a.clip - b.clip);
  let carried = null;
  return clips.map((clip) => {
    const cand = candidates(plan, bible, clip, carried);
    carried = { charIds: cand.chars.map((c) => c.id), locIds: cand.locs.map((c) => c.id) };
    return { clip, cand, landmarks: cand.locs.flatMap((l) => l.landmarks), geom: cutGeometry(clip), lines: ledgerLines.filter((l) => l.clip === clip.clip) };
  });
}

export function buildRec({ dir, plan, planMeta, bible, fold, i, base, dec, ledgerIn }) {
  const { clip, cand, landmarks, geom, lines } = base, rawAsk = planMeta.rawAsks[i];
  const cdir = join(dir, 'clips', `clip${pad(clip.clip)}`);
  const refPack = withCarriedState(assembleReferences(bible, cand, dec.picks, lines.map((l) => l.speaker)), fold.byClip[clip.clip] || [], fold.changesByClip[clip.clip] || []);
  const rules = cameraRules(clip, lines, bible);
  const framing = clip.shots.map((s, k) => { const planned = CAMERA_LABELS[s.camera]; const o = rules.find((r) => r.cut === k + 1 && r.to); const final = o ? CAMERA_LABELS[o.to] : planned; return { cut: k + 1, planned, final, changed: final !== planned, rules: rules.filter((r) => r.cut === k + 1).map((r) => r.rule) }; });
  const offscreen = offscreenCuts(clip, lines, bible);
  const locationId = refPack.references.find((r) => r.type === 'location')?.id || cand.locs[0].id;
  const rec = { clip, rawAsk, offscreen, geom, cand: { chars: cand.chars.map((c) => c.id), props: cand.props.map((c) => c.id), locs: cand.locs.map((c) => c.id) }, picks: dec.picks, answers: dec.answers, invalid: dec.invalid, constrained: dec.constrained, decisionCalls: dec.calls.length, decisionCost: dec.cost, decisionSecs: dec.secs, refPack, framing, ledgerBefore: ledgerIn, ledgerAfter: dec.ledgerAfter, locationId, questions: dec.questions.length };
  wr(decisionFile(cdir), { clip: clip.clip, offscreen, picks: dec.picks, answers: dec.answers, constrained: dec.constrained, changes: dec.changes, invalid: dec.invalid, calls: dec.calls, cand: rec.cand, refs: refPack.references.map((r) => r.id), forced: refPack.forced, dropped: refPack.dropped, framing, ledgerBefore: ledgerIn, ledgerAfter: dec.ledgerAfter, questions: dec.questions.length });
  return rec;
}

// -> one promise per clip that resolves to { rec, dec } once the clip's decisions are in (resumed clips load theirs from disk)
export function decideAll({ name, outRoot, plan, planMeta, bible, ledgerLines, resume = false, bases = null }) {
  const dir = join(outRoot, name);
  const fold = foldState(plan, bible);
  wr(join(dir, 'state_fold.json'), fold);
  const planning = bases || clipPlanning({ plan, bible, ledgerLines });
  let chain = Promise.resolve(emptyLedger());
  return planning.map((base, i) => {
    const { clip, cand, landmarks, geom, lines } = base, rawAsk = planMeta.rawAsks[i];
    const cdir = join(dir, 'clips', `clip${pad(clip.clip)}`);
    const stored = resume && existsSync(join(cdir, 'result.json')) ? decFromDisk(cdir) : null;
    if (stored) {
      chain = chain.then(() => stored.ledgerAfter);
      return Promise.resolve({ base, dec: stored, rec: buildRec({ dir, plan, planMeta, bible, fold, i, base, dec: stored, ledgerIn: stored.ledgerIn }), resumed: true });
    }
    const args = { outRoot, dir: cdir, story: name, plan, bible, clip, rawAsk, cand, landmarks, geom, lines };
    const free = decideFree(args);
    const staged = chain.then(async (ledger) => { const ledgerIn = pruneLedger(ledger, landmarks); return { ledgerIn, st: await decideStaged({ ...args, ledger: ledgerIn }) }; });
    chain = staged.then(({ ledgerIn, st }) => resolveStaging({ clipNumber: clip.clip, ledger: ledgerIn, questions: st.all, answers: st.answers, cutCount: clip.shots.length, landmarks }).ledgerAfter);
    return Promise.all([free, staged]).then(([f, { ledgerIn, st }]) => {
      const dec = mergeDecision({ clip, ledger: ledgerIn, landmarks, free: f, staged: st });
      return { base, dec, rec: buildRec({ dir, plan, planMeta, bible, fold, i, base, dec, ledgerIn }) };
    });
  });
}

async function writeClip({ name, outRoot, plan, bible, story, rawAsks, fix, shot, rec, budget }) {
  const cdir = join(outRoot, name, 'clips', `clip${pad(rec.clip.clip)}`);
  const facts = factsFor({ fix, shot, rec });
  const prompt = withFacts(writerPrompt({ fix, shot, rec, bible, plan, rawAsks, story, carriedText: ledgerText(rec.ledgerBefore) }), facts);
  wr(join(cdir, 'facts.txt'), facts); wr(join(cdir, 'writer.prompt.txt'), prompt);
  const calls = [];
  const gen1 = async (nm, kind, content) => {
    const c = await call({ outRoot, dir: cdir, name: nm, kind, story: name, clip: rec.clip.clip, messages: [{ role: 'user', content }], settings: SETTINGS });
    budget.spent += c.cost; calls.push({ name: nm, cost: c.cost, secs: c.secs });
    const p = parseJsonReply(c.content);
    const prose = p.ok ? (p.value.shots || [p.value]).find((s) => s.id === shot.id) || (p.value.shots || [p.value])[0] : null;
    return { c, prose };
  };
  let { c: gen, prose } = await gen1('round0.write', 'writer', prompt);
  if (!prose) ({ c: gen, prose } = await gen1('round0.write.resample', 'repair', prompt));
  if (!prose) return { rec: { clip: rec.clip.clip, shotId: shot.id, failed: `no parseable reply${gen?.cut ? ` (${cutNote(gen.cut)})` : ''}`, cost: calls.reduce((a, c) => a + c.cost, 0) } };
  prose = { ...prose, duration: rec.geom.duration };
  const masters = fix.film.masters;
  let ens = ensureLines(prose, shot, masters, fix);
  let conf = planConformance(ens.prose, rec.geom);
  let resampled = false;
  if (!conf.ok) {
    const complaint = `\n\nNOTE: a previous draft of this shot failed these plan checks: ${conf.issues.join('; ')}. Write exactly ${rec.geom.cuts.length} cuts, one [Shot N] marker per planned shot, at the cut times the facts give.`;
    const r2 = await gen1('plan.resample', 'repair', prompt + complaint);
    resampled = true;
    if (r2.prose) {
      const e2 = ensureLines({ ...r2.prose, duration: rec.geom.duration }, shot, masters, fix);
      const c2 = planConformance(e2.prose, rec.geom);
      if (c2.ok || c2.issues.length < conf.issues.length) { ens = e2; conf = c2; gen = r2.c; }
    }
  }
  const raw = ens.prose;
  const moves = Object.fromEntries(rec.clip.shots.map((_, i) => [i + 1, rec.picks[`move.${i + 1}`]]).filter(([, v]) => v && v !== UNSTATED));
  const res = await processDraft({ fix, shot, sceneId: fix.sceneId, facts, raw, dir: cdir, maxRounds: 2, budget, moves });
  let final = res.prose;
  const att = await enforceAttribution({ plan, bible, shot, prose: final, sceneId: fix.sceneId, facts, repair: repairOnce, mapFindings, budget });
  const { appendFileSync } = await import('node:fs');
  let attCost = 0;
  att.repairCalls.forEach((c, i) => {
    attCost += c.cost; budget.spent += c.cost;
    const nm = `attribution.repair${i + 1}`;
    wr(join(cdir, `${nm}.request.json`), c.body); wr(join(cdir, `${nm}.response.raw.txt`), c.raw || c.error || ''); wr(join(cdir, `${nm}.meta.json`), { usage: c.usage, cost: c.cost, finish: c.finish, secs: c.secs, status: c.status, attempt: c.attempt });
    appendFileSync(join(outRoot, 'calls.jsonl'), `${JSON.stringify({ kind: 'repair', story: name, clip: rec.clip.clip, name: 'attribution.repair', usage: c.usage, cost: c.cost, secs: c.secs })}\n`);
  });
  if (att.repaired || att.retagged.length) {
    final = deterministicStage(fix, shot, att.prose).prose;
    const fin = runValidation(fix, shot, final);
    res.rec.after = { strict: summarize(fin.strict), v2: summarize(fin.findings) };
  } else final = att.prose;
  // E4.6: last resort for the soundscape, after the repair rounds: a list item that still holds a music-like word is dropped (never when nothing would be left).
  const sweep = [];
  if (soundVocabFindings(final).some((f) => f.field === 'overallSoundscape')) { const d = dropItems(final.overallSoundscape); if (d.dropped.length) { sweep.push({ rule: 'soundscape_item_dropped', dropped: d.dropped }); final = { ...final, overallSoundscape: d.text }; } }
  const attAfter = speakerAttribution({ plan, bible, shot, prose: final });
  const attribution = { before: att.before, after: attAfter, repaired: att.repaired, retagged: att.retagged, repairCost: attCost };
  wr(join(cdir, 'attribution.json'), attribution);
  const finalFindings = runValidation(fix, shot, final).findings;
  const warnings = finalFindings.filter((f) => !isRepairWorthy(f, { lineTexts: shot.lines.map((l) => l.text) })).reduce((a, f) => { a[f.code] = (a[f.code] || 0) + 1; return a; }, {});
  const finalConf = planConformance(final, rec.geom);
  const repairCalls = [1, 2].map((i) => join(cdir, `round${i}.repair.meta.json`)).filter(existsSync).map((p) => rj(p));
  for (const m of repairCalls) appendFileSync(join(outRoot, 'calls.jsonl'), `${JSON.stringify({ kind: 'repair', story: name, clip: rec.clip.clip, name: 'hybrid3.repair', usage: m.usage, cost: m.cost, secs: m.secs })}\n`);
  const words = String(final.detailedDescription || '').split(/\s+/).filter(Boolean).length;
  wr(join(cdir, 'final.prose.json'), final);
  wr(join(cdir, 'checks46.json'), { ...clipChecks({ shot, prose: final, fix, attribution: attAfter }), sweep });
  wr(join(cdir, `e4__budget4096__${shot.id}.json`), { tag: `e4__budget4096__${shot.id}`, shotId: shot.id, clip: rec.clip.clip, condition: 'budget4096', modelRequested: MODEL, arm: 'E4', usage: gen?.usage || {}, content: JSON.stringify({ sceneId: fix.sceneId, shots: [final] }, null, 2), words, cost: res.rec.cost + attCost + calls.reduce((a, c) => a + c.cost, 0), attribution, hybrid: res.rec, linesReinserted: ens.log, planConformance: { first: conf, final: finalConf, resampled } });
  return { rec: { clip: rec.clip.clip, shotId: shot.id, words, cost: res.rec.cost + attCost + calls.reduce((a, c) => a + c.cost, 0), attribution: { ok: attAfter.every((r) => r.ok), repaired: att.repaired, retagged: att.retagged.length, repairCalls: att.repairCalls.length }, writeCost: calls.reduce((a, c) => a + c.cost, 0), writeSecs: calls.reduce((a, c) => a + c.secs, 0), repairs: res.rec.repairs, rejected: res.rec.rejected, resampled, warnings, editCounts: res.rec.editCounts, linesReinserted: ens.log.filter((l) => l.rule === 'line_reinserted').length, before: res.rec.before, afterDeterministic: res.rec.afterDeterministic, after: res.rec.after, planConformance: finalConf, hybrid: res.rec }, prose: final };
}

export async function runStory({ name, story, outRoot, budget, resume = false, workers = 4, language = 'English', refwriter = 'default', refsOnly = false, score = 'off', bindPictures = null }) {
  const t0 = Date.now(), at = () => Number(((Date.now() - t0) / 1000).toFixed(1));
  const dir = join(outRoot, name);
  wr(join(dir, 'story.txt'), story);
  const { plan, planMeta, bible, bibleMeta } = await planAndBible({ name, story, outRoot, resume, language, refwriter, score, bindPictures });
  if (score === 'on' && !bible.score) throw new Error('score on, but the bible has no score (a resumed bible from a score-off run)');
  if (refsOnly) return { plan, bible, planMeta, bibleMeta };
  const tPlan = at();
  const ledgerLines = buildLedgerLines(plan, bible);
  wr(join(dir, 'dialogue_ledger.json'), ledgerLines);
  const bases = clipPlanning({ plan, bible, ledgerLines });
  const n = bases.length;
  const recs = new Array(n), shots = new Array(n), results = new Array(n), timeline = new Array(n);
  // E4.11: a clip is written as soon as its own decisions are in; the clips never wait for each other beyond the staging chain of the decisions. Results are stored by clip index, never by finish order.
  const decisions = decideAll({ name, outRoot, plan, planMeta, bible, ledgerLines, resume, bases });
  const decideAt = new Array(n);
  await Promise.all(decisions.map((dp, i) => dp.then(async (d) => {
    decideAt[i] = at();
    const { rec } = d;
    recs[i] = rec;
    const shot = makeShot(i, shotId(rec.clip.clip), rec.refPack, bases[i].lines, rec.clip, rec.offscreen);
    shots[i] = shot;
    const cdir = join(dir, 'clips', `clip${pad(rec.clip.clip)}`);
    if (d.resumed && existsSync(join(cdir, 'result.json'))) results[i] = rj(join(cdir, 'result.json'));
    else if (budget.spent > budget.cap) results[i] = { rec: { clip: rec.clip.clip, failed: 'cap reached' } };
    else {
      const fixI = makeFix(bible, ledgerLines, [shot], [rec.refPack], { score });
      results[i] = await writeClip({ name, outRoot, plan, bible, story, rawAsks: planMeta.rawAsks, fix: fixI, shot, rec, budget });
      if (!results[i].rec.failed) wr(join(cdir, 'result.json'), results[i]);
    }
    timeline[i] = { clip: rec.clip.clip, decided: decideAt[i], done: at() };
    const r = results[i].rec;
    console.log(`${name} clip${pad(r.clip)} ${r.failed ? `FAILED ${r.failed}` : `words=${r.words} before=${r.before.v2.total} afterDet=${r.afterDeterministic.v2.total} after=${r.after.v2.total} repairs=${r.repairs} plan=${r.planConformance.ok ? 'ok' : r.planConformance.issues.join('/')} cost=${r.cost.toFixed(4)}`}`);
  })));
  const tDecide = Math.max(...decideAt);
  const fix = makeFix(bible, ledgerLines, shots, recs.map((r) => r.refPack), { score });
  wr(join(dir, 'fix.json'), { refs: fix.refs, split: fix.split, ledger: fix.ledger, continuity: fix.continuity, granted: [...fix.granted], masters: fix.film.masters, voices: fix.voices, score: fix.score, scoreText: fix.scoreText });
  wr(join(dir, 'shots.json'), shots);
  wr(join(dir, 'staging_ledger.json'), recs.map((r) => ({ clip: r.clip.clip, before: r.ledgerBefore, after: r.ledgerAfter })));
  wr(join(dir, 'film_checks.json'), filmChecks({ plan, bible, story, ledgerLines, shots, fix, proseByClip: Object.fromEntries(results.filter((r) => r.prose).map((r) => [r.rec.clip, r.prose])) }));
  const wall = at();
  const summary = { story: name, clips: n, wallSecs: wall, planBibleSecs: tPlan, decideSecs: tDecide - tPlan, writeSecs: wall - tDecide, concurrency: CONCURRENCY, limiter: limiterStats(), timeline, planIssues: planMeta.issues, planWarnings: planMeta.warnings || [], planFixes: countByKind(planMeta.fixes), bibleFixes: countByKind(bibleMeta.fixes), bibleWarnings: bibleMeta.warnings || [], planAttempts: planMeta.attempts.length, bibleAttempts: bibleMeta.attempts.length, perClip: results.map((r) => r.rec) };
  wr(join(dir, '_summary.json'), summary);
  wr(join(dir, '_state.json'), { recs: recs.map((r) => ({ clip: r.clip.clip, refs: r.refPack.references.map((x) => x.id), forced: r.refPack.forced, dropped: r.refPack.dropped, framing: r.framing, invalid: r.invalid, decisionCalls: r.decisionCalls, decisionCost: r.decisionCost, decisionSecs: r.decisionSecs, questions: r.questions, cand: r.cand })) });
  void workers;
  return { plan, bible, planMeta, bibleMeta, recs, fix, shots, ledgerLines, results, summary };
}
void exists; void entityList;
