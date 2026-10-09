// Tests of e4/bridge/scale.mjs: a long film is planned in parts and a failed part is split, never raised. Run: node --test e4/bridge/test
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, readdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { splitStory, estimateClips, weightOf, mergePlans, mergeBible, writerContext, refContext, unclosed, SINGLE_MAX_CLIPS } from '../scale.mjs';
import { planStory } from '../../planpath48/planner.mjs';

const filler = 'The lamp burned low while the two of them argued about the road, the rain, and who had lost the key to the old shed behind the mill. '.repeat(4).trim();
const story = (n) => Array.from({ length: n }, (_, i) => `[P${String(i + 1).padStart(2, '0')}] ${filler}`).join('\n\n');
const hindi = (n) => Array.from({ length: n }, (_, i) => `[P${String(i + 1).padStart(2, '0')}] ${'मीरा देवी ने काँपते हाथों से लिफ़ाफ़ा उठाया और बहुत देर तक उसे देखती रहीं। '.repeat(5).trim()}`).join('\n\n');

test('the clip estimate: Latin text at 700 characters a clip, any other script at 380', () => {
  assert.equal(estimateClips('a'.repeat(1400)), 2);
  assert.ok(estimateClips('क'.repeat(1900)) >= 5);
  assert.ok(weightOf(hindi(1)) > weightOf(filler) * 0.9);
  assert.ok(estimateClips(story(10)) <= SINGLE_MAX_CLIPS, 'ten paragraphs fit one call');
  assert.ok(estimateClips(story(40)) > SINGLE_MAX_CLIPS, 'forty do not');
});

test('splitStory cuts at paragraph boundaries into parts of about equal weight and covers the story exactly', () => {
  const s = story(40);
  const parts = splitStory(s, 5);
  assert.equal(parts.length, 5);
  for (const p of parts) assert.equal(s.slice(p.start, p.end).trim(), p.text);
  assert.equal(parts[0].start, 0);
  for (let i = 1; i < parts.length; i++) assert.ok(parts[i].start >= parts[i - 1].end);
  for (const p of parts) assert.match(p.text, /^\[P\d+\]/, 'a part starts at a paragraph');
  const w = parts.map((p) => weightOf(p.text));
  assert.ok(Math.max(...w) / Math.min(...w) < 1.5, `weights ${w.map((x) => x.toFixed(1))}`);
  const joined = parts.map((p) => p.text).join('\n\n');
  assert.equal(joined.replace(/\s+/g, ' '), s.replace(/\s+/g, ' '));
});

test('splitStory cuts one huge paragraph at sentence ends, in Latin and Devanagari', () => {
  const one = (filler + ' ').repeat(20).trim();
  const parts = splitStory(one, 4);
  assert.equal(parts.length, 4);
  for (const p of parts) assert.match(p.text, /[.]$/);
  const h = ('मीरा देवी ने लिफ़ाफ़ा उठाया। ' + 'सुधा चुप रही। ').repeat(60).trim();
  const hp = splitStory(h, 3);
  assert.equal(hp.length, 3);
  for (const p of hp) assert.match(p.text, /।$/);
});

const clipOf = (n, tag) => ({ clip: n, beat: `beat ${tag}`, shots: [4, 4, 4, 3].map((seconds, k) => ({ shot: k + 1, seconds, camera: ['wide_establishing', 'medium', 'close_up', 'low_angle'][k], camera_raw: ['wide_establishing', 'medium', 'close_up', 'low_angle'][k], subject: `hero ${tag}`, action: `moves ${tag} ${k}`, dialogue: null })), forward_pull: `pull ${tag}`, state_changes: [], end_state: { location: `place ${tag}`, time_light: 'dusk', end_action: `stands ${tag}`, characters: [{ name: 'Hero', position: 'left', wardrobe: 'coat', props: 'none', state: 'calm' }] } });

test('mergePlans: global clip numbers, entities joined by id with their clip ids, axes and options', () => {
  const ent = (clip_ids, options, initial) => ({ id: 'hero', name: 'Hero', kind: 'character', clip_ids, axes: [{ axis: 'coat', options, progressive: false, plate_visible: true, visible_trace: false }], initial: [{ axis: 'coat', value: initial }] });
  const a = { chapter: 'spine a', ledger: { entities: [ent([1, 2], ['dry', 'wet'], 'dry')] }, clips: [clipOf(1, 'a1'), clipOf(2, 'a2')] };
  const b = { chapter: 'spine b', ledger: { entities: [ent([1], ['wet', 'torn'], 'wet'), { ...ent([2], ['x'], 'x'), id: 'lamp', name: 'Lamp', kind: 'prop' }] }, clips: [clipOf(1, 'b1'), clipOf(2, 'b2')] };
  const m = mergePlans([{ breakdown: a }, { breakdown: b }]);
  assert.deepEqual(m.clips.map((c) => c.clip), [1, 2, 3, 4]);
  assert.deepEqual(m.clips.map((c) => c.beat), ['beat a1', 'beat a2', 'beat b1', 'beat b2']);
  const hero = m.ledger.entities.find((e) => e.id === 'hero');
  assert.deepEqual(hero.clip_ids, [1, 2, 3]);
  assert.deepEqual(hero.axes[0].options, ['dry', 'wet', 'torn']);
  assert.deepEqual(hero.initial, [{ axis: 'coat', value: 'dry' }]);
  assert.deepEqual(m.ledger.entities.find((e) => e.id === 'lamp').clip_ids, [4]);
  assert.equal(m.chapter, 'spine a');
});

test('mergeBible keeps the first definition of an id, adds new entities and speaker strings, never duplicates', () => {
  const a = { language: 'Hindi', speakers: { Meera: 'meera' }, cast: [{ id: 'meera', name: 'Meera' }], props: [], locations: [{ id: 'shop', name: 'Shop', landmarks: [{ id: 'counter' }] }], voices: [] };
  const b = { language: 'Hindi', speakers: { Meera: 'someone_else', Sudha: 'sudha' }, cast: [{ id: 'meera', name: 'DUP' }, { id: 'sudha', name: 'Sudha' }], props: [{ id: 'letter', name: 'Letter' }], locations: [{ id: 'street', name: 'Street', landmarks: [{ id: 'counter' }, { id: 'gate' }] }] };
  const m = mergeBible(a, b);
  assert.deepEqual(m.cast.map((c) => c.id), ['meera', 'sudha']);
  assert.equal(m.cast[0].name, 'Meera');
  assert.deepEqual(m.speakers, { Meera: 'meera', Sudha: 'sudha' });
  assert.deepEqual(m.props.map((p) => p.id), ['letter']);
  assert.equal(a.cast.length, 1, 'the accumulated bible is not mutated');
});

// ---- the planner against a canned server: one clip per [Pnn] paragraph of the chapter text
async function planScenario(storyText, { cutOver = Infinity, resumeTwice = false, language = 'English' } = {}) {
  const seen = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const b = JSON.parse(body);
      const text = b.messages.map((m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content))).join('\n');
      const chapter = text.slice(text.indexOf('THE STORY') >= 0 ? 0 : 0);
      const markers = [...new Set((chapter.match(/\[P\d+\]/g) || []))];
      const part = /PART (\d+) OF (\d+) OF ONE LONG FILM/.exec(text);
      seen.push({ promptChars: text.length, markers: markers.length, part: part ? Number(part[1]) : null, of: part ? Number(part[2]) : null, hasEnd: /THE FILM SO FAR ENDS LIKE THIS \(end of clip (\d+)\)/.exec(text)?.[1] || null, hasLedger: /THE LEDGER SO FAR/.test(text), max_tokens: b.max_tokens });
      const cut = markers.length > cutOver;
      const clips = markers.map((m, i) => ({ clip: i + 1, beat: `beat ${m.replace(/[\[\]]/g, '')}`, shots: [4, 4, 4, 3].map((seconds, k) => ({ shot: k + 1, seconds, camera: ['wide_establishing', 'medium', 'close_up', 'low_angle'][k], subject: `hero at ${m.replace(/[\[\]]/g, '')}`, action: `moves around ${m.replace(/[\[\]]/g, '')} ${k}`, has_dialogue: false, dialogue_speaker: '', dialogue_line: '' })), forward_pull: `pull ${m.replace(/[\[\]]/g, '')}`, state_changes: [], end_state: { location: `place ${m.replace(/[\[\]]/g, '')}`, time_light: 'dusk', end_action: `stands at ${m.replace(/[\[\]]/g, '')}`, characters: [{ name: 'Hero', position: 'left', wardrobe: 'coat', props: 'none', state: 'calm' }] } }));
      const plan = { chapter: `spine ${String(markers[0]).replace(/[\[\]]/g, '')}`, ledger: { entities: [{ id: 'hero', name: 'Hero', kind: 'character', clip_ids: clips.map((c) => c.clip), axes: [{ axis: 'coat', options: ['dry', 'wet'], progressive: false, plate_visible: true, visible_trace: false }], initial: [{ axis: 'coat', value: 'dry' }] }] }, clips };
      const out = JSON.stringify(plan);
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ content: [{ type: 'thinking', thinking: 't' }, { type: 'text', text: cut ? out.slice(0, 200) : out }], stop_reason: cut ? 'max_tokens' : 'end_turn', usage: { input_tokens: 900, output_tokens: 3000, output_tokens_details: { thinking_tokens: 100 } } }));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const out = mkdtempSync(join(tmpdir(), 'scale-'));
  try {
    const code = `import { planFilm } from ${JSON.stringify(new URL('../scale.mjs', import.meta.url).href)};
      import { join } from 'node:path';
      const story = ${JSON.stringify(storyText)};
      const dir = join(${JSON.stringify(out)}, 's');
      const run = (resume) => planFilm({ name: 's', story, wrap: (t) => t + '\\n\\nDIALOGUE LANGUAGE: ${language}.', outRoot: ${JSON.stringify(out)}, dir, resume });
      let r = await run(false);
      if (${resumeTwice}) r = await run(true);
      console.log(JSON.stringify({ clips: r.plan.clips.map((c) => [c.clip, c.beat]), parts: r.plan.parts || null, entities: r.plan.ledger.entities.map((e) => [e.id, e.clip_ids.length]), rawAsks: r.planMeta.rawAsks.length, issues: r.planMeta.issues, splitFrom: r.planMeta.splitFrom || [] }));`;
    const { stdout } = await promisify(execFile)(process.execPath, ['--input-type=module', '-e', code],
      { env: { ...process.env, E4_LLM_API_STYLE: 'ninfer-messages', E4_LLM_URL: `http://127.0.0.1:${server.address().port}`, E4_LLM_MODEL: 'm', E4_LLM_SLOT_CTX: '' }, timeout: 120000 });
    return { ...JSON.parse(stdout), seen, out };
  } finally { server.close(); }
}

test('a short story is planned in ONE call, exactly as E4.8 does: no part context, the same call names', async () => {
  const r = await planScenario(story(8));
  assert.equal(r.seen.length, 1);
  assert.equal(r.seen[0].part, null);
  assert.equal(r.parts, null);
  assert.equal(r.clips.length, 8);
  const files = readdirSync(join(r.out, 's', 'planner'));
  assert.ok(files.includes('plan.request.json') && files.includes('plan.response.raw.txt') && !files.some((f) => f.startsWith('plan.part')));
  assert.ok(!existsSync(join(r.out, 's', 'plan_parts')));
});

test('a long story is planned in parts that carry the film so far, then merged with global numbers', async () => {
  const r = await planScenario(story(40));
  const parts = r.seen.length;
  assert.ok(parts >= 4 && parts <= 8, `${parts} planner calls`);
  assert.equal(r.seen[0].part, 1);
  assert.equal(r.seen[1].part, 2);
  assert.ok(r.seen[1].hasEnd && r.seen[1].hasLedger, 'part 2 is told how the film so far ended and which entities exist');
  assert.equal(r.seen[0].hasEnd, null);
  assert.equal(r.seen.reduce((a, s) => a + s.markers, 0), 40, 'every paragraph is in exactly one part');
  assert.equal(r.clips.length, 40);
  assert.deepEqual(r.clips.map((c) => c[0]), Array.from({ length: 40 }, (_, i) => i + 1));
  assert.deepEqual(r.clips.map((c) => c[1]), Array.from({ length: 40 }, (_, i) => `beat P${String(i + 1).padStart(2, '0')}`), 'in story order');
  assert.deepEqual(r.entities, [['hero', 40]]);
  assert.equal(r.rawAsks, 40);
  assert.equal(r.parts.length, parts);
  assert.equal(r.parts[0].first, 1);
  assert.equal(r.parts.at(-1).last, 40);
  assert.deepEqual(r.issues.filter((i) => !/barely|identical/.test(i)).length, r.issues.length);
});

test('a resumed run does not plan a stored part again', async () => {
  const r = await planScenario(story(40), { resumeTwice: true });
  const first = r.seen.length;
  assert.ok(first <= 8, `a resume made no new planner call (${first} calls in all)`);
  assert.equal(r.clips.length, 40);
});

test('a part whose reply is always cut is split in two, again and again, and the film still plans', async () => {
  const r = await planScenario(story(24), { cutOver: 3 });
  assert.equal(r.clips.length, 24);
  assert.ok(r.splitFrom.length >= 3, `${r.splitFrom.length} splits`);
  assert.ok(r.seen.some((s) => s.markers <= 3), 'pieces of three paragraphs or fewer were planned');
  assert.deepEqual(r.clips.map((c) => c[0]), Array.from({ length: 24 }, (_, i) => i + 1));
});

test('a story the one-call path cannot plan falls into parts instead of raising', async () => {
  const r = await planScenario(story(12), { cutOver: 6 });
  assert.equal(r.clips.length, 12);
  assert.ok(r.splitFrom.some((n) => /no usable JSON twice/.test(n)));
  assert.ok(r.parts && r.parts.length >= 2);
});

test('a piece that cannot be planned even when small is the one thing that raises, and says so', async () => {
  await assert.rejects(() => planScenario(story(12), { cutOver: 0 }), /smallest piece|no usable JSON twice/);
});

// ---- the writer's context
const fakePlan = (n, parts) => ({ clips: Array.from({ length: n }, (_, i) => ({ clip: i + 1, beat: `beat ${i + 1}` })), parts });
test('the writer context is untouched for a story that fits and windowed for one that does not', () => {
  const small = fakePlan(8);
  assert.equal(writerContext({ plan: small, rawAsks: small.clips.map((c) => `ask ${c.clip}`), story: 'short', clipNumber: 3 }), null);
  const n = 60, big = fakePlan(n, [{ first: 1, last: 30, start: 0, end: 10 }, { first: 31, last: 60, start: 11, end: 20 }]);
  const asks = big.clips.map((c) => `ASK${c.clip} ${'x'.repeat(2400)}`);
  const text = '0123456789\nABCDEFGHI';
  const ctx = writerContext({ plan: big, rawAsks: asks, story: text + 'z'.repeat(60000), clipNumber: 40 });
  assert.ok(ctx);
  assert.match(ctx.screenplay, />>> THIS CLIP <<<\nASK40 /);
  for (const k of [37, 38, 39, 41, 42, 43]) assert.match(ctx.screenplay, new RegExp(`ASK${k} `));
  assert.doesNotMatch(ctx.screenplay, /ASK36 |ASK44 |ASK1 /);
  assert.match(ctx.screenplay, /Clip 1: beat 1/);
  assert.match(ctx.screenplay, /Clip 60: beat 60/);
  assert.equal(ctx.storyText, 'ABCDEFGHI');
  assert.ok(ctx.screenplay.length < 30000, `${ctx.screenplay.length} characters`);
});

test('a reference repair quotes only the clips the entity is in when the film is long', () => {
  const n = 40, plan = { ...fakePlan(n), ledger: { entities: [{ id: 'lamp', clip_ids: [5, 9] }] } };
  const asks = plan.clips.map((c) => `ASK${c.clip} ${'x'.repeat(2400)}`);
  const small = refContext({ story: 's', rawAsks: ['a', 'b'], plan: fakePlan(2), ent: { id: 'lamp', name: 'Lamp' } });
  assert.deepEqual(small, { story: 's', rawAsks: ['a', 'b'] });
  const r = refContext({ story: 'q'.repeat(60000), rawAsks: asks, plan, ent: { id: 'lamp', name: 'Lamp' } });
  assert.equal(r.rawAsks.length, 2);
  assert.match(r.rawAsks[0], /^ASK5 /);
  assert.ok(r.story.length <= 6000);
});

test('a 60-clip story is planned in bounded parts: no planner prompt grows with the film', async () => {
  const r = await planScenario(story(70));
  assert.equal(r.clips.length, 70);
  const small = (await planScenario(story(20))).seen;
  const big = r.seen;
  assert.ok(big.length >= 7, `${big.length} planner calls`);
  const maxBig = Math.max(...big.map((s) => s.promptChars)), maxSmall = Math.max(...small.map((s) => s.promptChars));
  assert.ok(maxBig < maxSmall * 1.6, `the largest part prompt of 70 paragraphs (${maxBig} chars) stays near the one of 20 (${maxSmall})`);
  assert.ok(maxBig < 60000, `${maxBig} characters`);
  assert.deepEqual(r.clips.map((c) => c[0]), Array.from({ length: 70 }, (_, i) => i + 1));
  assert.equal(r.parts.at(-1).last, 70);
});

test('unclosed: a reply that stops inside a string or with open brackets is a cut reply, a complete or non-JSON one is not', () => {
  assert.equal(unclosed('{"a": [1, 2'), true);
  assert.equal(unclosed('```json\n{"a": "x'), true);
  assert.equal(unclosed('{"a": {"b": 1}}'), false);
  assert.equal(unclosed('{"a": "}"} '), false, 'a brace inside a string is not a bracket');
  assert.equal(unclosed('sorry, no'), false);
});

const planJson = (n, { shots = 4 } = {}) => JSON.stringify({ chapter: 'c', ledger: { entities: [] }, clips: Array.from({ length: n }, (_, i) => ({ clip: i + 1, beat: `b${i}`, shots: Array.from({ length: shots }, (_, k) => ({ shot: k + 1, seconds: 15 / shots, camera: ['wide_establishing', 'medium', 'close_up', 'low_angle'][k % 4], subject: `s${i}${k}`, action: `a${i}${k}`, has_dialogue: false, dialogue_speaker: '', dialogue_line: '' })), forward_pull: `p${i}`, state_changes: [], end_state: { location: 'l', time_light: 't', end_action: `e${i}`, characters: [] } })) });

test('a retry that comes back unparseable keeps the first reply\'s plan instead of raising', async () => {
  const replies = [planJson(3, { shots: 2 }), 'not json at all'];
  const asked = [];
  const r = await planStory(async (m, attempt) => { asked.push(attempt); return replies[attempt]; }, 'A story.');
  assert.equal(asked.length, 2, 'the first reply had a failing check (two shots), so the plan was asked for again');
  assert.equal(r.breakdown.clips.length, 3);
  assert.ok(r.issues.some((i) => /shots? — outside/.test(i)));
  assert.ok(r.attempts.at(-1).issues.includes('kept the first reply'));
  await assert.rejects(() => planStory(async () => 'not json', 'A story.'), /no usable JSON twice/);
});
