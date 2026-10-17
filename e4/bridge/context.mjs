// The writer's and the reference repair's context for a long film. Engine-independent: it reads only the plan, the asks and the story; the token estimate comes from the
// transport of the engine in use (E4_PLANPATH, set by run.mjs and the job's environment; planpath410 when unset).
const { estimatePromptTokens } = await import(`../${process.env.E4_PLANPATH || 'planpath410'}/transport.mjs`);

export const WRITER_CONTEXT_TOKENS = 14000;   // past this the writer's story + film plan are windowed
export const NEAR_CLIPS = 3;            // clips this near the one being written are quoted in full
const tokens = (text) => estimatePromptTokens([{ role: 'user', content: String(text ?? '') }]);
const sliceOf = (story, part) => String(story).slice(part.start, part.end).trim();

// -> null when the full context fits the budget (the caller then builds exactly what E4.10 builds), else { screenplay, storyText }
export function writerContext({ plan, rawAsks, story, clipNumber }) {
  const asks = rawAsks.join('\n\n');
  if (tokens(asks) + tokens(story) <= WRITER_CONTEXT_TOKENS) return null;
  const part = (plan.parts || []).find((p) => clipNumber >= p.first && clipNumber <= p.last);
  const storyText = part ? sliceOf(story, part) : String(story).trim();
  const ordered = [...plan.clips].sort((a, b) => a.clip - b.clip);
  const items = ordered.map((c, i) => {
    const near = Math.abs(c.clip - clipNumber) <= NEAR_CLIPS;
    if (c.clip === clipNumber) return `>>> THIS CLIP <<<\n${rawAsks[i]}`;
    return near ? rawAsks[i] : `Clip ${c.clip}: ${String(c.beat || '').trim()}`;
  });
  const screenplay = `The film is told in ${plan.clips.length} clips that play back to back as one continuous film. Only clip ${clipNumber} is yours to write; the others are written separately (do not write them, do not import their action). Clips more than ${NEAR_CLIPS} away from yours are given by their beat only.\n\n${items.join('\n\n---\n\n')}`;
  return { screenplay, storyText };
}

// the story and the plan quoted in a reference-slot repair for ONE entity
export function refContext({ story, rawAsks, plan, ent }) {
  if (tokens(rawAsks.join('\n\n')) + tokens(story) <= WRITER_CONTEXT_TOKENS) return { story, rawAsks };
  const entity = plan?.ledger?.entities?.find((e) => e.id === ent.id);
  const wanted = entity?.clip_ids?.length ? entity.clip_ids : [];
  const hit = (plan?.clips || []).map((c, i) => ({ c, i })).filter(({ c, i }) => wanted.includes(c.clip) || String(rawAsks[i] || '').toLowerCase().includes(String(ent.name || ent.id).toLowerCase()));
  const picked = (hit.length ? hit : (plan?.clips || []).map((c, i) => ({ c, i }))).slice(0, 6).map(({ i }) => rawAsks[i]);
  const first = hit[0]?.c?.clip;
  const part = (plan?.parts || []).find((p) => first >= p.first && first <= p.last);
  return { story: part ? sliceOf(story, part) : String(story).slice(0, 6000), rawAsks: picked };
}
