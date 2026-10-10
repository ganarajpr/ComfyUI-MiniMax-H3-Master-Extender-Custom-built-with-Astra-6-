// Story discovery. A fixtures root is either a JSON manifest {name: path} or a directory with one sub-directory per story.
// A story's text is read from the first of: story.txt, story.md, narrative_seed.json (storyText), project/plans/narrative_seed.json,
// _fixture/project/plans/narrative_seed.json. Nothing else of a fixture is read.
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';

const SEEDS = ['story.txt', 'story.md', 'narrative_seed.json', 'project/plans/narrative_seed.json', '_fixture/project/plans/narrative_seed.json'];

export function storyText(dir) {
  for (const rel of SEEDS) {
    const p = join(dir, rel);
    if (!existsSync(p)) continue;
    const raw = readFileSync(p, 'utf8');
    if (rel.endsWith('.json')) { const t = JSON.parse(raw).storyText; if (typeof t === 'string' && t.trim()) return t.trim(); } else if (raw.trim()) return raw.trim();
  }
  return null;
}

export function loadStories(root) {
  const r = resolve(root);
  let entries;
  if (statSync(r).isFile()) entries = Object.entries(JSON.parse(readFileSync(r, 'utf8'))).map(([n, p]) => [n, resolve(dirname(r), typeof p === 'string' ? p : p.dir), typeof p === 'string' ? null : p.language || null]);
  else if (storyText(r)) entries = [[r.split('/').pop(), r]];
  else entries = readdirSync(r).filter((f) => statSync(join(r, f)).isDirectory()).sort().map((f) => [f, join(r, f)]);
  const lang = (dir) => (existsSync(join(dir, 'language.txt')) ? readFileSync(join(dir, 'language.txt'), 'utf8').trim() : null);
  return entries.map(([name, dir, language]) => ({ name, dir, text: storyText(dir), language: language || lang(dir) })).filter((s) => s.text);
}
