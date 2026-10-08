// E4.7 transport: E4.6's request builder (hybrid3/lib.mjs, frozen) plus
//   - decision calls (kind 'decision') think OFF by default; E4_DECISION_THINKING=off | <budget in tokens> sets it (a budget is at least 1024, ninfer's minimum):
//       ninfer-messages  "thinking": {"type": "disabled"}                      (never omit the field: without it the model thinks)
//       llama-chat       "chat_template_kwargs": {"enable_thinking": false}    (a top-level enable_thinking returned an empty message)
//       openrouter       "reasoning": {"enabled": false}                       (OpenRouter's reasoning switch; a model that cannot be switched off ignores it. Not exercised:
//                                                                              no remote model is used, only the request is checked)
//     a budget N: thinking enabled with budget_tokens N (ninfer), reasoning_budget_tokens N (llama), reasoning {max_tokens: N} (openrouter)
//   - the wire 'llama-chat' (E4_LLM_API_STYLE): llama.cpp / Strata chat completions, no key, the thinking budget as the TOP-LEVEL fields reasoning_budget_tokens and
//     reasoning_budget_message (E4_LLM_BUDGET_MESSAGE), the same per-kind budgets as ninfer-messages
//   - E4_LLM_MAX_TOKENS caps max_tokens of every call to what the server's context slot holds
// Every other call kind, on the two E4.6 wires, builds exactly the request E4.6 builds (test/e47.test.mjs and replay-check.mjs prove it).
import { API_STYLE, BASE, MODEL, buildRequest as buildRequest46, thinkBudget } from '../hybrid3/lib.mjs';

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
  const cap = Number(process.env.E4_LLM_MAX_TOKENS) || 0;
  if (cap && r.body.max_tokens > cap) r.body.max_tokens = cap;
  return r;
}
