import { readJson, resolveInputPath, rs } from './inputs.js';
import { auditReferenceLayer, grantedPlatesFrom } from './auditShot.js';
import { normalizeReferenceLayerShot } from './normalizeReferenceLayer.js';
export const auditShotReferencesRunner = {
    describe: () => ({
        id: 'h3.audit_shot_references',
        displayName: 'H3 shot reference-layer audit (deterministic gate, blocking, before prose)',
        description: "Sits between shot_references and shot_prose in h3_film. Deterministic, zero LLM calls: verifies every shot's references[] is a subset of this scene's scene_manifest grant, and that subjectDefinitions/retentionAnalysis each have exactly one entry per reference, 1..N, with a valid retention marker and no (Sx) speaker tag. BLOCKS (ok:false) the whole scene's shot_prose call on any violation. Reuses auditShot()'s own reference-layer checks (auditReferenceLayer) so there is exactly one implementation of these checks, not two.",
        capabilities: ['audit.deterministic', 'audit.reference_layer'],
        modalities: { input: ['text'], output: ['text'] },
        configSchema: {
            type: 'object',
            required: ['referencesInput', 'manifestInput', 'outputPath'],
            properties: {
                referencesInput: {
                    type: 'string',
                    description: "Input id of this scene's shot_references output ({ sceneId, shots: [{ id, references, subjectDefinitions, retentionAnalysis }] }), matching scope.",
                },
                manifestInput: {
                    type: 'string',
                    description: "Input id of this scene's scene_manifest ({ references: [{ id, ... }] }), matching scope -- the authority for which plate ids are legal in this scene.",
                },
                referencesPath: {
                    type: 'string',
                    description: "Path template of the shot_references file itself (e.g. 'prompts/shot_references/{{item_id}}.json'), so a deterministic normalization can be written BACK to where shot_prose reads it. Required for the normalization to persist -- ctx.inputs carries the parsed value, not its path. Without it the node still audits, but logs a WARNING and leaves the original in place.",
                },
                outputPath: {
                    type: 'string',
                    description: "Where to write { ok, sceneId, perShot, findings } -- relative to the project dir. Wire shot_prose to depend on THIS node (usage:'context', scope:'matching') purely to gate ordering, the same pattern scene_audit uses ahead of scene_render_manifest -- shot_prose still reads shot_references directly for its own content.",
                },
            },
        },
        costHint: 'free',
    }),
    run: async (ctx) => {
        const cfg = ctx.node.runner.config;
        const doc = readJson(ctx, rs(cfg, 'referencesInput'));
        const manifestDoc = readJson(ctx, rs(cfg, 'manifestInput'));
        const outputPath = rs(cfg, 'outputPath');
        if (!doc || !Array.isArray(doc.shots)) {
            return { ok: false, error: 'h3.audit_shot_references: referencesInput did not resolve to a { sceneId, shots: [...] } document' };
        }
        if (!outputPath)
            return { ok: false, error: 'h3.audit_shot_references: config.outputPath is required' };
        const grantedPlateIds = grantedPlatesFrom(manifestDoc);
        // Normalize the two mechanical sections FIRST, deterministically and with
        // no LLM call, then audit. Anchoring and a missing definition paragraph are
        // formatting, not authorship — see normalizeReferenceLayer.ts. Whatever
        // survives normalization is a real finding.
        let normalizedAny = false;
        doc.shots = doc.shots.map((shot) => {
            const { shot: next, changes } = normalizeReferenceLayerShot(shot);
            if (changes.length > 0) {
                normalizedAny = true;
                for (const c of changes) {
                    ctx.log(`h3.audit_shot_references[${ctx.itemId ?? '?'}:${shot.id}] normalized: ${c}`);
                }
            }
            return next;
        });
        if (normalizedAny) {
            // Persist it: shot_prose reads shot_references directly for content, so a
            // fix that lives only in this node's memory would not reach the prose call.
            const { writeFileSync: wf } = await import('node:fs');
            const { resolve: rsv } = await import('node:path');
            // The walker hands runners the already-PARSED input value and drops the
            // path it came from, so the write-back target cannot be recovered from
            // ctx.inputs. It has to be declared, the same way outputPath is — the
            // walker substitutes {{item_id}} in both before the runner sees them.
            // The walker substitutes {{item_id}} only for the keys it knows about
            // (outputs.pattern, outputPath) — an arbitrary config key arrives raw,
            // so it writes to a literal '{{item_id}}.json' unless we substitute here.
            const refTemplate = rs(cfg, 'referencesPath');
            const refFile = refTemplate
                ? refTemplate.replace(/\{\{\s*item_id\s*\}\}/g, ctx.itemId ?? '')
                : resolveInputPath(ctx, rs(cfg, 'referencesInput'));
            if (refFile) {
                try {
                    wf(rsv(ctx.projectDir, refFile), JSON.stringify(doc, null, 2));
                    ctx.log(`h3.audit_shot_references[${ctx.itemId ?? '?'}] wrote normalized reference layer back to ${refFile}`);
                }
                catch (e) {
                    ctx.log(`h3.audit_shot_references[${ctx.itemId ?? '?'}] could not persist normalization: ${e instanceof Error ? e.message : String(e)}`);
                }
            }
            else {
                // Loud, not silent: the gate would otherwise pass on a document the
                // next node never sees.
                ctx.log(`h3.audit_shot_references[${ctx.itemId ?? '?'}] WARNING: normalized the reference layer but has nowhere to write it back — set config.referencesPath (e.g. 'prompts/shot_references/{{item_id}}.json'); shot_prose will read the ORIGINAL until then`);
            }
        }
        let allOk = true;
        const perShot = [];
        const allFindings = [];
        for (const shot of doc.shots) {
            const rawFindings = auditReferenceLayer(shot, grantedPlateIds);
            const findings = rawFindings.map((f) => ({ ...f, shotId: shot.id }));
            const ok = findings.length === 0;
            perShot.push({ shotId: shot.id, ok, findings });
            allFindings.push(...findings);
            if (!ok)
                allOk = false;
            for (const f of findings)
                ctx.log(`h3.audit_shot_references[${ctx.itemId ?? '?'}:${shot.id}] ${f.code}: ${f.message}`);
        }
        const { writeFileSync, mkdirSync } = await import('node:fs');
        const { dirname, resolve } = await import('node:path');
        const abs = resolve(ctx.projectDir, outputPath);
        mkdirSync(dirname(abs), { recursive: true });
        writeFileSync(abs, JSON.stringify({ ok: allOk, sceneId: doc.sceneId ?? ctx.itemId, perShot, findings: allFindings }, null, 2));
        if (!allOk) {
            const failed = perShot.filter((p) => !p.ok).map((p) => p.shotId);
            return {
                ok: false,
                error: `h3.audit_shot_references[${ctx.itemId ?? '?'}]: BLOCKED — ${failed.length} of ${perShot.length} shot(s) with findings: ${failed
                    .map((id) => {
                    const codes = perShot.find((p) => p.shotId === id)?.findings.map((f) => f.code).join(', ');
                    return `${id}: ${codes}`;
                })
                    .join(' | ')}`,
            };
        }
        return { ok: true, outputPath };
    },
};
//# sourceMappingURL=auditShotReferences.js.map