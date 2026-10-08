#!/usr/bin/env node
// The Master Extender's entry point for story_engine=e4:  node e4/bridge/run.mjs <job.json>
// One story in, E4.6's clips out. The job (written by e4_engine.py):
//   { name, story, language, score: "off"|"on", workers, resume, out, vision: bool,
//     pictures: [{label: <the extender's Picture number>, file: <png>}], notes: {<label>: "text"} }
// The model endpoint, its wire and the thinking budgets come from E4's own config layer, the environment:
//   E4_LLM_URL, E4_LLM_MODEL, E4_LLM_API_STYLE (ninfer-messages | llama-chat | openrouter), E4_LLM_BUDGET_<KIND> (PLANNER, BIBLE, WRITER, REPAIR, and PICTURE_MAP of the
//   picture-binding call), E4_DECISION_THINKING (off | budget: the per-clip decision calls, off by default since E4.7), E4_LLM_MAX_TOKENS, E4_LLM_BUDGET_MESSAGE.
// Progress goes to stdout as lines "E4PROGRESS {json}"; every request and reply of every call is stored under <out>/<name>/ and listed in <out>/calls.jsonl.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { runStory } from '../planpath48/film.mjs';
import { makeBinder } from './pictures.mjs';
import { exportClips } from './export.mjs';

const progress = (o) => console.log(`E4PROGRESS ${JSON.stringify(o)}`);
const [jobFile] = process.argv.slice(2);
if (!jobFile) { console.error('usage: node e4/bridge/run.mjs <job.json>'); process.exit(2); }
const job = JSON.parse(readFileSync(jobFile, 'utf8'));
const out = resolve(job.out);
const name = job.name || 'story';
const pictures = (job.pictures || []).map((p) => ({ label: Number(p.label), file: p.file }));

progress({ stage: 'start', story: name });
const bindPictures = pictures.length ? makeBinder({ pictures, notes: job.notes || {}, sees: !!job.vision, resume: !!job.resume, log: (m) => progress({ stage: 'pictures', message: m }) }) : null;
await runStory({ name, story: job.story, outRoot: out, budget: { spent: 0, cap: Infinity }, resume: !!job.resume, workers: Math.max(1, Math.min(4, Number(job.workers) || 3)), language: job.language || 'English', score: job.score === 'on' ? 'on' : 'off', bindPictures });
progress({ stage: 'export' });
const result = exportClips(out, name, { pictures });
const done = result.clips.filter((c) => c.prompt).length;
progress({ stage: 'done', clips: result.clips.length, written: done });
process.exit(done ? 0 : 1);
