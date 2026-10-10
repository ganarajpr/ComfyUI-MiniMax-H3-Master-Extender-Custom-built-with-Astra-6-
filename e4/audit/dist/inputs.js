import { existsSync, readFileSync } from 'node:fs';
/**
 * `ctx.inputs[key]` arrives as one of: an already-parsed JSON value (object
 * or array), a literal string, or a string that is actually a filesystem
 * path to a file the walker resolved but did not read for us (seen on
 * stage-node text/json outputs). Handle all three defensively — this
 * runner has no walker of its own to test against, only the contract
 * documented in @dheeai/runner-sdk's RunnerContext.
 */
export function readRaw(ctx, key) {
    if (!key)
        return undefined;
    const v = ctx.inputs[key];
    if (v === undefined || v === null)
        return undefined;
    if (typeof v === 'object')
        return v;
    if (typeof v === 'string') {
        const looksLikePath = /\.(json|md|txt)$/i.test(v) && !v.includes('\n');
        if (looksLikePath && existsSync(v)) {
            const text = readFileSync(v, 'utf-8');
            try {
                return JSON.parse(text);
            }
            catch {
                return text;
            }
        }
        try {
            return JSON.parse(v);
        }
        catch {
            return v;
        }
    }
    return v;
}
export function readJson(ctx, key) {
    const v = readRaw(ctx, key);
    return v;
}
/**
 * Normalize a `scope:'all'` aggregate into a plain array of parsed values,
 * in a stable order. Handles every shape a walker might hand back: an
 * array of `{ itemId, content }` / `{ itemId, outputAbs }` wrappers, a
 * plain `{ itemId -> value }` map, or a bare array of values.
 */
export function collectAll(ctx, key) {
    const raw = ctx.inputs[key ?? ''];
    if (raw === undefined || raw === null)
        return [];
    const resolveOne = (v) => {
        if (typeof v === 'string') {
            if (/\.(json)$/i.test(v) && existsSync(v)) {
                try {
                    return JSON.parse(readFileSync(v, 'utf-8'));
                }
                catch {
                    return v;
                }
            }
            try {
                return JSON.parse(v);
            }
            catch {
                return v;
            }
        }
        return v;
    };
    if (Array.isArray(raw)) {
        return raw.map((entry, i) => {
            if (entry && typeof entry === 'object' && ('content' in entry || 'outputAbs' in entry || 'itemId' in entry)) {
                const e = entry;
                const value = e.content !== undefined ? e.content : resolveOne(e.outputAbs);
                return { itemId: e.itemId ?? String(i), value: value };
            }
            return { itemId: String(i), value: resolveOne(entry) };
        });
    }
    if (typeof raw === 'object') {
        return Object.entries(raw).map(([itemId, v]) => ({
            itemId,
            value: resolveOne(v),
        }));
    }
    return [];
}
export function rs(cfg, key) {
    const v = cfg[key];
    return typeof v === 'string' ? v : undefined;
}
/**
 * Like `readJson`, but distinguishes WHY a JSON bundle input failed to
 * resolve, so a runner can give an actionable preflight message instead of
 * a flat "did not resolve to a JSON object" (the exact defect a real,
 * unassisted run hit: the message named neither the missing file nor its
 * expected path). `raw` mirrors `readRaw`'s handling of the three shapes
 * `ctx.inputs[key]` can arrive in, but keeps the real `JSON.parse` error
 * instead of swallowing it.
 */
export function diagnoseJsonInput(ctx, key) {
    if (!key)
        return { status: 'missing' };
    const v = ctx.inputs[key];
    if (v === undefined || v === null || v === '')
        return { status: 'missing' };
    if (typeof v === 'object')
        return { status: 'ok', value: v };
    if (typeof v === 'string') {
        const looksLikePath = /\.(json|md|txt)$/i.test(v) && !v.includes('\n');
        if (looksLikePath) {
            if (!existsSync(v))
                return { status: 'missing' };
            const text = readFileSync(v, 'utf-8');
            if (!text.trim())
                return { status: 'missing' };
            try {
                return { status: 'ok', value: JSON.parse(text) };
            }
            catch (e) {
                return { status: 'malformed', error: e instanceof Error ? e.message : String(e) };
            }
        }
        try {
            return { status: 'ok', value: JSON.parse(v) };
        }
        catch (e) {
            return { status: 'malformed', error: e instanceof Error ? e.message : String(e) };
        }
    }
    return { status: 'missing' };
}
/**
 * h3_film v0.2.0: `shot_repair`'s output (and, wrapped the same way,
 * `h3.audit_shot`'s batched result) may now be SCENE-shaped —
 * `{ sceneId, shots: [...] }` (one entry per shot in that scene) — instead
 * of the original flat one-entry-per-shot-item shape `collectAll` was
 * built for. `h3.audit_scene`/`h3.scene_render_manifest` still need a flat
 * per-shot view (they filter/look up by shot id). This expands any
 * scene-shaped entries in a `collectAll` result into per-shot entries,
 * leaving already-flat (legacy, h3_shots-style) entries untouched — both
 * shapes can appear in the SAME aggregate simultaneously with zero
 * ambiguity, since a scene-shaped value structurally has `.shots[]` and a
 * bare `ShotPrompt` never does.
 */
export function flattenShotEntries(entries) {
    const out = [];
    for (const e of entries) {
        const v = e.value;
        if (v && Array.isArray(v.shots)) {
            for (const shot of v.shots) {
                if (shot && typeof shot.id === 'string')
                    out.push({ itemId: shot.id, value: shot });
            }
        }
        else {
            out.push({ itemId: e.itemId, value: e.value });
        }
    }
    return out;
}
/**
 * Same expansion, for `h3.audit_shot`'s batched `{ ok, sceneId, perShot: [...] }`
 * result — each `perShot[]` entry already carries its own `shotId`/`ok`/
 * `findings`/`speakerAssignments`, matching the legacy per-shot audit record
 * shape exactly once renamed `shotId` -> `itemId`.
 */
export function flattenShotAuditEntries(entries) {
    const out = [];
    for (const e of entries) {
        const v = e.value;
        if (v && Array.isArray(v.perShot)) {
            for (const p of v.perShot) {
                if (p && typeof p.shotId === 'string') {
                    out.push({ itemId: p.shotId, value: { ok: p.ok, findings: p.findings, speakerAssignments: p.speakerAssignments } });
                }
            }
        }
        else {
            out.push({ itemId: e.itemId, value: e.value });
        }
    }
    return out;
}
/**
 * h3_film v0.2.0: resolve a `promptsInput`-style dependency (shot_repair's
 * output) into a flat per-shot view, REGARDLESS of whether the walker
 * handed it over via `scope:'matching'` (now that shot_repair is itself
 * scene-granular, this is a SINGLE `{ sceneId, shots: [...] }` document --
 * no id-keyed map at all) or the older `scope:'all'` aggregation (a map of
 * `sceneId -> { sceneId, shots: [...] }`, or even the original flat
 * `shotId -> ShotPrompt` shape from a pre-v0.2.0 flat-shotId shot_repair).
 * Preferring the exact `matching` shape when present is what makes
 * `h3.audit_scene`/`h3.scene_render_manifest` NOT need a film-wide
 * `scope:'all'` dependency at all for their PRIMARY read -- eliminating the
 * exact cross-scene cascade this whole mechanism exists to avoid. The
 * `scope:'all'` fallback stays for `h3.audit_film` (genuinely film-wide by
 * design) and for backward compatibility.
 */
export function resolvePerShotPrompts(ctx, key) {
    if (!key)
        return [];
    const resolved = readRaw(ctx, key);
    if (resolved && typeof resolved === 'object' && !Array.isArray(resolved) && Array.isArray(resolved.shots)) {
        const shots = resolved.shots;
        return shots.filter((s) => s && typeof s.id === 'string').map((s) => ({ itemId: s.id, value: s }));
    }
    return flattenShotEntries(collectAll(ctx, key));
}
/** Same idea as `resolvePerShotPrompts`, for a `shotAuditInput`-style
 * dependency (shot_audit's output) -- prefers the exact `scope:'matching'`
 * single-scene `{ ok, sceneId, perShot: [...] }` document when present. */
export function resolvePerShotAudits(ctx, key) {
    if (!key)
        return [];
    const resolved = readRaw(ctx, key);
    if (resolved && typeof resolved === 'object' && !Array.isArray(resolved) && Array.isArray(resolved.perShot)) {
        const perShot = resolved.perShot;
        return perShot
            .filter((p) => p && typeof p.shotId === 'string')
            .map((p) => ({ itemId: p.shotId, value: { ok: p.ok, findings: p.findings, speakerAssignments: p.speakerAssignments } }));
    }
    return flattenShotAuditEntries(collectAll(ctx, key));
}
/**
 * The FILESYSTEM PATH an input resolved to, when there is one.
 *
 * `readRaw` answers "what is the value" and happily parses a path into an
 * object. A runner that wants to write a corrected document BACK to where it
 * came from needs the path instead, and the two are not the same question.
 *
 * A matching-scope collection input does not arrive as a bare string: it is a
 * `{ [itemId]: path }` map, so a `typeof v === 'string'` guard silently skips
 * the write and the correction never reaches the next node. Measured
 * 2026-09-02: h3.audit_shot_references normalized a scene's reference layer in
 * memory, passed its own gate, and persisted nothing — shot_prose would have
 * read the un-normalized document.
 *
 * Returns undefined when the input is an inline value with no file behind it;
 * callers must treat that as "nothing to write back", never as an error.
 */
export function resolveInputPath(ctx, key) {
    if (!key)
        return undefined;
    const v = ctx.inputs[key];
    const asPath = (x) => {
        if (typeof x === 'string' && /\.(json|md|txt)$/i.test(x) && !x.includes('\n'))
            return x;
        if (x && typeof x === 'object') {
            const abs = x['outputAbs'] ?? x['path'];
            if (typeof abs === 'string')
                return abs;
        }
        return undefined;
    };
    const direct = asPath(v);
    if (direct)
        return direct;
    // matching-scope collection: { [itemId]: path | { outputAbs } }
    if (v && typeof v === 'object' && !Array.isArray(v)) {
        const map = v;
        if (ctx.itemId && ctx.itemId in map) {
            const hit = asPath(map[ctx.itemId]);
            if (hit)
                return hit;
        }
        // a single-entry map is unambiguous even without an itemId
        const keys = Object.keys(map);
        if (keys.length === 1)
            return asPath(map[keys[0]]);
    }
    return undefined;
}
//# sourceMappingURL=inputs.js.map