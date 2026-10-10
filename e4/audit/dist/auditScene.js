import { resolvePerShotPrompts, resolvePerShotAudits, readJson, rs } from './inputs.js';
import { auditFilm } from './auditFilm.js';
/**
 * h3_film's Layer 2b — WITHIN one scene, deterministic, BLOCKING. h3_shots'
 * `h3.audit_film` (Layer 2) already does every cross-shot check that
 * matters (ledger coverage/order, side/wardrobe agreement, (Sx) speaker-id
 * consistency) — but it is FILM-WIDE, and h3_film's unit of render is the
 * SCENE (one Long Media chained job per scene, per the design), so a
 * defect scoped to one scene should block that scene's render without
 * requiring every OTHER scene's shots to exist first.
 *
 * Rather than fork auditFilm's logic (the exact trap the founder's brief
 * warns against — "the difference between a gate that blocks and one that
 * waves things through" is having ONE correct implementation, not two that
 * can drift), this is a thin wrapper: filter shotAudits/shotPrompts down to
 * the shots belonging to THIS scene, then call the SAME `auditFilm()` core
 * with only that subset as its "whole film". The film-wide (Sx) consistency
 * check therefore also runs scoped to just this scene's shots here — which
 * is strictly WEAKER than the film-wide version (a speaker id could still
 * drift ACROSS scenes and only `h3.audit_film` catches that), so `h3_film`
 * runs both: `h3.audit_scene` per scene, `h3.audit_film` once, globally,
 * over every shot in the film.
 *
 * ONE CONSEQUENCE of scoping the ledger down to this scene's own shots'
 * `lineIds` (there is no independent "which ledger lines belong to this
 * scene" oracle other than the shot assignment itself — scene_split IS the
 * thing that makes that assignment): `LEDGER_LINE_MISSING` and
 * `LEDGER_LINE_UNKNOWN` become STRUCTURALLY VACUOUS at scene scope (a scene's
 * ledger subset is defined as exactly the ids its own shots cite, so neither
 * can ever fire here) — that is not a false negative, `h3.audit_film` still
 * checks both, film-wide, where the check is meaningful. What DOES stay
 * meaningful scoped to one scene: `LEDGER_LINE_DUPLICATED` (two shots in the
 * SAME scene both citing one line) and `LEDGER_ORDER_VIOLATED` (this scene's
 * shots present their own lines out of the order those lines hold in the
 * full ledger) — plus every non-ledger check (side/wardrobe agreement,
 * (Sx) consistency, duplicate shot id, Layer 1 completeness).
 */
export function auditScene(scene, ledger, continuity, shotAudits, shotPrompts) {
    const sceneShotIds = new Set((scene?.shots ?? []).map((s) => s.id));
    const sceneLedgerIds = new Set((scene?.shots ?? []).flatMap((s) => s.lineIds ?? []));
    const findings = [];
    if (!scene || !Array.isArray(scene.shots) || scene.shots.length === 0) {
        findings.push({ code: 'SCENE_HAS_NO_SHOTS', message: `scene "${scene?.id ?? '?'}" has no shots[] to audit` });
        return { ok: false, findings };
    }
    const sceneLedger = ledger.filter((l) => sceneLedgerIds.has(l.id));
    const sceneShotAudits = shotAudits.filter((a) => sceneShotIds.has(a.itemId ?? ''));
    const sceneShotPrompts = shotPrompts.filter((p) => sceneShotIds.has(p.itemId));
    const result = auditFilm({ shots: scene.shots }, sceneLedger, continuity, sceneShotAudits, sceneShotPrompts);
    return result;
}
export const auditSceneRunner = {
    describe: () => ({
        id: 'h3.audit_scene',
        displayName: 'H3 scene audit (deterministic, blocking, within one scene)',
        description: "Layer 2b: the same cross-shot checks as h3.audit_film (ledger coverage/order, side/wardrobe agreement, (Sx) speaker-id consistency), scoped to ONE scene's shots so a defect in one scene blocks only that scene's Long Media render, not the whole film. Reuses auditFilm() directly on the scene's own shot subset -- one implementation, two granularities. Zero LLM calls.",
        capabilities: ['audit.deterministic', 'audit.ledger_coverage'],
        modalities: { input: ['text'], output: ['text'] },
        configSchema: {
            type: 'object',
            required: ['sceneInput', 'promptsInput', 'shotAuditInput', 'ledgerInput', 'continuityInput', 'outputPath'],
            properties: {
                sceneInput: { type: 'string', description: "Input id of THIS scene's own descriptor ({ id, shots: [...] }), matching scope." },
                promptsInput: { type: 'string', description: "scope:'all' input id of every shot's authored prompt JSON, keyed by shot item id (film-wide; this runner filters to the scene's own shots)." },
                shotAuditInput: { type: 'string', description: "scope:'all' input id of every h3.audit_shot result (film-wide; filtered to the scene's own shots)." },
                ledgerInput: { type: 'string', description: 'Input id of the full dialogue ledger array (film-wide; filtered to lines this scene\'s shots cite).' },
                continuityInput: { type: 'string', description: 'Input id of the prepared continuity.json.' },
                outputPath: { type: 'string', description: 'Where to write { ok, findings } — relative to the project dir.' },
            },
        },
        costHint: 'free',
    }),
    run: async (ctx) => {
        const cfg = ctx.node.runner.config;
        let scene = readJson(ctx, rs(cfg, 'sceneInput'));
        const ledger = readJson(ctx, rs(cfg, 'ledgerInput'));
        const continuity = readJson(ctx, rs(cfg, 'continuityInput'));
        const outputPath = rs(cfg, 'outputPath');
        if (!scene)
            return { ok: false, error: 'h3.audit_scene: sceneInput did not resolve to a JSON object' };
        // `sceneInput` is wired to `scene_split`, which is a STAGE node: there is
        // no per-scene document for scope:'matching' to narrow to, so what lands
        // here is the WHOLE film breakdown ({chapters, locations, scenes[], shots[]}).
        // Select THIS scene by ctx.itemId. Without this, `scene.shots` is the
        // film-wide flat list and the Layer-1 completeness check compares one
        // scene's audits against every shot in the film — measured 2026-09-02 on
        // scene01: "expected 26 per-shot audit result(s), got 1".
        const asBreakdown = scene;
        if (Array.isArray(asBreakdown.scenes)) {
            const match = asBreakdown.scenes.find((sc) => sc?.id === ctx.itemId);
            if (!match) {
                return {
                    ok: false,
                    error: `h3.audit_scene: sceneInput resolved to the whole film breakdown and it has no scene with id '${ctx.itemId ?? '?'}' (has: ${asBreakdown.scenes.map((sc) => sc?.id).join(', ')})`,
                };
            }
            scene = match;
        }
        if (!Array.isArray(ledger))
            return { ok: false, error: 'h3.audit_scene: ledgerInput did not resolve to an array' };
        if (!continuity)
            return { ok: false, error: 'h3.audit_scene: continuityInput did not resolve to a JSON object' };
        if (!outputPath)
            return { ok: false, error: 'h3.audit_scene: config.outputPath is required' };
        const shotAudits = resolvePerShotAudits(ctx, rs(cfg, 'shotAuditInput')).map((e) => ({
            itemId: e.itemId,
            ok: Boolean(e.value?.ok),
            findings: e.value?.findings ?? [],
            speakerAssignments: e.value?.speakerAssignments ?? [],
        }));
        // h3_film v0.2.0: promptsInput/shotAuditInput (shot_repair/shot_audit)
        // are now SCENE-granular collections -- wired here via scope:'matching',
        // so resolvePerShotPrompts/resolvePerShotAudits get the exact SINGLE
        // scene document (no film-wide map, no cross-scene walker dependency at
        // all for this node's PRIMARY read). Falls back to a scope:'all'
        // aggregate shape automatically if ever wired that way instead.
        const shotPrompts = resolvePerShotPrompts(ctx, rs(cfg, 'promptsInput'));
        const { ok, findings } = auditScene(scene, ledger, continuity, shotAudits, shotPrompts);
        const { writeFileSync, mkdirSync } = await import('node:fs');
        const { dirname, resolve } = await import('node:path');
        const abs = resolve(ctx.projectDir, outputPath);
        mkdirSync(dirname(abs), { recursive: true });
        writeFileSync(abs, JSON.stringify({ ok, sceneId: ctx.itemId, findings }, null, 2));
        for (const f of findings)
            ctx.log(`h3.audit_scene[${ctx.itemId ?? '?'}] ${f.code}: ${f.message}`);
        if (!ok) {
            return {
                ok: false,
                error: `h3.audit_scene[${ctx.itemId ?? '?'}]: BLOCKED — ${findings.length} finding(s): ${findings.map((f) => `[${f.code}] ${f.message}`).join(' | ')}`,
            };
        }
        return { ok: true, outputPath };
    },
};
//# sourceMappingURL=auditScene.js.map