#!/usr/bin/env node
// Re-vendor the frozen story engines (E4.10 tag e4.10-frozen, E4.11.1 tag e4.11.1-frozen) side by side into e4/ from the h3-prompt-eval repo and the audit runner, apply the
// declared patches (e4/PATCHES.json) and write e4/MANIFEST.json. Only used to (re)build e4/; nothing here runs inside ComfyUI.
//   node tools/vendor_e4.mjs --eval410 <worktree of e4.10-frozen> --eval411 <worktree of e4.11.1-frozen> --audit ~/.kshana/runners/dhee-runner-h3-audit
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { join, dirname, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';

const argv = process.argv.slice(2);
const opt = (k, d) => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1] : d; };
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'e4');
const AUDIT = resolve(opt('audit', join(homedir(), '.kshana/runners/dhee-runner-h3-audit')));
// Engines vendored side by side under e4/: --eval410 / --eval411 are checkouts (git worktree add <dir> <tag>) of their tags, because closure.mjs reads the tree it sits in.
const ENGINES = [
  { id: 'e4.10', name: 'E4.10', pp: 'planpath410', ref: opt('ref410', 'e4.10-frozen'), eval: resolve(opt('eval410', opt('eval', join(homedir(), 'Projects/h3-prompt-eval')))), record: 'E4.10-FROZEN.md' },
  { id: 'e4.11', name: 'E4.11.1', pp: 'planpath411', ref: opt('ref411', 'e4.11.1-frozen'), eval: resolve(opt('eval411', opt('eval', join(homedir(), 'Projects/h3-prompt-eval')))), record: 'E4.11-FROZEN.md' },
];
const sha = (b) => createHash('sha256').update(b).digest('hex');

const AUDIT_ROOT = '/Users/ganaraj/.kshana/runners/dhee-runner-h3-audit/';
const patches = JSON.parse(readFileSync(join(OUT, 'PATCHES.json'), 'utf8'));

// ---- per engine: the runtime closure of run-e4.mjs (the freeze's own closure.mjs: static and absolute imports, plus the data files the modules name) ----
const files = new Map();   // dest -> { src, dest, kind, engine }   (shared directories are vendored once; they are byte-identical across the tags, which is checked)
for (const eng of ENGINES) {
  const { runtimeClosure } = await import(join(eng.eval, eng.pp, 'closure.mjs'));
  const closure = runtimeClosure({ entries: [join(eng.eval, eng.pp, 'run-e4.mjs')] });
  const list = [];
  const add = (src, dest, kind) => list.push({ src, dest, kind, engine: eng });
  for (const f of [...closure.modules, ...closure.data].sort()) {
    if (f.startsWith(AUDIT)) add(f, `audit/dist/${relative(join(AUDIT, 'dist'), f)}`, 'audit');
    else if (f.startsWith(AUDIT_ROOT)) add(join(AUDIT, relative(AUDIT_ROOT, f)), `audit/${f.slice(AUDIT_ROOT.length)}`, 'audit');
    else add(f, relative(eng.eval, f), 'eval');
  }
  // closure.mjs sees only data files named as string literals: planner.md and its siblings are opened through a built path (loadPrompt), and templater/taxonomy by a directory read.
  // Whole data directories are vendored on top of the closure so a path built at run time is never missing.
  const have = new Set(list.map((f) => f.dest));
  for (const d of [`${eng.pp}/vendor/prompts`, `${eng.pp}/vendor/schemas`, 'templater/taxonomy']) for (const n of readdirSync(join(eng.eval, d)).sort()) if (!have.has(`${d}/${n}`)) add(join(eng.eval, d, n), `${d}/${n}`, 'eval');
  add(join(eng.eval, eng.pp, 'vendor/PROVENANCE.md'), `${eng.pp}/vendor/PROVENANCE.md`, 'eval');
  add(join(eng.eval, eng.pp, eng.record), `${eng.pp}/${eng.record}`, 'eval');
  add(join(AUDIT, 'LICENSE'), 'audit/LICENSE', 'audit');
  for (const f of list) {
    const seen = files.get(f.dest);
    if (!seen) { files.set(f.dest, f); continue; }
    if (f.kind === 'eval' && sha(readFileSync(f.src)) !== sha(readFileSync(seen.src))) throw new Error(`${f.dest} differs between ${seen.engine.ref} and ${f.engine.ref}: it cannot be shared`);
  }
}

const tagFiles = Object.fromEntries(ENGINES.map((e) => [e.id, new Set(execFileSync('git', ['-C', e.eval, 'ls-tree', '-r', '--name-only', e.ref], { maxBuffer: 1 << 28 }).toString().split('\n').filter(Boolean))]));
const records = Object.fromEntries(ENGINES.map((e) => {
  const record = readFileSync(join(e.eval, e.pp, e.record), 'utf8');
  return [e.id, new Map([...record.matchAll(/^([0-9a-f]{64})  (\S+)$/gm)].map((m) => [m[2].replace(/^~\/Projects\/h3-prompt-eval/, e.eval).replace(/^~/, homedir()), m[1]]))];
}));

for (const old of ['planpath46', 'planpath47', 'planpath48', ...ENGINES.map((e) => e.pp)]) rmSync(join(OUT, old), { recursive: true, force: true });
for (const d of ['hybrid3', 'templater', 'staging', 'audit']) rmSync(join(OUT, d), { recursive: true, force: true });

const manifest = [];
for (const { src, dest, kind, engine: eng } of [...files.values()].sort((a, b) => (a.dest < b.dest ? -1 : 1))) {
  const rel = kind === 'eval' ? relative(eng.eval, src) : null;
  const inTag = rel !== null && tagFiles[eng.id].has(rel);
  const source = inTag ? execFileSync('git', ['-C', eng.eval, 'show', `${eng.ref}:${rel}`], { maxBuffer: 1 << 28 }) : readFileSync(src);
  let body = source.toString('utf8');
  const patch = patches.find((p) => p.file === dest);
  if (patch) for (const r of patch.replacements) {
    if (body.split(r.find).length !== 2) throw new Error(`${dest}: patch text must occur exactly once: ${r.find.slice(0, 70)}`);
    body = body.replace(r.find, () => r.replace);
  }
  const out = Buffer.from(body, 'utf8');
  mkdirSync(dirname(join(OUT, dest)), { recursive: true });
  writeFileSync(join(OUT, dest), out);
  const recHash = records[eng.id].get(src) ?? null;
  manifest.push({ path: `e4/${dest}`, engine: eng.id, ref: eng.ref, source: kind === 'eval' ? `h3-prompt-eval:${rel}` : `dhee-runner-h3-audit:dist/${dest.slice('audit/dist/'.length)}`.replace('dist/LICENSE', 'LICENSE'), inTag, inFreezeRecord: recHash !== null, sourceSha256: sha(source), freezeRecordSha256: recHash, patched: !!patch, vendoredSha256: sha(out) });
}
writeFileSync(join(OUT, 'audit/package.json'), '{"type":"module"}\n');
manifest.push({ path: 'e4/audit/package.json', engine: 'shared', ref: null, source: 'new (module-type marker for the vendored audit runner)', inTag: false, inFreezeRecord: false, sourceSha256: null, freezeRecordSha256: null, patched: false, vendoredSha256: sha(Buffer.from('{"type":"module"}\n')) });
const evalCommit = (e) => execFileSync('git', ['-C', e.eval, 'rev-parse', `${e.ref}^{commit}`]).toString().trim();
writeFileSync(join(OUT, 'MANIFEST.json'), `${JSON.stringify({ engine: ENGINES[0].name, ref: ENGINES[0].ref, evalCommit: evalCommit(ENGINES[0]), engines: ENGINES.map((e) => ({ id: e.id, name: e.name, dir: e.pp, ref: e.ref, evalCommit: evalCommit(e) })), files: manifest }, null, 1)}\n`);
console.log(`${manifest.length} files vendored; ${manifest.filter((m) => m.patched).length} patched; ${manifest.filter((m) => !m.inTag && !m.inFreezeRecord && m.sourceSha256).length} not in the tag and not in the freeze record`);
