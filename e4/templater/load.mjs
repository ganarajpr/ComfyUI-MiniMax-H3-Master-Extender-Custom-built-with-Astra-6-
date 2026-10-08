// Fixture loader. A "fixture" is the directory the LLM candidates were given:
//   <dir>/project/plans/{scene_split,dialogue_ledger,continuity,world_state}.json
//   <dir>/project/plans/{scene_direction,acting_scene,scene_manifest}/<sceneId>.json
//   <dir>/project/plans/acting_master/<characterId>.json
//   <dir>/project/prompts/shot_references/<sceneId>.json
// A different film plugs in by shipping the same layout.

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

const sha = (buf) => createHash('sha256').update(buf).digest('hex');

export const titleCase = (id) => String(id).split(/[_\s-]+/).map((w) => (w ? w[0].toUpperCase() + w.slice(1) : w)).join(' ');

export function loadFixture(dir) {
  const P = join(dir, 'project');
  const hashes = {};
  const read = (rel) => {
    const buf = readFileSync(join(P, rel));
    hashes[rel] = sha(buf);
    return buf.toString('utf8');
  };
  const J = (rel) => JSON.parse(read(rel));

  const refFiles = readdirSync(join(P, 'prompts/shot_references')).filter((f) => f.endsWith('.json'));
  if (refFiles.length !== 1) throw new Error(`expected exactly one scene in prompts/shot_references, found ${refFiles.length}`);
  const refs = J(`prompts/shot_references/${refFiles[0]}`);
  const sceneId = refs.sceneId;

  const split = J('plans/scene_split.json');
  const ledger = J('plans/dialogue_ledger.json');
  const continuity = J('plans/continuity.json');
  const world = J('plans/world_state.json');
  const direction = J(`plans/scene_direction/${sceneId}.json`);
  const actingScene = J(`plans/acting_scene/${sceneId}.json`);
  const manifest = existsSync(join(P, `plans/scene_manifest/${sceneId}.json`)) ? J(`plans/scene_manifest/${sceneId}.json`) : null;
  const masters = {};
  for (const f of readdirSync(join(P, 'plans/acting_master')).filter((x) => x.endsWith('.json'))) {
    const m = J(`plans/acting_master/${f}`);
    masters[m.characterId] = m;
  }

  const scene = (split.scenes || []).find((s) => s.id === sceneId);
  if (!scene) throw new Error(`scene ${sceneId} not in scene_split`);
  const ledgerById = new Map(ledger.map((l) => [l.id, l]));
  const castById = new Map((continuity.cast || []).map((c) => [c.id, c]));

  const shots = refs.shots.map((r, index) => {
    const breakdown = scene.shots.find((s) => s.id === r.id);
    const dir = (direction.shots || []).find((s) => s.shotId === r.id);
    const act = ((actingScene.shots || []).find((s) => s.shotId === r.id) || {}).characters || [];
    if (!breakdown || !dir) throw new Error(`shot ${r.id} missing from scene_split or scene_direction`);
    return {
      id: r.id,
      index,
      // a character reference may name an appearance state ("rhea__state01"); the character is the part before "__"
      references: r.references.map((ref) => (ref.type === 'character' && ref.id.includes('__') ? { ...ref, stateId: ref.stateId || ref.id, id: ref.id.split('__')[0] } : ref)),
      subjectDefinitions: r.subjectDefinitions || '',
      breakdown,
      direction: dir,
      acting: act,
      lines: (breakdown.lineIds || []).map((id) => {
        const l = ledgerById.get(id);
        if (!l) throw new Error(`ledger line ${id} missing`);
        return l;
      }),
    };
  });

  return { world, dir, sceneId, split, scene, ledger, continuity, direction, actingScene, manifest, masters, castById, shots, hashes, refs };
}
