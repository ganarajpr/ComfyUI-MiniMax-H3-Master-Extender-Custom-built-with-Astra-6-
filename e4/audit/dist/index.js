import { auditShotRunner } from './auditShot.js';
import { auditFilmRunner } from './auditFilm.js';
import { auditSceneRunner } from './auditScene.js';
import { auditShotReferencesRunner } from './auditShotReferences.js';
import { auditDirectionActingRunner } from './auditDirectionActing.js';
import { auditDialogueLedgerRunner } from './auditDialogueLedger.js';
import { continuityPrepRunner } from './continuityPrep.js';
import { repairShotRunner } from './repairShot.js';
import { sceneRenderManifestRunner } from './sceneRenderManifest.js';
import { mergeShotRunner } from './mergeShot.js';
import { narrativeSeedPrepRunner } from './narrativeSeedPrep.js';
export { auditShot, resolveBreakdownItem, auditReferenceLayer, grantedPlatesFrom } from './auditShot.js';
export { auditFilm } from './auditFilm.js';
export { auditScene } from './auditScene.js';
export { auditShotReferencesRunner } from './auditShotReferences.js';
export { auditDirectionActing, isNearCopyOfCameraAngle, auditDirectionActingRunner } from './auditDirectionActing.js';
export { ledgerLineImplausibilityReason, detectNoDialogueSignal, auditDialogueLedgerRunner } from './auditDialogueLedger.js';
export { continuityPrepRunner } from './continuityPrep.js';
export { repairShotLoop, repairShotRunner } from './repairShot.js';
export { buildSceneRenderManifest, sceneRenderManifestRunner } from './sceneRenderManifest.js';
export { mergeShotLayers, mergeShotRunner } from './mergeShot.js';
export { narrativeSeedPrepRunner } from './narrativeSeedPrep.js';
export * from './types.js';
export * from './text.js';
const VERSION = '0.14.0';
const ENGINE_COMPAT = '>=0.1.0';
const mkManifest = (tool, displayName, description) => ({
    tool,
    version: VERSION,
    engineCompat: ENGINE_COMPAT,
    credentials: [],
    displayName,
    description,
    permissions: { network: [], filesystem: 'project', subprocess: false, env: [] },
});
export const runners = [
    {
        manifest: mkManifest('h3.narrative_seed', 'Narrative seed prep (story / storyboard / sketch, no LLM)', "h3_film's SECOND preflight, added v0.3.0: resolves story_input/storyboard_input/sketch_input (each independently optional) into one ALWAYS-PRESENT plans/narrative_seed.json ({hasStory, storyText?, hasStoryboard, storyboardPath?, hasSketch, sketchPath?}) so downstream llm.generate prompts (screenplay, shot_prompt) can reference a single guaranteed key instead of three independently-optional bundle inputs, which would hard-fail template substitution the moment any one is absent. Refuses (ok:false) when none of the three is supplied."),
        runner: narrativeSeedPrepRunner,
    },
    {
        manifest: mkManifest('h3.continuity_prep', 'Continuity prep (structural validation, no LLM)', "Validates continuity_input's shape and cross-checks every dialogue_ledger speaker against the declared cast, then writes plans/continuity.json so downstream collections can fan out over cast[]."),
        runner: continuityPrepRunner,
    },
    {
        manifest: mkManifest('h3.audit_shot', 'H3 shot audit (deterministic, blocking)', 'Layer 1 per-shot audit ported from h3-shots submit.mjs: dialogue byte-match against the ledger, speaker attribution, native script, speech-without-words, soundscape vocal-free, no authored <Picture N>, forbidden-word sweep, music sentinel, format/frame-grid. Zero LLM calls, ok:false blocks the run.'),
        runner: auditShotRunner,
    },
    {
        manifest: mkManifest('h3.audit_film', 'H3 film audit (deterministic, blocking)', 'Layer 2 film-level audit ported from h3-shots audit_film.mjs: every ledger line spoken exactly once in script order, no duplicate shot ids, wardrobe/side agreement across shots, Layer 1 completeness. Zero LLM calls, ok:false blocks every downstream render.'),
        runner: auditFilmRunner,
    },
    {
        manifest: mkManifest('h3.audit_scene', 'H3 scene audit (deterministic, blocking, within one scene)', "Layer 2b, added for h3_film: the same cross-shot checks as h3.audit_film (ledger coverage/order, side/wardrobe agreement, (Sx) speaker-id consistency), scoped to ONE scene's shots -- a defect in one scene blocks only that scene's Long Media render. Reuses auditFilm() on the scene's own shot subset. Zero LLM calls."),
        runner: auditSceneRunner,
    },
    {
        manifest: mkManifest('h3.audit_shot_references', 'H3 shot reference-layer audit (deterministic gate, blocking, before prose)', "h3_film v0.6.0: sits between shot_references and shot_prose. Deterministic, zero LLM calls: every shot's references[] must be a subset of this scene's scene_manifest grant, and subjectDefinitions/retentionAnalysis must each have exactly one entry per reference, 1..N, a valid retention marker, and no (Sx) speaker tag. BLOCKS the whole scene's shot_prose call (ok:false halts the walk) on any violation. Reuses auditShot()'s own auditReferenceLayer() -- one implementation of these checks shared with the full post-merge h3.audit_shot/h3.repair_shot."),
        runner: auditShotReferencesRunner,
    },
    {
        manifest: mkManifest('h3.audit_direction_acting', 'H3 direction + acting per-shot audit (deterministic gate, blocking, before shot_references)', "h3_film: sits between acting_scene and shot_references. Deterministic, zero LLM calls: every shot in scene_split for this scene must have exactly one scene_direction.shots[] entry (whatItShows/cameraAngle/whyThisAngle, all non-empty, whyThisAngle not a near-copy of cameraAngle) and exactly one acting_scene.shots[] entry (one characters[] row per character actually present, each with behaviours/lookingAt/interactingWith/stateChange all non-empty). BLOCKS (ok:false) the whole scene's shot_references call on any violation."),
        runner: auditDirectionActingRunner,
    },
    {
        manifest: mkManifest('h3.audit_dialogue_ledger', 'H3 dialogue ledger audit (deterministic gate, blocking, before anything consumes the ledger)', "h3_film: sits immediately after dialogue_ledger, before continuity/shot_prose/any audit reads it. Deterministic, zero LLM calls: (1) rejects a ledger entry that is not plausibly something a person says out loud -- a stage direction ('He checks his watch.') or narration reporting speech accepted as spoken dialogue, requiring several mechanical signals to agree so a terse real line is never over-rejected; (2) when the film's own source material states there is no dialogue, requires the ledger to be EMPTY. BLOCKS (ok:false) on any violation."),
        runner: auditDialogueLedgerRunner,
    },
    {
        manifest: mkManifest('h3.merge_shot', 'H3 shot layer merge (deterministic, no LLM)', "h3_film v0.6.0: combines ONE scene's shot_references output ({id,references,subjectDefinitions,retentionAnalysis}) with its shot_prose output ({id,detailedDescription,summary,overallSoundscape,nonDiegeticMusic,duration,performanceBeats}) into the single ShotPrompt shape h3.repair_shot/h3.audit_shot/h3.scene_render_manifest already consume. Pure mechanical merge-by-shot-id -- fails loudly if either layer is missing or invents a shot id the other does not have. Zero LLM calls."),
        runner: mergeShotRunner,
    },
    {
        manifest: mkManifest('h3.repair_shot', 'H3 shot repair (bounded, fast-model, structured-finding loop)', "Sits between shot_prompt and shot_audit in h3_film. Runs the same auditShot() as h3.audit_shot; clean shots pass through untouched (no LLM call). Findings repair via ctx.llm on a FAST tier (default 'medium', never 'heavy'), re-audited, up to maxIterations attempts (default 3), then BLOCKS loudly with the surviving findings if the gate still fails. Uses ctx.llm.generateText -- a LOCAL model only, per the founder's model policy."),
        runner: repairShotRunner,
    },
    {
        manifest: mkManifest('h3.scene_render_manifest', 'H3 scene render manifest (deterministic, no LLM)', "Assembles ONE scene's h3.longmedia promptInput document from this bundle's authored ShotPrompt JSON. Pure mechanical transform (frames from duration, refIds from references[].id/stateId, six sections camelCase->snake_case). Zero LLM calls."),
        runner: sceneRenderManifestRunner,
    },
];
export default runners;
//# sourceMappingURL=index.js.map