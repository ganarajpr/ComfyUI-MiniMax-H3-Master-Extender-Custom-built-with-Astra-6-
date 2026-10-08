// The clips of one finished E4 run, in the shape the Master Extender's clip list takes: <out>/clips.json (+ the six-section prompt files).
// Reads only what runStory wrote under <out>/<story>/; so it can be re-run on a stored run: node e4/bridge/export.mjs <out> [story]
import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { citeSubjectDefinitions, pictureList, checkCitations } from './pictures.mjs';

const rj = (p) => JSON.parse(readFileSync(p, 'utf8'));
const block = (name, body) => `${name}:\n${String(body).trim()}`;
export const SECTIONS = ['subject_definitions', 'summary', 'retention_analysis', 'detailed_description', 'overall_soundscape', 'non_diegetic_music'];

// H3 durations are whole seconds in the extender; E4 plans on the 17k+5 frame grid at 24 fps (15.08 s for a 15 s clip).
export const wholeSeconds = (d) => Math.max(1, Math.round(Number(d)));
const shorten = (s, n) => { const t = String(s || '').replace(/\s+/g, ' ').trim(); return t.length <= n ? t : `${t.slice(0, n - 1).replace(/[\s,;:.-]+\S*$/, '')}…`; };

export function exportClips(outRoot, story, { pictures = [], version = 'e4.6-frozen' } = {}) {
  const dir = join(outRoot, story);
  const plan = rj(join(dir, 'plan.json'));
  const bible = rj(join(dir, 'bible.json')).bible;
  const fix = rj(join(dir, 'fix.json'));
  const summary = existsSync(join(dir, '_summary.json')) ? rj(join(dir, '_summary.json')) : null;
  const filmChecks = existsSync(join(dir, 'film_checks.json')) ? rj(join(dir, 'film_checks.json')) : null;
  const map = existsSync(join(dir, 'pictures', 'map.json')) ? rj(join(dir, 'pictures', 'map.json')) : { pictureOf: {}, pictures: [], unused: [] };
  const pictureOf = map.pictureOf || {};
  const attached = pictures.length ? pictures.map((p) => p.label) : map.pictures.map((p) => p.picture);
  const names = Object.fromEntries([...bible.cast, ...bible.props, ...bible.locations].map((e) => [e.id, e.name]));
  const planClips = [...plan.plan.clips].sort((a, b) => a.clip - b.clip);
  const rawAsks = plan.planMeta.rawAsks;
  const promptsDir = join(outRoot, 'prompts');
  mkdirSync(promptsDir, { recursive: true });
  const clips = [];
  planClips.forEach((pc, i) => {
    const id = `clip${String(pc.clip).padStart(2, '0')}`;
    const f = join(dir, 'clips', id, 'final.prose.json');
    const per = summary?.perClip?.find((r) => r.clip === pc.clip) || null;
    if (!existsSync(f)) { clips.push({ clip: pc.clip, id, title: shorten(pc.beat, 60), beat: pc.beat, rawAsk: rawAsks[i], prompt: null, failed: per?.failed || 'no final prompt was written', endState: pc.end_state || null }); return; }
    const prose = rj(f);
    const ref = fix.refs.shots.find((s) => s.id === prose.id);
    const subjectDefinitions = citeSubjectDefinitions(ref.subjectDefinitions, ref.references, names, pictureOf);
    const sections = { subject_definitions: subjectDefinitions, summary: prose.summary, retention_analysis: ref.retentionAnalysis, detailed_description: prose.detailedDescription, overall_soundscape: prose.overallSoundscape || 'N/A', non_diegetic_music: prose.nonDiegeticMusic || 'N/A' };
    const text = SECTIONS.map((n) => block(n, sections[n])).join('\n\n');
    const list = pictureList(ref.references, pictureOf);
    const citation = checkCitations({ references: ref.references, sections, pictureOf, attached });
    writeFileSync(join(promptsDir, `${story}__${id}_e4.txt`), text);
    clips.push({
      clip: pc.clip, id, title: shorten(pc.beat, 60), beat: pc.beat, rawAsk: rawAsks[i], prompt: text, sections,
      duration: wholeSeconds(prose.duration), durationExact: Number(prose.duration),
      pictures: list.map((p) => ({ ...p, name: names[p.entity] })),
      describedOnly: ref.references.flatMap((r, k) => (r.noPicture || !pictureOf[r.id] ? [{ subject: k + 1, entity: r.id, name: names[r.id], type: r.type }] : [])),
      endState: pc.end_state || null,
      checks: { citationIssues: citation, strictFindings: per?.after?.strict?.total ?? null, attributionOk: per?.attribution?.ok ?? null, planConformanceOk: per?.planConformance?.ok ?? null },
      words: per?.words ?? null,
    });
  });
  const result = {
    engine: 'e4', version, story, language: bible.language, score: fix.score,
    clips,
    mapping: { mode: map.mode || 'none', pictures: map.pictures, unused: map.unused, issues: map.issues || [], fallback: map.fallback || null },
    film: filmChecks ? { speakerIds: filmChecks.speakerIds, sequence: filmChecks.sequence } : null,
    stats: summary ? { wallSecs: summary.wallSecs, planAttempts: summary.planAttempts, bibleAttempts: summary.bibleAttempts, planIssues: summary.planIssues } : null,
  };
  writeFileSync(join(outRoot, 'clips.json'), `${JSON.stringify(result, null, 1)}\n`);
  writeFileSync(join(promptsDir, 'durations.json'), `${JSON.stringify(Object.fromEntries(clips.filter((c) => c.prompt).map((c) => [`${story}__${c.id}`, c.duration])), null, 1)}\n`);
  return result;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [out, story] = process.argv.slice(2);
  if (!out) { console.error('usage: node e4/bridge/export.mjs <outDir> [story]'); process.exit(2); }
  const root = resolve(out);
  const name = story || readdirSync(root).find((d) => existsSync(join(root, d, 'plan.json')));
  const r = exportClips(root, name);
  console.log(`${r.clips.filter((c) => c.prompt).length}/${r.clips.length} clips exported to ${join(root, 'clips.json')}`);
}
