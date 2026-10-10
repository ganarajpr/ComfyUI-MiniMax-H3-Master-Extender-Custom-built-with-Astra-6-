// SOUNDSCAPE VOCAL WORD: the gate bans vocal words in overallSoundscape; each has a fixed non-vocal equivalent in the shared lexicon.
import { SOUNDSCAPE_SUBS } from '../templater/lexicon.mjs';

const VOCAL_SUBS = SOUNDSCAPE_SUBS.filter(([re]) => !/silence/.test(re.source));
const keepCase = (src, to) => (src[0] === src[0].toUpperCase() && /[a-z]/i.test(src[0]) ? to[0].toUpperCase() + to.slice(1) : to);

export function substituteVocalWords(text) {
  const edits = [];
  let out = String(text);
  for (const [re, to] of VOCAL_SUBS) {
    out = out.replace(re, (m) => { edits.push({ rule: 'soundscape_vocal_word', word: m, as: to }); return keepCase(m, to); });
  }
  return { text: out, edits };
}
