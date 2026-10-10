// Jev (TypeSafe System One decision model) client with a disk cache and a
// hard budget. The ONLY network call the templater is allowed to make.
//   POST https://openrouter.ai/api/alpha/decisions
//   { state, model: '~typesafe/jev-latest', questions: { id: { type, instructions, criteria? } } }
// Key: LLM_JUDGE_API_KEY (env, else ~/Projects/dhee-core/.env). Never logged.

import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';

export const JEV_URL = 'https://openrouter.ai/api/alpha/decisions';
export const JEV_MODEL = '~typesafe/jev-latest';

export function loadKey() {
  if (process.env.LLM_JUDGE_API_KEY) return process.env.LLM_JUDGE_API_KEY;
  const env = readFileSync(join(homedir(), 'Projects/dhee-core/.env'), 'utf8');
  const m = env.match(/^LLM_JUDGE_API_KEY=(.*)$/m);
  if (!m) throw new Error('LLM_JUDGE_API_KEY not found');
  const key = m[1].trim().replace(/^["']|["']$/g, '');
  if (key.startsWith('local')) throw new Error('LLM_JUDGE_API_KEY is a local-gateway placeholder');
  return key;
}

export class JevClient {
  constructor({ cacheDir, maxCost = 0.2, key = null, fetchImpl = fetch } = {}) {
    this.cacheDir = cacheDir;
    this.maxCost = maxCost;
    this.key = key;
    this.fetch = fetchImpl;
    this.stats = { calls: 0, cached: 0, cost: 0, cachedCost: 0, inputTokens: 0, outputTokens: 0, secs: 0 };
    mkdirSync(cacheDir, { recursive: true });
    this.priorSpend = cumulativeCost(cacheDir).usd;
  }

  cachePath(body) {
    return join(this.cacheDir, `${createHash('sha256').update(JSON.stringify(body)).digest('hex')}.json`);
  }

  async ask(state, questions) {
    const body = { state, model: JEV_MODEL, questions };
    const path = this.cachePath(body);
    if (existsSync(path)) {
      this.stats.cached += 1;
      const { response } = JSON.parse(readFileSync(path, 'utf8'));
      this.stats.cachedCost += (response.usage && response.usage.cost) || 0;
      return response;
    }
    if (this.priorSpend + this.stats.cost >= this.maxCost) throw new Error(`Jev budget $${this.maxCost} exhausted`);
    if (!this.key) this.key = loadKey();
    const t0 = Date.now();
    const res = await this.fetch(JEV_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(60_000),
    });
    if (!res.ok) throw new Error(`jev ${res.status}: ${(await res.text()).slice(0, 300)}`);
    const response = await res.json();
    const secs = (Date.now() - t0) / 1000;
    const usage = response.usage || {};
    this.stats.calls += 1;
    this.stats.cost += usage.cost || 0;
    this.stats.inputTokens += usage.input_tokens || 0;
    this.stats.outputTokens += usage.output_tokens || 0;
    this.stats.secs += secs;
    writeFileSync(path, JSON.stringify({ request: body, response, secs, cachedAt: new Date().toISOString() }, null, 2));
    return response;
  }
}

// Every dollar ever spent through this cache directory (all cached responses).
export function cumulativeCost(cacheDir) {
  let total = 0;
  let n = 0;
  for (const f of readdirSync(cacheDir).filter((x) => x.endsWith('.json'))) {
    const j = JSON.parse(readFileSync(join(cacheDir, f), 'utf8'));
    total += (j.response.usage && j.response.usage.cost) || 0;
    n += 1;
  }
  return { usd: Number(total.toFixed(8)), responses: n };
}

// Top-1 / margin from a choice answer.
export function pickChoice(answer) {
  if (!answer || answer.type !== 'choice') return null;
  const entries = Object.entries(answer.probabilities || {}).sort((a, b) => b[1] - a[1]);
  if (!entries.length) return null;
  return {
    value: answer.choice,
    confidence: entries[0][1],
    margin: entries[0][1] - (entries[1] ? entries[1][1] : 0),
    runnerUp: entries[1] ? entries[1][0] : null,
  };
}
