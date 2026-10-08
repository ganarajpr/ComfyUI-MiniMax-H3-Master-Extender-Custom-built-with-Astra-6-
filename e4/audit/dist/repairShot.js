import { readJson, rs } from './inputs.js';
import { auditShot, resolveBreakdownItem, grantedPlatesFrom } from './auditShot.js';
import { isSceneShotBatch } from './types.js';
/**
 * `h3.repair_shot` — sits BETWEEN `shot_prompt` and `shot_audit` in
 * `h3_film`. Founder requirement (2026-09-01): the deterministic gate
 * stays the primary and only BLOCKING detector (per `h3.audit_shot` /
 * `h3.audit_film` / `h3.audit_scene`), but a finding it raises should be
 * REPAIRABLE by a small, fast model rather than only reported to a human —
 * that is the whole reason `Finding` grew `span`/`operation`/`hint`
 * (`src/types.ts`). This node is what actually spends those fields.
 *
 * Design:
 *   1. Run `auditShot()` — the SAME function `h3.audit_shot` calls, zero
 *      drift between "what got repaired" and "what actually gates."
 *   2. If clean, pass the candidate through untouched. Most shots authored
 *      well the first time never reach the LLM call at all — this node is
 *      free in that case, not just fast.
 *   3. If findings exist, build a repair prompt FROM the structured
 *      findings (code + span + operation + hint — never a vague "fix
 *      this") and call `ctx.llm.generateText({ tier: 'medium', ... })`.
 *      MEDIUM, deliberately not 'heavy': applying a named operation to a
 *      named span is volume-bound, not reasoning-bound — it does not need
 *      thinkingcap-27b's extra reasoning depth, and paying for it would be
 *      the "took the default without making the trade" failure the model
 *      policy calls out by name. (`h3_film`'s authoring nodes — screenplay,
 *      scene_split, world_state, direction, acting, shot_prompt itself —
 *      stay on 'heavy'; this loop is the one deliberately-lighter tier.)
 *   4. Re-audit the repaired candidate. Repeat up to `maxIterations`
 *      (default 3) total repair attempts.
 *   5. If still failing after the bound, STOP and return `ok:false`,
 *      quoting every surviving finding's code + span + hint LOUDLY in the
 *      error. Per the founder's own caution: the probe's Whisper gate
 *      failed silently-wrong three times in a row because each failure
 *      reported a problem with the TAKE when the problem was in the CHECK
 *      — an unbounded repair loop against a broken check would repeat that
 *      failure shape, just automated. A loud, bounded stop makes a
 *      check that can never be satisfied visible AS a check that keeps
 *      failing, not as prose that silently keeps churning forever.
 *
 * `h3.audit_shot` still runs immediately downstream and re-audits from
 * scratch — this node's own internal "ok" is not trusted as the final
 * word, the same belt-and-suspenders discipline `h3.continuity_prep` /
 * `continuityValidator` already use for `continuity_author`.
 */
const DEFAULT_MAX_ITERATIONS = 3;
/**
 * The set of shot ids a given scene legitimately owns, read from the film
 * breakdown. Returns undefined when the breakdown has no scenes[] to consult
 * (then the caller must not enforce anything).
 */
function sceneShotIdsFor(breakdownDoc, sceneId) {
    if (!sceneId || !breakdownDoc || typeof breakdownDoc !== 'object')
        return undefined;
    const scenes = breakdownDoc.scenes;
    if (!Array.isArray(scenes))
        return undefined;
    const scene = scenes.find((sc) => sc?.id === sceneId);
    if (!scene || !Array.isArray(scene.shots))
        return undefined;
    return new Set(scene.shots.map((sh) => String(sh?.id)).filter((id) => id && id !== 'undefined'));
}
function repairPrompt(candidate, findings) {
    const findingsBlock = findings
        .map((f, i) => {
        const lines = [`${i + 1}. [${f.code}] ${f.message}`];
        if (f.span !== undefined)
            lines.push(`   span (exact text to find): ${JSON.stringify(f.span)}`);
        if (f.operation)
            lines.push(`   operation: ${f.operation}`);
        if (f.hint !== undefined)
            lines.push(`   hint: ${f.hint}`);
        return lines.join('\n');
    })
        .join('\n');
    return [
        'You are repairing ONE authored MiniMax H3 shot-prompt JSON object. A deterministic checker found the findings below. Each finding names a machine-checkable defect and, where mechanical, the exact operation that clears it — insert, substitute, expand, or delete a specific span. Apply ONLY these fixes. Do not rewrite, shorten, "improve", or restructure any field the findings did not flag.',
        '',
        'FINDINGS:',
        findingsBlock,
        '',
        'THE CURRENT JSON:',
        JSON.stringify(candidate, null, 2),
        '',
        'Return ONLY the complete corrected JSON object, same shape, no markdown fence, no commentary. Every field the findings did not mention must be copied through UNCHANGED, byte-for-byte — this includes every <d> dialogue tag not named in a finding.',
    ].join('\n');
}
function extractJson(text) {
    const trimmed = text.trim();
    try {
        return JSON.parse(trimmed);
    }
    catch {
        // best-effort: pull the first {...} block out of a fenced/prose reply
        const match = /\{[\s\S]*\}/.exec(trimmed);
        if (match) {
            try {
                return JSON.parse(match[0]);
            }
            catch {
                return undefined;
            }
        }
        return undefined;
    }
}
/** Pure loop, independent of the walker, so it is directly unit-testable
 * with a stub `generateText`. */
export async function repairShotLoop(initial, breakdown, ledger, continuity, generateText, maxIterations = DEFAULT_MAX_ITERATIONS, log = () => { }, grantedPlateIds) {
    let candidate = initial;
    let attempt = 0;
    /**
     * The previous attempt's finding set, as a stable signature. If a repair
     * comes back with EXACTLY the same findings, the loop is not converging and
     * never will: either the model cannot act on those hints, or two of them
     * contradict each other and each fix re-triggers the other.
     *
     * Measured 2026-09-02: one scene burned 168 repair calls with 10 of its 11
     * shots repeating an identical finding set to the 8-attempt ceiling.
     * DIALOGUE_COUNT_MISMATCH said "add the <d> line"; SPEECH_WITHOUT_WORDS said
     * "remove the speech verb" — for the same sentence. No number of attempts
     * resolves that, and grinding to the ceiling just multiplies the bill.
     */
    let previousSignature;
    /**
     * How many times in a row the identical set has come back. ONE repeat is
     * tolerated: a model that fluffs an attempt and gets it right on the retry
     * is normal and worth paying for. TWO repeats is a stuck loop — nothing has
     * moved across three consecutive audits.
     */
    let repeats = 0;
    while (true) {
        const { ok, findings } = auditShot(candidate, breakdown, ledger, continuity, grantedPlateIds);
        if (ok)
            return { ok: true, candidate, attempts: attempt, findings: [] };
        const signature = findings.map((f) => f.code).sort().join('|');
        repeats = attempt > 0 && signature === previousSignature ? repeats + 1 : 0;
        if (repeats >= 2) {
            log(`h3.repair_shot: NOT CONVERGING — attempt ${attempt} returned the identical finding set ` +
                `(${signature}) three audits running. Stopping instead of grinding to ${maxIterations}: ` +
                `means no further attempt can help. Either the hints are unactionable or two of them ` +
                `contradict each other, which is a bug in the GATES, not something the author can solve.`);
            for (const f of findings) {
                log(`  [${f.code}] ${f.message}${f.hint !== undefined ? ` | hint=${f.hint}` : ''}`);
            }
            return { ok: false, candidate, attempts: attempt, findings };
        }
        previousSignature = signature;
        if (attempt >= maxIterations) {
            log(`h3.repair_shot: REPAIR EXHAUSTED after ${attempt} attempt(s) — ${findings.length} surviving finding(s):`);
            for (const f of findings) {
                log(`  [${f.code}] ${f.message}${f.span !== undefined ? ` | span=${JSON.stringify(f.span)}` : ''}${f.hint !== undefined ? ` | hint=${f.hint}` : ''}`);
            }
            return { ok: false, candidate, attempts: attempt, findings };
        }
        attempt += 1;
        log(`h3.repair_shot: attempt ${attempt}/${maxIterations} — repairing ${findings.length} finding(s): ${findings.map((f) => f.code).join(', ')}`);
        const raw = await generateText(repairPrompt(candidate, findings));
        const parsed = extractJson(raw);
        if (!parsed || typeof parsed !== 'object') {
            log(`h3.repair_shot: attempt ${attempt} returned no parseable JSON — stopping early, findings unchanged`);
            const { findings: last } = auditShot(candidate, breakdown, ledger, continuity, grantedPlateIds);
            return { ok: false, candidate, attempts: attempt, findings: last };
        }
        candidate = parsed;
    }
}
export const repairShotRunner = {
    describe: () => ({
        id: 'h3.repair_shot',
        displayName: 'H3 shot repair (bounded, fast-model, structured-finding loop)',
        description: "Runs the SAME auditShot() as h3.audit_shot; if clean, passes the candidate through untouched. If findings exist, repairs them via ctx.llm on a FAST tier (default 'medium', never 'heavy' — applying a named operation to a named span is volume-bound, not reasoning-bound), re-audits, up to maxIterations attempts, then BLOCKS loudly with the surviving findings' codes/spans/hints if the gate still fails. h3.audit_shot still re-audits from scratch immediately downstream regardless of this node's own verdict.",
        capabilities: ['audit.repair', 'llm.tier_medium'],
        modalities: { input: ['text'], output: ['text'] },
        configSchema: {
            type: 'object',
            required: ['promptInput', 'breakdownInput', 'ledgerInput', 'continuityInput', 'outputPath'],
            properties: {
                promptInput: { type: 'string', description: "Input id of this shot's authored candidate prompt JSON." },
                breakdownInput: { type: 'string', description: "Input id of this shot's breakdown descriptor ({ id, lineIds, refs }), matching scope." },
                ledgerInput: { type: 'string', description: 'Input id of the full dialogue ledger array.' },
                continuityInput: { type: 'string', description: 'Input id of the prepared continuity.json.' },
                outputPath: { type: 'string', description: 'Where to write the (possibly repaired) shot prompt JSON — relative to the project dir. Wire shot_audit\'s promptInput at THIS node, not the original shot_prompt.' },
                maxIterations: { type: 'number', description: `Max repair attempts before giving up and blocking. Default ${DEFAULT_MAX_ITERATIONS}.` },
                tier: { type: 'string', enum: ['heavy', 'medium', 'light'], description: "LLM tier for the repair call. Default 'medium' — deliberately NOT 'heavy'; see this file's module comment." },
            },
        },
        costHint: 'local_gpu',
    }),
    run: async (ctx) => {
        const cfg = ctx.node.runner.config;
        const promptRaw = readJson(ctx, rs(cfg, 'promptInput'));
        const breakdownDoc = readJson(ctx, rs(cfg, 'breakdownInput'));
        const grantedPlateIds = grantedPlatesFrom(readJson(ctx, rs(cfg, 'manifestInput')));
        const ledger = readJson(ctx, rs(cfg, 'ledgerInput'));
        const continuity = readJson(ctx, rs(cfg, 'continuityInput'));
        const outputPath = rs(cfg, 'outputPath');
        const maxIterations = typeof cfg['maxIterations'] === 'number' ? cfg['maxIterations'] : DEFAULT_MAX_ITERATIONS;
        const tier = (typeof cfg['tier'] === 'string' ? cfg['tier'] : 'medium');
        if (!promptRaw)
            return { ok: false, error: 'h3.repair_shot: promptInput did not resolve to a JSON object' };
        if (!Array.isArray(ledger))
            return { ok: false, error: 'h3.repair_shot: ledgerInput did not resolve to an array' };
        if (!continuity)
            return { ok: false, error: 'h3.repair_shot: continuityInput did not resolve to a JSON object' };
        if (!outputPath)
            return { ok: false, error: 'h3.repair_shot: config.outputPath is required' };
        if (!ctx.llm)
            return { ok: false, error: 'h3.repair_shot: ctx.llm capability not available (walker did not inject it)' };
        const generateText = async (prompt) => {
            const res = await ctx.llm.generateText({
                tier,
                messages: [{ role: 'user', content: prompt }],
                temperature: 0.2,
            });
            return res.content ?? '';
        };
        const { writeFileSync, mkdirSync } = await import('node:fs');
        const { dirname, resolve } = await import('node:path');
        const abs = resolve(ctx.projectDir, outputPath);
        mkdirSync(dirname(abs), { recursive: true });
        // ── h3_film v0.2.0: SCENE-BATCH mode ── promptInput is { sceneId, shots: [...] },
        // one h3.repair_shot call per SCENE (itemId=sceneId) repairing every shot in it
        // independently (its own bounded repairShotLoop, its own breakdown lookup by
        // shot.id). See types.ts's SceneShotBatch doc for why this exists.
        if (isSceneShotBatch(promptRaw)) {
            const repaired = [];
            const failedShots = [];
            const failedShotFindings = [];
            // ── DETERMINISTIC SHOT-LIST ENFORCEMENT ──────────────────────────────
            // Which shots belong to this scene is ARITHMETIC the runner already
            // knows — it is in the breakdown. Asking the authoring model for it in
            // prose (and re-asking louder each time it gets it wrong) is what grew
            // shot_prompt.md to 46KB and pushed other rules out of the model's
            // instruction budget. Enforce it here instead: drop any authored shot
            // that this scene's breakdown does not list, loudly. Prose stays for
            // judgement; counting stays in code.
            // Measured 2026-09-02: a one-shot scene was authored with three shots
            // (pulled from the film-wide flat list) twice, on two different prompts.
            const sceneId = promptRaw.sceneId ?? ctx.itemId;
            const legalIds = sceneShotIdsFor(breakdownDoc, sceneId);
            let sceneShots = promptRaw.shots;
            if (legalIds !== undefined) {
                const extras = sceneShots.filter((sh) => !legalIds.has(sh.id));
                if (extras.length > 0) {
                    ctx.log(`h3.repair_shot[${sceneId ?? '?'}]: dropping ${extras.length} authored shot(s) not in this scene's breakdown: ` +
                        `${extras.map((sh) => sh.id).join(', ')} (scene declares: ${[...legalIds].join(', ')})`);
                    sceneShots = sceneShots.filter((sh) => legalIds.has(sh.id));
                }
                const missing = [...legalIds].filter((id) => !sceneShots.some((sh) => sh.id === id));
                if (missing.length > 0) {
                    return {
                        ok: false,
                        error: `h3.repair_shot[${sceneId ?? '?'}]: the authored prompt is MISSING shot(s) this scene declares: ${missing.join(', ')} — re-author shot_prompt for this scene`,
                    };
                }
            }
            for (const shot of sceneShots) {
                const breakdown = resolveBreakdownItem(breakdownDoc, shot.id);
                const { ok: shotOk, candidate, attempts, findings } = await repairShotLoop(shot, breakdown, ledger, continuity, generateText, maxIterations, (m) => ctx.log(`[${shot.id}] ${m}`), grantedPlateIds);
                repaired.push({ ...candidate, id: shot.id });
                if (!shotOk) {
                    failedShots.push(shot.id);
                    ctx.log(`h3.repair_shot[${ctx.itemId ?? '?'}:${shot.id}]: REPAIR EXHAUSTED after ${attempts} attempt(s) — ${findings.length} surviving finding(s): ${findings.map((f) => f.code).join(', ')}`);
                    failedShotFindings.push({ id: shot.id, findings });
                }
                else if (attempts > 0) {
                    ctx.log(`h3.repair_shot[${ctx.itemId ?? '?'}:${shot.id}]: repaired clean in ${attempts} attempt(s)`);
                }
            }
            writeFileSync(abs, JSON.stringify({ sceneId: promptRaw.sceneId ?? ctx.itemId, shots: repaired }, null, 2));
            if (failedShots.length > 0) {
                return {
                    ok: false,
                    // Carry the SURVIVING FINDING CODES per shot, not just the shot ids.
                    // A gate that only says "exhausted" forces the caller to go dig in
                    // ctx.log, and an agent driving this node cannot act on it at all.
                    // (2026-09-02: cost a full diagnostic round-trip on scene01.)
                    error: `h3.repair_shot[${ctx.itemId ?? '?'}]: REPAIR EXHAUSTED for ${failedShots.length} of ${sceneShots.length} shot(s) — ${failedShotFindings.map(({ id, findings: fs }) => `${id}: ${fs.map((f) => f.code).join(', ')}`).join(' | ')}`,
                };
            }
            return { ok: true, outputPath };
        }
        // ── Legacy single-shot mode (h3_shots and any other flat-shotId caller) ──
        const promptDoc = promptRaw;
        const breakdown = resolveBreakdownItem(breakdownDoc, ctx.itemId);
        const { ok, candidate, attempts, findings } = await repairShotLoop(promptDoc, breakdown, ledger, continuity, generateText, maxIterations, ctx.log, grantedPlateIds);
        writeFileSync(abs, JSON.stringify(candidate, null, 2));
        if (!ok) {
            return {
                ok: false,
                error: `h3.repair_shot[${ctx.itemId ?? '?'}]: REPAIR EXHAUSTED after ${attempts} attempt(s) — ${findings.length} surviving finding(s): ${findings.map((f) => `${f.code}${f.span !== undefined ? ` (span=${JSON.stringify(f.span)})` : ''}`).join('; ')}`,
            };
        }
        if (attempts > 0)
            ctx.log(`h3.repair_shot[${ctx.itemId ?? '?'}]: repaired clean in ${attempts} attempt(s)`);
        return { ok: true, outputPath };
    },
};
//# sourceMappingURL=repairShot.js.map