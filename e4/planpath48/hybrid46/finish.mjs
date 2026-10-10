// Deterministic finish: facts the ledger and the format fix exactly.
export function finishShot(fix, shot, prose) {
  const log = [];
  const p = { ...prose };
  const music = fix.score === 'on' ? fix.scoreText : 'N/A';
  if (p.nonDiegeticMusic !== music) { log.push({ rule: 'music_sentinel', before: p.nonDiegeticMusic }); p.nonDiegeticMusic = music; }
  const tokenOf = (id) => { const i = shot.references.findIndex((r) => r.id === id); return i === -1 ? null : `<Subject ${i + 1}>`; };
  let dd = String(p.detailedDescription || '');
  const tags = [...dd.matchAll(/<d>\[([^\]]*)\]\s*([\s\S]*?)<\/d>/g)];
  if (tags.length === shot.lines.length) {
    let out = '', last = 0;
    tags.forEach((m, i) => {
      const L = shot.lines[i];
      const SID = L.sid || L.id;
      const lang = L.language || fix.continuity.language || 'English';
      let before = dd.slice(last, m.index);
      const win = Math.max(0, before.length - 400);
      let head = before.slice(0, win), tail = before.slice(win);
      const sid = /\(S\d+\)/g;
      const hits = [...tail.matchAll(sid)];
      if (!hits.length) {
        // no (Sn) id before the line: it goes right after the speaker's own token, in front of "says"
        const tk0 = tokenOf(L.speaker);
        const at = tk0 ? tail.lastIndexOf(tk0) : -1;
        if (at >= 0 && /says?\b/i.test(tail.slice(at))) { tail = tail.slice(0, at + tk0.length) + ` (${SID})` + tail.slice(at + tk0.length); log.push({ rule: 'speaker_id_inserted', line: L.id }); }
      }
      if (hits.length) {
        const h = hits[hits.length - 1];
        if (h[0] !== `(${SID})`) { log.push({ rule: 'speaker_id', line: L.id, before: h[0] }); tail = tail.slice(0, h.index) + `(${SID})` + tail.slice(h.index + h[0].length); }
        const tk = tokenOf(L.speaker);
        const upto = tail.slice(0, tail.lastIndexOf(`(${SID})`));
        const tm = [...upto.matchAll(/<Subject \d+>/g)].pop();
        if (tk && tm && tm[0] !== tk) { log.push({ rule: 'speaker_token', line: L.id, before: tm[0], after: tk }); tail = tail.slice(0, tm.index) + tk + tail.slice(tm.index + tm[0].length); }
      }
      const tagTxt = `<d>[${lang}] ${L.text}</d>`;
      if (m[0] !== tagTxt) log.push({ rule: 'dialogue_text', line: L.id });
      out += head + tail + tagTxt;
      last = m.index + m[0].length;
    });
    dd = out + dd.slice(last);
  }
  p.detailedDescription = dd;
  // performanceBeats: subjectId is the reference id of the character (state id when the reference has one)
  if (Array.isArray(p.performanceBeats)) {
    const refIdOf = (id) => { const r = shot.references.find((x) => x.id === String(id).split('__')[0]); return r ? (r.stateId || r.id) : null; };
    const beats = p.performanceBeats.map((b) => { const want = refIdOf(b.subjectId); if (want && want !== b.subjectId) { log.push({ rule: 'beat_subject', before: b.subjectId, after: want }); return { ...b, subjectId: want }; } return b; });
    p.performanceBeats = beats;
  }
  return { prose: p, log };
}
