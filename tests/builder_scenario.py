"""The story-mode scenarios whose builder-engine behaviour must not change (story_engine absent or 'builder').

``python tests/builder_scenario.py --root <checkout> --out golden.json`` records what ``rewrite_clips`` of that checkout sends and writes:
every planner and writer request (messages with the pictures hashed, and the call's arguments), the server session it opens, the clips, the
progress lines and the notes. ``tests/fixtures/builder_story_b12b03d.json`` was made from commit b12b03d, before story_engine existed;
``test_e4_engine.BuilderUnchanged`` runs the same scenarios on the current tree and requires the identical record.
"""

from __future__ import annotations

import argparse
import copy
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import stub_pack  # noqa: E402

STORY = ("Ana, a night-shift nurse, leaves her flat in the rain and walks across the city to the central station. She catches the last train "
         "to her sister's coast town and sleeps against the window. At dawn the train reaches the coast and Ana steps onto an empty platform.")
BASE = {"rewrite_mode": "pending clips", "rewrite_writer_model": "w", "rewrite_task": "Ref2VA", "rewrite_parallel": 1, "rewrite_previous_clips": "raw asks",
        "rewrite_max_new_tokens": 100, "rewrite_story": STORY, "auto_clips": 2, "planner_refs": "images", "auto_clip_seconds": 15, "rewrite_thinking": True,
        "rewrite_reasoning_budget": "2048", "rewrite_reasoning_budget_message": "Wrap up.", "rewrite_greedy": True, "rewrite_seed": 42}
# What a workflow saved with the story engine widgets sends when the engine is the builder.
NEW_WIDGETS = {"story_engine": "builder", "e4_language": "English", "e4_score": "off", "e4_decision_budget": "2048", "e4_picture_notes": ""}


def clips_empty(n=1):
    return [{"id": i, "title": f"Clip {i + 1}", "prompt": "", "duration": 15, "beyond": False, "seed": 1, "seed_mode": "fixed", "validated": False, "loras": []} for i in range(n)]


def scenarios():
    final = dict(BASE, rewrite_previous_clips="final prompts")
    typed = clips_empty(3)
    typed[0]["prompt"] = "Ana leaves her flat in the rain."
    return {
        "story_auto_raw_asks": (BASE, clips_empty(1)),
        "story_auto_final_prompts": (final, clips_empty(1)),
        "story_plan_around_typed": (dict(BASE, auto_clips=3), typed),
        "story_auto_no_thinking": (dict(BASE, rewrite_thinking=False), clips_empty(1)),
    }


def record(root, with_new_widgets=False):
    out = {}
    for name, (settings, clips) in scenarios().items():
        settings = dict(settings, **NEW_WIDGETS) if with_new_widgets else dict(settings)
        refs = stub_pack.make_pictures((0, 1))
        rec, notes, done = stub_pack.run_rewrite(root, settings, copy.deepcopy(clips), refs=refs, reply=lambda m: "FINAL " + stub_pack.digest(json.dumps(stub_pack.plain(m))))
        out[name] = stub_pack.snapshot(rec, notes, done)
    return out


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--root", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--new-widgets", action="store_true")
    a = ap.parse_args()
    Path(a.out).write_text(stub_pack.dumps(record(a.root, a.new_widgets)) + "\n", encoding="utf-8")
    print("wrote", a.out)
