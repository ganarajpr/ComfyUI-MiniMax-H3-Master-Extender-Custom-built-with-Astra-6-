// E4 shared helpers: key lookup, one recorded LLM call, JSON reply parsing, small utilities.
// Every request, raw response and meta of every call made through `call()` is stored under the caller's directory,
// and one line per call is appended to <outDir>/calls.jsonl so the report can count calls by kind.
import { readFileSync, writeFileSync, mkdirSync, appendFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { SETTINGS, MODEL, BASE, API_STYLE, normalizeResponse, parseJsonReply, wr, rj } from '../hybrid3/lib.mjs';
import { buildRequest } from './transport.mjs';

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

export const DECISION_SETTINGS = { max_tokens: 16000, reasoning: { max_tokens: 4096 }, temperature: 0 };

// One chat-completions call on the normal OpenRouter endpoint with explicit settings; transient errors retried.
export async function chatWith(messages, settings = SETTINGS, { retries = 3, kind = 'writer' } = {}) {
  const { url, headers, body } = buildRequest(messages, settings, kind);
  let last = null;
  for (let a = 1; a <= retries; a++) {
    const t0 = Date.now();
    try {
      const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body), signal: AbortSignal.timeout(900000) });
      const text = await res.text();
      let resp = null; try { resp = normalizeResponse(JSON.parse(text)); } catch { /* raw kept */ }
      last = { body, status: res.status, raw: text, resp, secs: (Date.now() - t0) / 1000, attempt: a };
      if (res.ok && resp && !resp.error && resp.choices?.[0] && resp.choices[0].finish_reason !== 'error' && (resp.choices[0].message?.content || '').trim()) break;
    } catch (e) { last = { body, error: String(e.message || e), secs: (Date.now() - t0) / 1000, attempt: a }; }
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

// A recorded call. kind is one of planner | bible | decision | writer | repair; name is the file stem under dir.
export async function call({ outRoot, dir, name, kind, story, clip, messages, settings = SETTINGS }) {
  const c = await chatWith(messages, settings, { kind });
  wr(join(dir, `${name}.request.json`), c.body);
  wr(join(dir, `${name}.response.raw.txt`), c.raw || c.error || '');
  const meta = { kind, story, clip: clip ?? null, name, usage: c.usage, cost: c.cost, finish: c.finish, secs: c.secs, status: c.status, attempt: c.attempt, model: c.resp?.model || null };
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
