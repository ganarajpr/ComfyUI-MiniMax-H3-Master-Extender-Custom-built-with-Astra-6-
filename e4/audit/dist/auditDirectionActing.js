import { readJson, rs } from './inputs.js';
const FILLER_WORDS = new Set([
    'a', 'an', 'the', 'is', 'was', 'were', 'be', 'been', 'being', 'it', 'its', 'this', 'that', 'these',
    'those', 'to', 'of', 'in', 'on', 'with', 'as', 'for', 'and', 'or', 'but', 'because', 'since', 'so',
    'shot', 'angle', 'camera', 'chosen', 'choice', 'selected', 'selects', 'used', 'uses', 'using', 'we',
    'you', 'viewer', 'audience', 'here', 'here.', 'here,',
]);
function meaningfulTokens(s) {
    return s
        .toLowerCase()
        .replace(/[^a-z0-9\s]/g, ' ')
        .split(/\s+/)
        .filter((w) => w.length > 2 && !FILLER_WORDS.has(w));
}
/**
 * A deterministic proxy for "this justification just restates the angle
 * instead of arguing from dramatic intent" — the founder's own example: "a
 * low angle was chosen because it is a low angle." Real prose can't be
 * graded for QUALITY without an LLM, but a `whyThisAngle` whose meaningful
 * vocabulary is almost entirely drawn from `cameraAngle`'s own words, with
 * few or no NEW words of its own, cannot be arguing from anything the
 * camera angle didn't already say — it is restating, not justifying.
 */
export function isNearCopyOfCameraAngle(cameraAngle, whyThisAngle) {
    const camTokens = new Set(meaningfulTokens(cameraAngle));
    const whyTokens = meaningfulTokens(whyThisAngle);
    if (whyTokens.length === 0)
        return true;
    if (camTokens.size === 0)
        return false;
    const uniqueWhy = new Set(whyTokens);
    const newWords = [...uniqueWhy].filter((w) => !camTokens.has(w));
    const overlapCount = whyTokens.filter((w) => camTokens.has(w)).length;
    const overlapRatio = overlapCount / whyTokens.length;
    return overlapRatio >= 0.6 && newWords.length < 3;
}
export function auditDirectionActing(scene, sceneDirection, actingScene) {
    const findings = [];
    const fail = (code, message, shotId) => findings.push({ code, message, shotId });
    const sceneShotIds = (scene?.shots ?? []).map((s) => s.id);
    const sceneShotIdSet = new Set(sceneShotIds);
    const refsByShotId = new Map((scene?.shots ?? []).map((s) => [s.id, new Set(s.refs ?? [])]));
    if (sceneShotIds.length === 0) {
        fail('SCENE_HAS_NO_SHOTS', `scene "${scene?.id ?? '?'}" has no shots[] to audit`);
        return { ok: false, findings };
    }
    // ── scene_direction coverage ──
    if (!sceneDirection || !Array.isArray(sceneDirection.shots)) {
        fail('SCENE_DIRECTION_MISSING', 'scene_direction did not resolve to a { sceneId, sceneIntent, shots: [...] } document for this scene');
    }
    else {
        const seen = new Map();
        for (const entry of sceneDirection.shots) {
            const id = entry.shotId ?? '';
            if (!id)
                continue;
            seen.set(id, (seen.get(id) ?? 0) + 1);
            if (!sceneShotIdSet.has(id)) {
                fail('SCENE_DIRECTION_SHOT_UNKNOWN', `scene_direction.shots[] names shot "${id}", which this scene (${scene.id}) does not have — its own shots are [${sceneShotIds.join(', ')}]. Remove this entry or fix the id.`, id);
            }
        }
        for (const [id, count] of seen) {
            if (count > 1) {
                fail('SCENE_DIRECTION_SHOT_DUPLICATED', `scene_direction.shots[] has ${count} entries for shot "${id}" — exactly one is required.`, id);
            }
        }
        for (const id of sceneShotIds) {
            if (!seen.has(id)) {
                fail('SCENE_DIRECTION_SHOT_MISSING', `scene_direction.shots[] has no entry for shot "${id}" — every shot in scene_split.scenes[${scene.id}].shots[] needs exactly one direction entry.`, id);
            }
        }
        // ── per-shot direction field checks ──
        for (const entry of sceneDirection.shots) {
            const id = entry.shotId ?? '?';
            const cameraAngle = String(entry.cameraAngle ?? '').trim();
            const whyThisAngle = String(entry.whyThisAngle ?? '').trim();
            const whatItShows = String(entry.whatItShows ?? '').trim();
            if (!whatItShows)
                fail('WHAT_IT_SHOWS_EMPTY', `shot "${id}": whatItShows is empty — state what this shot actually shows.`, id);
            if (!cameraAngle)
                fail('CAMERA_ANGLE_EMPTY', `shot "${id}": cameraAngle is empty — name the angle.`, id);
            if (!whyThisAngle) {
                fail('WHY_THIS_ANGLE_EMPTY', `shot "${id}": whyThisAngle is empty — every camera choice must be justified from the scene's dramatic intent, never left bare.`, id);
            }
            else if (cameraAngle && isNearCopyOfCameraAngle(cameraAngle, whyThisAngle)) {
                fail('WHY_THIS_ANGLE_NEAR_COPY', `shot "${id}": whyThisAngle ("${whyThisAngle}") mostly restates cameraAngle ("${cameraAngle}") instead of arguing from what the audience should feel or notice — e.g. "a low angle was chosen because it is a low angle" is not a justification. Rewrite it to argue from this scene's dramatic intent, not the angle's own name.`, id);
            }
        }
    }
    // ── acting_scene per-shot coverage ──
    if (!actingScene || !Array.isArray(actingScene.shots)) {
        fail('ACTING_SCENE_SHOTS_MISSING', 'acting_scene did not resolve to a document with a shots[] array for this scene');
    }
    else {
        const seen = new Map();
        for (const entry of actingScene.shots) {
            const id = entry.shotId ?? '';
            if (!id)
                continue;
            seen.set(id, (seen.get(id) ?? 0) + 1);
            if (!sceneShotIdSet.has(id)) {
                fail('ACTING_SCENE_SHOT_UNKNOWN', `acting_scene.shots[] names shot "${id}", which this scene (${scene.id}) does not have — its own shots are [${sceneShotIds.join(', ')}]. Remove this entry or fix the id.`, id);
            }
        }
        for (const [id, count] of seen) {
            if (count > 1) {
                fail('ACTING_SCENE_SHOT_DUPLICATED', `acting_scene.shots[] has ${count} entries for shot "${id}" — exactly one is required.`, id);
            }
        }
        for (const id of sceneShotIds) {
            if (!seen.has(id)) {
                fail('ACTING_SCENE_SHOT_MISSING', `acting_scene.shots[] has no entry for shot "${id}" — every shot with a character present needs a per-shot acting entry.`, id);
            }
        }
        // ── per-shot per-character field checks + presence check ──
        for (const entry of actingScene.shots) {
            const id = entry.shotId ?? '?';
            const expectedRefs = refsByShotId.get(id ?? '') ?? new Set();
            const listedIds = new Set();
            for (const c of entry.characters ?? []) {
                const characterId = c.characterId ?? '?';
                listedIds.add(characterId);
                const fields = [
                    ['behaviours', c.behaviours],
                    ['lookingAt', c.lookingAt],
                    ['interactingWith', c.interactingWith],
                    ['stateChange', c.stateChange],
                ];
                for (const [field, value] of fields) {
                    if (!String(value ?? '').trim()) {
                        fail('ACTING_SHOT_CHARACTER_FIELD_EMPTY', `shot "${id}", character "${characterId}": ${field} is empty — an omitted field is indistinguishable from forgetting it. If the honest answer is "nothing"/"no change", say so explicitly (e.g. interactingWith: "nothing"; stateChange: "no change").`, id);
                    }
                }
            }
            if (expectedRefs.size > 0) {
                for (const refId of expectedRefs) {
                    if (!listedIds.has(refId)) {
                        fail('ACTING_SHOT_CHARACTER_MISSING', `shot "${id}": character "${refId}" is physically present (scene_split.shots[].refs) but has no per-shot acting entry.`, id);
                    }
                }
                for (const listedId of listedIds) {
                    if (!expectedRefs.has(listedId)) {
                        fail('ACTING_SHOT_CHARACTER_EXTRA', `shot "${id}": character "${listedId}" has a per-shot acting entry but scene_split does not list them as present (refs) in this shot — only characters actually present belong here.`, id);
                    }
                }
            }
        }
    }
    return { ok: findings.length === 0, findings };
}
export const auditDirectionActingRunner = {
    describe: () => ({
        id: 'h3.audit_direction_acting',
        displayName: 'H3 direction + acting per-shot audit (deterministic gate, blocking, before shot_references)',
        description: "Sits between acting_scene and shot_references in h3_film. Deterministic, zero LLM calls: every shot in scene_split for this scene must have exactly one scene_direction.shots[] entry (whatItShows/cameraAngle/whyThisAngle, all non-empty, whyThisAngle not a near-copy of cameraAngle) and exactly one acting_scene.shots[] entry (one characters[] row per character actually present, each with behaviours/lookingAt/interactingWith/stateChange all non-empty). BLOCKS (ok:false) the whole scene's shot_references call on any violation.",
        capabilities: ['audit.deterministic', 'audit.direction_acting_coverage'],
        modalities: { input: ['text'], output: ['text'] },
        configSchema: {
            type: 'object',
            required: ['sceneSplitInput', 'sceneDirectionInput', 'actingSceneInput', 'outputPath'],
            properties: {
                sceneSplitInput: {
                    type: 'string',
                    description: "Input id of scene_split (a STAGE — resolves to the whole film breakdown; this runner selects ctx.itemId's own scene from scenes[]).",
                },
                sceneDirectionInput: {
                    type: 'string',
                    description: "Input id of THIS scene's scene_direction output ({ sceneId, sceneIntent, shots: [...] }), matching scope.",
                },
                actingSceneInput: {
                    type: 'string',
                    description: "Input id of THIS scene's acting_scene output ({ sceneId, characters, voiceProfiles, shots: [...] }), matching scope.",
                },
                outputPath: {
                    type: 'string',
                    description: 'Where to write { ok, sceneId, findings } — relative to the project dir. Wire shot_references to depend on THIS node (usage: context, scope: matching) purely to gate ordering, the same pattern shot_prose uses ahead of shot_reference_audit.',
                },
            },
        },
        costHint: 'free',
    }),
    run: async (ctx) => {
        const cfg = ctx.node.runner.config;
        let scene = readJson(ctx, rs(cfg, 'sceneSplitInput'));
        const sceneDirection = readJson(ctx, rs(cfg, 'sceneDirectionInput'));
        const actingScene = readJson(ctx, rs(cfg, 'actingSceneInput'));
        const outputPath = rs(cfg, 'outputPath');
        if (!scene)
            return { ok: false, error: 'h3.audit_direction_acting: sceneSplitInput did not resolve to a JSON object' };
        if (!outputPath)
            return { ok: false, error: 'h3.audit_direction_acting: config.outputPath is required' };
        // scene_split is a STAGE: what lands here may be the WHOLE film
        // breakdown ({chapters, locations, scenes[], shots[]}), not one scene —
        // same defensive lookup as h3.audit_scene.
        const asBreakdown = scene;
        if (Array.isArray(asBreakdown.scenes)) {
            const match = asBreakdown.scenes.find((sc) => sc?.id === ctx.itemId);
            if (!match) {
                return {
                    ok: false,
                    error: `h3.audit_direction_acting: sceneSplitInput resolved to the whole film breakdown and it has no scene with id '${ctx.itemId ?? '?'}' (has: ${asBreakdown.scenes.map((sc) => sc?.id).join(', ')})`,
                };
            }
            scene = match;
        }
        const { ok, findings } = auditDirectionActing(scene, sceneDirection, actingScene);
        const { writeFileSync, mkdirSync } = await import('node:fs');
        const { dirname, resolve } = await import('node:path');
        const abs = resolve(ctx.projectDir, outputPath);
        mkdirSync(dirname(abs), { recursive: true });
        writeFileSync(abs, JSON.stringify({ ok, sceneId: ctx.itemId ?? scene.id, findings }, null, 2));
        for (const f of findings)
            ctx.log(`h3.audit_direction_acting[${ctx.itemId ?? '?'}] ${f.code}: ${f.message}`);
        if (!ok) {
            return {
                ok: false,
                error: `h3.audit_direction_acting[${ctx.itemId ?? '?'}]: BLOCKED — ${findings.length} finding(s): ${findings.map((f) => `[${f.code}] ${f.message}`).join(' | ')}`,
            };
        }
        return { ok: true, outputPath };
    },
};
//# sourceMappingURL=auditDirectionActing.js.map