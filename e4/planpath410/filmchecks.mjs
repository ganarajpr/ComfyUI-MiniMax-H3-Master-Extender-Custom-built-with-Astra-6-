// E4.6 code checks that read the finished prompts: per clip (off-screen framing, music-like sound words, speech without a line, the voice form) and per film
// (one speaker id per speaker in every clip, sequence continuity of numbered lines). No model.
import { speakerAttribution, speakerIdIssues } from './speakers.mjs';
import { offscreenFramingRows } from './offscreen.mjs';
import { soundVocabFindings } from './soundvocab.mjs';
import { speechProse } from './utterance.mjs';
import { sequenceIssues } from './sequence.mjs';

export function clipChecks({ shot, prose, fix, attribution }) {
  const framing = offscreenFramingRows({ shot, prose });
  const sound = soundVocabFindings(prose, { score: fix?.score }).map((f) => ({ field: f.field, word: f.match }));
  const speech = speechProse(prose.detailedDescription).map((h) => ({ act: h.act, match: h.match }));
  const voiceForm = (attribution || []).filter((r) => r.voice || r.offscreen).map((r) => ({ line: r.line, sid: r.sid, ok: r.ok, problems: r.problems }));
  const music = fix?.score === 'on' ? prose.nonDiegeticMusic === fix.scoreText : prose.nonDiegeticMusic === 'N/A';
  return { offscreenFraming: { rows: framing, ok: framing.every((r) => r.ok) }, soundVocab: { hits: sound, ok: !sound.length }, speechWithoutLine: { hits: speech, ok: !speech.length }, voiceForm: { rows: voiceForm, ok: voiceForm.every((r) => r.ok) }, musicField: { ok: music, value: prose.nonDiegeticMusic } };
}

export function filmChecks({ plan, bible, story, ledgerLines, shots, fix, proseByClip }) {
  const written = [], clips = {};
  for (const shot of shots) {
    const prose = proseByClip[shot.clipNumber];
    if (!prose) continue;
    const rows = speakerAttribution({ plan, bible, shot, prose });
    written.push(...rows);
    clips[shot.clipNumber] = clipChecks({ shot, prose, fix, attribution: rows });
  }
  const ids = speakerIdIssues({ lines: ledgerLines, written });
  const seq = sequenceIssues(ledgerLines.map((l) => ({ clip: l.clip, cut: l.cut, speaker: l.speaker, text: l.text })), story);
  const speakers = Object.fromEntries([...new Set(ledgerLines.map((l) => l.speaker))].map((sp) => [sp, { sid: ledgerLines.find((l) => l.speaker === sp).sid, writtenIds: [...new Set(written.filter((w) => w.expected === sp).map((w) => w.promptId))] }]));
  return { speakers, speakerIds: { ok: !ids.length, issues: ids }, sequence: { ok: !seq.issues.length, issues: seq.issues, unverified: seq.unverified, lines: ledgerLines.map((l) => ({ clip: l.clip, cut: l.cut, speaker: l.speaker, sid: l.sid, text: l.text })) }, clips };
}
