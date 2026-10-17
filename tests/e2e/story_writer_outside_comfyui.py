#!/usr/bin/env python3
"""The H3 Story Writer end to end, OUTSIDE ComfyUI, against a real model server (the 5090 gateway's ninfer lane), then (--e4) the vendored E4.10 planner on
the story it wrote: clips requested vs planned, utterances, and whether every planned line exists verbatim in the story.

  story_writer_outside_comfyui.py --brief-file brief.txt --clips 6 --out DIR [--language English] [--seconds 15] [--e4] [--endpoint URL]

Same gate as e4_outside_comfyui.py: refuses to start unless the gateway shows nothing in flight and (when ComfyUI is the active backend) an empty queue; never
starts or restarts anything. Requests go out ``--concurrency`` at a time (the node's setting; 1 reproduces the old sequential writer when ``--impl-root`` is a
checkout of the old code).

  --openrouter MODEL   (this script only; the node has no such path) run against an OpenRouter-compatible endpoint instead of the local gateway: no gate, no
                       wake, the key is read from dhee-core's .env (the first sk-or value among LLM_JUDGE_API_KEY, OPENROUTER_API_KEY, OPENAI_API_KEY) and never
                       printed; every call's cost is added to --ledger and the run refuses to go past --cap dollars.
  --impl-root DIR      import story_writer.py from this checkout instead of the repo (to run the code on another branch as the baseline).

Output (DIR): the story (.md) and its sidecar (.json) under DIR/h3_story_writer/, the kept work folder
(outline, every request and reply) beside them, and with --e4 DIR/e4/ (the planner's run) and DIR/e4_check.json.
"""

from __future__ import annotations

import argparse
import importlib.util
import json
import os
import re
import subprocess
import sys
import threading
import time
import unicodedata
import urllib.error
import urllib.request
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(HERE))
DEFAULT_ENDPOINT = "http://5090.tail3cca41.ts.net:9000/ninfer-swift15"
GATEWAY = "http://5090.tail3cca41.ts.net:9000"
OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions"
ENV_FILE = Path.home() / "Projects" / "dhee-core" / ".env"
story_writer = None


def load_story_writer(impl_root=None):
    """The story_writer module of the repo, or of ``impl_root`` (an older checkout used as the baseline)."""
    global story_writer
    root = Path(impl_root).resolve() if impl_root else ROOT
    sys.path.insert(0, str(root))
    spec = importlib.util.spec_from_file_location("story_writer", root / "story_writer.py")
    story_writer = importlib.util.module_from_spec(spec)
    sys.modules["story_writer"] = story_writer
    spec.loader.exec_module(story_writer)
    return story_writer


def openrouter_key():
    for line in ENV_FILE.read_text(encoding="utf-8").splitlines():
        name, _, value = line.partition("=")
        if name.strip() in ("LLM_JUDGE_API_KEY", "OPENROUTER_API_KEY", "OPENAI_API_KEY") and value.strip().strip("\"'").startswith("sk-or"):
            return value.strip().strip("\"'")
    raise SystemExit("no sk-or key among LLM_JUDGE_API_KEY, OPENROUTER_API_KEY, OPENAI_API_KEY in " + str(ENV_FILE))


class OpenRouterChat:
    """The engine's ``chat`` against OpenRouter chat completions, for this script only. Costs come from the response's ``usage.cost`` and are appended to a ledger file."""

    def __init__(self, model, key, ledger, cap, retries=4):
        self.model, self.key, self.ledger, self.cap, self.retries = model, key, Path(ledger), cap, retries
        self.lock = threading.Lock()
        self.cost = 0.0

    def spent(self):
        if not self.ledger.is_file():
            return 0.0
        return sum(json.loads(line)["cost"] for line in self.ledger.read_text().splitlines() if line.strip())

    def __call__(self, messages, *, max_tokens, budget, kind="", temperature=0.6):
        with self.lock:
            if self.spent() >= self.cap:
                raise story_writer.StoryWriterError(f"spend cap ${self.cap} reached")
        body = {"model": self.model, "messages": messages, "max_tokens": max_tokens, "temperature": temperature, "reasoning": {"max_tokens": max(1024, budget)},
                "usage": {"include": True}}
        headers = {"Content-Type": "application/json", "Authorization": "Bearer " + self.key}
        last = ""
        for attempt in range(1, self.retries + 1):
            started = time.time()
            try:
                request = urllib.request.Request(OPENROUTER_URL, data=json.dumps(body).encode("utf-8"), headers=headers)
                with urllib.request.urlopen(request, timeout=600) as answer:
                    payload = json.loads(answer.read().decode("utf-8"))
                if payload.get("error") or not payload.get("choices"):
                    last = str(payload.get("error"))[:300]
                else:
                    return self.parse(payload, time.time() - started)
            except urllib.error.HTTPError as error:
                last = f"HTTP {error.code} {error.read().decode('utf-8', errors='replace')[:300]}"
                if error.code in (400, 401, 402, 403, 404):
                    raise story_writer.StoryWriterError("OpenRouter refused the request: " + last) from error
            except (urllib.error.URLError, OSError, ValueError) as error:
                last = str(error)
            time.sleep(3 * attempt)
        raise story_writer.LLMUnavailable("OpenRouter did not answer: " + last)

    def parse(self, payload, secs):
        choice = payload["choices"][0]
        usage = payload.get("usage") or {}
        cost = float(usage.get("cost") or 0.0)
        with self.lock:
            self.cost += cost
            with open(self.ledger, "a", encoding="utf-8") as handle:
                handle.write(json.dumps({"model": self.model, "cost": cost, "at": time.strftime("%H:%M:%S")}) + "\n")
        text = (choice.get("message") or {}).get("content") or ""
        think = (usage.get("completion_tokens_details") or {}).get("reasoning_tokens") or 0
        return story_writer.Reply(story_writer.strip_think(text), "length" if choice.get("finish_reason") == "length" else "stop", int(usage.get("prompt_tokens") or 0),
                                  int(usage.get("completion_tokens") or 0), int(think), secs)


def normal(text):
    text = unicodedata.normalize("NFC", str(text)).casefold()
    return " ".join("".join(ch if unicodedata.category(ch)[0] in "LMN" else " " for ch in text).split())


def check_plan(story, plan_file):
    plan = json.loads(Path(plan_file).read_text(encoding="utf-8"))["plan"]
    lines = [{"clip": c["clip"], "shot": s["shot"], "speaker": (s.get("dialogue") or {}).get("speaker", ""), "line": s["dialogue"]["line"]}
             for c in plan["clips"] for s in c["shots"] if (s.get("dialogue") or {}).get("line")]
    haystack = normal(story)
    missing = [x for x in lines if normal(x["line"]) not in haystack]
    return {"clips_planned": len(plan["clips"]), "utterances": len(lines), "verbatim": len(lines) - len(missing), "not_verbatim": missing,
            "story_quoted_lines": len(story_writer.QUOTED.findall(story)), "parts": plan.get("parts")}


def check_e4(story, language, endpoint, out, workers=2):
    run = out / "e4"
    run.mkdir(parents=True, exist_ok=True)
    job = {"name": "story", "story": story, "language": language, "score": "off", "workers": workers, "resume": False, "out": str(run), "vision": False,
           "pictures": [], "notes": {}, "stopAfter": "bible"}
    (run / "job.json").write_text(json.dumps(job, ensure_ascii=False), encoding="utf-8")
    import e4_engine

    node = e4_engine.find_node()
    t0 = time.time()
    proc = subprocess.run([node, str(ROOT / "e4" / "bridge" / "run.mjs"), str(run / "job.json")], cwd=str(ROOT / "e4"),
                          env=e4_engine.build_env(endpoint, decision=0, score="off"), capture_output=True, text=True, encoding="utf-8", errors="replace")
    secs = time.time() - t0
    plan_file = run / "story" / "plan.json"
    if not plan_file.is_file():
        return {"ok": False, "error": (proc.stderr or proc.stdout)[-800:], "secs": round(secs, 1)}
    later = (proc.stderr or proc.stdout)[-400:] if proc.returncode != 0 else ""
    return {"ok": True, "after_plan_error": later, "secs": round(secs, 1), **check_plan(story, plan_file)}


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--brief-file", required=True)
    ap.add_argument("--clips", type=int, required=True)
    ap.add_argument("--seconds", type=int, default=15)
    ap.add_argument("--language", default="English")
    ap.add_argument("--seed", type=int, default=42)
    ap.add_argument("--out", required=True)
    ap.add_argument("--endpoint", default=DEFAULT_ENDPOINT)
    ap.add_argument("--gateway", default=GATEWAY)
    ap.add_argument("--model", default="swift-1.5-qwen3.8-27b-orcarouter")
    ap.add_argument("--e4", action="store_true", help="plan the written story with the vendored E4.10 and check the lines")
    ap.add_argument("--no-gate", action="store_true")
    ap.add_argument("--chunk-beats", type=int, default=None)
    ap.add_argument("--concurrency", type=int, default=None)
    ap.add_argument("--two-level-min", type=int, default=None)
    ap.add_argument("--openrouter", metavar="MODEL")
    ap.add_argument("--ledger", default=str(HERE / "openrouter_spend.jsonl"))
    ap.add_argument("--cap", type=float, default=3.0)
    ap.add_argument("--impl-root")
    ap.add_argument("--budget", type=int, default=None, help="thinking budget per call (default: the writer's)")
    a = ap.parse_args()
    load_story_writer(a.impl_root)
    out = Path(a.out).resolve()
    out.mkdir(parents=True, exist_ok=True)
    if a.openrouter:
        model, endpoint = a.openrouter, {"style": "openrouter"}
        chat = OpenRouterChat(model, openrouter_key(), a.ledger, a.cap)
        if a.e4:
            raise SystemExit("--e4 needs the local gateway")
    else:
        from e4_outside_comfyui import gate, wake

        if not a.no_gate:
            gate(a.gateway)
        model = wake(a.endpoint, a.model)
        endpoint = {"url": a.endpoint.rstrip("/"), "model": model, "style": "ninfer-messages"}
        chat = story_writer.ServerChat(endpoint)
    extra = {k: v for k, v in (("chunk_beats", a.chunk_beats), ("concurrency", a.concurrency), ("two_level_min", a.two_level_min), ("budget", a.budget)) if v is not None}
    t0 = time.time()
    result = story_writer.write_story(chat, brief=Path(a.brief_file).read_text(encoding="utf-8"), clips=a.clips, seconds=a.seconds, language=a.language, seed=a.seed,
                                      model=model, style=endpoint["style"], out_dir=out / "h3_story_writer", say=lambda m: print("  writer:", m, flush=True), **extra)
    side = result["sidecar"]
    summary = {"requested": a.clips, "beats_written": side["beats_written"], "beats_exact": side["beats_written"] == a.clips, "writer_secs": round(time.time() - t0, 1),
               "tokens": side["tokens"], "calls": side["calls"], "retries": side.get("retries"), "outline_mode": side.get("outline_mode"),
               "concurrency": side.get("concurrency", 1), "chunk_beats": side.get("chunk_beats", getattr(story_writer, "CHUNK_BEATS", None)),
               "seam_issues": side.get("seam_issues"), "kinds": {k: sum(1 for c in side["call_log"] if c["kind"] == k) for k in sorted({c["kind"] for c in side["call_log"]})},
               "cost_usd": round(getattr(chat, "cost", 0.0), 4), "stop_reasons": side["stop_reasons"], "e4_estimate": side["e4_estimated_clips"], "words": side["story_words"],
               "warnings": side["warnings"], "story": result["story_path"]}
    if a.e4:
        summary["e4"] = check_e4(result["story"], a.language, endpoint, out)
        (out / "e4_check.json").write_text(json.dumps(summary["e4"], indent=1, ensure_ascii=False), encoding="utf-8")
    (out / "summary.json").write_text(json.dumps(summary, indent=1, ensure_ascii=False), encoding="utf-8")
    print(json.dumps({k: v for k, v in summary.items() if k != "e4"} | ({"e4": {k: v for k, v in summary["e4"].items() if k != "not_verbatim"}} if a.e4 else {}), indent=1, ensure_ascii=False))
    if a.e4 and summary["e4"].get("not_verbatim"):
        print("not verbatim:", json.dumps(summary["e4"]["not_verbatim"], ensure_ascii=False, indent=1))


if __name__ == "__main__":
    main()
