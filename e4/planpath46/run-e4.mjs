#!/usr/bin/env node
// E4: story -> film with exactly three kinds of LLM call (planner, bible, clip writer) + decisions + code.
//   node planpath/run-e4.mjs <fixturesRoot> <outDir> [--stories a,b] [--cap 3.0] [--resume] [--workers 4] [--refwriter default|llm] [--refs-only]
// <fixturesRoot>: a directory with one sub-directory per story, a single story directory, or a JSON manifest {name: dir}.
// Only each story's story text is read (see stories.mjs); the dialogue language defaults to English (--language, or language.txt in a story directory, or {dir, language} in a manifest). Every request, response, plan, bible, decision and prompt is stored under <outDir>.
import { resolve } from 'node:path';
import { loadStories } from './stories.mjs';
import { runStory } from './film.mjs';
import { exportPrompts } from './export-prompts.mjs';
import { reportAll } from './report.mjs';

const argv = process.argv.slice(2);
const opt = (k, d) => { const i = argv.indexOf('--' + k); return i >= 0 ? argv[i + 1] : d; };
const VALUED = new Set(['--stories', '--cap', '--workers', '--language', '--refwriter', '--score']);
const [root, outArg] = argv.filter((a, i) => !a.startsWith('--') && !VALUED.has(argv[i - 1]));
if (!root || !outArg) { console.error('usage: node planpath/run-e4.mjs <fixturesRoot> <outDir> [--stories a,b] [--cap 3.0] [--resume] [--workers 4] [--refwriter default|llm] [--refs-only] [--score off|on]'); process.exit(2); }
const outRoot = resolve(outArg);
const only = opt('stories') ? new Set(opt('stories').split(',')) : null;
const budget = { spent: 0, cap: Number(opt('cap', '3.0')) };
const refwriter = opt('refwriter', 'default');
if (!['default', 'llm'].includes(refwriter)) { console.error('--refwriter is default (code assembles the image prompts) or llm (comparison mode: one extra LLM call per entity)'); process.exit(2); }
const refsOnly = argv.includes('--refs-only');
const score = opt('score', process.env.E4_SCORE || 'off');
if (!['off', 'on'].includes(score)) { console.error('--score is off (non_diegetic_music N/A, music-like words swept) or on (an explicit score from the bible)'); process.exit(2); }
const stories = loadStories(root).filter((s) => !only || only.has(s.name));
if (!stories.length) { console.error('no story text found'); process.exit(2); }
console.log(`E4 on ${stories.length} stories: ${stories.map((s) => s.name).join(', ')} -> ${outRoot}`);
const settled = await Promise.allSettled(stories.map((s) => runStory({ name: s.name, story: s.text, outRoot, budget, resume: argv.includes('--resume'), workers: Number(opt('workers', '4')), language: s.language || opt('language', 'English'), refwriter, refsOnly, score })));
settled.forEach((r, i) => { if (r.status === 'rejected') console.error(`${stories[i].name} FAILED: ${r.reason?.stack || r.reason}`); });
if (refsOnly) { console.log(`refs only (${refwriter}): plan, bible and reference prompts written under ${outRoot}`); process.exit(settled.some((r) => r.status === 'rejected') ? 1 : 0); }
console.log(`${exportPrompts(outRoot)} clip prompts exported`);
reportAll(outRoot);
console.log(`spent $${budget.spent.toFixed(4)} (writer and repair calls only; per-story totals in report.json)`);
process.exit(settled.some((r) => r.status === 'rejected') ? 1 : 0);
