import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { rs } from './inputs.js';
/**
 * `h3.narrative_seed` -- the bundle's SECOND preflight (alongside
 * `h3.continuity_prep`), added in h3_film v0.3.0 so a film can start from a
 * rough sketch or a storyboard, not only from story prose.
 *
 * WHY THIS RUNNER HAS TO EXIST (not just three optional bundle inputs read
 * straight by `screenplay`'s `llm.generate` template): `story_input`,
 * `storyboard_input` and `sketch_input` are all `kind:"file", required:false`
 * bundle inputs. `resolveBundleInputs` (dhee-core walker.ts) SKIPS setting a
 * key at all for an absent optional file input -- it does not set it to `""`
 * or `null`. `llm.generate`'s `substituteTemplate` hard-fails the WHOLE call
 * ("prompt template references variable(s) that were not provided") the
 * moment ANY `{{name}}` token in the template has no matching key in
 * `ctx.inputs`, regardless of whether OTHER referenced inputs resolved fine.
 * There is no conditional templating (`{{#if}}`) to fall back on. So a
 * `screenplay` prompt that referenced `{{story_input}}`, `{{storyboard_input}}`
 * and `{{sketch_input}}` directly would crash on every run where the operator
 * supplied only ONE of the three -- which is the whole point of this feature
 * (start from JUST a sketch, or JUST a storyboard).
 *
 * This runner is a real DAG NODE (not a bundle input), so its JSON output is
 * ALWAYS present in `ctx.inputs['narrative_seed']` for any node downstream
 * that runs at all -- `screenplay` and `shot_prompt` reference
 * `{{narrative_seed}}` (one always-present key) instead of the three
 * independently-optional raw inputs. The three `has*` flags let the prompt
 * behave differently per combination without ever hitting a missing-key
 * crash.
 *
 * Deterministic, zero LLM calls. Refuses (`ok:false`) when NONE of the three
 * is supplied -- the bundle's explicit "must refuse to run with none of the
 * three" requirement, enforced here rather than left to an LLM's judgement.
 */
const IMAGE_RE = /\.(png|jpe?g|webp|gif|bmp)$/i;
export const narrativeSeedPrepRunner = {
    describe: () => ({
        id: 'h3.narrative_seed',
        displayName: 'Narrative seed prep (story / storyboard / sketch, no LLM)',
        description: "Reads the three optional starting-material bundle inputs (story_input text, storyboard_input image, sketch_input image), refuses the run when NONE is supplied, and writes an ALWAYS-PRESENT plans/narrative_seed.json describing which are present so screenplay/shot_prompt can reference one guaranteed key instead of three independently-optional ones. Zero LLM calls.",
        capabilities: ['prep.preflight', 'prep.passthrough'],
        modalities: { input: ['text', 'image'], output: ['text'] },
        configSchema: {
            type: 'object',
            required: ['outputPath'],
            properties: {
                storyInput: { type: 'string', description: "OPTIONAL. ctx.inputs key holding the raw story prose text. Default 'story_input'." },
                storyboardInput: { type: 'string', description: "OPTIONAL. ctx.inputs key holding the storyboard image path. Default 'storyboard_input'." },
                sketchInput: { type: 'string', description: "OPTIONAL. ctx.inputs key holding the sketch image path. Default 'sketch_input'." },
                outputPath: { type: 'string', description: 'Where to write the resolved narrative_seed.json -- relative to the project dir.' },
            },
        },
        costHint: 'free',
    }),
    run: async (ctx) => {
        const cfg = ctx.node.runner.config;
        const outputPath = rs(cfg, 'outputPath');
        if (!outputPath)
            return { ok: false, error: 'h3.narrative_seed: config.outputPath is required' };
        const storyKey = rs(cfg, 'storyInput') ?? 'story_input';
        const storyboardKey = rs(cfg, 'storyboardInput') ?? 'storyboard_input';
        const sketchKey = rs(cfg, 'sketchInput') ?? 'sketch_input';
        const storyRaw = ctx.inputs[storyKey];
        const storyboardRaw = ctx.inputs[storyboardKey];
        const sketchRaw = ctx.inputs[sketchKey];
        const storyText = typeof storyRaw === 'string' ? storyRaw.trim() : '';
        const hasStory = storyText.length > 0;
        const isRealImagePath = (v) => typeof v === 'string' && v.trim().length > 0 && IMAGE_RE.test(v) && existsSync(v);
        const hasStoryboard = isRealImagePath(storyboardRaw);
        const hasSketch = isRealImagePath(sketchRaw);
        if (!hasStory && !hasStoryboard && !hasSketch) {
            return {
                ok: false,
                error: 'h3.narrative_seed: no starting material supplied. Provide at least ONE of: story_input ' +
                    '(inputs/story.md, chapter-wise prose), storyboard_input (inputs/storyboard.png|jpg, one sheet ' +
                    'or a contact sheet of numbered panels), or sketch_input (inputs/sketch.png|jpg, a rough drawing ' +
                    "of the world/character/moment). This bundle refuses to invent a story from nothing.",
            };
        }
        const seed = {
            hasStory,
            hasStoryboard,
            hasSketch,
        };
        if (hasStory)
            seed['storyText'] = storyText;
        if (hasStoryboard)
            seed['storyboardPath'] = storyboardRaw;
        if (hasSketch)
            seed['sketchPath'] = sketchRaw;
        const abs = resolve(ctx.projectDir, outputPath);
        mkdirSync(dirname(abs), { recursive: true });
        writeFileSync(abs, JSON.stringify(seed, null, 2), 'utf-8');
        ctx.log(`h3.narrative_seed: hasStory=${hasStory} hasStoryboard=${hasStoryboard} hasSketch=${hasSketch}`);
        return { ok: true, outputPath, metadata: { hasStory, hasStoryboard, hasSketch } };
    },
};
//# sourceMappingURL=narrativeSeedPrep.js.map