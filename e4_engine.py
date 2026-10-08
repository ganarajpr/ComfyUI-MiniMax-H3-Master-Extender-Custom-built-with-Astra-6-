"""story_engine=e4.8: the E4.8 story-to-film pipeline as the Master Extender's story planner and clip writer.

E4 is plain Node (no npm package) vendored under ``e4/`` (see ``e4/MANIFEST.json``, ``e4/verify-frozen.mjs``). Story mode runs it
as ONE subprocess per film (``e4/bridge/run.mjs``) against the SAME model server the rewriter already opened, and puts E4's final prompts
into the clip list as finished clips, so ``builder.md`` is not run for them.

This module owns everything on the Python side: finding Node, describing the model endpoint to E4's config layer (environment variables),
the job file, the subprocess with its progress, and writing E4's clips into the extender's clip dicts. Nothing here imports ComfyUI.
"""

from __future__ import annotations

import base64
import hashlib
import json
import logging
import os
import random
import re
import shutil
import subprocess
import sys
import threading
import time
from collections import deque
from pathlib import Path

_LOG = logging.getLogger("minimax_h3_master_extender.e4")

ENGINES = ["builder", "e4.8"]
ENGINE_ID = "e4.8"
LEGACY_ENGINES = {"e4": ENGINE_ID}   # the value a workflow saved with the E4.6/E4.7 build carries
SCORES = ["off", "on"]
DECISION_THINKING = ["off", "1024", "2048", "4096"]
DECISION_BUDGETS = DECISION_THINKING
ENGINE_NAME = "E4.8"
ENGINE_TAG = "e4.8-frozen"


def normalize_engine(value) -> str:
    """A story_engine value from a widget or a saved workflow: builder, e4.8, or the old name e4 (which is e4.8 now); anything else is builder."""
    value = str(value or "builder").strip()
    value = LEGACY_ENGINES.get(value, value)
    return value if value in ENGINES else "builder"


PLAN_BUDGET = 4096          # planner, bible and writer (and the repairs) think at most this many tokens per call
PICTURE_BUDGET = 2048       # the call that binds the pictures to the entities looks at images: with thinking off it missed a character that thinking 2048 and 4096 found
DECISION_BUDGET_DEFAULT = "off"
BUDGET_MESSAGE = "Time to stop thinking. Give the final answer now."
SLOT_CTX = 32768            # context of one server slot an E4 call may use (largest measured call: 15k prompt + 8k answer)
SLOT_CTX_ENV = "MINIMAX_H3_E4_SLOT_CTX"
MAX_WORKERS = 4
NODE_ENV = "MINIMAX_H3_E4_NODE"
NODE_FILE = "e4_node.txt"
MIN_NODE_MAJOR = 18         # global fetch, AbortSignal.timeout and top-level await
TIMEOUT_SECONDS = 4 * 3600
DEFAULT_LANGUAGE = "English"

NOTE_LINE = re.compile(r"^\s*(?:picture\s*)?(\d{1,2})\s*[:.)\-]\s*(.+?)\s*$", re.IGNORECASE)


class E4Error(RuntimeError):
    pass


def e4_dir() -> Path:
    return Path(__file__).resolve().parent / "e4"


def slot_ctx() -> int:
    try:
        return max(16384, int(os.environ.get(SLOT_CTX_ENV, SLOT_CTX)))
    except ValueError:
        return SLOT_CTX


def max_tokens() -> int:
    """What one reply may use of a slot: the slot minus the longest prompt E4 sends (about 20k tokens)."""
    return max(4096, slot_ctx() - 20480)


def decision_budget(value) -> int:
    """The thinking of the per-clip decision calls: 0 = thinking off (the default: measured 0.6 points below thinking 2048, not significant, and about
    4.7 times faster), else the nearest of 1024 / 2048 / 4096 thinking tokens at most."""
    text = str(value).strip().lower() if value is not None else "off"
    if text in ("", "off", "0", "none", "false", "no"):
        return 0
    try:
        number = int(float(text))
    except ValueError:
        return 0
    if number <= 0:
        return 0
    return min((int(b) for b in DECISION_THINKING if b != "off"), key=lambda b: (abs(b - number), -b))


def decision_label(budget: int) -> str:
    return "thinking off" if not budget else f"thinking {budget}"


def parse_notes(text) -> dict[int, str]:
    """``e4_picture_notes``: one line per picture, ``2: the old tailor in a grey kurta`` or ``Picture 2: ...``."""
    notes: dict[int, str] = {}
    for line in str(text or "").splitlines():
        match = NOTE_LINE.match(line)
        if match and match.group(2).strip():
            notes[int(match.group(1))] = match.group(2).strip()
    return notes


# --------------------------------------------------------------------------- node


def _user_dir() -> Path | None:
    try:
        import folder_paths

        return Path(folder_paths.get_user_directory()) / "minimax_h3_master"
    except Exception:
        return None


def node_version(path: str) -> tuple[int, int, int]:
    try:
        out = subprocess.run([path, "--version"], capture_output=True, text=True, timeout=30).stdout.strip()
    except (OSError, subprocess.SubprocessError) as error:
        raise E4Error(f"cannot run node at '{path}': {error}") from error
    match = re.match(r"v?(\d+)\.(\d+)\.(\d+)", out)
    if not match:
        raise E4Error(f"'{path} --version' answered '{out}', not a Node version")
    return int(match.group(1)), int(match.group(2)), int(match.group(3))


def find_node(user_dir: Path | None = None) -> str:
    """The Node executable E4 runs on: ``MINIMAX_H3_E4_NODE``, else the first line of ``<user>/minimax_h3_master/e4_node.txt``, else PATH."""
    tried = []
    candidates = []
    env = os.environ.get(NODE_ENV, "").strip()
    if env:
        candidates.append((f"environment variable {NODE_ENV}", env))
    folder = user_dir if user_dir is not None else _user_dir()
    if folder is not None and (folder / NODE_FILE).is_file():
        line = (folder / NODE_FILE).read_text(encoding="utf-8").strip().splitlines()
        if line and line[0].strip():
            candidates.append((str(folder / NODE_FILE), line[0].strip().strip('"')))
    found = shutil.which("node")
    if found:
        candidates.append(("PATH", found))
    for where, path in candidates:
        if not os.path.isfile(path):
            tried.append(f"{where}: '{path}' is not a file")
            continue
        major = node_version(path)[0]
        if major < MIN_NODE_MAJOR:
            tried.append(f"{where}: '{path}' is Node {major}, E4 needs {MIN_NODE_MAJOR} or newer")
            continue
        return path
    raise E4Error("story_engine=e4.8 needs Node.js " + str(MIN_NODE_MAJOR) + "+ (no package install, just the executable). Set "
                  + NODE_ENV + " or write its path on the first line of " + (str(folder / NODE_FILE) if folder else NODE_FILE)
                  + (". Tried: " + "; ".join(tried) if tried else ". Nothing found on PATH."))


# --------------------------------------------------------------------------- the model endpoint


def endpoint_of(server, *, model_path: str, strata: bool, is_ninfer) -> dict:
    """How E4's config layer reaches the model the rewriter already opened.

    ninfer-serve (a ``.ninfer`` artifact) is called on its Anthropic-style ``/v1/messages`` where ``thinking.budget_tokens`` is a real per-request cap;
    a llama.cpp server and Strata take chat completions with the top-level ``reasoning_budget_tokens`` and ``reasoning_budget_message``.
    """
    base = str(getattr(server, "base", "") or "").rstrip("/")
    if not base:
        raise E4Error("the rewriter's server has no address E4 can call")
    if strata:
        return {"url": base, "model": str(getattr(server, "model", "") or "local"), "style": "llama-chat"}
    model = str(getattr(server, "model_id", "") or "")
    if is_ninfer(model_path):
        return {"url": base, "model": model, "style": "ninfer-messages"}
    return {"url": base, "model": model or "local", "style": "llama-chat"}


# --------------------------------------------------------------------------- the job


def runs_dir(user_dir: Path | None = None) -> Path:
    folder = user_dir if user_dir is not None else _user_dir()
    base = (folder if folder is not None else Path.cwd() / "minimax_h3_master") / "e4"
    base.mkdir(parents=True, exist_ok=True)
    return base


def job_hash(story: str, language: str, score: str, labels, pictures_sha: list[str], endpoint: dict) -> str:
    payload = json.dumps([story.strip(), language, score, list(labels), pictures_sha, endpoint["model"], endpoint["style"], ENGINE_TAG], ensure_ascii=False)
    return hashlib.sha1(payload.encode("utf-8")).hexdigest()[:10]


def pick_run_dir(root: Path, digest: str) -> tuple[Path, bool]:
    """A run that stopped before its end is resumed (plan, bible and picture binding are kept); a finished one is archived and started again."""
    run = root / digest
    if run.exists() and (run / ".done").exists():
        run.rename(root / f"{digest}-{time.strftime('%Y%m%d-%H%M%S')}")
    resume = run.exists() and (run / "story" / "plan.json").exists() and time.time() - (run / "story" / "plan.json").stat().st_mtime < 24 * 3600
    if run.exists() and not resume:
        run.rename(root / f"{digest}-{time.strftime('%Y%m%d-%H%M%S')}")
    run.mkdir(parents=True, exist_ok=True)
    return run, resume


def decode_picture(data_uri: str) -> bytes:
    head, _, data = data_uri.partition(",")
    if not head.startswith("data:image/png"):
        raise E4Error("a reference picture is not a PNG data URI")
    return base64.b64decode(data)


def build_env(endpoint: dict, *, decision: int, score: str, budget_message: str = BUDGET_MESSAGE) -> dict:
    """E4's config layer, as environment variables. ``decision`` 0 = the per-clip decision calls think off (E4_DECISION_THINKING=off), else their budget."""
    env = dict(os.environ)
    for key in [k for k in env if k.startswith("E4_LLM_") or k == "E4_DECISION_THINKING"]:
        del env[key]
    env.update({
        "E4_LLM_URL": endpoint["url"], "E4_LLM_MODEL": endpoint["model"] or "local", "E4_LLM_API_STYLE": endpoint["style"],
        "E4_LLM_BUDGET_PLANNER": str(PLAN_BUDGET), "E4_LLM_BUDGET_BIBLE": str(PLAN_BUDGET), "E4_LLM_BUDGET_WRITER": str(PLAN_BUDGET),
        "E4_LLM_BUDGET_REPAIR": str(PLAN_BUDGET), "E4_LLM_BUDGET_PICTURE_MAP": str(PICTURE_BUDGET),
        "E4_DECISION_THINKING": str(decision) if decision else "off",
        "E4_LLM_MAX_TOKENS": str(max_tokens()), "E4_LLM_BUDGET_MESSAGE": budget_message or BUDGET_MESSAGE,
        "E4_SCORE": score, "NODE_NO_WARNINGS": "1",
    })
    return env


class Tail:
    """New rows of <run>/calls.jsonl, the one line E4 appends per model call: the progress the panel shows."""

    def __init__(self, path: Path):
        self.path = path
        self.offset = 0

    def rows(self) -> list[dict]:
        if not self.path.is_file():
            return []
        with open(self.path, "rb") as handle:
            handle.seek(self.offset)
            data = handle.read()
        end = data.rfind(b"\n")
        if end < 0:
            return []
        self.offset += end + 1
        out = []
        for line in data[:end].decode("utf-8", errors="replace").splitlines():
            try:
                out.append(json.loads(line))
            except ValueError:
                continue
        return out


def progress_message(row: dict, clips: int | None, seen: dict) -> tuple[str, float]:
    """One call row -> (message, fraction of the E4 span 0..1)."""
    kind, name, clip = row.get("kind"), row.get("name", ""), row.get("clip")
    secs = row.get("secs")
    took = f" ({secs:.0f} s)" if isinstance(secs, (int, float)) else ""
    count = clips or "?"
    if kind == "planner":
        seen["planner"] = seen.get("planner", 0) + 1
        return f"E4: story planned{' again after a failed check' if seen['planner'] > 1 else ''}{took}", 0.12
    if kind == "bible":
        return f"E4: film bible written{took}", 0.25
    if name == "pictures.map":
        return f"E4: reference pictures bound to the film's entities{took}", 0.3
    if kind == "decision":
        staged = seen.setdefault("staged", set())
        staged.add(clip)
        return f"E4: clip {clip}/{count} staged and referenced{took}", 0.3 + 0.2 * (len(staged) / clips if clips else 0.5)
    if kind == "writer":
        seen.setdefault("written", set()).add(clip)
        return f"E4: clip {clip}/{count} written{took}", 0.5 + 0.45 * (len(seen["written"]) / clips if clips else 0.5)
    if kind == "repair":
        return f"E4: clip {clip}/{count} repaired{took}", 0.5 + 0.45 * (len(seen.get("written", ())) / clips if clips else 0.5)
    return f"E4: {kind or 'call'} {name}{took}", 0.5


def plan_clip_count(run: Path) -> int | None:
    try:
        return len(json.loads((run / "story" / "plan.json").read_text(encoding="utf-8"))["plan"]["clips"])
    except (OSError, ValueError, KeyError):
        return None


def plan_film(*, story: str, language: str, score: str, labels: list[int], pictures: dict[int, str], notes: dict[int, str], sees: bool,
              endpoint: dict, decision: int, workers: int, user_dir: Path | None = None, say=None, interrupted=None) -> dict:
    """Run E4 on one story and return its ``clips.json`` (see ``e4/bridge/export.mjs``).

    ``labels`` are the extender's Picture numbers (slot + 1); ``pictures`` maps a number to the PNG data URI the extender sends to its writer
    (only when the writer sees). Every request and reply is stored under the run directory (``<user>/minimax_h3_master/e4/<hash>/story/``).
    """
    say = say or (lambda message, fraction: None)
    node = find_node(user_dir)
    if not (e4_dir() / "bridge" / "run.mjs").is_file():
        raise E4Error(f"{e4_dir() / 'bridge' / 'run.mjs'} is missing: the e4/ folder was not installed")
    language = (language or DEFAULT_LANGUAGE).strip() or DEFAULT_LANGUAGE
    score = "on" if score == "on" else "off"
    shas = [hashlib.sha1(pictures[n].encode("ascii")).hexdigest()[:12] if n in pictures else "" for n in labels]
    digest = job_hash(story, language, score, labels, shas, endpoint)
    run, resume = pick_run_dir(runs_dir(user_dir), digest)
    pdir = run / "pictures"
    pdir.mkdir(exist_ok=True)
    files = []
    for n in labels:
        if n in pictures:
            path = pdir / f"picture_{n}.png"
            path.write_bytes(decode_picture(pictures[n]))
            files.append({"label": n, "file": str(path)})
        else:
            files.append({"label": n, "file": None})
    job = {"name": "story", "story": story, "language": language, "score": score, "workers": max(1, min(MAX_WORKERS, int(workers))), "resume": resume,
           "out": str(run), "vision": bool(sees), "pictures": files, "notes": {str(k): v for k, v in notes.items()},
           "decision_thinking": decision_label(decision), "endpoint": {"style": endpoint["style"], "model": endpoint["model"]}}
    (run / "job.json").write_text(json.dumps(job, indent=1, ensure_ascii=False), encoding="utf-8")
    command = [node, str(e4_dir() / "bridge" / "run.mjs"), str(run / "job.json")]
    _LOG.info("E4: %s (resume=%s) -> %s", " ".join(command), resume, run)
    say(f"E4: starting {ENGINE_NAME} on the story ({len(labels)} picture(s), {'resuming' if resume else 'new run'})", 0.0)
    flags = getattr(subprocess, "CREATE_NO_WINDOW", 0) if os.name == "nt" else 0
    proc = subprocess.Popen(command, cwd=str(e4_dir()), env=build_env(endpoint, decision=decision, score=score), stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                            text=True, encoding="utf-8", errors="replace", creationflags=flags)
    stderr: deque = deque(maxlen=60)
    stdout: deque = deque(maxlen=60)

    def pump(stream, sink):
        for line in iter(stream.readline, ""):
            sink.append(line.rstrip())

    threads = [threading.Thread(target=pump, args=(proc.stdout, stdout), daemon=True), threading.Thread(target=pump, args=(proc.stderr, stderr), daemon=True)]
    for thread in threads:
        thread.start()
    tail, seen, clips = Tail(run / "calls.jsonl"), {}, None
    started = time.time()
    try:
        while proc.poll() is None:
            if interrupted is not None and interrupted():
                proc.kill()
                try:
                    import comfy.model_management as mm
                except ImportError:
                    raise E4Error("interrupted") from None
                raise mm.InterruptProcessingException()
            if time.time() - started > TIMEOUT_SECONDS:
                proc.kill()
                raise E4Error(f"E4 ran longer than {TIMEOUT_SECONDS // 3600} h and was stopped")
            for row in tail.rows():
                clips = clips or plan_clip_count(run)
                message, fraction = progress_message(row, clips, seen)
                say(message, fraction)
            time.sleep(0.5)
    finally:
        if proc.poll() is None:
            proc.kill()
        for thread in threads:
            thread.join(timeout=5)
        for stream in (proc.stdout, proc.stderr):
            stream.close()
    for row in tail.rows():
        message, fraction = progress_message(row, clips or plan_clip_count(run), seen)
        say(message, fraction)
    if proc.returncode != 0:
        last = [line for line in list(stderr)[-12:] if line.strip()] or list(stdout)[-6:]
        raise E4Error(f"{ENGINE_NAME} failed (exit {proc.returncode}); the run is kept in {run} and resumes when the same story is run again:\n" + "\n".join(last))
    try:
        result = json.loads((run / "clips.json").read_text(encoding="utf-8"))
    except (OSError, ValueError) as error:
        raise E4Error(f"{ENGINE_NAME} finished but wrote no readable clips.json in {run}: {error}") from error
    if result.get("engine") != "e4" or not result.get("clips"):
        raise E4Error(f"{ENGINE_NAME} produced no clips ({run})")
    (run / ".done").write_text(time.strftime("%Y-%m-%d %H:%M:%S"), encoding="utf-8")
    result["run_dir"] = str(run)
    return result


# --------------------------------------------------------------------------- into the clip list


def _next_id(clips: list) -> int:
    ids = [c["id"] for c in clips if isinstance(c, dict) and isinstance(c.get("id"), int)]
    return (max(ids) + 1) if ids else 0


def clip_title(number: int, beat: str) -> str:
    beat = " ".join(str(beat or "").split())
    return f"Clip {number}: {beat}" if beat else f"Clip {number}"


def apply_clips(clips: list, result: dict, *, model: str, thinking_budget: int = PLAN_BUDGET) -> list[int]:
    """Write E4's clips into the clip list, which holds only empty clips (E4 plans a whole film at once).

    Existing empty clips are filled first (their id, seed and LoRAs stay), the rest are appended. A clip E4 could not write keeps its planned
    ask as a pending clip, so the builder writes it in the normal pass. Returns the positions written.
    """
    written = []
    when = time.strftime("%Y-%m-%d %H:%M:%S")
    for position, item in enumerate(result["clips"]):
        number = position + 1
        if position < len(clips):
            clip = clips[position]
            if not isinstance(clip, dict):
                continue
            for key in ("prompt_raw", "rewrite_text", "rewrite_meta"):
                clip.pop(key, None)
            default_title = not clip.get("title") or re.fullmatch(r"Clip \d+(: .*)?", str(clip.get("title")), re.DOTALL)
        else:
            clip = {"id": _next_id(clips), "title": "", "duration": 15, "beyond": False, "seed": random.randint(0, 999999999),
                    "seed_mode": "randomize", "validated": False, "loras": []}
            clips.append(clip)
            default_title = True
        if default_title:
            clip["title"] = clip_title(number, item.get("title") or item.get("beat"))
        clip["planned"] = True
        clip["validated"] = False
        end = item.get("endState")
        if isinstance(end, dict):
            clip["plan_end_state"] = end
        raw = str(item.get("rawAsk") or "")
        if item.get("prompt"):
            seconds = int(item["duration"])
            clip["duration"] = seconds
            if seconds > 15:
                clip["beyond"] = True
            clip["prompt_raw"] = raw
            clip["prompt"] = item["prompt"]
            clip["rewrite_text"] = item["prompt"]
            clip["prompt_rewritten"] = True
            clip["rewrite_meta"] = {
                "model": model, "task": "Ref2VA", "engine": "e4", "engine_version": result.get("version") or ENGINE_TAG, "thinking": True,
                "budget": thinking_budget, "seconds": round(float((result.get("stats") or {}).get("wallSecs") or 0) / max(len(result["clips"]), 1), 1),
                "at": when, "duration_exact": item.get("durationExact"), "pictures": [{"picture": p["picture"], "entity": p["entity"]} for p in item.get("pictures", [])],
                "citation_issues": (item.get("checks") or {}).get("citationIssues") or [], "fingerprint": None,
            }
        else:
            clip["prompt"] = raw
            clip["prompt_rewritten"] = False
            _LOG.warning("E4: clip %d has no final prompt (%s); it keeps its planned ask and the builder writes it", number, item.get("failed"))
        written.append(position)
    return written
