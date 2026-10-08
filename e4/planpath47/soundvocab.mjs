// E4.6 (issue #9): music-like words in the sound fields bring a score back although non_diegetic_music is N/A (H3 hears "a low stone hum" as a drone).
// Two classes. CORE words describe a sustained or tuned sound in every sense, so they are swept from overall_soundscape and from the description outside <d>.
// SOUND words are ordinary in a body or a number context, so they are swept only from overall_soundscape (where every word names a sound) and, for tone, from a description sentence that carries no speaker marker.
// The rewrite is a model repair to a concrete physical source; code only has the last-resort removal of the offending list item (dropItems).
import { sentences } from '../hybrid3/lib.mjs';

const CORE = /\b(?:hum|hums|humming|hummed|drone|drones|droning|droned|resonance|resonances|resonant|resonate|resonates|resonated|resonating|chord|chords|thrum|thrums|thrumming|overtone|overtones|harmonic|harmonics|reverberation|reverberations|reverberate|reverberates|reverberated|sustained notes?|low notes?|high notes?)\b/gi;
const SOUND = /\b(?:tone|tones|tonal|swell|swells|swelling|swelled|pulse|pulses|pulsing|pulsed|throb|throbs|throbbing|throbbed|notes?)\b/gi;
const TONE = /\b(?:tone|tones|tonal)\b/gi;
const SPEAKER_SENTENCE = /\(S\d+\)|<d>/;

// -> [{word, index}] for one field's text; field is 'overallSoundscape' or a description field. Text inside <d> is never read.
export function musicLikeHits(text, field = 'overallSoundscape') {
  const t = String(text || '').replace(/<d>[\s\S]*?<\/d>/g, (m) => ' '.repeat(m.length));
  const hits = [];
  for (const m of t.matchAll(CORE)) hits.push({ word: m[0], index: m.index });
  if (field === 'overallSoundscape') for (const m of t.matchAll(SOUND)) hits.push({ word: m[0], index: m.index });
  else for (const s of sentenceSpans(t)) if (!SPEAKER_SENTENCE.test(s.text)) for (const m of s.text.matchAll(TONE)) hits.push({ word: m[0], index: s.start + m.index });
  return hits.sort((a, b) => a.index - b.index);
}

function sentenceSpans(text) {
  const out = [];
  let at = 0;
  for (const s of sentences(text)) { const i = text.indexOf(s, at); out.push({ text: s, start: i < 0 ? at : i }); at = (i < 0 ? at : i) + s.length; }
  return out;
}

// Findings in the validator's shape (src lint, code soundvocab) with the sentence index the targeted repair needs.
export function soundVocabFindings(prose, { score = 'off' } = {}) {
  const out = [];
  for (const field of ['overallSoundscape', 'detailedDescription']) {
    const text = prose[field];
    if (typeof text !== 'string') continue;
    const sents = sentences(text);
    const spans = sentenceSpans(text);
    const seen = new Set();
    for (const h of musicLikeHits(text, field)) {
      const idx = spans.findIndex((s) => h.index >= s.start && h.index < s.start + s.text.length);
      if (idx < 0 || seen.has(`${field}:${idx}:${h.word.toLowerCase()}`)) continue;
      seen.add(`${field}:${idx}:${h.word.toLowerCase()}`);
      out.push({ src: 'lint', code: 'soundvocab', field, idx, match: h.word, message: `"${h.word}" in: ${sents[idx].slice(0, 160)}`, score });
    }
  }
  return out;
}

// Last resort when the repair did not clear the soundscape: drop each comma or "and" separated item that holds a music-like word. Returns the text unchanged when nothing would be left.
export function dropItems(soundscape) {
  const text = String(soundscape || '');
  if (!musicLikeHits(text, 'overallSoundscape').length) return { text, dropped: [] };
  const body = text.replace(/[.\s]+$/, '');
  const parts = body.split(/\s*,\s*(?:and\s+)?|\s+and\s+(?=(?:a|an|the|faint|soft|low|distant)\b)/i).filter(Boolean);
  const keep = parts.filter((p) => !musicLikeHits(p, 'overallSoundscape').length);
  const dropped = parts.filter((p) => musicLikeHits(p, 'overallSoundscape').length);
  if (!keep.length) return { text, dropped: [] };
  const lead = keep.map((p, i) => (i === 0 ? p : p.replace(/^./, (c) => c.toLowerCase())));
  const joined = lead.length > 1 ? `${lead.slice(0, -1).join(', ')}, and ${lead[lead.length - 1]}` : lead[0];
  return { text: `${joined}.`, dropped };
}
