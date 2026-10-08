#!/usr/bin/env node
// Render stored E4 clips as H3 prompt text, the same six-section layout as hybrid3/export-prompts.mjs and results/2026-10-07-pathtest/prompts/.
//   node planpath44/export-prompts.mjs <outDir> [promptsDir] [--images <root>] [--no-cite]      (default promptsDir = <outDir>/prompts)
// E4.4: the pictured subjects cite their <Picture N> (pictures.mjs); per clip <id>_e4.refs.json lists the entities in Picture order, and with
// --images <root> (rendered files <root>/<story>/<entityId>_<seed>.png) also <id>_e4.refs, the comma-separated image paths for REFS=.
// --no-cite writes the E4.3 text exactly (the regression check).
import { readFileSync, readdirSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pictureList, citeSubjectDefinitions, imageMap, checkPictureCitations } from './pictures.mjs';
import { citeRetention } from './state.mjs';

const block = (name, body) => `${name}:\n${String(body).trim()}`;
export function exportPrompts(outDir, promptsDir = join(outDir, 'prompts'), { cite = true, images = null } = {}) {
  mkdirSync(promptsDir, { recursive: true });
  const jobs = [], durations = {}, pictureChecks = {};
  for (const story of readdirSync(outDir).filter((d) => existsSync(join(outDir, d, 'plan.json'))).sort()) {
    if (!existsSync(join(outDir, story, 'fix.json'))) continue;
    const cdir = join(outDir, story, 'clips');
    const fix = JSON.parse(readFileSync(join(outDir, story, 'fix.json'), 'utf8'));
    const bible = JSON.parse(readFileSync(join(outDir, story, 'bible.json'), 'utf8')).bible;
    const names = Object.fromEntries([...bible.cast, ...bible.props, ...bible.locations].map((e) => [e.id, e.name]));
    const refsFile = join(outDir, story, 'refs', 'refs.json');
    const refsJson = existsSync(refsFile) ? JSON.parse(readFileSync(refsFile, 'utf8')) : null;
    const imgs = images ? imageMap(refsJson, join(images, story)) : {};
    for (const c of readdirSync(cdir).filter((d) => /^clip\d+$/.test(d)).sort()) {
      const f = join(cdir, c, 'final.prose.json');
      if (!existsSync(f)) continue;
      const prose = JSON.parse(readFileSync(f, 'utf8'));
      const ref = fix.refs.shots.find((s) => s.id === prose.id);
      const subjectDefinitions = cite ? citeSubjectDefinitions(ref.subjectDefinitions, ref.references, names) : ref.subjectDefinitions;
      const retention = cite ? citeRetention(ref.retentionAnalysis, ref.references, pictureList(ref.references)) : ref.retentionAnalysis;
      const text = [block('subject_definitions', subjectDefinitions), block('summary', prose.summary), block('retention_analysis', retention), block('detailed_description', prose.detailedDescription), block('overall_soundscape', prose.overallSoundscape || 'N/A'), block('non_diegetic_music', prose.nonDiegeticMusic || 'N/A')].join('\n\n');
      const id = `${story}__${c}`;
      writeFileSync(join(promptsDir, `${id}_e4.txt`), text);
      if (cite) {
        const pictures = pictureList(ref.references, imgs);
        writeFileSync(join(promptsDir, `${id}_e4.refs.json`), JSON.stringify({ story, clip: c, duration: prose.duration, pictures }, null, 2));
        if (images) writeFileSync(join(promptsDir, `${id}_e4.refs`), pictures.map((p) => p.image).join(','));
        pictureChecks[id] = checkPictureCitations({ references: ref.references, sections: { subject_definitions: subjectDefinitions, summary: prose.summary, retention_analysis: retention, detailed_description: prose.detailedDescription, overall_soundscape: prose.overallSoundscape || '', non_diegetic_music: prose.nonDiegeticMusic || '' }, pictures, refsJson, images: images ? imgs : null });
      }
      durations[id] = prose.duration;
      jobs.push(`${id} ${Math.round(Number(prose.duration))}`);
    }
  }
  writeFileSync(join(promptsDir, 'jobs.txt'), `${jobs.join('\n')}\n`);
  writeFileSync(join(promptsDir, 'durations.json'), JSON.stringify(durations, null, 2));
  if (cite) writeFileSync(join(promptsDir, 'picture-checks.json'), JSON.stringify(pictureChecks, null, 2));
  return jobs.length;
}
if (import.meta.url === `file://${process.argv[1]}`) {
  const argv = process.argv.slice(2);
  const ii = argv.indexOf('--images');
  const images = ii >= 0 ? resolve(argv[ii + 1]) : null;
  const [outDir, promptsDir] = argv.filter((a, i) => !a.startsWith('--') && argv[i - 1] !== '--images');
  if (!outDir) { console.error('usage: node planpath44/export-prompts.mjs <outDir> [promptsDir] [--images <root>] [--no-cite]'); process.exit(2); }
  const dir = promptsDir && resolve(promptsDir);
  const n = exportPrompts(resolve(outDir), dir, { cite: !argv.includes('--no-cite'), images });
  console.log(`${n} prompts written`);
}
