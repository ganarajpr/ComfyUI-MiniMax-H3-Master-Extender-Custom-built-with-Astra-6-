Author the PROSE layer of the MiniMax H3 prompt for EVERY SHOT IN ONE SCENE of this film, in the OFFICIAL full-reference format, in a SINGLE call: `detailedDescription`, `summary`, `overallSoundscape`, `nonDiegeticMusic`, `performanceBeats`, and `duration`. The IDENTITY layer — `references[]`, `subjectDefinitions`, `retentionAnalysis` — was already authored by a SEPARATE call (`shot_references`) and deterministically validated by `h3.audit_shot_references` before this call ever started. It is given to you above, one entry per shot, and it is FACT: the `<Subject N>` labels, their order, how many there are, and what each one is are FIXED — you cannot add a subject, remove one, renumber one, or invent a plate that isn't already there. Your job is only the action, camera, sound and dialogue that use those given labels. A deterministic audit runs immediately after this call (`h3.repair_shot`, then `h3.audit_shot` again, both in scene-batch mode, against the MERGED reference+prose document) and BLOCKS THIS SCENE'S RENDER on any violation below, PER SHOT — every rule here is something the audit actually checks, mechanically, per shot, with no judgement calls. Read all of it before writing.

**YOUR assigned scene id is exactly: {{item_id}}**

<!-- DATA BLOCKS — llm.generate substitutes ONLY double-brace variables; it does NOT append ctx.inputs.
     Without these the prompt's every reference to data 'above' is empty and the model
     invents a film. Measured 2026-09-02: it authored 10 shots for a 1-shot scene citing
     plates (mrs_vale, kitchen_window) from no film at all. -->

================================================================
THE REFERENCE LAYER ALREADY DECIDED FOR THIS SCENE — references[], subjectDefinitions and retentionAnalysis per shot. These are FIXED FACTS: the only <Subject N> labels that exist are the ones here.:

{{shot_references}}

================================================================
THE FULL STRUCTURAL BREAKDOWN — chapters, locations, scenes[] (find YOUR scene by id) and the flat film-wide shots[]:

{{scene_split}}

================================================================
THE CONTINUITY CONTRACT — cast ids, sides, wardrobe, language, forbidden words:

{{continuity}}

================================================================
THE FILM'S WORLD STATE — entities, props, locations and per-character state variants across the whole timeline:

{{world_state}}

================================================================
THIS SCENE'S OWN DIRECTION SHEET — camera, framing and escalation per beat:

{{scene_direction}}

================================================================
THIS SCENE'S OWN PER-CHARACTER ACTING ADAPTATION:

{{acting_scene}}

================================================================
EACH CAST MEMBER'S PERMANENT ACTING PROFILE, keyed by continuity.cast[].id:

{{acting_master}}

================================================================
THE SCREENPLAY:

{{screenplay}}

================================================================
THE NARRATIVE SEED (which source this film started from):

{{narrative_seed}}

================================================================


⚠ **The shots you write prose for are exactly and only the ids in `shot_references`'s own `shots[]` above, in the same order.** Do not add a shot, drop one, or reorder them — `h3.merge_shot` fails loudly if your `shots[]` ids don't match `shot_references`'s exactly, one-to-one.

⚠ **Every `<Subject N>` token you write must refer to the GIVEN `references[]` from `shot_references` above — never renumber, never invent a `<Subject N>` beyond that shot's own given `references[].length`.** If a given shot has 2 references, the only legal labels anywhere in your prose for that shot are `<Subject 1>` and `<Subject 2>`. `<Subject N>`'s number is FIXED by its position in the GIVEN `references[]` array — `references[0]` is always `<Subject 1>` for that shot, `references[1]` is always `<Subject 2>`, and so on, no matter which one you introduce first in prose or which one speaks first. Before writing `(S<n>) says: <d>...`, do this lookup explicitly: find the speaker's `id` in the ledger line, find that SAME id's position in the GIVEN `references[]` array (1-based), and cite exactly that `<Subject k>`. (`h3.longmedia`, the actual render runner, later RENUMBERS every shot's local `<Subject N>` onto the whole scene's global reference order — that renumbering is mechanical and happens after you return, so keep your OWN local numbering internally consistent and let the renumbering worry about the scene.)

================================================================
RULE 1 — DIALOGUE EXISTS ONLY INSIDE A `<d>` TAG. NOWHERE ELSE, EVER.
================================================================

This is the single most important rule in this prompt and the most common way a shot gets blocked. Read it twice.

**Before writing each shot's own dialogue: re-read THAT shot's own `lineIds` from the breakdown above. You are authoring ONLY those line ids for THAT shot. If you find yourself about to write a `<d>` tag for any id not in that specific shot's own `lineIds`, stop — that line belongs to a DIFFERENT shot in this same scene (or a different scene entirely) and must not appear here, no matter how naturally it seems to follow.**

H3 builds its audio track FROM THE PROSE TEXT. If your prose says or implies that a character speaks — anywhere, in any sentence, in any tense — and those exact words are not wrapped in a `<d>` tag right there, H3 synthesises a voice saying NOTHING: voice-shaped noise, like a corrupted audio file. This is measured, not theoretical. Describing a trembling voice with no words produces a trembling voice saying nothing. A denial doesn't save you either — "she does not speak," "he stays silent," "without a word" written NEAR a speech verb still reads as asserting speech to the model that renders it. If a beat is genuinely wordless, do not use any speech-shaped language near it at all — write "her lips stay closed" instead of "she says nothing." **Do not combine the two** — "She does not speak, her lips stay closed" still contains the word "speak" and still trips the check even though the second half is the correct phrase. Write ONLY "her lips stay closed" (or an equivalent physical description with zero speech-shaped words anywhere in the same sentence) and stop there.

Concretely, this means:

- **Never narrate that someone speaks, is about to speak, or has spoken, unless that exact sentence also contains the `<d>` tag for it.** Do not write "X tells Y that..." or "X mentions..." or "X asks whether..." and then either omit the `<d>` tag or put it somewhere else in the paragraph. The speech verb and the `<d>` tag are ONE unit — they appear together, in the same clause, or not at all.
- **Never write ANY phrase describing readiness, preparation, or anticipation of speech, however worded — this is a PATTERN, not a fixed list.** "waiting for her to speak", "before he speaks", "before he continues", "as she prepares to speak", "gathering herself to answer", "readying his reply", "about to respond" — every one of these uses a speech verb (or a clear paraphrase of one — "prepares," "readies," "gathers herself," "about to" all count when paired with any verb of speaking) with no adjacent `<d>` tag, and blocks the shot exactly like any other untagged speech verb. The check is a blunt word match, so a NEW phrasing you invent that still uses one of the banned words (see the full list below) will ALSO trip it — there is no clever rewording that keeps the word and avoids the block. Describe pure physical stillness/attention instead: "his gaze fixed steadily on her, attentive and still," "her breath steadies, her eyes finally lifting to meet his" — physical detail only, with zero speech-adjacent vocabulary anywhere near it, even to describe the moment just before a line.
- **Never summarize, paraphrase, foreshadow, or preview the CONTENT of a line in plain narration — not even once, not even briefly — whether that line belongs to this shot or a DIFFERENT shot.** If a ledger line's meaning is "she is leaving the city tomorrow," you may not write "she tells him she is leaving the city tomorrow" as narration; that content may appear ONLY inside its own `<d>` tag, verbatim, exactly where its `(Sn)` speaker marker sits. This is true even for a line assigned to a shot other than this one — do not hint at, allude to, or set up what a future or past shot's line says.
- **Only ever cite the ledger line ids listed in THIS shot's `lineIds`.** If `lineIds` is empty, this shot has zero `<d>` tags and zero speech verbs of any kind — write it as a pure action/reaction beat with no dialogue language at all.
- Every ledger line this shot IS licensed to speak must appear as `<Subject k> (S<n>) says: <d>[Language] EXACT LEDGER TEXT</d>`, in the same order as `lineIds`, with the identifying phrase, action and vocal delivery (age, register, pace, accent) OUTSIDE the tag and ONLY the language tag + verbatim words INSIDE it. **The literal token `<Subject k>` must be written DIRECTLY in the speaking sentence itself, immediately before the speech verb — never replaced with a pronoun ("she", "he") even if you already named `<Subject k>` earlier in the paragraph.** Write "`<Subject 1>` looks up and says: `<d>...</d>`", never "She looks up and says: `<d>...</d>`" — a pronoun-only reference is too far from the tag for the audit to attribute it, and the shot is blocked (DIALOGUE_NO_SPEAKER) even though a human reader would understand who is speaking.
- **`(S<n>)` is NOT optional decoration — it is checked separately from `<Subject k>` and a missing one blocks the shot on its own (DIALOGUE_MISSING_SPEAKER_ID), even when `<Subject k>` attribution is otherwise perfect.** Every spoken line needs BOTH: `<Subject k>` (which subject) AND `(S<n>)` (which voice), written together as `<Subject k> (S<n>) says: <d>...</d>`. To pick the right `n`: read `{{dialogue_ledger}}` in order (it is already in script order) and assign `(S1)` to whichever character's `id` speaks FIRST across the WHOLE FILM, `(S2)` to the next character who speaks for the first time, and so on — a character keeps the SAME number in EVERY shot they speak in, even shots authored by a different call than this one. Getting this wrong is checked film-wide (SPEAKER_ID_INCONSISTENT) even if it looks fine in isolation.
- **Vocal identity (age, register, pace, accent) must be stated in words, near the tag — not implied.** "his voice low and measured, unhurried in pace" or "her tone warm and even, a steady mid-register voice" — a real, specific phrase, in the same sentence or the one just before the `<d>` tag. Pull this from that character's `voicePrompt` in `acting_master` above, adapted to fit the sentence, not copied as a fragment. A speaking line with zero such phrasing nearby is blocked (DIALOGUE_MISSING_VOCAL_IDENTITY) — this is not a nice-to-have, the official guide states plainly that without it "H3 picks a voice at random and drifts," which breaks continuity for a character across shots.
- **Never use a speech verb to refer BACK to dialogue that was already spoken and tagged earlier in the same shot** — "throughout the utterance", "after she finishes speaking", "once he stops talking" all trip the same block as an untagged NEW line. Describe the aftermath in purely physical terms instead: "she holds the gaze", "a beat of stillness follows", "the moment settles" — never a word from the banned list below, even in the past tense, even referring to a line already inside its own `<d>` tag.
- `overall_soundscape` carries **zero** voice-adjacent language, from this EXACT banned list, in ANY sense, even describing a purely ambient/non-human sound: voice, whisper, whispers, whispered, murmur, murmurs, murmured, shout, shouts, word, words. **"The low murmur of the city" is BANNED even though no person is speaking** — the word itself is what triggers it, not the meaning. Use "hum," "rumble," "drone," or "distant traffic noise" instead of "murmur." If a sound is genuinely vocal, it belongs in `detailed_description` as a proper `<d>` tag, never described in `overall_soundscape` at all.

Before you submit, re-read your own `detailedDescription` and ask: does any sentence use a speech verb without an adjacent `<d>` tag for that exact utterance? If yes, delete the narration or add the tag — do not leave both.

**Attribution is mechanical: the audit believes whichever `<Subject N>` token appears LAST before your `<d>` tag is the speaker.** This means the speaking sentence must contain EXACTLY ONE `<Subject N>` token — the speaker's own — and NO other subject's `<Subject N>` token anywhere in it. Refer to anyone else in that same sentence (who the speaker is looking at, addressing, sitting beside) with a plain pronoun (her/him/them), NEVER their `<Subject N>` token — everyone's `<Subject N>` was already introduced in the given `subjectDefinitions` above, so a pronoun is unambiguous to a reader and invisible to the attribution check.

**WRONG (blocks the shot — two Subject tokens in the speaking sentence):**
`<Subject 2> looks toward <Subject 1>, his gaze steady, and says: <d>[English] You're really doing it.</d>`
— the last `<Subject N>` token before `<d>` is `<Subject 1>`, so the audit attributes the line to `<Subject 1>`, which is wrong. Reordering the sentence does not reliably fix this — the safest fix is to remove the second token entirely.

**RIGHT (the same beat, one Subject token, pronoun for the other person):**
`<Subject 2> looks toward her, his gaze steady, and says: <d>[English] You're really doing it.</d>`
— only `<Subject 2>`'s own token appears in this sentence; "her" refers to the other character without introducing a second `<Subject N>` token near the tag. This is DIFFERENT from Rule 1's earlier requirement that the SPEAKER's own token (not a pronoun) sits right before "says" — that rule is about the speaker only; every OTHER person mentioned in that same sentence uses a pronoun. **This includes the POSSESSIVE form** — "meets `<Subject 2>`'s gaze" still writes the literal `<Subject 2>` token (with an 's attached), and the audit sees it exactly the same as a bare mention: it becomes the last token before the tag and mis-attributes the line. Write "meets his gaze" instead of "meets `<Subject 2>`'s gaze" — the token itself must not appear in ANY grammatical form (bare, possessive, or otherwise) for anyone except the speaker, anywhere in that sentence. A recurring exact trap: **"meets `<Subject 2>`'s gaze and says"** — this specific phrase has caused this exact mis-attribution before. Write "meets his gaze and says" or "holds his gaze and says" instead — same meaning, zero risk, because "his"/"her" is never mistaken for a Subject token. This is not limited to "meets ... gaze" -- ANY verb of looking/turning/facing followed by the other person's Subject token has the identical problem: "looks at <Subject 2>", "looks toward <Subject 2>", "looks directly at <Subject 2>", "turns to <Subject 2>", "faces <Subject 2>", "regards <Subject 2>" all put that token right before "says" and mis-attribute the line. The fix is always the same, no matter which verb: replace the OTHER person's Subject token with him/her/them. "Looks directly at him and says" -- never "Looks directly at <Subject 2> and says."

**The exact word list the audit scans for, so you can check precisely** — every one of these, in ANY sense, anywhere it appears without a `<d>` tag in the same sentence, blocks the shot: say, says, speak, speaks, spoke, answer, answers, ask, asks, reply, replies, tell, tells, add, adds, explain, explains, mention, mentions, mentioning, respond, responds, utter, question, questions, deliver, delivers, emphasise, emphasizes, affirms, assures, declares, announces, invites, urges, promises, reminds, introduces, initiates, concludes, voiceover. **This is a blunt string match with no understanding of meaning** — it fires on "her delivery was calm" (not about speech at all) exactly as hard as "she delivers the line". Avoid EVERY one of these words entirely outside a `<d>` sentence, even for an unrelated meaning — use "her performance was calm" instead of "her delivery was calm", "the shot ends" or "the scene settles" instead of "the scene concludes", "gives" instead of "delivers" for a non-speech action. This includes describing HOW a line lands cinematically — "to emphasize her isolation in the delivery" is banned too; write "to emphasize her isolation in this moment" instead. It also includes the common idiom "speaks of" meaning "suggests" or "indicates" -- "a bracing that speaks of contained urgency" contains the whole word "speaks" and blocks the shot exactly as hard as literal dialogue narration. Use "suggests," "indicates," or "hints at" instead: "a bracing that suggests contained urgency."

================================================================
RULE 2 — `[Shot 1]` NEVER CARRIES A TIMESTAMP.
================================================================

- `[Shot 1]` — the shot's opening marker — is written exactly as `[Shot 1]` with nothing else attached to it. No "At 00:00.000", no time of any kind. **Every single shot has this marker, with NO exceptions — including a shot that is one continuous take with no internal cuts.** A `detailedDescription` with zero `[Shot N]` markers anywhere is invalid on its own (NO_SHOT_MARKER) regardless of how good the prose is otherwise. Write it as the first bracketed token, right where the action begins, after your one or two scene-setting sentences.
- Any LATER internal cut is written `[Shot N] At MM:SS.mmm, the shot cuts to ...` (N = 2, 3, ...), and each successive cut's time must be STRICTLY GREATER than the one before it, and less than or equal to this shot's `duration`.
- Use exactly one marker style throughout a shot: either one bare `[Shot 1]` and nothing else (a single continuous take), or `[Shot 1]` followed by one or more strictly-increasing timed `[Shot N] At MM:SS.mmm` cuts. Never omit `[Shot 1]` itself.

================================================================
RULE 3 — `duration` MUST BE ONE OF THESE EXACT VALUES.
================================================================

H3 only renders frame counts on the grid `frames = 17k + 5` at 24fps. Any other value gets silently snapped UP by the sampler, which desynchronises every timestamp you wrote in `detailedDescription` against the actual rendered length. **Do not just pick a "round" number of seconds and assume it is legal — check it against the table.** Most round numbers are NOT legal (5, 10, 15 and 20 seconds are all off-grid), but 8.0 seconds happens to BE legal (192 frames = 17×11+5) — it is the one coincidence on this list, not a pattern. Never reason "round numbers are illegal" or "round numbers are fine"; always match against the table below. Instead, compute how long your dialogue and action actually need (roughly: total spoken words ÷ 2.6 words/second, plus ~1s lead-in/tail per utterance, plus ~0.35s between separate lines, plus non-speech air for any internal cuts), then set `duration` to the CLOSEST value in this table, in seconds — copy the digits exactly, do not round further:

| seconds | | seconds | | seconds |
|---|---|---|---|---|
| 5.167 | | 9.417 | | 13.667 |
| 5.875 | | 10.125 | | 14.375 |
| 6.583 | | 10.833 | | 15.083 |
| 7.292 | | 11.542 | | 15.792 |
| 8.000 | | 12.250 | | 16.500 |
| 8.708 | | 12.958 | | 17.208 |
| | | | | 17.917 |
| | | | | 18.625 |
| | | | | 19.333 |

(20.0 is NOT on this list and is NOT legal — the nearest grid points are 19.333 and 20.042, and 20.042 exceeds this shot's maximum. If you need the longest possible shot, use 19.333.)

================================================================
RULE 4 — THE WORD FLOOR IS 350-500 WORDS. THIS IS THE OFFICIAL GUIDE'S OWN NUMBER, NOT A BUNDLE INVENTION.
================================================================

The official MiniMax H3 full-reference guide states `detailedDescription` is **350-500 English words for a generation task**, and adds explicitly: *"measured outputs land near 200 and that is too thin."* **The floor is `max(350, 120 × number_of_shot_markers)` words:**

- 1 cut (`[Shot 1]` only) → at least **350** words.
- 2 cuts → at least **350** words (120×2=240 is still under the guide's own floor).
- 3 cuts → at least **360** words.
- 4 cuts → at least **480** words.

**200 words will BLOCK the shot.** Do not write to exactly 350 — aim inside the guide's actual 350-500 range, e.g. 380-450, so a slightly-off manual word count still clears the floor. **Reaching 350+ words is NEVER a reason to include a line from a different shot.** If your own shot's lineIds only license one line (or none), the extra length comes ENTIRELY from richer coverage of the seven categories below — never from continuing the scene into the next character's line.

**Reach this length with SUBSTANCE, never padding.** The guide names exactly what a shot needs to cover to legitimately reach 350-500 words — treat this as a per-shot checklist, not a hope:

1. **Composition and framing** — the specific shot type (medium-wide, close-up, two-shot) and how it's arranged. Draw the shot type from `scene_direction.shots[]`'s own `cameraAngle` for this shot id — GIVEN FACT, not yours to redecide; `whyThisAngle` tells you what the framing is FOR, so let it shape how you write the composition, not just what you name it.
2. **Each subject's appearance AND position in frame** — not just "what they look like" but literally where they sit relative to the frame and to each other (frame left/right, foreground/background). Pull each subject's appearance straight from the GIVEN `subjectDefinitions` above — do not invent a different look.
3. **Environment and light** — the space itself, the quality and direction of light, how it changes if it does. Pull the escalation level from `scene_direction.shots[]`'s own `contrastLevel` for this shot when present, else from `sceneIntent`'s own statement of this scene's place on the film-wide curve.
4. **The action as a STATE CHANGE** — not a static description but what moves from one condition to another (a posture that shifts, a hand that stills, light that fades) — this is the single most common thing thin prose skips. Ground each present character's state change in `acting_scene.shots[]`'s own per-shot `stateChange`/`behaviours`/`lookingAt`/`interactingWith` for THIS shot id (GIVEN FACT, more specific than the scene-wide `characters[]` adaptation) — do not invent a different behaviour than what was already decided there.
5. **Camera motion** — using the controlled vocabulary (see below), matching `scene_direction.shots[]`'s own `cameraAngle` for this shot; `whatItShows` tells you what must actually be visible through that motion.
6. **The sound in that moment** — what's audible at each beat of the shot, described briefly in the action prose itself (distinct from the separate `overall_soundscape` section, which is the sustained ambient bed for the whole shot). Pull from `scene_direction.shots[]`'s own `soundAnchor` for this shot when present.
7. **Where each reference actually takes effect** — when a plate's identity/geometry becomes visible or relevant in the action, not just named once at the top.

A shot covering all seven per `[Shot N]` cut will clear 350-500 words naturally; a shot that only does 2-3 of these will pad with repetition to hit the count, which is worse than being short — write the substance, not the length. As a fast self-check before counting words: a shot that reaches 350+ words with real substance almost always has at least 14-16 full sentences (roughly two sentences per category, per cut) — a shot with 8-10 short sentences is very unlikely to clear the floor even when every category is technically touched once. **Default to two internal cuts for any shot with dialogue between two characters, unless `scene_direction.shots[]`'s own `function`/`cameraAngle` for this shot clearly calls for one continuous take** — a wide two-shot establishing both subjects and the line, then a closer reaction cut on the listening subject. **If this shot's own `lineIds` license only ONE line, the second cut must be SILENT** — a pure physical reaction shot on the listening subject, with zero dialogue and zero speech-shaped language of any kind. Do not let the second cut's reaction beat drift into that subject's own reply; their reply (if the ledger gives them one) belongs to a LATER shot's own call, authored separately. Budget it explicitly: aim for at least 90-110 words in the silent second cut alone.

================================================================
RULE 5 — `summary` OPENS WITH EXACTLY ONE OF THESE BRACKETED TAGS.
================================================================

Every shot in this bundle is reference-plate-driven generation, never an edit of an existing video, so `summary` must begin with the literal text `[reference generation]` followed by your one-paragraph summary using the GIVEN `<Subject N>` labels from `shot_references`. Do not invent a different bracketed tag and do not omit it. Introduce no new `<Subject N>` labels beyond what was given.

================================================================
RULE 6 — `performanceBeats`: THE ACTING LAYER. EVERY CHARACTER IN THE SHOT NEEDS ONE.
================================================================

Every entry in the GIVEN `references[]` (from `shot_references`) of type `"character"` that is physically present in this shot — speaking OR silent — needs at least one `performanceBeats` entry: `{ subjectId, tactic, observableBehavior }`.

- `subjectId` is that character's `continuity.cast[].id` (the same id used in the GIVEN `references[].id`), NOT a `<Subject N>` number.
- `tactic` is what they are TRYING TO DO in this shot, in filmable terms — never a bare emotion label. Not "feeling nervous"; instead "testing whether he'll actually answer honestly." Draw this from `acting_scene.characters[]`'s scene-wide `objective`/`obstacle` for this character, sharpened by their `acting_scene.shots[]` entry for THIS shot id (`behaviours`/`stateChange`) — the per-shot entry is what makes the tactic specific to this beat rather than a restatement of the scene-wide objective.
- `observableBehavior` is the concrete physical/vocal manifestation of that tactic in THIS shot specifically — posture, gaze, breath, tempo, a gesture. Pull it from `acting_scene.shots[]`'s own per-shot `behaviours`/`lookingAt`/`interactingWith`/`stateChange` for THIS character in THIS shot id — GIVEN FACT, already decided there — and write it into prose; do not re-derive a different behaviour from the scene-wide `physicalBusiness`/`bodyState`/`eyeLife` alone, and never copy any of these fields verbatim as a sentence — turn the given facts into observed prose.
- **The character you give a beat to must actually be written into `detailedDescription`** — if `performanceBeats` names a character, that character's `<Subject N>` token must appear in the prose, or the acting direction never reached the shot and the audit blocks it.
- A shot with zero character references (pure environment) may leave `performanceBeats` as an empty array.

================================================================
================================================================
Everything else
================================================================

- Restate each present character's side (left/right) and wardrobe explicitly in THIS shot — nothing carries over automatically from another shot.
- Every composition you describe must be photographable from the camera you stated — do not describe an action, prop, or framing the stated shot type cannot actually see.
- `nonDiegeticMusic` must be exactly the literal string `"N/A"` (the schema enforces this too, but never try to satisfy "no music" any other way, even if asked to elaborate — a denial like "no score plays" still instructs H3 to produce one).
- Name nothing in the room that is not already in the location reference plate (from the GIVEN `references[]`). The plate locks the set; the prose must not add to it or contradict it. This includes AMBIENT/ENVIRONMENTAL nouns in `overallSoundscape` too, not just visible objects in `detailedDescription` — a "distant hum from the street" invents a street the plate never showed. Before submitting, check every noun you named against `continuity.forbiddenWords` (given to you above) and cut or replace any match; prefer the vocabulary already in `continuity.allowPhrases` for ambient detail (e.g. "city lights", not an invented "street").
- **Every single `[Shot N]` cut needs at least ONE controlled camera-motion term, checked per cut, not just once for the whole shot:** Zoom In / Zoom Out, Push In, Pull Out, Pan Left / Pan Right, Truck Left / Truck Right, Tilt Up / Tilt Down, Pedestal Up / Pedestal Down, Arc Shot, Tracking Shot, Static Shot, Shake Slightly / Shake Strongly, POV, Roll Clockwise / Roll Counterclockwise — optionally "with small/large amplitude", "at slow/fast speed". **Spell a term EXACTLY as listed, as natural English inside the shot's own sentence** — "in a static medium shot" does NOT register as `Static Shot` (the audit only matches the literal phrase "static shot", so a paraphrase is invisible to it even though a human reader would understand it fine); "slow dolly forward" does not register as `Push In` either. A `[Shot N]` cut with no matching term anywhere in its own text blocks the shot (CAMERA_MOTION_MISSING), one finding per cut that fails.

SUBMISSION CHECKLIST — verify every line, FOR EVERY SHOT IN YOUR `shots[]` ARRAY, before you return JSON:

-1. **Does your `shots[]` array have exactly one entry per shot in `shot_references`'s own `shots[]` for this scene, in the same order, each carrying that shot's own `id`?** Not fewer, not more, not reordered.
0. **For EACH shot, separately: count the `<d>` tags you wrote in it. Does that count EXACTLY match the number of ids in THAT shot's own `lineIds` (from its own entry in the breakdown above) — not one more, not one borrowed from a sibling shot in this same scene?** If you wrote a line belonging to a different shot's own `id`, delete it now — a single misplaced line blocks this scene's whole render, even if everything else is correct.
1. Does `detailedDescription` contain the literal text `[Shot 1]`? (mandatory, even for one continuous take)
2. Does `detailedDescription` contain `<Pic` anywhere? (must be NO)
3. For every `<Subject k>` you wrote, does the GIVEN `references[k-1]` (from `shot_references`) actually name that same character/object/location? (recheck against the given array, in order — you are not deciding this numbering yourself)
4. For every ledger line you were licensed to speak, is there exactly one `<d>[Language] ...</d>` tag with the EXACT ledger text, positioned right after a `(S<n>)` marker?
5. Does any sentence use a speech verb (say, says, tell, speak, ask, mention, explain, reply, respond, ...) — including inside a denial — without an adjacent `<d>` tag for that exact utterance?
6. Is `duration` copied verbatim from the legal table above?
7. Does `summary` start with exactly `[reference generation]`?
8. Is `nonDiegeticMusic` exactly `"N/A"`?
9. Count the words in `detailedDescription` — is it comfortably inside 350-500, using `max(350, 120 × your cut count)` as the hard floor?
10. Does every GIVEN `references[]` entry of type `"character"` have at least one matching `performanceBeats` entry, and does every `performanceBeats.subjectId`'s `<Subject N>` actually appear in `detailedDescription`?
11. Does EVERY spoken line have BOTH `<Subject k>` AND `(S<n>)` before "says," with `n` consistent for that character across every shot they speak in?
12. Does EVERY spoken line have a real vocal-identity phrase (age/register/pace/accent) in words, near the `<d>` tag?
13. Does EVERY `[Shot N]` cut — each one separately — contain at least one exact controlled camera-motion term?
14. Is `(Sx)` numbering CONSISTENT across every shot in THIS array — the same character gets the same number in shot 3 as in shot 1, per the ledger's own first-speaking order?

If any answer is wrong, fix it before returning. Do not return an answer you have not checked against this list.

Return only the schema-conforming object.

================================================================
A COMPLETE WORKED EXAMPLE — study its SHAPE, never its CONTENT
================================================================

This example is illustrative only. Its characters, location, dialogue line, and reference ids are all invented for demonstration and have nothing to do with this film. Copy its STRUCTURE — how the JSON keys are used, how `[Shot N]` markers are written, where the `<d>` tag sits, which duration value was picked from the table above, how long the prose runs — never its words, names, or duration value. Your actual shot must use YOUR OWN ledger text, YOUR OWN continuity cast, and a duration computed for YOUR OWN dialogue.

GIVEN (from `shot_references`, NOT part of your output, shown only so the example reads coherently): shot `shot001` was given three references, in order — `<Subject 1>` = `example_woman` (young woman, denim jacket), `<Subject 2>` = `example_man` (man in his thirties, grey zip-up jacket), `<Subject 3>` = `rooftop_ledge` (the location) — each already covered by its own `subjectDefinitions` paragraph and `retentionAnalysis: fully_preserved` line.

YOUR OUTPUT for this same shot:

```json
{
  "sceneId": "scene01",
  "shots": [
  {
  "id": "shot001",
  "summary": "[reference generation] A late-afternoon two-shot on a rooftop ledge between <Subject 1> and <Subject 2>, holding on their exchange as the city skyline settles behind them, then closing in on <Subject 1> as she answers him.",
  "detailedDescription": "Warm late-afternoon light rakes across a rooftop ledge, the city skyline soft with haze behind a low concrete parapet. <Subject 1>, a woman in her late twenties with short dark hair, sits cross-legged near the parapet in a faded denim jacket, her posture relaxed but her hands restless in her lap, fingers picking at a loose thread on her sleeve. <Subject 2>, a man in his thirties in a grey zip-up jacket, stands a step back on frame right, one hand resting on the ledge, watching her with quiet attention, his weight settled evenly on both feet. The wide two-shot holds them both, <Subject 1> on frame left, <Subject 2> on frame right, the hazy skyline filling the space between and above them, the parapet's rough concrete texture visible along the bottom of the frame. [Shot 1] Static Shot. <Subject 2> (S1), his voice low and measured, unhurried in pace, leans slightly toward her and says: <d>[English] Are you sure you want to do this alone?</d> He waits, still watching her, his weight settling back onto his heels as the wind moves loose strands of her hair across her face. <Subject 1> looks down at her hands, then back up at the skyline, her jaw set in quiet resolve, her stillness deliberate rather than uncertain, the faded denim jacket catching the last warm light along one shoulder. [Shot 2] At 00:05.400, the shot cuts to a closer angle on <Subject 1> alone, Push In slowly on her face as the wide rooftop falls away behind her into a soft blur, the parapet and skyline reduced to a warm smear of colour. <Subject 1> (S2), her tone quiet and even, a steady, unhurried register, holds his gaze off-frame right and says: <d>[English] I already know what I'm doing.</d> Her expression stays steady throughout, unhurried, the light catching the edge of her jaw as her hands finally still in her lap, the restless picking at her sleeve now gone entirely. The camera holds on her for a long beat, Static Shot, the skyline's hum distant and unbroken beneath the quiet, before the shot settles into stillness, her decision visible in her face and posture alone, the last of the afternoon light fading almost imperceptibly across the concrete ledge beside her.",
  "overallSoundscape": "A steady rooftop wind, distant traffic hum rising faintly from below, the soft creak of a loose cable somewhere off-frame, fabric shifting as she resettles her hands.",
  "nonDiegeticMusic": "N/A",
  "duration": 10.125,
  "performanceBeats": [
    {
      "subjectId": "example_woman",
      "tactic": "holding a decision she has already made without needing his approval for it",
      "observableBehavior": "keeps her posture deliberately still, hands resting rather than fidgeting once she has spoken, gaze steady on the skyline before meeting his eyes"
    },
    {
      "subjectId": "example_man",
      "tactic": "testing whether she wants him to argue or just to witness",
      "observableBehavior": "leans in only slightly, keeps his weight even and his hand still on the ledge rather than reaching for her, watches more than he speaks"
    }
  ]
  }
  ]
}
```

(A real scene has one entry in `shots[]` for EVERY shot `shot_references` gave you — this example shows only one to keep it readable; do not stop at one shot yourself.)

Notice in the example: `example_woman` and `example_man` map to `<Subject 1>`/`<Subject 2>` EXACTLY as given, and both actually appear in `detailedDescription`; both dialogue tags carry BOTH `<Subject k>` AND `(S<n>)` — `<Subject 2> (S1)` speaks first, `<Subject 1> (S2)` speaks second, each number assigned in the order they first speak; both dialogue tags have a real vocal-identity phrase right next to them; each `[Shot N]` cut has its own controlled camera term inside its own text; `[Shot 1]` bare, `[Shot 2]` timed and strictly after it; `<Picture` appears nowhere; `nonDiegeticMusic` is the bare sentinel; `duration` (10.125s = 243 frames) is copied verbatim from the legal table, not rounded to 10; and the `detailedDescription` runs 378 words — inside the official 350-500 range. There is NO `references`, `subjectDefinitions`, or `retentionAnalysis` field in the output — those were GIVEN, not authored here. Match this shape exactly, with your own film's content, for EVERY shot this scene's breakdown assigns you.

---

FINAL CHECK BEFORE YOU EMIT: count your `shots[]` entries. Does that number equal the number of shots `shot_references` gave you for `{{item_id}}`, and is every id one of those same ids, in the same order? If not, delete the extras or add the missing ones now. Authoring prose for a shot `shot_references` didn't give you, or skipping one it did, is the single most common failure of this node.
