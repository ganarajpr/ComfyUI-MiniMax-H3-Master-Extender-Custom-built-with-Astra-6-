// Assembly of everything the writer and the hybrid3 checks need, built by CODE from the plan and the bible:
// the film-wide dialogue ledger, the candidate entities of a clip, a clip's references, its cut geometry, and the hybrid3 `fix` / `shot` objects.
import { tokensOf, gridSeconds, fmtTime, humanId } from './lib.mjs';
import { MAX_REFS } from './bible.mjs';
import { resolveSpeaker, voicesOf, lineOffscreen } from './speakers.mjs';
import { surfaceLandmarks, locationTexts } from './stage-classes.mjs';

const STOP = new Set('the and for with from that this into onto over under after before while where when then than they them their there here have has had been were was are his her its our out off who whom what which will would could should about above below between through during each other some such only just also very more most less much many one two all any not but nor yet'.split(' '));
const tokenSet = (s) => new Set(tokensOf(s, 3).filter((w) => !STOP.has(w)));

// Distinctive words of an entity: the words of its name and of its id.
export function entityWords(e) { return new Set([...tokenSet(e.name), ...tokenSet(humanId(e.id))]); }

// True when any distinctive word of the entity occurs as a whole word in the text.
export function mentions(text, e) {
  const t = tokenSet(text);
  for (const w of entityWords(e)) if (t.has(w)) return true;
  return false;
}

export const clipOf = (plan, n) => plan.clips.find((c) => c.clip === n);
export const shotText = (s) => `${s.subject} ${s.action} ${s.dialogue?.speaker || ''}`;

// Film-wide dialogue ledger in plan order. `id` names the LINE (L1, L2, ...). `sid` is the SPEAKER id, (Sx) in the prompt: one per speaker for the whole film,
// numbered in the order the speakers first speak (E4.6; E4.1 to E4.5 numbered the lines). Each line keeps where the plan puts it (clip, shot).
export function buildLedgerLines(plan, bible) {
  const lines = [], sids = new Map();
  for (const clip of [...plan.clips].sort((a, b) => a.clip - b.clip)) {
    for (const [idx, s] of clip.shots.entries()) {
      if (!s.dialogue?.line) continue;
      const speaker = resolveSpeaker(bible, s.dialogue.speaker);
      const key = speaker || String(s.dialogue.speaker || '');
      if (!sids.has(key)) sids.set(key, `S${sids.size + 1}`);
      const off = lineOffscreen(s, speaker, bible);
      const voice = voicesOf(bible).find((v) => v.id === speaker);
      lines.push({ id: `L${lines.length + 1}`, sid: sids.get(key), speaker: key, text: s.dialogue.line, language: bible.language, clip: clip.clip, cut: idx + 1, resolved: !!speaker, voice: off.voice, offscreen: off.offscreen, ...(voice ? { voicePhrase: String(voice.voicePrompt || '').replace(/[.\s]+$/, '') } : {}) });
    }
  }
  return lines;
}

export function cutGeometry(clip) {
  const total = clip.shots.reduce((a, s) => a + s.seconds, 0);
  const duration = gridSeconds(total || 15);
  let at = 0;
  const cuts = clip.shots.map((s, i) => { const start = at; at += s.seconds; return { n: i + 1, shot: s.shot, seconds: s.seconds, start, label: i === 0 ? null : fmtTime(start) }; });
  return { total, duration, cuts };
}

// Candidate entities of a clip: what its own text names, what the ledger of the plan puts in it, the end-state characters, the speakers, else what was carried from the clip before.
export function candidates(plan, bible, clip, carried) {
  const cast = bible.cast.map((c) => ({ ...c, type: 'character' })), props = bible.props.map((p) => ({ ...p, type: 'object' })), locs = bible.locations.map((l) => ({ ...l, type: 'location' }));
  const clipText = [clip.beat, ...clip.shots.map(shotText), clip.end_state?.location || '', clip.end_state?.end_action || ''].join(' ');
  const endChars = (clip.end_state?.characters || []).map((c) => c.name).join(' ');
  const propsText = (clip.end_state?.characters || []).map((c) => c.props).join(' ');
  const ledgerIds = new Set(plan.ledger.entities.filter((e) => e.clip_ids.includes(clip.clip)).map((e) => e.id));
  const speakerIds = new Set(buildLedgerLines({ clips: [clip] }, bible).map((l) => l.speaker));
  const pick = (list, text) => list.filter((e) => mentions(text, e) || ledgerIds.has(e.id));
  let chars = cast.filter((c) => mentions(`${clipText} ${endChars}`, c) || ledgerIds.has(c.id) || speakerIds.has(c.id));
  if (!chars.length) chars = cast.filter((c) => carried?.charIds?.includes(c.id));
  if (!chars.length) chars = cast.slice(0, 2);
  const pr = pick(props, `${clipText} ${propsText}`);
  let lc = locs.filter((l) => mentions(`${clip.end_state?.location || ''} ${clipText}`, l));
  if (!lc.length) lc = locs.filter((l) => carried?.locIds?.includes(l.id));
  if (!lc.length) lc = locs.slice(0, 1);
  return { chars, props: pr, locs: withSurfaces(lc, pr, bible) };
}

// A location's landmarks plus the furniture and seating its own set dressing names (bed, bench, seat, table); a prop that is itself furniture is a surface of the first location.
export function withSurfaces(locs, props, bible) {
  const reserved = new Set([...bible.cast, ...bible.props, ...bible.locations, ...(bible.locations || []).flatMap((l) => l.landmarks || [])].map((e) => e.id));
  return locs.map((l, i) => {
    const existing = l.landmarks || [];
    const extra = surfaceLandmarks({ texts: locationTexts(l), props: i === 0 ? props : [], existing, reserved: new Set([...reserved].filter((id) => !(i === 0 && props.some((p) => p.id === id)))) });
    return extra.length ? { ...l, landmarks: [...existing, ...extra] } : l;
  });
}

// Entities named in one planned shot (for per-cut staging); falls back to the clip's characters.
export function cutEntities(shot, cand, speakerOf) {
  const text = shotText(shot);
  let chars = cand.chars.filter((c) => mentions(text, c) || c.id === speakerOf);
  if (!chars.length) chars = cand.chars;
  const props = cand.props.filter((p) => mentions(text, p));
  return { chars, props };
}

const lcFirst = (t) => { const x = String(t).trim().replace(/[.\s]+$/, ''); return /^(?:A|An|The) /.test(x) ? x[0].toLowerCase() + x.slice(1) : x; };
const JOB = {
  character: 'face, build and hair held from the identity sheet throughout the clip',
  object: "the object's own material, scale and form, held from its anchor plate",
  location: "the set's layout, surfaces and light, held from its wide plate",
  described: 'a subject described in words only, with no reference picture: its face, build and clothes come from this description and stay the same at every mention',
};

// References of a clip from the yes/no picks: characters, then objects, then locations; speakers and one location are forced in.
export function assembleReferences(bible, cand, picks, speakerIds) {
  const all = [...bible.cast.map((c) => ({ ...c, type: 'character' })), ...bible.props.map((p) => ({ ...p, type: 'object' })), ...bible.locations.map((l) => ({ ...l, type: 'location' }))];
  const byId = Object.fromEntries(all.map((e) => [e.id, e]));
  const chosen = new Set(all.filter((e) => e.refImage !== false && picks[`ref.${e.id}`] === 'yes').map((e) => e.id));
  const forced = [];
  for (const id of speakerIds) if (byId[id] && !chosen.has(id)) { chosen.add(id); forced.push(id); }
  if (![...chosen].some((id) => byId[id].type === 'location') && cand.locs[0]) { chosen.add(cand.locs[0].id); forced.push(cand.locs[0].id); }
  const pictured = cand.chars.find((c) => c.refImage !== false);
  if (![...chosen].some((id) => byId[id].type === 'character') && pictured) { chosen.add(pictured.id); forced.push(pictured.id); }
  const rank = { character: 0, object: 1, location: 2 };
  let list = [...chosen].map((id) => byId[id]).sort((a, b) => rank[a.type] - rank[b.type] || all.indexOf(a) - all.indexOf(b));
  const dropped = [];
  while (list.length > MAX_REFS) { const drop = [...list].reverse().find((e) => e.type === 'object') || list[list.length - 1]; dropped.push(drop.id); list = list.filter((e) => e !== drop); }
  const references = list.map((e) => ({ id: e.id, type: e.type, appearsAs: e.appearsAs, job: e.refImage === false ? JOB.described : JOB[e.type], ...(e.refImage === false ? { noPicture: true } : {}) }));
  const subjectDefinitions = list.map((e, i) => `<Subject ${i + 1}> is ${e.name}, ${lcFirst(e.appearsAs)}; ${e.refImage === false ? JOB.described : JOB[e.type]}.`).join('\n\n');
  const retentionAnalysis = list.map((_, i) => `<Subject ${i + 1}>: fully_preserved`).join('\n');
  return { references, subjectDefinitions, retentionAnalysis, forced, dropped };
}

// The hybrid3 shot object for one clip. direction/acting stay empty on purpose: staging reaches the writer as decided facts (per cut),
// and hybrid3's spatial check reads only what the code-built subject definitions say.
export function makeShot(index, id, refPack, lines, clip, offscreen = []) {
  return { id, index, references: refPack.references, subjectDefinitions: refPack.subjectDefinitions, breakdown: { id, lineIds: lines.map((l) => l.id), refs: refPack.references.map((r) => r.id) }, direction: {}, acting: [], lines, clipNumber: clip.clip, offscreen };
}

export function makeFix(bible, ledgerLines, shots, refPacks, { score = 'off' } = {}) {
  const sceneId = 'scene01';
  const castIds = new Set(bible.cast.map((c) => c.id));
  return {
    root: null, proj: null, sceneId,
    refs: { sceneId, shots: shots.map((s, i) => ({ id: s.id, references: refPacks[i].references, subjectDefinitions: refPacks[i].subjectDefinitions, retentionAnalysis: refPacks[i].retentionAnalysis })) },
    split: { shots: shots.map((s) => ({ id: s.id, lineIds: s.breakdown.lineIds, refs: s.breakdown.refs })) },
    ledger: ledgerLines.map(({ id, sid, speaker, text, language }) => ({ id, sid, speaker, text, language })),
    score: score === 'on' ? 'on' : 'off', scoreText: score === 'on' ? String(bible.score || '') : '',
    continuity: { language: bible.language, cast: bible.cast.map((c) => ({ id: c.id, side: c.side, wardrobe: c.wardrobe })), staging: { seatNoun: 'set', description: bible.locations.map((l) => l.description).join(' ') }, forbiddenWords: [], allowPhrases: [], directAddressPhrases: [] },
    granted: new Set([...bible.cast, ...bible.props, ...bible.locations, ...voicesOf(bible)].map((e) => e.id)),
    voices: Object.fromEntries(voicesOf(bible).map((v) => [v.id, { voicePrompt: v.voicePrompt, appearsAs: v.appearsAs }])),
    film: { shots, masters: Object.fromEntries(bible.cast.filter((c) => castIds.has(c.id)).map((c) => [c.id, c.acting])) },
  };
}
