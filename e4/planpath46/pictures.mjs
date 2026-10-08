// E4.4: reference pictures are numbered and cited at export time (issue dheeai/h3-prompt-eval#6).
// Official ref guide (h3-prompting/references/ref_guide.md 2.1 / 2.2): a picture that only defines a subject is cited INSIDE that
// subject's definition ("<Subject 1> is NAME in <Picture 1>, ..."), with no standalone picture line. retention_analysis keeps
// its subject lines. Pictures are numbered 1..N in subject order over the entities that HAVE a reference image; described-only
// and voice subjects get none. Nothing upstream (planner, bible, decisions, writer) knows about pictures, so no request changes.
import { join } from 'node:path';
import { existsSync } from 'node:fs';

export const isPictured = (ref) => ref.type !== 'voice' && !ref.noPicture;

// The ordered picture list of one clip: [{ picture, subject, entity, type, image }]. `images` maps entity id -> file path (optional).
export function pictureList(references, images = {}) {
  const out = [];
  references.forEach((r, i) => { if (isPictured(r)) out.push({ picture: out.length + 1, subject: i + 1, entity: r.id, type: r.type, image: images[r.id] || null }); });
  return out;
}

// Subject definitions are code-built paragraphs "<Subject k> is NAME, ..." joined by a blank line; the citation goes right after NAME.
export function citeSubjectDefinitions(subjectDefinitions, references, names) {
  const paras = String(subjectDefinitions).split('\n\n');
  if (paras.length !== references.length) throw new Error(`subject_definitions has ${paras.length} paragraphs for ${references.length} references`);
  const pics = pictureList(references);
  const byEntity = new Map(pics.map((p) => [p.entity, p.picture]));
  return paras.map((para, i) => {
    const r = references[i];
    if (!byEntity.has(r.id)) return para;
    const head = `<Subject ${i + 1}> is ${names[r.id]}`;
    if (names[r.id] === undefined || !para.startsWith(head)) throw new Error(`subject ${i + 1} (${r.id}) does not start with "${head}"`);
    return `${head} in <Picture ${byEntity.get(r.id)}>${para.slice(head.length)}`;
  }).join('\n\n');
}

// Entity id -> rendered image path <dir>/<entityId>_<seed>.png, seed = the first seed of refs.json; entities not in refs.json have none.
export function imageMap(refsJson, dir) {
  const out = {};
  for (const [id, e] of Object.entries(refsJson?.entities || {})) out[id] = dir ? join(dir, `${id}_${e.seeds[0]}.png`) : null;
  return out;
}

// The checks of the citation: every pictured subject cites exactly one Picture and the numbering is consistent.
// `sections` is { subject_definitions, retention_analysis, ... } as written; `pictures` is pictureList(references).
export function checkPictureCitations({ references, sections, pictures, refsJson = null, images = null }) {
  const issues = [];
  const subj = String(sections.subject_definitions).split('\n\n');
  if (subj.length !== references.length) issues.push(`subject_definitions has ${subj.length} paragraphs for ${references.length} references`);
  const expected = pictureList(references);
  if (JSON.stringify(pictures.map((p) => [p.picture, p.subject, p.entity])) !== JSON.stringify(expected.map((p) => [p.picture, p.subject, p.entity]))) issues.push('the picture list does not match the pictured subjects in subject order');
  if (pictures.some((p, i) => p.picture !== i + 1)) issues.push('picture numbers are not 1..N');
  subj.forEach((para, i) => {
    const cites = [...para.matchAll(/<Picture (\d+)>/g)].map((m) => Number(m[1]));
    const r = references[i];
    if (!r) return;
    if (!para.startsWith(`<Subject ${i + 1}> is `)) issues.push(`subject paragraph ${i + 1} does not start with <Subject ${i + 1}> is`);
    const want = pictures.find((p) => p.subject === i + 1);
    if (want) {
      if (cites.length !== 1) issues.push(`subject ${i + 1} (${r.id}) cites ${cites.length} pictures, expected exactly 1`);
      else if (cites[0] !== want.picture) issues.push(`subject ${i + 1} (${r.id}) cites <Picture ${cites[0]}>, expected <Picture ${want.picture}>`);
      if (!new RegExp(`^<Subject ${i + 1}> is [^<,;]+ in <Picture ${want.picture}>`).test(para)) issues.push(`subject ${i + 1} (${r.id}) does not cite its picture right after the name`);
    } else if (cites.length) issues.push(`subject ${i + 1} (${r.id}) has no reference image but cites <Picture ${cites[0]}>`);
  });
  for (const line of Object.values(sections).join('\n').split('\n')) if (/^<Picture \d+>/.test(line.trim())) issues.push(`standalone picture line: ${line.trim().slice(0, 60)}`);
  const ret = String(sections.retention_analysis).split('\n').filter(Boolean);
  if (ret.length !== references.length || ret.some((l, i) => !l.startsWith(`<Subject ${i + 1}>:`) || /<Picture/.test(l))) issues.push('retention_analysis is not exactly one subject line per subject');
  const maxN = pictures.length;
  for (const [name, text] of Object.entries(sections)) if (name !== 'subject_definitions') for (const m of String(text).matchAll(/<Picture (\d+)>/g)) if (Number(m[1]) < 1 || Number(m[1]) > maxN) issues.push(`${name} cites <Picture ${m[1]}> outside 1..${maxN}`);
  if (refsJson) for (const p of pictures) if (!refsJson.entities?.[p.entity]) issues.push(`pictured subject ${p.entity} has no reference prompt in refs.json`);
  if (images) for (const p of pictures) if (!p.image) issues.push(`no image path for ${p.entity}`); else if (!existsSync(p.image)) issues.push(`image missing: ${p.image}`);
  return issues;
}
