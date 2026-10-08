// NEGATED PRESENCE: a clause that asserts an entity, sound, person or event is ABSENT or does NOT happen.
// Naming a thing tells the renderer to draw it, so a clause that says its object is absent still asks for the object; the clause is the unit.
// Words that merely contain a negative lexeme but assert something present, and camera/technical language, are not negated presence.
import { protect, restore, segmentize, joinSegs, wordsOf, plainWords, isAtom, sentenceStillSound, tidy } from '../../hybrid3/text.mjs';

const TRIGGER_RE = new RegExp(
  '\\b(?:no longer|rather than|instead of|no one|just (?:outside|beyond) the frame|outside the frame|off-?screen|cannot|nonexistent|[a-z]+n[\'’]t|not|never|without|nothing|nobody|none|nowhere|neither|nor|no(?![-\\w])|' +
  'absent|absence|devoid|lacking|lacks|lack|missing|unseen|invisible|gone|barely|hardly|scarcely|rarely|seldom|silence|silent|silently|soundless|muted?|vanish(?:es|ed|ing)?)\\b', 'gi');

const APPROXIMATOR = new Set(['barely', 'hardly', 'scarcely', 'rarely', 'seldom']);
const QUIET_STATE = new Set(['silence', 'silent', 'silently', 'soundless', 'mute', 'muted']);
const CLAUSE_NEGATORS = new Set(['not', 'never', 'no longer', 'neither', 'nor', 'nothing', 'nobody', 'none', 'nowhere', 'no', 'no one', 'cannot']);
const ADJUNCT_PREPS = new Set(['without', 'rather than', 'instead of']);
const LEXICAL = new Set(['absent', 'absence', 'devoid', 'lacking', 'lacks', 'lack', 'missing', 'unseen', 'invisible', 'gone', 'nonexistent', 'off-screen', 'offscreen', 'outside the frame', 'just outside the frame', 'just beyond the frame']);
const COORD = new Set(['and', 'but', 'or', 'yet', 'while', 'then', 'as', 'so']);
const RELATIVIZERS = new Set(['who', 'whom', 'whose', 'which', 'that', 'where', 'when', 'because', 'although', 'though', 'if', 'unless', 'until']);
const GONE_ABSENT_FOLLOWERS = new Set(['from', 'by', 'out', 'away', 'and', 'but', 'or', 'nor', 'as', 'while', 'now', 'then']);
const CAMERA_NOUN = new Set(['camera', 'lens', 'frame', 'framing', 'shot', 'take', 'angle', 'focus', 'image', 'view', 'viewpoint']);
const CAMERA_OPERATION = new Set(['cut', 'cuts', 'cutting', 'drift', 'drifting', 'shake', 'shaking', 'tremor', 'wobble', 'jitter', 'zoom', 'zooming', 'pan', 'panning', 'tilt', 'tilting', 'dolly', 'edit', 'editing', 'transition', 'jump', 'reframe', 'reframing', 'refocus', 'refocusing', 'timecode', 'timecodes', 'marker', 'markers']);
const CAMERA_VERB = new Set(['move', 'moves', 'moving', 'motion', 'movement', 'cut', 'cuts', 'drift', 'drifts', 'shake', 'shakes', 'waver', 'wavers', 'wavering', 'break', 'breaks', 'blink', 'blinks', 'change', 'changes', 'reframe', 'reframes', 'zoom', 'zooms', 'pan', 'pans', 'tilt', 'tilts', 'jump', 'jumps', 'lose', 'loses', 'leave', 'leaves', 'adjust', 'adjusts', 'follow', 'follows']);

const POSITIVE_FOLLOW = {
  nothing: /^\s*(?:but|more than|less than|short of|other than|else but)\b/i,
  none: /^\s*other than\b/i,
  no: /^\s*(?:(?:more|less|fewer) than|sooner|matter|doubt)\b/i,
  not: /^\s*(?:only|just|merely|simply|unlike|to mention)\b/i,
};
const SUBORDINATORS = /\s(?:while|as|until|when|whenever|before|after|because|although|though|where|which|who|whose|then|so)\b/i;
const HEDGE_BEFORE = /\b(?:whether|if|or)\s+$/i;

// E4.6: `off-screen` is the official guide's own marker for a voice or a speaker who is heard and not shown ("<Subject N> (Sx), off-screen, says",
// "an off-screen voiceover"), so it is not an assertion of absence when the sentence carries a speaker id or says voice or voiceover.
// Anywhere else the word still asserts that something is not in the frame and stays a negated presence. This file is hybrid3/negation.mjs plus this exception, nothing else.
export const OFFSCREEN_MARKER_CONTEXT = /\(S\d+\)|\boff-?screen[- ]voice(?:-?over)?\b/i;

// All triggers in one segment, each tagged NP (negated presence) or EXEMPT with the reason.
export function classifySegment(seg, { prevSeg = '', marked = false } = {}) {
  const out = [];
  TRIGGER_RE.lastIndex = 0;
  let m;
  const lowerAll = seg.toLowerCase();
  while ((m = TRIGGER_RE.exec(seg))) {
    const trig = m[0].toLowerCase().replace(/^just /, 'just ');
    const key = /^(?:off-?screen)$/.test(trig) ? 'off-screen' : trig;
    const before = seg.slice(0, m.index), after = seg.slice(m.index + m[0].length);
    const rec = { trigger: m[0], index: m.index, end: m.index + m[0].length, key, kind: 'NP', reason: 'asserts_absence' };
    const nextWords = plainWords(after).map((w) => w.toLowerCase());
    const next3 = nextWords.slice(0, 3), next4 = nextWords.slice(0, 4);
    if (key === 'off-screen' && marked) { rec.kind = 'EXEMPT'; rec.reason = 'guide_offscreen_marker'; }
    else if (APPROXIMATOR.has(key)) { rec.kind = 'EXEMPT'; rec.reason = 'approximator_asserts_weak_presence'; }
    else if (QUIET_STATE.has(key)) { rec.kind = 'EXEMPT'; rec.reason = 'quiet_state_noun_or_adjective'; }
    else if (/^vanish/.test(key)) { rec.kind = 'EXEMPT'; rec.reason = 'disappearance_event_asserts_an_event'; }
    else if (key === 'gone') {
      const nxt = (after.match(/^[\s]*([A-Za-z]+|[^\sA-Za-z])?/) || [])[1];
      const absentReading = !nxt || !/^[A-Za-z]/.test(nxt) || GONE_ABSENT_FOLLOWERS.has(nxt.toLowerCase());
      if (!absentReading) { rec.kind = 'EXEMPT'; rec.reason = 'change_of_state_complement'; }
    } else if (POSITIVE_FOLLOW[key] && POSITIVE_FOLLOW[key].test(after)) { rec.kind = 'EXEMPT'; rec.reason = 'idiom_asserts_what_follows'; }
    else if (key === 'not' && HEDGE_BEFORE.test(before)) { rec.kind = 'EXEMPT'; rec.reason = 'hedge_idiom'; }
    if (rec.kind === 'NP') {
      const camSubject = [...wordsOf(lowerAll)].some((w) => CAMERA_NOUN.has(w)) ||
        (plainWords(before).length <= 1 && wordsOf(prevSeg.toLowerCase()).some((w) => CAMERA_NOUN.has(w)));
      if (next3.some((w) => CAMERA_OPERATION.has(w)) || (camSubject && next4.some((w) => CAMERA_VERB.has(w)))) { rec.kind = 'EXEMPT'; rec.reason = 'camera_or_technical_language'; }
    }
    out.push(rec);
  }
  return out;
}

// Every trigger in a sentence, with segment coordinates.
export function classifySentence(sentence) {
  const P = protect(sentence);
  const sg = segmentize(P.text);
  const res = [];
  const marked = OFFSCREEN_MARKER_CONTEXT.test(sentence);
  sg.segs.forEach((seg, i) => {
    for (const r of classifySegment(seg, { prevSeg: sg.segs[i - 1] || '', marked })) res.push({ ...r, segIdx: i, segText: restore(seg, P.atoms) });
  });
  return res;
}
export const negatedPresences = (sentence) => classifySentence(sentence).filter((r) => r.kind === 'NP');

// Plan the removal of one NP: the whole separable segment, or the trailing adjunct that starts at the trigger.
function plan(sg, np) {
  const seg = sg.segs[np.segIdx];
  const before = seg.slice(0, np.index);
  let pw = plainWords(before).map((w) => w.toLowerCase());
  let startCut = np.index;
  const lead = before.match(/(?:\s|^)(with)\s*$/i);
  if (lead) { startCut = before.length - lead[0].replace(/^\s/, '').length - (lead[0].startsWith(' ') ? 0 : 0); pw = pw.slice(0, -1); }
  while (pw.length && COORD.has(pw[pw.length - 1]) && np.key !== 'rather than' && np.key !== 'instead of') { pw = pw.slice(0, -1); }
  const leadersOnly = pw.every((w) => COORD.has(w));
  const wholeOK = np.segIdx >= 1 && !pw.some((w) => RELATIVIZERS.has(w));
  const clauseLevel = CLAUSE_NEGATORS.has(np.key) || LEXICAL.has(np.key);
  if (leadersOnly) return wholeOK ? { mode: 'segment' } : { decline: np.segIdx === 0 ? 'sentence_initial_clause' : 'relativizer_lead' };
  const coordBefore = plainWords(before).length && COORD.has(plainWords(before).slice(-1)[0].toLowerCase());
  if (coordBefore && pw.length >= 1 && /^(?:never|not|no longer)$|n['’]t$/.test(np.key) && !pw.some((w) => RELATIVIZERS.has(w))) return { mode: 'adjunct' };
  if (clauseLevel && pw.length <= 3 && wholeOK) return { mode: 'segment' };
  if (clauseLevel && pw.length <= 3 && np.segIdx === 0) return { mode: 'decline', decline: 'main_clause_is_the_negation' };
  if (ADJUNCT_PREPS.has(np.key) || (coordBefore && /^(?:never|not|no longer)$/.test(np.key))) {
    if (pw.length < 2) return { decline: 'adjunct_without_a_clause' };
    return { mode: 'adjunct' };
  }
  return { decline: 'not_separable' };
}

// Try to delete one negated-presence clause from a sentence. Returns {ok, text, removed} or {ok:false, reason}.
export function removeNegatedClause(sentence, np) {
  const P = protect(sentence);
  const sg = segmentize(P.text);
  const seg = sg.segs[np.segIdx];
  if (seg === undefined) return { ok: false, reason: 'segment_not_found' };
  const next = { segs: [...sg.segs], delims: [...sg.delims], term: sg.term };
  let removed;
  const afterTrig = seg.slice(np.end);
  const corr = /^((?:\s+[\w'’-]+){1,8}?)\s+but\s+/i.exec(afterTrig);
  const p = corr && /^(?:not|no longer|never)$|n['’]t$/.test(np.key) ? { mode: 'correction' } : plan(sg, np);
  if (p.decline || p.mode === 'decline') return { ok: false, reason: p.decline };
  if (p.mode === 'correction') {
    // contrastive correction "not X but Y": the negated alternative and the "but" go, Y stays
    removed = restore(seg.slice(np.index, np.end + corr[0].length), P.atoms).trim();
    next.segs[np.segIdx] = seg.slice(0, np.index) + afterTrig.slice(corr[0].length);
  } else if (p.mode === 'segment') {
    removed = restore(seg, P.atoms);
    const i = np.segIdx;
    if (i === next.segs.length - 1) { next.segs.splice(i, 1); next.delims.splice(i - 1, 1); }
    else { next.segs.splice(i, 1); next.delims.splice(i - 1, 1); }
  } else {
    const before = seg.slice(0, np.index);
    const lead = before.match(/\s+(?:with)\s*$/i);
    let cutAt = lead ? before.length - lead[0].length : np.index;
    let keep = seg.slice(0, cutAt).replace(/[\s]+$/, '');
    keep = keep.replace(/\s+(?:and|but|or|yet|while)\s*$/i, '');
    const sub = SUBORDINATORS.exec(seg.slice(np.end));
    const tail = sub ? seg.slice(np.end + sub.index) : '';
    removed = restore(seg.slice(keep.length, tail ? seg.length - tail.length : undefined), P.atoms).trim();
    next.segs[np.segIdx] = keep + tail;
  }
  let text = restore(joinSegs(next), P.atoms);
  text = tidy(text);
  const bad = sentenceStillSound(sentence, text);
  if (bad) return { ok: false, reason: bad };
  return { ok: true, text, removed };
}

// Apply removals to a sentence until nothing removable is left. `declined` lists NPs left for the LLM.
export function stripNegatedPresence(sentence) {
  let cur = sentence;
  const edits = [], declined = new Map();
  for (let guard = 0; guard < 8; guard++) {
    const nps = negatedPresences(cur);
    let applied = false;
    for (const np of nps.reverse()) {
      const key = `${np.key}|${np.segText.slice(0, 50)}`;
      if (declined.has(key)) continue;
      const r = removeNegatedClause(cur, np);
      if (r.ok) { edits.push({ rule: 'negation_removed', trigger: np.trigger, removed: r.removed, before: cur, after: r.text }); cur = r.text; applied = true; break; }
      declined.set(key, { rule: 'negation_declined', trigger: np.trigger, reason: r.reason, sentence: cur });
    }
    if (!applied) break;
  }
  const stillNP = negatedPresences(cur).map((n) => `${n.key}|${n.segText.slice(0, 50)}`);
  return { text: cur, edits, declined: [...declined.entries()].filter(([k]) => stillNP.includes(k)).map(([, v]) => v) };
}
