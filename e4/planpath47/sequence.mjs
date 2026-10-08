// E4.6 (issue #7): sequence continuity across the whole film. A line that is a number or a numbered item is a sequence token; the tokens of one
// speaker, and of all speakers together when the story relates them, must continue as the story says. Everything is read from the plan's lines and
// the story text; nothing here knows any story.
//   - per speaker: consecutive tokens step by exactly one in a single direction (no reset, no jump) unless the story says a restart or names the number
//   - across speakers, when the story relates them: a repeat is the same token, "one number later" is the next, "the next number" continues
//   - relations the story states (echo, one number later, the next number) must occur in the lines
const UNITS = { zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19 };
const TENS = { twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90 };
const ORDINALS = { first: 1, third: 3, fourth: 4, fifth: 5, sixth: 6, seventh: 7, eighth: 8, ninth: 9, tenth: 10, eleventh: 11, twelfth: 12, thirteenth: 13, fourteenth: 14, fifteenth: 15, sixteenth: 16, seventeenth: 17, eighteenth: 18, nineteenth: 19, twentieth: 20 };
const FILLER = new Set(['and', 'then', 'now', 'again', 'next']);
const wordsOf = (s) => String(s || '').toLowerCase().replace(/<[^>]*>/g, ' ').match(/\d+|[a-z]+(?:-[a-z]+)*/g) || [];

// Words and digits -> numbers; "twenty-one", "twenty one" and "one hundred and five" are single numbers.
export function parseNumbers(text) {
  const w = wordsOf(text).flatMap((x) => (TENS[x.split('-')[0]] && x.includes('-') ? x.split('-') : [x]));
  const numbers = [], labels = [];
  for (let i = 0; i < w.length; i++) {
    const t = w[i];
    if (/^\d+$/.test(t)) { numbers.push(Number(t)); continue; }
    let v = null;
    if (t in UNITS) { v = UNITS[t]; if (w[i + 1] === 'hundred') { v *= 100; i += 1; if (w[i + 1] === 'and') i += 1; if (w[i + 1] in TENS) { v += TENS[w[i + 1]]; i += 1; if (w[i + 1] in UNITS && UNITS[w[i + 1]] < 10 && UNITS[w[i + 1]] > 0) { v += UNITS[w[i + 1]]; i += 1; } } else if (w[i + 1] in UNITS && UNITS[w[i + 1]] > 0) { v += UNITS[w[i + 1]]; i += 1; } } }
    else if (t in TENS) { v = TENS[t]; if (w[i + 1] in UNITS && UNITS[w[i + 1]] > 0 && UNITS[w[i + 1]] < 10) { v += UNITS[w[i + 1]]; i += 1; } }
    if (v !== null) numbers.push(v); else if (!FILLER.has(t)) labels.push(t);
  }
  return { numbers, labels };
}

// A sequence line is made of numbers with at most one label word ("Four.", "One. Two. Three.", "Level four", "Step 3").
export function sequenceTokens(text) {
  const { numbers, labels } = parseNumbers(text);
  return numbers.length && labels.length <= 1 ? { numbers, label: labels[0] || '' } : null;
}

// What the story says about its numbers. Every field is a phrase class, never a word of one story.
export function storyRelations(story) {
  const t = String(story || '').toLowerCase().replace(/\s+/g, ' ');
  const numbers = new Set();
  for (const m of t.matchAll(/\b(\d+)(?:st|nd|rd|th)?\b/g)) numbers.add(Number(m[1]));
  for (const m of t.matchAll(/\b([a-z]+)\b/g)) if (m[1] in ORDINALS) numbers.add(ORDINALS[m[1]]);
  for (const m of t.matchAll(/\b(?:to|from|until|reaches|reaching|up to|at|number)\s+([a-z]+(?:[- ][a-z]+)?)\b/g)) { const n = parseNumbers(m[1]).numbers; if (n.length === 1 && n[0] > 2) numbers.add(n[0]); }
  const r = {
    down: /\bcount(?:s|ed|ing)?\s+(?:down|backwards?)\b|\bcountdown\b|\bbackwards?\b|\bin reverse\b|\bdescending (?:count|numbers?)\b/.test(t),
    restart: /\b(?:starts?|begins?|restarts?|resets?)\s+(?:over|again)\b|\brestart(?:s|ed)?\b|\bresets?\b|\bagain from\b|\bfrom the (?:beginning|start)\b/.test(t),
    echo: /\bhalf[- ](?:a )?(?:beat|count|second|step)\s+(?:behind|after|late|ahead)\b|\b(?:a )?(?:beat|moment|breath) (?:behind|after|later)\b|\becho(?:es|ed|ing)?\b|\bin unison\b|\bmimic\w*|\bsame (?:number|word|words|count)\b|\brepeat(?:s|ed|ing)?\s+(?:her|his|their|its|the)\b|\bafter (?:her|him|them)\b|\bwith (?:her|him|them)\b/.test(t),
    next: /\b(?:the )?next (?:number|count|one in the (?:count|sequence)|in the (?:count|sequence))\b|\bcontinues? the (?:count|sequence)\b/.test(t),
    offset: 0,
  };
  const off = /\bone (?:number|count) (later|after|ahead|more|earlier|before|behind|less)\b/.exec(t);
  if (off) r.offset = /^(?:later|after|ahead|more)$/.test(off[1]) ? 1 : -1;
  r.related = r.echo || r.next || r.offset !== 0;
  r.numbers = numbers;
  return r;
}

// lines: [{clip, cut, speaker, text}] in film order. -> { issues: [string], unverified: [string], tokens: [...] }
export function sequenceIssues(lines, story) {
  const rel = storyRelations(story);
  const toks = [];
  for (const l of lines) {
    const s = sequenceTokens(l.text);
    if (s) toks.push({ clip: l.clip, cut: l.cut, speaker: l.speaker, nums: s.numbers, label: s.label });
  }
  const issues = [], unverified = [];
  const where = (t) => `clip ${t.clip} shot ${t.cut} (${t.speaker})`;
  const flat = (list) => list.flatMap((t) => t.nums.map((n) => ({ n, t })));
  const run = (stream, scope, allowRepeat) => {
    let dir = rel.down ? -1 : 0;
    for (let i = 1; i < stream.length; i++) {
      const a = stream[i - 1], b = stream[i], step = b.n - a.n;
      if (step === 0) { if (!allowRepeat) issues.push(`${where(b.t)}: ${scope} repeats ${b.n} straight after ${a.n}; a count moves on by one each time unless the story has one speaker repeat another`); continue; }
      if (Math.abs(step) === 1 && (!dir || step === dir)) { dir = step; continue; }
      const stated = rel.numbers.has(b.n) || (rel.restart && b.n <= 1);
      if (!stated) issues.push(`${where(b.t)}: ${scope} goes from ${a.n} to ${b.n}${Math.abs(step) === 1 ? ', against the direction of the count' : ''}; a count continues by one in one direction (${rel.down ? 'down' : 'up'}) and the story states no restart or jump; the number after ${a.n} is ${a.n + (dir || (rel.down ? -1 : 1))}`);
    }
  };
  const speakers = [...new Set(toks.map((t) => t.speaker))];
  const related = rel.related && speakers.length > 1;
  if (related) run(flat(toks), 'the film count', rel.echo);
  else for (const sp of speakers) run(flat(toks.filter((t) => t.speaker === sp)), `${sp}'s count`, rel.echo);
  if (speakers.length > 1) {
    const f = flat(toks);
    const pairs = [];
    for (let i = 0; i < f.length; i++) for (let j = i + 1; j < f.length; j++) if (f[i].t.speaker !== f[j].t.speaker) pairs.push([f[i].n, f[j].n]);
    const last = (t) => t.nums[t.nums.length - 1];
    if (rel.echo && !pairs.some(([a, b]) => a === b)) issues.push('the story has one voice follow or repeat another, but no line repeats a number the other speaker said');
    if (rel.offset && !pairs.some(([a, b]) => b - a === rel.offset)) issues.push(`the story puts one speaker ${rel.offset > 0 ? 'one number later than' : 'one number before'} the other, but no two lines of different speakers differ by one`);
    if (rel.next && toks.length > 1) {
      const t = toks[toks.length - 1], prev = toks[toks.length - 2];
      const dir = rel.down ? -1 : 1;
      if (t.nums[0] - last(prev) !== dir) issues.push(`${where(t)}: the story says the next number, so this line must carry ${last(prev) + dir}, not ${t.nums[0]}`);
    }
  } else if (rel.related && toks.length) unverified.push('the story relates two speakers\' counts but only one speaker has number lines');
  return { issues, unverified, tokens: toks };
}
