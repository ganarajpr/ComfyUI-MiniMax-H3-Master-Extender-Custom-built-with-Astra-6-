#!/usr/bin/env python3
"""E4.8 on a long story, end to end, through the bridge the way e4_engine.py calls it, against the 5090 gateway's ninfer lane. No pictures.

  e4_longstory_proof.py --story story.txt --out DIR [--language Hindi] [--workers 4] [--slot-ctx 65536] [--max-tokens-ceiling 12288]

The environment is e4_engine.build_env (the same settings the extender sends); --slot-ctx / --max-tokens-ceiling override the slot context and the hard ceiling
(12288 with --slot-ctx 32768 is the old fixed cap). Refuses to start while the gateway shows work in flight or the ComfyUI queue is not empty. Prints, per call
kind, the calls, the largest prompt and reply and how many were cut at max_tokens, and writes DIR/proof.json.
"""
from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import time
import urllib.request
from collections import defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))
import e4_engine  # noqa: E402

GATEWAY = "http://5090.tail3cca41.ts.net:9000"
ENDPOINT = f"{GATEWAY}/ninfer-swift15"
MODEL = "swift-1.5-qwen3.8-27b-orcarouter"


def get(url):
    with urllib.request.urlopen(url, timeout=30) as a:
        return json.load(a)


def gate():
    status = get(f"{GATEWAY}/status")
    busy = {k: v for k, v in (status.get("inflight") or {}).items() if v}
    queue = get(f"{GATEWAY}/comfyui/queue")
    if busy or queue.get("queue_running") or queue.get("queue_pending"):
        sys.exit(f"GPU not free: inflight {busy}, comfyui queue {queue}")


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--story", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--language", default="English")
    ap.add_argument("--workers", type=int, default=4)
    ap.add_argument("--slot-ctx", type=int, default=0)
    ap.add_argument("--max-tokens-ceiling", type=int, default=0)
    ap.add_argument("--no-gate", action="store_true")
    ap.add_argument("--resume", action="store_true")
    ap.add_argument("--stop-after", default="", help="plan | bible: stop the run after that stage")
    a = ap.parse_args()
    if not a.no_gate:
        gate()
    out = Path(a.out).resolve()
    out.mkdir(parents=True, exist_ok=True)
    if a.slot_ctx:
        os.environ[e4_engine.SLOT_CTX_ENV] = str(a.slot_ctx)
    if a.max_tokens_ceiling:
        os.environ[e4_engine.MAX_TOKENS_ENV] = str(a.max_tokens_ceiling)
    env = e4_engine.build_env({"url": ENDPOINT, "model": MODEL, "style": "ninfer-messages"}, decision=0, score="off")
    story = Path(a.story).read_text(encoding="utf-8").strip()
    job = {"name": "story", "story": story, "language": a.language, "score": "off", "workers": a.workers, "resume": a.resume, "out": str(out), "vision": False, "pictures": [], "notes": {}}
    if a.stop_after:
        job["stopAfter"] = a.stop_after
    (out / "job.json").write_text(json.dumps(job, ensure_ascii=False), encoding="utf-8")
    node = os.environ.get("MINIMAX_H3_E4_NODE") or "node"
    t0 = time.time()
    proc = subprocess.run([node, str(ROOT / "e4" / "bridge" / "run.mjs"), str(out / "job.json")], env=env, capture_output=True, text=True, cwd=str(ROOT))
    wall = time.time() - t0
    (out / "stdout.txt").write_text(proc.stdout, encoding="utf-8")
    (out / "stderr.txt").write_text(proc.stderr, encoding="utf-8")
    kinds = defaultdict(lambda: {"calls": 0, "max_prompt": 0, "max_output": 0, "max_cap": 0, "cut": 0, "escalated": 0, "secs": 0.0})
    cap_of = {}
    calls = out / "calls.jsonl"
    rows = [json.loads(l) for l in calls.read_text(encoding="utf-8").splitlines() if l.strip()] if calls.exists() else []
    for r in rows:
        k = kinds[r.get("kind")]
        u = r.get("usage") or {}
        k["calls"] += 1
        k["max_prompt"] = max(k["max_prompt"], u.get("prompt_tokens") or 0)
        k["max_output"] = max(k["max_output"], u.get("completion_tokens") or 0)
        k["cut"] += 1 if (r.get("finish") == "length" or r.get("cut")) else 0
        k["escalated"] += 1 if r.get("escalated") else 0
        k["secs"] += r.get("secs") or 0
    for req in out.rglob("*.request.json"):
        try:
            b = json.loads(req.read_text(encoding="utf-8"))
        except ValueError:
            continue
        kind = "planner" if "planner" in req.parts else "bible" if "bible" in req.parts else None
        if kind:
            kinds[kind]["max_cap"] = max(kinds[kind]["max_cap"], b.get("max_tokens") or 0)
    clips = None
    cj = out / "clips.json"
    if cj.exists():
        c = json.loads(cj.read_text(encoding="utf-8"))["clips"]
        clips = {"planned": len(c), "written": sum(1 for x in c if x.get("prompt"))}
    report = {"exit": proc.returncode, "wall_secs": round(wall), "env": {k: env[k] for k in env if k.startswith("E4_LLM_SLOT") or k == "E4_LLM_MAX_TOKENS"}, "story_chars": len(story), "clips": clips, "kinds": kinds,
              "stderr_tail": proc.stderr.strip().splitlines()[-6:]}
    (out / "proof.json").write_text(json.dumps(report, indent=1), encoding="utf-8")
    print(json.dumps(report, indent=1))
    sys.exit(proc.returncode)


if __name__ == "__main__":
    main()
