import { resolvePerShotPrompts, resolvePerShotAudits, readJson, rs } from './inputs.js';
/**
 * Layer 2 — film-level, deterministic. Ported from
 * ~/Projects/h3-shots/audit_film.mjs. Everything in Layer 1 is per-file, so a
 * shot internally consistent with its own frontmatter passes even when the
 * FILM is wrong — this is what catches "a dropped line replaced by an
 * invented one" and "two takes swapped left/right". BLOCKING, same as
 * Layer 1: this node gates the whole render (every h3_clip instance in the
 * bundle depends on it), so one bad film-level finding stops every clip
 * before any GPU is spent.
 */
export function auditFilm(breakdown, ledger, continuity, shotAudits, shotPrompts) {
    const findings = [];
    const fail = (code, message) => findings.push({ code, message });
    const shots = Array.isArray(breakdown?.shots) ? breakdown.shots : [];
    // ── completeness — "could not check" must never read as "checked and fine" ──
    if (shotAudits.length !== shots.length) {
        fail('AUDIT_LAYER_INCOMPLETE', `expected ${shots.length} per-shot audit result(s), got ${shotAudits.length} — a shot is missing its Layer 1 audit and this run must not be treated as clean`);
    }
    const failedShots = shotAudits.filter((s) => s.ok === false);
    if (failedShots.length) {
        fail('SHOT_AUDIT_FAILED', `${failedShots.length} shot(s) failed Layer 1: ${failedShots.map((s) => s.itemId).join(', ')}`);
    }
    // ── duplicate shot ids ──
    const seen = new Map();
    for (const s of shots)
        seen.set(s.id, (seen.get(s.id) ?? 0) + 1);
    for (const [id, count] of seen) {
        if (count > 1)
            fail('DUPLICATE_SHOT_ID', `shot id "${id}" appears ${count} times in shot_breakdown`);
    }
    // ── ledger coverage — every line spoken exactly once, in script order ──
    const flattenedIds = shots.flatMap((s) => s.lineIds ?? []);
    const ledgerIds = ledger.map((l) => l.id);
    const flatSet = new Set(flattenedIds);
    const ledgerSet = new Set(ledgerIds);
    const missing = ledgerIds.filter((id) => !flatSet.has(id));
    if (missing.length) {
        fail('LEDGER_LINE_MISSING', `ledger line(s) never assigned to any shot: ${missing.join(', ')}`);
    }
    const unknown = flattenedIds.filter((id) => !ledgerSet.has(id));
    if (unknown.length) {
        fail('LEDGER_LINE_UNKNOWN', `shot_breakdown cites line id(s) not present in dialogue_ledger: ${[...new Set(unknown)].join(', ')}`);
    }
    const dupCount = new Map();
    for (const id of flattenedIds)
        dupCount.set(id, (dupCount.get(id) ?? 0) + 1);
    const duplicated = [...dupCount.entries()].filter(([, c]) => c > 1).map(([id]) => id);
    if (duplicated.length) {
        fail('LEDGER_LINE_DUPLICATED', `ledger line(s) assigned to more than one shot: ${duplicated.join(', ')}`);
    }
    if (!missing.length && !unknown.length && !duplicated.length) {
        // Only meaningful once the sets already match 1:1 — otherwise the order
        // check would just restate the same defect a second time.
        const orderOk = flattenedIds.length === ledgerIds.length && flattenedIds.every((id, i) => id === ledgerIds[i]);
        if (!orderOk) {
            fail('LEDGER_ORDER_VIOLATED', `every ledger line is assigned exactly once, but not in script order.\n  ledger order: ${ledgerIds.join(', ')}\n  film order:   ${flattenedIds.join(', ')}`);
        }
    }
    // ── wardrobe/side agreement across shots (the actual body-swap defect) ──
    const promptText = new Map(shotPrompts.map((p) => [p.itemId, p.value]));
    for (const cast of continuity.cast ?? []) {
        if (!cast.side)
            continue;
        const mentions = [];
        for (const shot of shots) {
            const prompt = promptText.get(shot.id);
            if (!prompt)
                continue;
            const text = `${prompt.detailedDescription ?? ''}`;
            const label = cast.plate ?? cast.id;
            const nameRe = new RegExp(`\\b${escapeRegExp(label)}\\b[\\s\\S]{0,120}?\\b(left|right)\\b`, 'i');
            const m = nameRe.exec(text);
            if (m)
                mentions.push({ shotId: shot.id, side: m[1].toLowerCase() });
        }
        const sides = new Set(mentions.map((m) => m.side));
        if (sides.size > 1) {
            fail('SIDE_DISAGREEMENT', `cast member "${cast.id}" is staged on both sides across shots: ${mentions.map((m) => `${m.shotId}=${m.side}`).join(', ')} (continuity.json declares "${cast.side}")`);
        }
        else if (sides.size === 1 && ![...sides][0].includes(cast.side.toLowerCase())) {
            fail('SIDE_DRIFT_FROM_CONTINUITY', `cast member "${cast.id}" is consistently staged "${[...sides][0]}" across shots but continuity.json declares "${cast.side}"`);
        }
    }
    // ── official rule: "(Sx) is assigned once in order of vocal events and
    // reused everywhere" -- one shot cannot verify this alone, since it only
    // sees the speakers IN it, so this cross-shot check aggregates every
    // shot's observed (subjectId -> sNumber) pairs and fails if any character
    // used a DIFFERENT (Sx) number in a different shot. ──
    const bySubject = new Map();
    for (const shotAudit of shotAudits) {
        for (const a of shotAudit.speakerAssignments ?? []) {
            if (!bySubject.has(a.subjectId))
                bySubject.set(a.subjectId, new Map());
            const byNumber = bySubject.get(a.subjectId);
            const list = byNumber.get(a.sNumber) ?? [];
            list.push(shotAudit.itemId ?? '?');
            byNumber.set(a.sNumber, list);
        }
    }
    for (const [subjectId, byNumber] of bySubject) {
        if (byNumber.size > 1) {
            const detail = [...byNumber.entries()].map(([n, shotIds]) => `(S${n}) in ${shotIds.join(', ')}`).join('; ');
            fail('SPEAKER_ID_INCONSISTENT', `"${subjectId}" is given a different (Sx) speaker id across shots: ${detail} -- the official rule is one (Sx) per character, assigned once and reused everywhere`);
        }
    }
    return { ok: findings.length === 0, findings };
}
function escapeRegExp(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
export const auditFilmRunner = {
    describe: () => ({
        id: 'h3.audit_film',
        displayName: 'H3 film audit (deterministic, blocking)',
        description: 'Layer 2: every ledger line spoken exactly once in script order, no duplicate shot ids, wardrobe/side agreement across shots, and completeness of the Layer 1 pass. Zero LLM calls. ok:false BLOCKS every h3_clip instance downstream (this is a single stage node, so no clip renders until it passes).',
        capabilities: ['audit.deterministic', 'audit.ledger_coverage'],
        modalities: { input: ['text'], output: ['text'] },
        configSchema: {
            type: 'object',
            required: ['breakdownInput', 'promptsInput', 'shotAuditInput', 'ledgerInput', 'continuityInput', 'outputPath'],
            properties: {
                breakdownInput: { type: 'string', description: 'Input id of the full shot_breakdown JSON ({ shots: [...] }).' },
                promptsInput: { type: 'string', description: "scope:'all' input id of every shot's authored prompt JSON, keyed by shot item id." },
                shotAuditInput: { type: 'string', description: "scope:'all' input id of every h3.audit_shot result — used both as a completeness gate and to re-fail if any shot failed." },
                ledgerInput: { type: 'string', description: 'Input id of the full dialogue ledger array.' },
                continuityInput: { type: 'string', description: 'Input id of the prepared continuity.json.' },
                outputPath: { type: 'string', description: 'Where to write { ok, findings } — relative to the project dir.' },
            },
        },
        costHint: 'free',
    }),
    run: async (ctx) => {
        const cfg = ctx.node.runner.config;
        const breakdown = readJson(ctx, rs(cfg, 'breakdownInput'));
        const ledger = readJson(ctx, rs(cfg, 'ledgerInput'));
        const continuity = readJson(ctx, rs(cfg, 'continuityInput'));
        const outputPath = rs(cfg, 'outputPath');
        if (!breakdown || !Array.isArray(breakdown.shots)) {
            return { ok: false, error: 'h3.audit_film: breakdownInput did not resolve to { shots: [...] }' };
        }
        if (!Array.isArray(ledger))
            return { ok: false, error: 'h3.audit_film: ledgerInput did not resolve to an array' };
        if (!continuity)
            return { ok: false, error: 'h3.audit_film: continuityInput did not resolve to a JSON object' };
        if (!outputPath)
            return { ok: false, error: 'h3.audit_film: config.outputPath is required' };
        const shotAudits = resolvePerShotAudits(ctx, rs(cfg, 'shotAuditInput')).map((e) => ({
            itemId: e.itemId,
            ok: Boolean(e.value?.ok),
            findings: e.value?.findings ?? [],
            speakerAssignments: e.value?.speakerAssignments ?? [],
        }));
        // h3_film v0.2.0: promptsInput/shotAuditInput (shot_repair/shot_audit)
        // are wired here via a genuine `scope:'all'` (this pass is film-wide BY
        // DESIGN -- it is the one check that must see every scene). Each entry
        // is SCENE-shaped ({sceneId,shots:[...]} / {sceneId,perShot:[...]});
        // resolvePerShotPrompts/resolvePerShotAudits flatten the whole map back
        // to a per-shot view.
        const shotPrompts = resolvePerShotPrompts(ctx, rs(cfg, 'promptsInput'));
        const { ok, findings } = auditFilm(breakdown, ledger, continuity, shotAudits, shotPrompts);
        const { writeFileSync, mkdirSync } = await import('node:fs');
        const { dirname, resolve } = await import('node:path');
        const abs = resolve(ctx.projectDir, outputPath);
        mkdirSync(dirname(abs), { recursive: true });
        writeFileSync(abs, JSON.stringify({ ok, findings }, null, 2));
        for (const f of findings)
            ctx.log(`h3.audit_film ${f.code}: ${f.message}`);
        if (!ok) {
            return {
                ok: false,
                error: `h3.audit_film: BLOCKED — ${findings.length} finding(s): ${findings.map((f) => `[${f.code}] ${f.message}`).join(' | ')}`,
            };
        }
        return { ok: true, outputPath };
    },
};
//# sourceMappingURL=auditFilm.js.map