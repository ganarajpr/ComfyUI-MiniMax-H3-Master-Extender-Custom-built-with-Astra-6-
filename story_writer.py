"""H3 Story Writer: a short brief in, a full story out, sized so that E4 plans about N clips from it.

A separate node from the Master Extender (it changes nothing there). Wired ``[H3 Story Writer] --STRING--> [Master Extender story input]`` with
story_engine=e4.10: E4 treats its story input as a finished story (one clip per distinct dramatic beat, every spoken line copied verbatim), so a
three-line brief gives about four clips with invented dialogue. This node writes the story first: exactly N beats of about ``seconds`` seconds,
one paragraph each, every spoken line in quotes with its speaker.

Two stages, both on the model server the rewriter pack opens for the Extender's E4 (same ``mtmd.session`` / ``open_strata`` path, same wires, same
thinking budgets), closed again when the node finishes so the render that follows has the card:

1. OUTLINE (one call): cast, locations and exactly N one-line beats, as JSON. The count is checked in code; a wrong count gets one retry that names the
   mismatch, then a repair in code (merge neighbours, split a beat by one more call, or by code if that fails too).
2. WRITE (calls of at most CHUNK_BEATS beats): each call gets the brief, the cast sheet, the whole outline and the last two paragraphs written. Beats are
   delimited by ``=== N ===`` lines the code strips, so a cut reply still yields every complete beat. A call that is cut or returns the wrong count is
   retried once with a larger cap and a terser instruction, then the chunk is split in half. Every accepted beat is written to disk at once; a run that
   dies resumes from them when the same inputs run again.

The pure engine (``StoryEngine``) takes any ``chat(messages, max_tokens=, budget=, kind=) -> Reply``; ``ServerChat`` is the HTTP one. ComfyUI is imported
lazily, so the engine runs and is tested without it.
"""

from __future__ import annotations

import contextlib
import hashlib
import json
import logging
import math
import os
import re
import time
import urllib.error
import urllib.request
from dataclasses import dataclass, field
from pathlib import Path

try:
    from . import e4_engine
    from . import prompt_rewriter
    from . import strata_backend
    from . import vram_release
except ImportError:  # imported as a top-level module (tests)
    import e4_engine
    import prompt_rewriter
    import strata_backend
    import vram_release

_LOG = logging.getLogger("minimax_h3_master_extender.story_writer")

VERSION = "1"
MIN_CLIPS, MAX_CLIPS = 1, 60
DEFAULT_SECONDS = 15
DEFAULT_LANGUAGE = "English"
CHUNK_BEATS = 8
THINKING_BUDGET = 4096
BUDGET_MESSAGE = e4_engine.BUDGET_MESSAGE
MIN_OUTPUT = 4096
MARGIN = 1024
LATIN_CHARS_PER_TOKEN = 2.5
MIN_BEAT_CHARS = 40
SPEECH_WORDS_PER_SECOND = 2.0
E4_LATIN_CHARS_PER_CLIP, E4_WIDE_CHARS_PER_CLIP = 700, 380   # e4/bridge/scale.mjs weightOf: how E4 sizes a story it must plan in parts
PROMPT_DIR = Path(__file__).resolve().parent / "prompts"
SENTINEL_MINOR = "MINOR_IN_SEXUAL_CONTENT"
OUTPUT_SUBDIR = "h3_story_writer"

LATIN_LANGUAGES = {
    "english", "spanish", "french", "german", "portuguese", "italian", "dutch", "polish", "turkish", "indonesian", "malay", "swedish", "danish", "norwegian",
    "finnish", "romanian", "czech", "slovak", "hungarian", "vietnamese", "hinglish", "swahili", "filipino", "tagalog", "latin", "catalan", "croatian",
}


class StoryWriterError(RuntimeError):
    """The story could not be written. ``work_dir`` holds what was kept; the same inputs resume from it."""

    def __init__(self, message, *, work_dir=None):
        super().__init__(message)
        self.work_dir = work_dir


class LLMUnavailable(StoryWriterError):
    """The model server did not answer."""


class MinorContentError(StoryWriterError):
    """The brief puts a minor in a sexual context. Nothing is written."""


@dataclass
class Reply:
    text: str
    finish: str = "stop"           # "stop" or "length"
    prompt_tokens: int = 0
    completion_tokens: int = 0
    thinking_tokens: int = 0
    secs: float = 0.0


# --------------------------------------------------------------------------- language and sizing


def is_wide(language: str) -> bool:
    """True for a language written outside Latin script (E4 sizes those by 380 characters a clip instead of 700)."""
    return str(language or DEFAULT_LANGUAGE).strip().lower() not in LATIN_LANGUAGES


def script_note(language: str) -> str:
    if str(language).strip().lower() == "hinglish":
        return " (Hindi in Latin script, the way it is typed)"
    return ", in its own native script (never romanised)" if is_wide(language) else ""


def beat_words(seconds: int, language: str) -> int:
    base = 115 * seconds / 15
    return int(round(max(55, min(170, base * (0.6 if is_wide(language) else 1.0))) / 5.0) * 5)


def max_speech_words(seconds: int) -> int:
    return max(8, int(seconds * SPEECH_WORDS_PER_SECOND))


def max_cast(clips: int) -> int:
    return max(3, min(8, 2 + clips // 5))


def e4_weight(text: str) -> float:
    latin = wide = 0
    for ch in str(text or ""):
        if ord(ch) < 0x250:
            latin += 1
        else:
            wide += 1
    return latin / E4_LATIN_CHARS_PER_CLIP + wide / E4_WIDE_CHARS_PER_CLIP


def estimate_prompt_tokens(messages) -> int:
    """e4/planpath410/transport.mjs estimatePromptTokens: Latin text at 2.5 characters a token, every other character one token."""
    latin = wide = 0
    for message in messages or []:
        for ch in str(message.get("content") or ""):
            if ord(ch) < 0x250:
                latin += 1
            else:
                wide += 1
        latin += 10
    return int(math.ceil(latin / LATIN_CHARS_PER_TOKEN + wide))


def output_room(messages, slot_ctx: int) -> int:
    """The most a reply to these messages may use: the slot minus the prompt minus a margin (transport.mjs outputRoom)."""
    return max(MIN_OUTPUT, slot_ctx - int(math.ceil(estimate_prompt_tokens(messages) * 1.05)) - MARGIN)


def answer_tokens(beats: int, seconds: int, language: str, *, wide_per_word=6.5, latin_per_word=1.8) -> int:
    per_word = wide_per_word if is_wide(language) else latin_per_word
    return int(beats * (beat_words(seconds, language) * per_word + 40))


# --------------------------------------------------------------------------- prompts


def load_prompt(name: str) -> str:
    return (PROMPT_DIR / f"story_writer_{name}.md").read_text(encoding="utf-8").strip()


def fill(template: str, **values) -> str:
    out = template
    for key, value in values.items():
        out = out.replace("{{" + key + "}}", str(value))
    return out


def format_cast(cast: list) -> str:
    return "\n".join(f"- {c['name']}: {c['look']}" if c.get("look") else f"- {c['name']}" for c in cast) or "- (none named)"


def format_locations(locations: list) -> str:
    return "\n".join(f"- {c['name']}: {c['look']}" if c.get("look") else f"- {c['name']}" for c in locations) or "- (none named)"


def format_outline(beats: list, first: int, last: int) -> str:
    lines = []
    for i, beat in enumerate(beats, start=1):
        mark = "  <== WRITE THIS ONE" if first <= i <= last else ""
        lines.append(f"{i}. {beat}{mark}")
    return "\n".join(lines)


# --------------------------------------------------------------------------- parsing


def strip_think(text: str) -> str:
    text = re.sub(r"<think>.*?</think>", "", text or "", flags=re.DOTALL)
    return text.split("</think>")[-1].strip()


def _balanced_object(text: str):
    start = text.find("{")
    while start >= 0:
        depth, in_str, esc = 0, False, False
        for i in range(start, len(text)):
            ch = text[i]
            if in_str:
                if esc:
                    esc = False
                elif ch == "\\":
                    esc = True
                elif ch == '"':
                    in_str = False
                continue
            if ch == '"':
                in_str = True
            elif ch == "{":
                depth += 1
            elif ch == "}":
                depth -= 1
                if depth == 0:
                    return text[start:i + 1]
        start = text.find("{", start + 1)
    return None


def parse_json_object(text: str):
    """The first JSON object in a model reply (fences and prose around it ignored, trailing commas forgiven), or None."""
    body = strip_think(text)
    body = re.sub(r"^```[a-zA-Z]*\s*", "", body.strip())
    body = re.sub(r"```\s*$", "", body).strip()
    chunk = _balanced_object(body)
    if chunk is None:
        return None
    for candidate in (chunk, re.sub(r",\s*([}\]])", r"\1", chunk)):
        try:
            value = json.loads(candidate)
        except ValueError:
            continue
        if isinstance(value, dict):
            return value
    return None


def _named_list(value) -> list:
    out = []
    for item in value if isinstance(value, list) else []:
        if isinstance(item, dict) and str(item.get("name") or "").strip():
            out.append({"name": str(item["name"]).strip(), "look": " ".join(str(item.get("look") or item.get("description") or "").split())})
        elif isinstance(item, str) and item.strip():
            out.append({"name": item.strip(), "look": ""})
    return out


def coerce_outline(obj) -> dict | None:
    """A reply's JSON as ``{title, minor, cast, locations, beats}``; None when it has no usable beats list and is not the minor refusal."""
    if not isinstance(obj, dict):
        return None
    minor = obj.get("minor_in_sexual_content") is True
    raw = obj.get("beats")
    beats = [" ".join(b.split()) for b in raw if isinstance(b, str) and b.strip()] if isinstance(raw, list) else []
    if not beats and not minor:
        return None
    return {"title": str(obj.get("title") or "").strip(), "minor": minor, "cast": _named_list(obj.get("cast")),
            "locations": _named_list(obj.get("locations")), "beats": beats}


MARKER = re.compile(r"^[ \t]*=+[ \t]*(END|\d+)[ \t]*=+[ \t]*$", re.IGNORECASE | re.MULTILINE)
LABEL = re.compile(r"^\s*(?:\**\s*)?(?:beat|clip|scene|shot)\s*\d+\s*[:.\-–—)]*\s*\**\s*", re.IGNORECASE)


def clean_beat(text: str) -> str:
    """One beat as one plain paragraph: markdown, labels and line breaks removed."""
    text = re.sub(r"^\s*#+\s*.*$", "", text, flags=re.MULTILINE) if re.match(r"\s*#", text) else text
    text = text.replace("**", "").replace("__", "")
    text = re.sub(r"^\s*[-*]\s+", "", text, flags=re.MULTILINE)
    text = " ".join(text.split())
    return LABEL.sub("", text).strip()


def parse_beats(text: str, count: int, *, truncated: bool):
    """The beats of a writer reply, in order: ``(beats, saw_end)``.

    Blocks are cut at the ``=== N ===`` lines. A reply that was cut (``truncated``) or never reached ``=== END ===`` loses its last block, which may be
    half a paragraph. A block shorter than MIN_BEAT_CHARS ends the accepted run. At most ``count`` beats are returned.
    """
    text = strip_think(text)
    marks = list(MARKER.finditer(text))
    blocks, saw_end = [], False
    for i, mark in enumerate(marks):
        if mark.group(1).upper() == "END":
            saw_end = True
            break
        end = marks[i + 1].start() if i + 1 < len(marks) else len(text)
        blocks.append(text[mark.end():end])
    if not marks:
        return [], False
    if truncated and not saw_end and blocks:
        blocks = blocks[:-1]
    out = []
    for block in blocks[:count]:
        beat = clean_beat(block)
        if len(beat) < MIN_BEAT_CHARS:
            break
        out.append(beat)
    return out, saw_end


QUOTED = re.compile(r"\"([^\"]+)\"|“([^”]+)”|«([^»]+)»")


def quoted_words(text: str) -> int:
    return sum(len((a or b or c).split()) for a, b, c in QUOTED.findall(text))


def quoted_lines(text: str) -> list:
    return [(a or b or c).strip() for a, b, c in QUOTED.findall(text)]


# --------------------------------------------------------------------------- the model server


class ServerChat:
    """A chat call on the model server the rewriter opened (``e4_engine.endpoint_of`` describes it): ninfer-serve's /v1/messages, or chat completions.

    ninfer: ``thinking.budget_tokens`` is a real per-request cap and thinking counts toward ``max_tokens``. llama.cpp and Strata: the top-level
    ``reasoning_budget_tokens`` and ``reasoning_budget_message``. Transient errors are retried; a server that stays down raises LLMUnavailable.
    """

    def __init__(self, endpoint: dict, *, budget_message: str = BUDGET_MESSAGE, interrupted=None, retries: int = 3, timeout: float = 1800.0, sleep=time.sleep):
        self.url = str(endpoint["url"]).rstrip("/")
        self.model = endpoint.get("model") or "local"
        self.style = endpoint["style"]
        self.budget_message = budget_message
        self.interrupted = interrupted
        self.retries = retries
        self.timeout = timeout
        self.sleep = sleep

    def request(self, messages, max_tokens: int, budget: int, temperature: float):
        if self.style == "ninfer-messages":
            system = "\n\n".join(m["content"] for m in messages if m["role"] == "system")
            body = {"model": self.model, "max_tokens": max_tokens, "temperature": temperature, "thinking": {"type": "enabled", "budget_tokens": max(1024, budget)},
                    "messages": [m for m in messages if m["role"] != "system"]}
            if system:
                body["system"] = system
            return f"{self.url}/v1/messages", {"Content-Type": "application/json", "anthropic-version": "2023-06-01"}, body
        body = {"model": self.model, "messages": messages, "max_tokens": max_tokens, "temperature": temperature,
                "reasoning_budget_tokens": max(1024, budget), "reasoning_budget_message": self.budget_message}
        return f"{self.url}/v1/chat/completions", {"Content-Type": "application/json"}, body

    def parse(self, payload: dict, secs: float) -> Reply:
        if self.style == "ninfer-messages":
            blocks = payload.get("content") or []
            text = "".join(b.get("text", "") for b in blocks if isinstance(b, dict) and b.get("type") == "text")
            usage = payload.get("usage") or {}
            think = (usage.get("output_tokens_details") or {}).get("thinking_tokens") or 0
            return Reply(strip_think(text), "length" if payload.get("stop_reason") == "max_tokens" else "stop", int(usage.get("input_tokens") or 0),
                         int(usage.get("output_tokens") or 0), int(think), secs)
        choice = (payload.get("choices") or [{}])[0]
        usage = payload.get("usage") or {}
        think = (usage.get("completion_tokens_details") or {}).get("reasoning_tokens") or 0
        return Reply(strip_think((choice.get("message") or {}).get("content") or ""), "length" if choice.get("finish_reason") == "length" else "stop",
                     int(usage.get("prompt_tokens") or 0), int(usage.get("completion_tokens") or 0), int(think), secs)

    def __call__(self, messages, *, max_tokens: int, budget: int, kind: str = "", temperature: float = 0.6) -> Reply:
        url, headers, body = self.request(messages, max_tokens, budget, temperature)
        last = ""
        for attempt in range(1, self.retries + 1):
            if self.interrupted is not None and self.interrupted():
                raise_interrupt()
            started = time.time()
            try:
                request = urllib.request.Request(url, data=json.dumps(body).encode("utf-8"), headers=headers)
                with urllib.request.urlopen(request, timeout=self.timeout) as answer:
                    payload = json.loads(answer.read().decode("utf-8"))
                if isinstance(payload, dict) and not payload.get("error"):
                    return self.parse(payload, time.time() - started)
                last = str(payload.get("error"))[:300]
            except urllib.error.HTTPError as error:
                detail = error.read().decode("utf-8", errors="replace")[:300]
                last = f"HTTP {error.code} {detail}"
                if error.code in (400, 401, 403, 404, 422):
                    raise StoryWriterError(f"the model server refused the {kind or 'request'}: {last}") from error
            except (urllib.error.URLError, OSError, ValueError) as error:
                last = str(error)
            _LOG.warning("story writer: %s attempt %d/%d failed: %s", kind or "call", attempt, self.retries, last)
            if attempt < self.retries:
                self.sleep(4 * attempt)
        raise LLMUnavailable(f"the model server at {self.url} did not answer ({last}); nothing was written")


def raise_interrupt():
    try:
        import comfy.model_management as mm
    except ImportError:
        raise KeyboardInterrupt("interrupted") from None
    raise mm.InterruptProcessingException()


# --------------------------------------------------------------------------- the engine


class StoryEngine:
    """Brief to story with an injected ``chat``. See the module docstring."""

    def __init__(self, chat, work_dir, *, brief: str, clips: int, seconds: int = DEFAULT_SECONDS, language: str = DEFAULT_LANGUAGE, slot_ctx: int = 65536,
                 budget: int = THINKING_BUDGET, chunk_beats: int = CHUNK_BEATS, progress=None, say=None):
        self.chat = chat
        self.work = Path(work_dir)
        self.brief = brief.strip()
        self.clips = int(clips)
        self.seconds = int(seconds)
        self.language = (language or DEFAULT_LANGUAGE).strip() or DEFAULT_LANGUAGE
        self.slot_ctx = int(slot_ctx)
        self.budget = int(budget)
        self.chunk_beats = max(1, int(chunk_beats))
        self.progress = progress or (lambda done, total: None)
        self.say = say or (lambda message: None)
        self.calls: list = []
        self.warnings: list = []
        self.total_steps = self.clips + 1
        (self.work / "beats").mkdir(parents=True, exist_ok=True)
        (self.work / "calls").mkdir(parents=True, exist_ok=True)
        self.calls_seen = len(list((self.work / "calls").glob("*.json")))

    # ---- calls

    def _ask(self, kind: str, messages, *, answer: int, budget=None, scale: float = 1.0, temperature: float = 0.6) -> Reply:
        budget = self.budget if budget is None else budget
        room = output_room(messages, self.slot_ctx)
        cap = int(min(room, max(budget + 512, int((budget + answer) * scale) + 512)))
        reply = self.chat(messages, max_tokens=cap, budget=budget, kind=kind, temperature=temperature)
        self.calls_seen += 1
        meta = {"n": self.calls_seen, "kind": kind, "max_tokens": cap, "budget": budget, "finish": reply.finish, "prompt_tokens": reply.prompt_tokens,
                "completion_tokens": reply.completion_tokens, "thinking_tokens": reply.thinking_tokens, "secs": round(reply.secs, 1)}
        self.calls.append(meta)
        record = dict(meta, at=time.strftime("%Y-%m-%d %H:%M:%S"), messages=messages, reply=reply.text)
        (self.work / "calls" / f"{self.calls_seen:03d}_{kind}.json").write_text(json.dumps(record, ensure_ascii=False, indent=1), encoding="utf-8")
        with open(self.work / "calls.jsonl", "a", encoding="utf-8") as handle:
            handle.write(json.dumps(meta) + "\n")
        _LOG.info("story writer: %s -> %s, %d tokens (thinking %d), cap %d, %.0f s", kind, reply.finish, reply.completion_tokens, reply.thinking_tokens, cap, reply.secs)
        return reply

    def _lang(self) -> dict:
        return {"language": self.language, "script_note": script_note(self.language), "seconds": self.seconds, "clips": self.clips}

    # ---- stage 1: the outline

    def outline(self) -> dict:
        stored = self.work / "outline.json"
        if stored.is_file():
            return json.loads(stored.read_text(encoding="utf-8"))
        self.say(f"outline: cast, locations and {self.clips} beats")
        out = self._outline_whole() or self._outline_in_parts()
        if out is None:
            raise StoryWriterError("the model did not return a usable outline in three attempts (replies are kept in " + str(self.work / "calls") + ")", work_dir=str(self.work))
        if out["minor"]:
            raise MinorContentError("the brief puts a minor in a sexual context; no story was written")
        out = self._fix_count(out, self.clips)
        stored.write_text(json.dumps(out, ensure_ascii=False, indent=1), encoding="utf-8")
        self.progress(1, self.total_steps)
        return out

    def _outline_messages(self, n: int, extra: str = "", total: int | None = None) -> list:
        values = dict(self._lang(), brief=self.brief, max_cast=max_cast(total or n), max_words=max_speech_words(self.seconds), extra=extra)
        values["clips"] = n
        return [{"role": "user", "content": fill(load_prompt("outline"), **values)}]

    def _outline_call(self, n: int, extra: str = "", total: int | None = None):
        messages = self._outline_messages(n, extra, total)
        answer = 500 + n * (200 if is_wide(self.language) else 90)
        for attempt in range(2):
            reply = self._ask("outline", messages, answer=answer, scale=1.0 if attempt == 0 else 2.0, temperature=0.5)
            parsed = coerce_outline(parse_json_object(reply.text)) if reply.finish != "length" else None
            if parsed:
                return parsed
            self.say("outline reply unusable" + (" (cut)" if reply.finish == "length" else "") + ", asking again")
        return None

    def _outline_whole(self):
        return self._outline_call(self.clips)

    def _outline_in_parts(self):
        """Fallback when the whole outline cannot be had in one reply: the first half, then the second half given the first."""
        if self.clips < 4:
            return None
        first = self.clips // 2
        second = self.clips - first
        self.say(f"outline in two parts ({first} + {second} beats)")
        head = self._outline_call(first, f"This is the FIRST PART of a story of {self.clips} beats: write only its first {first} beats, ending on a moment that leads on. "
                                  "Do not end the story. The cast may include characters who only appear in the second part.", total=self.clips)
        if head is None:
            return None
        head = self._fix_count(head, first)
        prior = "\n".join(f"{i}. {b}" for i, b in enumerate(head["beats"], start=1))
        tail = self._outline_call(second, f"This is the SECOND PART of a story of {self.clips} beats. The first {first} beats are already written:\n{prior}\n"
                                  f"Cast so far:\n{format_cast(head['cast'])}\nWrite ONLY the last {second} beats, which continue from beat {first} and end the story. "
                                  "Reuse the cast above under the same names; add a character only if the story needs one.", total=self.clips)
        if tail is None:
            return None
        tail = self._fix_count(tail, second)
        names = {c["name"] for c in head["cast"]}
        places = {c["name"] for c in head["locations"]}
        return {"title": head["title"] or tail["title"], "minor": head["minor"] or tail["minor"], "beats": head["beats"] + tail["beats"],
                "cast": head["cast"] + [c for c in tail["cast"] if c["name"] not in names],
                "locations": head["locations"] + [c for c in tail["locations"] if c["name"] not in places]}

    def _fix_count(self, out: dict, n: int) -> dict:
        """Exactly ``n`` beats: one retry that names the mismatch, then merge in code (too many) or split (too few)."""
        beats = out["beats"]
        if len(beats) == n:
            return out
        self.say(f"outline has {len(beats)} beats, {n} wanted: repairing")
        got = len(beats)
        if got > n:
            direction = f"that is {got - n} too many."
            how = f"Merge neighbouring beats that belong to the same moment, or drop the least important, until exactly {n} remain. Keep the story's start and ending."
        else:
            direction = f"that is {n - got} too few."
            how = f"Split the busiest beats into two consecutive distinct moments each, until exactly {n} beats exist. Keep the story's start and ending."
        shape = {"title": out["title"], "minor_in_sexual_content": False, "cast": out["cast"], "locations": out["locations"], "beats": beats}
        messages = [{"role": "user", "content": fill(load_prompt("fix_outline"), got=got, clips=n, direction=direction, how=how, outline_json=json.dumps(shape, ensure_ascii=False))}]
        reply = self._ask("outline_fix", messages, answer=500 + n * (200 if is_wide(self.language) else 90), temperature=0.4)
        parsed = coerce_outline(parse_json_object(reply.text)) if reply.finish != "length" else None
        if parsed and len(parsed["beats"]) == n:
            return dict(out, beats=parsed["beats"], cast=parsed["cast"] or out["cast"], locations=parsed["locations"] or out["locations"])
        if parsed and abs(len(parsed["beats"]) - n) < abs(got - n):
            beats = parsed["beats"]
        beats = list(beats)
        while len(beats) > n:
            i = min(range(len(beats) - 1), key=lambda k: len(beats[k]) + len(beats[k + 1]))
            beats[i:i + 2] = [beats[i].rstrip() + " " + beats[i + 1].lstrip()]
        while len(beats) < n:
            i = max(range(len(beats)), key=lambda k: len(beats[k]))
            beats[i:i + 1] = self._split_beat(beats[i])
            self.warnings.append(f"outline repaired: beat split to reach {n}")
        if len(beats) != n:
            raise StoryWriterError(f"could not bring the outline to {n} beats (have {len(beats)})", work_dir=str(self.work))
        self.warnings.append(f"outline repaired in code from {got} to {n} beats")
        return dict(out, beats=beats)

    def _split_beat(self, beat: str) -> list:
        messages = [{"role": "user", "content": fill(load_prompt("split_beat"), beat=beat, **self._lang())}]
        for _ in range(2):
            reply = self._ask("split_beat", messages, answer=600, temperature=0.4)
            obj = parse_json_object(reply.text) if reply.finish != "length" else None
            parts = [" ".join(p.split()) for p in (obj or {}).get("beats", []) if isinstance(p, str) and p.strip()]
            if len(parts) == 2:
                return parts
        return code_split(beat)

    # ---- stage 2: the beats

    def _beat_file(self, i: int) -> Path:
        return self.work / "beats" / f"{i + 1:03d}.txt"

    def _have(self, i: int) -> str | None:
        path = self._beat_file(i)
        return path.read_text(encoding="utf-8") if path.is_file() else None

    def _store(self, i: int, text: str) -> None:
        self._beat_file(i).write_text(text, encoding="utf-8")

    def write_all(self, out: dict) -> list:
        n = self.clips
        i = 0
        while i < n:
            if self._have(i) is not None:
                i += 1
                continue
            end = min(n, i + self.chunk_beats)
            for k in range(i, end):
                if self._have(k) is not None:
                    end = k
                    break
            self._write_range(out, i, end)
            i = end
        beats = [self._have(k) for k in range(n)]
        if any(b is None for b in beats):
            raise StoryWriterError("some beats are still missing after writing", work_dir=str(self.work))
        return beats

    def _write_messages(self, out: dict, start: int, end: int, *, extra: str = "") -> list:
        count = end - start
        previous = ""
        before = [self._have(k) for k in range(max(0, start - 2), start)]
        before = [b for b in before if b]
        if before:
            previous = ("\nTHE LAST PARAGRAPHS ALREADY WRITTEN (the story continues from the end of the last one; do not repeat them, keep their names, places, clothes and "
                        "physical state):\n" + "\n\n".join(before) + "\n")
        values = dict(self._lang(), brief=self.brief, cast=format_cast(out["cast"]), locations=format_locations(out["locations"]),
                      outline=format_outline(out["beats"], start + 1, end), previous=previous, first=start + 1, last=end, count=count,
                      plural="" if count == 1 else "s", beat_words=beat_words(self.seconds, self.language), max_words=max_speech_words(self.seconds), extra=extra)
        return [{"role": "user", "content": fill(load_prompt("write"), **values)}]

    def _write_range(self, out: dict, start: int, end: int) -> None:
        """Beats [start, end) written and stored. Two tries (the second larger and terser), then the range is halved; one beat that fails thrice raises."""
        for attempt in range(2):
            count = end - start
            terse = attempt > 0
            extra = ""
            if terse:
                words = max(40, int(beat_words(self.seconds, self.language) * 0.7))
                extra = (f"- Your earlier answer was cut off or had the wrong number of beats. Write exactly {count} beat{'' if count == 1 else 's'}, "
                         f"each at most {words} words, and finish with the === END === line.")
            messages = self._write_messages(out, start, end, extra=extra)
            reply = self._ask("write", messages, answer=answer_tokens(count, self.seconds, self.language), scale=1.0 if not terse else 1.8)
            if SENTINEL_MINOR in reply.text:
                raise MinorContentError("the story would put a minor in a sexual context; no story was written")
            beats, saw_end = parse_beats(reply.text, count, truncated=reply.finish == "length")
            for k, beat in enumerate(beats):
                self._store(start + k, beat)
                self._check_beat(start + k, beat)
            if beats:
                self.progress(1 + start + len(beats), self.total_steps)
            start += len(beats)
            if start >= end:
                return
            self.say(f"beats {start + 1}-{end}: {'cut' if reply.finish == 'length' else 'wrong count'}, retrying")
        count = end - start
        if count > 1:
            mid = start + count // 2
            self._write_range(out, start, mid)
            self._write_range(out, mid, end)
            return
        messages = self._write_messages(out, start, end, extra="- Write ONE beat of at most 70 words and finish with the === END === line.")
        reply = self._ask("write_last", messages, answer=answer_tokens(1, self.seconds, self.language), budget=1024, scale=2.5)
        beats, _ = parse_beats(reply.text, 1, truncated=reply.finish == "length")
        if not beats:
            raise StoryWriterError(f"beat {start + 1} could not be written in three attempts (replies are kept in {self.work / 'calls'}); run again to resume", work_dir=str(self.work))
        self._store(start, beats[0])
        self._check_beat(start, beats[0])
        self.progress(2 + start, self.total_steps)

    def _check_beat(self, i: int, beat: str) -> None:
        words = quoted_words(beat)
        cap = max_speech_words(self.seconds) * 1.25
        if words > cap:
            self.warnings.append(f"beat {i + 1}: {words} spoken words, over the {int(cap)} that fit {self.seconds} s")

    # ---- the whole

    def run(self) -> dict:
        outline = self.outline()
        beats = self.write_all(outline)
        story = "\n\n".join(beats)
        return {"story": story, "beats": beats, "outline": outline}


def code_split(beat: str) -> list:
    """Last resort: one beat into two by code, at the sentence, comma or 'and' nearest the middle."""
    middle = len(beat) / 2
    cuts = [m.end() for m in re.finditer(r"[.!?।]\s+", beat)] or [m.end() for m in re.finditer(r",\s+|;\s+", beat)] or [m.end() for m in re.finditer(r"\s+and\s+", beat)]
    if cuts:
        cut = min(cuts, key=lambda c: abs(c - middle))
        first, second = beat[:cut].strip(), beat[cut:].strip()
        if first and second:
            return [first, second]
    return [beat, "Moments later, the moment plays out: " + beat]


# --------------------------------------------------------------------------- files


def job_hash(brief: str, clips: int, seconds: int, language: str, seed: int, model: str, budget: int) -> str:
    payload = json.dumps([brief.strip(), int(clips), int(seconds), language, int(seed), model, int(budget), VERSION], ensure_ascii=False)
    return hashlib.sha1(payload.encode("utf-8")).hexdigest()[:10]


def output_root(base=None) -> Path:
    if base is not None:
        return Path(base)
    try:
        import folder_paths

        return Path(folder_paths.get_output_directory()) / OUTPUT_SUBDIR
    except Exception:
        return Path.cwd() / "output" / OUTPUT_SUBDIR


def write_outputs(root: Path, engine: StoryEngine, result: dict, *, model: str, seed: int, wall: float, style: str = "") -> tuple:
    root.mkdir(parents=True, exist_ok=True)
    stamp = time.strftime("%Y%m%d-%H%M%S")
    stem = f"{stamp}_{engine.clips}clips"
    story_path = root / f"{stem}.md"
    story_path.write_text(result["story"] + "\n", encoding="utf-8")
    calls = engine.calls
    stops: dict = {}
    for c in calls:
        stops[c["finish"]] = stops.get(c["finish"], 0) + 1
    beats = result["beats"]
    side = {
        "brief_sha1": hashlib.sha1(engine.brief.encode("utf-8")).hexdigest(), "brief_chars": len(engine.brief), "clips_requested": engine.clips, "beats_written": len(beats),
        "seconds": engine.seconds, "language": engine.language, "seed": seed, "model": model, "api_style": style, "version": VERSION,
        "title": result["outline"].get("title"), "cast": [c["name"] for c in result["outline"]["cast"]],
        "story_chars": len(result["story"]), "story_words": len(result["story"].split()), "e4_estimated_clips": int(math.ceil(e4_weight(result["story"]))),
        "spoken_words_per_beat": [quoted_words(b) for b in beats], "calls": len(calls),
        "tokens": {"prompt": sum(c["prompt_tokens"] for c in calls), "completion": sum(c["completion_tokens"] for c in calls), "thinking": sum(c["thinking_tokens"] for c in calls)},
        "stop_reasons": stops, "warnings": engine.warnings, "wall_seconds": round(wall, 1), "work_dir": str(engine.work),
        "call_log": calls, "written_at": time.strftime("%Y-%m-%d %H:%M:%S"),
    }
    json_path = root / f"{stem}.json"
    json_path.write_text(json.dumps(side, indent=1, ensure_ascii=False), encoding="utf-8")
    return story_path, json_path, side


def write_story(chat, *, brief: str, clips: int, seconds: int = DEFAULT_SECONDS, language: str = DEFAULT_LANGUAGE, seed: int = 0, model: str = "model", style: str = "",
                budget: int = THINKING_BUDGET, slot_ctx: int = 65536, out_dir=None, progress=None, say=None, chunk_beats: int = CHUNK_BEATS) -> dict:
    """The whole job with an injected ``chat``: validate, resume or start, write, save. Returns ``{story, story_path, json_path, sidecar}``."""
    brief = str(brief or "").strip()
    if not brief:
        raise StoryWriterError("brief is empty")
    clips = int(clips)
    if not MIN_CLIPS <= clips <= MAX_CLIPS:
        raise StoryWriterError(f"clips must be {MIN_CLIPS} to {MAX_CLIPS}, got {clips}")
    root = output_root(out_dir)
    work = root / "_work" / job_hash(brief, clips, seconds, language, seed, model, budget)
    started = time.time()
    engine = StoryEngine(chat, work, brief=brief, clips=clips, seconds=seconds, language=language, slot_ctx=slot_ctx, budget=budget, chunk_beats=chunk_beats,
                         progress=progress, say=say)
    result = engine.run()
    story_path, json_path, side = write_outputs(root, engine, result, model=model, seed=seed, wall=time.time() - started, style=style)
    (work / ".done").write_text(time.strftime("%Y-%m-%d %H:%M:%S"), encoding="utf-8")
    return {"story": result["story"], "story_path": str(story_path), "json_path": str(json_path), "sidecar": side}


# --------------------------------------------------------------------------- the ComfyUI node


def _pack():
    if not prompt_rewriter.available():
        raise StoryWriterError("the MiniMax-H3-Prompt-Rewriter-ComfyUI pack is not installed beside this node; the story writer runs on the model server it opens")
    return (prompt_rewriter._mod("nodes"), prompt_rewriter._mod("paths"), prompt_rewriter._mod("mtmd_engine"), prompt_rewriter._mod("server_engine"),
            prompt_rewriter._mod("runner"))


@contextlib.contextmanager
def open_model(writer_label: str, budget: int, *, slot_ctx: int, say=None):
    """The model server for the story writer: the rewriter pack's own session (a vision model from its list, on ninfer-serve or llama-server) or Strata, closed on exit."""
    say = say or (lambda message: None)
    nodes, paths, mtmd, server_engine, runner = _pack()
    if not writer_label or writer_label.startswith("("):
        raise StoryWriterError("writer_model: pick a model from the list (the rewriter pack's model list)")
    strata = writer_label == strata_backend.LABEL
    model_path, mmproj_path = ("", "") if strata else prompt_rewriter._vision_files(nodes, paths, writer_label)
    if not strata and not model_path:
        raise StoryWriterError("the story writer needs a model that runs on a server (a vision model from the pack's list, or Strata); "
                               f"'{writer_label}' does not. Pick another writer_model.")
    reasoning = {"enabled": True, "budget": budget, "message": BUDGET_MESSAGE}
    try:
        with contextlib.ExitStack() as stack:
            if strata:
                say("starting Strata")
                server = stack.enter_context(strata_backend.open_strata(budget, adopt=getattr(runner, "_adopt", None), on_wait=lambda s: say(f"waiting for Strata ({s:.0f} s)")))
            else:
                say(f"loading {os.path.basename(model_path)}")
                server = stack.enter_context(mtmd.session(model_path, mmproj_path, assets=0, attachments=1, gpu_layers=-1, n_ctx=0, device="auto", backend="auto",
                                                         auto_download=True, progress=None, slots=1, force=True, reasoning=reasoning, pool_ctx=slot_ctx))
            if server is None:
                raise StoryWriterError(f"the model server for '{writer_label}' did not start (see the ComfyUI log: minimax_h3_rewriter.server_engine)")
            endpoint = e4_engine.endpoint_of(server, model_path=model_path, strata=strata, is_ninfer=server_engine.is_ninfer)
            endpoint["label"] = os.path.basename(model_path) or writer_label
            yield endpoint, runner
    finally:
        vram_release.release("h3 story writer finished")


class H3StoryWriter:
    """Brief to full story. Feed its ``story`` to the Master Extender's story input (story_engine=e4.10)."""

    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {
            "brief": ("STRING", {"default": "", "multiline": True, "tooltip": "The idea, however short: who, where, what happens, the genre and tone. Spoken lines you already want are kept word for word."}),
            "clips": ("INT", {"default": 8, "min": MIN_CLIPS, "max": MAX_CLIPS, "tooltip": "How many clips the story should become. The story has exactly this many beats, one distinct dramatic moment each, so E4 (auto mode) plans about this many clips."}),
            "seconds": ("INT", {"default": DEFAULT_SECONDS, "min": 4, "max": 30, "tooltip": "Seconds of screen time per clip. Sizes each beat and the most speech it carries (about 2 words per second at most, leaving room for action)."}),
            "language": ("STRING", {"default": DEFAULT_LANGUAGE, "tooltip": "The language of every spoken line and of the narration (same meaning as the Extender's e4_language). A language not written in Latin script is written in its own script."}),
            "seed": ("INT", {"default": 42, "min": 0, "max": 2147483647, "control_after_generate": True, "tooltip": "Part of the key under which a half-finished run is resumed; change it to write a different version of the same brief. Leave the control on fixed: ComfyUI then reuses the story until an input changes."}),
            "writer_model": (prompt_rewriter.writer_choices(), {"tooltip": "The rewriter pack's model list, the same as the Extender's rewrite_writer_model: a vision model on ninfer-serve or llama-server, or Strata. The server is started for this node and closed after it, so the render that follows has the GPU."}),
            "thinking_budget": (prompt_rewriter.REASONING_BUDGETS, {"default": "4096", "tooltip": "Thinking tokens at most per call, on top of the answer."}),
        }}

    RETURN_TYPES = ("STRING",)
    RETURN_NAMES = ("story",)
    FUNCTION = "write"
    CATEGORY = "MiniMax H3 Master"
    OUTPUT_NODE = False

    @classmethod
    def VALIDATE_INPUTS(cls, thinking_budget=None):
        return True

    def write(self, brief, clips, seconds, language, seed, writer_model, thinking_budget="4096"):
        budget = int(prompt_rewriter.reasoning_budget(thinking_budget))
        slot_ctx = e4_engine.slot_ctx()
        bar = None
        try:
            import comfy.utils

            bar = comfy.utils.ProgressBar(int(clips) + 1)
        except Exception:
            bar = None
        last = {"n": 0}

        def progress(done, total):
            if bar is not None and done > last["n"]:
                bar.update(done - last["n"])
                last["n"] = done

        def say(message):
            _LOG.info("H3 Story Writer: %s", message)

        with open_model(str(writer_model), budget, slot_ctx=slot_ctx, say=say) as (endpoint, runner):
            chat = ServerChat(endpoint, interrupted=getattr(runner, "interrupted", None))
            result = write_story(chat, brief=brief, clips=clips, seconds=seconds, language=language, seed=seed, model=endpoint["model"], style=endpoint["style"],
                                 budget=budget, slot_ctx=slot_ctx, progress=progress, say=say)
        side = result["sidecar"]
        print(f"[H3 Story Writer] {side['beats_written']} beats, {side['story_words']} words, ~{side['e4_estimated_clips']} clips by E4's size estimate, "
              f"{side['wall_seconds']:.0f} s -> {result['story_path']}", flush=True)
        for warning in side["warnings"]:
            print(f"[H3 Story Writer] warning: {warning}", flush=True)
        return (result["story"],)


NODE_CLASS_MAPPINGS = {"H3StoryWriter": H3StoryWriter}
NODE_DISPLAY_NAME_MAPPINGS = {"H3StoryWriter": "H3 Story Writer (brief to story)"}
