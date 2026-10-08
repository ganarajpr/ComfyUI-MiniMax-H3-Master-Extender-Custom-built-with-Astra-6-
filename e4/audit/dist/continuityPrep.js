import { diagnoseJsonInput, rs } from './inputs.js';
export const continuityPrepRunner = {
    describe: () => ({
        id: 'h3.continuity_prep',
        displayName: 'Continuity prep + preflight (override-or-generated, no LLM)',
        description: "Preflight for the whole bundle, and the override/fallback point for continuity.json: prefers a human-supplied continuity_input verbatim when present (a malformed or incomplete override is a HARD error, never a silent fallback), otherwise uses continuity_author's generated output. Validates dialogue_ledger and (if configured) script_input are present and well-shaped, cross-checks every dialogue_ledger speaker against the resolved continuity's cast[], then writes plans/continuity.json. Zero LLM calls of its own.",
        capabilities: ['prep.passthrough', 'prep.preflight', 'prep.override'],
        modalities: { input: ['text'], output: ['text'] },
        configSchema: {
            type: 'object',
            required: ['ledgerInput', 'outputPath'],
            properties: {
                continuityInput: { type: 'string', description: 'OPTIONAL. Input id of a human-supplied continuity_input (continuity.json) override. When present and valid, it is used verbatim and continuityAuthorInput is never consulted. When present but malformed or incomplete, this is a HARD ERROR (never a silent fallback to the generated version) — a deliberate override that is broken should not be silently ignored.' },
                continuityAuthorInput: { type: 'string', description: "OPTIONAL. Input id of the generated fallback (continuity_author's output). Used only when continuityInput is absent." },
                ledgerInput: { type: 'string', description: 'Input id of the full dialogue ledger array ({ id, speaker, language?, text }[]) — the ledger of record.' },
                allowEmptyLedger: {
                    type: 'boolean',
                    description: "OPTIONAL, default false. h3_shots' dialogue_ledger is a hand-authored bundle input and an empty one is almost always a mistake, so the default stays a hard error. h3_film GENERATES dialogue_ledger from the screenplay (h3.audit_dialogue_ledger), and an empty ledger there is a legitimate, common state for a wordless/no-dialogue film — set this true so that case is not rejected as 'PRESENT but not a non-empty array'.",
                },
                scriptInput: { type: 'string', description: "OPTIONAL. Input id of script_input (script.md). When set, its presence is checked here too (as part of the same preflight) even though this runner does not otherwise use its content — catching a missing script before shot_breakdown fails on it separately." },
                continuitySchemaPath: { type: 'string', description: "OPTIONAL. Bundle-relative path to continuity.json's JSON Schema, named in error messages. Default 'schemas/continuity.schema.json'." },
                ledgerSchemaPath: { type: 'string', description: "OPTIONAL. Bundle-relative path to dialogue_ledger's JSON Schema, named in error messages. Default 'schemas/dialogue_ledger.schema.json'." },
                outputPath: { type: 'string', description: 'Where to write the resolved continuity.json — relative to the project dir.' },
            },
        },
        costHint: 'free',
    }),
    run: async (ctx) => {
        const cfg = ctx.node.runner.config;
        const continuityKey = rs(cfg, 'continuityInput');
        const authorKey = rs(cfg, 'continuityAuthorInput');
        const ledgerKey = rs(cfg, 'ledgerInput');
        const scriptKey = rs(cfg, 'scriptInput');
        const allowEmptyLedger = cfg['allowEmptyLedger'] === true;
        const outputPath = rs(cfg, 'outputPath');
        const continuitySchemaPath = rs(cfg, 'continuitySchemaPath') ?? 'schemas/continuity.schema.json';
        const ledgerSchemaPath = rs(cfg, 'ledgerSchemaPath') ?? 'schemas/dialogue_ledger.schema.json';
        if (!outputPath)
            return { ok: false, error: 'h3.continuity_prep: config.outputPath is required' };
        const problems = [];
        // ── dialogue_ledger (always required) ──
        const ledgerDiag = diagnoseJsonInput(ctx, ledgerKey);
        let ledger;
        if (ledgerDiag.status === 'missing') {
            problems.push({
                input: 'dialogue_ledger',
                path: 'inputs/lines.json',
                message: `ABSENT. Create "inputs/lines.json" in the project directory before running this bundle. It must be a non-empty JSON array of { "id": "...", "speaker": "...", "text": "..." } objects, in script order — see ${ledgerSchemaPath} for the full shape, and ~/.kshana/bundles/h3_shots/inputs/lines.json for a complete, runnable worked example. This is the ONLY source of spoken words in the film — no LLM node may invent a line.`,
            });
        }
        else if (ledgerDiag.status === 'malformed') {
            problems.push({
                input: 'dialogue_ledger',
                path: 'inputs/lines.json',
                message: `MALFORMED JSON: ${ledgerDiag.error}. Fix the syntax in "inputs/lines.json" — see ${ledgerSchemaPath} for the expected shape.`,
            });
        }
        else if (!Array.isArray(ledgerDiag.value)) {
            problems.push({
                input: 'dialogue_ledger',
                path: 'inputs/lines.json',
                message: `PRESENT but not an array. See ${ledgerSchemaPath}.`,
            });
        }
        else if (ledgerDiag.value.length === 0 && !allowEmptyLedger) {
            problems.push({
                input: 'dialogue_ledger',
                path: 'inputs/lines.json',
                message: `PRESENT but not a non-empty array. See ${ledgerSchemaPath}. (If a wordless/no-dialogue film is intended, the caller must set config.allowEmptyLedger:true on this node — an empty ledger is not accepted by default.)`,
            });
        }
        else {
            ledger = ledgerDiag.value;
        }
        // ── script_input (always required; checked here too as part of the same preflight) ──
        if (scriptKey) {
            const raw = ctx.inputs[scriptKey];
            const text = typeof raw === 'string' ? raw.trim() : '';
            if (!text) {
                problems.push({
                    input: 'script_input',
                    path: 'inputs/script.md',
                    message: `ABSENT or empty. Create "inputs/script.md" in the project directory before running this bundle — prose scene direction, action and blocking (NOT dialogue words; those belong only in inputs/lines.json). See ~/.kshana/bundles/h3_shots/inputs/script.md for a worked example.`,
                });
            }
        }
        // ── continuity: SUPPLIED (continuity_input) WINS, always. A broken
        // supplied override is a hard error, never a silent fallback to the
        // generated version — the whole point of an override is that it is
        // deliberate, so silently discarding a broken one would hide a real
        // mistake. Only genuine ABSENCE falls through to continuity_author. ──
        let continuity;
        const continuityDiag = diagnoseJsonInput(ctx, continuityKey);
        if (continuityDiag.status === 'malformed') {
            problems.push({
                input: 'continuity_input',
                path: 'inputs/continuity.json',
                message: `SUPPLIED but MALFORMED JSON: ${continuityDiag.error}. This file overrides the auto-generated continuity.json, so it is validated on its own rather than silently falling back — fix the syntax, or delete the file to let the bundle generate one instead. See ${continuitySchemaPath}.`,
            });
        }
        else if (continuityDiag.status === 'ok') {
            const c = continuityDiag.value;
            if (!c || typeof c !== 'object' || !c.language || !Array.isArray(c.cast) || c.cast.length === 0) {
                problems.push({
                    input: 'continuity_input',
                    path: 'inputs/continuity.json',
                    message: `SUPPLIED but missing a required field ("language" and a non-empty "cast" array are both mandatory). This file overrides the auto-generated continuity.json, so it is validated on its own rather than silently falling back — complete it, or delete the file to let the bundle generate one instead. See ${continuitySchemaPath}.`,
                });
            }
            else {
                continuity = c;
                ctx.log('h3.continuity_prep: using SUPPLIED continuity_input (override) — continuity_author was not consulted');
            }
        }
        else {
            // Genuinely absent — fall back to the generated version.
            const authorDiag = diagnoseJsonInput(ctx, authorKey);
            if (authorDiag.status !== 'ok' || !authorDiag.value || !Array.isArray(authorDiag.value.cast) || authorDiag.value.cast.length === 0) {
                problems.push({
                    input: 'continuity_author',
                    path: 'plans/continuity_generated.json',
                    message: `continuity_input was not supplied, and the auto-generated fallback (continuity_author) did not resolve to a valid { language, cast[] } document either. This is a bundle-internal problem, not something you did wrong — check that the continuity_author node ran and its output validates against ${continuitySchemaPath}.`,
                });
            }
            else {
                continuity = authorDiag.value;
                ctx.log('h3.continuity_prep: continuity_input not supplied — using continuity_author\'s GENERATED continuity.json');
            }
        }
        if (problems.length) {
            const lines = problems.map((p) => `- ${p.input} (expected at "${p.path}"): ${p.message}`);
            return {
                ok: false,
                error: `h3.continuity_prep: ${problems.length} required input(s) missing or invalid — nothing has run yet, no LLM or GPU cost incurred:\n${lines.join('\n')}`,
            };
        }
        // From here on, continuity and ledger are both present, well-formed JSON
        // with their minimum required fields — the deterministic cross-checks
        // below are about CONSISTENCY between them, not format. Re-checked here
        // even for the GENERATED path (where validateWith already enforced this
        // once at authoring time) because a human-supplied override has had no
        // such check, and one code path for both sources is simpler than two.
        const errors = [];
        const ids = continuity.cast.map((c) => c.id);
        const dupCast = ids.filter((id, i) => ids.indexOf(id) !== i);
        if (dupCast.length)
            errors.push(`duplicate cast id(s): ${[...new Set(dupCast)].join(', ')}`);
        const castSet = new Set(ids);
        const ledgerIds = new Set();
        for (const line of ledger) {
            if (!line.id || !line.speaker || !line.text) {
                errors.push(`dialogue_ledger entry missing id/speaker/text: ${JSON.stringify(line)}`);
                continue;
            }
            if (ledgerIds.has(line.id))
                errors.push(`duplicate ledger line id "${line.id}"`);
            ledgerIds.add(line.id);
            if (!castSet.has(line.speaker)) {
                errors.push(`ledger line "${line.id}" has speaker "${line.speaker}" not declared in continuity.cast[] (declared cast ids: ${ids.join(', ') || '(none)'})`);
            }
        }
        if (errors.length) {
            return { ok: false, error: `h3.continuity_prep: ${errors.length} consistency problem(s) between continuity.json and lines.json:\n- ${errors.join('\n- ')}` };
        }
        const { writeFileSync, mkdirSync } = await import('node:fs');
        const { dirname, resolve } = await import('node:path');
        const abs = resolve(ctx.projectDir, outputPath);
        mkdirSync(dirname(abs), { recursive: true });
        writeFileSync(abs, JSON.stringify(continuity, null, 2));
        ctx.log(`h3.continuity_prep: preflight clean — ${continuity.cast.length} cast member(s), ${ledger.length} ledger line(s), all speakers declared`);
        return { ok: true, outputPath };
    },
};
//# sourceMappingURL=continuityPrep.js.map