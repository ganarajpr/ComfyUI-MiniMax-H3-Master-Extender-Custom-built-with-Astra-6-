// v1's deterministic finish, plus a speaker-id insertion that also works when the speaker's token is not in front of "says".
import { finishShot as finishV1 } from './finish.mjs';

export function finishShot(fix, shot, prose) {
  const first = finishV1(fix, shot, prose);
  const log = [...first.log];
  const p = first.prose;
  const tokenOf = (id) => { const i = shot.references.findIndex((r) => r.id === id); return i === -1 ? null : `<Subject ${i + 1}>`; };
  let dd = String(p.detailedDescription || '');
  const tags = [...dd.matchAll(/<d>\[[^\]]*\]\s*[\s\S]*?<\/d>/g)];
  if (tags.length === shot.lines.length) {
    for (let i = tags.length - 1; i >= 0; i--) {
      const m = tags[i], L = shot.lines[i], tk = tokenOf(L.speaker);
      if (!tk) continue;
      const start = Math.max(0, m.index - 400);
      const win = dd.slice(start, m.index);
      if (/\(S\d+\)/.test(win)) continue;
      const sayings = [...win.matchAll(/(?:\b(he|she|they|it)\s+)?\b(says?|said)\b/gi)];
      if (!sayings.length) continue;
      const s = sayings[sayings.length - 1];
      const at = start + s.index;
      const insert = `${tk} (${L.sid || L.id}) `;
      const replaced = s[1] ? dd.slice(0, at) + insert + dd.slice(at + s[1].length + 1) : dd.slice(0, at) + insert + dd.slice(at);
      dd = replaced;
      log.push({ rule: 'speaker_id_inserted_before_says', line: L.id });
    }
    p.detailedDescription = dd;
  }
  return { prose: p, log };
}
