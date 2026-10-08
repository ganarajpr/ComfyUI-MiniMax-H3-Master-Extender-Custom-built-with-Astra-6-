// MUSIC VOCABULARY: a word is flagged only when it is used in a MUSICAL sense (it would hand the renderer a score to play).
// "beat" as a dramatic or time unit, "heart beats", "the tempo of an action", "a score" in a contest are not musical.
import { MUSIC_VOCAB } from '../templater/lexicon.mjs';
import { protect, restore, segmentize, joinSegs, wordsOf, plainWords, sentenceStillSound, tidy } from './text.mjs';

const ALWAYS_MUSICAL = new Set(['music', 'musical', 'soundtrack', 'melody', 'song', 'bpm']);
const MUSIC_CUE = new Set(['music', 'musical', 'melody', 'melodies', 'harmony', 'chord', 'chords', 'song', 'songs', 'instrument', 'instruments', 'percussion', 'orchestra', 'orchestral', 'guitar', 'piano', 'violin', 'synth', 'synthesizer', 'soundtrack', 'lyrics', 'bpm']);
// These double as verbs or common nouns, so they are a musical cue only as a noun directly after a determiner or preposition, or next to the word.
const AMBIGUOUS_CUE = new Set(['drum', 'drums', 'bass', 'kick', 'snare', 'groove', 'band', 'track', 'tune']);
const NOUN_LEAD = new Set(['a', 'an', 'the', 'this', 'that', 'his', 'her', 'its', 'their', 'of', 'with', 'to', 'by', 'like', 'from', 'and', 'or', 'under', 'over']);
const TIME_UNIT_PRE = new Set(['a', 'an', 'one', 'two', 'three', 'four', 'five', 'another', 'half', 'each', 'every', 'that', 'this', 'same', 'next', 'last', 'final', 'single', 'full', 'long', 'short', 'brief', 'slight', 'small', 'held', 'extra', 'entire', 'whole']);
const TIME_UNIT_POST = new Set(['later', 'longer', 'before', 'after', 'ahead', 'behind', 'too', 'early', 'late', 'of', 'past', 'beyond']);
const STRIKE_PREP = new Set(['against', 'on', 'at', 'down', 'upon', 'into', 'back', 'out', 'hard', 'fast', 'wildly', 'steadily', 'slowly', 'erratically', 'in']);
const KEEP_TIME = new Set(['on', 'off', 'to', 'with', 'keeping', 'keeps', 'keep', 'match', 'matches', 'matching', 'miss', 'misses', 'missing']);
const VERB_SUBJECTS = new Set(['he', 'she', 'they', 'it', 'we', 'you', 'i', 'who', 'to', 'will', 'would', 'can', 'could', 'may', 'might', 'must', 'should']);
const CONTEST_SCORE_PRE = new Set(['final', 'current', 'live', 'running', 'old', 'even', 'tied', 'settled', 'settle', 'settling', 'keep', 'keeping', 'kept']);
const CONTEST_SCORE_POST = new Set(['board', 'line', 'sheet', 'keeper', 'mark', 'marks', 'points']);
const DETERMINERS = new Set(['a', 'an', 'the', 'this', 'that', 'his', 'her', 'its', 'their']);
const STRIKE_VERBS = new Set(['strike', 'strikes', 'struck', 'striking', 'touch', 'touches', 'touched', 'hit', 'hits']);

export const NEUTRAL_SUB = { beat: 'pulse', beats: 'pulses', rhythm: 'pattern', rhythmic: 'regular', tempo: 'pace', cadence: 'pace' };

const MUSIC_RE = new RegExp(`\\b(?:${MUSIC_VOCAB.join('|')})\\b`, 'gi');

export function classifyMusic(sentence, field = 'detailedDescription') {
  const P = protect(sentence);
  const text = P.text;
  const all = [...text.matchAll(/[-]|[A-Za-z]+(?:['’-][A-Za-z]+)*|\d+/g)].map((m) => ({ w: m[0].toLowerCase(), i: m.index }));
  const out = [];
  for (const m of text.matchAll(MUSIC_RE)) {
    const w = m[0].toLowerCase();
    const k = all.findIndex((t) => t.i === m.index);
    const pre = all.slice(Math.max(0, k - 2), k).map((t) => t.w);
    const post = all.slice(k + 1, k + 3).map((t) => t.w);
    const lo = Math.max(0, k - 6);
    const cue = all.slice(lo, k + 7).some((t, idx) => {
      const abs = lo + idx;
      if (abs === k || t.w === w) return false;
      if (MUSIC_CUE.has(t.w)) return true;
      return AMBIGUOUS_CUE.has(t.w) && (Math.abs(abs - k) === 1 || NOUN_LEAD.has((all[abs - 1] || {}).w));
    });
    const dflt = field === 'overallSoundscape';
    let sense, reason;
    if (ALWAYS_MUSICAL.has(w)) { sense = 'musical'; reason = 'always_musical_lexeme'; }
    else if (cue) { sense = 'musical'; reason = 'musical_cue_nearby'; }
    else if (w === 'beat' || w === 'beats') {
      if (KEEP_TIME.has(pre[pre.length - 1]) || KEEP_TIME.has(pre[pre.length - 2]) && pre[pre.length - 1] === 'the') { sense = 'musical'; reason = 'on_or_off_the_beat'; }
      else if (TIME_UNIT_PRE.has(pre[pre.length - 1]) || TIME_UNIT_POST.has(post[0])) { sense = 'other'; reason = 'time_or_dramatic_unit'; }
      else if (STRIKE_PREP.has(post[0])) { sense = 'other'; reason = 'verb_strike_or_pulse'; }
      else { sense = dflt ? 'musical' : 'other'; reason = dflt ? 'bare_in_soundscape' : 'bare_outside_soundscape'; }
    } else if (w === 'score') {
      if (CONTEST_SCORE_PRE.has(pre[pre.length - 1]) || CONTEST_SCORE_POST.has(post[0]) || VERB_SUBJECTS.has(pre[pre.length - 1])) { sense = 'other'; reason = 'contest_tally_or_verb'; }
      else { sense = dflt ? 'musical' : 'other'; reason = 'bare_score'; }
    } else if (w === 'chord') {
      if (STRIKE_VERBS.has(pre[0]) || STRIKE_VERBS.has(pre[1])) { sense = 'other'; reason = 'idiom_strike_a_chord'; }
      else { sense = 'musical'; reason = 'chord_without_idiom'; }
    } else if (w === 'tune') {
      if (DETERMINERS.has(pre[pre.length - 1]) || pre[pre.length - 1] === 'in') { sense = pre[pre.length - 1] === 'in' ? 'other' : 'musical'; reason = sense === 'musical' ? 'noun_tune' : 'in_tune_figurative'; }
      else { sense = 'other'; reason = 'verb_tune_adjust'; }
    } else { sense = dflt ? 'musical' : 'other'; reason = dflt ? 'bare_in_soundscape' : 'bare_outside_soundscape'; }
    out.push({ word: m[0], index: m.index, sense, reason });
  }
  return out;
}

const matchCase = (from, to) => (from === from.toUpperCase() && from.length > 1 ? to.toUpperCase() : from[0] === from[0].toUpperCase() ? to[0].toUpperCase() + to.slice(1) : to);

// Musical-sense words with a neutral equivalent are substituted; the rest lose their separable clause or are left to the LLM.
export function fixMusic(sentence, field = 'detailedDescription') {
  let cur = sentence;
  const edits = [], declined = [];
  for (let guard = 0; guard < 8; guard++) {
    const hit = classifyMusic(cur, field).filter((h) => h.sense === 'musical').pop();
    if (!hit) break;
    const P = protect(cur);
    const w = hit.word.toLowerCase();
    if (NEUTRAL_SUB[w]) {
      const nt = P.text.slice(0, hit.index) + matchCase(hit.word, NEUTRAL_SUB[w]) + P.text.slice(hit.index + hit.word.length);
      edits.push({ rule: 'music_substituted', word: hit.word, as: NEUTRAL_SUB[w], reason: hit.reason, before: cur });
      cur = restore(nt, P.atoms);
      continue;
    }
    const sg = segmentize(P.text);
    let pos = 0, si = -1;
    sg.segs.forEach((s, i) => { if (si < 0 && hit.index >= pos && hit.index < pos + s.length) si = i; pos += s.length + (sg.delims[i] || '').length; });
    const seg = sg.segs[si];
    const fail = (reason) => { declined.push({ rule: 'music_declined', word: hit.word, reason, sentence: cur }); };
    if (si < 1 || /[-]/.test(seg)) { fail(si < 1 ? 'main_clause' : 'segment_holds_protected_text'); break; }
    const next = { segs: [...sg.segs], delims: [...sg.delims], term: sg.term };
    next.segs.splice(si, 1); next.delims.splice(si - 1, 1);
    const text = tidy(restore(joinSegs(next), P.atoms));
    const bad = sentenceStillSound(cur, text);
    if (bad) { fail(bad); break; }
    edits.push({ rule: 'music_clause_removed', word: hit.word, removed: restore(seg, P.atoms), reason: hit.reason, before: cur });
    cur = text;
  }
  return { text: cur, edits, declined };
}
