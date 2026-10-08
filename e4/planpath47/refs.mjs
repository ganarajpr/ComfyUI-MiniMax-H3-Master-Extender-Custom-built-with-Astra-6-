// E4.2 reference-image stage: from the bible's slots to one image prompt per entity.
//   default mode:        code assembles the prompt from the slots (refslots.mjs), code checks it (refchecks.mjs); a failing entity gets ONE targeted repair call
//   --refwriter llm mode: ONE extra LLM call per entity writes the prompt (the plate skill's own system prompt for a location); the same checks run; one retry on failure
// Output per story: refs/<entityId>.prompt.txt, refs/refs.json (entity -> prompt file, size, seeds, skill, checks); every call is stored under refs/calls/.
//   node planpath/refs.mjs render-script <rootDir>      writes <rootDir>/render.sh for every <mode>/<story>/refs/refs.json under it (renders nothing)
import { join } from 'node:path';
import { existsSync, readdirSync, writeFileSync, chmodSync } from 'node:fs';
import { homedir } from 'node:os';
import { call, parseJsonReply, wr, rj, MODEL } from './lib.mjs';
import { KINDS, assemble, slotIssues, repairPrompt, refwriterSystem, refwriterBrief, normalizeRef } from './refslots.mjs';
import { checkEntity, wordCount, plateObjects, namedObjectCount, objectCoverage, appearances, needsRef } from './refchecks.mjs';

export const COVERAGE_MIN = 0.7;

export function refEntities(bible) {
  return [...bible.cast.map((e) => ({ kind: 'character', ent: e })), ...bible.props.map((e) => ({ kind: 'object', ent: e })), ...bible.locations.map((e) => ({ kind: 'location', ent: e }))];
}

const tidy = (t) => String(t || '').replace(/^```[a-z]*\n?|```$/gm, '').replace(/\s*\n\s*/g, ' ').replace(/^["“]|["”]$/g, '').trim();
const headOf = (s) => ((String(s).toLowerCase().split(/\b(?:with|of|that|which|in|on)\b|,/)[0].match(/[a-z]+/g) || []).pop() || '');
const msgs = (issues) => issues.map((i) => i.msg);

// the wardrobe words of the story that the sheet does not show (advisory: reported, never a repair trigger)
const wardrobeMissing = (ent, text) => (ent.wardrobe || []).filter((w) => { const h = headOf(w); return h && !new RegExp(`\\b${h}`, 'i').test(text); });

async function oneDefault({ kind, ent, story, outRoot, dir, name, bible, plan, rawAsks }) {
  let text = assemble(kind, ent.ref, ent.name);
  const first = checkEntity(kind, ent, text, bible, plan);
  let issues = first, repair = null;
  if (first.length) {
    const landmarks = kind === 'location' ? ent.landmarks.map((l) => ({ id: l.id, gloss: l.gloss })) : null;
    const c = await call({ outRoot, dir, name: `ref.repair.${ent.id}`, kind: 'refrepair', story: name, messages: [{ role: 'user', content: repairPrompt({ kind, ent, story, rawAsks, issues: msgs(first), landmarks }) }] });
    const p = parseJsonReply(c.content);
    const cand = p.ok ? normalizeRef(p.value?.ref && typeof p.value.ref === 'object' ? p.value.ref : p.value) : null;
    const bad = cand ? slotIssues(kind, cand, ent.id) : ['the reply was not a JSON object'];
    repair = { cost: c.cost, applied: false, structural: bad };
    if (!bad.length) {
      const trial = { ...ent, ref: cand };
      const t2 = assemble(kind, cand, ent.name);
      const i2 = checkEntity(kind, trial, t2, bible, plan);
      repair.after = msgs(i2);
      if (i2.length <= first.length) { ent.ref = cand; text = t2; issues = i2; repair.applied = true; }
    }
  }
  return { text, first, issues, repair };
}

async function oneLlm({ kind, ent, outRoot, dir, name, bible, plan }) {
  const messages = [{ role: 'system', content: refwriterSystem(kind) }, { role: 'user', content: refwriterBrief(kind, ent) }];
  const check = (text) => {
    const out = checkEntity(kind, ent, text, bible, plan);
    if (kind === 'location') { const cov = objectCoverage(plateObjects(ent.ref), text); if (cov < COVERAGE_MIN) out.push({ code: 'object_coverage', msg: `only ${(cov * 100).toFixed(0)}% of the slot objects appear in the paragraph; name every slot object` }); }
    return out;
  };
  const c1 = await call({ outRoot, dir, name: `ref.${ent.id}`, kind: 'refwriter', story: name, messages });
  let text = tidy(c1.content);
  const first = check(text);
  let issues = first, repair = null;
  if (first.length) {
    const c2 = await call({ outRoot, dir, name: `ref.${ent.id}.retry`, kind: 'refwriter', story: name, messages: [...messages, { role: 'assistant', content: text }, { role: 'user', content: `That paragraph failed these checks:\n${msgs(first).map((m) => `- ${m}`).join('\n')}\nWrite the whole paragraph again with the same rules and the same facts, correcting exactly these. Output only the paragraph.` }] });
    const t2 = tidy(c2.content), i2 = check(t2);
    repair = { cost: c2.cost, applied: false, after: msgs(i2) };
    if (t2 && i2.length <= first.length) { text = t2; issues = i2; repair.applied = true; }
  }
  return { text, first, issues, repair, cost: c1.cost };
}

export async function buildRefs({ name, story, outRoot, bible, plan, planMeta, mode = 'default' }) {
  const dir = join(outRoot, name, 'refs');
  const app = appearances(plan, bible);
  const all = refEntities(bible);
  for (const { kind, ent } of all) { ent.clips = app[ent.id]; ent.refImage = needsRef(kind, ent.clips); }
  const todo = all.filter(({ ent }) => ent.refImage);
  const skipped = Object.fromEntries(all.filter(({ ent }) => !ent.refImage).map(({ kind, ent }) => [ent.id, { type: kind, name: ent.name, clips: ent.clips }]));
  for (const { kind, ent } of todo) if (!ent.ref) throw new Error(`${ent.id} (${kind}) has no "ref" slots: bible.json is in the E4.1 format; delete it so the bible call runs again`);
  const results = await Promise.all(todo.map(({ kind, ent }) => (mode === 'llm' ? oneLlm : oneDefault)({ kind, ent, story, outRoot, dir: join(dir, 'calls'), name, bible, plan, rawAsks: planMeta.rawAsks })));
  const entities = {};
  todo.forEach(({ kind, ent }, i) => {
    const r = results[i], K = KINDS[kind];
    ent.imagePrompt = r.text;
    wr(join(dir, `${ent.id}.prompt.txt`), r.text);
    entities[ent.id] = {
      type: kind, name: ent.name, clips: ent.clips, skill: K.skill, writer: mode === 'llm' ? 'llm' : 'code', file: `${ent.id}.prompt.txt`, width: K.w, height: K.h, seeds: K.seeds,
      words: wordCount(r.text), namedObjectsInSlots: kind === 'location' ? namedObjectCount(ent.ref) : null, slotObjectPhrases: kind === 'location' ? plateObjects(ent.ref).length : null,
      checks: { firstDraft: msgs(r.first), repaired: !!r.repair?.applied, repairCall: !!r.repair, final: msgs(r.issues), pass: r.issues.length === 0 },
      ...(kind === 'character' ? { wardrobeNotShown: wardrobeMissing(ent, r.text) } : {}),
    };
  });
  const out = { story: name, mode, model: MODEL, rule: 'a character or prop needs at least 2 clips, a location 1', clipCounts: Object.fromEntries(all.map(({ kind, ent }) => [ent.id, { type: kind, clips: ent.clips.length, ref: ent.refImage }])), skipped, entities };
  wr(join(dir, 'refs.json'), out);
  return out;
}

export function renderScript(root) {
  const lines = [];
  for (const mode of readdirSync(root).filter((d) => /^(default|llm)$/.test(d)).sort()) {
    for (const story of readdirSync(join(root, mode)).filter((d) => existsSync(join(root, mode, d, 'refs'))).sort()) {
      const f = join(root, mode, story, 'refs', 'refs.json');
      if (!existsSync(f)) continue;
      for (const [id, e] of Object.entries(rj(f).entities)) lines.push(`render ${mode} ${story} ${id} ${e.width} ${e.height} ${e.seeds.join(' ')}`);
    }
  }
  const sh = `#!/usr/bin/env bash
# Renders every reference prompt under this directory with the intricate-location-plate skill's render.py
# (Qwen Image 2.1, workflow ~/.kshana/bundles/h3_chapter/workflows/qwen21_tti.json, 2 seeds per prompt, sizes of the skills:
# character sheet 2304x1312, location plate 1664x928, object 1408x1408). Output: <story>/<mode>/renders/<entityId>_<seed>.png
# The GPU belongs to the founder: this script refuses to run unless GPU_FREE=1 is set and the ComfyUI queue is empty. It never restarts ComfyUI.
#   GPU_FREE=1 bash ${root.replace(homedir(), '~')}/render.sh
set -euo pipefail
[ "\${GPU_FREE:-}" = "1" ] || { echo "GPU_FREE=1 not set: not rendering (the founder is using the GPU)."; exit 1; }
Q="$(curl -s http://5090.tail3cca41.ts.net:9000/comfyui/queue)"
echo "$Q" | python3 -c 'import sys,json; q=json.load(sys.stdin); n=len(q.get("queue_running",[]))+len(q.get("queue_pending",[])); print("queue entries:", n); sys.exit(1 if n else 0)' || { echo "ComfyUI queue is not empty: not rendering."; exit 1; }
HERE="$(cd "$(dirname "$0")" && pwd)"
RENDER="$HOME/.claude/skills/intricate-location-plate/scripts/render.py"
render() { # mode story entity width height seed...
  local mode=$1 story=$2 id=$3 w=$4 h=$5; shift 5
  mkdir -p "$HERE/$story/$mode/renders"
  (cd "$HERE/$story/$mode/renders" && python3 "$RENDER" "$HERE/$mode/$story/refs/$id.prompt.txt" "$w" "$h" "$id" "$@")
}
${lines.join('\n')}
`;
  writeFileSync(join(root, 'render.sh'), sh);
  chmodSync(join(root, 'render.sh'), 0o755);
  return lines.length;
}

if (import.meta.url === `file://${process.argv[1]}` && process.argv[2] === 'render-script') console.log(`${renderScript(process.argv[3])} render lines`);
