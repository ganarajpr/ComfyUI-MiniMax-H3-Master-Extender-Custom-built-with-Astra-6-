# Changelog

## Unreleased

- **Plan more**: raising `auto_clips` past the existing clip count plans only the new clips after the existing ones (continuation block, carried ledger state, numbering from the next clip). The planner's end-of-clip state is stored on each planned clip as `plan_end_state`.
- **Fix**: logging model or user text (an en dash, Devanagari...) raised UnicodeEncodeError on a cp1252 console. Our loggers now pass every record through `ConsoleSafeFilter` (typographic punctuation to ASCII, the rest as \\uXXXX); the panel and the stored clips keep the real Unicode.
- `planner_refs` (images / captions / off, default images): the story planner sees the reference pictures (real image parts on the writer server, or caption lines) with a stage-only-with-these rule kept outside `prompts/planner.md`; videos are captions only.
- **Default rewrite system prompt is now the H3 Prompt Studio builder** (`prompts/builder.md`) when `rewrite_system_prompt` and `rewrite_system_prompt_in` are both empty and the task is Ref2VA. T2VA keeps MiniMax's official guide (the builder is written for ref2va). `@official` in the widget selects the official guide everywhere. Old workflows with an empty system prompt get the builder for clips rewritten from now on; already rewritten clips are kept.
- `auto_clips` (INT, default 0) and the story planner: plan `rewrite_story` once into N 15 s clips (`prompts/planner.md`, run on the writer GGUF), flagged *planned* in the panel; "Replan from story" is the only way to plan again.
- `rewrite_story` (multiline STRING): a film-level story block for every clip's writer.
- `rewrite_previous_clips` gains `final prompts`.
- New inputs are appended last; the trailing JS-only `master_ui` value of older workflows is repaired on load (`auto_clips`).
- Example workflows updated; `Story_Builder` and `Story_Auto` added.
