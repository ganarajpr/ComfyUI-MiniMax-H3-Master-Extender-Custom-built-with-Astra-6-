// Unit tests of the bridge (not part of the frozen E4.6): the picture binding, the Picture-N citation and the export. Run: node --test e4/bridge/test
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { validateMapping, settle, lexicalMap, mappingText, mappingMessages, redact, citeSubjectDefinitions, pictureList, checkCitations, pictureEntities } from '../pictures.mjs';
import { wholeSeconds } from '../export.mjs';

const entities = [
  { id: 'haroon', kind: 'character', name: 'Haroon', appearsAs: 'an old tailor', wardrobe: ['a grey kurta'] },
  { id: 'pramod', kind: 'character', name: 'Pramod', appearsAs: 'a young customer' },
  { id: 'tea_glass', kind: 'prop', name: 'tea glass', appearsAs: 'a steaming glass' },
  { id: 'chikankari_shop', kind: 'location', name: 'chikankari shop', appearsAs: 'a narrow shop' },
];
const ids = entities.map((e) => e.id);

test('validateMapping accepts a complete, unique answer and maps unused to null', () => {
  const v = validateMapping({ pictures: [{ picture: 1, entity: 'haroon' }, { picture: 2, entity: 'unused' }, { picture: 4, entity: 'tea_glass' }] }, [1, 2, 4], ids);
  assert.deepEqual(v.issues, []);
  assert.deepEqual([...v.map], [[1, 'haroon'], [2, null], [4, 'tea_glass']]);
});

test('validateMapping names every kind of failure so the retry can correct exactly it', () => {
  const v = validateMapping({ pictures: [{ picture: 1, entity: 'haroon' }, { picture: 2, entity: 'haroon' }, { picture: 9, entity: 'pramod' }, { picture: 3, entity: 'nobody' }] }, [1, 2, 3, 4], ids);
  const text = v.issues.join('\n');
  assert.match(text, /Picture 9|"picture": 9/);
  assert.match(text, /"nobody" is not an entity id/);
  assert.match(text, /haroon is bound to both Picture 1 and Picture 2/);
  assert.match(text, /Picture 4 has no answer/);
  assert.equal(validateMapping({}, [1], ids).map, null);
});

test('settle keeps the first claim on an entity and drops invalid ids', () => {
  const m = settle(new Map([[1, 'haroon'], [2, 'haroon'], [3, 'ghost'], [4, null]]), [1, 2, 3, 4], ids);
  assert.deepEqual([...m], [[1, 'haroon'], [2, null], [3, null], [4, null]]);
});

test('a voice is never offered as an entity', () => {
  const bible = { cast: [{ id: 'a', name: 'A', appearsAs: 'x' }], props: [], locations: [{ id: 'l', name: 'L', appearsAs: 'y' }], voices: [{ id: 'voice_below', name: 'voice', appearsAs: 'z' }] };
  assert.deepEqual(pictureEntities(bible).map((e) => e.id), ['a', 'l']);
});

test('lexicalMap binds a label that names exactly one entity and leaves ambiguous and repeated ones unused', () => {
  const m = lexicalMap([1, 2, 3, 4], { 1: 'Haroon at his machine', 2: 'a tea glass on a tray', 3: 'Haroon and Pramod together', 4: 'haroon again' }, entities);
  assert.deepEqual([...m], [[1, 'haroon'], [2, 'tea_glass'], [3, null], [4, null]]);
});

test('the mapping prompt lists the entities and the labels, with the user notes as a hint', () => {
  const text = mappingText({ entities, labels: [1, 3], notes: { 3: 'the shop front' }, sees: true });
  assert.match(text, /- haroon \| character \| Haroon: an old tailor \(wardrobe: a grey kurta\)/);
  assert.match(text, /Answer for EVERY picture: Picture 1, Picture 3/);
  assert.match(text, /Picture 3: the shop front/);
  assert.match(text, /what you see wins/);
  const blind = mappingText({ entities, labels: [1], notes: { 1: 'Haroon' }, sees: false });
  assert.match(blind, /You cannot see the pictures/);
});

test('the pictures come first, each labelled, in the wire of the endpoint', () => {
  const dir = mkdtempSync(join(tmpdir(), 'e4-'));
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGD4DwABBAEAX+XDSwAAAABJRU5ErkJggg==', 'base64');
  const files = [1, 3].map((n) => { const f = join(dir, `p${n}.png`); writeFileSync(f, png); return { label: n, file: f }; });
  const a = mappingMessages({ entities, pictures: files, notes: {}, sees: true, style: 'ninfer-messages' })[0].content;
  assert.deepEqual(a.slice(0, 5).map((p) => p.type), ['text', 'text', 'image', 'text', 'image']);
  assert.equal(a[1].text, 'Picture 1:');
  assert.equal(a[3].text, 'Picture 3:');
  assert.equal(a[2].source.data, png.toString('base64'));
  const b = mappingMessages({ entities, pictures: files, notes: {}, sees: true, style: 'llama-chat' })[0].content;
  assert.equal(b[2].image_url.url, `data:image/png;base64,${png.toString('base64')}`);
  assert.equal(typeof mappingMessages({ entities, pictures: files, notes: { 1: 'x' }, sees: false })[0].content, 'string');
});

test('redact replaces pictures by their hash in either wire', () => {
  const r = redact({ messages: [{ content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } }, { type: 'image', source: { type: 'base64', data: 'B'.repeat(300) } }] }] });
  assert.match(JSON.stringify(r), /<image 26 chars sha256 [0-9a-f]{16}>/);
  assert.match(JSON.stringify(r), /<image base64 300 chars/);
});

const refs = [
  { id: 'haroon', type: 'character' }, { id: 'tea_glass', type: 'object' }, { id: 'stepwell', type: 'location', noPicture: true }, { id: 'voice_below', type: 'voice' },
];
const defs = ['<Subject 1> is Haroon, an old tailor; face held.', '<Subject 2> is tea glass, a steaming glass; form held.', '<Subject 3> is the well, a shaft; described in words only.'].join('\n\n');
const names = { haroon: 'Haroon', tea_glass: 'tea glass', stepwell: 'the well' };

test('citation uses the extender\'s picture numbers, not 1..N per clip', () => {
  const out = citeSubjectDefinitions(defs, refs.slice(0, 3), names, { haroon: 4, tea_glass: 2 });
  assert.match(out, /^<Subject 1> is Haroon in <Picture 4>, an old tailor/);
  assert.match(out, /<Subject 2> is tea glass in <Picture 2>, a steaming glass/);
  assert.doesNotMatch(out.split('\n\n')[2], /Picture/);
  assert.deepEqual(pictureList(refs.slice(0, 3), { haroon: 4, tea_glass: 2 }).map((p) => [p.picture, p.subject, p.entity]), [[4, 1, 'haroon'], [2, 2, 'tea_glass']]);
});

test('a voice never gets a picture, even when the binding names one', () => {
  assert.deepEqual(pictureList(refs, { voice_below: 3 }), []);
});

test('checkCitations accepts a correct clip and names every kind of error', () => {
  const pictureOf = { haroon: 4, tea_glass: 2 };
  const good = { subject_definitions: citeSubjectDefinitions(defs, refs.slice(0, 3), names, pictureOf), summary: 's', retention_analysis: '<Subject 1>: fully_preserved\n<Subject 2>: fully_preserved\n<Subject 3>: fully_preserved', detailed_description: 'd' };
  assert.deepEqual(checkCitations({ references: refs.slice(0, 3), sections: good, pictureOf, attached: [1, 2, 3, 4] }), []);
  const wrong = { ...good, subject_definitions: good.subject_definitions.replace('<Picture 4>', '<Picture 3>') };
  assert.match(checkCitations({ references: refs.slice(0, 3), sections: wrong, pictureOf, attached: [1, 2, 3, 4] }).join('|'), /cites <Picture 3>, expected exactly <Picture 4>/);
  assert.match(checkCitations({ references: refs.slice(0, 3), sections: good, pictureOf, attached: [1, 2, 3] }).join('|'), /<Picture 4> is not an attached picture/);
  assert.match(checkCitations({ references: refs.slice(0, 3), sections: { ...good, detailed_description: 'see <Picture 2>' }, pictureOf, attached: [1, 2, 3, 4] }).join('|'), /detailed_description cites <Picture 2>/);
  const same = { haroon: 4, tea_glass: 4 };
  const twice = { ...good, subject_definitions: citeSubjectDefinitions(defs, refs.slice(0, 3), names, same) };
  assert.match(checkCitations({ references: refs.slice(0, 3), sections: twice, pictureOf: same, attached: [1, 2, 3, 4] }).join('|'), /is cited by subjects 1 and 2/);
  const noPic = { ...good, subject_definitions: good.subject_definitions.replace('the well, a shaft', 'the well in <Picture 1>, a shaft') };
  assert.match(checkCitations({ references: refs.slice(0, 3), sections: noPic, pictureOf, attached: [1, 2, 3, 4] }).join('|'), /has no picture but cites <Picture 1>/);
});

test('E4 durations become whole seconds', () => {
  assert.equal(wholeSeconds(15.08), 15);
  assert.equal(wholeSeconds('9.6'), 10);
  assert.equal(wholeSeconds(0.2), 1);
});

test('the llama-chat style sends the founder\'s two top-level budget fields and the ninfer style a per-request thinking budget', () => {
  const probe = (style) => JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e',
    `import('${new URL('../../hybrid3/lib.mjs', import.meta.url).href}').then((m) => console.log(JSON.stringify(m.buildRequest([{ role: 'system', content: 'S' }, { role: 'user', content: 'U' }], { max_tokens: 32000, reasoning: { max_tokens: 4096 }, temperature: 0.5 }, 'decision'))))`],
    { env: { ...process.env, E4_LLM_API_STYLE: style, E4_LLM_URL: 'http://h:1', E4_LLM_MODEL: 'm', E4_LLM_BUDGET_DECISION: '2048', E4_LLM_MAX_TOKENS: '12288' } }).toString());
  const llama = probe('llama-chat');
  assert.equal(llama.url, 'http://h:1/v1/chat/completions');
  assert.equal(llama.body.reasoning_budget_tokens, 2048);
  assert.equal(llama.body.reasoning_budget_message, 'Time to stop thinking. Give the final answer now.');
  assert.equal(llama.body.max_tokens, 12288);
  assert.equal(llama.body.chat_template_kwargs, undefined);
  assert.equal(llama.body.reasoning, undefined);
  assert.equal(llama.headers.Authorization, undefined);
  const ninfer = probe('ninfer-messages');
  assert.equal(ninfer.url, 'http://h:1/v1/messages');
  assert.deepEqual(ninfer.body.thinking, { type: 'enabled', budget_tokens: 2048 });
  assert.equal(ninfer.body.max_tokens, 12288);
  assert.equal(ninfer.body.system, 'S');
});
