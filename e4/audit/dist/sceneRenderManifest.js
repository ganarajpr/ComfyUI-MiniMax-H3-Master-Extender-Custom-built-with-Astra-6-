import { resolvePerShotPrompts, readJson, rs } from './inputs.js';
import { secondsToFrames } from './text.js';
/**
 * `h3.scene_render_manifest` — assembles ONE scene's `h3.longmedia`
 * `promptInput` document (`dhee-runner-h3-longmedia`'s own contract:
 * `{ shots: [{ id, frames, refIds, sections | prompt }] }`) from this
 * bundle's own `ShotPrompt` shape (camelCase: `duration`,
 * `references[].id`, `subjectDefinitions`/`detailedDescription`/…).
 *
 * Purely mechanical, zero LLM/judgement — the same reason
 * `comfy.minimax_h3_r2v` builds its `<Picture N>` binding clause in code
 * rather than asking a model to guess the final slot order: `frames` is a
 * pure function of `duration` (already grid-legal, `h3.audit_shot`/
 * `h3.repair_shot` enforced that upstream), `refIds` is a pure projection
 * of `references[].id` (falling back to `stateId` when a character
 * reference names one — see the field comment on `h3_film`'s own
 * `shot_prompt.schema.json`, a deliberate extension over `h3_shots`' for
 * multi-state characters), and the six H3 sections are a pure
 * camelCase→snake_case rename, nothing more. Putting an LLM in this path
 * would only be a chance to reintroduce exactly the drift
 * `h3.repair_shot`'s downstream `h3.audit_shot` re-check already
 * guarantees is gone.
 */
export function buildSceneRenderManifest(scene, shotPrompts) {
    if (!scene || !Array.isArray(scene.shots) || scene.shots.length === 0) {
        return { ok: false, error: `scene "${scene?.id ?? '?'}" has no shots[] to assemble` };
    }
    const byId = new Map(shotPrompts.map((p) => [p.itemId, p.value]));
    const shots = [];
    for (const shot of scene.shots) {
        const prompt = byId.get(shot.id);
        if (!prompt) {
            return { ok: false, error: `no authored shot_prompt found for shot "${shot.id}" (scene "${scene.id}") — h3.repair_shot/shot_prompt must run first` };
        }
        const duration = Number(prompt.duration);
        if (!Number.isFinite(duration) || duration <= 0) {
            return { ok: false, error: `shot "${shot.id}" has an invalid duration: ${JSON.stringify(prompt.duration)}` };
        }
        const refIds = (prompt.references ?? []).map((r) => {
            const withState = r;
            return withState.stateId || withState.id;
        });
        shots.push({
            id: shot.id,
            frames: secondsToFrames(duration),
            refIds,
            sections: {
                subject_definitions: prompt.subjectDefinitions ?? '',
                summary: prompt.summary,
                retention_analysis: prompt.retentionAnalysis ?? '',
                detailed_description: prompt.detailedDescription,
                overall_soundscape: prompt.overallSoundscape,
                non_diegetic_music: prompt.nonDiegeticMusic,
            },
        });
    }
    return { ok: true, manifest: { shots } };
}
export const sceneRenderManifestRunner = {
    describe: () => ({
        id: 'h3.scene_render_manifest',
        displayName: 'H3 scene render manifest (deterministic, no LLM)',
        description: "Assembles ONE scene's h3.longmedia promptInput document ({ shots: [{ id, frames, refIds, sections }] }) from this bundle's authored ShotPrompt JSON (scope:'all') and the scene's own shot list (scope:'matching', self-selected by id). Pure mechanical transform: frames from duration, refIds from references[].id/stateId, sections from a camelCase->snake_case rename. Zero LLM calls.",
        capabilities: ['prep.passthrough'],
        modalities: { input: ['text'], output: ['text'] },
        configSchema: {
            type: 'object',
            required: ['sceneInput', 'promptsInput', 'outputPath'],
            properties: {
                sceneInput: { type: 'string', description: "Input id of THIS scene's own descriptor ({ id, shots: [...] }), matching scope." },
                promptsInput: { type: 'string', description: "scope:'all' input id of every shot's (possibly repaired) authored prompt JSON, keyed by shot item id." },
                outputPath: { type: 'string', description: 'Where to write the assembled manifest — relative to the project dir. Wire h3.longmedia\'s promptInput at THIS node\'s output.' },
            },
        },
        costHint: 'free',
    }),
    run: async (ctx) => {
        const cfg = ctx.node.runner.config;
        let scene = readJson(ctx, rs(cfg, 'sceneInput'));
        const outputPath = rs(cfg, 'outputPath');
        if (!scene)
            return { ok: false, error: 'h3.scene_render_manifest: sceneInput did not resolve to a JSON object' };
        // `sceneInput` is wired to `scene_split`, a STAGE node — scope:'matching'
        // cannot narrow it, so the WHOLE film breakdown lands here. Select THIS
        // scene by ctx.itemId, or `scene.shots` is the film-wide flat list and we
        // demand a prompt for every shot in the film. Measured 2026-09-02 on
        // scene01: asked for shot002's prompt while building scene01's manifest.
        const asBreakdown = scene;
        if (Array.isArray(asBreakdown.scenes)) {
            const match = asBreakdown.scenes.find((sc) => sc?.id === ctx.itemId);
            if (!match) {
                return {
                    ok: false,
                    error: `h3.scene_render_manifest: sceneInput resolved to the whole film breakdown and it has no scene with id '${ctx.itemId ?? '?'}' (has: ${asBreakdown.scenes.map((sc) => sc?.id).join(', ')})`,
                };
            }
            scene = match;
        }
        if (!outputPath)
            return { ok: false, error: 'h3.scene_render_manifest: config.outputPath is required' };
        // h3_film v0.2.0: promptsInput (shot_repair) is now a SCENE-granular
        // collection, wired via scope:'matching' -- resolvePerShotPrompts gets
        // the exact single scene document directly, no film-wide dependency.
        const shotPrompts = resolvePerShotPrompts(ctx, rs(cfg, 'promptsInput'));
        const result = buildSceneRenderManifest(scene, shotPrompts);
        if (!result.ok)
            return { ok: false, error: `h3.scene_render_manifest[${ctx.itemId ?? '?'}]: ${result.error}` };
        const { writeFileSync, mkdirSync } = await import('node:fs');
        const { dirname, resolve } = await import('node:path');
        const abs = resolve(ctx.projectDir, outputPath);
        mkdirSync(dirname(abs), { recursive: true });
        writeFileSync(abs, JSON.stringify(result.manifest, null, 2));
        return { ok: true, outputPath };
    },
};
//# sourceMappingURL=sceneRenderManifest.js.map