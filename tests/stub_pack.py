"""Test harness shared by the story-engine tests: drives ``prompt_rewriter.rewrite_clips`` with the rewriter pack and ComfyUI stubbed.

Only plumbing is stubbed (the pack's modules, the server session, torch tensors); the extender's own code (prompt_rewriter, story_planner,
e4_engine) runs as it is. It needs no torch, so it runs on any machine with numpy and Pillow, and it runs against any checkout of the extender
(``root``), which is how the builder-mode golden file is made from the base commit.
"""

from __future__ import annotations

import contextlib
import hashlib
import importlib
import json
import logging
import os
import random
import sys
import tempfile
import types
from pathlib import Path


class Tensor:
    """Just enough of a torch IMAGE tensor ([1, H, W, 3], float 0..1) for the extender's picture code."""

    def __init__(self, array):
        self.a = array

    def dim(self):
        return self.a.ndim

    def __getitem__(self, i):
        return Tensor(self.a[i])

    def detach(self):
        return self

    def cpu(self):
        return self

    def float(self):
        return self

    def numpy(self):
        return self.a


def make_pictures(slots=(0, 1), side=280):
    """Distinct, deterministic pictures keyed ``ref_image_<slot>`` (slot 0 is Picture 1)."""
    import numpy

    refs = {}
    for slot in slots:
        array = numpy.zeros((side, side, 3), dtype=numpy.float32)
        array[..., slot % 3] = 0.8
        array[: side // 2, : side // 2, (slot + 1) % 3] = 0.5
        refs[f"ref_image_{slot}"] = Tensor(array[None, ...])
    return refs


def digest(text) -> str:
    return hashlib.sha256(str(text).encode("utf-8")).hexdigest()[:16]


def plain(messages):
    """messages with every picture data URI replaced by its hash, so a request can be compared and stored."""
    def fix(part):
        if isinstance(part, dict) and part.get("type") == "image_url":
            return {"type": "image_url", "image_url": {"url": "sha256:" + digest(part["image_url"]["url"])}}
        return part
    return [{"role": m["role"], "content": [fix(p) for p in m["content"]] if isinstance(m["content"], list) else m["content"]} for m in messages]


class Record:
    def __init__(self):
        self.chats = []
        self.sessions = []
        self.progress = []
        self.plans = []
        self.streams = []
        self.logs = []


def run_rewrite(root, settings, clips, *, refs, writer_suffix=".gguf", vision=True, reply=None, server_base="http://127.0.0.1:1", model_id="stub-model",
                strata=False, plan_reply=None, user_dir=None):
    """Run ``rewrite_clips`` of the checkout at ``root``. Returns (Record, notes, clips). ``reply(messages) -> str`` answers a writer call;
    ``plan_reply(messages) -> str`` a planner call (default: the checkout's own ``tests/test_story_planner.plan_json``)."""
    root = Path(root).resolve()
    for name in ("prompt_rewriter", "story_planner", "strata_backend", "e4_engine", "test_story_planner"):
        sys.modules.pop(name, None)
    sys.path.insert(0, str(root))
    sys.path.insert(0, str(root / "tests"))
    try:
        pr = importlib.import_module("prompt_rewriter")
        sb = importlib.import_module("strata_backend")
        plan_json = importlib.import_module("test_story_planner").plan_json
    finally:
        sys.path.remove(str(root))
        sys.path.remove(str(root / "tests"))
    rec = Record()
    folder = tempfile.mkdtemp()
    path = os.path.join(folder, "writer-stub" + writer_suffix)
    open(path, "w").close()

    writer = types.SimpleNamespace(local=True, reference=path, mmproj="", file="")
    captioner = types.SimpleNamespace(local=True, reference=path, mmproj="mm.gguf", file="")
    other = types.SimpleNamespace(local=True, reference=path + ".other", mmproj="mm2.gguf", file="")
    listed = {"cap": captioner} if vision else {"other": other}
    nodes = types.SimpleNamespace(
        _resolve_writer_choice=lambda label: writer, _resolve_captioner_choice=lambda label: listed[label],
        captioner_choices=lambda: list(listed), DEFAULT_OPTIONS={}, caption_question=lambda *a: "?",
        run_messages=lambda *a, **k: (_ for _ in ()).throw(RuntimeError("the in-process writer must not run")))

    def build(guide, task, prompt, resolution, duration, block, system=""):
        return [{"role": "system", "content": f"SYSTEM[{task}]"}, {"role": "user", "content": f"duration: {duration:g}\nreferences:\n{block}\noriginal_prompt:\n{prompt}"}]

    def text_of(content):
        return content if isinstance(content, str) else " ".join(p.get("text", "") for p in content if p["type"] == "text")

    class Server:
        def __init__(self):
            self.base = server_base
            self.model = model_id
            self.model_id = model_id

        def chat(self, messages, **kw):
            rec.chats.append({"messages": plain(messages), "kw": {k: v for k, v in sorted(kw.items()) if not callable(v)}})
            text = text_of(messages[0]["content"])
            if "Break the chapter below" in text:
                return (plan_reply or (lambda m: plan_json(2)))(messages)
            return (reply or (lambda m: "FINAL"))(messages)

    @contextlib.contextmanager
    def session(model_path, mmproj_path, *args, **kw):
        rec.sessions.append({"model": os.path.basename(model_path), "mmproj": mmproj_path, "kw": {k: (dict(v) if isinstance(v, dict) else v) for k, v in sorted(kw.items())}})
        yield Server()

    @contextlib.contextmanager
    def open_strata(budget, adopt=None, on_wait=None):
        rec.sessions.append({"strata": budget})
        yield Server()

    mods = {
        "nodes": nodes, "paths": types.SimpleNamespace(), "guides": types.SimpleNamespace(text=lambda *a: "G"),
        "guide_prompt": types.SimpleNamespace(GUIDE_FOR_MODE={"Ref2VA": 1, "T2VA": 2}, FIELDS_FOR_MODE={"Ref2VA": ["a"], "T2VA": ["a"]}, build_messages=build, context_needed=lambda m, b: 4096),
        "fields": types.SimpleNamespace(split_fields=lambda t, n: {"a": t}, missing=lambda s, n: []),
        "checks": types.SimpleNamespace(looping=lambda t: False),
        "mtmd_engine": types.SimpleNamespace(session=session, describe=lambda **k: "", clip_note=lambda *a: ""),
        "aspect": types.SimpleNamespace(resolve=lambda a, d: "16:9"),
        "constants": types.SimpleNamespace(answer_only=lambda t: t),
        "runner": types.SimpleNamespace(_adopt=lambda p: None),
        "progress": types.SimpleNamespace(NodeProgress=lambda x: None),
        "server_engine": types.SimpleNamespace(is_ninfer=lambda p: str(p).endswith(".ninfer")),
    }
    saved = (pr._mod, pr.available, pr._load_cache, pr._save_cache, sb.open_strata, sb.vision_available)
    pr._mod = lambda name: mods[name]
    pr.available = lambda: True
    pr._load_cache = lambda: {}
    pr._save_cache = lambda c: None
    sb.open_strata = open_strata
    sb.vision_available = lambda: vision
    if hasattr(pr, "e4_engine") and user_dir is not None:
        pr.e4_engine._user_dir = lambda: Path(user_dir)

    class Collect(logging.Handler):
        def emit(self, record):
            rec.logs.append(record.getMessage())

    handler = Collect()
    level = pr._LOG.level
    pr._LOG.setLevel(logging.INFO)
    pr._LOG.addHandler(handler)
    random.seed(1234)
    try:
        notes = pr.rewrite_clips(
            clips, refs, dict(settings), aspect_text="1280x720",
            progress_cb=lambda stage, message, pct: rec.progress.append([stage, message, round(pct, 3)]),
            stream_cb=lambda index, clip_id, phase, text, source="": rec.streams.append([index, clip_id, phase, digest(text)]),
            plan_cb=lambda planned, positions: rec.plans.append(list(positions)))
    finally:
        pr._mod, pr.available, pr._load_cache, pr._save_cache, sb.open_strata, sb.vision_available = saved
        pr._LOG.removeHandler(handler)
        pr._LOG.setLevel(level)
        os.unlink(path)
        os.rmdir(folder)
    return rec, notes, clips


def snapshot(rec, notes, clips):
    """Everything a builder-mode run did, in a form that compares and stores: the requests, the session, the clips, the messages shown."""
    volatile = {"at", "seconds"}
    cleaned = []
    for clip in clips:
        c = dict(clip)
        if isinstance(c.get("rewrite_meta"), dict):
            c["rewrite_meta"] = {k: v for k, v in c["rewrite_meta"].items() if k not in volatile}
        cleaned.append(c)
    return {"chats": rec.chats, "sessions": rec.sessions, "progress": rec.progress, "plans": rec.plans, "streams": rec.streams,
            "notes": [n if not n.startswith("rewriter:") else n.split(",")[0] for n in notes], "clips": cleaned}


def dumps(obj) -> str:
    return json.dumps(obj, indent=1, sort_keys=True, ensure_ascii=False)
