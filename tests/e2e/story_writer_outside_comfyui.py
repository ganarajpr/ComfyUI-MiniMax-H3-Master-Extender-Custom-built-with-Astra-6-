#!/usr/bin/env python3
"""The H3 Story Writer end to end, OUTSIDE ComfyUI, against a real model server (the 5090 gateway's ninfer lane), then (--e4) the vendored E4.10 planner on
the story it wrote: clips requested vs planned, utterances, and whether every planned line exists verbatim in the story.

  story_writer_outside_comfyui.py --brief-file brief.txt --clips 6 --out DIR [--language English] [--seconds 15] [--e4] [--endpoint URL]

Same gate as e4_outside_comfyui.py: refuses to start unless the gateway shows nothing in flight and (when ComfyUI is the active backend) an empty queue; never
starts or restarts anything; one call at a time. Output (DIR): the story (.md) and its sidecar (.json) under DIR/h3_story_writer/, the kept work folder
(outline, every request and reply) beside them, and with --e4 DIR/e4/ (the planner's run) and DIR/e4_check.json.
"""

from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
import time
import unicodedata
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(HERE))
import e4_engine  # noqa: E402
import story_writer  # noqa: E402
from e4_outside_comfyui import DEFAULT_ENDPOINT, GATEWAY, gate, wake  # noqa: E402


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
    ap.add_argument("--chunk-beats", type=int, default=story_writer.CHUNK_BEATS)
    a = ap.parse_args()
    out = Path(a.out).resolve()
    out.mkdir(parents=True, exist_ok=True)
    if not a.no_gate:
        gate(a.gateway)
    model = wake(a.endpoint, a.model)
    endpoint = {"url": a.endpoint.rstrip("/"), "model": model, "style": "ninfer-messages"}
    chat = story_writer.ServerChat(endpoint)
    t0 = time.time()
    result = story_writer.write_story(chat, brief=Path(a.brief_file).read_text(encoding="utf-8"), clips=a.clips, seconds=a.seconds, language=a.language, seed=a.seed,
                                      model=model, style=endpoint["style"], out_dir=out / "h3_story_writer", chunk_beats=a.chunk_beats,
                                      say=lambda m: print("  writer:", m, flush=True))
    side = result["sidecar"]
    summary = {"requested": a.clips, "beats_written": side["beats_written"], "writer_secs": round(time.time() - t0, 1), "tokens": side["tokens"], "calls": side["calls"],
               "stop_reasons": side["stop_reasons"], "e4_estimate": side["e4_estimated_clips"], "words": side["story_words"], "warnings": side["warnings"],
               "story": result["story_path"]}
    if a.e4:
        summary["e4"] = check_e4(result["story"], a.language, endpoint, out)
        (out / "e4_check.json").write_text(json.dumps(summary["e4"], indent=1, ensure_ascii=False), encoding="utf-8")
    (out / "summary.json").write_text(json.dumps(summary, indent=1, ensure_ascii=False), encoding="utf-8")
    print(json.dumps({k: v for k, v in summary.items() if k != "e4"} | ({"e4": {k: v for k, v in summary["e4"].items() if k != "not_verbatim"}} if a.e4 else {}), indent=1, ensure_ascii=False))
    if a.e4 and summary["e4"].get("not_verbatim"):
        print("not verbatim:", json.dumps(summary["e4"]["not_verbatim"], ensure_ascii=False, indent=1))


if __name__ == "__main__":
    main()
