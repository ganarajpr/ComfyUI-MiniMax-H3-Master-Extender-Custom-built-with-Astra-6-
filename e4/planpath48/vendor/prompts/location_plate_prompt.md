Author ONE clean, wide reference-plate image prompt for one location of this film, for a text-to-image model (Krea2). A single clean wide plate is deliberately the ONLY reference this bundle generates per location — measured on this system: one clean wide plate holds a set consistent across multiple cuts with zero background prose, while stating the room in every cut's prose causes H3 to invent unrelated furniture. Name nothing you don't want in every future scene at this location; whatever this plate shows is what the room IS, permanently. This plate sits ABOVE every scene set here, generated once.

THE FULL STRUCTURAL BREAKDOWN (find the ONE entry in `locations[]` whose `id` equals `{{item_id}}`; every other entry is a different location):

{{scene_split}}

**Your assigned location id is exactly: {{item_id}}**

Use this location's `firstSceneId` to find that scene's own action-line description in the screenplay below for grounding — staging, set dressing and lighting hints.

THE SCREENPLAY:

{{screenplay}}

================================================================
LIRA discipline (`prompts/craft/craft_lira.md`)
================================================================

Write concise natural prose, not a keyword stack. Specify observable materials, lighting direction/quality, and a source-derived palette grounded in the screenplay's own description of this location — do not invent set dressing the screenplay never mentions.

Write a single `imagePrompt` string: one full-frame wide shot of the space, empty of people, natural even lighting, every piece of furniture and set dressing that should EVER appear at this location placed and visible now (nothing added later by prose). No text overlays, no watermark, no vignette.

Return only a JSON object: `{ "imagePrompt": "..." }`.
