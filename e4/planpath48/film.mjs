// E4 for one story: story -> plan (LLM 1) -> bible (LLM 2) -> per-clip decisions + code ledger -> clip writer (LLM 3, + repair only when a check fails).
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { call, parseJsonReply, parseJsonLoose, wr, rj, SETTINGS, MODEL, exists, cutNote } from './lib.mjs';
import { planStory, CAMERA_LABELS, parseBreakdown } from './planner.mjs';
import { repairJson } from './jsonrepair.mjs';
import { makeBible, entityList } from './bible.mjs';
import { buildRefs } from './refs.mjs';
import { buildLedgerLines, candidates, cutGeometry, assembleReferences, makeShot, makeFix } from './clip.mjs';
import { decideClip, emptyLedger, ledgerText } from './decide.mjs';
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

const pad = (n) => String(n).padStart(2, '0');

export const withLanguage = (story, language) => `${String(story).trim()}\n\nDIALOGUE LANGUAGE: ${language}. Every spoken line is written in ${language}.`;

export async function planAndBible({ name, story, outRoot, resume, language = 'English', refwriter = 'default', score = 'off', bindPictures = null }) {
  const dir = join(outRoot, name);
  let plan, planMeta, bible, bibleMeta;
  const pf = join(dir, 'plan.json');
  if (resume && existsSync(pf)) ({ plan, planMeta } = rj(pf));
  else {
    const chat = async (messages, attempt) => {
      const c = await call({ outRoot, dir: join(dir, 'planner'), name: attempt ? 'plan.retry' : 'plan', kind: 'planner', story: name, messages });
      const text = c.content;
      if (c.cut) return { text, cut: { note: cutNote(c.cut), max_tokens: c.cut.max_tokens } };
      if (parseBreakdown(text)) return text;
      const r = repairJson(text);
      return r.ok ? JSON.stringify(r.value) : text;
    };
    const r = await planStory(chat, withLanguage(story, language));
    plan = r.breakdown; planMeta = { issues: r.issues, attempts: r.attempts, rawAsks: r.rawAsks };
    wr(pf, { plan, planMeta });
  }
  const bf = join(dir, 'bible.json');
  if (resume && existsSync(bf) && rj(bf).bible && !rj(bf).bibleMeta?.issues?.length) ({ bible, bibleMeta } = rj(bf));
  else {
    const chat = async (messages, attempt) => {
      const c = await call({ outRoot, dir: join(dir, 'bible'), name: attempt ? 'bible.retry' : 'bible', kind: 'bible', story: name, messages });
      if (c.cut) return { ...parseJsonReply(c.content), cut: { note: cutNote(c.cut), max_tokens: c.cut.max_tokens } };
      return parseJsonLoose(c.content);
    };
    const r = await makeBible(chat, story, plan, planMeta.rawAsks, { score });
    bible = r.bible; bibleMeta = { issues: r.issues, attempts: r.attempts };
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

export async function decideAll({ name, outRoot, plan, planMeta, bible, ledgerLines }) {
  const dir = join(outRoot, name);
  const recs = [];
  let ledger = emptyLedger(), carried = null;
  const fold = foldState(plan, bible);
  wr(join(dir, 'state_fold.json'), fold);
  const clips = [...plan.clips].sort((a, b) => a.clip - b.clip);
  for (let i = 0; i < clips.length; i++) {
    const clip = clips[i], rawAsk = planMeta.rawAsks[i];
    const cdir = join(dir, 'clips', `clip${pad(clip.clip)}`);
    const cand = candidates(plan, bible, clip, carried);
    const landmarks = cand.locs.flatMap((l) => l.landmarks);
    const geom = cutGeometry(clip);
    const lines = ledgerLines.filter((l) => l.clip === clip.clip);
    const ledgerIn = pruneLedger(ledger, landmarks);
    const dec = await decideClip({ outRoot, dir: cdir, story: name, plan, bible, clip, rawAsk, cand, landmarks, ledger: ledgerIn, geom, lines });
    const refPack = withCarriedState(assembleReferences(bible, cand, dec.picks, lines.map((l) => l.speaker)), fold.byClip[clip.clip] || [], fold.changesByClip[clip.clip] || []);
    const rules = cameraRules(clip, lines, bible);
    const framing = clip.shots.map((s, k) => { const planned = CAMERA_LABELS[s.camera]; const o = rules.find((r) => r.cut === k + 1 && r.to); const final = o ? CAMERA_LABELS[o.to] : planned; return { cut: k + 1, planned, final, changed: final !== planned, rules: rules.filter((r) => r.cut === k + 1).map((r) => r.rule) }; });
    const ledgerAfter = dec.ledgerAfter;
    const offscreen = offscreenCuts(clip, lines, bible);
    const locationId = refPack.references.find((r) => r.type === 'location')?.id || cand.locs[0].id;
    const rec = { clip, rawAsk, offscreen, geom, cand: { chars: cand.chars.map((c) => c.id), props: cand.props.map((c) => c.id), locs: cand.locs.map((c) => c.id) }, picks: dec.picks, answers: dec.answers, invalid: dec.invalid, constrained: dec.constrained, decisionCalls: dec.calls.length, decisionCost: dec.cost, decisionSecs: dec.secs, refPack, framing, ledgerBefore: ledgerIn, ledgerAfter, locationId, questions: dec.questions.length };
    wr(join(cdir, 'decisions.json'), { clip: clip.clip, offscreen, picks: dec.picks, answers: dec.answers, constrained: dec.constrained, changes: dec.changes, invalid: dec.invalid, calls: dec.calls, cand: rec.cand, refs: refPack.references.map((r) => r.id), forced: refPack.forced, dropped: refPack.dropped, framing, ledgerBefore: ledgerIn, ledgerAfter, questions: dec.questions.length });
    recs.push(rec);
    ledger = ledgerAfter;
    carried = { charIds: refPack.references.filter((r) => r.type === 'character').map((r) => r.id), locIds: refPack.references.filter((r) => r.type === 'location').map((r) => r.id) };
  }
  return recs;
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
  const res = await processDraft({ fix, shot, sceneId: fix.sceneId, facts, raw, dir: cdir, maxRounds: 2, budget });
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
  const finalConf = planConformance(final, rec.geom);
  const repairCalls = [1, 2].map((i) => join(cdir, `round${i}.repair.meta.json`)).filter(existsSync).map((p) => rj(p));
  for (const m of repairCalls) appendFileSync(join(outRoot, 'calls.jsonl'), `${JSON.stringify({ kind: 'repair', story: name, clip: rec.clip.clip, name: 'hybrid3.repair', usage: m.usage, cost: m.cost, secs: m.secs })}\n`);
  const words = String(final.detailedDescription || '').split(/\s+/).filter(Boolean).length;
  wr(join(cdir, 'final.prose.json'), final);
  wr(join(cdir, 'checks46.json'), { ...clipChecks({ shot, prose: final, fix, attribution: attAfter }), sweep });
  wr(join(cdir, `e4__budget4096__${shot.id}.json`), { tag: `e4__budget4096__${shot.id}`, shotId: shot.id, clip: rec.clip.clip, condition: 'budget4096', modelRequested: MODEL, arm: 'E4', usage: gen?.usage || {}, content: JSON.stringify({ sceneId: fix.sceneId, shots: [final] }, null, 2), words, cost: res.rec.cost + attCost + calls.reduce((a, c) => a + c.cost, 0), attribution, hybrid: res.rec, linesReinserted: ens.log, planConformance: { first: conf, final: finalConf, resampled } });
  return { rec: { clip: rec.clip.clip, shotId: shot.id, words, cost: res.rec.cost + attCost + calls.reduce((a, c) => a + c.cost, 0), attribution: { ok: attAfter.every((r) => r.ok), repaired: att.repaired, retagged: att.retagged.length, repairCalls: att.repairCalls.length }, writeCost: calls.reduce((a, c) => a + c.cost, 0), writeSecs: calls.reduce((a, c) => a + c.secs, 0), repairs: res.rec.repairs, rejected: res.rec.rejected, resampled, linesReinserted: ens.log.filter((l) => l.rule === 'line_reinserted').length, before: res.rec.before, afterDeterministic: res.rec.afterDeterministic, after: res.rec.after, planConformance: finalConf, hybrid: res.rec }, prose: final };
}

export async function runStory({ name, story, outRoot, budget, resume = false, workers = 4, language = 'English', refwriter = 'default', refsOnly = false, score = 'off', bindPictures = null }) {
  const t0 = Date.now();
  const dir = join(outRoot, name);
  wr(join(dir, 'story.txt'), story);
  const { plan, planMeta, bible, bibleMeta } = await planAndBible({ name, story, outRoot, resume, language, refwriter, score, bindPictures });
  if (score === 'on' && !bible.score) throw new Error('score on, but the bible has no score (a resumed bible from a score-off run)');
  if (refsOnly) return { plan, bible, planMeta, bibleMeta };
  const tPlan = (Date.now() - t0) / 1000;
  const ledgerLines = buildLedgerLines(plan, bible);
  wr(join(dir, 'dialogue_ledger.json'), ledgerLines);
  const recs = await decideAll({ name, outRoot, plan, planMeta, bible, ledgerLines });
  const tDecide = (Date.now() - t0) / 1000;
  wr(join(dir, 'staging_ledger.json'), recs.map((r) => ({ clip: r.clip.clip, before: r.ledgerBefore, after: r.ledgerAfter })));
  const shots = recs.map((r, i) => makeShot(i, shotId(r.clip.clip), r.refPack, ledgerLines.filter((l) => l.clip === r.clip.clip), r.clip, r.offscreen));
  const fix = makeFix(bible, ledgerLines, shots, recs.map((r) => r.refPack), { score });
  wr(join(dir, 'fix.json'), { refs: fix.refs, split: fix.split, ledger: fix.ledger, continuity: fix.continuity, granted: [...fix.granted], masters: fix.film.masters, voices: fix.voices, score: fix.score, scoreText: fix.scoreText });
  wr(join(dir, 'shots.json'), shots);
  const results = new Array(recs.length);
  let next = 0;
  await Promise.all(Array.from({ length: workers }, async () => {
    while (next < recs.length) {
      const i = next++;
      if (budget.spent > budget.cap) { results[i] = { rec: { clip: recs[i].clip.clip, failed: 'cap reached' } }; continue; }
      results[i] = await writeClip({ name, outRoot, plan, bible, story, rawAsks: planMeta.rawAsks, fix, shot: shots[i], rec: recs[i], budget });
      const r = results[i].rec;
      console.log(`${name} clip${pad(r.clip)} ${r.failed ? `FAILED ${r.failed}` : `words=${r.words} before=${r.before.v2.total} afterDet=${r.afterDeterministic.v2.total} after=${r.after.v2.total} repairs=${r.repairs} plan=${r.planConformance.ok ? 'ok' : r.planConformance.issues.join('/')} cost=${r.cost.toFixed(4)}`}`);
    }
  }));
  wr(join(dir, 'film_checks.json'), filmChecks({ plan, bible, story, ledgerLines, shots, fix, proseByClip: Object.fromEntries(results.filter((r) => r.prose).map((r) => [r.rec.clip, r.prose])) }));
  const wall = (Date.now() - t0) / 1000;
  const summary = { story: name, clips: recs.length, wallSecs: wall, planBibleSecs: tPlan, decideSecs: tDecide - tPlan, writeSecs: wall - tDecide, planIssues: planMeta.issues, planAttempts: planMeta.attempts.length, bibleAttempts: bibleMeta.attempts.length, perClip: results.map((r) => r.rec) };
  wr(join(dir, '_summary.json'), summary);
  wr(join(dir, '_state.json'), { recs: recs.map((r) => ({ clip: r.clip.clip, refs: r.refPack.references.map((x) => x.id), forced: r.refPack.forced, dropped: r.refPack.dropped, framing: r.framing, invalid: r.invalid, decisionCalls: r.decisionCalls, decisionCost: r.decisionCost, decisionSecs: r.decisionSecs, questions: r.questions, cand: r.cand })) });
  return { plan, bible, planMeta, bibleMeta, recs, fix, shots, ledgerLines, results, summary };
}
void exists; void entityList;
