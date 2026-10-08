// Validation for v3: the pipeline's auditShot gates (which enforce the production cut rules: bare [Shot 1], timed strictly increasing cuts no later than the
// duration, a controlled camera term in EVERY cut, the word floor scaled by the marker count, a speech-free silent cut) plus the lint,
// where the lint's word-level negation and music findings are the v2 definitions, and the v3 additions: cut plan, imagined objects, spatial facts.
import { auditShot } from '../../audit/dist/index.js';
import { lintShot } from './lint3.mjs';
import { sentences } from '../../hybrid3/lib.mjs';
import { MUSIC_VOCAB } from '../../templater/lexicon.mjs';
import { negatedPresences } from './negation.mjs';
import { classifyMusic } from '../../hybrid3/music.mjs';
import { FIELDS } from './deterministic.mjs';
import { derivePlan, planFindings, segments, fmtTime } from '../../hybrid3/cuts.mjs';
import { imaginedObjects } from '../../hybrid3/imagined.mjs';
import { extractFacts, checkSpatial } from '../../hybrid3/spatial.mjs';
import { soundVocabFindings } from '../soundvocab.mjs';
import { offscreenFindings } from '../offscreen.mjs';
import { speechProse } from '../utterance.mjs';

const VOCAL = /\b(?:voices?|whispers?|whispered|murmurs?|murmured|shouts?|words?)\b/i;

// strict = the lint as the templater defines it (minus the single-take rules, which production does not have) + the gates, for reporting.
export function strictValidation(fix, shot, prose) {
  const raw = [];
  const ls = lintShot({ detailedDescription: prose.detailedDescription, overallSoundscape: prose.overallSoundscape, summary: prose.summary, nonDiegeticMusic: prose.nonDiegeticMusic });
  for (const f of ls) raw.push({ src: 'lint', code: f.rule, field: f.field, match: f.match });
  const refShot = fix.refs.shots.find((s) => s.id === shot.id);
  let gate = [];
  try {
    gate = auditShot({ ...refShot, ...prose, id: shot.id }, (fix.split.shots || []).find((s) => s.id === shot.id), fix.ledger, fix.continuity, fix.granted).findings;
  } catch (e) { raw.push({ src: 'gate', code: 'AUDIT_ERROR', message: String(e.message || e) }); }
  // E4.6: a voice has no <Subject>, so the audit's subject-based attribution cannot apply to its lines (speakers.mjs checks them in the voice form), and a film that
  // wants a score carries it in non_diegetic_music instead of the N/A sentinel.
  const voiceLine = (g) => { const id = /ledger id "([^"]+)"/.exec(g.message || '')?.[1]; return shot.lines.some((l) => l.id === id && l.voice); };
  for (const g of gate) {
    if (['DIALOGUE_NO_SPEAKER', 'DIALOGUE_SPEAKER_MISMATCH', 'DIALOGUE_SUBJECT_OUT_OF_RANGE'].includes(g.code) && voiceLine(g)) continue;
    if (g.code === 'MUSIC_SENTINEL_VIOLATED' && fix.score === 'on') continue;
    raw.push({ src: 'gate', code: g.code, message: g.message, span: g.span, hint: g.hint, operation: g.operation });
  }
  return fix.score === 'on' ? raw.filter((f) => !(f.src === 'lint' && f.code === 'sentinel')) : raw;
}

export function runValidation(fix, shot, prose) {
  const strict = strictValidation(fix, shot, prose);
  const kept = strict.filter((f) => !(f.src === 'lint' && (f.code === 'negation' || f.code === 'music')));
  const sem = [];
  for (const field of FIELDS) {
    const arr = sentences(prose[field]);
    arr.forEach((s, idx) => {
      for (const np of negatedPresences(s)) sem.push({ src: 'lint', code: 'negation', field, idx, match: np.trigger, message: `${np.segText.trim().slice(0, 140)}` });
      for (const h of classifyMusic(s, field)) if (h.sense === 'musical') sem.push({ src: 'lint', code: 'music', field, idx, match: h.word });
      for (const h of imaginedObjects(s)) sem.push({ src: 'lint', code: 'imagined', field, idx, match: h.trigger, message: `${h.trigger} ${h.noun}` });
    });
  }
  sem.push(...soundVocabFindings(prose, { score: fix.score }));
  sem.push(...offscreenFindings({ shot, prose, sents: sentences(prose.detailedDescription) }));
  for (const h of speechProse(prose.detailedDescription)) sem.push({ src: 'lint', code: 'speech_prose', field: 'detailedDescription', idx: h.idx, match: h.match, message: `"${h.match}" in: ${h.sentence.slice(0, 160)}` });
  const plan = derivePlan(shot);
  sem.push(...planFindings(prose, plan));
  sem.push(...checkSpatial(prose, shot, extractFacts(shot)));
  return { findings: [...kept, ...sem], strict, plan };
}

const NEG_WORDS = "no, not, never, none, nothing, nobody, nowhere, neither, nor, without, cannot, any word ending in n't, no longer, rather than, instead of, absent, absence, devoid, lacking, lacks, barely, hardly, rarely, seldom, scarcely, unseen, invisible, missing, vanishes, silence, silent, silently, soundless, mute, muted, gone, off-screen, outside the frame";
export const RULE = {
  negation: 'contains a clause that asserts something is ABSENT or does NOT happen (naming it tells the renderer to draw it). Rewrite that clause as a positive substitution (say what IS there or what the character DOES instead), or drop the clause if the sentence stands without it. Do not use no / not / never / without / nothing / rather than / instead of / absent for anything in the picture.',
  narration: 'is craft or director narration. Do not use: the audience, the viewer, we see/feel, reads as, state change, feel / feels / feeling / felt, the dread, the trap, symbol, metaphor, subjective, objective fact, giving way to. Rewrite it as only what is visible or audible in the frame.',
  label: 'contains a "Label: value" construction (a phrase followed by a colon). Use no colon at all: rewrite it as an ordinary sentence with a verb.',
  music: 'uses a word in its musical sense (music, rhythm, beat, tempo, score, melody and the like). Rewrite it without music or rhythm vocabulary.',
  imagined: 'names an object that is imagined, mimed, pretended or otherwise not physically there. The renderer draws every noun it is given, so that object would appear in the picture. Rewrite the sentence so it describes ONLY the motion (what the hand, fingers or body does, where it moves and how) and does not name the object or label it as imagined / mimed / pretend / invisible.',
  spatial: 'contradicts where this shot\'s own spec puts a subject or an object (see the detail below and the SPATIAL staging facts). Rewrite the sentence so it agrees with the spec; keep the rest of the sentence.',
  cut_plan: 'is part of a cut structure that does not follow this shot\'s cut plan (see the settled facts).',
  CUT_MISSING_TIMESTAMP: 'opens a later cut without its time. Every cut after the first is written "[Shot N] At MM:SS.mmm, the shot cuts to ..." with a time later than the previous cut and no later than the duration. Keep the [Shot N] marker, add the time.',
  CUT_TIME_NOT_INCREASING: 'has a cut time that is not strictly later than the previous cut. Change only the time so it is later than the previous cut and no later than the duration.',
  CUT_TIME_OUT_OF_BOUNDS: 'has a cut time later than the shot duration. Change only the time so it is earlier than the duration and later than the previous cut.',
  SHOT_ONE_HAS_TIMESTAMP: 'writes [Shot 1] with a time. [Shot 1] is bare: remove the time and the words "At ...", keep the sentence.',
  CAMERA_MOTION_MISSING: 'opens a cut with no controlled camera-motion term. Include exactly one of these terms spelled as listed, as natural English inside this cut\'s own sentence: Zoom In, Zoom Out, Push In, Pull Out, Pan Left, Pan Right, Truck Left, Truck Right, Tilt Up, Tilt Down, Pedestal Up, Pedestal Down, Arc Shot, Tracking Shot, Static Shot, Shake Slightly, Shake Strongly, POV, Roll Clockwise, Roll Counterclockwise.',
  EYELINE_NOT_STATED: 'must state the eyeline direction of the single framed person: include the exact phrase "off-frame LEFT" or "off-frame RIGHT".',
  BLOCKING_NOT_STATED: 'must say where on the frame the person is: include "frame left" or "frame right" (or "LEFT half" / "RIGHT half").',
  DETAILED_DESCRIPTION_TOO_SHORT: 'is too short overall.',
  soundvocab: 'uses a word the renderer hears as music (hum, drone, resonance, resonant, tone, chord, sustained note, swell, pulse, thrum, throb). Rewrite it so every sound is named by its concrete physical source and action (rain tapping a window, a hinge creaking, a boot scuffing a floor, cloth rubbing, a switch clicking), with none of those words.',
  offscreen_framing: 'belongs to a cut where a line is spoken off-screen, and H3 lip-syncs the face it sees. Either frame this cut on the place the voice carries from with no character in view, or state in the sentence about each visible character that the lips are pressed shut, in those positive words (never that the character does not speak or is silent).',
  speech_prose: 'describes counting, reciting, chanting, calling or whispering with no <d> line in the sentence, so the renderer would improvise the words. Rewrite it as only what is physical (breath, posture, gaze, movement); every spoken word stays inside the <d> lines.',
  DIALOGUE_VOICE_FORM: 'is the line of a voice that has no picture. Write it as one sentence "a <voice description> (Sx), off-screen, says: <d>[Language] text</d>" with the Sx given in the hint and no <Subject N> token in that sentence.',
  SOUNDSCAPE_VOCAL_WORD: 'the soundscape must not use the words voice, whisper, murmur, shout or word. Use "speech", "hushed speech", "hum", "cry", "phrase" instead.',
};
void NEG_WORDS; void MUSIC_VOCAB;

export function mapFindings(findings, prose, shot) {
  const dd = sentences(prose.detailedDescription), ss = sentences(prose.overallSoundscape), su = sentences(prose.summary);
  let expand = null;
  const T = new Map(), unmapped = [];
  const add = (field, idx, rule, hint) => {
    if (idx < 0) return false;
    const k = `${field}:${idx}`;
    const t = T.get(k) || { field, idx, rules: [], hints: [] };
    if (!t.rules.includes(rule)) t.rules.push(rule);
    if (hint && !t.hints.includes(hint)) t.hints.push(hint);
    T.set(k, t);
    return true;
  };
  const find = (arr, needle) => (needle ? arr.findIndex((s) => s.toLowerCase().includes(String(needle).toLowerCase())) : -1);
  const dTagIdx = (n) => { let c = 0; for (let i = 0; i < dd.length; i++) { const m = dd[i].match(/<d>/g); if (m) { c += m.length; if (c >= n) return i; } } return -1; };
  const camIdx = dd.findIndex((s) => /\[Shot 1\]/.test(s));
  const markerIdx = (n) => dd.findIndex((s) => new RegExp(`\\[Shot\\s+${n}\\]`).test(s));
  const growExpand = (words, cut) => { expand = { words: Math.max(expand?.words || 0, words), cut: cut || expand?.cut || null }; };
  for (const f of findings) {
    let ok = false;
    if (f.src === 'lint') {
      const fld = f.field === 'overallSoundscape' ? 'overallSoundscape' : f.field === 'summary' ? 'summary' : 'detailedDescription';
      const arr = fld === 'overallSoundscape' ? ss : fld === 'summary' ? su : dd;
      const hint = f.code === 'negation' && f.message ? `clause: "${f.message}"` : ['imagined', 'spatial', 'soundvocab', 'offscreen_framing', 'speech_prose'].includes(f.code) && f.message ? `detail: ${f.message}` : '';
      if (f.idx !== undefined) ok = add(fld, f.idx, f.code, hint);
      else if (['negation', 'narration', 'label', 'music', 'soundvocab', 'speech_prose'].includes(f.code)) ok = add(fld, find(arr, f.match), f.code);
      else if (f.code === 'cut_plan') {
        if (f.missing) {
          const dur = Number(prose.duration) || 10;
          const segs = segments(prose.detailedDescription);
          const last = segs.reduce((m, s) => Math.max(m, s.at || 0), 0);
          const t = Math.min(dur - 0.5, Math.max(last + 1, Math.round(dur * 0.55 * 1000) / 1000));
          const plan = shot ? derivePlan(shot) : null;
          growExpand(110, { n: segs.length + 1, time: fmtTime(t), silent: !!plan?.silentSecond });
          ok = true;
        } else if (f.extra) {
          const firstExtra = dd.findIndex((s) => /\[Shot (?:[2-9]|\d{2,})\]/.test(s));
          if (firstExtra >= 0) { for (let i = firstExtra; i < dd.length; i++) add('detailedDescription', i, 'cut_plan', 'this shot is one continuous take: fold what these sentences describe into the single take (no [Shot 2], no time), keep any spoken line exactly'); ok = true; }
        }
      }
    } else if (f.src === 'gate') {
      if (/^DIALOGUE_/.test(f.code) || f.code === 'SPEECH_WITHOUT_WORDS') {
        const n = Number(/#(\d+)/.exec(f.message || '')?.[1] || 0);
        if (n) ok = add('detailedDescription', dTagIdx(n), f.code, f.hint ? `${f.code}: ${f.hint}` : f.message);
        else if (f.code === 'SPEECH_WITHOUT_WORDS') { const q = /"([^"]{12,})"/.exec(f.message || ''); ok = add('detailedDescription', find(dd, q ? q[1].slice(0, 25) : ''), f.code, f.message); }
      } else if (f.code === 'EYELINE_NOT_STATED' || f.code === 'BLOCKING_NOT_STATED') { const n = Number(/\[Shot (\d+)\]/.exec(f.message || '')?.[1] || 1); const at = markerIdx(n); ok = add('detailedDescription', at >= 0 ? at : camIdx, f.code, n > 1 ? `this applies to the cut that opens with [Shot ${n}]: state it in that cut's own sentence` : ''); }
      else if (f.code === 'DETAILED_DESCRIPTION_TOO_SHORT') { const n = Number(/add at least (\d+)/.exec(f.hint || '')?.[1] || 40); growExpand(n); ok = true; }
      else if (f.code === 'SOUNDSCAPE_VOCAL_WORD') { const i = ss.findIndex((s) => VOCAL.test(s)); ok = add('overallSoundscape', i, f.code); }
      else if (f.code === 'CAMERA_MOTION_MISSING') { const n = Number(/\[Shot (\d+)\]/.exec(f.message || '')?.[1] || 0); ok = add('detailedDescription', markerIdx(n), f.code, f.hint ? `use e.g. ${f.hint}` : ''); }
      else if (f.code === 'CUT_MISSING_TIMESTAMP' || f.code === 'CUT_TIME_NOT_INCREASING' || f.code === 'CUT_TIME_OUT_OF_BOUNDS') { const n = Number(/\[Shot (\d+)\]/.exec(f.message || '')?.[1] || 0); ok = add('detailedDescription', markerIdx(n), f.code, `duration is ${prose.duration}s; ${f.message}`); }
      else if (f.code === 'SHOT_ONE_HAS_TIMESTAMP') ok = add('detailedDescription', markerIdx(1), f.code);
    }
    if (!ok) unmapped.push(f);
  }
  return { targets: [...T.values()].sort((a, b) => (a.field < b.field ? -1 : a.field > b.field ? 1 : a.idx - b.idx)), unmapped, dd, ss, su, expand };
}
