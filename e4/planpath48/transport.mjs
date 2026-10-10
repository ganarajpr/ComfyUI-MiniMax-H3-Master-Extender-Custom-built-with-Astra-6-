// E4.7 transport: E4.6's request builder (hybrid3/lib.mjs, frozen) plus
//   - decision calls (kind 'decision') think OFF by default; E4_DECISION_THINKING=off | <budget in tokens> sets it (a budget is at least 1024, ninfer's minimum):
//       ninfer-messages  "thinking": {"type": "disabled"}                      (never omit the field: without it the model thinks)
//       llama-chat       "chat_template_kwargs": {"enable_thinking": false}    (a top-level enable_thinking returned an empty message)
//       openrouter       "reasoning": {"enabled": false}                       (OpenRouter's reasoning switch; a model that cannot be switched off ignores it. Not exercised:
//                                                                              no remote model is used, only the request is checked)
//     a budget N: thinking enabled with budget_tokens N (ninfer), reasoning_budget_tokens N (llama), reasoning {max_tokens: N} (openrouter)
//   - the wire 'llama-chat' (E4_LLM_API_STYLE): llama.cpp / Strata chat completions, no key, the thinking budget as the TOP-LEVEL fields reasoning_budget_tokens and
//     reasoning_budget_message (E4_LLM_BUDGET_MESSAGE), the same per-kind budgets as ninfer-messages
//   - E4_LLM_SLOT_CTX (the context of one server slot) caps max_tokens of every call per request: the slot minus the estimated prompt minus a margin (outputRoom), never above
//     the call's own setting and never below 4096. E4_LLM_MAX_TOKENS stays an optional hard ceiling over that.
// Every other call kind, on the two E4.6 wires, builds exactly the request E4.6 builds (test/e47.test.mjs and replay-check.mjs prove it).
import { API_STYLE, BASE, MODEL, buildRequest as buildRequest46, thinkBudget } from '../hybrid3/lib.mjs';

const MIN_OUTPUT = 4096;          // a reply always gets this much, whatever the prompt
const MARGIN = 1024;              // slack for the chat template and the estimate's error
const IMAGE_TOKENS = 1100;        // a reference picture is sent at most 1,024 tokens
const LATIN_CHARS_PER_TOKEN = 2.5; // English is nearer 4; this over-counts on purpose

// Conservative prompt size in tokens: Latin text at 2.5 characters a token, every character outside Latin (Devanagari, Kannada, CJK ...) at one token, a picture at 1100.
export function estimatePromptTokens(messages) {
  let latin = 0, wide = 0, images = 0;
  const count = (text) => { for (const ch of String(text ?? '')) { if (ch.codePointAt(0) < 0x250) latin += 1; else wide += 1; } };
  for (const m of messages || []) {
    if (typeof m.content === 'string') count(m.content);
    else for (const part of m.content || []) {
      if (part.type === 'text') count(part.text);
      else if (part.type === 'image' || part.type === 'image_url') images += 1;
      else count(JSON.stringify(part));
    }
    latin += 10;
  }
  return Math.ceil(latin / LATIN_CHARS_PER_TOKEN + wide + images * IMAGE_TOKENS);
}

// The most a reply to these messages may use: the slot (E4_LLM_SLOT_CTX) minus the prompt minus a margin, under the optional hard ceiling E4_LLM_MAX_TOKENS.
// Infinity when neither is set.
export function outputRoom(messages) {
  const slot = Number(process.env.E4_LLM_SLOT_CTX) || 0, hard = Number(process.env.E4_LLM_MAX_TOKENS) || 0;
  let room = Infinity;
  if (slot) { const prompt = estimatePromptTokens(messages); room = Math.max(MIN_OUTPUT, slot - Math.ceil(prompt * 1.05) - MARGIN); }
  if (hard) room = Math.min(room, hard);
  return room;
}

// The max_tokens of a call: its own setting, lowered to the room the prompt leaves.
export const outputCap = (messages, requested) => Math.min(requested, outputRoom(messages));

export const DEFAULT_BUDGET_MESSAGE = 'Time to stop thinking. Give the final answer now.';

// 0 = thinking off, else the budget in tokens.
export function decisionThinking() {
  const v = String(process.env.E4_DECISION_THINKING ?? 'off').trim().toLowerCase();
  if (['', 'off', '0', 'false', 'none'].includes(v)) return 0;
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) throw new Error(`E4_DECISION_THINKING must be off or a thinking budget in tokens, got "${v}"`);
  return Math.max(1024, Math.trunc(n));
}

export function buildRequest(messages, settings, kind) {
  const think = kind === 'decision' ? decisionThinking() : null;
  let r;
  if (API_STYLE === 'llama-chat') {
    r = { url: `${BASE}/v1/chat/completions`, headers: { 'Content-Type': 'application/json' }, body: { model: MODEL, messages, max_tokens: settings.max_tokens, temperature: settings.temperature } };
    if (think === 0) r.body.chat_template_kwargs = { enable_thinking: false };
    else { r.body.reasoning_budget_tokens = think ?? thinkBudget(kind, settings); r.body.reasoning_budget_message = process.env.E4_LLM_BUDGET_MESSAGE || DEFAULT_BUDGET_MESSAGE; }
  } else {
    r = buildRequest46(messages, settings, kind);
    if (kind === 'decision') {
      if (API_STYLE === 'ninfer-messages') r.body.thinking = think === 0 ? { type: 'disabled' } : { type: 'enabled', budget_tokens: think };
      else if (API_STYLE === 'openrouter') r.body.reasoning = think === 0 ? { enabled: false } : { max_tokens: think };
    }
  }
  if (r.body.max_tokens > 0) r.body.max_tokens = outputCap(messages, r.body.max_tokens);
  return r;
}
