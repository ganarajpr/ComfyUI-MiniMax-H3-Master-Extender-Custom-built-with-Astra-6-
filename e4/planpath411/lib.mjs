// E4 shared helpers: key lookup, one recorded LLM call, JSON reply parsing, small utilities.
// Every request, raw response and meta of every call made through `call()` is stored under the caller's directory,
// and one line per call is appended to <outDir>/calls.jsonl so the report can count calls by kind.
import { readFileSync, writeFileSync, mkdirSync, appendFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { SETTINGS, MODEL, BASE, API_STYLE, normalizeResponse, parseJsonReply, wr, rj } from '../hybrid3/lib.mjs';
import { buildRequest, outputRoom } from './transport.mjs';

import { repairJson } from './jsonrepair.mjs';
export { SETTINGS, MODEL, BASE, API_STYLE, parseJsonReply, wr, rj };

// parseJsonReply, then (only when it fails) the local syntax repairs of jsonrepair.mjs; `repaired` lists the fixes applied.
export function parseJsonLoose(content) {
  const p = parseJsonReply(content);
  if (p.ok) return p;
  const r = repairJson(content);
  return r.ok ? { ok: true, value: r.value, repaired: r.fixes } : p;
}
export const HERE = dirname(fileURLToPath(import.meta.url));

let env = ''; try { env = readFileSync(join(homedir(), 'Projects/dhee-core/.env'), 'utf8'); } catch { /* no .env file: a local endpoint needs no key */ }
const envKey = (name) => (env.match(new RegExp(`^${name}=(.*)$`, 'm'))?.[1] || '').trim().replace(/^"|"$/g, '');
const KEY = ['LLM_JUDGE_API_KEY', 'OPENROUTER_API_KEY', 'OPENAI_API_KEY'].map(envKey).find((k) => k.startsWith('sk-or')) || '';

// E4.11: ONE concurrency setting for every stage. E4_CONCURRENCY (default 6, at most 8) is the number of model requests in flight at any moment; every stage (planner, bible, decisions,
// writers, repairs, reference repairs) goes through the same limiter, so the total never exceeds it however many tasks are waiting. The wait for a free slot is not counted in a call's `secs`.
export const CONCURRENCY = Math.min(8, Math.max(1, Math.trunc(Number(process.env.E4_CONCURRENCY)) || 6));
const gate = { active: 0, peak: 0, waiting: [], calls: 0, seq: 0 };
export const limiterStats = () => ({ limit: CONCURRENCY, peak: gate.peak, calls: gate.calls });
// A lower priority number goes first (the staging chain of the decisions is the critical path, so it is 0; everything else is 1); equal priorities go in arrival order.
export async function withSlot(fn, priority = 1) {
  if (gate.active >= CONCURRENCY) await new Promise((resolve) => gate.waiting.push({ priority, seq: gate.seq++, resolve }));
  gate.active += 1; gate.calls += 1; gate.peak = Math.max(gate.peak, gate.active);
  try { return await fn(); } finally {
    gate.active -= 1;
    if (gate.waiting.length) { gate.waiting.sort((a, b) => a.priority - b.priority || a.seq - b.seq); gate.waiting.shift().resolve(); }
  }
}

export const DECISION_SETTINGS = { max_tokens: 16000, reasoning: { max_tokens: 4096 }, temperature: 0 };

// One chat-completions call on the normal OpenRouter endpoint with explicit settings; transient errors retried.
export async function chatWith(messages, settings = SETTINGS, opts = {}) {
  const first = await chatWithOnce(messages, settings, opts);
  const cap = first.body?.max_tokens || 0;
  if (first.finish !== 'length') return first;
  // The reply was cut at max_tokens: do not send the same request again. Send it once with a larger cap, up to the room the slot leaves (at most double).
  const limit = outputRoom(messages);
  const room = Number.isFinite(limit) ? Math.min(limit, cap * 2) : 0;
  if (!(room > cap * 1.05)) return { ...first, cut: cutOf(first) };
  const second = await chatWithOnce(messages, { ...settings, max_tokens: Math.floor(room) }, opts);
  const escalated = { from: cap, to: second.body?.max_tokens ?? Math.floor(room), firstOutputTokens: first.usage?.completion_tokens ?? null, firstThinkingTokens: thinkingOf(first) };
  return { ...second, escalated, cut: second.finish === 'length' ? cutOf(second) : null };
}
export const thinkingOf = (c) => c?.usage?.completion_tokens_details?.reasoning_tokens ?? null;
// Why a reply is unusable when the server stopped it at max_tokens: "reply cut at max_tokens 12288 (thinking 4121)".
export const cutOf = (c) => ({ max_tokens: c.body?.max_tokens ?? null, thinking: thinkingOf(c), output: c.usage?.completion_tokens ?? null });
export const cutNote = (cut) => (cut ? `reply cut at max_tokens ${cut.max_tokens}${cut.thinking != null ? ` (thinking ${cut.thinking})` : ''}` : '');
async function chatWithOnce(messages, settings = SETTINGS, { retries = 3, kind = 'writer', priority = 1 } = {}) {
  const { url, headers, body } = buildRequest(messages, settings, kind);
  let last = null;
  for (let a = 1; a <= retries; a++) {
    try {
      const t = await withSlot(async () => {
        const t0 = Date.now();
        const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body), signal: AbortSignal.timeout(900000) });
        return { res, text: await res.text(), t0 };
      }, priority);
      let resp = null; try { resp = normalizeResponse(JSON.parse(t.text)); } catch { /* raw kept */ }
      last = { body, status: t.res.status, raw: t.text, resp, secs: (Date.now() - t.t0) / 1000, t0: t.t0, attempt: a };
      if (t.res.ok && resp && !resp.error && resp.choices?.[0] && resp.choices[0].finish_reason !== 'error' && (resp.choices[0].message?.content || '').trim()) break;
    } catch (e) { last = { body, error: String(e.message || e), secs: 0, attempt: a }; }
    await new Promise((r) => setTimeout(r, 4000 * a));
  }
  const msg = last.resp?.choices?.[0]?.message || {};
  return { ...last, content: msg.content || '', usage: last.resp?.usage || {}, cost: Number(last.resp?.usage?.cost || 0), finish: last.resp?.choices?.[0]?.finish_reason || null, reasoning: msg.reasoning || msg.reasoning_content || '' };
}

// One chat call of the hybrid repair (hybrid3/lib.mjs `chat`, byte for byte, but built by the E4.7 transport so every wire works for the repairs too).
export async function chat(messages, { retries = 3 } = {}) {
  const { url, headers, body } = buildRequest(messages, SETTINGS, 'repair');
  let last = null;
  for (let a = 1; a <= retries; a++) {
    try {
      const t = await withSlot(async () => {
        const t0 = Date.now();
        const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body), signal: AbortSignal.timeout(900000) });
        return { res, text: await res.text(), t0 };
      });
      let resp = null; try { resp = normalizeResponse(JSON.parse(t.text)); } catch { /* raw kept */ }
      last = { body, status: t.res.status, raw: t.text, resp, secs: (Date.now() - t.t0) / 1000, t0: t.t0, attempt: a };
      if (t.res.ok && resp && !resp.error && resp.choices?.[0]) break;
    } catch (e) { last = { body, error: String(e.message || e), secs: 0, attempt: a }; }
    await new Promise((r) => setTimeout(r, 4000 * a));
  }
  const msg = last.resp?.choices?.[0]?.message || {};
  return { ...last, content: msg.content || '', usage: last.resp?.usage || {}, cost: Number(last.resp?.usage?.cost || 0), finish: last.resp?.choices?.[0]?.finish_reason || null, reasoning: msg.reasoning || msg.reasoning_content || '' };
}

// A recorded call. kind is one of planner | bible | decision | writer | repair; name is the file stem under dir.
export async function call({ outRoot, dir, name, kind, story, clip, messages, settings = SETTINGS, priority = 1 }) {
  const c = await chatWith(messages, settings, { kind, priority });
  wr(join(dir, `${name}.request.json`), c.body);
  wr(join(dir, `${name}.response.raw.txt`), c.raw || c.error || '');
  const meta = { kind, story, clip: clip ?? null, name, usage: c.usage, cost: c.cost, finish: c.finish, secs: c.secs, status: c.status, attempt: c.attempt, t0: c.t0 ?? null, model: c.resp?.model || null };
  if (c.cut) meta.cut = c.cut;
  if (c.escalated) meta.escalated = c.escalated;
  wr(join(dir, `${name}.meta.json`), meta);
  mkdirSync(outRoot, { recursive: true });
  appendFileSync(join(outRoot, 'calls.jsonl'), `${JSON.stringify(meta)}\n`);
  return c;
}

export const exists = (p) => existsSync(p);
export const tokensOf = (s, min = 3) => (String(s || '').toLowerCase().match(/[a-z\u00c0-\u024f\u0900-\u097f]+/g) || []).filter((w) => w.length >= min);
export const slug = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'x';
export const humanId = (id) => String(id).replace(/_/g, ' ');

// Grid duration: the least 17k+5 frame count at 24 fps that is at least the planned seconds (H3's legal durations).
export function gridSeconds(seconds, fps = 24) {
  let k = 7;
  while (17 * k + 5 < Math.ceil(seconds * fps - 1e-9)) k += 1;
  return Number(((17 * k + 5) / fps).toFixed(2));
}
export const fmtTime = (s) => `${String(Math.floor(s / 60)).padStart(2, '0')}:${(s % 60).toFixed(3).padStart(6, '0')}`;
