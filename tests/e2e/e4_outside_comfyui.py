#!/usr/bin/env python3
"""story_engine=e4 end to end, OUTSIDE ComfyUI, on one story, against a real model server (the 5090 gateway's ninfer lane).

The extender's own code runs (prompt_rewriter.rewrite_clips, story_planner, e4_engine, the vendored E4.6 as a Node subprocess); only ComfyUI and the rewriter
pack are stubbed (tests/stub_pack.py), the way extender-eval/x0.py stubs them for the builder. The server the rewriter would have started is replaced by the
lane's address, and the pictures go through the extender's own `_reference_pictures` (896 px PNG data URIs).

  e4_outside_comfyui.py --story story.txt --pictures 1.png,2.png,... --out DIR [--endpoint URL] [--language English] [--score off] [--parallel 3]

It refuses to start unless the gateway shows nothing in flight and (when ComfyUI is the active backend) an empty queue, never starts or restarts anything, and
makes at most --parallel (default 3, at most 4) concurrent calls. Output (DIR): extender_clips.json (the clip list as the panel gets it), prompts/clipNN.txt +
durations.txt + refs.txt (ready to render: REFS= the pictures in Picture order), notes.json, progress.json, user/minimax_h3_master/e4/<run>/ (every request and reply).
"""

from __future__ import annotations

import argparse
import json
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
sys.path.insert(0, str(ROOT / "tests"))
import builder_scenario  # noqa: E402
import stub_pack  # noqa: E402

DEFAULT_ENDPOINT = "http://5090.tail3cca41.ts.net:9000/ninfer-swift15"
GATEWAY = "http://5090.tail3cca41.ts.net:9000"


def get(url):
    with urllib.request.urlopen(url, timeout=30) as answer:
        return json.load(answer)


def gate(gateway):
    status = get(f"{gateway}/status")
    busy = {k: v for k, v in (status.get("inflight") or {}).items() if v}
    if busy or status.get("switch_pending"):
        sys.exit(f"the GPU is not free: inflight {busy}, switch pending {status.get('switch_pending')}")
    if status.get("active") == "comfyui":
        queue = get(f"{gateway}/comfyui/queue")
        if queue.get("queue_running") or queue.get("queue_pending"):
            sys.exit("the ComfyUI queue is not empty")
    return status


def wake(endpoint, model):
    """The gateway loads a lane on its first non-light request (a GET of /v1/models is light and answers 503 until then): one tiny chat request, retried while
    the lane starts. Returns the lane's model id."""
    base = endpoint.rstrip("/")
    body = json.dumps({"model": model, "max_tokens": 8, "messages": [{"role": "user", "content": "Reply with OK."}], "thinking": {"type": "disabled"}}).encode()
    deadline = time.time() + 600
    while True:
        try:
            request = urllib.request.Request(f"{base}/v1/messages", data=body, headers={"Content-Type": "application/json", "anthropic-version": "2023-06-01"})
            with urllib.request.urlopen(request, timeout=300):
                break
        except urllib.error.HTTPError as error:
            if error.code not in (502, 503, 504) or time.time() > deadline:
                sys.exit(f"the lane refused the wake-up request: HTTP {error.code} {error.read()[:300]!r}")
        except (urllib.error.URLError, OSError) as error:
            if time.time() > deadline:
                sys.exit(f"the lane did not answer: {error}")
        time.sleep(10)
    return get(f"{base}/v1/models")["data"][0]["id"]


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--story", required=True)
    ap.add_argument("--pictures", required=True, help="comma-separated image paths in <Picture N> order (at most 9)")
    ap.add_argument("--out", required=True)
    ap.add_argument("--endpoint", default=DEFAULT_ENDPOINT)
    ap.add_argument("--gateway", default=GATEWAY)
    ap.add_argument("--model", default="swift-1.5-qwen3.8-27b-orcarouter", help="the lane's model id (used for the wake-up request; the lane's own id is read afterwards)")
    ap.add_argument("--language", default="English")
    ap.add_argument("--score", choices=["off", "on"], default="off")
    ap.add_argument("--decision-budget", default="off", help="off (default) or 1024 / 2048 / 4096")
    ap.add_argument("--parallel", type=int, default=3)
    ap.add_argument("--notes", default="", help="the e4_picture_notes text")
    ap.add_argument("--no-gate", action="store_true", help="skip the gateway check (the caller has made it)")
    ap.add_argument("--no-vision", action="store_true", help="act as a writer that cannot see pictures")
    a = ap.parse_args()
    out = Path(a.out).resolve()
    out.mkdir(parents=True, exist_ok=True)
    paths = [p for p in a.pictures.split(",") if p]
    if not 1 <= len(paths) <= 9:
        sys.exit("1 to 9 pictures")
    if not a.no_gate:
        gate(a.gateway)
    model = wake(a.endpoint, a.model)
    story = Path(a.story).read_text(encoding="utf-8").strip()

    import numpy
    from PIL import Image

    refs = {}
    for slot, p in enumerate(paths):
        array = numpy.asarray(Image.open(p).convert("RGB"), dtype=numpy.float32) / 255.0
        refs[f"ref_image_{slot}"] = stub_pack.Tensor(array[None, ...])
    settings = dict(builder_scenario.BASE, rewrite_story=story, auto_clips=1, rewrite_parallel=min(4, max(1, a.parallel)), story_engine="e4.8", e4_language=a.language,
                    e4_score=a.score, e4_decision_budget=a.decision_budget, e4_picture_notes=a.notes, rewrite_thinking=False)
    t0 = time.time()
    rec, notes, clips = stub_pack.run_rewrite(ROOT, settings, builder_scenario.clips_empty(1), refs=refs, writer_suffix=".ninfer", vision=not a.no_vision,
                                              server_base=a.endpoint.rstrip("/"), model_id=model, user_dir=out / "user" / "minimax_h3_master")
    secs = time.time() - t0
    (out / "extender_clips.json").write_text(json.dumps(clips, indent=1, ensure_ascii=False), encoding="utf-8")
    (out / "notes.json").write_text(json.dumps(notes, indent=1), encoding="utf-8")
    (out / "progress.json").write_text(json.dumps(rec.progress, indent=1), encoding="utf-8")
    (out / "logs.txt").write_text("\n".join(rec.logs), encoding="utf-8")
    prompts = out / "prompts"
    prompts.mkdir(exist_ok=True)
    durations = []
    for i, clip in enumerate(clips, start=1):
        (prompts / f"clip{i:02d}.txt").write_text(clip["prompt"], encoding="utf-8")
        durations.append(f"clip{i:02d} {clip['duration']}")
    (prompts / "durations.txt").write_text("\n".join(durations) + "\n", encoding="utf-8")
    (prompts / "refs.txt").write_text(",".join(str(Path(p).resolve()) for p in paths) + "\n", encoding="utf-8")
    meta = {"endpoint": a.endpoint, "model": model, "pictures": paths, "seconds": round(secs, 1), "clips": len(clips), "builder_chats": len(rec.chats),
            "settings": {k: v for k, v in settings.items() if k.startswith("e4_") or k in ("story_engine", "rewrite_parallel")}, "notes": notes}
    (out / "meta.json").write_text(json.dumps(meta, indent=1), encoding="utf-8")
    print(json.dumps({k: meta[k] for k in ("model", "seconds", "clips", "builder_chats", "notes")}, indent=1))


if __name__ == "__main__":
    main()
