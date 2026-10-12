# vendor provenance

Copied verbatim on 2026-10-07 from the box (`ssh h3box`):
`C:\Users\user\Projects\ComfyUI_windows_portable\ComfyUI\custom_nodes\ComfyUI_MiniMax_H3_Master_Extender\`
git HEAD `41fb9f4d2bf33c4101556edf984490065b964a92` (Tue Oct 6 17:44:45 2026 +0530).

| file | role |
|---|---|
| `story_planner.py` | Python port of the Prompt Studio's chapter-breakdown planner (template filling, output shape, continuity rule, REFS rule, checks, retry). `planpath/planner.mjs` mirrors it function for function. |
| `prompts/planner.md` | the Studio's CHAPTER_BREAKDOWN_TEMPLATE, verbatim. Used byte for byte (header comment stripped like `load_prompt`). |
| `prompts/builder.md` | the extender's in-production ref2va writer system prompt. NOT used by E4 (E4 keeps the hybrid3 writer on the production `shot_prose.md` rules for comparability with E0/E2/E3); kept for the difference note in `E4-FROZEN.md`. |
| `prompts/shot_prose.md` | copy of `~/.kshana/bundles/h3_film/prompts/shot_prose.md` (the production shot_prose rules hybrid3 uses). |

The files in `story_planner.py`, `prompts/planner.md` and `prompts/builder.md` are byte-identical to the copies in the session scratchpad `ext/` directory (sha256 checked). Hashes are listed in `E4-FROZEN.md`.

Also copied on 2026-10-07 from `~/.kshana/bundles/h3_film/` (the h3_film bundle, unchanged): `prompts/acting_master.md`, `prompts/character_sheet_prompt.md`, `prompts/location_plate_prompt.md`, `prompts/object_anchor_prompt.md`, `schemas/acting_master.schema.json`. The bible prompt (`planpath/bible.mjs`) quotes the ACTING contract and the LIRA-discipline paragraphs from these files programmatically, and validates each acting master against the schema file.

E4.2 addition (2026-10-07): `prompts/plate_skill_system.md` is the system prompt of the stored skill `~/.claude/skills/intricate-location-plate/SKILL.md`, section "Having the local model do the rewrite", copied verbatim (the text inside the fenced block). `planpath/refslots.mjs` sends it, unchanged, as the system prompt of the comparison mode (`--refwriter llm`) for a location. A test compares it with the skill file when that file exists.
