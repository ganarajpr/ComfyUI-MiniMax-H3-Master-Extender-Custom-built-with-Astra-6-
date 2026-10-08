// Binding of the user's connected reference pictures to the entities of E4's film bible, and the Picture-N citation of the export.
// Not part of the frozen E4.6: the extender's pictures are the user's own, so the stage that would render E4's reference images
// (buildRefs) is replaced by one extra decision call in which the model SEES the pictures (or reads their labels) and says, for each
// picture, which bible entity it shows. The numbers are the extender's own (`Picture <slot+1>`), not renumbered per clip.
import { readFileSync, appendFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { chatWith, parseJsonLoose, wr, rj, API_STYLE, MODEL } from '../planpath46/lib.mjs';

export const MAP_KIND = 'decision';
export const MAP_SETTINGS = { max_tokens: 8000, reasoning: { max_tokens: 2048 }, temperature: 0 };

// Characters, props and locations of the bible. A voice is never a subject, so it is never offered.
export function pictureEntities(bible) {
  return [
    ...bible.cast.map((e) => ({ id: e.id, kind: 'character', name: e.name, appearsAs: e.appearsAs, wardrobe: e.wardrobe })),
    ...bible.props.map((e) => ({ id: e.id, kind: 'prop', name: e.name, appearsAs: e.appearsAs })),
    ...bible.locations.map((e) => ({ id: e.id, kind: 'location', name: e.name, appearsAs: e.appearsAs })),
  ];
}

const entityLine = (e) => `- ${e.id} | ${e.kind} | ${e.name}: ${String(e.appearsAs || '').trim()}${e.wardrobe?.length ? ` (wardrobe: ${e.wardrobe.join('; ')})` : ''}`;

export const MAP_RULES = [
  'Decide from what you SEE, using the names and descriptions only to tell the candidates apart. The number or position of a picture says nothing about who or what it shows.',
  'A picture shows a character when a person is its subject (their face and body), a prop when an object is its subject, and a location when a place is its subject.',
  'Each entity may get at most ONE picture. When two pictures show the same entity, bind the clearer one and answer "unused" for the other.',
  'When no entity fits a picture, or you cannot tell, answer "unused". Never guess an entity to fill a slot.',
];

export function mappingText({ entities, labels, notes, sees, complaint = '' }) {
  const noteLines = labels.filter((n) => notes?.[n]).map((n) => `Picture ${n}: ${notes[n]}`);
  return [
    sees
      ? 'You are binding the reference pictures a user attached to the entities of a film bible. The pictures are shown above, each labelled "Picture N:" right before its image.'
      : 'You are binding the reference pictures a user attached to the entities of a film bible. You cannot see the pictures: you only have the label the user wrote for each.',
    '',
    'THE ENTITIES (id | kind | name: how it appears)',
    ...entities.map(entityLine),
    ...(noteLines.length ? ['', `THE USER'S OWN LABELS FOR THE PICTURES${sees ? ' (use them as a hint; what you see wins)' : ''}`, ...noteLines] : []),
    '',
    'RULES',
    ...MAP_RULES.map((r, i) => `${i + 1}. ${r}`),
    '',
    `Answer for EVERY picture: ${labels.map((n) => `Picture ${n}`).join(', ')}. Reply with ONE JSON object and nothing else, in this shape:`,
    '{"pictures": [{"picture": <the number>, "entity": "<an entity id from the list, or unused>", "shows": "<what you see or read, a few words>"}]}',
    ...(complaint ? ['', `YOUR PREVIOUS REPLY FAILED THESE CHECKS, CORRECT EXACTLY THIS AND NOTHING ELSE:\n${complaint}`] : []),
  ].join('\n');
}

const dataUri = (file) => `data:image/png;base64,${readFileSync(file).toString('base64')}`;

// The user turn of the mapping call: the pictures first, as the extender sends them (`Picture N:` + image), then the task.
export function mappingMessages({ entities, pictures, notes, sees, complaint = '', style = API_STYLE }) {
  const labels = pictures.map((p) => p.label);
  const text = mappingText({ entities, labels, notes, sees, complaint });
  if (!sees) return [{ role: 'user', content: text }];
  const parts = [{ type: 'text', text: 'Reference pictures, in order (each labelled before its image):' }];
  for (const p of pictures) {
    parts.push({ type: 'text', text: `Picture ${p.label}:` });
    const uri = dataUri(p.file);
    parts.push(style === 'ninfer-messages'
      ? { type: 'image', source: { type: 'base64', media_type: 'image/png', data: uri.slice(uri.indexOf(',') + 1) } }
      : { type: 'image_url', image_url: { url: uri } });
  }
  parts.push({ type: 'text', text });
  return [{ role: 'user', content: parts }];
}

// Entity ids that name a picture of the reply; anything else becomes `unused`. Returns { map, issues } where map is picture -> entity | null.
export function validateMapping(value, labels, ids) {
  const issues = [];
  const rows = Array.isArray(value?.pictures) ? value.pictures : null;
  if (!rows) return { map: null, issues: ['the reply has no "pictures" array'] };
  const map = new Map();
  const said = new Map();
  for (const r of rows) {
    const n = Number(r?.picture);
    if (!labels.includes(n)) { issues.push(`"picture": ${JSON.stringify(r?.picture)} is not one of the attached pictures (${labels.join(', ')})`); continue; }
    if (said.has(n)) { issues.push(`Picture ${n} is answered twice`); continue; }
    const e = typeof r.entity === 'string' ? r.entity.trim() : null;
    const unused = !e || ['unused', 'none', 'null', 'n/a'].includes(e.toLowerCase());
    if (!unused && !ids.includes(e)) { issues.push(`Picture ${n}: "${e}" is not an entity id of the list (use one of: ${ids.join(', ')}, or unused)`); said.set(n, null); continue; }
    said.set(n, unused ? null : e);
  }
  for (const n of labels) if (!said.has(n)) issues.push(`Picture ${n} has no answer`);
  const owner = new Map();
  for (const n of labels) {
    const e = said.get(n);
    if (!e) continue;
    if (owner.has(e)) issues.push(`${e} is bound to both Picture ${owner.get(e)} and Picture ${n}; an entity gets one picture, answer unused for the other`);
    else owner.set(e, n);
  }
  for (const n of labels) map.set(n, said.get(n) ?? null);
  return { map, issues };
}

// Settle what is left after the one retry: invalid entity ids and second claims on an entity become unused; the first (lowest picture number) keeps it.
export function settle(map, labels, ids) {
  const out = new Map(), taken = new Set();
  for (const n of labels) {
    const e = map?.get(n) ?? null;
    if (e && ids.includes(e) && !taken.has(e)) { out.set(n, e); taken.add(e); } else out.set(n, null);
  }
  return out;
}

const words = (s) => (String(s || '').toLowerCase().match(/[a-zÀ-ɏऀ-ॿ]{3,}/g) || []);
const STOP = new Set(['the', 'and', 'with', 'for', 'her', 'his', 'its', 'photo', 'picture', 'image', 'shot', 'view', 'old']);
// Last resort when the model's reply is unusable: a picture's label names an entity when every word of the entity's name occurs in the label
// (or the entity's id occurs in it). Ambiguity (a label naming two entities) and a second claim on one entity leave the picture unused.
export function lexicalMap(labels, notes, entities) {
  const claims = new Map();
  for (const n of labels) {
    const text = String(notes?.[n] || '').toLowerCase();
    if (!text) continue;
    const have = new Set(words(text));
    const hits = entities.filter((e) => {
      const nameWords = words(e.name).filter((w) => !STOP.has(w));
      return (nameWords.length && nameWords.every((w) => have.has(w))) || text.includes(e.id.replace(/_/g, ' '));
    });
    if (hits.length === 1) claims.set(n, hits[0].id);
  }
  const out = new Map(), taken = new Set();
  for (const n of labels) { const e = claims.get(n) ?? null; if (e && !taken.has(e)) { out.set(n, e); taken.add(e); } else out.set(n, null); }
  return out;
}

const sha = (b) => createHash('sha256').update(b).digest('hex');
// A request or reply with its pictures replaced by their size and hash, for the logs: a data URI, and the base64 `data` of an Anthropic image block.
export function redact(value) {
  if (typeof value === 'string') return value.startsWith('data:image') ? `<image ${value.length} chars sha256 ${sha(value).slice(0, 16)}>` : value;
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = k === 'data' && value.type === 'base64' && typeof v === 'string' ? `<image base64 ${v.length} chars sha256 ${sha(v).slice(0, 16)}>` : redact(v);
    return out;
  }
  return value;
}

// The binder handed to film.mjs's planAndBible (patched hook). It also stores its result in <out>/<story>/pictures/map.json.
export function makeBinder({ pictures, notes = {}, sees, resume = false, log = () => {} }) {
  const labels = pictures.map((p) => p.label);
  return async function bindPictures({ name, outRoot, bible }) {
    const dir = join(outRoot, name, 'pictures');
    mkdirSync(dir, { recursive: true });
    const entities = pictureEntities(bible);
    const ids = entities.map((e) => e.id);
    const mapFile = join(dir, 'map.json');
    let result;
    if (resume && existsSync(mapFile)) result = rj(mapFile);
    else {
      result = { mode: sees ? 'vision' : (Object.keys(notes).length ? 'labels' : 'none'), pictures: [], attempts: 0, issues: [], fallback: null, model: MODEL, apiStyle: API_STYLE };
      let map = null;
      if (!labels.length) result.mode = 'none';
      else if (result.mode === 'none') result.issues.push('the writer cannot see pictures and no picture labels were given: every entity is described in words only');
      else {
        log(`binding ${labels.length} picture(s) to ${entities.length} entities (${result.mode})`);
        let complaint = '';
        for (let attempt = 1; attempt <= 2; attempt++) {
          const messages = mappingMessages({ entities, pictures, notes, sees, complaint });
          const c = await chatWith(messages, MAP_SETTINGS, { kind: MAP_KIND });
          const base = `pictures.map${attempt > 1 ? '.retry' : ''}`;
          wr(join(dir, `${base}.request.json`), redact(c.body));
          wr(join(dir, `${base}.response.raw.txt`), c.raw || c.error || '');
          const meta = { kind: MAP_KIND, story: name, clip: null, name: 'pictures.map', usage: c.usage, cost: c.cost, finish: c.finish, secs: c.secs, status: c.status, attempt: c.attempt, model: c.resp?.model || null };
          wr(join(dir, `${base}.meta.json`), meta);
          appendFileSync(join(outRoot, 'calls.jsonl'), `${JSON.stringify(meta)}\n`);
          result.attempts = attempt;
          const parsed = parseJsonLoose(c.content);
          const v = parsed.ok ? validateMapping(parsed.value, labels, ids) : { map: null, issues: ['the reply was not one JSON object'] };
          result.issues = v.issues;
          if (parsed.ok) result.shows = Object.fromEntries((parsed.value.pictures || []).filter((r) => r && labels.includes(Number(r.picture))).map((r) => [Number(r.picture), String(r.shows || '').slice(0, 160)]));
          map = v.map;
          if (!v.issues.length) break;
          complaint = v.issues.map((i) => `- ${i}`).join('\n');
        }
        if (map && result.issues.length) map = settle(map, labels, ids);
        if (!map) { map = lexicalMap(labels, notes, entities); result.fallback = 'lexical match of the picture labels to entity names (the model reply was unusable)'; }
      }
      map ||= new Map(labels.map((n) => [n, null]));
      result.pictures = labels.map((n) => ({ picture: n, entity: map.get(n) ?? null, shows: result.shows?.[n] || null }));
    }
    const pictureOf = Object.fromEntries(result.pictures.filter((p) => p.entity).map((p) => [p.entity, p.picture]));
    result.pictureOf = pictureOf;
    result.unused = result.pictures.filter((p) => !p.entity).map((p) => p.picture);
    for (const e of [...bible.cast, ...bible.props, ...bible.locations]) { e.refImage = e.id in pictureOf; e.picture = pictureOf[e.id] ?? null; }
    wr(mapFile, result);
    return result;
  };
}

// ---- export: subject definitions with the extender's own Picture numbers ----
export const isPictured = (ref) => ref.type !== 'voice' && !ref.noPicture;

// "<Subject k> is NAME, ..." -> "<Subject k> is NAME in <Picture j>, ..." for the pictured subjects, j = the user's picture number.
export function citeSubjectDefinitions(subjectDefinitions, references, names, pictureOf) {
  const paras = String(subjectDefinitions).split('\n\n');
  if (paras.length !== references.length) throw new Error(`subject_definitions has ${paras.length} paragraphs for ${references.length} references`);
  return paras.map((para, i) => {
    const r = references[i];
    const j = pictureOf[r.id];
    if (!isPictured(r) || !j) return para;
    const head = `<Subject ${i + 1}> is ${names[r.id]}`;
    if (!para.startsWith(head)) throw new Error(`subject ${i + 1} (${r.id}) does not start with "${head}"`);
    return `${head} in <Picture ${j}>${para.slice(head.length)}`;
  }).join('\n\n');
}

export function pictureList(references, pictureOf) {
  return references.flatMap((r, i) => (isPictured(r) && pictureOf[r.id] ? [{ picture: pictureOf[r.id], subject: i + 1, entity: r.id, type: r.type }] : []));
}

// Checks of the citation: a pictured subject cites exactly its picture right after its name, a described-only subject cites none,
// nothing cites a picture that was not attached, no picture is cited by two subjects, and there is no standalone picture line.
export function checkCitations({ references, sections, pictureOf, attached }) {
  const issues = [];
  const subj = String(sections.subject_definitions).split('\n\n');
  if (subj.length !== references.length) issues.push(`subject_definitions has ${subj.length} paragraphs for ${references.length} references`);
  const cited = new Map();
  subj.forEach((para, i) => {
    const r = references[i];
    if (!r) return;
    const cites = [...para.matchAll(/<Picture (\d+)>/g)].map((m) => Number(m[1]));
    if (!para.startsWith(`<Subject ${i + 1}> is `)) issues.push(`subject paragraph ${i + 1} does not start with <Subject ${i + 1}> is`);
    const want = isPictured(r) ? pictureOf[r.id] : null;
    if (want) {
      if (cites.length !== 1 || cites[0] !== want) issues.push(`subject ${i + 1} (${r.id}) cites ${cites.length ? cites.map((c) => `<Picture ${c}>`).join(', ') : 'no picture'}, expected exactly <Picture ${want}>`);
      else if (!new RegExp(`^<Subject ${i + 1}> is [^<,;]+ in <Picture ${want}>`).test(para)) issues.push(`subject ${i + 1} (${r.id}) does not cite its picture right after its name`);
      if (cited.has(want)) issues.push(`<Picture ${want}> is cited by subjects ${cited.get(want)} and ${i + 1}`); else cited.set(want, i + 1);
      if (!attached.includes(want)) issues.push(`<Picture ${want}> is not an attached picture`);
    } else if (cites.length) issues.push(`subject ${i + 1} (${r.id}) has no picture but cites <Picture ${cites[0]}>`);
  });
  for (const [name, text] of Object.entries(sections)) {
    if (name === 'subject_definitions') continue;
    for (const m of String(text).matchAll(/<Picture (\d+)>/g)) issues.push(`${name} cites <Picture ${m[1]}>; only subject_definitions may`);
  }
  const ret = String(sections.retention_analysis).split('\n').filter(Boolean);
  if (ret.length !== references.length || ret.some((l, i) => !l.startsWith(`<Subject ${i + 1}>:`))) issues.push('retention_analysis is not exactly one subject line per subject');
  return issues;
}
