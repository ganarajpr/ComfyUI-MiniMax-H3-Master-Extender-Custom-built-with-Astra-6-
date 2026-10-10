// NARRATION (light): a separable trailing or parenthetical clause that explains the shot instead of describing it
// ("so every step reads as ...", "telling the audience ...") is cut. Narration that is the sentence itself, or sits inside
// a clause that also carries picture, is left to the LLM.
import { NARRATION_PATTERNS } from '../templater/lexicon.mjs';
import { protect, restore, segmentize, joinSegs, plainWords, sentenceStillSound, tidy } from './text.mjs';

const ING_NOT_PARTICIPLE = new Set(['morning', 'evening', 'ceiling', 'building', 'ring', 'string', 'spring', 'king', 'thing', 'something', 'nothing', 'anything', 'everything']);

export const narrationMatches = (text) => NARRATION_PATTERNS.flatMap((re) => [...String(text).matchAll(new RegExp(re.source, re.flags.includes('g') ? re.flags : `${re.flags}g`))].map((m) => ({ match: m[0], index: m.index })));

function separableLead(seg) {
  const w = plainWords(seg).map((x) => x.toLowerCase());
  if (!w.length) return false;
  if (['so', 'which', 'meaning', 'as', 'while'].includes(w[0])) return true;
  if (/ing$/.test(w[0]) && w[0].length > 4 && !ING_NOT_PARTICIPLE.has(w[0])) return true;
  if (['and', 'but'].includes(w[0]) && w[1] && (/ing$/.test(w[1]) || ['so', 'which'].includes(w[1]))) return true;
  return false;
}

export function stripNarration(sentence) {
  let cur = sentence;
  const edits = [], declined = [];
  for (let guard = 0; guard < 6; guard++) {
    const P = protect(cur);
    const sg = segmentize(P.text);
    const bad = sg.segs.findIndex((s) => narrationMatches(s).length);
    if (bad < 0) break;
    const seg = sg.segs[bad];
    const why = (reason) => declined.push({ rule: 'narration_declined', match: narrationMatches(seg)[0].match, reason, sentence: cur });
    if (bad === 0) { why('narration_in_main_clause'); break; }
    if (!separableLead(seg)) { why('not_separable'); break; }
    if (/[-]/.test(seg)) { why('segment_holds_protected_text'); break; }
    const next = { segs: [...sg.segs], delims: [...sg.delims], term: sg.term };
    const first = Math.min(...narrationMatches(seg).map((x) => x.index));
    const leads = [...seg.matchAll(/\s(?:so|which|meaning|making|telling|showing|signalling|signaling|reminding|suggesting)\b/gi)].filter((m) => m.index < first);
    const cut = leads.length ? leads[leads.length - 1].index : -1;
    let gone = seg;
    if (cut >= 0 && plainWords(seg.slice(0, cut)).length >= 3) { next.segs[bad] = seg.slice(0, cut); gone = seg.slice(cut); }
    else { next.segs.splice(bad, 1); next.delims.splice(bad - 1, 1); }
    const text = tidy(restore(joinSegs(next), P.atoms));
    const why2 = sentenceStillSound(cur, text);
    if (why2) { why(why2); break; }
    edits.push({ rule: 'narration_removed', removed: restore(gone, P.atoms).trim(), before: cur, after: text });
    cur = text;
  }
  return { text: cur, edits, declined };
}
