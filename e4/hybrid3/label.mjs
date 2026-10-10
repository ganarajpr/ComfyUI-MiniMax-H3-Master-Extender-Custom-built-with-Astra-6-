// LABEL: a short capitalised phrase followed by a colon at the start of a sentence ("Phrase: value") is catalogue/director
// syntax, not prose. The colon becomes a full stop when the value is a clause of its own, a comma when it continues the phrase.
const LABEL_RE = /(?:^|[.!?]\s+)(?:<Subject \d+>\s*)?[A-Z][\w ,'’-]{0,36}:\s/g;

// The text exactly as the lint reads it (dialogue blanked; [Shot n] and "says:" blanked in the description field), with a map back.
function maskedView(text, field) {
  const re = field === 'detailedDescription' ? /<d>[\s\S]*?<\/d>|\[Shot \d+\]|\bsays:\s*/g : /<d>[\s\S]*?<\/d>/g;
  let view = '';
  const map = [];
  let cursor = 0, m;
  while ((m = re.exec(text))) {
    for (let i = cursor; i < m.index; i++) { view += text[i]; map.push(i); }
    view += ' '; map.push(m.index);
    cursor = m.index + m[0].length;
  }
  for (let i = cursor; i < text.length; i++) { view += text[i]; map.push(i); }
  return { view, map };
}

const CLAUSE_STARTERS = new Set(['the', 'a', 'an', 'his', 'her', 'its', 'their', 'my', 'your', 'our', 'this', 'that', 'these', 'those', 'he', 'she', 'they', 'it', 'we', 'you', 'i', 'both', 'each', 'every', 'one', 'two', 'three', 'some', 'another', 'other', 'no', 'nothing', 'nobody', 'none', 'something', 'someone', 'everything', 'everyone', 'there']);

export function labelColons(text, field = 'detailedDescription') {
  const { view, map } = maskedView(text, field);
  const out = [];
  for (const m of view.matchAll(LABEL_RE)) {
    const viewColon = m.index + m[0].length - 2;
    out.push({ at: map[viewColon], label: m[0].trim() });
  }
  return out;
}

export function rewriteLabels(text, field = 'detailedDescription') {
  const hits = labelColons(text, field);
  const edits = [];
  let out = text;
  for (const h of hits.reverse()) {
    if (out[h.at] !== ':') continue;
    let j = h.at + 1;
    while (j < out.length && /\s/.test(out[j])) j++;
    const rest = out.slice(j);
    const first = (/^[A-Za-z]+/.exec(rest) || [''])[0].toLowerCase();
    const clause = /^[<\[A-Z("“]/.test(rest) || CLAUSE_STARTERS.has(first);
    const head = out.slice(0, h.at);
    let tail = out.slice(j);
    if (clause) { tail = tail.replace(/^[a-z]/, (c) => c.toUpperCase()); out = `${head}. ${tail}`; edits.push({ rule: 'label_rewritten', label: h.label, as: 'period' }); }
    else { out = `${head}, ${tail}`; edits.push({ rule: 'label_rewritten', label: h.label, as: 'comma' }); }
  }
  return { text: out, edits };
}
