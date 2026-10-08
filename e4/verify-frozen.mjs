#!/usr/bin/env node
// Prove that the vendored E4.8 copy under e4/ is the frozen one.
//   node e4/verify-frozen.mjs                          offline: every vendored file against MANIFEST.json, patches reversed, and against the
//                                                      hashes of the freeze record (planpath48/E4.8-FROZEN.md) where the record lists the file
//   node e4/verify-frozen.mjs --eval-repo DIR [--ref e4.8-frozen]
//                                                      also: every file the git tag holds, read from the tag (git show), reversed the same way
// A file is "frozen" when, with the declared replacements of PATCHES.json reversed, its bytes equal the source's. Exit 1 on any difference.
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { join, dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const argv = process.argv.slice(2);
const opt = (k, d) => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1] : d; };
const evalRepo = opt('eval-repo', null) && resolve(opt('eval-repo'));
const sha = (b) => createHash('sha256').update(b).digest('hex');
const manifest = JSON.parse(readFileSync(join(HERE, 'MANIFEST.json'), 'utf8'));
const ref = opt('ref', manifest.ref);
const patches = JSON.parse(readFileSync(join(HERE, 'PATCHES.json'), 'utf8'));

function unpatch(rel, bytes) {
  const p = patches.find((x) => `e4/${x.file}` === rel);
  if (!p) return { ok: true, bytes };
  let text = bytes.toString('utf8');
  for (const r of [...p.replacements].reverse()) {
    if (text.split(r.replace).length !== 2) return { ok: false, why: `declared replacement not found exactly once: ${r.replace.slice(0, 60)}` };
    text = text.replace(r.replace, () => r.find);
  }
  return { ok: true, bytes: Buffer.from(text, 'utf8') };
}

const problems = [];
const note = [];
let checked = 0, patched = 0, tagChecked = 0, recordChecked = 0;
for (const f of manifest.files) {
  const file = join(ROOT, f.path);
  if (!existsSync(file)) { problems.push(`MISSING ${f.path}`); continue; }
  const bytes = readFileSync(file);
  checked += 1;
  if (sha(bytes) !== f.vendoredSha256) { problems.push(`CHANGED ${f.path} (not the vendored bytes of MANIFEST.json)`); continue; }
  if (f.sourceSha256 === null) continue;
  const u = unpatch(f.path, bytes);
  if (!u.ok) { problems.push(`PATCH ${f.path}: ${u.why}`); continue; }
  if (f.patched) patched += 1;
  if (sha(u.bytes) !== f.sourceSha256) problems.push(`DIFFERS ${f.path}: with the declared patches reversed it is not the source`);
  if (f.freezeRecordSha256) {
    recordChecked += 1;
    if (f.freezeRecordSha256 !== f.sourceSha256) problems.push(`RECORD ${f.path}: the source hash is not the one in E4.8-FROZEN.md`);
  }
  if (evalRepo && f.inTag) {
    const rel = f.source.replace(/^h3-prompt-eval:/, '');
    let blob;
    try { blob = execFileSync('git', ['-C', evalRepo, 'show', `${ref}:${rel}`], { maxBuffer: 1 << 28, stdio: ['ignore', 'pipe', 'ignore'] }); } catch { problems.push(`TAG ${f.path}: ${rel} is not in ${ref}`); continue; }
    tagChecked += 1;
    if (sha(blob) !== sha(u.bytes)) problems.push(`TAG ${f.path}: differs from ${ref}:${rel} (patches reversed)`);
  }
}

const listed = new Set(manifest.files.map((f) => f.path));
const OWN = new Set(['e4/MANIFEST.json', 'e4/PATCHES.json', 'e4/verify-frozen.mjs']);
(function scan(dir) {
  for (const n of readdirSync(dir)) {
    const p = join(dir, n);
    const rel = relative(ROOT, p).split('\\').join('/');
    if (statSync(p).isDirectory()) { if (rel === 'e4/bridge') continue; scan(p); } else if (!listed.has(rel) && !OWN.has(rel)) problems.push(`EXTRA ${rel} (not in MANIFEST.json)`);
  }
}(HERE));

const unfrozen = manifest.files.filter((f) => f.sourceSha256 && !f.inTag && !f.inFreezeRecord).map((f) => f.path);
if (unfrozen.length) note.push(`${unfrozen.length} vendored inputs are in neither the git tag nor the freeze record (checked against MANIFEST.json only): ${unfrozen.join(', ')}`);
for (const p of problems) console.log(p);
for (const n of note) console.log(`note: ${n}`);
console.log(`e4 ${manifest.engine} (${ref}): ${checked} files checked, ${patched} patched (patches reversed), ${recordChecked} against the freeze record${evalRepo ? `, ${tagChecked} against the git tag` : ' (offline: pass --eval-repo for the git tag)'}, ${problems.length} problem(s)`);
process.exit(problems.length ? 1 : 0);
