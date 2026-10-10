// stateChange "A to B" -> the physical transition into B, from the character's OWN
// acting-master vocabulary. Generic acting grammar, no story words:
//   state class  (what kind of state B is)   -> preferred entry classes (what the body does)
// Entries are classified by keyword; a release (surrender, resignation) has no
// entry of its own in most masters, so it is derived by reversing the master's
// tension entries (a high centre of gravity lowers, drawn-up shoulders come down).

export const STATE_CLASSES = {
  ALERT: /\b(alert|startl\w*|wary|tense|recogni\w*|aware|brac\w*|alarm\w*)\b/i,
  SEARCH: /\b(search\w*|scan\w*|seek\w*|hunt\w*|prob\w*)\b/i,
  VERIFY: /\b(verif\w*|confirm\w*|certain|sure|check\w*|test\w*)\b/i,
  RELEASE: /\b(surrender\w*|resign\w*|yield\w*|accept\w*|defeat\w*|settl\w*|submit\w*|slack\w*|collaps\w*)\b/i,
  WAIT: /\b(anticipat\w*|wait\w*|expect\w*|still\w*|frozen|locked|held)\b/i,
};

export const ENTRY_CLASSES = {
  STILL: /\b(freez\w*|fixed|still|locked|stops?|held|hold\w*|rigid|stiff\w*)\b/i,
  GAZEMOVE: /\b(slid\w*|slides|lead\w*|glanc\w*|dart\w*|scan\w*|turn\w*|blink\w*)\b/i,
  CLENCH: /\b(swallow\w*|jaw|clench\w*|sets?|tighten\w*|press(?:es|ed|ing)?|grip\w*)\b/i,
  BREATH: /\b(breath\w*|ribs|inhale|exhale|sigh)\b/i,
  STARTLE: /\b(widen\w*|jump\w*|shrug\w*|flinch\w*|start\w*|catchlights?)\b/i,
  GRAVITY: /\b(center of gravity|centre of gravity|shoulders?|posture|spine)\b/i,
};

export const PREFERRED = {
  ALERT: ['STARTLE', 'STILL', 'BREATH', 'CLENCH'],
  SEARCH: ['GAZEMOVE', 'BREATH'],
  VERIFY: ['CLENCH', 'BREATH', 'GAZEMOVE'],
  RELEASE: [],
  WAIT: ['STILL', 'BREATH'],
};

// Arrival states are written at the end of the take; reactions follow the key event.
export const ARRIVAL = new Set(['RELEASE', 'WAIT']);

const DEGREE = { low: 'slightly', medium: 'visibly', high: 'sharply', max: 'fully' };

export function stateClassesOf(target) {
  return Object.entries(STATE_CLASSES).filter(([, re]) => re.test(target)).map(([k]) => k);
}
export function entryClassesOf(text) {
  return Object.entries(ENTRY_CLASSES).filter(([, re]) => re.test(text)).map(([k]) => k);
}

// Reverse a tension entry into its release. Returns null when the entry has no tense form.
function releaseOf(entry, pron, degree) {
  const t = entry.text;
  if (/center of gravity|centre of gravity/i.test(t) && /\b(high|up|raised)\b/i.test(t)) return `${pron.Poss} center of gravity lowers ${degree}`;
  if (/shoulders?/i.test(t) && /\b(up|drawn|raised|into|forward)\b/i.test(t)) return `${pron.Poss} shoulders come down ${degree} from where they were drawn up`;
  if (/breath/i.test(t) && /\b(shallow\w*|tight|held)\b/i.test(t)) return `${pron.Poss} breath slows and deepens`;
  if (/\bjaw\b|swallow/i.test(t)) return `${pron.Poss} jaw loosens`;
  return null;
}

// Candidates for the physical arrival at state B. Each: { id, text (entry or derived),
// sentence?, cls, region, kind, derived }. `fit` filters by the shot (visibility, spec conflicts).
export function transitionCandidates({ vocab, target, pron, contrast, fit }) {
  const classes = stateClassesOf(target);
  const out = [];
  const seen = new Set();
  for (const sc of classes) {
    if (sc === 'RELEASE') {
      const degree = DEGREE[String(contrast || '').toLowerCase()] || 'visibly';
      for (const e of vocab) {
        const s = releaseOf(e, pron, degree);
        if (s && fit(e) && !seen.has(s)) {
          seen.add(s);
          out.push({ id: `t:${e.id}`, kind: 'transform', region: e.region, text: s, sentence: `${s}.`, derived: true, cls: sc });
        }
      }
      continue;
    }
    for (const want of PREFERRED[sc] || []) {
      for (const e of vocab) {
        if (e.kind === 'mask' || !entryClassesOf(e.text).includes(want) || !fit(e) || seen.has(e.id)) continue;
        seen.add(e.id);
        out.push({ ...e, cls: sc, rank: PREFERRED[sc].indexOf(want) });
      }
    }
  }
  return out;
}
