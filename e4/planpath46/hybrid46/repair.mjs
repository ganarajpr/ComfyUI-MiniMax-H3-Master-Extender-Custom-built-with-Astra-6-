// One targeted repair call: the shot JSON goes back with the exact offending sentences and the rule each breaks;
// the reply is accepted only if every other sentence and field is byte-identical.
import { chat, parseJsonReply, sentences } from '../../hybrid3/lib.mjs';
import { RULE } from './validate.mjs';

export function buildRepairMessages(prose, sceneId, map, facts, note) {
  const list = map.targets.map((t, i) => {
    const arr = t.field === 'overallSoundscape' ? map.ss : t.field === 'summary' ? map.su : map.dd;
    const rules = t.rules.map((r) => `- ${RULE[r] ? `${r}: this sentence ${RULE[r]}` : r}`).join('\n');
    const hints = t.hints.length ? `\nGate detail: ${t.hints.join(' | ')}` : '';
    return `[${i + 1}] field ${t.field}, sentence ${t.idx + 1}:\n"${arr[t.idx]}"\nRules broken:\n${rules}${hints}`;
  }).join('\n\n');
  const cut = map.expand?.cut;
  const cutText = cut ? `\n\nALSO: this shot has too few cuts. APPEND, after the last sentence of detailedDescription (nothing inserted elsewhere), a new cut that opens with "[Shot ${cut.n}] At ${cut.time}, the shot cuts to ..." and whose time is later than every earlier cut and no later than the duration in the JSON. ${cut.silent ? 'The cut is SILENT: a pure physical reaction of the listening subject, no <d> tag, no speech and no speech-shaped wording, at least 90 words.' : 'Keep every spoken line exactly once, in ledger order.'} It carries its own controlled camera-motion term (for example Static Shot, Push In or Pull Out, spelled exactly), a framing, where each subject sits, the light and the sound at that moment. No negation, no padding.` : '';
  const exp = map.expand ? `${cutText}\n\nALSO: detailedDescription is too short. APPEND new sentences at the very end of detailedDescription (after its last sentence, nothing inserted elsewhere) totalling at least ${map.expand.words + 20} words. They must add genuine concrete detail taken from this shot's own spec (framing, light, the action as it unfolds, the sound at that moment, where each reference sits). No padding, no repetition of earlier sentences, no negation.` : '';
  const text = `Below is one shot as JSON. Some of its sentences break rules. Return the SAME JSON with ONLY the listed sentences rewritten to satisfy the rules they break${map.expand ? ' (plus the appended sentences described below)' : ''}. Every other sentence, every other field and all spacing must stay BYTE-IDENTICAL: do not improve, shorten, reorder or add anything else. A rewritten sentence may become two sentences if it needs to; it must stay in the same place. Spoken lines inside <d>...</d> must be kept exactly. Return the JSON object only, no commentary.

${facts}

SENTENCES TO REWRITE
${list || '(none)'}${exp}
${note ? `\nNOTE FROM THE PREVIOUS ATTEMPT: ${note}\n` : ''}
SHOT JSON
${JSON.stringify({ sceneId, shots: [prose] }, null, 2)}`;
  return [{ role: 'user', content: text }];
}

// Accept only if untouched sentences/fields are unchanged and new text sits only where flagged sentences were.
export function verifyRepair(oldProse, newProse, map) {
  const problems = [];
  for (const k of Object.keys(oldProse)) {
    if (k === 'detailedDescription' || k === 'overallSoundscape' || k === 'summary') continue;
    if (JSON.stringify(oldProse[k]) !== JSON.stringify(newProse?.[k])) problems.push(`field ${k} changed`);
  }
  for (const k of Object.keys(newProse || {})) if (!(k in oldProse)) problems.push(`field ${k} added`);
  const check = (field, oldArr) => {
    if (field === 'summary' && newProse?.summary === undefined) return;
    const flagged = new Set(map.targets.filter((t) => t.field === field).map((t) => t.idx));
    const newArr = sentences(newProse?.[field]);
    let j = 0;
    const zones = []; // new sentences between anchors
    let zone = [];
    let flaggedSince = false;
    for (let i = 0; i < oldArr.length; i++) {
      if (flagged.has(i)) { flaggedSince = true; continue; }
      let k = j;
      while (k < newArr.length && newArr[k] !== oldArr[i]) k++;
      if (k >= newArr.length) { problems.push(`${field}: untouched sentence ${i + 1} missing or changed: "${oldArr[i].slice(0, 80)}"`); return; }
      const between = newArr.slice(j, k);
      if (between.length && !flaggedSince) problems.push(`${field}: new text inserted before untouched sentence ${i + 1}: "${between[0].slice(0, 80)}"`);
      j = k + 1; flaggedSince = false;
    }
    const tail = newArr.slice(j);
    if (tail.length && !flaggedSince && !(map.expand && field === 'detailedDescription')) problems.push(`${field}: new text appended at the end: "${tail[0].slice(0, 80)}"`);
  };
  check('detailedDescription', map.dd);
  check('overallSoundscape', map.ss);
  check('summary', map.su);
  return problems;
}


export async function repairOnce(prose, sceneId, map, facts, note) {
  const messages = buildRepairMessages(prose, sceneId, map, facts, note);
  const call = await chat(messages);
  const parsed = parseJsonReply(call.content);
  let newProse = null, problems = [];
  if (!parsed.ok) problems = [`reply is not JSON: ${parsed.error}`];
  else {
    newProse = (parsed.value.shots || [parsed.value]).find((s) => s.id === prose.id) || (parsed.value.shots || [parsed.value])[0];
    if (!newProse) problems = ['no shot in reply']; else problems = verifyRepair(prose, newProse, map);
  }
  return { call, messages, newProse, problems, accepted: problems.length === 0 };
}
