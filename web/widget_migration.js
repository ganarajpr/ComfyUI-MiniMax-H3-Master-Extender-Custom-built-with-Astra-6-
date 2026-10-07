// Saved-workflow migrations for the Master node's rewriter widgets.

const CAPTION_LENGTHS = ["brief", "standard", "detailed"];
const REASONING_BUDGETS = [1024, 2048, 4096];

// rewrite_caption_model sat right after rewrite_writer_model and has been merged into it. A workflow saved before
// that carries one extra value there, which shifts every later widget by one. The old layout is recognised by the
// caption length (a short fixed list) sitting two slots after the writer instead of one.
// Returns the corrected values, or null when the array is already in the current layout.
export function dropCaptionModelValue(names, values) {
    if (!Array.isArray(values)) return null;
    const writer = names.indexOf("rewrite_writer_model");
    if (writer < 0 || names[writer + 1] !== "rewrite_caption_length") return null;
    if (CAPTION_LENGTHS.includes(values[writer + 1]) || !CAPTION_LENGTHS.includes(values[writer + 2])) return null;
    return values.filter((_, i) => i !== writer + 1);
}

// single_text_encode (a BOOLEAN between audio_refine_cache and final_decode) was removed: one text-encoder pass per
// clip is now always on. A workflow saved before that carries one extra boolean there, shifting every later widget.
// Returns the corrected values, or null when the array is already in the current layout.
export function dropSingleTextEncodeValue(names, values) {
    if (!Array.isArray(values)) return null;
    const cache = names.indexOf("audio_refine_cache");
    if (cache < 0 || names[cache + 1] !== "final_decode") return null;
    if (typeof values[cache + 1] !== "boolean" || typeof values[cache + 2] !== "string") return null;
    return values.filter((_, i) => i !== cache + 1);
}

// rewrite_reasoning_budget was an INT (-1..32768) and is now a 1024 / 2048 / 4096 dropdown of strings.
// Same mapping as prompt_rewriter.reasoning_budget: nearest allowed value, -1 / 0 / junk -> 4096.
export function normalizeReasoningBudget(value) {
    const n = Math.trunc(Number(value));
    if (!Number.isFinite(n) || n <= 0) return String(REASONING_BUDGETS[REASONING_BUDGETS.length - 1]);
    let best = REASONING_BUDGETS[0];
    for (const b of REASONING_BUDGETS) if (Math.abs(b - n) <= Math.abs(best - n)) best = b;
    return String(best);
}
