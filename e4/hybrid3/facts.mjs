// The short SETTLED FACTS block appended to the exact shot_prose prompt: only high-confidence, generic facts. v3: no single-take fact (the production cut rules apply),
// a cut plan where the spec licenses one, and spatial facts read out of the shot's own spec.
import { titleCase } from '../templater/load.mjs';
import { derivePlan } from './cuts.mjs';
import { extractFacts, renderFacts } from './spatial.mjs';

const POSTURE_CLAUSE = /\b(?:sits?|seated|stands?|standing|kneels?|kneeling|lies|lying|crouch\w*|climbs?|climbing)\b/i;

export function planFact(plan) {
  if (!plan) return null;
  if (plan.cuts === 1) return 'Cut plan: this shot\'s own direction asks for one continuous take, so write a single bare [Shot 1] and no later cut.';
  const second = plan.silentSecond
    ? 'The shot licenses exactly one spoken line, so the second cut is SILENT: a physical reaction shot of the listener with no <d> tag and no speech-shaped wording, at least 90 words.'
    : 'Carry the spoken lines in their ledger order across the two cuts.';
  return `Cut plan: two cuts (dialogue between two characters). A bare [Shot 1] for the wide two-shot, then "[Shot 2] At MM:SS.mmm, the shot cuts to ..." for the closer cut, with a time later than the opening and no later than the duration. Each cut carries its own controlled camera-motion term. ${second}`;
}

export function settledFacts(fix, shot) {
  const lang = (l) => l.language || fix.continuity.language || 'English';
  const tokenOf = (id) => { const i = shot.references.findIndex((r) => r.id === id); return i === -1 ? null : `<Subject ${i + 1}>`; };
  const lines = shot.lines.map((l, i) => `  ${i + 1}. (${l.id}) ${tokenOf(l.speaker) || l.speaker} says <d>[${lang(l)}] ${l.text}</d>`);
  const out = ['SETTLED FACTS FOR THIS SHOT (do not contradict)'];
  if (lines.length) {
    out.push(`- This shot carries exactly ${lines.length} spoken line${lines.length > 1 ? 's' : ''}, in this order, each verbatim, each written as "<Subject N> (Sn), in the voice of ..., says: <d>[Language] text</d>" with the speaker token and (Sn) id shown here:`);
    out.push(...lines);
  } else out.push('- No spoken lines in this shot: write no <d> tag and no speech.');
  const plan = planFact(derivePlan(shot));
  if (plan) out.push(`- ${plan}`);
  out.push('- non_diegetic_music is exactly: N/A');
  out.push('- Write every absence as a substitution: name what IS there, never what is not. Before: "He does not turn around." After: "He keeps his eyes on the water." Before: "No light reaches the corner." After: "The corner stays in shadow."');
  out.push('- If a gesture suggests an object that is not physically in the shot (a mimed, pretended or imagined one), write only the motion of the hands and body. Never name that object and never label it as imagined. Before: "her hand lifts an imagined whistle to her lips." After: "her hand curls and rises to her lips, her cheeks drawing in."');
  const posture = [];
  for (const a of shot.acting || []) {
    const clause = String(a.behaviours || '').split(/[;,—]|\s-\s/).map((c) => c.trim()).find((c) => POSTURE_CLAUSE.test(c));
    if (clause) posture.push(`  - ${tokenOf(a.characterId) || titleCase(a.characterId)} (${titleCase(a.characterId)}), per this shot's own spec: "${clause}"`);
  }
  if (posture.length) { out.push('- Body position stated by this shot\'s own spec:'); out.push(...posture); }
  const spatial = renderFacts(extractFacts(shot), shot);
  if (spatial) out.push(spatial);
  return out.join('\n');
}

export function withFacts(basePrompt, facts) { return `${basePrompt}\n\n${facts}\n`; }
