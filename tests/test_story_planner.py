import copy
import json
import os
import subprocess
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import prompt_rewriter as pr  # noqa: E402
import story_planner as sp  # noqa: E402

STUDIO = Path(os.environ.get("H3_PROMPT_STUDIO", Path.home() / "Projects" / "h3-prompt-studio"))


def shot(n, seconds, camera, subject="Ana", action="walks on", dialogue=False, line="", speaker=""):
    return {"shot": n, "seconds": seconds, "camera": camera, "subject": subject, "action": action,
            "has_dialogue": dialogue, "dialogue_speaker": speaker, "dialogue_line": line}


def clip_json(n, beat="a beat", shots=None, changes=None):
    return {"clip": n, "beat": beat, "forward_pull": f"What is at the station {n}?",
            "shots": shots or [shot(1, 5, "wide_establishing", "The wet street", "shines under a lamp"),
                               shot(2, 5, "medium", "Ana", "walks on"),
                               shot(3, 5, "close_up", "Her face", "tightens", True, "Not yet.", "Ana")],
            "state_changes": changes or []}


def plan_json(n, ledger=None):
    return json.dumps({"chapter": "A night walk", "ledger": ledger or {"entities": []},
                       "clips": [clip_json(i + 1, f"beat {i + 1}") for i in range(n)]})


class StudioSyncTests(unittest.TestCase):
    def evaluate(self, expr_import, name):
        script = f"import {{ {name} }} from '{STUDIO}/src/lib/{expr_import}.ts'; process.stdout.write({name})"
        out = subprocess.run(["node", "--import", "tsx", "--input-type=module", "-e", script], cwd=STUDIO,
                             capture_output=True, text=True, timeout=120)
        self.assertEqual(out.returncode, 0, out.stderr)
        return out.stdout

    @unittest.skipUnless((STUDIO / "node_modules" / ".bin" / "tsx").exists(), "Studio checkout not present")
    def test_prompts_equal_studio_source(self):
        self.assertEqual(sp.load_prompt("builder"), self.evaluate("rewriteSystemPrompt", "DEFAULT_REWRITE_SYSTEM_PROMPT"))
        self.assertEqual(sp.load_prompt("planner"), self.evaluate("chapterBreakdown", "CHAPTER_BREAKDOWN_TEMPLATE"))


class PromptFileTests(unittest.TestCase):
    def test_header_stripped_placeholders_kept(self):
        planner = sp.load_prompt("planner")
        self.assertTrue(planner.startswith("Break the chapter below into fixed 15-second"))
        self.assertIn("{{runtimeInstruction}}", planner)
        self.assertIn("{{chapter}}", planner)
        self.assertIn(", ".join(sp.CAMERA_SHOTS), planner)
        self.assertTrue(sp.load_prompt("builder").startswith("You write MiniMax H3 (Hailuo 03) video prompts in full-reference mode"))
        raw = (Path(sp.PROMPT_DIR) / "builder.md").read_text(encoding="utf-8")
        self.assertIn("canonical copy lives HERE", raw.split("-->")[0])

    def test_template_filling_target_and_auto(self):
        out = sp.build_user_message("  Ana walks.  ", 3)
        self.assertNotIn("{{", out)
        self.assertIn("EXACTLY 3 clips of 15 seconds each (45s total)", out)
        self.assertIn("CHAPTER:\nAna walks.\n", out)
        self.assertIn("OUTPUT FORMAT", out)
        self.assertIn("EXACTLY 1 clip of 15 seconds each (15s total)", sp.runtime_instruction("target", 1))
        self.assertTrue(sp.runtime_instruction("auto").startswith("RUNTIME — AUTO"))


class SystemChoiceTests(unittest.TestCase):
    def test_empty_ref2va_is_builder_t2va_official_override_wins(self):
        text, name = pr.choose_system("", "Ref2VA")
        self.assertEqual(text, sp.load_prompt("builder"))
        self.assertEqual(pr.choose_system("", "T2VA")[0], "")
        self.assertEqual(pr.choose_system("  @official ", "Ref2VA")[0], "")
        self.assertEqual(pr.choose_system("my house style", "Ref2VA")[0], "my house style")
        self.assertEqual(pr.choose_system("@OFFICIAL", "T2VA")[0], "")


class ParseCheckTests(unittest.TestCase):
    def test_parse_fenced_and_garbage(self):
        self.assertIsNone(sp.parse_breakdown("no json here"))
        self.assertIsNone(sp.parse_breakdown('{"chapter": "x", "clips": []}'))
        b = sp.parse_breakdown("```json\n" + plan_json(2) + "\n```")
        self.assertEqual(len(b["clips"]), 2)
        self.assertEqual(sp.check_breakdown(b), [])

    def test_checks_flag_shots_seconds_camera_ledger(self):
        bad = clip_json(1, shots=[shot(1, 8, "medium"), shot(2, 8, "medium"), shot(3, 2, "sideways")],
                        changes=[{"entity": "ghost", "axis": "a", "to": "b", "shot": 1}])
        b = sp.parse_breakdown(json.dumps({"chapter": "c", "ledger": {"entities": []}, "clips": [bad]}))
        issues = " | ".join(sp.check_breakdown(b))
        self.assertIn("sum to 18.0s", issues)
        self.assertIn("camera 'sideways' is not one of", issues)
        self.assertIn("repeat the same camera", issues)
        self.assertIn("not in ledger.entities[].id", issues)
        few = sp.parse_breakdown(json.dumps({"chapter": "c", "clips": [clip_json(1, shots=[shot(1, 15, "medium")])]}))
        self.assertIn("1 shot — outside the 3-6 range", " ".join(sp.check_breakdown(few)))

    def test_ledger_integrity_and_progressive(self):
        ledger = {"entities": [{"id": "ana", "name": "Ana", "kind": "character", "clip_ids": [1, 2],
                                "axes": [{"axis": "coat", "options": ["dry", "wet", "soaked"], "progressive": True, "plate_visible": True}],
                                "initial": [{"axis": "coat", "value": "wet"}]}]}
        c1 = clip_json(1, changes=[{"entity": "ana", "axis": "coat", "to": "soaked", "shot": 2}])
        c2 = clip_json(2, changes=[{"entity": "ana", "axis": "coat", "to": "dry", "shot": 9}])
        b = sp.parse_breakdown(json.dumps({"chapter": "c", "ledger": ledger, "clips": [c1, c2]}))
        issues = " | ".join(sp.check_breakdown(b))
        self.assertIn("cites shot 9", issues)
        self.assertIn("ana.coat moves backwards at clip 2", issues)

    def test_count_check(self):
        b = sp.parse_breakdown(plan_json(2))
        self.assertEqual(sp.check_clip_count(b, 2), [])
        self.assertIn("EXACTLY 3", sp.check_clip_count(b, 3)[0])


class FormatTests(unittest.TestCase):
    def test_format_clip_raw_ask_exact(self):
        b = sp.parse_breakdown(plan_json(1))
        self.assertEqual(
            sp.format_clip_raw_ask(b["clips"][0]),
            "Clip 1:\n\n"
            "Shot 1 – Wide as The wet street shines under a lamp. (5s)\n"
            "Shot 2 – Medium as Ana walks on. (5s)\n"
            "Shot 3 – Close Up as Her face tightens, Ana says \"Not yet.\". (5s)\n\n"
            "What is at the station 1?")

    def test_new_sentence_action_and_fractional_seconds(self):
        line = sp.format_shot_line({"shot": 2, "seconds": 2.5, "camera": "tracking_following",
                                    "subject": "Ana's flat", "action": "The door is open", "dialogue": None})
        self.assertEqual(line, "Shot 2 – Tracking as Ana's flat. The door is open. (2.5s)")

    def test_state_blocks_prepended(self):
        ledger = {"entities": [{"id": "ana", "name": "Ana", "kind": "character", "clip_ids": [1, 2],
                                "axes": [{"axis": "coat", "options": ["dry", "wet"], "progressive": False, "plate_visible": True}],
                                "initial": [{"axis": "coat", "value": "dry"}]}]}
        c1 = clip_json(1, changes=[{"entity": "ana", "axis": "coat", "to": "wet", "shot": 2}])
        b = sp.parse_breakdown(json.dumps({"chapter": "c", "ledger": ledger, "clips": [c1, clip_json(2)]}))
        two = sp.raw_ask_for_clip(b, 2)
        self.assertTrue(two.startswith("STATE AT THE START OF THIS CLIP:\nAna (character): coat=wet\n\nClip 2:"))
        self.assertIn("CHANGES DURING THIS CLIP:\nAna.coat -> wet (shot 2)", sp.raw_ask_for_clip(b, 1))


class PlanStoryTests(unittest.TestCase):
    def test_bad_json_retries_once_with_complaint(self):
        replies = ["Sure! here is a plan, no json", plan_json(3)]
        seen = []

        def chat(messages):
            seen.append(messages[0]["content"])
            return replies[len(seen) - 1]

        asks = sp.plan_story(chat, "Ana walks.", 3)
        self.assertEqual(len(asks), 3)
        self.assertEqual(len(seen), 2)
        self.assertNotIn("PREVIOUS REPLY FAILED", seen[0])
        self.assertIn("PREVIOUS REPLY FAILED", seen[1])
        self.assertIn("not one valid JSON object", seen[1])
        self.assertTrue(asks[2].startswith("Clip 3:"))

    def test_wrong_count_retries_then_raises(self):
        calls = []
        def chat(messages):
            calls.append(messages[0]["content"])
            return plan_json(2)
        with self.assertRaises(sp.PlanError):
            sp.plan_story(chat, "Ana walks.", 3)
        self.assertEqual(len(calls), 2)
        self.assertIn("the target is EXACTLY 3", calls[1])

    def test_soft_issues_are_kept_after_one_retry(self):
        bad = json.loads(plan_json(1))
        bad["clips"][0]["shots"][1]["seconds"] = 9
        calls = []
        def chat(messages):
            calls.append(1)
            return json.dumps(bad)
        asks = sp.plan_story(chat, "x", 1)
        self.assertEqual(len(asks), 1)
        self.assertEqual(len(calls), 2)


class PlanSlotsTests(unittest.TestCase):
    def clips(self, *prompts):
        return [{"id": i, "title": f"Clip {i + 1}", "prompt": p, "duration": 15, "seed": 1, "seed_mode": "fixed"}
                for i, p in enumerate(prompts)]

    def test_fresh_empty_list_plans_all_and_appends(self):
        clips = self.clips("")
        slots = sp.plan_slots(clips, 4)
        self.assertEqual(slots, [0, 1, 2, 3])
        asks = [f"ask {i}" for i in range(4)]
        self.assertEqual(sp.apply_plan(clips, asks, slots), [0, 1, 2, 3])
        self.assertEqual([c["prompt"] for c in clips], asks)
        self.assertTrue(all(c["planned"] is True and c["duration"] == 15 for c in clips))
        self.assertEqual(len({c["id"] for c in clips}), 4)

    def test_plan_once_never_replans_on_story_or_n_change(self):
        clips = self.clips("")
        sp.apply_plan(clips, ["a", "b"], sp.plan_slots(clips, 2))
        self.assertEqual(sp.plan_slots(clips, 2), [])
        self.assertEqual(sp.plan_slots(clips, 6), [])
        clips[0]["planned"] = False
        clips[1]["planned"] = False
        self.assertEqual(sp.plan_slots(clips, 6), [])

    def test_hand_clips_protected_and_only_empty_slots_filled(self):
        clips = self.clips("my own opening", "", "")
        slots = sp.plan_slots(clips, 3)
        self.assertEqual(slots, [1, 2])
        sp.apply_plan(clips, ["PLAN 0", "PLAN 1", "PLAN 2"], [0, 1, 2])
        self.assertEqual(clips[0]["prompt"], "my own opening")
        self.assertNotIn("planned", clips[0])
        self.assertEqual([clips[1]["prompt"], clips[2]["prompt"]], ["PLAN 1", "PLAN 2"])

    def test_apply_never_overwrites_text_typed_after_slots_were_chosen(self):
        clips = self.clips("typed", "")
        sp.apply_plan(clips, ["PLAN 0", "PLAN 1"], [0, 1])
        self.assertEqual(clips[0]["prompt"], "typed")

    def test_no_slots_when_all_filled_or_off(self):
        self.assertEqual(sp.plan_slots(self.clips("a", "b"), 2), [])
        self.assertEqual(sp.plan_slots(self.clips(""), 0), [])


class FakeServer:
    def __init__(self, log):
        self.log = log

    def chat(self, messages, **kw):
        user = messages[0]["content"] if messages[0]["role"] == "user" else messages[1]["content"]
        self.log.append(user)
        if "Break the chapter below" in user:
            return plan_json(3)
        return "FINAL[" + user.rsplit("original_prompt:", 1)[1].strip()[:12] + "]"


class RewriteIntegrationTests(unittest.TestCase):
    def run_rewrite(self, clips, settings_extra, log):
        import contextlib
        import tempfile
        import types
        gguf = tempfile.NamedTemporaryFile(suffix=".gguf", delete=False)
        gguf.close()
        self.addCleanup(os.unlink, gguf.name)
        choice = types.SimpleNamespace(local=True, reference=gguf.name, mmproj="")
        nodes = types.SimpleNamespace(_resolve_writer_choice=lambda l: choice, _resolve_captioner_choice=lambda l: choice,
                                      DEFAULT_OPTIONS={}, caption_question=lambda *a: "?")

        @contextlib.contextmanager
        def session(*a, **kw):
            self.session_kw = kw
            yield FakeServer(log)

        def build(guide, task, prompt, resolution, duration, refs, system=""):
            self.systems.append(system)
            return [{"role": "system", "content": "SYS"}, {"role": "user", "content": f"original_prompt: {prompt}"}]

        mods = {
            "nodes": nodes, "paths": types.SimpleNamespace(), "guides": types.SimpleNamespace(text=lambda *a: "GUIDE"),
            "guide_prompt": types.SimpleNamespace(GUIDE_FOR_MODE={"T2VA": 1}, FIELDS_FOR_MODE={"T2VA": ["a"]},
                                                  build_messages=build, context_needed=lambda m, b: 4096),
            "fields": types.SimpleNamespace(split_fields=lambda t, n: {"a": t}, missing=lambda s, n: []),
            "checks": types.SimpleNamespace(looping=lambda t: False),
            "mtmd_engine": types.SimpleNamespace(session=session),
            "aspect": types.SimpleNamespace(resolve=lambda a, d: "16:9"),
            "constants": types.SimpleNamespace(answer_only=lambda t: t),
        }
        saved = (pr._mod, pr.available, pr._load_cache)
        pr._mod = lambda name: mods[name]
        pr.available = lambda: True
        pr._load_cache = lambda: {}
        calls = []
        try:
            settings = {"rewrite_mode": "pending clips", "rewrite_writer_model": "w", "rewrite_caption_model": "c",
                        "rewrite_task": "T2VA", "rewrite_parallel": 3, "rewrite_previous_clips": "final prompts",
                        "rewrite_max_new_tokens": 100, "rewrite_story": "Ana walks to the station.", "auto_clips": 3}
            settings.update(settings_extra)
            notes = pr.rewrite_clips(clips, {}, settings, aspect_text="1280x720",
                                     plan_cb=lambda c, positions: calls.append(list(positions)))
        finally:
            pr._mod, pr.available, pr._load_cache = saved
        return notes, calls

    def setUp(self):
        self.systems = []

    def test_plans_once_then_rewrites_and_second_run_does_not_replan(self):
        clips = [{"id": 0, "title": "Clip 1", "prompt": "", "duration": 15, "seed": 1, "seed_mode": "fixed"}]
        log = []
        notes, calls = self.run_rewrite(clips, {}, log)
        self.assertEqual(len(clips), 3)
        self.assertEqual(calls, [[0, 1, 2]])
        self.assertEqual(sum("Break the chapter below" in m for m in log), 1)
        self.assertTrue(all(c["planned"] is True and c["prompt_rewritten"] is True for c in clips))
        self.assertTrue(clips[0]["prompt_raw"].startswith("Clip 1:\n\nShot 1"))
        self.assertTrue(clips[1]["prompt"].startswith("FINAL["))
        self.assertEqual(self.session_kw["pool_ctx"], 4096)
        log2 = []
        notes2, calls2 = self.run_rewrite(clips, {"auto_clips": 5, "rewrite_story": "A different story entirely."}, log2)
        self.assertEqual(log2, [])
        self.assertEqual(calls2, [])
        self.assertEqual(notes2, ["rewriter: nothing pending"])
        self.assertEqual(len(clips), 3)

    def test_hand_clip_survives_a_plan(self):
        clips = [{"id": 0, "title": "Clip 1", "prompt": "I wrote this myself", "duration": 15},
                 {"id": 1, "title": "Clip 2", "prompt": "", "duration": 15}]
        self.run_rewrite(clips, {"rewrite_previous_clips": "raw asks"}, [])
        self.assertEqual(clips[0]["prompt_raw"], "I wrote this myself")
        self.assertNotIn("planned", clips[0])
        self.assertTrue(clips[1]["planned"])
        self.assertEqual(len(clips), 3)

    def test_planner_off_without_story_or_zero(self):
        for extra in ({"rewrite_story": ""}, {"auto_clips": 0}):
            clips = [{"id": 0, "prompt": "ask", "duration": 15}]
            log = []
            _, calls = self.run_rewrite(clips, extra, log)
            self.assertEqual(calls, [])
            self.assertFalse(any("Break the chapter below" in m for m in log))

    def test_t2va_uses_official_guide(self):
        clips = [{"id": 0, "prompt": "ask", "duration": 15}]
        self.run_rewrite(clips, {"auto_clips": 0}, [])
        self.assertTrue(all(s == "" for s in self.systems))


if __name__ == "__main__":
    unittest.main()
