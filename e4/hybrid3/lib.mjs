// Shared helpers for the hybrid writer: fixture loading, GLM transport, sentence handling.
import { readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { homedir } from 'node:os';
import { loadFixture } from '../templater/load.mjs';

export const MODEL = process.env.E4_LLM_MODEL || 'z-ai/glm-5.3-flash';
export const BASE = process.env.E4_LLM_URL || 'https://openrouter.ai/api/v1';
export const API_STYLE = process.env.E4_LLM_API_STYLE || 'openrouter';
export const SETTINGS = { max_tokens: 32000, reasoning: { max_tokens: 4096 }, temperature: 0.5 };

let env = ''; try { env = readFileSync(join(homedir(), 'Projects/dhee-core/.env'), 'utf8'); } catch { /* no .env file: a local endpoint needs no key */ }
const envKey = (name) => (env.match(new RegExp(`^${name}=(.*)$`, 'm'))?.[1] || '').trim().replace(/^"|"$/g, '');
const KEY = ['LLM_JUDGE_API_KEY', 'OPENROUTER_API_KEY', 'OPENAI_API_KEY'].map(envKey).find((k) => k.startsWith('sk-or')) || '';
export const wr = (p, d) => { mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, typeof d === 'string' ? d : JSON.stringify(d, null, 2)); };
export const rj = (p) => JSON.parse(readFileSync(p, 'utf8'));

export function loadFix(fixtureDir) {
  const root = resolve(fixtureDir), proj = join(root, 'project');
  const refFile = readdirSync(join(proj, 'prompts/shot_references')).filter((f) => f.endsWith('.json')).sort()[0];
  const refs = rj(join(proj, 'prompts/shot_references', refFile));
  return {
    root, proj, film: loadFixture(root), refs,
    ledger: rj(join(proj, 'plans/dialogue_ledger.json')), continuity: rj(join(proj, 'plans/continuity.json')),
    split: rj(join(proj, 'plans/scene_split.json')),
    granted: new Set((rj(join(proj, `plans/scene_manifest/${refs.sceneId}.json`)).references || []).map((r) => r.id)),
  };
}


// The transport layer. Style 'openrouter' (the default) is the normal OpenRouter chat-completions request with the
// key; style 'ninfer-messages' is the Anthropic-style /v1/messages endpoint of the local ninfer lane (no key), where
// thinking.budget_tokens is a real per-request cap. The reply is always normalised to the chat-completions shape.
export const thinkBudget = (kind, settings) => Math.max(1024, Number(process.env[`E4_LLM_BUDGET_${String(kind || '').toUpperCase()}`] || process.env.E4_LLM_BUDGET || settings.reasoning?.max_tokens || 4096));
export function buildRequest(messages, settings, kind) {
  if (API_STYLE === 'openrouter') return { url: `${BASE}/chat/completions`, headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' }, body: { model: MODEL, messages, ...settings } };
  if (API_STYLE !== 'ninfer-messages') throw new Error(`E4_LLM_API_STYLE must be openrouter or ninfer-messages, got ${API_STYLE}`);
  const system = messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n\n');
  const body = { model: MODEL, max_tokens: settings.max_tokens, temperature: settings.temperature, thinking: { type: 'enabled', budget_tokens: thinkBudget(kind, settings) }, messages: messages.filter((m) => m.role !== 'system') };
  if (system) body.system = system;
  return { url: `${BASE}/v1/messages`, headers: { 'Content-Type': 'application/json', 'anthropic-version': '2023-06-01' }, body };
}
export function normalizeResponse(resp) {
  if (API_STYLE !== 'ninfer-messages' || !resp || !Array.isArray(resp.content)) return resp;
  const text = resp.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
  const thinking = resp.content.filter((b) => b.type === 'thinking').map((b) => b.thinking).join('');
  const u = resp.usage || {};
  return { id: resp.id, model: resp.model, choices: [{ index: 0, finish_reason: resp.stop_reason === 'max_tokens' ? 'length' : 'stop', message: { role: 'assistant', content: text, reasoning: thinking } }], usage: { prompt_tokens: u.input_tokens, completion_tokens: u.output_tokens, completion_tokens_details: { reasoning_tokens: u.output_tokens_details?.thinking_tokens ?? null }, cost: 0 } };
}

// One chat-completions call (the normal OpenRouter endpoint), transient errors retried; returns everything.
export async function chat(messages, { retries = 3 } = {}) {
  const { url, headers, body } = buildRequest(messages, SETTINGS, 'repair');
  let last = null;
  for (let a = 1; a <= retries; a++) {
    const t0 = Date.now();
    try {
      const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body), signal: AbortSignal.timeout(900000) });
      const text = await res.text();
      let resp = null; try { resp = normalizeResponse(JSON.parse(text)); } catch { /* raw kept */ }
      last = { body, status: res.status, raw: text, resp, secs: (Date.now() - t0) / 1000, attempt: a };
      if (res.ok && resp && !resp.error && resp.choices?.[0]) break;
    } catch (e) { last = { body, error: String(e.message || e), secs: (Date.now() - t0) / 1000, attempt: a }; }
    await new Promise((r) => setTimeout(r, 4000 * a));
  }
  const msg = last.resp?.choices?.[0]?.message || {};
  return { ...last, content: msg.content || '', usage: last.resp?.usage || {}, cost: Number(last.resp?.usage?.cost || 0), finish: last.resp?.choices?.[0]?.finish_reason || null, reasoning: msg.reasoning || msg.reasoning_content || '' };
}

// JSON out of a model reply: fences stripped, trailing prose after the object ignored (like the pipeline's tryParseJson).
export function parseJsonReply(content) {
  let s = String(content || '').trim().replace(/^```[a-z]*\s*/i, '').replace(/```\s*$/, '').trim();
  s = s.slice(Math.max(0, s.indexOf('{')));
  try { return { ok: true, value: JSON.parse(s) }; } catch (err) {
    const m = /position (\d+)/.exec(err.message);
    if (m) { try { return { ok: true, value: JSON.parse(s.slice(0, Number(m[1]))), trailing: s.slice(Number(m[1])).trim().slice(0, 200) }; } catch { /* fall through */ } }
    return { ok: false, error: String(err.message) };
  }
}

// Sentences of a description, dialogue blocks kept whole.
export function sentences(text) {
  const keep = [];
  const prot = String(text || '').replace(/<d>[\s\S]*?<\/d>/g, (m) => { keep.push(m); return `\u0000${keep.length - 1}\u0000`; });
  return prot.split(/(?<=[.!?])\s+(?=[A-Z<\["\u0000])/).map((s) => s.replace(/\u0000(\d+)\u0000/g, (_, i) => keep[Number(i)])).filter((s) => s.length);
}
export const joinSentences = (arr) => arr.join(' ');
