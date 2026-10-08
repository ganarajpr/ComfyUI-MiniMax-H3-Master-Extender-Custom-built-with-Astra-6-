// LLM call 3: the clip writer. The hybrid3 machinery (production shot_prose rules prompt, settled facts, lint, validate, targeted repair,
// deterministic finish) is imported unchanged. What differs from E0/E2 is only the DATA the rules prompt receives:
// the clip's planned shot list (one H3 generation, planned shots = its internal cuts), settled facts from the plan and the decisions,
// the acting masters of the on-screen characters, and the film plan. The rules sections are byte-identical.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { HERE } from './lib.mjs';
import { CAMERA_LABELS } from './planner.mjs';
import { EFFORTS, UNSTATED } from './decide.mjs';
import { voicesOf } from './speakers.mjs';
import { stateFacts } from './state.mjs';

const SEP = '================================================================';
const HEAD = {
  world: "THE FILM'S WORLD STATE — entities, props, locations and per-character state variants across the whole timeline:\n\n{{world_state}}",
  dir: "THIS SCENE'S OWN DIRECTION SHEET — camera, framing and escalation per beat:\n\n{{scene_direction}}",
  act: "THIS SCENE'S OWN PER-CHARACTER ACTING ADAPTATION:\n\n{{acting_scene}}",
  screenplay: 'THE SCREENPLAY:\n\n{{screenplay}}',
};
const swap = (t, from, to) => { if (!t.includes(from)) throw new Error(`template section not found: ${from.slice(0, 50)}`); return t.replace(from, () => to); };
const fill = (t, vars) => t.replace(/\{\{\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*\}\}/g, (_, n) => { const v = vars[n]; return typeof v === 'string' ? v : JSON.stringify(v); });

export const rawTemplate = () => readFileSync(join(HERE, 'vendor/prompts/shot_prose.md'), 'utf8');
export const shotId = (clipNumber) => `shot${String(clipNumber).padStart(3, '0')}`;

export const MAPPING = (duration, cutCount) => `NOTE FOR THIS RUN — read before the rules. This run supplies no direction sheet, no acting adaptation and no world-state prose. Wherever the rules cite \`scene_direction.shots[]\` (cameraAngle, whatItShows, whyThisAngle, function, contrastLevel, soundAnchor), \`acting_scene\` (behaviours, stateChange, lookingAt, interactingWith, objective, obstacle), the acting profile or \`world_state\`, take that information from the PLANNED SHOT LIST quoted below, the "STAGING AND CAMERA DECIDED" facts at the end of the prompt, the shaping decisions section, the acting profile of each on-screen character, and the state ledger. The one shot you write is ONE H3 generation of ${duration} seconds; the planned shots of the list are its ${cutCount} internal cuts, in that order: write exactly one [Shot N] cut for each planned shot, at the cut times given, covering what that planned shot does. Every other rule below applies exactly as written.`;

export function entityBlock(bible) {
  const np = (e) => (e.refImage === false ? '; no reference picture, describe it fully in the prose' : '');
  const rows = [...bible.cast.map((c) => `- ${c.id}: character, ${c.appearsAs}${np(c)}`), ...bible.props.map((p) => `- ${p.id}: object, ${p.appearsAs}${np(p)}`), ...bible.locations.map((l) => `- ${l.id}: location, ${l.appearsAs}`), ...voicesOf(bible).map((v) => `- ${v.id}: a voice with no picture and no <Subject> number, heard off-screen, ${v.appearsAs}; in the voice of ${v.voicePrompt}`)];
  return rows.join('\n');
}

const tokenOf = (shot, id) => { const i = shot.references.findIndex((r) => r.id === id); return i === -1 ? null : `<Subject ${i + 1}>`; };

// Shaping decisions: govern HOW the performance is written and never appear as words.
export function shapingBlock(shot, rec, bible) {
  const chars = shot.references.filter((r) => r.type === 'character');
  const cutLines = [];
  rec.clip.shots.forEach((s, i) => {
    const k = i + 1;
    const per = chars.map((c) => {
      const tac = rec.picks[`tactic.${k}.${c.id}`], eff = rec.picks[`effort.${k}.${c.id}`];
      if (!tac && !eff) return null;
      return `${tokenOf(shot, c.id)} (${c.id}): tactic = ${tac || UNSTATED}; effort = ${eff ? `${eff} (${EFFORTS[eff]})` : UNSTATED}`;
    }).filter(Boolean);
    if (per.length) cutLines.push(`- cut ${k}: ${per.join(' | ')}`);
  });
  const tics = chars.map((c) => {
    const pick = rec.picks[`tic.${c.id}`];
    const m = /^tic (\d+)$/.exec(pick || '');
    const t = m && bible.cast.find((x) => x.id === c.id)?.acting?.signatureTics?.[Number(m[1]) - 1];
    return t ? `- ${tokenOf(shot, c.id)} (${c.id}) performs this recurring habit once or twice in the clip, at a moment its trigger fits: ${t.tic} (trigger: ${t.trigger}). Write it as plain physical action; never call it a habit, tic or tell.` : null;
  }).filter(Boolean);
  return `SHAPING DECISIONS FOR THIS CLIP. They govern HOW the performance is written and must NEVER appear as words in detailedDescription, summary or overallSoundscape: do not write the tactic verb, the effort name, "tactic", "effort", or a paraphrase such as "she is trying to ..." or "with a punching quality". Perform them through posture, tempo, pressure, gaze and breath, cut by cut. A decision that is "unstated" leaves you free. Never write a denial of anything. For each performanceBeats entry, \`tactic\` is a filmable phrase of what that character is trying to do (Rule 6), consistent with the decided tactic${cutLines.length ? ` (one entry per character; make it the through-line of the cuts)` : ''}.\n${cutLines.join('\n') || '(none decided)'}${tics.length ? `\nSIGNATURE HABITS CHOSEN FROM THE ACTING PROFILES\n${tics.join('\n')}` : ''}`;
}

export function worldSlot(bible, rec, carriedText) {
  return `ENTITY LIST (this run supplies no world-state prose):\n${entityBlock(bible)}\n\nPLANNER STATE AT THE START OF THIS CLIP AND WHERE THE PREVIOUS CLIP ENDED ARE QUOTED INSIDE THE PLANNED SHOT LIST BELOW.\n\n${carriedText}`;
}

export function dirSlot(rec) {
  return `${MAPPING(rec.geom.duration, rec.geom.cuts.length)}\n\nTHIS CLIP'S PLANNED SHOT LIST (clip ${rec.clip.clip}; the raw ask, with the ledger state blocks the planner attached):\n\n${rec.rawAsk}\n\nCUT TIMES: [Shot 1] opens the clip with no time; ${rec.geom.cuts.slice(1).map((c) => `[Shot ${c.n}] opens At ${c.label}`).join('; ') || '(single cut)'}. The duration is ${rec.geom.duration} seconds.`;
}

export function screenplaySlot(plan, rawAsks, clipNumber) {
  return `The film is told in ${plan.clips.length} clips that play back to back as one continuous film. Only clip ${clipNumber} is yours to write; the others are written separately (do not write them, do not import their action).\n\n${rawAsks.map((a, i) => `${i + 1 === clipNumber ? '>>> THIS CLIP <<<\n' : ''}${a}`).join('\n\n---\n\n')}`;
}

export function splitJson(bible, rec, shot) {
  const e = { id: shot.id, purpose: rec.clip.beat, lineIds: shot.breakdown.lineIds, refs: shot.breakdown.refs, sceneId: 'scene01' };
  return { chapters: [{ id: 'chapter01', title: 'The film', sceneIds: ['scene01'] }], locations: bible.locations.map((l) => ({ id: l.id, name: l.name, firstSceneId: 'scene01' })), scenes: [{ id: 'scene01', chapterId: 'chapter01', locationId: rec.locationId, shots: [{ id: e.id, purpose: e.purpose, lineIds: e.lineIds, refs: e.refs }] }], shots: [e] };
}

export function writerPrompt({ fix, shot, rec, bible, plan, rawAsks, story, carriedText }) {
  let t = rawTemplate();
  t = swap(t, HEAD.world, `THE ENTITY LIST AND THE STATE LEDGER FOR THIS CLIP:\n\n{{world_state}}`);
  t = swap(t, HEAD.dir, `THIS CLIP'S PLANNED SHOT LIST AND HOW THIS RUN MAPS THE RULES BELOW:\n\n{{scene_direction}}`);
  t = swap(t, HEAD.act, `{{acting_scene}}`);
  t = swap(t, HEAD.screenplay, `THE FILM PLAN (this run has no screenplay; every clip's planned shot list, in order):\n\n{{screenplay}}`);
  const masters = Object.fromEntries(shot.references.filter((r) => r.type === 'character').map((r) => [r.id, bible.cast.find((c) => c.id === r.id).acting]));
  const vars = {
    item_id: fix.sceneId,
    shot_references: { sceneId: fix.sceneId, shots: [fix.refs.shots.find((s) => s.id === shot.id)] },
    scene_split: splitJson(bible, rec, shot),
    dialogue_ledger: fix.ledger, continuity: fix.continuity,
    world_state: worldSlot(bible, rec, carriedText), scene_direction: dirSlot(rec), acting_scene: shapingBlock(shot, rec, bible), acting_master: masters,
    screenplay: screenplaySlot(plan, rawAsks, rec.clip.clip),
    narrative_seed: { hasStory: true, storyText: story },
  };
  return fill(t, vars);
}

// ---- settled facts: the generic block hybrid3 appends to every prompt + the plan's cut structure + the decided staging and camera ----
const lcf = (t) => (t ? `${String(t).charAt(0).toLowerCase()}${String(t).slice(1)}` : t);
export function e4Facts({ fix, shot, rec }) {
  const lang = (l) => l.language || fix.continuity.language || 'English';
  const who = (l) => (l.voice ? 'a voice with no picture' : `${tokenOf(shot, l.speaker) || l.speaker}${l.offscreen ? ' speaking off-screen' : ''}`);
  const lines = shot.lines.map((l, i) => `  ${i + 1}. (${l.sid}) ${who(l)} says <d>[${lang(l)}] ${l.text}</d>  (planned for [Shot ${l.cut}])`);
  const out = ['SETTLED FACTS FOR THIS SHOT (do not contradict)'];
  if (lines.length) {
    out.push(`- This shot carries exactly ${lines.length} spoken line${lines.length > 1 ? 's' : ''}, in this order, each verbatim, inside the cut the plan puts it in. The id (Sx) names the SPEAKER, not the line: a speaker keeps the same (Sx) in every shot of the film, so write exactly the (Sx) shown here. A speaker with a picture is written "<Subject N> (Sx), in the voice of ..., says: <d>[Language] text</d>" with the speaker token and (Sx) shown here:`);
    out.push(...lines);
  } else out.push('- No spoken lines in this shot: write no <d> tag and no speech.');
  const seen = new Set();
  for (const l of shot.lines.filter((x) => x.voice)) {
    if (seen.has(l.speaker)) continue;
    seen.add(l.speaker);
    const own = shot.lines.filter((x) => x.speaker === l.speaker);
    const v = fix.voices?.[l.speaker] || {};
    out.push(`- ${own.map((x) => `(${x.sid})`).filter((x, i, a) => a.indexOf(x) === i).join(' ')} is a voice with no picture, so it has no <Subject N> token and no subject definition. Write each of its lines (${own.map((x) => `[Shot ${x.cut}]`).join(', ')}) as one sentence of the form "<its voice description, and where it carries from> (${l.sid}), off-screen, says: <d>[Language] text</d>", with no <Subject N> token anywhere in that sentence; for example "a calm, level voice carrying from a far room (${l.sid}), off-screen, says: <d>[Language] text</d>". Its voice: ${norm(v.voicePrompt || '').replace(/[.]+$/, '') || '<its voice>'}${v.appearsAs ? `. Where it is heard: ${lcf(norm(v.appearsAs))}` : ''}. Keep the voice description (age, register, pace, accent) in that same sentence and the word off-screen, which is the official marker; the lint keeps it beside (${l.sid}).`);
  }
  for (const l of shot.lines.filter((x) => x.offscreen && !x.voice)) out.push(`- (${l.sid}) in [Shot ${l.cut}] is spoken by ${tokenOf(shot, l.speaker)} from out of frame: write "${tokenOf(shot, l.speaker)} (${l.sid}), off-screen, says: <d>...</d>", keeping the same form.`);
  for (const c of shot.offscreen || []) {
    const ids = c.sids.map((x) => `(${x})`).join(' ');
    if (c.mode === 'no_face') out.push(`- [Shot ${c.cut}] carries the off-screen line ${ids}. H3 gives a line to the face it sees, so frame this cut on ${c.source || 'the place the voice carries from'}: the place itself, with no character's face or body in view and no <Subject N> token for a character in this cut. A character's lips pressed shut is the alternative only if one cannot be left out.`);
    else out.push(`- [Shot ${c.cut}] carries the off-screen line ${ids} while ${c.visible.map((id) => tokenOf(shot, id) || id).join(' and ')} is in the cut. H3 gives a line to the face it sees, so in the sentence about ${c.visible.length > 1 ? 'each of them' : 'that character'} write that the lips are pressed shut ("her lips are pressed shut", "his mouth stays closed"), in those positive words; the listening is shown through the eyes, the breath and the posture.`);
  }
  out.push('- Every word a person or voice says aloud in this shot (counting, reciting, calling out) is one of the <d> lines above and appears nowhere else. Write no sentence that describes counting, reciting, chanting, calling or whispering without its <d> line, and do not describe the count as a sound of the mouth.');
  out.push(`- Cut plan: this shot has exactly ${rec.geom.cuts.length} cuts, one per planned shot, in order: a bare [Shot 1], then ${rec.geom.cuts.slice(1).map((c) => `"[Shot ${c.n}] At ${c.label}, the shot cuts to ..."`).join(', ') || 'no later cut'}. Each cut carries its own controlled camera-motion term and covers only its own planned shot.`);
  out.push(`- Duration: exactly ${rec.geom.duration} seconds; copy this value into duration.`);
  out.push(fix.score === 'on' ? `- non_diegetic_music is exactly this score, copied character for character: ${fix.scoreText}` : '- non_diegetic_music is exactly: N/A');
  out.push(`- overall_soundscape names every ambient sound by its physical source and action (rain tapping a window, a hinge creaking, a boot scuffing a floor, cloth rubbing, a switch clicking). The renderer hears a hum, drone, resonance, tone, chord, sustained note, swell, pulse, thrum or throb as ${fix.score === 'on' ? 'part of the score, which the music field already carries' : 'a musical score, which this film does not have'}, so use none of those words in overall_soundscape or in the description; this replaces any earlier suggestion to use hum or drone.`);
  out.push('- Write every absence as a substitution: name what IS there, never what is not. Before: "He does not turn around." After: "He keeps his eyes on the water." Before: "No light reaches the corner." After: "The corner stays in shadow."');
  out.push('- If a gesture suggests an object that is not physically in the shot (a mimed, pretended or imagined one), write only the motion of the hands and body. Never name that object and never label it as imagined. Before: "her hand lifts an imagined whistle to her lips." After: "her hand curls and rises to her lips, her cheeks drawing in."');
  out.push(...stateFacts({ shot, rec }));
  return out.join('\n');
}

export function stagingFacts({ shot, rec }) {
  const refIds = shot.references.map((r) => r.id).sort((a, b) => b.length - a.length);
  const tok = (s) => String(s).replace(/\s*\(level [+-]?\d+\)/g, '').replace(refIds.length ? new RegExp(`\\b(${refIds.join('|')})\\b`, 'g') : /$^/, (m) => `${tokenOf(shot, m)} (${m})`).replace(/_/g, ' ');
  const P = rec.picks, ok = (v) => v && v !== UNSTATED;
  const out = ['STAGING AND CAMERA DECIDED FOR THIS SHOT (stated facts: write each one as what is visible and do not contradict it; the planned shot list is the authority on what happens, so where one of these facts would contradict a planned action, follow the planned action)'];
  rec.clip.shots.forEach((s, i) => {
    const k = i + 1;
    const bits = [];
    const frame = rec.framing[i];
    if (frame) bits.push(`framing: ${frame.final} (shot size and angle of this cut)`);
    if (ok(P[`move.${k}`])) bits.push(`camera-motion term exactly "${P[`move.${k}`]}"`);
    if (k === 1) {
      if (ok(P['c1.camera.side'])) bits.push(`camera position: ${tok(P['c1.camera.side'])}`);
      if (ok(P['c1.camera.height'])) bits.push(`camera height: ${P['c1.camera.height']}`);
    }
    out.push(`- [Shot ${k}] (${s.seconds}s): ${bits.join('; ') || 'camera is yours'}.`);
    for (const r of shot.references.filter((x) => x.type !== 'location')) {
      const sub = [];
      const q = (n) => P[`c${k}.${r.id}.${n}`];
      if (ok(q('zone'))) sub.push(`position: ${tok(q('zone'))}`);
      if (ok(q('faces'))) sub.push(`facing: ${tok(q('faces'))}`);
      if (ok(q('moves'))) sub.push(`movement: ${tok(q('moves'))}`);
      if (ok(q('held_by'))) {
        const mode = q('held_by.mode') || 'held', from = q('held_by.from'), who = q('held_by') === 'none' ? null : tok(q('held_by'));
        if (mode === 'put down') sub.push(from ? `put down by ${tok(from)} during this cut` : 'put down during this cut');
        else if (!who) sub.push('held by nobody');
        else if (mode === 'worn') sub.push(`worn by ${q('held_by.also') ? 'both ' : ''}${who}${q('held_by.also') ? ` and ${tok(q('held_by.also'))}` : ''}`);
        else if (mode === 'shared') sub.push(`shared between ${who} and ${tok(q('held_by.also'))}`);
        else if (mode === 'lifted') sub.push(`lifted by ${who} during this cut`);
        else if (mode === 'passed' || from) sub.push(`passed ${from && from !== 'none' ? `from ${tok(from)} ` : ''}to ${who} during this cut`);
        else sub.push(`held by ${who}`);
      }
      if (ok(q('points_at'))) sub.push(`pointing: ${tok(q('points_at'))}`);
      if (sub.length) out.push(`  - ${tokenOf(shot, r.id)} (${r.id}): ${sub.join('; ')}.`);
    }
  });
  return out.join('\n');
}

export function factsFor(args) { return `${e4Facts(args)}\n\n${stagingFacts(args)}`; }

// ---- dialogue licensing in code: every planned line must be in the written clip, verbatim, once, in plan order ----
const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim();
export function dialogueTags(dd) { return [...String(dd || '').matchAll(/<d>\[[^\]]*\]\s*([\s\S]*?)<\/d>/g)].map((m) => norm(m[1])); }

// Re-insert planned lines that the writer dropped, at the end of the cut the plan puts them in.
export function ensureLines(prose, shot, masters, fix) {
  const log = [];
  let dd = String(prose.detailedDescription || '');
  const have = dialogueTags(dd);
  const missing = shot.lines.filter((l) => !have.includes(norm(l.text)));
  if (!missing.length || have.length >= shot.lines.length) return { prose, log };
  for (const l of missing) {
    const tk = tokenOf(shot, l.speaker);
    if (!tk && !l.voice) { log.push({ rule: 'line_reinsert_skipped', line: l.id, why: 'speaker is not a reference' }); continue; }
    const voice = norm(masters[l.speaker]?.voicePrompt || fix.voices?.[l.speaker]?.voicePrompt || '').replace(/[.]+$/, '');
    const marks = [...dd.matchAll(/\[Shot\s+(\d+)\]/g)].map((m) => ({ n: Number(m[1]), index: m.index }));
    const at = marks.findIndex((m) => m.n === l.cut);
    let pos = dd.length;
    if (at >= 0 && at + 1 < marks.length) pos = marks[at + 1].index;
    const lang = l.language || fix.continuity.language;
    const off = l.offscreen ? ', off-screen' : '';
    const sentence = l.voice ? `${voice ? `${/^an? /i.test(voice) ? '' : 'a voice, '}${voice.charAt(0).toLowerCase()}${voice.slice(1)}` : 'a voice'} (${l.sid})${off}, says: <d>[${lang}] ${l.text}</d>` : `${tk} (${l.sid})${off}${voice ? `, speaking in the voice of ${voice.charAt(0).toLowerCase()}${voice.slice(1)}` : ''}, says: <d>[${lang}] ${l.text}</d>`;
    const before = dd.slice(0, pos).replace(/\s+$/, ''), after = dd.slice(pos);
    dd = `${before}${/[.!?>]$/.test(before) ? '' : '.'} ${sentence}${/[.!?]$/.test(l.text) ? '' : '.'}${after ? ` ${after.replace(/^\s+/, '')}` : ''}`;
    log.push({ rule: 'line_reinserted', line: l.id, cut: l.cut });
  }
  return { prose: { ...prose, detailedDescription: dd }, log };
}

// ---- plan conformance (a code check the E4 report counts): one [Shot N] marker per planned shot, at the planned cut times ----
export function planConformance(prose, geom) {
  const marks = [...String(prose.detailedDescription || '').matchAll(/\[Shot\s+(\d+)\](?:\s+At\s+(\d{1,2}):(\d{2}(?:\.\d+)?))?/g)].map((m) => ({ n: Number(m[1]), at: m[2] !== undefined ? Number(m[2]) * 60 + Number(m[3]) : null }));
  const issues = [];
  if (marks.length !== geom.cuts.length) issues.push(`${marks.length} cut markers for ${geom.cuts.length} planned shots`);
  geom.cuts.slice(1).forEach((c, i) => { const m = marks[i + 1]; if (m && m.at !== null && Math.abs(m.at - c.start) > 0.75) issues.push(`[Shot ${c.n}] at ${m.at}s, planned ${c.start}s`); });
  return { ok: !issues.length, issues, markers: marks.length };
}

export const framingLabel = (k) => CAMERA_LABELS[k] || k;
