<!-- planner.md: canonical copy lives HERE (the extender). Evaluated verbatim from h3-prompt-studio/src/lib/chapterBreakdown.ts CHAPTER_BREAKDOWN_TEMPLATE (Studio HEAD 56aa415, file last changed 02391d9).
     The Studio carries a sync test against this file. Edit here and in the Studio together; this comment block is stripped before use. -->
Break the chapter below into fixed 15-second video clips, each built from 3-6 shots.

RULES — a clip is one continuous narrative beat; a shot is one discrete camera angle inside it.

- Every clip is exactly 15 seconds of shots (they must sum to 15, plus or minus half a second).
- 3-4 shots per clip by default. Only use 5-6 when the beat truly demands rapid cuts. Never fewer than 3, never more than 6.
- Follow a setup -> action -> reaction -> payoff arc, compressed to fit the shot count: shot 1 establishes where/who/what state; the middle shot(s) carry the action that moves the beat forward; the last shot is the reaction or the payoff — usually a line of dialogue, a held look, or a final gesture.
- Vary the camera between consecutive shots in the SAME clip — never the same camera term twice in a row.
- One action per shot. If a character does two distinct things, that's two shots.
- Dialogue gets its OWN shot (or is attached to the payoff shot) — never buried inside a multi-action shot. Dialogue is in the target language/script only, verbatim, no translation or gloss.
- End every clip with tension, a question, or a forward pull into the next clip — the last shot should make the audience need the next 15 seconds.
- No shot should require having seen a previous clip to make sense — each clip is visually self-contained.
- Camera per shot must be exactly one of these terms (spelled verbatim, snake_case): wide_establishing, medium, medium_close, close_up, extreme_close_up_macro, tracking_following, over_the_shoulder, top_down_overhead, low_angle, high_angle.

{{runtimeInstruction}}

STATE LEDGER — before writing the clips, propose a small ledger of what actually CHANGES visibly during this chapter:
- One entry per character, prop, creature, or location-as-environment whose visible state changes (wardrobe, condition, possession, consciousness, restraint for people; configuration, integrity, fill, activation for objects/environments — a lamp lit or not, a door open or not). Do NOT track a permanent trait as an axis, and do NOT invent an entity with nothing that changes.
- Each entity declares its own small set of axes, each axis a short ordered list of options (least to most, for anything that can only move one way — an injury does not heal mid-chapter) and whether it is progressive (can never move backwards) and whether it would show on that entity's own reference plate (wardrobe, a visible marking — never posture or mood).
- Give every entity its value on every one of its own axes at the chapter's OPENING, before clip 1.
- Then, per clip, list ONLY the state changes that actually happen in THAT clip (which entity, which axis, its new value, and which shot causes it) — never restate a value that did not change, and never repeat earlier clips' changes.

CHAPTER:
{{chapter}}

Return the breakdown as data: the state ledger first (entities, their axes, their opening values), then every clip in order with its beat, its shots (camera, subject, the physical action, and — only on the shot where someone actually speaks — the speaker and their exact line), its own state changes if any, and the forward pull that closes it.