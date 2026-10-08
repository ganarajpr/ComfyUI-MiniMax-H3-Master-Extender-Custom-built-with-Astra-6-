You are writing the permanent ACTING master profile for ONE recurring character of this film. Return one JSON object matching `schemas/acting_master.schema.json` exactly, with no extra fields.

## Inputs

The full continuity contract, including this film's cast (find the entry whose `id` equals `{{item_id}}` — that is the ONLY character you are profiling; every other cast entry is a different character and must not leak into this profile):

{{continuity}}

Screenplay context (for grounding only — do not invent traits the screenplay doesn't support):

{{screenplay}}

Write only `{{item_id}}`'s profile. This profile lives ABOVE every scene — it is generated once and cited by every scene this character appears in, exactly like their identity reference plate. It is a behavior source for later per-scene and per-shot adaptation, not a look sheet and not a shot prompt — do not describe wardrobe, camera, lighting, or plot.

## ACTING contract (`prompts/craft/craft_acting.md`)

`masterProfile` is one flowing English paragraph of 150–220 words. Deconstruct the character's body and objective engine, diagnose the pressure points that change their behavior, then develop concrete filmable choices. Keep every claim observable: posture, center of gravity, movement tempo, breath, hands, gaze, blinks, voice and reactions — never an emotion label ("anxious" is not filmable; a hand returning twice to a pocket is). Give the character a specific physical tell and explain how it changes under one named trigger. Include a social `mask` and an exact `crackTrigger`; the crack must be visible in the body or face. Every entry in `signatureTics` must pair one visible tic with its concrete trigger. Include continuous eye life: target changes, micro-saccades, realistic blinks, live catchlights and eyes leading the thought.

Do not write wardrobe, costume, camera, framing, lighting, color, shot design, or unfilmable psychology. Do not name an emotion as if it were an action; turn inner pressure into a physical marker. The profile must survive any scene's specific staging. **Do not paste this profile verbatim into a later scene or shot** — `acting_scene` and `shot_prompt` rewrite pieces of it into scene- and shot-specific observable behavior, never quote it whole.

`voicePrompt` is the fixed one- or two-sentence vocal identity: approximate age, origin or accent when relevant, timbre, register, pace and how the voice shifts under pressure. Keep it stable across every scene this character speaks in — a shot's dialogue tag establishes delivery using this same vocal identity, never a different one. `objectiveEngine`, `physicalBaseline` and `eyeLife` are concise reusable summaries of the same observable system. `softeningTarget` is optional and names at most one target.

Set `characterId` to `{{item_id}}` verbatim — the exact same id, copied back, not a name or a paraphrase.

Output only the schema-conforming JSON object: `{ "characterId": "{{item_id}}", "masterProfile": "...", "voicePrompt": "...", "objectiveEngine": "...", "physicalBaseline": "...", "eyeLife": "...", "signatureTics": [...], "mask": "...", "crackTrigger": "..." }`. Do not return Markdown or commentary.
