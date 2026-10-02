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
        text = handle.read()
    if text.startswith("<!--"):
        end = text.index("-->")
        text = text[end + 3:]
        if text.startswith("\r\n"):
            text = text[2:]
        elif text.startswith("\n"):
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
     "state_changes": [{"entity": "an entity id", "axis": "one of its axes", "to": "one of that axis's options", "shot": 2}]}
  ]
}
Each clip has 3-6 shots whose seconds sum to 15. "ledger.entities" may be an empty array when nothing visibly changes."""


def build_user_message(story: str, target_clips: int) -> str:
    return fill_template(load_prompt("planner"), story, "target", target_clips) + OUTPUT_SHAPE


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


def _coerce_clip(v, fallback: int):
    if not isinstance(v, dict) or not isinstance(v.get("shots"), list) or not v["shots"]:
        return None
    shots = [s for s in (_coerce_shot(s, i + 1) for i, s in enumerate(v["shots"])) if s]
    if not shots:
        return None
    changes = [c for c in (_coerce_change(c) for c in (v.get("state_changes") if isinstance(v.get("state_changes"), list) else [])) if c]
    return {"clip": int(_num(v.get("clip"), fallback)), "beat": _text(v.get("beat")), "shots": shots,
            "forward_pull": _text(v.get("forward_pull")), "state_changes": changes}


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


def raw_ask_for_clip(breakdown, clip_number: int):
    """``format_clip_raw_ask`` with the ledger's STATE blocks prepended, as the Studio sends it to the rewriter."""
    clip = next((c for c in breakdown["clips"] if c["clip"] == clip_number), None)
    if clip is None:
        return None
    text = format_clip_raw_ask(clip)
    if breakdown["ledger"]["entities"]:
        start = fold_ledger(breakdown["ledger"], breakdown["clips"]).get(clip_number)
        if start is not None:
            blocks = format_state_blocks(breakdown["ledger"], start, clip["state_changes"], clip_number)
            if blocks:
                text = f"{blocks}\n\n{text}"
    return text


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


class PlanError(RuntimeError):
    pass


def plan_story(chat, story: str, target_clips: int, log=None) -> list[str]:
    """Plan ``story`` into exactly ``target_clips`` raw asks with ``chat(messages) -> reply text``.

    One call; on an unparseable reply, a wrong clip count or any failed check, exactly one retry with the
    complaint appended (the Studio's own discipline). After the retry, soft issues are logged and kept;
    an unparseable reply or a wrong clip count raises ``PlanError``.
    """
    say = log or (lambda *_: None)
    user = build_user_message(story, target_clips)
    complaint, parsed, issues = [], None, []
    for attempt in range(2):
        content = user
        if complaint:
            content = f"{user}\n\nYOUR PREVIOUS REPLY FAILED THESE CHECKS — CORRECT EXACTLY THIS AND NOTHING ELSE:\n" + "\n".join(complaint)
        reply = chat([{"role": "user", "content": content}])
        parsed = parse_breakdown(reply)
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


def _next_id(clips: list) -> int:
    ids = [c["id"] for c in clips if isinstance(c, dict) and isinstance(c.get("id"), int)]
    return (max(ids) + 1) if ids else 0


def apply_plan(clips: list, asks: list[str], slots: list[int]) -> list[int]:
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
        clip["duration"] = 15
        clip["validated"] = False
        written.append(i)
    return written
