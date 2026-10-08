import { readJson, rs } from './inputs.js';
import { normalizeText, extractDialogueTags, containsPictureBinding, precedingSpeaker, hasNativeScript, speechWithoutWords, SOUNDSCAPE_BANNED, onGrid, secondsToFrames, extractCuts, wordCount, forbiddenWordHits, hasCameraVocabulary, segmentByShotMarker, hasVocalDescriptor, checkBlockingAndEyeline, nearestGridSeconds, CAMERA_VOCABULARY, VOCAL_DESCRIPTOR_WORDS, } from './text.js';
import { isSceneShotBatch } from './types.js';
/**
 * Layer 1 — per-shot, deterministic. Ported from ~/Projects/h3-shots/submit.mjs
 * `audit()` (~line 320). Every check here is BLOCKING: a single failed shot
 * must stop the run, because clips are minutes of GPU each and a film with a
 * silently-wrong line is worse than one that never started.
 *
 * This tool makes NO LLM calls. Per the h3-shots skill: "An LLM in the
 * deterministic layer would add false negatives to checks that currently
 * have none — putting a model in the path that verifies dialogue would give
 * back exactly what this repo was built to buy." A semantic (Layer 3) or
 * Whisper (Layer 4) pass may ADD findings elsewhere; it must never be able
 * to clear one raised here.
 */
/**
 * `breakdownInput` is wired with `scope: 'matching'` against `shot_breakdown`
 * — but `shot_breakdown` is a STAGE (one instance), and dhee-core's walker
 * degrades an unmatched/stage 'matching' scope to "pick the first (only)
 * instance" (src/dag/walker.ts, the 'Otherwise: matching picks ...' branch).
 * That hands EVERY shot_prompt/shot_audit item the WHOLE
 * `{ shots: [...] }` document, not its own entry — confirmed live: shot101
 * and shot102 both received the full array and both authored both shots'
 * dialogue. Mirrors dhee-runner-minimax-h3's own `shotsForItem()`: never
 * trust a 'matching' scope to have sliced a stage-sourced plan; the RUNNER
 * must find its own row by itemId, defensively, regardless of which shape
 * the walker handed it.
 */
export function resolveBreakdownItem(raw, itemId) {
    if (!raw || typeof raw !== 'object')
        return undefined;
    const obj = raw;
    if (Array.isArray(obj.shots)) {
        const shots = obj.shots;
        if (itemId !== undefined) {
            const match = shots.find((s) => s?.id === itemId);
            if (match)
                return match;
        }
        return shots[0];
    }
    if (typeof obj.id === 'string' || Array.isArray(obj.lineIds)) {
        return raw;
    }
    return undefined;
}
/** The plate ids a scene_manifest grants, or undefined when not wired.
 * Shared by `h3.repair_shot` (via `auditShot`'s own `grantedPlateIds` param)
 * and `h3.audit_shot_references` (the reference-layer gate, `auditShotReferences.ts`)
 * — one implementation, so the two never drift on what "granted" means. */
export function grantedPlatesFrom(doc) {
    if (!doc || typeof doc !== 'object')
        return undefined;
    const refs = doc.references;
    if (!Array.isArray(refs))
        return undefined;
    const ids = refs.map((r) => String(r?.id ?? '')).filter(Boolean);
    return ids.length ? new Set(ids) : undefined;
}
/**
 * The reference-layer checks — factored out of `auditShot()` so
 * `h3.audit_shot_references` (the deterministic gate between `shot_references`
 * and `shot_prose`, h3_film v0.6.0) and `auditShot()` itself (the full
 * post-merge check, still run by `h3.repair_shot`/`h3.audit_shot`) share
 * exactly ONE implementation of "is this reference layer internally
 * consistent" — never two copies that can drift apart. `extraSubjectRangeFields`
 * lets `auditShot()` additionally scan `detailedDescription`/`summary` for an
 * out-of-range `<Subject N>` token once those fields exist (they don't yet at
 * the reference-layer stage, before `shot_prose` has run) — see `auditShot()`'s
 * own call site below.
 */
export function auditReferenceLayer(layer, grantedPlateIds, extraSubjectRangeFields = []) {
    const findings = [];
    const fail = (code, message, extra) => findings.push({ code, message, ...extra });
    // ── references[] must be a SUBSET of the plates this scene was granted ──
    // h3.longmedia refuses to render a shot citing a plate id with no resolved
    // image ("cite plate id(s) with no resolved reference image: successor,
    // vaulted_chamber"), but nothing here checked it — so the author invented
    // reference ids, every gate passed, and the failure surfaced only at render
    // time. scene_manifest is the authority: it is the already-capped list of
    // plates THIS scene may cite. The breakdown's own `refs` is NOT usable for
    // this — measured 2026-09-02, scene_split left it empty while the manifest
    // correctly granted keeper + lighthouse.
    if (grantedPlateIds && grantedPlateIds.size > 0) {
        const cited = Array.isArray(layer.references) ? layer.references : [];
        const illegal = cited
            .map((r) => String(r?.id ?? ''))
            .filter((id) => id && !grantedPlateIds.has(id));
        if (illegal.length > 0) {
            fail('REFERENCE_NOT_GRANTED', `references[] cites plate id(s) this scene was not granted: ${illegal.join(', ')} — the scene manifest grants only [${[...grantedPlateIds].join(', ')}]`, {
                operation: 'delete',
                hint: `Remove the reference entry for ${illegal.join(', ')} from references[], and remove its <Subject N> paragraph ` +
                    `from subjectDefinitions and its line from retentionAnalysis. Renumber the remaining <Subject N> tokens so they ` +
                    `stay 1-based and contiguous into the shortened references[]. Rewrite any prose that depended on the removed ` +
                    `subject to use only the granted plates [${[...grantedPlateIds].join(', ')}] — do NOT invent a plate to keep a ` +
                    `sentence; the plate must actually exist as a rendered reference image.`,
            });
        }
    }
    // ── references sanity ──
    if (!Array.isArray(layer.references) || layer.references.length === 0) {
        fail('NO_REFERENCES', 'references[] is empty — H3 needs at least one identity/set plate with an explicit job');
    }
    else {
        layer.references.forEach((r, i) => {
            if (!r.id || !r.type || !r.appearsAs || !r.job) {
                fail('REFERENCE_INCOMPLETE', `references[${i}] is missing one of id/type/appearsAs/job`);
            }
        });
    }
    // ── GAP 1 (v0.2.0): subject_definitions — one of the six official H3
    // sections, missing from v0.1.0. AUTHORING-ONLY (the render runner builds
    // its own mechanical version from references[] after routing — see the
    // schema's field description) but still checked here: this is where the
    // model is forced to plan every subject's identity and this shot's
    // specific performance BEFORE writing detailedDescription, so it earns a
    // real check even though its text never reaches H3 verbatim. ──
    const subjectDefs = String(layer.subjectDefinitions ?? '');
    const refCount = Array.isArray(layer.references) ? layer.references.length : 0;
    if (!subjectDefs.trim()) {
        fail('SUBJECT_DEFINITIONS_MISSING', 'subjectDefinitions is empty — one paragraph per reference is required');
    }
    else {
        for (let k = 1; k <= refCount; k++) {
            if (!new RegExp(`(?:^|\\n)\\s*<Subject\\s+${k}>`).test(subjectDefs)) {
                fail('SUBJECT_DEFINITIONS_MISSING_ENTRY', `subjectDefinitions has no paragraph starting with <Subject ${k}> (references[] has ${refCount} entries — one paragraph per reference is required, in order)`, {
                    operation: 'substitute',
                    hint: `Put <Subject ${k}> at the START of its own line, separated from the previous entry by a blank line. ` +
                        `The token may already be present mid-sentence — that does not count; the check anchors to a line start. ` +
                        `Do not add or remove any subject, only re-break the lines.`,
                });
            }
        }
        if (extractDialogueTags(subjectDefs).length > 0) {
            fail('SUBJECT_DEFINITIONS_CONTAINS_DIALOGUE', 'subjectDefinitions contains a <d> dialogue tag — this section is identity/behavior, never action or speech');
        }
        if (containsPictureBinding(subjectDefs)) {
            fail('SUBJECT_DEFINITIONS_CONTAINS_PICTURE', 'subjectDefinitions contains a literal <Picture N> clause — never authored, the renderer builds it');
        }
    }
    // ── GAP 1 (v0.2.0): retention_analysis — the other missing official section. ──
    const RETENTION_MARKERS = ['fully_preserved', 'partially_preserved', 'attribute_transfer', 'weak_reference'];
    const retention = String(layer.retentionAnalysis ?? '');
    if (!retention.trim()) {
        fail('RETENTION_ANALYSIS_MISSING', 'retentionAnalysis is empty — one "<Subject N>: MARKER" line per reference is required');
    }
    else {
        if (/\(S\d+\)/.test(retention)) {
            fail('RETENTION_ANALYSIS_CONTAINS_SPEAKER_TAG', 'retentionAnalysis contains a (Sx) speaker marker — retention_analysis states a preservation relationship, never who speaks (official H3 rule)');
        }
        const lines = [...retention.matchAll(/<Subject\s+(\d+)>\s*:\s*([a-zA-Z_]+)/g)];
        const seen = new Set(lines.map((m) => Number(m[1])));
        for (let k = 1; k <= refCount; k++) {
            if (!seen.has(k)) {
                fail('RETENTION_ANALYSIS_MISSING_ENTRY', `retentionAnalysis has no "<Subject ${k}>: MARKER" line (references[] has ${refCount} entries)`);
            }
        }
        for (const m of lines) {
            const marker = m[2];
            if (!RETENTION_MARKERS.includes(marker)) {
                fail('RETENTION_ANALYSIS_INVALID_MARKER', `retentionAnalysis line for <Subject ${m[1]}> uses "${marker}", not one of ${RETENTION_MARKERS.join(', ')}`);
            }
        }
    }
    // ── Subject numbers must exist in references[] ──
    // h3.longmedia rejects a shot whose prose cites <Subject N> beyond
    // references.length ("prose cites <Subject 3> but refIds declares only 2"),
    // but nothing here caught it — so the repair loop never got the chance and
    // the failure only surfaced at render time, after every gate had passed.
    // A gate that lets through what the renderer rejects is a gate that
    // silently passes. Measured 2026-09-02 on scene01 of the lighthouse film.
    {
        const cited = new Set();
        for (const field of [layer.subjectDefinitions, layer.retentionAnalysis, ...extraSubjectRangeFields]) {
            for (const m of String(field ?? '').matchAll(/<Subject (\d+)>/g))
                cited.add(Number(m[1]));
        }
        const over = [...cited].filter((n) => n > refCount || n < 1).sort((a, b) => a - b);
        if (over.length && refCount > 0) {
            fail('SUBJECT_NUMBER_OUT_OF_RANGE', `prose cites ${over.map((n) => `<Subject ${n}>`).join(', ')} but references[] declares only ${refCount} — <Subject N> is 1-based into references[], so the highest legal label is <Subject ${refCount}>`, {
                operation: 'substitute',
                hint: `Every <Subject N> token must be between <Subject 1> and <Subject ${refCount}> inclusive. ` +
                    `Either renumber the out-of-range token(s) onto the correct existing reference (check which id sits at that ` +
                    `1-based position in references[]), or delete the sentence that introduces a subject this shot has no reference for. ` +
                    `Do NOT add a new entry to references[] to make the number legal — the plate must actually exist.`,
            });
        }
    }
    return findings;
}
export function auditShot(prompt, breakdown, ledger, continuity, grantedPlateIds) {
    const findings = [];
    const fail = (code, message, extra) => findings.push({ code, message, ...extra });
    // ── reference-layer checks (references[]/subjectDefinitions/retentionAnalysis)
    // — shared with h3.audit_shot_references, see auditReferenceLayer() above.
    // extraSubjectRangeFields adds detailedDescription/summary to the
    // out-of-range <Subject N> scan, since both exist by the time this
    // full-shot audit runs (post-merge) but not at the reference-layer stage. ──
    findings.push(...auditReferenceLayer(prompt, grantedPlateIds, [prompt.detailedDescription, prompt.summary]));
    const speakerAssignments = [];
    const prose = String(prompt.detailedDescription ?? '');
    const ledgerById = new Map(ledger.map((l) => [l.id, l]));
    // ── 1. <d> vs ledger — the check this bundle exists for. Never relax. ──
    const expectedIds = breakdown?.lineIds ?? [];
    const tags = extractDialogueTags(prose);
    if (expectedIds.length !== tags.length) {
        fail('DIALOGUE_COUNT_MISMATCH', `shot declares ${expectedIds.length} ledger line(s) [${expectedIds.join(', ') || 'none'}] but detailedDescription contains ${tags.length} <d> tag(s)`, 
        // Mechanical in BOTH directions, so repair can act instead of re-rolling.
        // Measured 2026-09-02: scene01/shot001 declares lineIds:[] (a silent
        // beat) and the author wrote two <d> tags; the finding named the count
        // but not the edit, so repair exhausted on it.
        expectedIds.length === 0
            ? {
                operation: 'delete',
                hint: `This shot is SILENT — its breakdown declares no ledger lines. Delete every <d>...</d> tag from ` +
                    `detailedDescription, along with the speech that introduces each one (the "(S<n>) says:" clause and any ` +
                    `vocal-identity phrase attached to it). Replace each with a NON-VOCAL physical beat of similar length so the ` +
                    `word count holds — a look, a breath, a hand moving — and make sure no speech-shaped word survives. Do not ` +
                    `add dialogue anywhere else to compensate.`,
            }
            : tags.length > expectedIds.length
                ? {
                    operation: 'delete',
                    hint: `Keep exactly the ${expectedIds.length} tag(s) carrying ledger line(s) [${expectedIds.join(', ')}], in that ` +
                        `order, and delete the extra ${tags.length - expectedIds.length}. Replace each deleted line with a non-vocal ` +
                        `physical beat so the word count holds.`,
                }
                : {
                    operation: 'insert',
                    hint: `Add the missing ${expectedIds.length - tags.length} line(s) — ledger id(s) [${expectedIds.join(', ')}] — each as ` +
                        `<Subject k> (S<n>) says: <d>[Language]…</d> with the ledger's text VERBATIM, in ledger order, in this shot's prose.`,
                });
    }
    const n = Math.min(expectedIds.length, tags.length);
    for (let i = 0; i < n; i++) {
        const lineId = expectedIds[i];
        const ledgerLine = ledgerById.get(lineId);
        const tag = tags[i];
        if (!ledgerLine) {
            fail('DIALOGUE_UNKNOWN_ID', `lineIds[${i}]="${lineId}" does not exist in dialogue_ledger`);
            continue;
        }
        const expected = normalizeText(ledgerLine.text);
        const actual = normalizeText(tag.text);
        if (expected !== actual) {
            fail('DIALOGUE_MISMATCH', `<d> #${i + 1} (ledger id "${lineId}") does not byte-match the ledger.\n  expected: ${JSON.stringify(expected)}\n  actual:   ${JSON.stringify(actual)}`, { span: actual, operation: 'substitute', hint: expected });
        }
        const expectedLang = (ledgerLine.language ?? continuity.language ?? '').trim();
        if (expectedLang && tag.language.trim().toLowerCase() !== expectedLang.toLowerCase()) {
            fail('DIALOGUE_LANGUAGE_MISMATCH', `<d> #${i + 1} (ledger id "${lineId}") tagged [${tag.language}], expected [${expectedLang}]`, { span: tag.language, operation: 'substitute', hint: expectedLang });
        }
        // native script (per line, since a project can mix languages per line)
        if (continuity.scriptRange && expectedLang.toLowerCase() === (continuity.language ?? '').toLowerCase()) {
            if (!hasNativeScript(tag.text, continuity.scriptRange)) {
                fail('NON_NATIVE_SCRIPT', `<d> #${i + 1} (ledger id "${lineId}") has no character in continuity.scriptRange [${continuity.scriptRange.join(',')}] — looks romanized`, { span: tag.text, operation: 'substitute', hint: `rewrite the ledger's own text for "${lineId}" in native script — copy it from dialogue_ledger, do not transliterate` });
            }
        }
        // ── 2. attribution — nearest preceding (SN)/<Subject k> must resolve to the ledger's speaker ──
        const { subjectNum, speakerNum } = precedingSpeaker(prose, tag.index);
        if (subjectNum === null) {
            fail('DIALOGUE_NO_SPEAKER', `<d> #${i + 1} (ledger id "${lineId}") has no preceding <Subject k> marker to attribute it`, { operation: 'insert', hint: `insert "<Subject k> (S<n>)" immediately before this <d> tag's "says:" clause, where k is this speaker's position in references[]` });
        }
        else {
            const ref = prompt.references?.[subjectNum - 1];
            if (!ref) {
                fail('DIALOGUE_SUBJECT_OUT_OF_RANGE', `<d> #${i + 1} cites <Subject ${subjectNum}> but references[] has ${prompt.references?.length ?? 0} entries`);
            }
            else if (ref.id !== ledgerLine.speaker) {
                const correctIdx = prompt.references.findIndex((r) => r.id === ledgerLine.speaker);
                fail('DIALOGUE_SPEAKER_MISMATCH', `<d> #${i + 1} (ledger id "${lineId}") is attributed to <Subject ${subjectNum}> = "${ref.id}" but the ledger's speaker is "${ledgerLine.speaker}"`, {
                    span: `<Subject ${subjectNum}>`,
                    operation: 'substitute',
                    hint: correctIdx >= 0 ? `<Subject ${correctIdx + 1}>` : `the references[] entry whose id is "${ledgerLine.speaker}"`,
                });
            }
        }
        // ── official rule: every spoken line needs BOTH a (Sx) speaker id AND the <d> tag ──
        if (speakerNum === null) {
            fail('DIALOGUE_MISSING_SPEAKER_ID', `<d> #${i + 1} (ledger id "${lineId}") has no (S<n>) speaker id before it — the official format requires both a (Sx) marker and the <d> tag on every spoken line, or H3 may pick a voice at random`, { operation: 'insert', hint: '"(S<n>)" immediately after the speaker\'s <Subject k> token, before "says:" — n is that character\'s FIRST-speaking order across the whole film, kept consistent in every shot they speak in' });
        }
        else {
            speakerAssignments.push({ subjectId: ledgerLine.speaker, sNumber: speakerNum });
        }
        // ── official rule: vocal identity (age, register, pace, accent) outside the tag ──
        const vocalWindowStart = Math.max(0, tag.index - 300);
        const vocalWindow = prose.slice(vocalWindowStart, tag.index);
        if (!hasVocalDescriptor(vocalWindow)) {
            fail('DIALOGUE_MISSING_VOCAL_IDENTITY', `<d> #${i + 1} (ledger id "${lineId}") has no vocal-identity descriptor (age/register/pace/accent) in the text before it — H3 picks a voice at random and drifts without one`, { operation: 'insert', hint: `a real phrase drawn from ${ledgerLine.speaker}'s voicePrompt, e.g. one of: ${VOCAL_DESCRIPTOR_WORDS.slice(0, 6).join(', ')}, … — placed in the same sentence as, or the one just before, this <d> tag` });
        }
    }
    // ── 6. no <Picture N> in authored prose (the render runner builds this itself) ──
    {
        const pictureMatch = /<Picture\s*\d+>[^\n]*/i.exec(prose);
        if (pictureMatch) {
            fail('PICTURE_BINDING_AUTHORED', 'detailedDescription contains a literal <Picture N> clause — this is built deterministically by comfy.minimax_h3_r2v (bindingClause) and must never be authored', { span: pictureMatch[0], operation: 'delete', hint: 'remove this clause entirely — the renderer builds the binding clause itself' });
        }
    }
    // ── 4. speech described with no words ──
    for (const hit of speechWithoutWords(prose)) {
        const m = /^"(.*)" \(matched verb: (.+)\)$/.exec(hit);
        fail('SPEECH_WITHOUT_WORDS', `speech verb with no <d> tag nearby: ${hit}`, m ? { span: m[1], operation: 'substitute', hint: `rewrite with zero speech-shaped words (remove "${m[2]}"); describe physical stillness/reaction only, e.g. "his gaze fixed steadily on her" — or add the missing <d>[Language] ...</d> tag right in this sentence if the line genuinely belongs here` } : undefined);
    }
    // ── 5. overall_soundscape vocal-free ──
    const soundscape = String(prompt.overallSoundscape ?? '');
    const soundscapeLower = soundscape.toLowerCase();
    for (const banned of SOUNDSCAPE_BANNED) {
        if (new RegExp(`\\b${banned}\\b`, 'i').test(soundscapeLower)) {
            fail('SOUNDSCAPE_VOCAL_WORD', `overall_soundscape uses vocal-adjacent word "${banned}" — describe non-verbal sound only, dialogue lives in detailed_description`, { span: banned, operation: 'substitute', hint: 'a non-vocal synonym, e.g. "hum", "rumble", "drone", or "distant traffic noise"' });
        }
    }
    // ── 8. background drift words, with allowPhrases rescue ──
    const forbidden = continuity.forbiddenWords ?? [];
    const allow = continuity.allowPhrases ?? [];
    if (forbidden.length) {
        for (const field of [['detailedDescription', prose], ['overallSoundscape', soundscape], ['summary', String(prompt.summary ?? '')]]) {
            const hits = forbiddenWordHits(field[1], forbidden, allow);
            for (const w of hits) {
                fail('FORBIDDEN_WORD', `${field[0]} names forbidden set-drift word "${w}"`, {
                    span: w,
                    operation: 'delete',
                    hint: allow.length ? `remove it, or reframe using one of the approved phrases: ${allow.join(', ')}` : 'remove it — the reference plate does not show this',
                });
            }
        }
    }
    // ── 9a. sentinel — non_diegetic_music must be exactly N/A (never a denial) ──
    const music = String(prompt.nonDiegeticMusic ?? '').trim();
    if (music !== 'N/A') {
        fail('MUSIC_SENTINEL_VIOLATED', `non_diegetic_music must be the literal sentinel "N/A" to suppress music; got ${JSON.stringify(music)}. Naming the absence of music ("no score", "silence") still instructs H3 to produce it.`, { span: music, operation: 'substitute', hint: 'N/A' });
    }
    // ── 9b. format: [task type] prefix on summary ──
    const summary = String(prompt.summary ?? '');
    if (!/^\[[^\]]+\]/.test(summary.trim())) {
        fail('SUMMARY_MISSING_TASK_PREFIX', 'summary must open with a square-bracketed task-type prefix, e.g. "[reference generation]"', { operation: 'insert', hint: '"[reference generation] " prepended to the start of summary' });
    }
    // ── 9c. format: [Shot 1] carries no timestamp; later cuts strictly increasing and in-bounds ──
    const cuts = extractCuts(prose);
    if (!cuts.length) {
        fail('NO_SHOT_MARKER', 'detailedDescription has no [Shot N] marker at all');
    }
    else {
        const first = cuts[0];
        if (first.shotNumber === 1 && first.atSeconds !== null) {
            fail('SHOT_ONE_HAS_TIMESTAMP', '[Shot 1] must carry no timestamp — a timed [Shot 1] fights the render runner\'s own untimed first cut');
        }
        let prevTime = -1;
        for (let i = 1; i < cuts.length; i++) {
            const c = cuts[i];
            if (c.atSeconds === null) {
                fail('CUT_MISSING_TIMESTAMP', `[Shot ${c.shotNumber}] (cut #${i + 1}) has no "At MM:SS" timestamp`);
                continue;
            }
            if (c.atSeconds <= prevTime) {
                fail('CUT_TIME_NOT_INCREASING', `[Shot ${c.shotNumber}] at ${c.atSeconds}s does not strictly increase over the previous cut at ${prevTime}s`);
            }
            if (c.atSeconds > (prompt.duration ?? Infinity)) {
                fail('CUT_TIME_OUT_OF_BOUNDS', `[Shot ${c.shotNumber}] at ${c.atSeconds}s exceeds the shot's declared duration ${prompt.duration}s`);
            }
            prevTime = c.atSeconds;
        }
    }
    // ── 9d. frame grid ──
    const duration = Number(prompt.duration);
    if (!Number.isFinite(duration) || duration <= 0) {
        fail('DURATION_INVALID', `duration must be a positive number of seconds, got ${JSON.stringify(prompt.duration)}`);
    }
    else {
        const frames = secondsToFrames(duration);
        if (!onGrid(frames)) {
            // Never suggest a duration shorter than the last declared cut.
            const lastCut = cuts.reduce((m, c) => (c.atSeconds !== null && c.atSeconds > m ? c.atSeconds : m), 0);
            const nearest = nearestGridSeconds(duration, 24, lastCut > 0 ? lastCut : undefined);
            fail('OFF_GRID_DURATION', `duration ${duration}s → ${frames} frames is not on H3's 17k+5 grid; the renderer will snap it UP and desynchronise every [Shot N] timecode this prompt declares`, { span: String(prompt.duration), operation: 'substitute', hint: String(nearest) });
        }
    }
    // ── 9e. word floor: the official guide's own 350-500 word generation-task
    // range, not a bundle-invented number -- "measured outputs land near 200
    // and that is too thin." max(350, 120×cuts) so a shot with many internal
    // cuts still gets more than the flat floor when it genuinely needs it. ──
    const cutCount = Math.max(1, cuts.length);
    const floor = Math.max(350, 120 * cutCount);
    const words = wordCount(prose);
    if (words < floor) {
        fail('DETAILED_DESCRIPTION_TOO_SHORT', `detailed_description is ${words} words, below the floor of max(350, 120×cuts)=${floor} for ${cutCount} cut(s) -- the official H3 guide's own generation-task range is 350-500 words`, { operation: 'expand', hint: `add at least ${floor - words} more words. Do not pad — deepen 2-3 of the seven categories the guide names (composition/framing, subject appearance+position, environment/light, the action as a state change, camera motion, the sound in that moment, where each reference takes effect) with a genuine second sentence each` });
    }
    // ── official rule: controlled camera-motion vocabulary, at least one
    // term per [Shot N] -- "in a static medium shot" does NOT register. ──
    for (const segment of segmentByShotMarker(prose)) {
        if (!hasCameraVocabulary(segment.text)) {
            fail('CAMERA_MOTION_MISSING', `[Shot ${segment.shotNumber}] uses no controlled camera-motion term (${CAMERA_VOCABULARY.join(', ')}) -- a paraphrase like "in a static medium shot" does not register as one of these`, { operation: 'insert', hint: `one exact term verbatim inside [Shot ${segment.shotNumber}]'s own text, e.g. "${CAMERA_VOCABULARY[segment.shotNumber % CAMERA_VOCABULARY.length]}"` });
        }
    }
    // ── blocking / eyeline — ported from ~/Projects/h3-shots/submit.mjs
    // audit() check 5, the one check in the probe's 32-check union this
    // runner was missing. A single or an OTS framing must restate WHERE the
    // framed subject is blocked (LEFT/RIGHT half or frame left/right) and, for
    // a true single (not an OTS — both people are in frame there), which
    // off-frame direction they are looking (off-frame LEFT/RIGHT). A shot that
    // states neither lets H3 re-invent the geography shot-to-shot — measured
    // on the probe as a body swap and a 90-degree axis flip across two takes
    // of the same scene. Direct-address shots are exempt (no eyeline to fix).
    const seatNoun = continuity.staging?.seatNoun ?? 'seat';
    for (const hit of checkBlockingAndEyeline(prose, continuity.directAddressPhrases)) {
        if (hit.kind === 'BLOCKING_NOT_STATED') {
            fail('BLOCKING_NOT_STATED', `[Shot ${hit.shotNumber}] frames one person (or an over-the-shoulder) but never says where on the ${seatNoun} they are — needs "LEFT/RIGHT half" or "frame left/right"`, { operation: 'insert', hint: `"LEFT half" / "RIGHT half" or "frame left" / "frame right" naming where the framed subject is positioned, inside [Shot ${hit.shotNumber}]'s own text` });
        }
        else {
            fail('EYELINE_NOT_STATED', `[Shot ${hit.shotNumber}] is a single but never states the eyeline direction (needs "off-frame LEFT" or "off-frame RIGHT")`, { operation: 'insert', hint: `"off-frame LEFT" or "off-frame RIGHT" stating which direction this subject is looking, inside [Shot ${hit.shotNumber}]'s own text` });
        }
    }
    // ── GAP 2 (v0.2.0): performanceBeats — the acting layer. Structural checks
    // only: whether the beat's TEXT actually shaped detailedDescription's prose
    // is not deterministically checkable (illustrated_story_h3's own compiler
    // "does not paste entire master profiles verbatim", so there is no fixed
    // string to look for). What IS checkable and meaningful: every character
    // physically in the shot has a beat, every beat points at a real character
    // reference, and that character is actually written into the prose. ──
    const beats = Array.isArray(prompt.performanceBeats) ? prompt.performanceBeats : [];
    const characterRefs = (prompt.references ?? []).filter((r) => r.type === 'character');
    const characterIds = new Set(characterRefs.map((r) => r.id));
    const beatIds = new Set(beats.map((b) => b.subjectId));
    for (const beat of beats) {
        if (!characterIds.has(beat.subjectId)) {
            fail('PERFORMANCE_BEAT_UNKNOWN_SUBJECT', `performanceBeats cites subjectId "${beat.subjectId}", which is not a references[] entry of type "character" in this shot`);
            continue;
        }
        const idx = prompt.references.findIndex((r) => r.id === beat.subjectId);
        const subjectTag = `<Subject ${idx + 1}>`;
        if (!prose.includes(subjectTag)) {
            // Carry a MECHANICAL operation + hint so h3.repair_shot can actually
            // fix this rather than re-rolling the prose. Measured 2026-09-02: the
            // authoring model returned a detailedDescription with ZERO <Subject N>
            // tokens, and repair exhausted because the finding named the defect
            // without naming the edit that clears it.
            fail('PERFORMANCE_BEAT_SUBJECT_NOT_IN_PROSE', `performanceBeats gives "${beat.subjectId}" a beat, but ${subjectTag} never appears in detailedDescription — the acting direction never reached the shot`, {
                operation: 'substitute',
                hint: `In detailedDescription, replace the noun phrase that refers to this character with the literal token ${subjectTag} ` +
                    `on its FIRST mention in each [Shot N] block (e.g. "the keeper polishes the lens" -> "${subjectTag} polishes the lens"). ` +
                    `${subjectTag} is this character's label because "${beat.subjectId}" sits at that 1-based position in references[]. ` +
                    `Keep every later mention in the same sentence as a pronoun, and never place another character's Subject token in a ` +
                    `sentence that ends in a <d> tag. Do not rewrite the prose otherwise — this is a token substitution, not a rewrite.`,
            });
        }
    }
    for (const ref of characterRefs) {
        if (!beatIds.has(ref.id)) {
            fail('PERFORMANCE_BEAT_MISSING_FOR_CHARACTER', `references[] includes character "${ref.id}" but performanceBeats has no entry for it — every character physically in the shot needs acting direction`);
        }
    }
    return { ok: findings.length === 0, findings, speakerAssignments };
}
export const auditShotRunner = {
    describe: () => ({
        id: 'h3.audit_shot',
        displayName: 'H3 shot audit (deterministic, blocking)',
        description: 'Layer 1: per-shot dialogue byte-match against the ledger, speaker attribution, native script, speech-without-words, soundscape vocal-free, no authored <Picture N>, forbidden-word sweep, music sentinel, format/frame-grid. Zero LLM calls. ok:false BLOCKS the run.',
        capabilities: ['audit.deterministic', 'audit.dialogue_bytematch'],
        modalities: { input: ['text'], output: ['text'] },
        configSchema: {
            type: 'object',
            required: ['promptInput', 'breakdownInput', 'ledgerInput', 'continuityInput', 'outputPath'],
            properties: {
                promptInput: { type: 'string', description: "Input id of this shot's authored prompt JSON (summary/detailedDescription/overallSoundscape/nonDiegeticMusic/references/duration)." },
                breakdownInput: { type: 'string', description: "Input id of this shot's breakdown descriptor ({ id, lineIds, refs }), matching scope." },
                ledgerInput: { type: 'string', description: 'Input id of the full dialogue ledger array ({ id, speaker, language?, text }[]) — the ledger of record.' },
                continuityInput: { type: 'string', description: 'Input id of the prepared continuity.json (language, scriptRange, cast, forbiddenWords, allowPhrases).' },
                outputPath: { type: 'string', description: 'Where to write { ok, findings } — relative to the project dir.' },
            },
        },
        costHint: 'free',
    }),
    run: async (ctx) => {
        const cfg = ctx.node.runner.config;
        const promptRaw = readJson(ctx, rs(cfg, 'promptInput'));
        const breakdownDoc = readJson(ctx, rs(cfg, 'breakdownInput'));
        const ledger = readJson(ctx, rs(cfg, 'ledgerInput'));
        const continuity = readJson(ctx, rs(cfg, 'continuityInput'));
        const outputPath = rs(cfg, 'outputPath');
        if (!promptRaw)
            return { ok: false, error: 'h3.audit_shot: promptInput did not resolve to a JSON object' };
        if (!Array.isArray(ledger))
            return { ok: false, error: 'h3.audit_shot: ledgerInput did not resolve to an array' };
        if (!continuity)
            return { ok: false, error: 'h3.audit_shot: continuityInput did not resolve to a JSON object' };
        if (!outputPath)
            return { ok: false, error: "h3.audit_shot: config.outputPath is required" };
        const { writeFileSync, mkdirSync } = await import('node:fs');
        const { dirname, resolve } = await import('node:path');
        const abs = resolve(ctx.projectDir, outputPath);
        mkdirSync(dirname(abs), { recursive: true });
        // The scene_manifest grant. h3.repair_shot has always passed this into
        // auditShot(); h3.audit_shot did not, so the post-merge gate silently
        // skipped the plate-grant check while the bundle had been passing
        // manifestInput to it all along. A shot citing an ungranted plate passed
        // shot_audit and only failed later at render, where the error names a
        // missing image rather than an ungranted citation. (2026-09-02)
        const grantedPlateIds = grantedPlatesFrom(readJson(ctx, rs(cfg, 'manifestInput')));
        // ── h3_film v0.2.0: SCENE-BATCH mode ── promptInput is { sceneId, shots: [...] },
        // one h3.audit_shot call per SCENE (itemId=sceneId) auditing every shot in it.
        // Introduced so shot_audit can sit downstream of a scene-granular shot_repair
        // without a shotId<->sceneId itemId mismatch — see types.ts's SceneShotBatch doc.
        if (isSceneShotBatch(promptRaw)) {
            let allOk = true;
            const perShot = [];
            const allFindings = [];
            for (const shot of promptRaw.shots) {
                const breakdown = resolveBreakdownItem(breakdownDoc, shot.id);
                const { ok: shotOk, findings: rawFindings, speakerAssignments } = auditShot(shot, breakdown, ledger, continuity, grantedPlateIds);
                const findings = rawFindings.map((f) => ({ ...f, shotId: shot.id }));
                perShot.push({ shotId: shot.id, ok: shotOk, findings, speakerAssignments });
                allFindings.push(...findings);
                if (!shotOk)
                    allOk = false;
                for (const f of findings)
                    ctx.log(`h3.audit_shot[${ctx.itemId ?? '?'}:${shot.id}] ${f.code}: ${f.message}`);
            }
            writeFileSync(abs, JSON.stringify({ ok: allOk, itemId: ctx.itemId, sceneId: promptRaw.sceneId ?? ctx.itemId, perShot, findings: allFindings }, null, 2));
            if (!allOk) {
                const failed = perShot.filter((p) => !p.ok).map((p) => p.shotId);
                return {
                    ok: false,
                    error: `h3.audit_shot[${ctx.itemId ?? '?'}]: BLOCKED — ${failed.length} of ${perShot.length} shot(s) with findings: ${failed.join(', ')}`,
                };
            }
            return { ok: true, outputPath };
        }
        // ── Legacy single-shot mode (h3_shots and any other flat-shotId caller) ──
        const promptDoc = promptRaw;
        const breakdown = resolveBreakdownItem(breakdownDoc, ctx.itemId);
        const { ok, findings: rawFindings, speakerAssignments } = auditShot(promptDoc, breakdown, ledger, continuity, grantedPlateIds);
        // shotId is attached centrally, here, rather than at every fail() call
        // site — every finding this tool emits carries which shot it belongs
        // to, which is what makes a finding usable OUTSIDE this node (by
        // h3.repair_shot, by h3.audit_scene/h3.audit_film's aggregate view, by
        // a human reading plans/shot_audit/*.json without the file path).
        const findings = rawFindings.map((f) => ({ ...f, shotId: ctx.itemId }));
        writeFileSync(abs, JSON.stringify({ ok, itemId: ctx.itemId, findings, speakerAssignments }, null, 2));
        for (const f of findings)
            ctx.log(`h3.audit_shot[${ctx.itemId ?? '?'}] ${f.code}: ${f.message}`);
        if (!ok) {
            return {
                ok: false,
                error: `h3.audit_shot[${ctx.itemId ?? '?'}]: BLOCKED — ${findings.length} finding(s): ${findings.map((f) => `[${f.code}] ${f.message}`).join(' | ')}`,
            };
        }
        return { ok: true, outputPath };
    },
};
//# sourceMappingURL=auditShot.js.map