"""Story planner for the Master Extender's built-in rewriter.

A Python port of the one-call chapter-breakdown planner of the H3 Prompt Studio
(``h3-prompt-studio/src/lib/chapterBreakdown.ts``): one story in, exactly N
fixed-15s clips out, each a numbered shot list that reads as a clip's raw ask.
The prompt itself is ``prompts/planner.md`` (verbatim from the Studio; this repo
holds the canonical copy). Everything else here is the Studio's own contract:
the runtime instruction (auto / target N), the output shape, the lenient parse,
the checks (3-6 shots, shots sum to 15 s +-0.5, camera from the fixed list, the
state ledger's referential integrity) and ``format_clip_raw_ask``.

Pure functions only (no ComfyUI, no torch): the model call is a ``chat``
callable handed in by the rewriter, which runs it on the writer's llama-server.
"""

from __future__ import annotations

import base64
import copy
import json
import os
import random
import re

PROMPT_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "prompts")

CAMERA_SHOTS = [
    "wide_establishing", "medium", "medium_close", "close_up", "extreme_close_up_macro",
    "tracking_following", "over_the_shoulder", "top_down_overhead", "low_angle", "high_angle",
]
CAMERA_LABELS = {
    "wide_establishing": "Wide", "medium": "Medium", "medium_close": "Medium Close", "close_up": "Close Up",
    "extreme_close_up_macro": "Extreme Close Up / Macro", "tracking_following": "Tracking",
    "over_the_shoulder": "Over-the-shoulder", "top_down_overhead": "Top Down / Overhead",
    "low_angle": "Low Angle", "high_angle": "High Angle",
}
SHOT_MIN = 3
SHOT_MAX = 6
CLIP_SECONDS = 15
SECONDS_TOLERANCE = 0.5
DIALOGUE_WORDS_PER_SECOND_MAX = 2.2

OFFICIAL_SENTINEL = "@official"


# --------------------------------------------------------------------------- prompt files


def load_prompt(name: str) -> str:
    """A ``prompts/<name>.md`` body with its leading ``<!-- ... -->`` header stripped."""
    with open(os.path.join(PROMPT_DIR, name + ".md"), "r", encoding="utf-8", newline="") as handle:
        text = handle.read().replace("\r\n", "\n")
    if text.startswith("<!--"):
        end = text.index("-->")
        text = text[end + 3:]
        if text.startswith("\n"):
            text = text[1:]
    return text


# --------------------------------------------------------------------------- prompt filling


def runtime_instruction(mode: str, target_clips: int | None = None) -> str:
    if mode == "target" and target_clips and target_clips > 0:
        n = target_clips
        return (
            f"RUNTIME — TARGET, NOT A CEILING OR A FLOOR: this chapter must become EXACTLY {n} clip{'' if n == 1 else 's'} "
            f"of 15 seconds each ({n * 15}s total) — not one more, not one fewer. Reach EXACTLY {n} by covering the SAME "
            f"events at a finer or coarser grain — more or fewer clips, longer or shorter dwell on each beat — never by "
            f"inventing events the chapter does not contain, and never by compressing two distinct dramatic beats into one clip "
            f"or stretching one beat thin across several just to fill the count."
        )
    return (
        "RUNTIME — AUTO: decide how many 15-second clips this chapter genuinely needs, one clip per distinct dramatic beat. "
        "Do not compress two beats into one clip, and do not pad a single beat across several clips just to run longer. "
        "The clip count follows the STORY, not a target."
    )


def fill_template(template: str, chapter: str, mode: str = "auto", target_clips: int | None = None) -> str:
    return (template
            .replace("{{runtimeInstruction}}", runtime_instruction(mode, target_clips), 1)
            .replace("{{chapter}}", chapter.strip(), 1))


# The Studio passes the shape as a json_schema response_format. The rewriter's server path has no
# response_format, so the same shape rides in the message.
OUTPUT_SHAPE = """\

OUTPUT FORMAT — reply with ONE JSON object and nothing else (no prose, no code fence), in exactly this shape and key order:
{
  "chapter": "the chapter's own spine, one line",
  "ledger": {"entities": [
    {"id": "short_slug", "name": "...", "kind": "character|prop|creature|environment",
     "clip_ids": [1, 2],
     "axes": [{"axis": "wardrobe", "options": ["least", "...", "most"], "progressive": false, "plate_visible": true}],
     "initial": [{"axis": "wardrobe", "value": "one of that axis's options"}]}
  ]},
  "clips": [
    {"clip": 1, "beat": "the dramatic beat this clip covers, one line, no camera",
     "shots": [
       {"shot": 1, "seconds": 4, "camera": "one of the camera terms above, verbatim",
        "subject": "who or what is on screen, no camera language", "action": "the one physical action",
        "has_dialogue": false, "dialogue_speaker": "", "dialogue_line": ""}
     ],
     "forward_pull": "the tension, question or forward pull this clip closes on",
     "state_changes": [{"entity": "an entity id", "axis": "one of its axes", "to": "one of that axis's options", "shot": 2}],
     "end_state": {"location": "where the last frame is, with the spot in the set", "time_light": "time of day and light at the last frame",
                   "end_action": "the exact physical action or pose of the last shot's last second",
                   "characters": [{"name": "...", "position": "where in the set, facing which way", "wardrobe": "the full outfit, or: as on the reference",
                                   "props": "held, worn or carried objects, or: none", "state": "visible emotion or condition"}]}}
  ]
}
Each clip has 3-6 shots whose seconds sum to 15. "ledger.entities" may be an empty array when nothing visibly changes."""


# Kept out of prompts/planner.md (the Studio's template) like REFS_RULE. The template tells each clip to be
# "visually self-contained"; this is the one place the plan says the clips are a single continuous film.
CONTINUITY_RULE = (
    "CONTINUITY STATE \u2014 these rules sit on top of the template and win over its 'visually self-contained' line. The clips "
    "play back to back as ONE continuous film: clip N opens exactly where clip N-1 ended. For EVERY clip add \"end_state\": the "
    "state at that clip's FINAL frame \u2014 location (the spot inside the set), time_light, end_action (the exact physical "
    "action or pose of the last shot's last second) and, for every character on screen at that moment, position (where in the "
    "set, facing which way), wardrobe, props and state. Carry every field forward unchanged into the next clip unless a shot of "
    "that clip changes it: nobody changes clothes, loses a prop, heals, or moves between clips off screen. Only an explicit "
    "time or location cut that the beat itself names may open a clip somewhere else, and then say so in the beat. "
    "WARDROBE comes from the STORY, never from a reference picture: when the story says what a character wears at that point "
    "(or changes into), write the full outfit \u2014 garment, colour, fabric, trim, accessories \u2014 in every clip's end_state "
    "until the story changes it; when the story says nothing about that character's clothing, write exactly: as on the reference. "
    "A reference picture tells you who a character is (face, build, hair), not what they wear in the film."
)

OPENS_MARK = "CONTINUITY \u2014 THIS CLIP OPENS EXACTLY WHERE CLIP {n} ENDED:"
ENDS_MARK = "AT THE END OF THIS CLIP (the next clip opens exactly here):"


def output_shape(start: int = 1, second: int | None = None) -> str:
    """The OUTPUT FORMAT block, its example clip numbered ``start`` (and ``second``, for the ledger's clip_ids)."""
    second = start + 1 if second is None else second
    if start == 1 and second == 2:
        return OUTPUT_SHAPE
    return (OUTPUT_SHAPE.replace('{"clip": 1,', f'{{"clip": {start},', 1)
            .replace('"clip_ids": [1, 2]', f'"clip_ids": [{start}, {second}]', 1))


def build_user_message(story: str, target_clips: int, numbers: list[int] | None = None) -> str:
    first = numbers[0] if numbers else 1
    second = numbers[1] if numbers and len(numbers) > 1 else None
    return fill_template(load_prompt("planner"), story, "target", target_clips) + "\n\n" + CONTINUITY_RULE + output_shape(first, second)


def _spans(numbers: list[int]) -> str:
    """[4, 5, 6, 9] -> '4-6, 9'."""
    out, i = [], 0
    while i < len(numbers):
        j = i
        while j + 1 < len(numbers) and numbers[j + 1] == numbers[j] + 1:
            j += 1
        out.append(f"{numbers[i]}-{numbers[j]}" if j > i else f"{numbers[i]}")
        i = j + 1
    return ", ".join(out)


def more_block(more: dict) -> str:
    """Everything a continuation or plan-around call needs besides the template (kept out of prompts/planner.md):
    every clip in order (typed or planned ones verbatim, the ones to plan as '[TO PLAN: clip N]'), the state carried
    out of the existing clips, and the instruction. The tail case (clips to plan only after the last existing one)
    is just a gap at the end."""
    numbers = more["numbers"]
    x, k = numbers[0], len(numbers)
    tail = more.get("tail", False)
    spans = _spans(numbers)
    parts = [f"ALREADY IN THE FILM (do not re-plan, repeat or contradict) \u2014 the asks of clips 1-{x - 1}, in order:" if tail
             else "ALREADY IN THE FILM (do not re-plan, repeat or contradict) \u2014 every clip in order; the ones marked "
                  "TO PLAN are yours:"]
    for number, text in more["existing"]:
        if text is None:
            parts.append(f"[TO PLAN: clip {number}]")
            continue
        body = text.strip() or "(empty \u2014 nothing planned or typed here)"
        parts.append(f"--- Clip {number} ---\n{body}")
    carried = more.get("carried")
    if carried:
        lines = [f"STATE CARRIED INTO CLIPS {spans} (as of the end of clip {x - 1}). These are the OPENING values of your ledger: "
                 f"reuse these entity ids and set each entity's 'initial' to exactly these values (each value must be one of "
                 f"that axis's options):"]
        for eid, ent in carried.items():
            axes = ", ".join(f"{a}={v}" for a, v in ent["axes"].items())
            lines.append(f"{eid} | {ent['name']} ({ent['kind']}): {axes}")
        parts.append("\n".join(lines))
    else:
        parts.append("STATE \u2014 the existing clips have no ledger: derive the opening state of your ledger from where the "
                     "existing clips leave things.")
    if tail:
        parts.append(
            f"CONTINUATION \u2014 Plan exactly {k} more clip{'' if k == 1 else 's'}, numbered {spans}. Begin where clip {x - 1} ends "
            f"and carry the story forward from there; cover what the story has not yet covered. Number them {spans} in the JSON "
            f"('clip' fields and the ledger's clip_ids). The CHAPTER below is the whole film's story; clips 1-{x - 1} above already "
            f"cover its first part. Plan ONLY the {k} new clip{'' if k == 1 else 's'}."
        )
    else:
        parts.append(
            f"PLAN AROUND THE TYPED CLIPS \u2014 Plan exactly the clips marked TO PLAN (clip{'' if k == 1 else 's'} {spans}). "
            f"Each must bridge from the clip before it to the clip after it; never repeat or contradict a typed clip; the typed "
            f"clips' events are fixed. Use exactly those clip numbers in the JSON ('clip' fields and the ledger's clip_ids); "
            f"they need not be contiguous. The CHAPTER below is the whole film's story. Plan ONLY the {k} marked clip{'' if k == 1 else 's'}."
        )
    return "\n\n".join(parts)


# Kept out of prompts/planner.md on purpose: that file is the Studio's template, compared with it by the
# Studio's drift test. This rule exists only when the run has reference pictures.
REFS_RULE = (
    "REFERENCE RULE — These are the only characters, props and locations that have a reference picture. "
    "Stage the story with them: a character keeps the face, build and hair of their picture, a prop or location keeps its "
    "material and layout. A character's clothing comes from the story, not from the picture (the picture's outfit is only "
    "the fallback when the story is silent). Anything without a picture stays off screen or unseen. Name a subject by its "
    "Picture number the first time it appears in a clip's shots."
)
REFS_HEADER = "REFERENCES — the only subjects that have a reference (labelled in slot order):"

#: What the pack allows one picture on the server path (media.PATCH-pixel blocks, mtmd_engine.FRAME_MAX_TOKENS).
IMAGE_TOKENS_CAP = 768
IMAGE_PATCH = 28


def image_tokens(tensor, cap: int = IMAGE_TOKENS_CAP, patch: int = IMAGE_PATCH) -> int:
    """Tokens one reference picture costs on the server: its (height//28) x (width//28) blocks, capped at 768.

    The cap is the per-picture ceiling the pack's server path shrinks a picture to (``FRAME_MAX_TOKENS``); a
    picture smaller than that costs its own block count.
    """
    shape = tuple(int(x) for x in tensor.shape)
    height, width = shape[-3], shape[-2]
    return min(cap, max(1, (width // patch) * (height // patch)))


def png_data_uri(path: str) -> str:
    with open(path, "rb") as handle:
        return "data:image/png;base64," + base64.b64encode(handle.read()).decode("ascii")


def build_user_content(story: str, target_clips: int, refs: dict | None = None, more: dict | None = None):
    """The planner's user turn: a string, or (with real pictures) a list of OpenAI-style content parts.

    ``refs`` = ``{"pictures": [{"label": "Picture 1", "caption": str, "image": data-URI or None}],
    "videos": [{"label": "Video 1", "caption": str}]}``. Pictures with an ``image`` are sent as image parts
    followed by their caption; the others as one labelled caption line. Videos are always caption lines.
    ``more`` (see ``plan_more``) turns the call into a continuation of an existing film.
    """
    text = build_user_message(story, target_clips, more["numbers"] if more else None)
    body = f"{more_block(more)}\n\n{text}" if more else text
    pictures = list((refs or {}).get("pictures") or [])
    videos = list((refs or {}).get("videos") or [])
    if not pictures and not videos:
        return body
    tail = f"{REFS_RULE}\n\n{body}"
    if not any(p.get("image") for p in pictures):
        lines = [f"{item['label']}: {item['caption']}".rstrip() for item in pictures + videos]
        return "\n".join([REFS_HEADER] + lines) + f"\n\n{tail}"
    parts = [{"type": "text", "text": REFS_HEADER}]
    for item in pictures:
        parts.append({"type": "text", "text": f"{item['label']}:"})
        if item.get("image"):
            parts.append({"type": "image_url", "image_url": {"url": item["image"]}})
        parts.append({"type": "text", "text": item["caption"] or "(no caption)"})
    for item in videos:
        parts.append({"type": "text", "text": f"{item['label']}: {item['caption']}".rstrip()})
    parts.append({"type": "text", "text": f"\n{tail}"})
    return parts


def _with_complaint(content, complaint: str):
    if isinstance(content, str):
        return content + complaint
    parts = [dict(p) for p in content]
    parts[-1]["text"] += complaint
    return parts


# --------------------------------------------------------------------------- parse (lenient, never raises)


def _extract_json_object(raw: str):
    s = re.sub(r"```(?:json)?", "", (raw or "").strip(), flags=re.IGNORECASE)
    a, b = s.find("{"), s.rfind("}")
    if a < 0 or b <= a:
        return None
    try:
        value = json.loads(s[a:b + 1])
    except ValueError:
        return None
    return value if isinstance(value, dict) else None


def _num(value, default=0.0):
    try:
        out = float(value)
    except (TypeError, ValueError):
        return default
    return out if out == out and abs(out) != float("inf") else default


def _text(value) -> str:
    return value.strip() if isinstance(value, str) else ""


def _coerce_shot(v, fallback: int):
    if not isinstance(v, dict):
        return None
    speaker, line = _text(v.get("dialogue_speaker")), _text(v.get("dialogue_line"))
    camera = v.get("camera")
    return {
        "shot": int(_num(v.get("shot"), fallback)),
        "seconds": _num(v.get("seconds"), 0.0) or 0.0,
        "camera": camera if camera in CAMERA_SHOTS else "medium",
        "camera_raw": camera if isinstance(camera, str) else "",
        "subject": _text(v.get("subject")),
        "action": _text(v.get("action")),
        "dialogue": {"speaker": speaker, "line": line} if v.get("has_dialogue") is True and (speaker or line) else None,
    }


def _coerce_change(v):
    if not isinstance(v, dict) or not all(isinstance(v.get(k), str) for k in ("entity", "axis", "to")):
        return None
    return {"entity": v["entity"].strip(), "axis": v["axis"].strip(), "to": v["to"].strip(), "shot": int(_num(v.get("shot"), 0))}


def _coerce_end_state(v):
    if not isinstance(v, dict):
        return None
    characters = []
    for c in (v.get("characters") if isinstance(v.get("characters"), list) else []):
        if isinstance(c, dict) and _text(c.get("name")):
            characters.append({k: _text(c.get(k)) for k in ("name", "position", "wardrobe", "props", "state")})
    state = {"location": _text(v.get("location")), "time_light": _text(v.get("time_light")),
             "end_action": _text(v.get("end_action")), "characters": characters}
    return state if state["end_action"] or characters or state["location"] else None


def _coerce_clip(v, fallback: int):
    if not isinstance(v, dict) or not isinstance(v.get("shots"), list) or not v["shots"]:
        return None
    shots = [s for s in (_coerce_shot(s, i + 1) for i, s in enumerate(v["shots"])) if s]
    if not shots:
        return None
    changes = [c for c in (_coerce_change(c) for c in (v.get("state_changes") if isinstance(v.get("state_changes"), list) else [])) if c]
    return {"clip": int(_num(v.get("clip"), fallback)), "beat": _text(v.get("beat")), "shots": shots,
            "forward_pull": _text(v.get("forward_pull")), "state_changes": changes,
            "end_state": _coerce_end_state(v.get("end_state"))}


def _coerce_axis(v):
    if not isinstance(v, dict) or not isinstance(v.get("axis"), str):
        return None
    options = [o for o in (v.get("options") if isinstance(v.get("options"), list) else []) if isinstance(o, str)]
    return {"axis": v["axis"].strip(), "options": options, "progressive": v.get("progressive") is True,
            "plate_visible": v.get("plate_visible") is True}


def _coerce_entity(v):
    if not isinstance(v, dict) or not isinstance(v.get("id"), str) or not v["id"].strip():
        return None
    kind = v.get("kind") if v.get("kind") in ("character", "prop", "creature", "environment") else "character"
    clip_ids = [int(n) for n in (_num(x, None) for x in (v.get("clip_ids") if isinstance(v.get("clip_ids"), list) else [])) if n is not None]
    axes = [a for a in (_coerce_axis(a) for a in (v.get("axes") if isinstance(v.get("axes"), list) else [])) if a]
    initial = []
    for item in (v.get("initial") if isinstance(v.get("initial"), list) else []):
        if isinstance(item, dict) and isinstance(item.get("axis"), str) and isinstance(item.get("value"), str):
            initial.append({"axis": item["axis"].strip(), "value": item["value"].strip()})
    return {"id": v["id"].strip(), "name": _text(v.get("name")) or v["id"].strip(), "kind": kind,
            "clip_ids": clip_ids, "axes": axes, "initial": initial}


def parse_breakdown(raw: str):
    """The planner reply as a breakdown dict, or None when it carries no usable clip."""
    obj = _extract_json_object(raw)
    if not obj or not isinstance(obj.get("chapter"), str) or not isinstance(obj.get("clips"), list) or not obj["clips"]:
        return None
    clips = [c for c in (_coerce_clip(c, i + 1) for i, c in enumerate(obj["clips"])) if c]
    if not clips:
        return None
    ledger = obj.get("ledger") if isinstance(obj.get("ledger"), dict) else {}
    entities = [e for e in (_coerce_entity(e) for e in (ledger.get("entities") if isinstance(ledger.get("entities"), list) else [])) if e]
    return {"chapter": obj["chapter"].strip(), "ledger": {"entities": entities}, "clips": clips}


# --------------------------------------------------------------------------- state ledger


def _initial_state(ledger) -> dict:
    return {e["id"]: {i["axis"]: i["value"] for i in e["initial"]} for e in ledger["entities"]}


def fold_ledger(ledger, clips) -> dict:
    """clip number -> state (entity -> axis -> value) as of the START of that clip."""
    by_clip = {}
    running = _initial_state(ledger)
    for c in sorted(clips, key=lambda c: c["clip"]):
        by_clip[c["clip"]] = {k: dict(v) for k, v in running.items()}
        nxt = {k: dict(v) for k, v in running.items()}
        for change in c["state_changes"]:
            nxt.setdefault(change["entity"], {})[change["axis"]] = change["to"]
        running = nxt
    return by_clip


def format_state_blocks(ledger, start_state, clip_changes, clip: int) -> str:
    by_id = {e["id"]: e for e in ledger["entities"]}
    on_screen = [e for e in ledger["entities"] if clip in e["clip_ids"]]
    if not on_screen:
        return ""
    start_lines = []
    for entity in on_screen:
        if not entity["axes"]:
            continue
        axis_map = start_state.get(entity["id"], {})
        parts = []
        for a in entity["axes"]:
            value = axis_map.get(a["axis"])
            if value is None:
                value = next((i["value"] for i in entity["initial"] if i["axis"] == a["axis"]), "")
            parts.append(f"{a['axis']}={value}")
        start_lines.append(f"{entity['name']} ({entity['kind']}): {', '.join(parts)}")
    change_lines = [f"{by_id[c['entity']]['name']}.{c['axis']} -> {c['to']} (shot {c['shot']})"
                    for c in clip_changes if c["entity"] in by_id]
    parts = []
    if start_lines:
        parts.append("\n".join(["STATE AT THE START OF THIS CLIP:"] + start_lines))
    if change_lines:
        parts.append("\n".join(["CHANGES DURING THIS CLIP:"] + change_lines))
    return "\n\n".join(parts)


# --------------------------------------------------------------------------- raw-ask formatting


def _fmt_seconds(seconds: float) -> str:
    return str(int(seconds)) if float(seconds).is_integer() else f"{seconds:.1f}"


def format_shot_line(s) -> str:
    camera = CAMERA_LABELS.get(s["camera"], s["camera"])
    subject, action = s["subject"].strip(), s["action"].strip()
    if subject and action:
        new_sentence = bool(re.match(r"[A-Z]", action))
        sep = ((("" if re.search(r"[.!?]$", subject) else ".") + " ") if new_sentence else " ")
        body = f"{subject}{sep}{action}"
    else:
        body = subject or action
    if s["dialogue"] and s["dialogue"]["line"]:
        sep = "" if re.search(r"[.!?,]$", body) else ","
        speaker = f"{s['dialogue']['speaker']} says" if s["dialogue"]["speaker"] else "says"
        body = f"{body}{sep} {speaker} \"{s['dialogue']['line']}\"" if body else f"{speaker} \"{s['dialogue']['line']}\""
    if not re.search(r"[.!?]$", body):
        body += "."
    return f"Shot {s['shot']} – {camera} as {body} ({_fmt_seconds(s['seconds'])}s)"


def format_clip_raw_ask(clip) -> str:
    """One planned clip as the plain-text raw ask: 'Clip N:', its numbered shot lines, then the forward pull."""
    lines = [f"Clip {clip['clip']}:", ""] + [format_shot_line(s) for s in clip["shots"]]
    if clip["forward_pull"].strip():
        lines += ["", clip["forward_pull"].strip()]
    return "\n".join(lines)


def format_end_state(end_state) -> str:
    lines = []
    if end_state["location"]:
        lines.append(f"Location: {end_state['location']}")
    if end_state["time_light"]:
        lines.append(f"Time and light: {end_state['time_light']}")
    if end_state["end_action"]:
        lines.append(f"Last action: {end_state['end_action']}")
    for c in end_state["characters"]:
        parts = [f"{label}: {c[key]}" for key, label in (("position", "position"), ("wardrobe", "wardrobe"),
                                                           ("props", "props"), ("state", "state")) if c[key]]
        lines.append(f"{c['name']} \u2014 " + "; ".join(parts) if parts else c["name"])
    return "\n".join(lines)


def raw_ask_for_clip(breakdown, clip_number: int):
    """``format_clip_raw_ask`` with the ledger's STATE blocks (as the Studio sends it) and the continuity blocks: the
    previous clip's end state in front, this clip's own end state behind."""
    clip = next((c for c in breakdown["clips"] if c["clip"] == clip_number), None)
    if clip is None:
        return None
    text = format_clip_raw_ask(clip)
    ordered = sorted(breakdown["clips"], key=lambda c: c["clip"])
    at = ordered.index(clip)
    before = ordered[at - 1] if at > 0 else None
    head = []
    if breakdown["ledger"]["entities"]:
        start = fold_ledger(breakdown["ledger"], breakdown["clips"]).get(clip_number)
        if start is not None:
            blocks = format_state_blocks(breakdown["ledger"], start, clip["state_changes"], clip_number)
            if blocks:
                head.append(blocks)
    if before is not None and before.get("end_state") and before["clip"] == clip["clip"] - 1:
        head.append(f"{OPENS_MARK.format(n=before['clip'])}\n{format_end_state(before['end_state'])}")
    if clip.get("end_state"):
        text = f"{text}\n\n{ENDS_MARK}\n{format_end_state(clip['end_state'])}"
    return "\n\n".join(head + [text])


# --------------------------------------------------------------------------- checks (plain strings, never raise)


def check_clip_count(b, target_clips: int | None) -> list[str]:
    if not target_clips:
        return []
    actual = len(b["clips"])
    if actual == target_clips:
        return []
    return [f"This chapter came back as {actual} clip{'' if actual == 1 else 's'} — the target is EXACTLY {target_clips}. "
            f"Reach {target_clips} by covering the same events at a finer or coarser grain, never by inventing or dropping events."]


def check_raw_asks_distinct(b) -> list[str]:
    issues, seen = [], {}
    for clip in b["clips"]:
        text = raw_ask_for_clip(b, clip["clip"])
        if not text:
            issues.append(f"clip {clip['clip']}: could not build a raw ask at all.")
        elif text in seen:
            issues.append(f"clip {clip['clip']}'s raw ask is byte-identical to clip {seen[text]}'s.")
        else:
            seen[text] = clip["clip"]
    return issues


def check_breakdown(b) -> list[str]:
    issues = []
    entity_by_id = {e["id"]: e for e in b["ledger"]["entities"]}
    for clip in b["clips"]:
        n = len(clip["shots"])
        if n < SHOT_MIN or n > SHOT_MAX:
            issues.append(f"clip {clip['clip']} has {n} shot{'' if n == 1 else 's'} — outside the {SHOT_MIN}-{SHOT_MAX} range.")
        total = sum(s["seconds"] for s in clip["shots"])
        drift = abs(total - CLIP_SECONDS)
        if drift > SECONDS_TOLERANCE:
            issues.append(f"clip {clip['clip']}'s shots sum to {total:.1f}s — {drift:.1f}s off the {CLIP_SECONDS}s target.")
        for s in clip["shots"]:
            if s["camera_raw"] not in CAMERA_SHOTS:
                issues.append(f"clip {clip['clip']} shot {s['shot']}: camera '{s['camera_raw']}' is not one of {', '.join(CAMERA_SHOTS)}.")
        for i in range(1, n):
            if clip["shots"][i]["camera"] == clip["shots"][i - 1]["camera"]:
                issues.append(f"clip {clip['clip']}, shots {clip['shots'][i - 1]['shot']}-{clip['shots'][i]['shot']} repeat the same "
                              f"camera ({CAMERA_LABELS[clip['shots'][i]['camera']]}) back-to-back.")
        for s in clip["shots"]:
            line = (s["dialogue"] or {}).get("line")
            if not line:
                continue
            words = len(line.split())
            wps = words / s["seconds"] if s["seconds"] > 0 else float("inf")
            if wps > DIALOGUE_WORDS_PER_SECOND_MAX:
                issues.append(f"clip {clip['clip']} shot {s['shot']}: {words} words in {s['seconds']:.1f}s is {wps:.1f} words/s — "
                              f"over the {DIALOGUE_WORDS_PER_SECOND_MAX} words/s ceiling H3 dialogue tends to mangle past.")
        shot_numbers = {s["shot"] for s in clip["shots"]}
        for change in clip["state_changes"]:
            entity = entity_by_id.get(change["entity"])
            if entity is None:
                issues.append(f"clip {clip['clip']} state_changes cites entity '{change['entity']}', which is not in ledger.entities[].id.")
                continue
            axis = next((a for a in entity["axes"] if a["axis"] == change["axis"]), None)
            if axis is None:
                issues.append(f"clip {clip['clip']} state_changes: entity '{change['entity']}' has no axis '{change['axis']}' declared in the ledger.")
                continue
            if change["to"] not in axis["options"]:
                issues.append(f"clip {clip['clip']} state_changes: '{change['to']}' is not one of {entity['id']}.{axis['axis']}'s declared options ({', '.join(axis['options'])}).")
            if change["shot"] not in shot_numbers:
                issues.append(f"clip {clip['clip']} state_changes cites shot {change['shot']}, which is not one of this clip's own shots ({', '.join(str(x) for x in sorted(shot_numbers))}).")
    for clip in b["clips"]:
        end = clip.get("end_state")
        if end is None or not end["end_action"]:
            issues.append(f"clip {clip['clip']} has no usable end_state (needs location, time_light, end_action and every on-screen "
                          f"character's position, wardrobe, props and state).")
    ordered = sorted(b["clips"], key=lambda c: c["clip"])
    for entity in b["ledger"]["entities"]:
        for axis in entity["axes"]:
            if not axis["progressive"]:
                continue
            options = axis["options"]
            start = next((i["value"] for i in entity["initial"] if i["axis"] == axis["axis"]), "")
            last = options.index(start) if start in options else -1
            for clip in ordered:
                change = next((c for c in clip["state_changes"] if c["entity"] == entity["id"] and c["axis"] == axis["axis"]), None)
                if change is None or change["to"] not in options:
                    continue
                idx = options.index(change["to"])
                if last != -1 and idx < last:
                    issues.append(f"{entity['id']}.{axis['axis']} moves backwards at clip {clip['clip']} (from '{options[last]}' to '{change['to']}') "
                                  f"— this axis is progressive and its options are ordered least to most.")
                last = idx
    issues.extend(check_raw_asks_distinct(b))
    return issues


# --------------------------------------------------------------------------- the planner call


def renumber(b, numbers: list[int]):
    """Number the planned clips with ``numbers`` (the slots asked for, possibly not contiguous).

    A reply whose 'clip' fields are exactly those numbers is kept as it is (mapped to slots by the field); anything
    else (counted from 1 whatever it was told) is mapped by position. Each entity's clip_ids follow the same mapping.
    """
    ordered = sorted(b["clips"], key=lambda c: c["clip"])
    if sorted(c["clip"] for c in ordered) == sorted(numbers):
        mapping = {c["clip"]: c["clip"] for c in ordered}
    else:
        mapping = {c["clip"]: numbers[i] for i, c in enumerate(ordered) if i < len(numbers)}
    for c in ordered:
        c["clip"] = mapping.get(c["clip"], c["clip"])
    for e in b["ledger"]["entities"]:
        e["clip_ids"] = sorted({mapping[n] for n in e["clip_ids"] if n in mapping})
    b["clips"] = sorted(ordered, key=lambda c: c["clip"])
    return b


def apply_carried(ledger, carried) -> None:
    """Make the ledger open on the state carried out of the existing film (where the declared options allow it)."""
    for e in ledger["entities"]:
        known = (carried or {}).get(e["id"])
        if not known:
            continue
        for item in e["initial"]:
            value = known["axes"].get(item["axis"])
            axis = next((a for a in e["axes"] if a["axis"] == item["axis"]), None)
            if value is not None and axis is not None and value in axis["options"]:
                item["value"] = value


def end_states(b, carried=None) -> list:
    """The state at the END of each planned clip (carried entities not redeclared are kept), in clip order."""
    state = {k: {"name": v["name"], "kind": v["kind"], "axes": dict(v["axes"])} for k, v in (carried or {}).items()}
    for e in b["ledger"]["entities"]:
        entry = state.setdefault(e["id"], {"name": e["name"], "kind": e["kind"], "axes": {}})
        entry["name"], entry["kind"] = e["name"], e["kind"]
        for item in e["initial"]:
            entry["axes"][item["axis"]] = item["value"]
    out = []
    for c in sorted(b["clips"], key=lambda c: c["clip"]):
        for change in c["state_changes"]:
            if change["entity"] in state:
                state[change["entity"]]["axes"][change["axis"]] = change["to"]
        out.append(copy.deepcopy(state))
    return out


class PlanError(RuntimeError):
    pass


def plan_story(chat, story: str, target_clips: int, log=None, refs: dict | None = None,
               more: dict | None = None, states_out: list | None = None) -> list[str]:
    """Plan ``story`` into exactly ``target_clips`` raw asks with ``chat(messages) -> reply text``.

    One call; on an unparseable reply, a wrong clip count or any failed check, exactly one retry with the
    complaint appended (the Studio's own discipline). After the retry, soft issues are logged and kept;
    an unparseable reply or a wrong clip count raises ``PlanError``.
    """
    say = log or (lambda *_: None)
    numbers = more["numbers"] if more else list(range(1, target_clips + 1))
    carried = more.get("carried") if more else None
    user = build_user_content(story, target_clips, refs, more)
    complaint, parsed, issues = [], None, []
    for attempt in range(2):
        content = user
        if complaint:
            content = _with_complaint(
                user, "\n\nYOUR PREVIOUS REPLY FAILED THESE CHECKS — CORRECT EXACTLY THIS AND NOTHING ELSE:\n" + "\n".join(complaint))
        reply = chat([{"role": "user", "content": content}])
        parsed = parse_breakdown(reply)
        if parsed is not None:
            renumber(parsed, numbers)
            apply_carried(parsed["ledger"], carried)
        if parsed is None:
            complaint = ["Your reply was not one valid JSON object in the OUTPUT FORMAT above (or had no clips). Reply with that JSON object only."]
            issues = list(complaint)
            say(f"attempt {attempt + 1}: reply not parseable")
            continue
        issues = check_clip_count(parsed, target_clips) + check_breakdown(parsed)
        if not issues:
            break
        complaint = issues
        say(f"attempt {attempt + 1}: {len(issues)} issue(s): " + " | ".join(issues[:4]))
    if parsed is None:
        raise PlanError("the story planner returned no usable JSON twice")
    count = check_clip_count(parsed, target_clips)
    if count:
        raise PlanError(count[0])
    if issues:
        say("kept the plan with remaining issues: " + " | ".join(issues))
    ordered = sorted(parsed["clips"], key=lambda c: c["clip"])
    if states_out is not None:
        states_out[:] = end_states(parsed, carried)
    return [raw_ask_for_clip(parsed, c["clip"]) for c in ordered]


# --------------------------------------------------------------------------- putting a plan into the clip list


def _ask_text(clip) -> str:
    return (clip.get("prompt_raw") if clip.get("prompt_rewritten") and isinstance(clip.get("prompt_raw"), str)
            else clip.get("prompt") if isinstance(clip.get("prompt"), str) else "") or ""


def plan_slots(clips: list, target_clips: int) -> list[int]:
    """Clip positions a plan may write: empty slots that never held a plan, and slots past the end.

    Empty list = no plan to make. A list that already carries any ``planned`` flag (True while the plan's text is
    untouched, False once the user edited it) has been planned once and is never planned again from here: the
    panel's replan action removes the flags and blanks the untouched plan text first.
    """
    if target_clips <= 0 or any(isinstance(c, dict) and "planned" in c for c in clips):
        return []
    slots = []
    for i in range(target_clips):
        if i >= len(clips):
            slots.append(i)
        elif isinstance(clips[i], dict) and not _ask_text(clips[i]).strip():
            slots.append(i)
    return slots


def _context(clips: list, numbers: list[int], carried) -> dict:
    """Every clip in order for the planner: its text, or None where it is to plan (see ``more_block``)."""
    wanted = set(numbers)
    last = max(len(clips), max(numbers))
    entries = []
    for n in range(1, last + 1):
        if n in wanted:
            entries.append((n, None))
        else:
            entries.append((n, _ask_text(clips[n - 1]).strip() if isinstance(clips[n - 1], dict) else ""))
    first = min(numbers)
    tail = numbers == list(range(first, first + len(numbers))) and all(t is None for n, t in entries if n >= first)
    return {"numbers": list(numbers), "start": first, "count": len(numbers), "existing": entries,
            "carried": carried, "tail": tail}


def plan_around(clips: list, target_clips: int, slots: list[int]):
    """First plan with typed clips in the range: plan only ``slots`` (the empty ones), around the typed clips.

    None when no clip in the range has text (then the whole story is planned into N from scratch, as before).
    All the slots go in ONE call; a typed clip is fixed context. Typed clips have no ledger, so the planner derives
    the opening state itself.
    """
    if not slots or not any(isinstance(c, dict) and _ask_text(c).strip() for c in clips[:target_clips]):
        return None
    return _context(clips, [i + 1 for i in slots], None)


def plan_more(clips: list, target_clips: int):
    """The continuation to plan when ``auto_clips`` is raised past the existing film, else None.

    Fires only when the list already carries a ``planned`` flag (it was planned once) and ``target_clips`` is more
    than the clips there now. Plans exactly the difference, numbered from len+1, appended after the end. Existing
    clips, typed or planned, are existing film and are never touched; empty clips inside the existing range stay
    as they are (they appear in the 'already in the film' block as empty). The state carried in is the end state
    stored on the latest existing clip that has one, so a typed clip with no ledger carries the last known state.
    """
    if target_clips <= len(clips) or not any(isinstance(c, dict) and "planned" in c for c in clips):
        return None
    carried = None
    for c in reversed(clips):
        if isinstance(c, dict) and isinstance(c.get("plan_end_state"), dict):
            carried = c["plan_end_state"]
            break
    return _context(clips, list(range(len(clips) + 1, target_clips + 1)), carried)


def place(asks: list[str], states: list, numbers: list[int]):
    """Asks and end-states in clip-number order -> (asks, states, slots) indexed by slot, for ``apply_plan``."""
    slots = [n - 1 for n in numbers]
    size = max(slots) + 1
    full, full_states = [""] * size, [None] * size
    for slot, ask, i in zip(slots, asks, range(len(asks))):
        full[slot] = ask
        if i < len(states):
            full_states[slot] = states[i]
    return full, full_states, slots[:len(asks)]


def _next_id(clips: list) -> int:
    ids = [c["id"] for c in clips if isinstance(c, dict) and isinstance(c.get("id"), int)]
    return (max(ids) + 1) if ids else 0


def apply_plan(clips: list, asks: list[str], slots: list[int], states: list | None = None) -> list[int]:
    """Write ``asks[i]`` into the empty ``slots`` (appending clips past the end). Typed clips are never touched.

    Returns the positions written. Each is flagged ``planned: True``, 15 s, not rewritten.
    """
    written = []
    for i in slots:
        if i >= len(asks):
            break
        if i < len(clips):
            clip = clips[i]
            if _ask_text(clip).strip() or "planned" in clip:
                continue
        else:
            clip = {"id": _next_id(clips), "title": f"Clip {i + 1}", "duration": 15, "beyond": False,
                    "seed": random.randint(0, 999999999), "seed_mode": "randomize", "validated": False, "loras": []}
            clips.append(clip)
        for key in ("prompt_raw", "rewrite_text", "rewrite_meta"):
            clip.pop(key, None)
        clip["prompt"] = asks[i]
        clip["prompt_rewritten"] = False
        clip["planned"] = True
        if states is not None and i < len(states) and states[i] is not None:
            clip["plan_end_state"] = states[i]
        clip["duration"] = 15
        clip["validated"] = False
        written.append(i)
    return written
