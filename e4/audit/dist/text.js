/**
 * Deterministic text checks ported from ~/Projects/h3-shots/submit.mjs
 * (audit(), ~line 320) and audit_film.mjs. No LLM, no network — every
 * function here is a pure string/regex check so the gate can never flip
 * between runs and can never silently "pass by not checking" (see
 * h3-shots skill: "'could not check' must never render as 'checked and
 * fine'").
 */
/** NFC + collapse whitespace + trim. The exact normalisation submit.mjs
 * applies before comparing a <d> tag to its ledger line. */
export function normalizeText(s) {
    return s.normalize('NFC').replace(/\s+/g, ' ').trim();
}
const DIALOGUE_TAG_RE = /<d>\[([^\]]+)\]\s*([\s\S]*?)\s*<\/d>/g;
/** Every `<d>[Language] words</d>` tag, in document order. */
export function extractDialogueTags(prose) {
    const out = [];
    let m;
    DIALOGUE_TAG_RE.lastIndex = 0;
    while ((m = DIALOGUE_TAG_RE.exec(prose))) {
        out.push({ language: m[1].trim(), text: m[2], index: m.index, raw: m[0] });
    }
    return out;
}
/** Literal `<Picture N>` reference-binding clause — must never appear in
 * AUTHORED prose. The render runner (comfy.minimax_h3_r2v, bindingClause:
 * true) builds this deterministically from the resolved reference order,
 * which the authoring model cannot know in advance. */
export function containsPictureBinding(prose) {
    return /<Picture\s+\d+>/i.test(prose);
}
/** Nearest preceding `(S<n>)` speaker marker and `<Subject k>` before a
 * given character offset, within a bounded lookback window. Mirrors
 * submit.mjs's attribution gate: a <d> tag binds to the nearest PRECEDING
 * (SN), which must be the ledger's speaker for that line. */
export function precedingSpeaker(prose, beforeIndex, lookback = 400) {
    const window = prose.slice(Math.max(0, beforeIndex - lookback), beforeIndex);
    const sMatches = [...window.matchAll(/\(S(\d+)\)/g)];
    const subjMatches = [...window.matchAll(/<Subject\s+(\d+)>/g)];
    const speakerNum = sMatches.length ? Number(sMatches[sMatches.length - 1][1]) : null;
    const subjectNum = subjMatches.length ? Number(subjMatches[subjMatches.length - 1][1]) : null;
    return { speakerNum, subjectNum };
}
/** At least one character of `text` falls inside the inclusive Unicode
 * code-point range [loHex, hiHex]. Drives the native-script gate off
 * continuity.scriptRange as DATA, not a hardcoded per-language regex. */
export function hasNativeScript(text, range) {
    const lo = parseInt(range[0], 16);
    const hi = parseInt(range[1], 16);
    for (const ch of text) {
        const cp = ch.codePointAt(0);
        if (cp !== undefined && cp >= lo && cp <= hi)
            return true;
    }
    return false;
}
/** The machine-checkable speech vocabulary, ported verbatim from
 * submit.mjs SPEECH_VERBS — hoisted as data so an authoring brief can be
 * built FROM the same list the gate enforces. */
/**
 * Verbs that mean SPEECH and nothing else. A hit here is enough on its own.
 */
export const SPEECH_VERBS_STRONG = [
    'say', 'says', 'speak', 'speaks', 'spoke', 'answer', 'answers', 'ask', 'asks',
    'reply', 'replies', 'tell', 'tells', 'explain', 'explains',
    'mention', 'mentions', 'mentioning', 'respond', 'responds', 'utter',
    'emphasise', 'emphasizes', 'affirms', 'assures', 'declares', 'announces',
    'invites', 'urges', 'promises', 'reminds', 'voiceover',
    'call to action', 'offering no answer', 'offers no answer',
];
/**
 * Verbs that MIGHT mean speech but read perfectly innocently in visual prose:
 * "the fog adds depth", "the shot concludes on his face", "the frame
 * introduces the tower". Flagged ONLY when a speaker marker sits beside them,
 * because otherwise they are ordinary description.
 *
 * Why this split exists (measured 2026-09-02): a shot oscillated to the
 * 8-attempt repair ceiling on three findings at once, and two of them
 * contradicted each other through this list.
 * `DETAILED_DESCRIPTION_TOO_SHORT` hints "add at least N more words … deepen
 * 2-3 of the seven categories", the model duly wrote more description, and the
 * words 'add'/'adds'/'concludes' in that new prose tripped
 * `SPEECH_WITHOUT_WORDS` — which then hinted "remove the speech verb",
 * shortening the prose again. One gate's fix was the other gate's violation,
 * forever.
 */
export const SPEECH_VERBS_AMBIGUOUS = [
    'add', 'adds', 'question', 'questions', 'deliver', 'delivers',
    'introduces', 'initiates', 'concludes',
];
/**
 * The union, kept as-is so an authoring brief can still be built FROM the same
 * vocabulary the gate enforces.
 */
export const SPEECH_VERBS = [...SPEECH_VERBS_STRONG, ...SPEECH_VERBS_AMBIGUOUS];
/**
 * A speaker marker beside an ambiguous verb is what turns "adds" from
 * description into reported speech: `<Subject 2>` or an `(S3)` speaker id.
 */
const SPEAKER_MARKER_RE = /<Subject\s+\d+>|\(S\d+\)/i;
/** Rejected in overall_soundscape even in a plainly non-vocal sense. */
export const SOUNDSCAPE_BANNED = [
    'voice', 'whisper', 'whispers', 'whispered', 'murmur', 'murmurs',
    'murmured', 'shout', 'shouts', 'word', 'words',
];
/** Split into rough sentences for a bounded speech-verb lookahead. */
export function splitSentences(text) {
    return text.split(/(?<=[.!?])\s+/).filter((s) => s.trim().length > 0);
}
/**
 * Speech described with no words to speak: a SPEECH_VERBS hit with no `<d>`
 * tag opening nearby. The proximity check is a CHARACTER window anchored on
 * the verb's own position in the ORIGINAL prose (default 300 chars
 * forward), not a sentence-count lookahead — measured 2026-09-02: a
 * sentence-count window (this sentence + the next) stopped seeing a `<d>`
 * tag that opened right after the verb's own "says:" clause, in the SAME
 * sentence, whenever that tag's shape did not match a stricter pattern this
 * check used to require (`<d>\[Language\]`). The tag's own well-formedness
 * (does it carry `[Language]`, does it byte-match the ledger, …) is
 * DIALOGUE_MISMATCH/extractDialogueTags' job, not this check's — this check
 * only asks "is a `<d>` tag opening anywhere near this speech verb", so it
 * uses a loose `/<d>/` test, not the strict tag grammar.
 *
 * An article/possessive guard keeps nouns like "the question" / "the
 * answer" from false-positiving, matching submit.mjs's own guard.
 */
export function speechWithoutWords(prose, forwardWindow = 300) {
    const sentences = splitSentences(prose);
    const hits = [];
    const guardRe = /\b(the|a|an|his|her|their|its|my|your|our)\s+(question|answer|word|words)\b/i;
    // Each sentence's own start offset in the ORIGINAL prose, so the <d>
    // proximity window can be anchored on the verb's real position rather
    // than on which sentence-array slot it landed in.
    let searchFrom = 0;
    const sentenceStarts = [];
    for (const s of sentences) {
        const idx = prose.indexOf(s, searchFrom);
        const start = idx >= 0 ? idx : searchFrom;
        sentenceStarts.push(start);
        searchFrom = start + s.length;
    }
    for (let i = 0; i < sentences.length; i++) {
        const sentence = sentences[i];
        const guarded = guardRe.test(sentence);
        const lower = sentence.toLowerCase();
        // Earliest speech-verb occurrence IN THIS SENTENCE (by position, not by
        // SPEECH_VERBS list order — list order previously decided ties, which
        // never mattered while the check was sentence-scoped, but matters now
        // that the window is anchored on the verb's own character offset).
        let verbHit;
        let verbIndexInSentence = -1;
        // An ambiguous verb only counts when this sentence also carries a speaker
        // marker; a strong verb always counts.
        const hasSpeaker = SPEAKER_MARKER_RE.test(sentence);
        const candidates = hasSpeaker ? SPEECH_VERBS : SPEECH_VERBS_STRONG;
        for (const v of candidates) {
            const m = new RegExp(`\\b${escapeRegExp(v)}\\b`, 'i').exec(lower);
            if (m && (verbIndexInSentence === -1 || m.index < verbIndexInSentence)) {
                verbHit = v;
                verbIndexInSentence = m.index;
            }
        }
        if (!verbHit)
            continue;
        if (guarded && !/\boffering no answer\b|\boffers no answer\b/i.test(lower))
            continue;
        const verbEndInProse = sentenceStarts[i] + verbIndexInSentence + verbHit.length;
        const window = prose.slice(verbEndInProse, verbEndInProse + forwardWindow);
        if (!/<d>/.test(window)) {
            hits.push(`"${sentence.trim()}" (matched verb: ${verbHit})`);
        }
    }
    return hits;
}
/** H3's legal clip lengths are 17k+5 frames at 24fps. */
export function onGrid(frames) {
    return frames >= 124 && (frames - 5) % 17 === 0;
}
export function secondsToFrames(seconds, fps = 24) {
    return Math.round(seconds * fps);
}
/** The nearest legal H3 duration (17k+5 frames at 24fps, k>=7 i.e. >=5s),
 * rounded to 3 decimals — for OFF_GRID_DURATION's repair hint. Searches
 * both directions from the requested value and picks whichever grid point
 * is closer, so a repair model gets a single concrete number to substitute
 * rather than having to compute the grid itself. */
export function nearestGridSeconds(seconds, fps = 24, minSeconds) {
    const targetFrames = seconds * fps;
    // A grid point BELOW the last declared cut would make OFF_GRID_DURATION's own
    // hint trip CUT_TIME_OUT_OF_BOUNDS: substitute the shorter duration and a cut
    // that was in bounds is suddenly past the end. One gate's fix becomes
    // another's violation — the same shape as the SPEECH_WITHOUT_WORDS pair that
    // cost 246 repair attempts (2026-09-02).
    //
    // It also matches what the message promises: the renderer "will snap it UP",
    // so a hint that rounds DOWN contradicts the explanation beside it.
    const floorFrames = minSeconds !== undefined ? Math.ceil(minSeconds * fps) : 0;
    let best;
    let bestDelta = Infinity;
    for (let frames = 124; frames <= 481; frames += 17) {
        if (frames < floorFrames)
            continue;
        const delta = Math.abs(targetFrames - frames);
        if (delta < bestDelta) {
            best = frames;
            bestDelta = delta;
        }
    }
    // Nothing on the grid clears the floor — the cuts themselves are the problem,
    // not the duration, so hand back the longest legal clip and let the cut
    // checks report it.
    const chosen = best ?? 481;
    return Math.round((chosen / fps) * 1000) / 1000;
}
const CUT_RE = /\[Shot\s+(\d+)\](?:\s+At\s+(\d{1,2}):(\d{2}(?:\.\d+)?))?/g;
/** Every `[Shot N]` / `[Shot N] At MM:SS.mmm` marker, in document order. */
export function extractCuts(prose) {
    const out = [];
    let m;
    CUT_RE.lastIndex = 0;
    while ((m = CUT_RE.exec(prose))) {
        const shotNumber = Number(m[1]);
        const atSeconds = m[2] !== undefined ? Number(m[2]) * 60 + Number(m[3]) : null;
        out.push({ shotNumber, atSeconds, index: m.index });
    }
    return out;
}
/** Word count, for the `max(150, 120 × cuts)` floor. */
export function wordCount(text) {
    return text.trim().split(/\s+/).filter(Boolean).length;
}
/** A forbidden word/phrase sweep with an allow-phrase rescue: a hit is
 * dropped when it sits inside (or adjacent to, word-boundary-safe) an
 * approved phrase from continuity.allowPhrases. */
export function forbiddenWordHits(text, forbidden, allowPhrases) {
    const hits = [];
    const lower = text.toLowerCase();
    for (const word of forbidden) {
        const re = new RegExp(`\\b${escapeRegExp(word.toLowerCase())}\\b`, 'g');
        let m;
        while ((m = re.exec(lower))) {
            const start = Math.max(0, m.index - 40);
            const end = Math.min(lower.length, m.index + word.length + 40);
            const context = lower.slice(start, end);
            const rescued = allowPhrases.some((p) => context.includes(p.toLowerCase()));
            if (!rescued)
                hits.push(word);
        }
    }
    return [...new Set(hits)];
}
function escapeRegExp(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
/**
 * H3's controlled camera-motion vocabulary, verbatim from the official guide
 * (h3-prompting skill / MiniMax's own docs). "in a static medium shot" does
 * NOT register as `Static Shot` — only these exact phrases count, matched as
 * natural English inside the shot, never a synonym or a paraphrase.
 */
export const CAMERA_VOCABULARY = [
    'zoom in', 'zoom out', 'push in', 'pull out', 'pan left', 'pan right',
    'truck left', 'truck right', 'tilt up', 'tilt down', 'pedestal up', 'pedestal down',
    'arc shot', 'tracking shot', 'static shot', 'shake slightly', 'shake strongly',
    'pov', 'roll clockwise', 'roll counterclockwise',
];
/** At least one of these phrases (case-insensitive) marks the shot as using
 * the controlled camera vocabulary. */
export function hasCameraVocabulary(text) {
    const lower = text.toLowerCase();
    return CAMERA_VOCABULARY.some((phrase) => new RegExp(`\\b${escapeRegExp(phrase)}\\b`, 'i').test(lower));
}
/**
 * Split prose into one chunk per `[Shot N]` marker (chunk = from this
 * marker's start to the next marker's start, or end of string). Used to
 * check a per-cut requirement (e.g. camera vocabulary) rather than a
 * whole-document one.
 */
export function segmentByShotMarker(prose) {
    const cuts = extractCuts(prose);
    if (!cuts.length)
        return [];
    return cuts.map((c, i) => {
        const end = i + 1 < cuts.length ? cuts[i + 1].index : prose.length;
        return { shotNumber: c.shotNumber, text: prose.slice(c.index, end) };
    });
}
/**
 * Closed-ish vocabulary for "vocal identity" — age, register, pace, accent —
 * that the official guide requires OUTSIDE every `<d>` tag ("or H3 picks a
 * voice at random and drifts"). A blunt string match, same design as
 * SPEECH_VERBS/SOUNDSCAPE_BANNED: it can false-negative on an unusual
 * phrasing, but it can also genuinely fire, which is the property that
 * matters for a gate.
 */
export const VOCAL_DESCRIPTOR_WORDS = [
    // register / timbre
    'low voice', 'high voice', 'warm voice', 'soft voice', 'husky', 'raspy', 'gravelly',
    'mid-register', 'low register', 'high register', 'deep voice', 'bright voice',
    'low-pitched', 'high-pitched', 'timbre', 'register',
    // pace
    'measured', 'unhurried', 'steady pace', 'quick pace', 'slow pace', 'clipped',
    'halting', 'rapid-fire', 'deliberate pace', 'even pace', 'brisk',
    // age
    'young voice', 'youthful voice', 'aged voice', 'years old', 'late twenties',
    'early thirties', 'late thirties', 'early twenties', 'middle-aged', 'elderly voice',
    // accent / origin
    'accent', 'lilt', 'drawl', 'inflection',
];
export function hasVocalDescriptor(text) {
    const lower = text.toLowerCase();
    return VOCAL_DESCRIPTOR_WORDS.some((phrase) => new RegExp(`\\b${escapeRegExp(phrase)}\\b`, 'i').test(lower));
}
/**
 * Ported from ~/Projects/h3-shots/submit.mjs `audit()` check 5 (~line 527) —
 * the ONE check in the probe's 32-check union that dhee-runner-h3-audit did
 * not yet have. Every clip is an independent generation, so staging carries
 * over only if EACH shot restates it; a single that says merely "a tight
 * medium shot on X" lets H3 re-invent the geography, and measured on the
 * probe it did: two takes swapped the men left-to-right, and one staged them
 * facing each other across a table instead of side by side on the seat.
 *
 * A SINGLE (one person the whole frame) or an over-the-shoulder needs BOTH:
 * (a) where the framed subject is blocked ("LEFT half" / "frame left"), and
 * (b) for a true single (not an OTS — both people are visible in an OTS, so
 * there is no off-frame eyeline to state), which off-frame direction they
 * are looking ("off-frame LEFT" / "off-frame RIGHT"). Direct-address shots
 * (looking down the lens) are exempt — there is no eyeline to fix.
 */
export const SINGLE_FRAMING_RE = /\b(single on|close-up on|tight on|medium on)\b/i;
export const OVER_THE_SHOULDER_RE = /\bover[- ]the[- ]shoulder\b/i;
export function isBlockingPlaced(text) {
    return /(LEFT|RIGHT) half/.test(text) || /\bframe (left|right)\b/i.test(text);
}
export function isEyelineStated(text) {
    return /off-frame (LEFT|RIGHT)/.test(text);
}
const DEFAULT_DIRECT_ADDRESS_PHRASES = [
    'down the lens', 'into the lens', 'straight at the camera', 'square-on to the camera',
];
/**
 * Scans each `[Shot N]` segment (first 600 chars, matching the probe's own
 * bounded head window) for a SINGLE or OTS framing cue, and — when found —
 * requires the blocking (and, for a true single, the eyeline) to be stated.
 * A direct-address shot is skipped entirely (no eyeline to fix).
 */
export function checkBlockingAndEyeline(prose, directAddressPhrases) {
    const out = [];
    const direct = (directAddressPhrases?.length ? directAddressPhrases : DEFAULT_DIRECT_ADDRESS_PHRASES)
        .map((p) => escapeRegExp(p))
        .join('|');
    const directRe = new RegExp(direct, 'i');
    for (const segment of segmentByShotMarker(prose)) {
        const head = segment.text.slice(0, 600);
        const framingWindow = head.slice(0, 240);
        const isSingle = SINGLE_FRAMING_RE.test(framingWindow);
        const isOts = OVER_THE_SHOULDER_RE.test(framingWindow);
        if (!isSingle && !isOts)
            continue;
        if (directRe.test(head))
            continue;
        if (!isBlockingPlaced(head))
            out.push({ shotNumber: segment.shotNumber, kind: 'BLOCKING_NOT_STATED' });
        if (isSingle && !isEyelineStated(head))
            out.push({ shotNumber: segment.shotNumber, kind: 'EYELINE_NOT_STATED' });
    }
    return out;
}
//# sourceMappingURL=text.js.map