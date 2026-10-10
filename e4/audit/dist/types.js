/**
 * Shared shapes for the h3-audit tools. These mirror the JSON this bundle's
 * `continuity`, `dialogue_ledger` and `shot_prompt` nodes actually write —
 * see ~/.kshana/bundles/h3_shots/README.md for the authoritative schema.
 */
export function isSceneShotBatch(v) {
    return Boolean(v && typeof v === 'object' && Array.isArray(v.shots));
}
//# sourceMappingURL=types.js.map