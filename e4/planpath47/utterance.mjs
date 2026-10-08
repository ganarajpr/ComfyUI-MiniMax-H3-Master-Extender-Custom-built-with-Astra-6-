// E4.6 (issue #7): every audible utterance is a verbatim line. A sentence that describes a person or voice counting, reciting, chanting, calling,
// whispering or murmuring with no <d> line in that sentence is speech the renderer will improvise ("her mouth moves in a steady low count").
// One rule table serves two places: the plan's shots (subject and action text of a shot that has no dialogue line) and the written prompt (a sentence outside every <d> line).
import { sentences } from '../hybrid3/lib.mjs';

const POSS = '(?:her|his|their|its|my|your|our)';
const ARTICLE_BEFORE = /\b(?:a|an|the|soft|faint|low|distant|quiet|hushed|gentle|only|any|no)\s+$/i;
const NOUN_AFTER = /^\s*(?:of|from|through|across|over)\b/i;

// Each entry: [name, regex, noun-reading guard applied to the text before and after the match].
const ACTS = [
  ['count_aloud', new RegExp(`\\bcount(?:s|ed|ing)?\\s+(?:aloud|out loud|out|off|down|up|under ${POSS} breath|softly|quietly|slowly|steadily|in a (?:low|soft|steady|hushed)\\b|the (?:numbers?|steps?|levels?|stairs?|beats?)\\s+(?:aloud|out loud|under ${POSS} breath))`, 'i'), false],
  ['mouth_count', new RegExp(`\\b(?:mouth|lips|voice|breath|jaw)\\b[^.<]{0,50}\\b(?:count|counting|counts|chant|chanting|chants|recitation|recites?|reciting|prayer|murmur|murmurs|murmuring)\\b`, 'i'), false],
  ['in_a_count', /\bin (?:a|an) (?:[a-z-]+ ){0,3}(?:count|chant|murmur|recitation|whisper)\b/i, false],
  ['recite', /\b(?:recit(?:es|ed|ing)|chant(?:s|ed|ing)|intone[sd]?|intoning|mutter(?:s|ed|ing)?|murmur(?:s|ed|ing))\b/i, true],
  ['whisper', /\bwhisper(?:s|ed|ing)?\b/i, true],
  ['call_out', /\b(?:call(?:s|ed|ing)?|cr(?:y|ies|ied|ying)|shout(?:s|ed|ing)?|yell(?:s|ed|ing)?|scream(?:s|ed|ing)?|sing(?:s|ing)|sang)\s+(?:out|to|for|after|down|up|across|back|along|aloud)\b/i, false],
  ['repeat_after', new RegExp(`\\b(?:repeat(?:s|ed|ing)?|echo(?:es|ed|ing)?|answer(?:s|ed|ing)? back)\\s+(?:${POSS}|the|a)\\s+(?:number|numbers|word|words|call|phrase|name|line|count)\\b`, 'i'), false],
  ['read_aloud', /\bread(?:s|ing)?\s+(?:aloud|out loud|out)\b/i, false],
];

// -> [{act, text}] for one piece of prose. A hit is voided when the same sentence holds a <d> line, or when the word reads as a noun ("the whispers of the wind").
export function speechActs(sentence) {
  const out = [];
  if (/<d>/.test(sentence)) return out;
  const text = String(sentence).replace(/<Subject \d+>/g, 'X');
  for (const [act, re, guard] of ACTS) {
    const m = re.exec(text);
    if (!m) continue;
    if (guard && (ARTICLE_BEFORE.test(text.slice(0, m.index)) || NOUN_AFTER.test(text.slice(m.index + m[0].length)))) continue;
    out.push({ act, text: m[0] });
  }
  return out;
}

// Written prompt: every sentence of the clip's description that describes speech without a line.
export function speechProse(description) {
  const rows = [];
  sentences(description).forEach((s, idx) => { const a = speechActs(s)[0]; if (a) rows.push({ idx, act: a.act, match: a.text, sentence: s }); });
  return rows;
}

// Plan: a shot without a dialogue line whose subject or action describes speech.
export function planSpeechIssues(plan) {
  const issues = [];
  for (const clip of plan.clips) for (const s of clip.shots) {
    if (s.dialogue?.line) continue;
    for (const field of ['subject', 'action']) {
      const hit = speechActs(s[field] || '')[0];
      if (hit) issues.push(`clip ${clip.clip} shot ${s.shot}: the ${field} describes speech ("${hit.text}") but the shot has no dialogue line. Write every utterance as the exact words in dialogue_line (has_dialogue true, with its speaker), or take the speech out of the ${field}.`);
    }
  }
  return issues;
}
