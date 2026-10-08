// Spatial settled facts and their check.
//
// FACTS are read out of the shot's own spec (scene_direction, acting_scene, the subject definitions) by grammatical relation, never invented:
// if the spec is silent about where something is, there is no fact. Each fact keeps the spec clause it came from.
//   side       a subject's frame side:               "<name> ... frame left", "the right-side presence of the pair"
//   motion     locomotion relative to a landmark:     LOCOMOTION verb + direction preposition + noun phrase
//   orient     facing / pointing relative to a landmark:  ORIENT verb + direction preposition + noun phrase
//   axis       a noun phrase placed ahead of / behind a person:   "X extended ahead of her"
//   colocate   two subjects placed at / against / beside the same landmark (so on the same side of it)
//   holds      the holder of a carried object:        HOLD verb + determiner-led noun phrase, in that character's own acting entry
//
// CHECKS read the written prose with the same relations and flag a contradiction of a fact, or a within-cut frame-side flip:
//   - a direction preposition of the opposite polarity on the same landmark for the same subject
//   - the same noun phrase placed behind where the fact says ahead (or the reverse)
//   - a landmark written as standing between / separating two subjects the spec placed at that landmark
//   - an object written in the hands of a subject other than the one the spec gives it to
//   - a subject placed on the opposite frame side to the spec, or on both sides inside one cut with no movement in between
import { sentences } from './lib.mjs';
import { titleCase } from '../templater/load.mjs';
import { segments } from './cuts.mjs';

const inflect = (b) => {
  const e = b.endsWith('e') ? b.slice(0, -1) : b;
  const dbl = /[^aeiou][aeiou][^aeiouwy]$/.test(b) ? b + b.slice(-1) : b;
  return [b, `${b}s`, `${b}es`, b.endsWith('y') ? `${b.slice(0, -1)}ies` : `${b}s`, `${e}ed`, `${b}ed`, `${e}ing`, `${dbl}ing`, `${dbl}ed`];
};
const verbSet = (bases, extra = []) => new Set([...bases.flatMap(inflect), ...extra]);

const LOCOMOTION = verbSet(['walk', 'run', 'step', 'move', 'climb', 'cross', 'wade', 'advance', 'retreat', 'approach', 'rush', 'hurry', 'sprint', 'scramble', 'stride', 'march', 'enter', 'exit', 'leave', 'flee', 'go', 'come', 'ascend', 'descend', 'stagger', 'stumble', 'dash', 'crawl', 'sneak', 'lunge', 'swim'], ['ran', 'left', 'fled', 'went', 'came', 'goes']);
const ORIENT = verbSet(['face', 'point', 'aim', 'angle', 'turn', 'lean'], []);
export const HOLD = verbSet(['hold', 'grip', 'clutch', 'carry', 'wield', 'cradle', 'grasp', 'brandish', 'clasp'], ['held', 'carried', 'gripped', 'clutched']);

const TOWARD = ['toward', 'towards', 'to', 'into', 'onto', 'up'];
const AWAY = ['away from', 'out of', 'off', 'from', 'down'];
const OPPOSITE = {
  toward: ['away from', 'out of', 'from', 'off'], towards: ['away from', 'out of', 'from', 'off'], to: ['away from', 'out of', 'from', 'off'],
  into: ['out of', 'away from', 'from', 'off'], onto: ['off', 'away from', 'from'], up: ['down'], down: ['up'],
  'away from': ['toward', 'towards', 'to', 'into', 'onto'], 'out of': ['into', 'toward', 'towards', 'to'], from: ['toward', 'towards', 'to', 'into'], off: ['onto', 'toward', 'towards'],
};
// prepositions that give a heading (an endpoint or a direction of travel); onto / into / to / from / off name a surface or an edge and are not required to be restated
const HEADING = new Set(['toward', 'towards', 'away from', 'up', 'down', 'out of']);
const DIR_PREPS = new Set([...TOWARD, ...AWAY]);
const DETERMINER = new Set(['a', 'an', 'the', 'his', 'her', 'their', 'its', 'this', 'that', 'these', 'those', 'each', 'every', 'some', 'one', 'two', 'both', 'my', 'your', 'our']);
const STOP = new Set(('and or but then while as until before after when where which who whom whose that with without from to toward towards into onto through past across along around over under above below behind beyond beside between near by at in on of for up down out off away against beside beneath upon inside outside is are was were be being been he she they them him it so if than not no never nor its his her their each').split(' '));
const SIDE_OPP = { near: ['far', 'opposite', 'other'], far: ['near', 'same'], same: ['opposite', 'far', 'other'], opposite: ['same', 'near'], other: ['same', 'near'], inside: ['outside'], outside: ['inside'] };
const COLOCATE = new Set(['against', 'beside', 'by', 'near', 'at', 'along']);
const FRONT = ['ahead of', 'in front of', 'ahead', 'forward of'];
const BACK = ['behind', 'back over', 'to the rear of'];

const PARTICIPLE = /^(?:extended|held|pointing|pointed|aimed|raised|thrown|cast|stretched|trailing|reaching|out|swinging|sweeping|lifted)$/i;
// a pronoun is the object of the preposition (not a possessive) when what follows is punctuation, the end, or a function word
const objectEnds = (toks, k) => !toks[k] || !isWord(toks[k]) || STOP.has(String(toks[k]).toLowerCase());
const TOKEN = /<Subject \d+>|[A-Za-z]+(?:['’-][A-Za-z]+)*|[,.;:—–()]/g;
const tokenize = (s) => String(s).match(TOKEN) || [];
const norm = (w) => { const x = String(w).toLowerCase(); return x.length > 4 ? x.replace(/ies$/, 'y').replace(/s$/, '') : x; };
const isWord = (t) => /^[A-Za-z]/.test(t || '');
const isSubjTok = (t) => /^<Subject \d+>$/.test(t || '');

// Noun phrase starting at toks[i]: determiners skipped, up to three content words, stops at a function word or punctuation.
// A subject token is a phrase of its own.
const POSSESSIVE = new Set(['his', 'her', 'their', 'its', 'my', 'your', 'our']);
const CAMERA_NOUNS = new Set(['frame', 'shot', 'camera', 'lens', 'screen', 'image', 'view', 'angle', 'take']);
function nounPhrase(toks, i) {
  let j = i, det = null;
  while (j < toks.length && DETERMINER.has(String(toks[j]).toLowerCase())) { det = det || String(toks[j]).toLowerCase(); j += 1; }
  if (isSubjTok(toks[j])) return { text: toks[j], words: [toks[j]], head: toks[j], end: j + 1, det };
  const words = [];
  while (j < toks.length && words.length < 3 && isWord(toks[j]) && !STOP.has(toks[j].toLowerCase()) && !DETERMINER.has(toks[j].toLowerCase())) { words.push(toks[j]); j += 1; }
  return words.length ? { text: words.join(' '), words, head: norm(words[words.length - 1]), end: j, det, possessed: POSSESSIVE.has(det) || /^(?:own|free|other|bare)$/.test(words[0].toLowerCase()), camera: CAMERA_NOUNS.has(words[words.length - 1].toLowerCase()) } : null;
}

function prepAt(toks, i) {
  const a = String(toks[i] || '').toLowerCase(), b = String(toks[i + 1] || '').toLowerCase();
  if ((a === 'away' && b === 'from') || (a === 'out' && b === 'of')) return { prep: `${a} ${b}`, len: 2 };
  if (DIR_PREPS.has(a)) return { prep: a, len: 1 };
  return null;
}

// Character table of a shot: <Subject n> token and the surface names the spec uses for that character.
export function characters(shot) {
  const out = [];
  (shot.references || []).forEach((r, i) => {
    if (r.type !== 'character') return;
    const names = new Set();
    const id = String(r.id).split('__')[0];
    id.split(/[_\s-]+/).filter((w) => w.length >= 3).forEach((w) => names.add(w.toLowerCase()));
    const m = new RegExp(`<Subject ${i + 1}> is ([A-Z][a-z]+(?: [A-Z][a-z]+)?)`).exec(shot.subjectDefinitions || '');
    if (m) m[1].split(' ').forEach((w) => names.add(w.toLowerCase()));
    out.push({ n: i + 1, token: `<Subject ${i + 1}>`, id, names });
  });
  return out;
}

const clip = (c) => (c.length <= 200 ? c : `${c.slice(0, c.lastIndexOf(' ', 200))} ...`);
const specClauses = (text) => String(text || '').split(/(?<=[.;!?])\s+|\s[—–]\s|;/).map((c) => c.trim()).filter(Boolean);

// subject of a position: the nearest character name before it in the clause, else the owner of the field
function subjectAt(toks, pos, chars, owner) {
  for (let k = pos - 1; k >= 0; k--) {
    const w = String(toks[k]).toLowerCase();
    const c = chars.find((x) => x.names.has(w) || x.token === toks[k]);
    if (c) return c;
  }
  return owner || null;
}

// a frame-side phrase belongs to the subject that directly precedes it: at most six tokens back, with no punctuation between,
// and any other subject token (a place or an object) in between means the phrase is about that one
function adjacentSubject(toks, pos, resolve) {
  for (let k = pos - 1; k >= Math.max(0, pos - 6); k--) {
    if (/^[.;:,—–()]$/.test(toks[k])) return null;
    if (isSubjTok(toks[k])) return resolve(toks[k]) || null;
    const c = resolve(String(toks[k]).toLowerCase());
    if (c) return c;
  }
  return null;
}

const relationsIn = (toks, kind, verbs) => {
  const out = [];
  for (let i = 0; i < toks.length; i++) {
    if (!verbs.has(String(toks[i]).toLowerCase())) continue;
    for (let j = i + 1; j < Math.min(toks.length, i + 9); j++) {
      if (/^[.;:,—–]$/.test(toks[j])) break;
      const p = prepAt(toks, j);
      if (!p) continue;
      if (p.prep === 'to' && !(DETERMINER.has(String(toks[j + 1]).toLowerCase()) || isSubjTok(toks[j + 1]))) continue;
      const np = nounPhrase(toks, j + p.len);
      if (np && !np.possessed && !np.camera && (np.det || isSubjTok(np.head) || /^[A-Z]/.test(np.words[0]))) out.push({ kind, verbAt: i, verb: toks[i], prep: p.prep, np });
    }
  }
  return out;
};

export function extractFacts(shot) {
  const chars = characters(shot);
  const facts = [];
  const byName = (w) => chars.find((c) => c.names.has(String(w).toLowerCase()));
  const landmark = (np) => {
    const c = byName(np.words[0]) || (isSubjTok(np.head) ? chars.find((x) => x.token === np.head) : null);
    return c ? { head: c.token, text: c.token } : { head: np.head, text: np.text };
  };
  const fields = [];
  const d = shot.direction || {};
  for (const k of ['whatItShows', 'cameraAngle', 'microAction', 'eyeTrace', 'endsOnState']) if (d[k]) fields.push({ src: `direction.${k}`, text: d[k], owner: null });
  if (shot.breakdown?.purpose) fields.push({ src: 'breakdown.purpose', text: shot.breakdown.purpose, owner: null });
  for (const a of shot.acting || []) {
    const owner = chars.find((c) => c.id === String(a.characterId).split('__')[0]) || null;
    for (const k of ['behaviours', 'interactingWith']) if (a[k]) fields.push({ src: `acting.${a.characterId}.${k}`, text: a[k], owner });
  }
  if (shot.subjectDefinitions) fields.push({ src: 'subjectDefinitions', text: shot.subjectDefinitions, owner: null, subjDefs: true });

  const seen = new Set();
  const push = (f) => { const key = JSON.stringify([f.kind, f.subject, f.rel, f.landmark, f.dir, f.head]); if (!seen.has(key)) { seen.add(key); facts.push(f); } };
  for (const fld of fields) {
    for (const clause of specClauses(fld.text)) {
      let owner = fld.owner;
      let scope = clause;
      if (fld.subjDefs) {
        const m = /^<Subject (\d+)>/.exec(clause);
        owner = m ? chars.find((c) => c.n === Number(m[1])) || null : null;
        if (!owner) continue;
      }
      const toks = tokenize(scope);
      // side
      const sideRe = /\b(?:frame|screen)[- ](left|right)\b|\b(left|right)[- ](?:hand |side )?(?:side|half|third|edge|presence)(?: of (?:the )?(?:frame|screen|pair))?\b|\b(?:on|at|to) the (left|right) of (?:the )?(?:frame|screen)\b/gi;
      for (const m of scope.matchAll(sideRe)) {
        const pos = tokenize(scope.slice(0, m.index)).length;
        const named = toks.some((t) => chars.some((c) => c.names.has(String(t).toLowerCase()) || c.token === t));
        const who = adjacentSubject(toks, pos, (w) => chars.find((c) => c.names.has(w) || c.token === w)) || (!named ? owner : null);
        if (!who) continue;
        const side = (m[1] || m[2] || m[3]).toLowerCase();
        push({ kind: 'side', subject: who.n, rel: side, source: fld.src, clause: clip(clause) });
      }
      // motion / orient
      for (const kind of [['motion', LOCOMOTION], ['orient', ORIENT]]) {
        for (const r of relationsIn(toks, kind[0], kind[1])) {
          const who = subjectAt(toks, r.verbAt, chars, owner);
          if (!who) continue;
                    const lm = landmark(r.np);
          if (lm.head === who.token) continue;
          push({ kind: kind[0], subject: who.n, rel: r.prep, landmark: lm.head, landmarkText: lm.text, source: fld.src, clause: clip(clause) });
        }
      }
      const low = toks.map((t) => String(t).toLowerCase());
      // barrier side: "on the near / far / same / opposite side of NP", "inside / outside NP"
      for (const [i, w] of low.entries()) {
        let word = null, npAt = -1;
        if (w === 'side' && low[i + 1] === 'of' && SIDE_OPP[low[i - 1]]) { word = low[i - 1]; npAt = i + 2; }
        else if ((w === 'inside' || w === 'outside')) { word = w; npAt = low[i + 1] === 'of' ? i + 2 : i + 1; }
        if (!word) continue;
        const who = subjectAt(toks, i, chars, owner);
        const np = nounPhrase(toks, npAt);
        if (!who || !np || isSubjTok(np.head)) continue;
        push({ kind: 'bside', subject: who.n, rel: word, head: np.head, text: np.text, source: fld.src, clause: clip(clause) });
      }
      // axis: a noun phrase ahead of / behind a person
      for (let i = 0; i < low.length; i++) {
        for (const [dirName, list] of [['front', FRONT], ['back', BACK]]) {
          for (const ph of list) {
            const pw = ph.split(' ');
            if (!pw.every((w, k) => low[i + k] === w)) continue;
            const after = low[i + pw.length];
            if (!objectEnds(toks, i + pw.length + 1)) continue;
            const ref = after && /^(?:her|his|him)$/.test(after) ? 'owner' : null;
            if (!ref && !chars.some((c) => c.names.has(after))) continue;
            const who = chars.find((c) => c.names.has(after)) || owner;
            if (!who) continue;
            // the noun phrase directly before: walk back over content words
            let s = i - 1, part = false;
            while (s >= 0 && PARTICIPLE.test(low[s])) { s -= 1; part = true; }
            const words = [];
            while (s >= 0 && isWord(toks[s]) && !STOP.has(low[s]) && !DETERMINER.has(low[s]) && words.length < 3) { words.unshift(toks[s]); s -= 1; }
            if (!words.length || /^(?:own|free|other|bare)$/.test(words[0].toLowerCase()) || CAMERA_NOUNS.has(words[words.length - 1].toLowerCase())) continue;
            if (!part && !DETERMINER.has(low[s])) continue;
            push({ kind: 'axis', subject: who.n, rel: dirName, words: words.map(norm), head: norm(words[words.length - 1]), text: words.join(' '), source: fld.src, clause: clip(clause) });
          }
        }
      }
      // colocate
      for (let i = 0; i < toks.length; i++) {
        if (!COLOCATE.has(low[i])) continue;
        const who = subjectAt(toks, i, chars, owner);
        const np = nounPhrase(toks, i + 1);
        if (!who || !np || isSubjTok(np.head) || byName(np.words[0]) || np.possessed || np.camera) continue;
        push({ kind: 'colocate', subject: who.n, rel: low[i], head: np.head, text: np.text, source: fld.src, clause: clip(clause) });
      }
      // holds (only in a character's own acting entry)
      if (owner && fld.src.startsWith('acting.')) {
        for (let i = 0; i < toks.length; i++) {
          if (!HOLD.has(low[i])) continue;
          const j = DETERMINER.has(low[i + 1]) ? i + 1 : -1;
          if (j < 0) continue;
          const np = nounPhrase(toks, j);
          if (np && !isSubjTok(np.head) && !np.camera) push({ kind: 'holds', subject: owner.n, head: np.head, words: np.words.map(norm), text: np.text, source: fld.src, clause: clip(clause) });
        }
      }
    }
  }
  // a landmark claimed by two characters under holds is ambiguous: no fact
  const holdsBy = new Map();
  for (const f of facts.filter((x) => x.kind === 'holds')) holdsBy.set(f.head, new Set([...(holdsBy.get(f.head) || []), f.subject]));
  const colocated = new Map();
  for (const f of facts.filter((x) => x.kind === 'colocate')) colocated.set(f.head, new Set([...(colocated.get(f.head) || []), f.subject]));
  return facts
    .filter((f) => f.kind !== 'holds' || holdsBy.get(f.head).size === 1)
    .filter((f) => f.kind !== 'colocate' || colocated.get(f.head).size >= 2);
}

const tok = (n) => `<Subject ${n}>`;
export function renderFacts(facts, shot) {
  const chars = characters(shot);
  const nameOf = (n) => { const c = chars.find((x) => x.n === n); if (!c) return tok(n);
    const label = titleCase(c.id);
    return `${tok(n)} (${label})`; };
  const out = [];
  for (const f of facts.filter((x) => x.kind === 'side')) out.push(`- ${nameOf(f.subject)} is on the ${f.rel} of the frame (spec: "${f.clause}")`);
  for (const f of facts.filter((x) => x.kind === 'motion')) out.push(`- ${nameOf(f.subject)} moves ${f.rel} ${f.landmarkText} (spec: "${f.clause}")`);
  for (const f of facts.filter((x) => x.kind === 'orient')) out.push(`- ${nameOf(f.subject)} is oriented ${f.rel} ${f.landmarkText} (spec: "${f.clause}")`);
  for (const f of facts.filter((x) => x.kind === 'axis')) out.push(`- ${f.text} is ${f.rel === 'front' ? 'ahead of' : 'behind'} ${nameOf(f.subject)} (spec: "${f.clause}")`);
  for (const f of facts.filter((x) => x.kind === 'bside')) out.push(`- ${nameOf(f.subject)} is ${f.rel === 'inside' || f.rel === 'outside' ? f.rel : `on the ${f.rel} side of`} ${f.text} (spec: "${f.clause}")`);
  const groups = new Map();
  for (const f of facts.filter((x) => x.kind === 'colocate')) groups.set(f.head, [...(groups.get(f.head) || []), f]);
  for (const [, g] of groups) out.push(`- ${[...new Map(g.map((f) => [f.subject, `${nameOf(f.subject)} ${f.rel} ${f.text}`])).values()].join('; ')}: these subjects share the same side of ${g[0].text} (spec: "${g[0].clause}")`);
  for (const f of facts.filter((x) => x.kind === 'holds')) out.push(`- ${nameOf(f.subject)} holds ${f.text} (spec: "${f.clause}")`);
  if (!out.length) return null;
  return `- Spatial staging stated by this shot's own spec (keep it consistent, do not reverse it; anything the spec does not state is yours to decide):\n${out.map((l) => `  ${l}`).join('\n')}`;
}

// ---- checks ----------------------------------------------------------------------------------------------------------------------------

export function checkSpatial(prose, shot, facts) {
  const chars = characters(shot);
  if (!chars.length) return [];
  const dd = sentences(prose.detailedDescription);
  const only = chars.length === 1 ? chars[0] : null;
  const out = [];
  const flag = (idx, match, message) => { if (!out.some((o) => o.idx === idx && o.match === match)) out.push({ src: 'lint', code: 'spatial', field: 'detailedDescription', idx, match, message }); };
  const subjOf = (toks, pos) => {
    for (let k = pos - 1; k >= 0; k--) { const c = chars.find((x) => x.token === toks[k]); if (c) return c; }
    return only;
  };
  const get = (k) => facts.filter((f) => f.kind === k);

  dd.forEach((sentence, idx) => {
    const withoutDialogue = sentence.replace(/<d>[\s\S]*?<\/d>/g, ' ');
    const toks = tokenize(withoutDialogue);
    const low = toks.map((t) => t.toLowerCase());
    // motion / orient contradictions
    for (const [kind, verbs] of [['motion', LOCOMOTION], ['orient', ORIENT]]) {
      for (const r of relationsIn(toks, kind, verbs)) {
        const who = subjOf(toks, r.verbAt);
        if (!who) continue;
        for (const f of get(kind).filter((x) => x.subject === who.n)) {
          const lm = (isSubjTok(r.np.head) ? r.np.head : r.np.head);
          if (norm(lm) !== norm(f.landmark) && lm !== f.landmark) continue;
          if ((OPPOSITE[f.rel] || []).includes(r.prep)) flag(idx, `${r.verb} ${r.prep} ${r.np.text}`, `the spec has ${tok(f.subject)} ${f.rel} ${f.landmarkText}; this sentence has ${r.prep} ${r.np.text}`);
        }
      }
    }
    // axis contradictions
    for (const f of get('axis')) {
      const opposite = f.rel === 'front' ? BACK : FRONT;
      for (let i = 0; i < low.length; i++) {
        for (const ph of opposite) {
          const pw = ph.split(' ');
          if (!pw.every((w, k) => low[i + k] === w)) continue;
          const after = low[i + pw.length];
          if (!objectEnds(toks, i + pw.length + 1)) continue;
          let s = i - 1;
          while (s >= 0 && PARTICIPLE.test(low[s])) s -= 1;
          const words = [];
          while (s >= 0 && isWord(toks[s]) && !STOP.has(low[s]) && !DETERMINER.has(low[s]) && words.length < 3) { words.unshift(norm(toks[s])); s -= 1; }
          if (!words.length || !words.some((w) => f.words.includes(w))) continue;
          const who = subjOf(toks, i);
          if (who && who.n !== f.subject) continue;
          flag(idx, `${words.join(' ')} ${ph}`, `the spec puts ${f.text} ${f.rel === 'front' ? 'ahead of' : 'behind'} ${tok(f.subject)}; this sentence puts it ${ph}`);
        }
      }
    }
    // barrier side contradictions
    for (let i = 0; i < toks.length; i++) {
      let word = null, npAt = -1;
      if (low[i] === 'side' && low[i + 1] === 'of' && SIDE_OPP[low[i - 1]]) { word = low[i - 1]; npAt = i + 2; }
      else if (low[i] === 'inside' || low[i] === 'outside') { word = low[i]; npAt = low[i + 1] === 'of' ? i + 2 : i + 1; }
      if (!word) continue;
      const np = nounPhrase(toks, npAt);
      const who = subjOf(toks, i);
      if (!np || !who) continue;
      for (const f of get('bside').filter((x) => x.subject === who.n && x.head === np.head)) if ((SIDE_OPP[f.rel] || []).includes(word)) flag(idx, `${word} ${np.text}`, `the spec puts ${tok(who.n)} ${f.rel === 'inside' || f.rel === 'outside' ? f.rel : `on the ${f.rel} side of`} ${f.text}; this sentence puts them ${word === 'inside' || word === 'outside' ? word : `on the ${word} side of`} it`);
    }
    // between / separating two colocated subjects
    const groups = new Map();
    for (const f of get('colocate')) groups.set(f.head, [...(groups.get(f.head) || []), f]);
    for (const [head, g] of groups) {
      if (!low.some((w) => norm(w) === head)) continue;
      const pair = [...new Set(g.map((f) => f.subject))];
      const m = /\b(?:between|separat\w+|divid\w+|splitting)\b/i.exec(withoutDialogue);
      if (!m) continue;
      const present = pair.filter((n) => withoutDialogue.includes(tok(n)));
      if (present.length >= 2) flag(idx, `${head} ${m[0]}`, `the spec places ${present.map(tok).join(' and ')} at the same ${head}; this sentence puts it between them`);
    }
    // holder swaps
    for (const f of get('holds')) {
      for (let i = 0; i < toks.length; i++) {
        if (HOLD.has(low[i]) && DETERMINER.has(low[i + 1])) {
          const np = nounPhrase(toks, i + 1);
          if (np && np.words.map(norm).includes(f.head)) {
            const who = subjOf(toks, i);
            if (who && who.n !== f.subject) flag(idx, `${toks[i]} ${np.text}`, `the spec gives ${f.text} to ${tok(f.subject)}; this sentence has ${tok(who.n)} holding it`);
          }
        }
      }
      const poss = new RegExp(`(<Subject (\\d+)>)['’]s\\s+(?:[a-z-]+\\s+){0,2}${f.head}s?\\b`, 'gi');
      for (const m of withoutDialogue.matchAll(poss)) if (Number(m[2]) !== f.subject && chars.some((c) => c.n === Number(m[2]))) flag(idx, m[0], `the spec gives ${f.text} to ${tok(f.subject)}; this sentence gives it to ${m[1]}`);
    }
  });

  // a motion fact the prose never states: no sentence that names the landmark also carries a locomotion verb
  for (const f of get('motion').filter((x) => HEADING.has(x.rel))) {
    const at = [];
    let stated = false;
    dd.forEach((sentence, idx) => {
      const toks = tokenize(sentence.replace(/<d>[\s\S]*?<\/d>/g, ' '));
      if (!toks.some((t) => norm(t) === norm(f.landmark) || t === f.landmark)) return;
      at.push(idx);
      if (toks.some((t, k) => LOCOMOTION.has(t.toLowerCase()) && norm(t) !== norm(f.landmark) && !DETERMINER.has(String(toks[k - 1] || '').toLowerCase()))) stated = true;
    });
    if (stated) continue;
    const idx = at.length ? at[0] : dd.findIndex((sentence) => sentence.includes(tok(f.subject)) && tokenize(sentence).some((t) => LOCOMOTION.has(t.toLowerCase())));
    if (idx >= 0) flag(idx, `${f.rel} ${f.landmarkText}`, `the spec has ${tok(f.subject)} moving ${f.rel} ${f.landmarkText}; no sentence about ${f.landmarkText} says ${tok(f.subject)} moves ${f.rel} it`);
  }

  // frame side against the spec, and flips inside one cut
  const sideRe = /\b(?:frame|screen)[- ](left|right)\b|\b(left|right)[- ](?:hand )?(?:side|half|third) of (?:the )?(?:frame|screen)\b/gi;
  const segs = segments(prose.detailedDescription);
  const spans = segs.length ? segs : [{ start: 0, end: String(prose.detailedDescription || '').length, text: String(prose.detailedDescription || ''), n: 1 }];
  const MOVEMENT = /\b(?:crosses?|crossing|moves?|moving|steps?|stepping|shifts?|shifting|walks?|walking|passes?|passing|swaps?|swapping|turns?|turning|slides?|sliding|drifts?|drifting|rises?|enters?|exits?|leaves?|travels?|swings?|circles?|orbits?|arcs?|pans?|trucks?)\b/i;
  const full = String(prose.detailedDescription || '');
  const seenSide = new Map();
  spans.forEach((span, si) => {
    for (const m of span.text.matchAll(sideRe)) {
      const abs = span.start + m.index;
      const before = full.slice(0, abs);
      const lastSentenceStart = Math.max(before.lastIndexOf('. '), before.lastIndexOf('! '), before.lastIndexOf('? '), before.lastIndexOf('] '));
      const lead = full.slice(Math.max(0, lastSentenceStart + 1), abs);
      const toksLead = tokenize(lead);
      const who = adjacentSubject(toksLead, toksLead.length, (w) => chars.find((c) => c.token === w));
      if (!who) continue;
      const side = (m[1] || m[2]).toLowerCase();
      const idx = dd.findIndex((s) => s.includes(full.slice(abs, abs + m[0].length)) && s.includes(lead.trim().slice(0, 30)));
      const sentenceIdx = idx >= 0 ? idx : dd.findIndex((s) => s.includes(m[0]));
      if (sentenceIdx < 0) continue;
      const moves = MOVEMENT.test(dd[sentenceIdx]);
      const key = `${si}:${who.n}`;
      const prev = seenSide.get(key);
      if (prev && prev.side !== side && !moves && !prev.moves) flag(sentenceIdx, `${tok(who.n)} frame ${side}`, `${tok(who.n)} is on the frame ${prev.side} earlier in this cut and on the frame ${side} here with no movement between`);
      if (!prev) seenSide.set(key, { side, moves });
      if (si === 0 && !moves) {
        for (const f of get('side').filter((x) => x.subject === who.n)) if (f.rel !== side) flag(sentenceIdx, `${tok(who.n)} frame ${side}`, `the spec puts ${tok(who.n)} on the ${f.rel} of the frame; this sentence puts them on the ${side}`);
      }
    }
  });
  return out;
}

