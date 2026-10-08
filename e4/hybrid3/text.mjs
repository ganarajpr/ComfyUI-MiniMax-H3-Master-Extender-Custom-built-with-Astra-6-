// Text plumbing for the deterministic rules: protected atoms, clause segments, grammar guards.
import { cameraTerms } from './lint3.mjs';

const PUA = 0xe000;
const ATOM_RE = /<d>[\s\S]*?<\/d>|\[[^\]\n]{1,40}\]|<Subject \d+>|\(S\d+\)|\b\d{1,2}:\d{2}(?:\.\d+)?\b/g;

// Everything the format treats as machine-checked (dialogue tags, [Shot n], cut timecodes, <Subject n>, (Sn)) becomes one private-use
// character, so no rule can read, split or delete through it.
export function protect(text) {
  const atoms = [];
  const out = String(text).replace(ATOM_RE, (m) => { atoms.push(m); return String.fromCharCode(PUA + atoms.length - 1); });
  return { text: out, atoms };
}
export const restore = (text, atoms) => text.replace(/[-]/g, (c) => atoms[c.charCodeAt(0) - PUA] ?? c);
export const isAtom = (w) => /^[-]$/.test(w);

export const WORD_RE = /[-]|[A-Za-z]+(?:['’-][A-Za-z]+)*|\d+/g;
export const wordsOf = (s) => String(s).match(WORD_RE) || [];
export const plainWords = (s) => wordsOf(s).filter((w) => !isAtom(w));

const DELIM_RE = /(\s*[—–]\s*|\s-\s|[,;:]\s+)/g;

export function segmentize(sentence) {
  const m = /([.!?]+["”’')]*)\s*$/.exec(sentence);
  const term = m ? m[1] : '';
  const body = m ? sentence.slice(0, m.index) : sentence;
  const segs = [], delims = [];
  let last = 0, mm;
  DELIM_RE.lastIndex = 0;
  while ((mm = DELIM_RE.exec(body))) { segs.push(body.slice(last, mm.index)); delims.push(mm[0]); last = mm.index + mm[0].length; }
  segs.push(body.slice(last));
  return { segs, delims, term };
}
export const joinSegs = ({ segs, delims, term }) => segs.map((s, i) => s + (i < delims.length ? delims[i] : '')).join('') + term;

// Words a phrase cannot end on without being a broken sentence.
const DANGLING = new Set(('a an the of to in on at by for from with into onto upon over under through toward towards as than that which who whom whose where when while if so but and or nor yet ' +
  'his its their my your our this these those he she they is are was were be been being has have had do does did very more most both each every any some another').split(' '));
export const dangles = (body) => { const w = plainWords(body.replace(/[-]/g, ' ')); const last = (w[w.length - 1] || '').toLowerCase(); return !last || DANGLING.has(last); };

export function tidy(s) {
  return s.replace(/\s+([,.;:!?])/g, '$1').replace(/([,;:])\s*(?=[,;:])/g, '').replace(/,\s*(?=[.!?]|$)/g, '').replace(/\s*[—–]\s*(?=[.!?]|$)/g, '')
    .replace(/(?:^|(?<=[,;:]))\s*(?:and|but|or|yet|while)\s*(?=[.!?]|$)/gi, '').replace(/\s{2,}/g, ' ').trim();
}

const countOf = (s, ch) => s.split(ch).length - 1;
// A removal is acceptable only if the sentence is still a sentence and nothing the format checks was touched.
export function sentenceStillSound(before, after) {
  const b = protect(before), a = protect(after);
  if (JSON.stringify(b.atoms) !== JSON.stringify(a.atoms)) return 'atom_changed';
  if (JSON.stringify(cameraTerms(restore(b.text, b.atoms))) !== JSON.stringify(cameraTerms(restore(a.text, a.atoms)))) return 'camera_term_changed';
  const body = a.text.replace(/[.!?]+["”’')]*\s*$/, '');
  if (plainWords(body).length < 3) return 'too_short';
  if (dangles(body)) return 'dangling_end';
  if (countOf(after, '(') !== countOf(after, ')') || countOf(after, '"') % 2) return 'unbalanced';
  if (/[,;:]\s*[,;:]|\s[—–]\s*[—–]/.test(after)) return 'punctuation';
  return null;
}

// Replace each sentence of `text` with fn(sentence) in place, leaving all other characters exactly as they were.
export function mapSentences(text, splitter, fn) {
  let out = '', cursor = 0;
  for (const s of splitter(text)) {
    const at = text.indexOf(s, cursor);
    if (at < 0) continue;
    out += text.slice(cursor, at) + fn(s);
    cursor = at + s.length;
  }
  return out + text.slice(cursor);
}
