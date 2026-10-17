// The patches that sit on the vendored E4.11.1 (planpath411): a cut reply is resent larger and says why, the planner and bible ask for shorter values, and the bridge's context
// helpers read the engine named by E4_PLANPATH. Run: node --test e4/bridge/test/engine411.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { planStory, PlanError } from '../../planpath411/planner.mjs';
import { makeBible } from '../../planpath411/bible.mjs';

const run = promisify(execFile);
const here = (rel) => new URL(rel, import.meta.url).href;

async function cutScenario(cutBelow, settings = { max_tokens: 6000, reasoning: { max_tokens: 4096 }, temperature: 0 }) {
  const seen = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const b = JSON.parse(body);
      seen.push(b.max_tokens);
      const cut = b.max_tokens < cutBelow;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ content: [{ type: 'thinking', thinking: 't' }, { type: 'text', text: cut ? '{"a": [' : '{"a": []}' }], stop_reason: cut ? 'max_tokens' : 'end_turn', usage: { input_tokens: 900, output_tokens: b.max_tokens, output_tokens_details: { thinking_tokens: 4121 } } }));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    const code = `import { chatWith, cutNote } from ${JSON.stringify(here('../../planpath411/lib.mjs'))};
      const c = await chatWith([{ role: 'user', content: 'hello' }], ${JSON.stringify(settings)}, { kind: 'planner' });
      console.log(JSON.stringify({ finish: c.finish, content: c.content, cut: c.cut, escalated: c.escalated, note: cutNote(c.cut) }));`;
    const { stdout } = await run(process.execPath, ['--input-type=module', '-e', code],
      { env: { ...process.env, E4_LLM_API_STYLE: 'ninfer-messages', E4_LLM_URL: `http://127.0.0.1:${server.address().port}`, E4_LLM_MODEL: 'm', E4_LLM_SLOT_CTX: '32768' }, timeout: 60000 });
    return { ...JSON.parse(stdout), seen };
  } finally { server.close(); }
}

test('E4.11.1: a reply cut at max_tokens is sent again once with a larger cap, up to the slot', async () => {
  const r = await cutScenario(12000);
  assert.deepEqual(r.seen, [6000, 12000]);
  assert.equal(r.content, '{"a": []}');
  assert.deepEqual(r.escalated, { from: 6000, to: 12000, firstOutputTokens: 6000, firstThinkingTokens: 4121 });
  assert.equal(r.cut, null);
});

test('E4.11.1: a reply still cut at the largest cap says why', async () => {
  const r = await cutScenario(1e9);
  assert.equal(r.seen.length, 2);
  assert.equal(r.note, 'reply cut at max_tokens 12000 (thinking 4121)');
  const room = await cutScenario(1e9, { max_tokens: 32000, reasoning: { max_tokens: 4096 }, temperature: 0 });
  assert.equal(room.seen.length, 1, 'the first request already had all the room the slot leaves');
});

test('E4.11.1: the planner asks a cut reply again for shorter field values and the PlanError names the cut', async () => {
  const asked = [];
  const chat = async (messages) => { asked.push(messages[0].content); return { text: '{"clips": [{"clip": 1, "beat": "a', cut: { note: 'reply cut at max_tokens 12288 (thinking 4121)', max_tokens: 12288 } }; };
  await assert.rejects(() => planStory(chat, 'A short story.'), (e) => e instanceof PlanError && /no usable JSON twice \(reply cut at max_tokens 12288 \(thinking 4121\)\)/.test(e.message));
  assert.equal(asked.length, 2);
  assert.match(asked[1], /cut off at the output limit \(max_tokens 12288\).*shorter field values/s);
  const plain = [];
  await assert.rejects(() => planStory(async (m) => { plain.push(m[0].content); return 'not json'; }, 'A short story.'), (e) => e instanceof PlanError && !/cut/.test(e.message));
  assert.match(plain[1], /was not one valid JSON object/);
});

test('E4.11.1: the bible retry names a cut reply', async () => {
  const asked = [];
  const chat = async (messages) => { asked.push(messages[0].content); return { ok: false, value: null, cut: { note: 'reply cut at max_tokens 9000', max_tokens: 9000 } }; };
  const plan = { chapter: 'c', ledger: { entities: [] }, clips: [] };
  const r = await makeBible(chat, 'story', plan, []);
  assert.equal(asked.length, 2);
  assert.match(asked[1], /reply cut at max_tokens 9000; write the SAME structure with shorter field values/);
  assert.equal(r.bible, null);
});

test('the bridge context helpers import the engine named by E4_PLANPATH and window a long film the same way for both', async () => {
  for (const pp of ['planpath410', 'planpath411']) {
    const code = `const { writerContext, refContext } = await import(${JSON.stringify(here('../context.mjs'))});
      const plan = { clips: Array.from({ length: 40 }, (_, i) => ({ clip: i + 1, beat: 'beat ' + (i + 1) })) };
      const asks = plan.clips.map((c) => 'ask '.repeat(300) + c.clip);
      const short = writerContext({ plan: { clips: plan.clips.slice(0, 2) }, rawAsks: asks.slice(0, 2), story: 'short', clipNumber: 1 });
      const long = writerContext({ plan, rawAsks: asks, story: 'story '.repeat(6000), clipNumber: 20 });
      console.log(JSON.stringify({ short, long: long.screenplay.includes('>>> THIS CLIP <<<') && long.screenplay.includes('Clip 1: beat 1') }));`;
    const { stdout } = await run(process.execPath, ['--input-type=module', '-e', code], { env: { ...process.env, E4_PLANPATH: pp } });
    assert.deepEqual(JSON.parse(stdout), { short: null, long: true }, pp);
  }
});
