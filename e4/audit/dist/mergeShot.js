import { readJson, rs } from './inputs.js';
export function mergeShotLayers(referencesDoc, proseDoc) {
    if (!referencesDoc || !Array.isArray(referencesDoc.shots)) {
        return { ok: false, error: 'referencesInput did not resolve to a { sceneId, shots: [...] } document' };
    }
    if (!proseDoc || !Array.isArray(proseDoc.shots)) {
        return { ok: false, error: 'proseInput did not resolve to a { sceneId, shots: [...] } document' };
    }
    const proseById = new Map(proseDoc.shots.map((s) => [s.id, s]));
    const referenceIds = new Set(referencesDoc.shots.map((s) => s.id));
    const missingFromProse = referencesDoc.shots.map((s) => s.id).filter((id) => !proseById.has(id));
    if (missingFromProse.length > 0) {
        return {
            ok: false,
            error: `shot_prose is missing ${missingFromProse.length} shot(s) present in shot_references: ${missingFromProse.join(', ')} — re-run shot_prose for this scene`,
        };
    }
    // EXTRA prose shots are DROPPED, not fatal. The reference layer is the
    // authority on which shots exist (it is itself gated against the scene
    // breakdown), so prose for a shot that layer never declared is simply
    // discarded — noisily, so a persistently over-authoring prompt is visible.
    // A MISSING shot above stays fatal: that one loses work.
    // Measured 2026-09-02: shot_prose authored 3 shots for a 1-shot scene even
    // with the scene data injected; failing the merge for it wasted the two
    // good LLM calls that preceded it.
    let droppedShots = [];
    const extraInProse = proseDoc.shots.map((s) => s.id).filter((id) => !referenceIds.has(id));
    if (extraInProse.length > 0) {
        droppedShots = extraInProse;
        proseDoc = { ...proseDoc, shots: proseDoc.shots.filter((s) => referenceIds.has(s.id)) };
    }
    if (false) {
        return {
            ok: false,
            error: `unreachable`,
        };
    }
    const shots = referencesDoc.shots.map((ref) => {
        const prose = proseById.get(ref.id);
        return {
            subjectDefinitions: ref.subjectDefinitions,
            summary: prose.summary,
            retentionAnalysis: ref.retentionAnalysis,
            detailedDescription: prose.detailedDescription,
            overallSoundscape: prose.overallSoundscape,
            nonDiegeticMusic: prose.nonDiegeticMusic,
            references: ref.references,
            duration: prose.duration,
            performanceBeats: prose.performanceBeats,
            id: ref.id,
        };
    });
    return { ok: true, sceneId: referencesDoc.sceneId, shots, droppedShots: droppedShots.length ? droppedShots : undefined };
}
export const mergeShotRunner = {
    describe: () => ({
        id: 'h3.merge_shot',
        displayName: 'H3 shot layer merge (deterministic, no LLM)',
        description: "Combines ONE scene's shot_references output ({id,references,subjectDefinitions,retentionAnalysis}) with its shot_prose output ({id,detailedDescription,summary,overallSoundscape,nonDiegeticMusic,duration,performanceBeats}) into the single ShotPrompt shape h3.repair_shot/h3.audit_shot/h3.scene_render_manifest already consume, keyed by shot id in shot_references' own order. Pure mechanical merge -- fails loudly if either layer is missing a shot id the other has. Zero LLM calls.",
        capabilities: ['prep.merge'],
        modalities: { input: ['text'], output: ['text'] },
        configSchema: {
            type: 'object',
            required: ['referencesInput', 'proseInput', 'outputPath'],
            properties: {
                referencesInput: {
                    type: 'string',
                    description: "Input id of this scene's shot_references output ({ sceneId, shots: [...] }), matching scope.",
                },
                proseInput: {
                    type: 'string',
                    description: "Input id of this scene's shot_prose output ({ sceneId, shots: [...] }), matching scope.",
                },
                outputPath: {
                    type: 'string',
                    description: "Where to write the merged { sceneId, shots: [...] } ShotPrompt document -- relative to the project dir. Wire h3.repair_shot's promptInput at THIS node's output.",
                },
            },
        },
        costHint: 'free',
    }),
    run: async (ctx) => {
        const cfg = ctx.node.runner.config;
        const referencesDoc = readJson(ctx, rs(cfg, 'referencesInput'));
        let proseDoc = readJson(ctx, rs(cfg, 'proseInput'));
        const outputPath = rs(cfg, 'outputPath');
        if (!outputPath)
            return { ok: false, error: 'h3.merge_shot: config.outputPath is required' };
        const result = mergeShotLayers(referencesDoc, proseDoc);
        if (!result.ok)
            return { ok: false, error: `h3.merge_shot[${ctx.itemId ?? '?'}]: ${result.error}` };
        if (result.droppedShots?.length) {
            ctx.log?.(`h3.merge_shot[${ctx.itemId ?? '?'}]: dropped ${result.droppedShots.length} prose shot(s) ` +
                `shot_references never declared: ${result.droppedShots.join(', ')}`);
        }
        const { writeFileSync, mkdirSync } = await import('node:fs');
        const { dirname, resolve } = await import('node:path');
        const abs = resolve(ctx.projectDir, outputPath);
        mkdirSync(dirname(abs), { recursive: true });
        writeFileSync(abs, JSON.stringify({ sceneId: result.sceneId ?? ctx.itemId, shots: result.shots }, null, 2));
        return { ok: true, outputPath };
    },
};
//# sourceMappingURL=mergeShot.js.map