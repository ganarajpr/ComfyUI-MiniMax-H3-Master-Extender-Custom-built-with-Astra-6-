// The deterministic stage: every word-level rule, applied sentence by sentence, with a log of what changed and what was declined.
import { sentences } from '../../hybrid3/lib.mjs';
import { mapSentences } from '../../hybrid3/text.mjs';
import { stripNegatedPresence } from './negation.mjs';
import { rewriteLabels } from '../../hybrid3/label.mjs';
import { fixMusic } from '../../hybrid3/music.mjs';
import { stripNarration } from '../../hybrid3/narration.mjs';
import { substituteVocalWords } from '../../hybrid3/soundscape.mjs';

export const FIELDS = ['detailedDescription', 'overallSoundscape', 'summary'];

export function applyRules(prose) {
  const p = { ...prose };
  const edits = [], declined = [];
  for (const field of FIELDS) {
    if (typeof p[field] !== 'string') continue;
    let t = p[field];
    const tag = (arr, into) => arr.forEach((e) => into.push({ field, ...e }));
    if (field === 'overallSoundscape') { const r = substituteVocalWords(t); t = r.text; tag(r.edits, edits); }
    const lab = rewriteLabels(t, field); t = lab.text; tag(lab.edits, edits);
    t = mapSentences(t, sentences, (s) => {
      let cur = s;
      const mu = fixMusic(cur, field); cur = mu.text; tag(mu.edits, edits); tag(mu.declined, declined);
      const na = stripNarration(cur); cur = na.text; tag(na.edits, edits); tag(na.declined, declined);
      const ne = stripNegatedPresence(cur); cur = ne.text; tag(ne.edits, edits); tag(ne.declined, declined);
      return cur;
    });
    p[field] = t;
  }
  return { prose: p, edits, declined };
}
