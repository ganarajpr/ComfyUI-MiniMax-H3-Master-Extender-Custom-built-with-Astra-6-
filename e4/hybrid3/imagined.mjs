// Imagined / mimed / pretended objects. The renderer draws every noun it is given, whatever qualifier travels with it, so an object that is
// not physically there has to be written as the MOTION that suggests it, never as a noun phrase.
//
// Defined by the qualifier class and the syntactic relation, not by any noun:
//   (1) qualifier + noun phrase:   QUALIFIER (modifier){0,2} NOUN              "an imaginary X", "a mimed X"
//   (2) cognition / make-believe verb + determiner-led noun phrase:           "imagining the X", "pretends to hold a X", "mimes a X"
//   (3) "as if" / "as though" + handling participle or verb + determiner-led noun phrase:  "as if gripping a X"
// A qualifier with no noun phrase after it ("the plan was imagined.") names nothing and is not flagged.
import { protect, restore } from './text.mjs';
import { HOLD } from './spatial.mjs';

const QUALIFIERS = new Set(['imagined', 'imaginary', 'pretend', 'pretended', 'mimed', 'make-believe', 'phantom', 'illusory', 'fictitious', 'nonexistent', 'non-existent', 'unreal', 'fictional']);
const MAKE_BELIEVE = /^(?:imagin(?:e|es|ed|ing)|pretend(?:s|ed|ing)?|mim(?:e|es|ed|ing))$/i;
const AS_IF = /^as$/i;
const IF_THOUGH = /^(?:if|though)$/i;
const DETERMINER = new Set(['a', 'an', 'the', 'his', 'her', 'their', 'its', 'some', 'one', 'two', 'three', 'that', 'this', 'those', 'these', 'each', 'every', 'my', 'your', 'our']);
const FUNCTION = new Set(('and or but then while as until before after when where which who whom whose that with without from to toward towards into onto through past across along around over under above below behind beyond beside between near by at in on of for up down out off away is are was were be being been has have had do does did not no never nor so if than very more most both each every any some it he she they them him his her its their i you we').split(' '));
const WORD = /<Subject \d+>|[A-Za-z]+(?:['’-][A-Za-z]+)*|[^\sA-Za-z]/g;
const isWord = (t) => /^[A-Za-z]/.test(t);

// Noun phrase after position i: up to three consecutive content words; the phrase must end on a word (not punctuation) to count as named.
function nounPhrase(toks, i, { needDeterminer = false } = {}) {
  let j = i;
  if (needDeterminer) {
    if (!(j < toks.length && DETERMINER.has(toks[j].toLowerCase()))) return null;
    j += 1;
  } else while (j < toks.length && DETERMINER.has(toks[j].toLowerCase())) j += 1;
  const words = [];
  while (j < toks.length && words.length < 3 && isWord(toks[j]) && !FUNCTION.has(toks[j].toLowerCase()) && !DETERMINER.has(toks[j].toLowerCase())) { words.push(toks[j]); j += 1; }
  return words.length ? words.join(' ') : null;
}

export function imaginedObjects(sentence) {
  const { text, atoms } = protect(sentence);
  const toks = (text.match(WORD) || []).filter((t) => t.trim());
  const hits = [];
  for (let i = 0; i < toks.length; i++) {
    const w = toks[i].toLowerCase();
    if (QUALIFIERS.has(w)) {
      const np = nounPhrase(toks, i + 1);
      if (np) hits.push({ kind: 'qualifier', trigger: toks[i], noun: np });
    } else if (MAKE_BELIEVE.test(w)) {
      let j = i + 1;
      if (toks[j]?.toLowerCase() === 'to' && isWord(toks[j + 1] || '')) j += 2;
      const np = nounPhrase(toks, j, { needDeterminer: true });
      if (np) hits.push({ kind: 'make_believe', trigger: toks[i], noun: np });
    } else if (AS_IF.test(w) && IF_THOUGH.test(toks[i + 1] || '') && HOLD.has((toks[i + 2] || '').toLowerCase())) {
      const np = nounPhrase(toks, i + 3, { needDeterminer: true });
      if (np) hits.push({ kind: 'as_if', trigger: `as ${toks[i + 1]} ${toks[i + 2]}`, noun: np });
    }
  }
  return hits.map((h) => ({ ...h, trigger: restore(h.trigger, atoms), noun: restore(h.noun, atoms) }));
}
