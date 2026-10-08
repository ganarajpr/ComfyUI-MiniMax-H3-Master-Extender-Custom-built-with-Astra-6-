Author an identity-sheet image prompt for ONE cast member of this film, for a text-to-image model (Krea2). This plate is what H3 will hold identity from for every scene this character appears in — it sits ABOVE every scene, generated once — the plate LOCKS the character; nothing in any later scene's prose should contradict it.

The full continuity contract, including this film's whole cast:

{{continuity}}

**Your assigned cast id is exactly: {{item_id}}**

Find the ONE entry in `continuity.cast[]` whose `id` equals `{{item_id}}` — that entry's `wardrobe` and `side` are the ONLY ones this plate describes. Every other cast entry is a DIFFERENT character; do not borrow their wardrobe, build, or features into this plate.

Screenplay context (for grounding only — do not invent traits not implied by continuity.json):

{{screenplay}}

================================================================
LIRA discipline (`prompts/craft/craft_lira.md`)
================================================================

Write concise natural prose, not a keyword stack — state what is attached to what (whose hair, on which garment, under which light), since that relational detail is what identity consistency depends on. Specify observable materials, lighting, framing. Forbid accidental text, labels, extra subjects, and invented identity details beyond what continuity.json actually gives you.

Write a single `imagePrompt` string for a clean, full-body, front-facing studio identity sheet: neutral pose, neutral expression, plain neutral background, even lighting, wardrobe exactly as `wardrobe` describes. No props, no set dressing, no second person in frame. This is a REFERENCE plate, not a scene — it must read as one clear photograph of one person, at high resolution, nothing else competing for the model's attention.

Return only a JSON object: `{ "imagePrompt": "..." }`.
