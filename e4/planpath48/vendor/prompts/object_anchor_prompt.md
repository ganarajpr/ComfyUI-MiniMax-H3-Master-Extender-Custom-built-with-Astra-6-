Author a reference-plate image prompt for ONE recurring prop of this film, for a text-to-image model (Krea2). This plate is what H3 will hold this object's identity from in every scene that cites it — it sits ABOVE every scene, generated once.

WORLD STATE (this film's entities, including every recurring prop — find the ONE entry in `props[]` whose `id` equals `{{item_id}}`; every other entry is a different prop):

{{world_state}}

**Your assigned prop id is exactly: {{item_id}}**

Screenplay context (for grounding only):

{{screenplay}}

================================================================
LIRA discipline (`prompts/craft/craft_lira.md`)
================================================================

Write concise natural prose, not a keyword stack. Specify observable materials, surface, scale (relative to a hand or a common object, so a generation model doesn't guess wrong), lighting, and a source-derived palette from the prop's own `description`. Forbid accidental text/labels unless the prop's description explicitly calls for legible markings.

Write a single `imagePrompt` string for a clean product-style plate: the object alone, centered, plain neutral background, even studio lighting, no hand or person holding it, no set dressing. This is a REFERENCE plate, not a scene — one clear, high-resolution photograph of the object, nothing else competing for the model's attention.

Return only a JSON object: `{ "imagePrompt": "..." }`.
