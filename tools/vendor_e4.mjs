#!/usr/bin/env node
// Re-vendor the frozen E4.6 story engine into e4/ from the h3-prompt-eval repo (tag e4.6-frozen) and the audit runner, apply the
// declared patches (e4/PATCHES.json) and write e4/MANIFEST.json. Only used to (re)build e4/; nothing here runs inside ComfyUI.
//   node tools/vendor_e4.mjs --eval ~/Projects/h3-prompt-eval --audit ~/.kshana/runners/dhee-runner-h3-audit [--ref e4.6-frozen]
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
const EVAL = resolve(opt('eval', join(homedir(), 'Projects/h3-prompt-eval')));
const AUDIT = resolve(opt('audit', join(homedir(), '.kshana/runners/dhee-runner-h3-audit')));
const REF = opt('ref', 'e4.6-frozen');
const sha = (b) => createHash('sha256').update(b).digest('hex');

// ---- the runtime closure of run-e4.mjs, over static imports (no npm package is imported anywhere) ----
const seen = new Set();
const AUDIT_SPEC = '/Users/ganaraj/.kshana/runners/dhee-runner-h3-audit/dist/index.js';
function walk(file) {
  if (seen.has(file)) return;
  seen.add(file);
  const text = readFileSync(file, 'utf8');
  for (const m of text.matchAll(/(?:from\s+|import\s*\(\s*|import\s+)['"]([^'"]+)['"]/g)) {
    const spec = m[1];
    if (spec.startsWith('node:')) continue;
    if (spec === AUDIT_SPEC) { walk(join(AUDIT, 'dist/index.js')); continue; }
    if (!/^[\w@][\w./@-]*$/.test(spec) && !spec.startsWith('.')) continue; // text inside a string, not an import
    if (!spec.startsWith('.')) throw new Error(`${file}: imports the package '${spec}'; E4 must have no package dependency`);
    const target = resolve(dirname(file), spec);
    if (existsSync(target)) walk(target);
  }
}
walk(join(EVAL, 'planpath46/run-e4.mjs'));

const files = [];
const add = (src, dest, kind) => files.push({ src, dest, kind });
for (const f of [...seen].sort()) {
  if (f.startsWith(AUDIT)) add(f, `audit/dist/${relative(join(AUDIT, 'dist'), f)}`, 'audit');
  else add(f, relative(EVAL, f), 'eval');
}
const dataDirs = ['planpath46/vendor/prompts', 'planpath46/vendor/schemas', 'templater/taxonomy'];
for (const d of dataDirs) for (const n of readdirSync(join(EVAL, d)).sort()) add(join(EVAL, d, n), `${d}/${n}`, 'eval');
add(join(EVAL, 'planpath46/vendor/PROVENANCE.md'), 'planpath46/vendor/PROVENANCE.md', 'eval');
add(join(EVAL, 'planpath46/E4.6-FROZEN.md'), 'planpath46/E4.6-FROZEN.md', 'eval');
add(join(AUDIT, 'LICENSE'), 'audit/LICENSE', 'audit');

const tagFiles = new Set(execFileSync('git', ['-C', EVAL, 'ls-tree', '-r', '--name-only', REF], { maxBuffer: 1 << 28 }).toString().split('\n').filter(Boolean));
const record = readFileSync(join(EVAL, 'planpath46/E4.6-FROZEN.md'), 'utf8');
const recorded = new Map([...record.matchAll(/^([0-9a-f]{64})  (\S+)$/gm)].map((m) => [m[2].replace(/^~/, homedir()), m[1]]));
const patches = JSON.parse(readFileSync(join(OUT, 'PATCHES.json'), 'utf8'));

rmSync(join(OUT, 'planpath46'), { recursive: true, force: true });
for (const d of ['hybrid3', 'templater', 'staging', 'audit']) rmSync(join(OUT, d), { recursive: true, force: true });

const manifest = [];
for (const { src, dest, kind } of files) {
  const rel = kind === 'eval' ? relative(EVAL, src) : null;
  const inTag = rel !== null && tagFiles.has(rel);
  const source = inTag ? execFileSync('git', ['-C', EVAL, 'show', `${REF}:${rel}`], { maxBuffer: 1 << 28 }) : readFileSync(src);
  if (inTag && sha(source) !== sha(readFileSync(src)) && rel !== 'planpath46/E4.6-FROZEN.md') console.warn(`note: ${rel} differs between the tag and the working tree; the tag is vendored`);
  let body = source.toString('utf8');
  const patch = patches.find((p) => p.file === dest);
  if (patch) for (const r of patch.replacements) {
    if (body.split(r.find).length !== 2) throw new Error(`${dest}: patch text must occur exactly once: ${r.find.slice(0, 70)}`);
    body = body.replace(r.find, () => r.replace);
  }
  const out = Buffer.from(body, 'utf8');
  mkdirSync(dirname(join(OUT, dest)), { recursive: true });
  writeFileSync(join(OUT, dest), out);
  const recHash = recorded.get(src) ?? null;
  manifest.push({ path: `e4/${dest}`, source: kind === 'eval' ? `h3-prompt-eval:${rel}` : `dhee-runner-h3-audit:dist/${dest.slice('audit/dist/'.length)}`.replace('dist/LICENSE', 'LICENSE'), inTag, inFreezeRecord: recHash !== null, sourceSha256: sha(source), freezeRecordSha256: recHash, patched: !!patch, vendoredSha256: sha(out) });
}
writeFileSync(join(OUT, 'audit/package.json'), '{"type":"module"}\n');
manifest.push({ path: 'e4/audit/package.json', source: 'new (module-type marker for the vendored audit runner)', inTag: false, inFreezeRecord: false, sourceSha256: null, freezeRecordSha256: null, patched: false, vendoredSha256: sha(Buffer.from('{"type":"module"}\n')) });
writeFileSync(join(OUT, 'MANIFEST.json'), `${JSON.stringify({ engine: 'E4.6', ref: REF, evalCommit: execFileSync('git', ['-C', EVAL, 'rev-parse', `${REF}^{commit}`]).toString().trim(), files: manifest }, null, 1)}\n`);
console.log(`${manifest.length} files vendored; ${manifest.filter((m) => m.patched).length} patched; ${manifest.filter((m) => !m.inTag && !m.inFreezeRecord && m.sourceSha256).length} not in the tag and not in the freeze record`);
