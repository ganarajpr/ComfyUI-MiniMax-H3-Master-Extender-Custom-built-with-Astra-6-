import { readJson, rs } from './inputs.js';
/**
 * A DELIBERATELY SMALL, closed keyword sweep — same design as this
 * package's other word lists (SOUNDSCAPE_BANNED, forbidden-word sweep):
 * it can false-negative on an unusual phrasing of the same intent, but it
 * can also genuinely fire, which is the property that matters for a gate.
 * Detecting "this brief means no dialogue" from ARBITRARY prose is
 * inherently semantic and cannot be made exhaustive deterministically —
 * this is a floor, not a substitute for good authoring elsewhere.
 */
const NO_DIALOGUE_PATTERNS = [
    /\bno dialogue\b/i,
    /\bwithout dialogue\b/i,
    /\bno spoken words?\b/i,
    /\bno words? (?:are |is )?spoken\b/i,
    /\bno speech\b/i,
    /\bwordless\b/i,
    /\bsilent film\b/i,
    /\bsilent short\b/i,
    /\bnobody speaks\b/i,
    /\bno one speaks\b/i,
    /\bno talking\b/i,
    /\bpurely visual\b/i,
    /\bentirely non-verbal\b/i,
];
/** The matched phrase, or undefined when no no-dialogue signal is present. */
export function detectNoDialogueSignal(text) {
    const t = String(text ?? '');
    for (const re of NO_DIALOGUE_PATTERNS) {
        const m = re.exec(t);
        if (m)
            return m[0];
    }
    return undefined;
}
const FIRST_OR_SECOND_PERSON_RE = /\b(i'm|i've|i'll|i'd|i|me|my|mine|myself|we're|we've|we'll|we'd|we|us|our|ours|ourselves|you're|you've|you'll|you'd|you|your|yours|yourself)\b/i;
/**
 * A small closed vocabulary of common third-person present-tense action
 * verbs, plus a generic "-s" ending fallback for regular verbs not on the
 * list. Deliberately not exhaustive — see the module doc: several signals
 * must agree, so this list does not have to catch every verb on its own.
 */
const ACTION_VERB_LIST = new Set([
    'checks', 'goes', 'climbs', 'tries', 'turns', 'walks', 'moves', 'watches', 'waits',
    'stands', 'sits', 'nods', 'shakes', 'reaches', 'opens', 'closes', 'stops', 'leaves',
    'enters', 'stares', 'glances', 'decides', 'looks', 'reads', 'sighs', 'steps', 'kneels',
    'crouches', 'freezes', 'hesitates', 'pauses', 'pulls', 'pushes', 'drops', 'lifts',
    'raises', 'lowers', 'grips', 'releases', 'exhales', 'inhales', 'breathes', 'runs',
    'jumps', 'falls', 'rises', 'sinks', 'drifts', 'pivots', 'crosses', 'follows',
    'begins', 'starts', 'continues', 'settles', 'shifts', 'leans', 'smiles', 'frowns',
    'gestures', 'points', 'holds', 'grabs', 'clutches', 'wipes', 'sets', 'places',
]);
function escapeRegExp(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
function displayNameFromSpeakerId(speaker) {
    return speaker
        .split('_')
        .filter(Boolean)
        .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
        .join(' ');
}
function isPresentTenseActionVerb(word) {
    const w = word.toLowerCase().replace(/^[^a-z]+|[^a-z]+$/g, '');
    if (!w)
        return false;
    if (ACTION_VERB_LIST.has(w))
        return true;
    // Generic 3rd-person-singular present-tense shape: ends in "s", long
    // enough not to collide with a stray possessive/pronoun ("his", "yes").
    if (/^[a-z]{4,}s$/.test(w) && w !== 'this')
        return true;
    return false;
}
/**
 * Does `text` OPEN with a third-person-narrator subject — a bare pronoun
 * (He/She/It/They) or the speaker's own name (derived from `speaker`'s
 * ledger id)? The task's own strongest single tell: an entry whose SUBJECT
 * is the same character as its `speaker` is describing them, not being
 * spoken by them.
 */
function matchNarratorSubject(text, speaker) {
    const trimmed = text.trim();
    const pronounRe = /^(he|she|it|they)(?:'s|'re|'ll|'ve|'d)?\b\s*/i;
    const pm = pronounRe.exec(trimmed);
    if (pm)
        return { subject: pm[0].trim(), rest: trimmed.slice(pm[0].length) };
    if (speaker) {
        const name = displayNameFromSpeakerId(speaker);
        if (name) {
            const nameRe = new RegExp(`^${escapeRegExp(name)}(?:'s|'re|'ll|'ve|'d)?\\b\\s*`, 'i');
            const nm = nameRe.exec(trimmed);
            if (nm)
                return { subject: nm[0].trim(), rest: trimmed.slice(nm[0].length) };
        }
    }
    return undefined;
}
/**
 * Deterministic "is this plausibly something a person says OUT LOUD" check
 * for one `dialogue_ledger` entry. Returns a human-readable reason when the
 * entry should be rejected, or `undefined` when it is plausible speech.
 *
 * Two independent rejection paths, mirroring the task's own examples:
 *
 * 1. NARRATION REPORTING SPEECH — 'The static reads: "Dev decides to
 *    stay."' — a colon immediately followed by a quoted span means the
 *    ledger text is ABOUT an utterance, not the utterance itself. Real
 *    spoken `text` should just BE the words; wrapping them in a reporting
 *    clause + quotes is a standalone, sufficient tell.
 *
 * 2. THIRD-PERSON STAGE DIRECTION — "He checks his watch." — requires
 *    SEVERAL signals to agree, so a terse real line like "Stay." (no
 *    narrator subject at all) is never rejected:
 *      a. the text opens with a third-person subject (a bare pronoun, or
 *         the speaker's own name) — the strongest single tell per the task;
 *      b. the very next word is a present-tense action verb ("checks",
 *         "climbs", "goes", …);
 *      c. the text has NO first- or second-person pronoun anywhere (a
 *         corroborating signal — "They watch us." keeps its "us" and is
 *         left alone even though (a)+(b) both fire).
 *    All three must hold. Any one alone is not enough — that is exactly
 *    what would over-reject a real short line.
 */
export function ledgerLineImplausibilityReason(entry) {
    const text = String(entry.text ?? '');
    if (!text.trim())
        return undefined; // empty text is a different problem, not this check's job
    if (/:\s*["“]/.test(text)) {
        return 'reads as narration REPORTING speech (a colon immediately followed by a quoted span), not the spoken words themselves';
    }
    const subjectMatch = matchNarratorSubject(text, entry.speaker);
    if (!subjectMatch)
        return undefined;
    const nextWordMatch = /^([a-zA-Z']+)/.exec(subjectMatch.rest);
    const nextWord = nextWordMatch?.[1];
    if (!nextWord || !isPresentTenseActionVerb(nextWord))
        return undefined;
    if (FIRST_OR_SECOND_PERSON_RE.test(text))
        return undefined;
    return `reads as third-person narration ("${subjectMatch.subject} ${nextWord}…") describing what the speaker DOES, not something they SAY — nobody says "${subjectMatch.subject} ${nextWord}..." out loud about themselves`;
}
export const auditDialogueLedgerRunner = {
    describe: () => ({
        id: 'h3.audit_dialogue_ledger',
        displayName: 'H3 dialogue ledger audit (deterministic gate, blocking, before anything consumes the ledger)',
        description: "Sits immediately after dialogue_ledger, before continuity/shot_prose/any audit reads it. Deterministic, zero LLM calls: (1) rejects a ledger entry that is not plausibly something a person says out loud -- a stage direction ('He checks his watch.') or narration reporting speech ('X reads: \"...\"') accepted as spoken dialogue, requiring several mechanical signals to agree so a terse real line is never over-rejected; (2) when the film's own source material states there is no dialogue (a legitimate 'no dialogue at all' / 'wordless' / 'silent film' brief), requires the ledger to be EMPTY. BLOCKS (ok:false) on any violation -- no repair loop can win against wrong ledger data.",
        capabilities: ['audit.deterministic', 'audit.ledger_plausibility'],
        modalities: { input: ['text'], output: ['text'] },
        configSchema: {
            type: 'object',
            required: ['ledgerInput', 'outputPath'],
            properties: {
                ledgerInput: { type: 'string', description: 'Input id of the full dialogue ledger array ({ id, speaker, language?, text }[]) -- the ledger of record, freshly authored by dialogue_ledger.' },
                narrativeSeedInput: {
                    type: 'string',
                    description: "OPTIONAL. Input id of narrative_seed ({ hasStory, storyText?, ... }). When wired, storyText is swept for an explicit no-dialogue signal ('no dialogue', 'wordless', 'silent film', ...) and, when found, the ledger is REQUIRED to be empty. Omit to skip this half of the gate (the per-entry plausibility check always runs regardless).",
                },
                outputPath: { type: 'string', description: 'Where to write { ok, count, findings } -- relative to the project dir.' },
            },
        },
        costHint: 'free',
    }),
    run: async (ctx) => {
        const cfg = ctx.node.runner.config;
        const ledger = readJson(ctx, rs(cfg, 'ledgerInput'));
        const narrativeSeed = readJson(ctx, rs(cfg, 'narrativeSeedInput'));
        const outputPath = rs(cfg, 'outputPath');
        if (!Array.isArray(ledger))
            return { ok: false, error: 'h3.audit_dialogue_ledger: ledgerInput did not resolve to an array' };
        if (!outputPath)
            return { ok: false, error: 'h3.audit_dialogue_ledger: config.outputPath is required' };
        const findings = [];
        for (const entry of ledger) {
            const reason = ledgerLineImplausibilityReason(entry);
            if (reason) {
                findings.push({
                    code: 'LEDGER_ENTRY_NOT_SPEECH',
                    message: `ledger entry "${entry?.id ?? '?'}" (speaker "${entry?.speaker ?? '?'}") ${reason}: ${JSON.stringify(entry?.text ?? '')}`,
                    operation: 'delete',
                    hint: `Remove this entry from dialogue_ledger entirely -- it is a stage direction/narration, not spoken dialogue, and the fix is deletion, never a rewrite into a line of dialogue nobody would actually say. ` +
                        `Renumber no OTHER ids. If any scene_split shot's lineIds[] already cites "${entry?.id ?? '?'}", remove that citation too (or regenerate scene_split after fixing the ledger).`,
                });
            }
        }
        const noDialogueMatch = detectNoDialogueSignal(narrativeSeed?.storyText);
        if (noDialogueMatch && ledger.length > 0) {
            findings.push({
                code: 'LEDGER_SHOULD_BE_EMPTY',
                message: `the film's source material states there is no dialogue (matched "${noDialogueMatch}") but dialogue_ledger has ${ledger.length} entr${ledger.length === 1 ? 'y' : 'ies'}`,
                operation: 'delete',
                hint: 'Regenerate dialogue_ledger as a bare empty JSON array []. A wordless/no-dialogue film is a legitimate deliverable -- ' +
                    'do not invent lines to satisfy a non-empty ledger, and do not let a schema minItems floor force one either.',
            });
        }
        const ok = findings.length === 0;
        const { writeFileSync, mkdirSync } = await import('node:fs');
        const { dirname, resolve } = await import('node:path');
        const abs = resolve(ctx.projectDir, outputPath);
        mkdirSync(dirname(abs), { recursive: true });
        writeFileSync(abs, JSON.stringify({ ok, count: ledger.length, findings }, null, 2));
        for (const f of findings)
            ctx.log(`h3.audit_dialogue_ledger ${f.code}: ${f.message}`);
        if (!ok) {
            return {
                ok: false,
                error: `h3.audit_dialogue_ledger: BLOCKED -- ${findings.length} finding(s): ${findings.map((f) => `[${f.code}] ${f.message}`).join(' | ')}`,
            };
        }
        return { ok: true, outputPath };
    },
};
//# sourceMappingURL=auditDialogueLedger.js.map