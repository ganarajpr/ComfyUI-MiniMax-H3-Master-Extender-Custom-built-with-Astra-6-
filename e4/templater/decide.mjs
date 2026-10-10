// Decide step. One Jev call per shot, three kinds of question, all closed lists
// drawn from the film's own data or a published taxonomy:
//
//   tactic   (choice, 45 actioning verbs) what the character is doing to whatever
//            opposes them. Written only into performanceBeats.tactic; it no longer
//            shapes the prose (a manner phrase derived from it contradicted the
//            acting master's carriage in v1).
//   tell     (choice, the character's OWN acting-master entries + "none") which
//            physical tell fits this shot's behaviour/state at its key moment.
//            Candidates are filtered by derive.tellCandidates (no hands when
//            interactingWith is "nothing", no condition-bound crack without its
//            condition in the shot, no legs for a seated shot, cracks only for a
//            real stateChange). Taken only at confidence >= 0.35 and margin >= 0.10.
//   order    (noul, one per pair of events) which event happens first, read off the
//            shot's own text. See order.mjs for the cue check that overrides it.
//
// Never asked: camera move, shot size, effort, tic selection by trigger (22-44% trust).

import { pickChoice } from './jev.mjs';
import { tellCandidates, adaptEntry, feasible, conflicts, shotSpecText, deriveSize, VISIBLE } from './derive.mjs';
import { transitionCandidates } from './state.mjs';
import { buildCandidates, expressionQuestions, readExpressionAnswers } from './expression.mjs';
import { buildEvents } from './events.mjs';
import { orderQuestions, orderFromAnswers, cueVotes, defaultOrder, reconcile } from './order.mjs';

export const TACTICS = [
  'accuse', 'admonish', 'appease', 'badger', 'bargain', 'beg', 'belittle',
  'beseech', 'bluff', 'cajole', 'challenge', 'charm', 'coax', 'command',
  'comfort', 'confess', 'confront', 'deflect', 'defy', 'demand', 'deter',
  'disarm', 'dismiss', 'distract', 'dodge', 'endure', 'evade', 'forbid',
  'goad', 'implore', 'mock', 'needle', 'outface', 'placate', 'plead',
  'provoke', 'rebuff', 'reproach', 'resist', 'shame', 'shield', 'stall',
  'stonewall', 'taunt', 'warn',
];

export const MIN_CONFIDENCE = 0.3;
export const MIN_TELL_CONFIDENCE = 0.35;
export const MIN_TELL_MARGIN = 0.1;

export function parseStateChange(sc) {
  const t = String(sc || '').trim();
  if (!t || /^no change\b/i.test(t)) return null;
  const m = t.match(/^(.*?)\s+to\s+(.*)$/i);
  return m ? { from: m[1].trim(), to: m[2].trim() } : { from: '', to: t };
}

function stateText(film, shot, charId, name) {
  const act = film.actingScene.characters.find((c) => c.characterId === charId) || {};
  const per = shot.acting.find((c) => c.characterId === charId) || {};
  const d = shot.direction;
  const arc = film.scene.shots.map((s) => `${s.id === shot.id ? '>> ' : '   '}${s.id}: ${s.purpose}`).join('\n');
  return [
    `Scene arc (>> marks the beat being decided):\n${arc}`,
    `Character: ${name}`,
    act.objective ? `Wants: ${act.objective}` : '',
    act.obstacle ? `In the way: ${act.obstacle}` : '',
    `This beat shows: ${d.whatItShows}`,
    d.microAction ? `Small action: ${d.microAction}` : '',
    d.soundAnchor ? `Sound: ${d.soundAnchor}` : '',
    per.behaviours ? `What ${name} does: ${per.behaviours}` : '',
    per.lookingAt ? `${name} looks at: ${per.lookingAt}` : '',
    per.stateChange ? `State change in this beat: ${per.stateChange}` : '',
  ].filter(Boolean).join('\n');
}

// Entries that can carry the arrival at the target state in this shot.
export function transitionFor(vocab0, shot, per, pron, size, change) {
  const text = shotSpecText(shot, per);
  const vocab = vocab0.map((e) => adaptEntry(e, text));
  const nothing = /^\s*(?:nothing|none)\b/i.test(String(per.interactingWith || ''));
  const vis = size ? VISIBLE[size] : null;
  const holds = /\b(?:fixed|locked|frozen|still)\b/i.test(text);
  const fit = (e) => !(e.region === 'hands' && nothing) && feasible(e, text) && !conflicts(e, text) && (!vis || vis.includes(e.region))
    && !(e.region === 'eyes' && per.lookingAt && !holds && !/\b(?:widen\w*|jump\w*|catchlight\w*)\b/i.test(e.text));
  return transitionCandidates({ vocab, target: change.to, pron, contrast: shot.direction.contrastLevel, fit });
}

// Master entries the expression layer may draw signatures from: the tells the shot allows, plus the
// entries whose class fits the target state (so a state-bound tell is offered without its playback trigger).
export function eligibleFor(vocab, shot, per, pron, size, change) {
  const out = [...tellCandidates(vocab, shot, per, !!change)];
  if (change) for (const t of transitionFor(vocab, shot, per, pron, size, change)) if (!t.derived && !out.some((e) => e.id === t.id)) out.push(t);
  return out;
}

export function shotCues(shot) {
  const d = shot.direction;
  return [d.whatItShows, d.soundAnchor, d.microAction, ...shot.acting.map((a) => a.behaviours)].join('. ');
}

export async function decideShot(film, shot, jev, vocabByChar, nameByChar, chars, focusId, opts = {}) {
  const out = {};
  const focus = chars.find((c) => c.id === focusId) || chars[0];
  const size = deriveSize(shot.direction.cameraAngle, chars.map((c) => c.name));
  const { events } = buildEvents(film, shot, chars, size);
  const cues = cueVotes(events, shotCues(shot));

  for (const ref of shot.references.filter((r) => r.type === 'character')) {
    const charId = ref.id;
    const name = nameByChar[charId];
    const vocab = vocabByChar[charId] || [];
    const per = shot.acting.find((c) => c.characterId === charId) || {};
    const change = parseStateChange(per.stateChange);
    const questions = {
      tactic: {
        type: 'choice',
        instructions: `In the marked beat, what is ${name} doing to whatever stands in ${name}'s way? Pick the verb that names that action.`,
        criteria: Object.fromEntries(TACTICS.map((v) => [v, v])),
      },
    };
    const trans = change ? transitionFor(vocab, shot, per, chars.find((c) => c.id === charId).pron, size, change) : [];
    const cands = change ? [] : tellCandidates(vocab, shot, per, false);
    if (trans.length > 1) {
      questions.transition = {
        type: 'choice',
        instructions: `${name} arrives at the state "${change.to}" in this beat. Which one physical sign from the list best shows that arrival?`,
        criteria: Object.fromEntries(trans.map((e) => [e.id, e.sentence ? e.sentence.replace(/\.$/, '') : e.text])),
      };
    }
    if (cands.length) {
      questions.tell = {
        type: 'choice',
        instructions: `Which one physical tell from the list best shows ${name} at the key moment of this beat${change ? ` (arriving at "${change.to}")` : ''}?`,
        criteria: { ...Object.fromEntries(cands.map((e) => [e.id, e.text])), none: 'none of these fits this beat' },
      };
    }
    const isFocus = charId === focus.id;
    if (isFocus && events.length > 1) Object.assign(questions, orderQuestions(events));
    const response = await jev.ask(stateText(film, shot, charId, name), questions);
    const tactic = pickChoice(response.answers?.tactic);
    const tell = pickChoice(response.answers?.tell);
    let transition = null;
    if (change) {
      const probs = response.answers?.transition?.probabilities || {};
      const ranked = trans.map((e) => e.id).sort((a, b) => (probs[b] || 0) - (probs[a] || 0));
      transition = { ids: ranked, probs, jev: trans.length > 1 };
    }
    out[charId] = {
      transition,
      tactic: tactic && tactic.confidence >= MIN_CONFIDENCE ? tactic : { ...(tactic || {}), value: null },
      tell: tell && tell.value !== 'none' && tell.confidence >= MIN_TELL_CONFIDENCE && tell.margin >= MIN_TELL_MARGIN ? tell : (tell ? { ...tell, value: null } : null),
    };
    if (isFocus && opts.expression !== false) {
      const chObj = chars.find((c) => c.id === charId);
      const eligible = eligibleFor(vocab, shot, per, chObj.pron, size, change);
      const { candidates, mapping } = buildCandidates({ shot, per, size, pron: chObj.pron, stateTarget: change ? change.to : null, eligibleEntries: eligible, events });
      const lineEv = events.find((e) => e.kind === 'line');
      const keyText = lineEv ? `the line "${lineEv.line.text}" is heard` : (events.length ? events[events.length - 1].text : null);
      let ps = candidates.map(() => null);
      let intensity = null;
      if (candidates.length) {
        const eq = expressionQuestions({ name, stateTarget: change ? change.to : null, keyEvent: keyText, candidates });
        const r2 = await jev.ask(stateText(film, shot, charId, name), eq);
        ({ ps, intensity } = readExpressionAnswers(candidates, r2.answers));
      }
      out.__expr = { stateTarget: change ? change.to : null, keyEvent: keyText, candidates: candidates.map((c, i) => ({ key: c.key, codes: c.codes, source: c.source, p: ps[i] })), intensity, mapping };
    }
    if (isFocus) {
      let order;
      if (events.length > 1) {
        const { ids, detail } = orderFromAnswers(events, response.answers || {});
        const rec = reconcile(shot.id, events, ids, cues);
        order = { ids: rec.ids, jevIds: ids, disagreements: rec.disagreements, pairs: detail, source: 'jev+cues' };
      } else {
        order = { ids: events.map((e) => e.id), jevIds: events.map((e) => e.id), disagreements: [], pairs: {}, source: 'single' };
      }
      out.__order = order;
    }
  }
  return out;
}

// Order when Jev is not consulted.
export function fallbackOrder(shot, events) {
  const cues = cueVotes(events, shotCues(shot));
  return { ids: defaultOrder(events, cues), jevIds: null, disagreements: [], pairs: {}, source: 'cues-only' };
}
