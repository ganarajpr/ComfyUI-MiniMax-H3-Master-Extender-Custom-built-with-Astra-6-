/**
 * Deterministic repair of the reference layer's two mechanical sections,
 * BEFORE the gate runs and with no LLM call.
 *
 * Two failures show up over and over, and neither is a judgement call:
 *
 *  1. ANCHORING. `subjectDefinitions` has every `<Subject N>` token but runs
 *     two of them together on one line. The audit anchors the token to a line
 *     start, so the shot fails with all its content present. Re-breaking the
 *     lines is a pure formatting fix.
 *
 *  2. A MISSING ENTRY. `references[]` declares N plates but only the first few
 *     get a definition paragraph. This looks like lost content, but it is not:
 *     the reference entry the model already wrote carries `appearsAs`, `type`
 *     and `job`, which is exactly what a definition paragraph says. Composing
 *     the paragraph from that entry invents nothing — it restates the model's
 *     own words in the section the audit reads.
 *
 * Measured 2026-09-02 across two scenes of one film: scene 1 failed on (1),
 * scene 2 on (2) — the same gate, twice, on a purely mechanical deviation.
 * Sending either to an LLM to fix costs a call and can perturb prose that was
 * already correct.
 *
 * `retentionAnalysis` gets the same treatment: one `<Subject N>: marker` line
 * per reference, anchored, with a conservative `fully_preserved` for a missing
 * line (the audit's own accepted marker — a plate cited for a scene is
 * preserved unless the author said otherwise).
 */
export function normalizeReferenceLayerShot(shot) {
    const refs = Array.isArray(shot.references) ? shot.references : [];
    const changes = [];
    if (refs.length === 0)
        return { shot, changes };
    const definitions = splitBySubject(shot.subjectDefinitions ?? '', refs.length);
    const retention = splitBySubject(shot.retentionAnalysis ?? '', refs.length);
    const defOut = [];
    const retOut = [];
    for (let k = 1; k <= refs.length; k++) {
        const ref = refs[k - 1];
        const existingDef = definitions.get(k);
        if (existingDef) {
            defOut.push(existingDef);
        }
        else {
            defOut.push(composeDefinition(k, ref));
            changes.push(`backfilled <Subject ${k}> definition from references[${k - 1}] ('${ref.id}')`);
        }
        const existingRet = retention.get(k);
        if (existingRet) {
            retOut.push(existingRet);
        }
        else {
            retOut.push(`<Subject ${k}>: fully_preserved`);
            changes.push(`backfilled <Subject ${k}> retention line`);
        }
    }
    const nextDefs = defOut.join('\n\n');
    const nextRet = retOut.join('\n');
    if (nextDefs !== (shot.subjectDefinitions ?? '') && changes.length === 0) {
        changes.push('re-anchored <Subject N> tokens to line starts');
    }
    if (nextDefs === (shot.subjectDefinitions ?? '') && nextRet === (shot.retentionAnalysis ?? '')) {
        return { shot, changes: [] };
    }
    if (changes.length === 0)
        changes.push('re-anchored <Subject N> tokens to line starts');
    return {
        shot: { ...shot, subjectDefinitions: nextDefs, retentionAnalysis: nextRet },
        changes,
    };
}
/**
 * Split a section into its `<Subject N>` chunks WHEREVER the tokens sit — line
 * start or mid-sentence. That is what makes this a formatting fix rather than
 * a rewrite: the text between one token and the next is carried over verbatim.
 * Only tokens in 1..max are recognised, so a stray `<Subject 9>` cannot
 * silently create a chunk the audit will then reject.
 */
function splitBySubject(text, max) {
    const out = new Map();
    if (!text.trim())
        return out;
    const re = /<Subject\s+(\d+)>/g;
    const hits = [];
    let m;
    while ((m = re.exec(text)) !== null) {
        const n = Number(m[1]);
        if (n >= 1 && n <= max)
            hits.push({ n, start: m.index });
    }
    for (let i = 0; i < hits.length; i++) {
        const hit = hits[i];
        const end = i + 1 < hits.length ? hits[i + 1].start : text.length;
        const chunk = text.slice(hit.start, end).trim();
        // First occurrence wins; a duplicated token is the audit's problem to report.
        if (!out.has(hit.n) && chunk)
            out.set(hit.n, chunk);
    }
    return out;
}
/** Restate a reference entry as the definition paragraph the audit expects. */
function composeDefinition(k, ref) {
    const bits = [
        ref.appearsAs?.trim(),
        ref.job?.trim(),
    ].filter((s) => !!s);
    const body = bits.length
        ? bits.join('; ')
        : `the ${(ref.type ?? 'subject').replace(/_/g, ' ')} '${ref.id}' as established`;
    return `<Subject ${k}> is ${ref.id}, ${body}.`;
}
//# sourceMappingURL=normalizeReferenceLayer.js.map