import copy
import io
import json
import logging
import os
import re
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


def end_state_json(n):
    return {"location": f"the street, lamp {n}", "time_light": "night, sodium lamplight",
            "end_action": f"Ana stops under lamp {n} and looks up",
            "characters": [{"name": "Ana", "position": "centre of the lane, facing the station", "wardrobe": "as on the reference",
                            "props": "none", "state": "wary"}]}


def clip_json(n, beat="a beat", shots=None, changes=None):
    return {"clip": n, "beat": beat, "forward_pull": f"What is at the station {n}?", "end_state": end_state_json(n),
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
        self.assertTrue(two.startswith("STATE AT THE START OF THIS CLIP:\nAna (character): coat=wet\n\nCONTINUITY"))
        self.assertIn("\n\nClip 2:\n", two)
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
        self.assertIn("\nClip 3:\n", asks[2])

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


class FakeTensor:
    def __init__(self, h, w):
        self.shape = (1, h, w, 3)


class RefsTests(unittest.TestCase):
    REFS = {"pictures": [{"label": "Picture 1", "caption": "a woman in a maroon saree", "image": "data:image/png;base64,AAA"},
                         {"label": "Picture 2", "caption": "a brass lamp on a carved table", "image": "data:image/png;base64,BBB"}],
            "videos": [{"label": "Video 1", "caption": "a slow pan across a courtyard"}]}

    def test_rule_lives_outside_planner_md_and_only_with_refs(self):
        self.assertNotIn("only characters, props and locations", sp.load_prompt("planner"))
        self.assertNotIn("REFERENCE RULE", sp.build_user_content("story", 3))
        self.assertEqual(sp.build_user_content("story", 3), sp.build_user_message("story", 3))
        self.assertIn("Name a subject by its Picture number the first time it appears", sp.REFS_RULE)

    def test_images_mode_parts_in_slot_order(self):
        parts = sp.build_user_content("story", 3, self.REFS)
        kinds = [p["type"] for p in parts]
        self.assertEqual(kinds, ["text", "text", "image_url", "text", "text", "image_url", "text", "text", "text"])
        self.assertEqual(parts[1]["text"], "Picture 1:")
        self.assertEqual(parts[2]["image_url"]["url"], "data:image/png;base64,AAA")
        self.assertEqual(parts[3]["text"], "a woman in a maroon saree")
        self.assertEqual(parts[4]["text"], "Picture 2:")
        self.assertEqual(parts[7]["text"], "Video 1: a slow pan across a courtyard")
        self.assertTrue(parts[8]["text"].lstrip().startswith("REFERENCE RULE"))
        self.assertIn("CHAPTER:\nstory", parts[8]["text"])

    def test_captions_mode_is_one_string_and_videos_are_captions_in_both(self):
        refs = {"pictures": [dict(p, image=None) for p in self.REFS["pictures"]], "videos": self.REFS["videos"]}
        text = sp.build_user_content("story", 3, refs)
        self.assertIsInstance(text, str)
        head = text.split("\n\n")[0].split("\n")
        self.assertEqual(head[1:], ["Picture 1: a woman in a maroon saree", "Picture 2: a brass lamp on a carved table",
                                    "Video 1: a slow pan across a courtyard"])
        self.assertIn("REFERENCE RULE", text)

    def test_image_token_estimate(self):
        self.assertEqual(sp.image_tokens(FakeTensor(280, 280)), 100)
        self.assertEqual(sp.image_tokens(FakeTensor(1024, 1024)), 768)
        self.assertEqual(sp.image_tokens(FakeTensor(10, 10)), 1)

    def test_retry_complaint_goes_on_the_last_text_part_keeping_images(self):
        seen = []
        replies = ["nope", plan_json(1)]

        def chat(messages):
            seen.append(messages[0]["content"])
            return replies[len(seen) - 1]

        sp.plan_story(chat, "s", 1, refs=self.REFS)
        self.assertEqual([p["type"] for p in seen[0]], [p["type"] for p in seen[1]])
        self.assertNotIn("PREVIOUS REPLY FAILED", seen[0][-1]["text"])
        self.assertIn("PREVIOUS REPLY FAILED", seen[1][-1]["text"])

    def test_picture_mentions_do_not_trouble_format_or_checks(self):
        c = clip_json(1, shots=[shot(1, 5, "wide_establishing", "Mira (Picture 1)", "stands in the courtyard of Picture 2"),
                                shot(2, 5, "medium", "The brass lamp (Picture 2)", "flickers"),
                                shot(3, 5, "close_up", "Mira (Picture 1)", "smiles", True, "Look.", "Mira")])
        b = sp.parse_breakdown(json.dumps({"chapter": "c", "ledger": {"entities": []}, "clips": [c]}))
        self.assertEqual(sp.check_breakdown(b), [])
        ask = sp.format_clip_raw_ask(b["clips"][0])
        self.assertIn("Shot 1 \u2013 Wide as Mira (Picture 1) stands in the courtyard of Picture 2. (5s)", ask)
        self.assertIn("Shot 2 \u2013 Medium as The brass lamp (Picture 2) flickers. (5s)", ask)


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


PLAN_REPLY = lambda k: plan_json(k)  # noqa: E731


class FakeServer:
    def __init__(self, log):
        self.log = log

    def chat(self, messages, **kw):
        user = messages[0]["content"] if messages[0]["role"] == "user" else messages[1]["content"]
        self.log.append(user)
        if "Break the chapter below" in user:
            return PLAN_REPLY(int(re.search(r"EXACTLY (\d+) clip", user).group(1)))
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
        for extra in ({"rewrite_story": "A different story entirely."}, {"auto_clips": 2},
                      {"auto_clips": 1, "rewrite_story": "Another story."}):
            log2 = []
            notes2, calls2 = self.run_rewrite(clips, extra, log2)
            self.assertEqual(log2, [], extra)
            self.assertEqual(calls2, [], extra)
            self.assertEqual(notes2, ["rewriter: nothing pending"], extra)
            self.assertEqual(len(clips), 3)

    def test_raise_plans_only_the_new_clips_after_the_existing_ones(self):
        global PLAN_REPLY
        saved = PLAN_REPLY
        PLAN_REPLY = ledger_plan
        try:
            clips = [{"id": 0, "title": "Clip 1", "prompt": "", "duration": 15, "seed": 1, "seed_mode": "fixed"}]
            self.run_rewrite(clips, {}, [])
            self.assertEqual(len(clips), 3)
            self.assertEqual(clips[2]["plan_end_state"]["ana"]["axes"]["coat"], "soaked")
            clips[1]["prompt_raw"] = "MY EDIT OF CLIP TWO"  # a user edit of a planned clip
            clips[1]["prompt"] = "MY EDIT OF CLIP TWO"
            clips[1]["prompt_rewritten"] = False
            clips[1]["planned"] = False
            for key in ("rewrite_text", "rewrite_meta"):
                clips[1].pop(key, None)
            before = copy.deepcopy(clips)
            log = []
            notes, calls = self.run_rewrite(clips, {"auto_clips": 5, "rewrite_story": "The full story, longer now."}, log)
            planner = [m for m in log if "Break the chapter below" in m]
            self.assertEqual(len(planner), 1)
            msg = planner[0]
            self.assertIn("EXACTLY 2 clips", msg)
            self.assertIn("numbered 4-5", msg)
            self.assertIn("--- Clip 2 ---\nMY EDIT OF CLIP TWO", msg)
            self.assertIn("ana | Ana (character): coat=soaked", msg)
            self.assertIn("CHAPTER:\nThe full story, longer now.", msg)
            self.assertEqual(calls, [[3, 4]])
            self.assertEqual(len(clips), 5)
            for i in range(3):
                for key in ("prompt_raw", "planned", "plan_end_state"):
                    self.assertEqual(clips[i].get(key), before[i].get(key), (i, key))
            self.assertTrue(all(c["planned"] is True and c["prompt_rewritten"] is True for c in clips[3:]))
            self.assertTrue(clips[3]["prompt_raw"].startswith("STATE AT THE START OF THIS CLIP:\nAna (character): coat=soaked\n\nClip 4:"))
            self.assertIn("Clip 5:", clips[4]["prompt_raw"])
            # final prompts: clip 4 was written from clip 3's final prompt, and only the new clips were rewritten
            writer = [m for m in log if "original_prompt" in m]
            self.assertEqual(len(writer), 4)  # clip 2 (user edit, pending), 3 (its predecessor changed), 4, 5 -- in order
            self.assertIn("Previous clip, final prompt (clip 3", writer[2])
            self.assertIn(clips[2]["prompt"], writer[2])
            # raising again continues from the new end; lowering after that does nothing
            log3 = []
            _, calls3 = self.run_rewrite(clips, {"auto_clips": 6}, log3)
            self.assertEqual(calls3, [[5]])
            self.assertEqual(len(clips), 6)
            _, calls4 = self.run_rewrite(clips, {"auto_clips": 3}, [])
            self.assertEqual(calls4, [])
        finally:
            PLAN_REPLY = saved

    def test_gapped_first_plan_is_one_call_then_plan_more_continues_after_it(self):
        global PLAN_REPLY
        saved = PLAN_REPLY
        PLAN_REPLY = ledger_plan
        try:
            clips = [{"id": 0, "title": "Clip 1", "prompt": "typed one", "duration": 15},
                     {"id": 1, "title": "Clip 2", "prompt": "", "duration": 15},
                     {"id": 2, "title": "Clip 3", "prompt": "", "duration": 15},
                     {"id": 3, "title": "Clip 4", "prompt": "typed four", "duration": 15}]
            log = []
            _, calls = self.run_rewrite(clips, {"auto_clips": 5, "rewrite_previous_clips": "raw asks"}, log)
            planner = [m for m in log if "Break the chapter below" in m]
            self.assertEqual(len(planner), 1)
            self.assertIn("[TO PLAN: clip 2]", planner[0])
            self.assertIn("[TO PLAN: clip 5]", planner[0])
            self.assertIn("--- Clip 4 ---\ntyped four", planner[0])
            self.assertEqual(calls, [[1, 2, 4]])
            self.assertEqual(len(clips), 5)
            self.assertEqual(clips[0]["prompt_raw"], "typed one")
            self.assertEqual(clips[3]["prompt_raw"], "typed four")
            self.assertNotIn("planned", clips[0])
            self.assertNotIn("planned", clips[3])
            self.assertTrue(all(clips[i]["planned"] is True for i in (1, 2, 4)))
            self.assertTrue(clips[1]["prompt_raw"].startswith("Clip 2:") or "Clip 2:" in clips[1]["prompt_raw"])
            self.assertIn("What is at the station 3?", clips[4]["prompt_raw"])
            # no second plan from a story edit or a lower N
            self.assertEqual(self.run_rewrite(clips, {"auto_clips": 5, "rewrite_story": "Changed."}, [])[1], [])
            self.assertEqual(self.run_rewrite(clips, {"auto_clips": 3}, [])[1], [])
            # plan more after the gapped plan: typed and planned clips are all existing film, carried state from clip 5
            log2 = []
            _, calls2 = self.run_rewrite(clips, {"auto_clips": 7, "rewrite_previous_clips": "raw asks"}, log2)
            msg = [m for m in log2 if "Break the chapter below" in m][0]
            self.assertEqual(calls2, [[5, 6]])
            self.assertIn("numbered 6-7", msg)
            self.assertIn("--- Clip 1 ---\ntyped one", msg)
            self.assertIn("--- Clip 4 ---\ntyped four", msg)
            self.assertIn("--- Clip 5 ---\n", msg)
            self.assertIn("ana | Ana (character): coat=soaked", msg)
            self.assertEqual(len(clips), 7)
        finally:
            PLAN_REPLY = saved

    def test_no_typed_clips_first_plan_has_no_existing_film_block(self):
        clips = [{"id": 0, "prompt": "", "duration": 15}]
        log = []
        self.run_rewrite(clips, {"auto_clips": 3}, log)
        msg = [m for m in log if "Break the chapter below" in m][0]
        self.assertNotIn("ALREADY IN THE FILM", msg)
        self.assertNotIn("TO PLAN", msg)
        self.assertIn("EXACTLY 3 clips", msg)

    def test_hand_clip_counts_as_existing_film_when_raising(self):
        clips = [{"id": 0, "prompt": "", "duration": 15, "seed": 1, "seed_mode": "fixed"}]
        self.run_rewrite(clips, {"auto_clips": 3}, [])
        clips.append({"id": 9, "title": "Clip 4", "prompt": "I typed clip four", "duration": 15})
        log = []
        _, calls = self.run_rewrite(clips, {"auto_clips": 6}, log)
        self.assertEqual(calls, [[4, 5]])
        self.assertEqual(clips[3]["prompt_raw"], "I typed clip four")
        self.assertNotIn("planned", clips[3])
        self.assertIn("numbered 5-6", [m for m in log if "Break the chapter below" in m][0])

    def test_replan_still_works_after_plan_more(self):
        clips = [{"id": 0, "prompt": "", "duration": 15, "seed": 1, "seed_mode": "fixed"}]
        self.run_rewrite(clips, {"auto_clips": 2}, [])
        for c in clips:  # what the panel's "Replan from story" does to untouched planned clips
            c["prompt"] = ""
            for key in ("prompt_raw", "rewrite_text", "rewrite_meta", "planned", "plan_end_state"):
                c.pop(key, None)
            c["prompt_rewritten"] = False
        log = []
        _, calls = self.run_rewrite(clips, {"auto_clips": 2}, log)
        self.assertEqual(calls, [[0, 1]])
        self.assertIn("EXACTLY 2 clips", [m for m in log if "Break the chapter below" in m][0])
        self.assertNotIn("ALREADY IN THE FILM", [m for m in log if "Break the chapter below" in m][0])

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


def ledger_plan(k):
    ledger = {"entities": [{"id": "ana", "name": "Ana", "kind": "character", "clip_ids": list(range(1, k + 1)),
                            "axes": [{"axis": "coat", "options": ["dry", "wet", "soaked"], "progressive": True, "plate_visible": True}],
                            "initial": [{"axis": "coat", "value": "dry"}]}]}
    clips = [clip_json(i + 1, f"beat {i + 1}") for i in range(k)]
    clips[-1]["state_changes"] = [{"entity": "ana", "axis": "coat", "to": "soaked", "shot": 2}]
    return json.dumps({"chapter": "c", "ledger": ledger, "clips": clips})


class ConsoleSafeLoggingTests(unittest.TestCase):
    ASK = "Shot 1 \u2013 Wide as \u201cMira\u201d \u2014 \u0924\u0941\u092e \u0915\u0948\u0938\u0947 \u0939\u094b? \u2026"

    def test_cp1252_console_does_not_raise_and_text_is_untouched(self):
        raw = io.BytesIO()
        stream = io.TextIOWrapper(raw, encoding="cp1252", errors="strict", write_through=True)
        errors = []

        class Handler(logging.StreamHandler):
            def handleError(self, record):
                errors.append(record)

        handler = Handler(stream)
        saved_encoding = pr._console_encoding
        pr._console_encoding = lambda: "cp1252"
        pr._LOG.addHandler(handler)
        old_level, old_prop = pr._LOG.level, pr._LOG.propagate
        pr._LOG.setLevel(logging.INFO)
        pr._LOG.propagate = False
        try:
            ask = self.ASK
            pr._LOG.info("Rewriter plan clip %d:\n%s", 1, ask)
            pr._LOG.info(f"fstring {ask}")
            pr._LOG.info("percent-free %s", "100%")
        finally:
            pr._LOG.removeHandler(handler)
            pr._LOG.setLevel(old_level)
            pr._LOG.propagate = old_prop
            pr._console_encoding = saved_encoding
        self.assertEqual(errors, [])
        out = raw.getvalue().decode("cp1252")
        self.assertIn('Shot 1 - Wide as "Mira" - ', out)
        self.assertIn("\\u0924", out)
        self.assertEqual(ask, self.ASK)
        self.assertIn("\u2013", ask)

    def test_helper_is_ascii_for_a_narrow_console(self):
        saved = pr._console_encoding
        pr._console_encoding = lambda: "ascii"
        try:
            self.assertEqual(pr._console_safe("a\u2013b \u0939"), "a-b \\u0939")
        finally:
            pr._console_encoding = saved

    def test_master_node_logger_carries_the_filter(self):
        src = (Path(__file__).resolve().parents[1] / "master_node.py").read_text(encoding="utf-8")
        self.assertIn("_LOG.addFilter(prompt_rewriter.ConsoleSafeFilter())", src)


class PlanMoreUnitTests(unittest.TestCase):
    def film(self):
        end1 = {"ana": {"name": "Ana", "kind": "character", "axes": {"coat": "wet"}}}
        end3 = {"ana": {"name": "Ana", "kind": "character", "axes": {"coat": "soaked"}}}
        return [{"id": 0, "prompt": "Clip 1:\n\nShot 1 planned one", "planned": True, "plan_end_state": end1, "duration": 15},
                {"id": 1, "prompt": "Clip 2:\n\nShot 1 planned two", "planned": True, "duration": 15},
                {"id": 2, "prompt": "I rewrote clip three myself", "planned": False, "plan_end_state": end3, "duration": 15}]

    def test_fires_only_on_a_raise_past_the_existing_film(self):
        clips = self.film()
        self.assertIsNone(sp.plan_more(clips, 3))
        self.assertIsNone(sp.plan_more(clips, 2))
        self.assertIsNone(sp.plan_more(clips, 0))
        more = sp.plan_more(clips, 5)
        self.assertEqual((more["start"], more["count"]), (4, 2))

    def test_never_without_a_planned_flag(self):
        clips = [{"id": 0, "prompt": "typed", "duration": 15}]
        self.assertIsNone(sp.plan_more(clips, 5))

    def test_hand_clips_count_as_existing_film(self):
        clips = self.film() + [{"id": 3, "prompt": "I typed clip four", "duration": 15}]
        more = sp.plan_more(clips, 7)
        self.assertEqual((more["start"], more["count"]), (5, 3))
        self.assertEqual(more["existing"][3], (4, "I typed clip four"))

    def test_carried_state_is_the_latest_known_one(self):
        clips = self.film() + [{"id": 3, "prompt": "typed, no ledger", "duration": 15}]
        self.assertEqual(sp.plan_more(clips, 6)["carried"]["ana"]["axes"]["coat"], "soaked")

    def test_empty_slot_inside_the_range_is_kept_and_listed_empty(self):
        clips = self.film()
        clips[1]["prompt"] = ""
        more = sp.plan_more(clips, 4)
        self.assertEqual((more["start"], more["count"]), (4, 1))
        msg = sp.build_user_content("S", 1, None, more)
        self.assertIn("--- Clip 2 ---\n(empty", msg)
        sp.apply_plan(clips, [""] * 3 + ["NEW"], [3])
        self.assertEqual(clips[1]["prompt"], "")
        self.assertEqual(len(clips), 4)

    def test_edited_planned_clip_text_is_what_block_b_shows(self):
        clips = self.film()
        clips[0]["prompt"] = "MY EDITED CLIP ONE"
        clips[0]["planned"] = False
        msg = sp.build_user_content("The story.", 2, None, sp.plan_more(clips, 5))
        self.assertIn("--- Clip 1 ---\nMY EDITED CLIP ONE", msg)
        self.assertNotIn("planned one", msg)

    def test_message_layout_outside_planner_md(self):
        more = sp.plan_more(self.film(), 5)
        msg = sp.build_user_content("The whole story.", 2, None, more)
        self.assertLess(msg.index("ALREADY IN THE FILM"), msg.index("STATE CARRIED INTO CLIPS 4-5"))
        self.assertLess(msg.index("STATE CARRIED"), msg.index("CONTINUATION"))
        self.assertLess(msg.index("CONTINUATION"), msg.index("Break the chapter below"))
        self.assertIn("ana | Ana (character): coat=soaked", msg)
        self.assertIn("Plan exactly 2 more clips, numbered 4-5. Begin where clip 3 ends and carry the story forward from there; cover what the story has not yet covered.", msg)
        self.assertIn("EXACTLY 2 clips of 15 seconds each (30s total)", msg)
        self.assertIn('{"clip": 4,', msg)
        self.assertIn("CHAPTER:\nThe whole story.", msg)
        for text in ("ALREADY IN THE FILM", "CONTINUATION"):
            self.assertNotIn(text, sp.load_prompt("planner"))

    def test_plan_story_numbers_from_x_and_states_start_from_the_carried_state(self):
        more = sp.plan_more(self.film(), 5)
        states = []
        asks = sp.plan_story(lambda m: ledger_plan(2), "S", 2, more=more, states_out=states)
        self.assertEqual(len(asks), 2)
        self.assertIn("Clip 4:", asks[0])
        self.assertIn("Clip 5:", asks[1])
        self.assertIn("STATE AT THE START OF THIS CLIP:\nAna (character): coat=soaked", asks[0])
        self.assertNotIn("coat=dry", asks[0])
        self.assertEqual(states[-1]["ana"]["axes"]["coat"], "soaked")
        self.assertEqual(len(states), 2)

    def test_plan_story_accepts_a_reply_already_numbered_from_x(self):
        more = sp.plan_more(self.film(), 5)
        reply = json.loads(plan_json(2))
        for i, c in enumerate(reply["clips"]):
            c["clip"] = 4 + i
        asks = sp.plan_story(lambda m: json.dumps(reply), "S", 2, more=more)
        self.assertTrue(asks[0].startswith("Clip 4:") or "Clip 4:" in asks[0])

    def test_count_check_uses_k(self):
        more = sp.plan_more(self.film(), 5)
        with self.assertRaises(sp.PlanError):
            sp.plan_story(lambda m: plan_json(3), "S", 2, more=more)


class PlanAroundUnitTests(unittest.TestCase):
    def typed(self, *texts):
        return [{"id": i, "title": f"Clip {i + 1}", "prompt": t, "duration": 15} for i, t in enumerate(texts)]

    def test_typed_1_to_6_with_n10_plans_only_7_to_10_with_all_typed_asks_in_the_block(self):
        clips = self.typed(*[f"typed ask number {i}" for i in range(1, 7)])
        slots = sp.plan_slots(clips, 10)
        self.assertEqual(slots, [6, 7, 8, 9])
        ctx = sp.plan_around(clips, 10, slots)
        self.assertEqual(ctx["numbers"], [7, 8, 9, 10])
        self.assertTrue(ctx["tail"])
        msg = sp.build_user_content("The whole story.", 4, None, ctx)
        for i in range(1, 7):
            self.assertIn(f"--- Clip {i} ---\ntyped ask number {i}", msg)
        for n in range(7, 11):
            self.assertIn(f"[TO PLAN: clip {n}]", msg)
        self.assertIn("Plan exactly 4 more clips, numbered 7-10. Begin where clip 6 ends", msg)
        self.assertIn("derive the opening state of your ledger from where the existing clips leave things", msg)
        self.assertNotIn("PLAN AROUND THE TYPED CLIPS", msg)
        self.assertIn("EXACTLY 4 clips", msg)
        self.assertIn('{"clip": 7,', msg)

    def test_typed_clip_1_with_n4_plans_2_to_4(self):
        clips = self.typed("my opening")
        ctx = sp.plan_around(clips, 4, sp.plan_slots(clips, 4))
        self.assertEqual(ctx["numbers"], [2, 3, 4])
        self.assertIn("--- Clip 1 ---\nmy opening", sp.build_user_content("S", 3, None, ctx))

    def test_nothing_typed_is_the_whole_story_plan_unchanged(self):
        clips = self.typed("")
        self.assertIsNone(sp.plan_around(clips, 4, sp.plan_slots(clips, 4)))
        self.assertEqual(sp.plan_slots(clips, 4), [0, 1, 2, 3])

    def gapped(self):
        return self.typed("typed one", "", "", "typed four")

    def test_gapped_list_one_context_with_markers_and_noncontiguous_numbers(self):
        clips = self.gapped()
        slots = sp.plan_slots(clips, 5)
        self.assertEqual(slots, [1, 2, 4])
        ctx = sp.plan_around(clips, 5, slots)
        self.assertEqual(ctx["numbers"], [2, 3, 5])
        self.assertFalse(ctx["tail"])
        msg = sp.build_user_content("The whole story.", 3, None, ctx)
        self.assertLess(msg.index("--- Clip 1 ---\ntyped one"), msg.index("[TO PLAN: clip 2]"))
        self.assertLess(msg.index("[TO PLAN: clip 3]"), msg.index("--- Clip 4 ---\ntyped four"))
        self.assertLess(msg.index("--- Clip 4 ---"), msg.index("[TO PLAN: clip 5]"))
        self.assertIn("PLAN AROUND THE TYPED CLIPS", msg)
        self.assertIn("Plan exactly the clips marked TO PLAN (clips 2-3, 5)", msg)
        self.assertIn("bridge from the clip before it to the clip after it; never repeat or contradict a typed clip", msg)
        self.assertNotIn("CONTINUATION", msg)
        self.assertIn("EXACTLY 3 clips", msg)
        self.assertIn('{"clip": 2,', msg)
        self.assertIn('"clip_ids": [2, 3]', msg)

    def test_noncontiguous_numbers_pass_the_checks_and_map_by_field(self):
        ctx = sp.plan_around(self.gapped(), 5, [1, 2, 4])
        reply = json.loads(plan_json(3))
        for c, n in zip(reply["clips"], (2, 3, 5)):
            c["clip"] = n
        asks = sp.plan_story(lambda m: json.dumps(reply), "S", 3, more=ctx)
        self.assertEqual([re.search(r"^Clip \d+:", a, re.M).group(0) for a in asks], ["Clip 2:", "Clip 3:", "Clip 5:"])
        b = sp.parse_breakdown(json.dumps(reply))
        self.assertEqual(sp.check_breakdown(b), [])

    def test_reply_numbered_1_to_k_is_remapped_by_position(self):
        ctx = sp.plan_around(self.gapped(), 5, [1, 2, 4])
        asks = sp.plan_story(lambda m: plan_json(3), "S", 3, more=ctx)
        self.assertEqual([re.search(r"^Clip \d+:", a, re.M).group(0) for a in asks], ["Clip 2:", "Clip 3:", "Clip 5:"])

    def test_place_and_apply_fill_the_right_slots_and_leave_typed_clips_alone(self):
        clips = self.gapped()
        ctx = sp.plan_around(clips, 5, sp.plan_slots(clips, 5))
        full, states, slots = sp.place(["A2", "A3", "A5"], [{"s": 2}, {"s": 3}, {"s": 5}], ctx["numbers"])
        written = sp.apply_plan(clips, full, slots, states=states)
        self.assertEqual(written, [1, 2, 4])
        self.assertEqual([c["prompt"] for c in clips], ["typed one", "A2", "A3", "typed four", "A5"])
        self.assertNotIn("planned", clips[0])
        self.assertNotIn("planned", clips[3])
        self.assertTrue(all(clips[i]["planned"] is True for i in (1, 2, 4)))
        self.assertEqual(clips[4]["plan_end_state"], {"s": 5})


try:
    import torch
except ImportError:
    torch = None


@unittest.skipUnless(torch, "needs torch (the box has it)")
class RewriteRefsTests(unittest.TestCase):
    def run_it(self, planner_refs, mmproj="mm.gguf", same_file=True):
        import contextlib
        import tempfile
        import types
        gguf = tempfile.NamedTemporaryFile(suffix=".gguf", delete=False)
        gguf.close()
        self.addCleanup(os.unlink, gguf.name)
        writer = gguf.name
        cap = gguf.name if same_file else gguf.name + ".other"
        sent = []
        choice_w = types.SimpleNamespace(local=True, reference=writer, mmproj="")
        choice_c = types.SimpleNamespace(local=True, reference=cap, mmproj=mmproj)
        nodes = types.SimpleNamespace(_resolve_writer_choice=lambda l: choice_w, _resolve_captioner_choice=lambda l: choice_c,
                                      DEFAULT_OPTIONS={}, caption_question=lambda *a: "?")

        class Server:
            def chat(self, messages, **kw):
                sent.append(messages)
                content = messages[0]["content"]
                text = content if isinstance(content, str) else " ".join(p.get("text", "") for p in content)
                if "Break the chapter below" in text:
                    return plan_json(2)
                return "FINAL"

        @contextlib.contextmanager
        def session(*a, **kw):
            self.pool_ctx = kw["pool_ctx"]
            yield Server()

        class Media:
            PATCH = 28

            class Workspace:
                def __enter__(self):
                    self.dir = tempfile.mkdtemp()
                    return self

                def __exit__(self, *a):
                    pass

                def file(self, n):
                    return os.path.join(self.dir, n)

            @staticmethod
            def image_files(image, ws, n, prefix="", max_pixels=0):
                path = ws.file(prefix + ".png")
                open(path, "wb").write(b"PNG")
                return [path]

        def build(guide, task, prompt, resolution, duration, refs, system=""):
            return [{"role": "system", "content": "S"}, {"role": "user", "content": f"original_prompt: {prompt}"}]

        mods = {
            "nodes": nodes, "paths": types.SimpleNamespace(), "guides": types.SimpleNamespace(text=lambda *a: "G"),
            "guide_prompt": types.SimpleNamespace(GUIDE_FOR_MODE={"Ref2VA": 1}, FIELDS_FOR_MODE={"Ref2VA": ["a"]},
                                                  build_messages=build, context_needed=lambda m, b: b),
            "fields": types.SimpleNamespace(split_fields=lambda t, n: {"a": t}, missing=lambda s, n: []),
            "checks": types.SimpleNamespace(looping=lambda t: False),
            "mtmd_engine": types.SimpleNamespace(
                session=session, describe=lambda **kw: "a caption", clip_note=lambda *a: ""),
            "aspect": types.SimpleNamespace(resolve=lambda a, d: "16:9"),
            "constants": types.SimpleNamespace(answer_only=lambda t: t),
            "media": Media,
        }
        saved = (pr._mod, pr.available, pr._load_cache, pr._save_cache)
        pr._mod = lambda name: mods[name]
        pr.available = lambda: True
        pr._load_cache = lambda: {}
        pr._save_cache = lambda c: None
        try:
            clips = [{"id": 0, "prompt": "", "duration": 15}]
            settings = {"rewrite_mode": "pending clips", "rewrite_writer_model": "w", "rewrite_caption_model": "c",
                        "rewrite_task": "Ref2VA", "rewrite_parallel": 1, "rewrite_previous_clips": "raw asks",
                        "rewrite_max_new_tokens": 100, "rewrite_story": "A story.", "auto_clips": 2,
                        "planner_refs": planner_refs}
            refs = {"ref_image_0": torch.zeros(1, 280, 560, 3), "ref_image_1": torch.zeros(1, 2000, 2000, 3)}
            pr.rewrite_clips(clips, refs, settings, aspect_text="1280x720")
        finally:
            pr._mod, pr.available, pr._load_cache, pr._save_cache = saved
        return [m for m in sent if "Break the chapter below" in json.dumps(m[0]["content"])][0][0]["content"]

    def test_images_mode_sends_image_parts_and_sizes_context(self):
        content = self.run_it("images")
        self.assertEqual([p["type"] for p in content].count("image_url"), 2)
        texts = [p["text"] for p in content if p["type"] == "text"]
        self.assertIn("Picture 1:", texts)
        self.assertIn("Picture 2:", texts)
        self.assertIn("a caption", texts)
        self.assertGreaterEqual(self.pool_ctx, 140 * 4 + 768)  # 2 pictures: 560x280 -> 200 tokens, 2000x2000 -> capped 768

    def test_captions_mode_and_fallback_without_vision(self):
        for mode, kw in (("captions", {}), ("images", {"mmproj": ""})):
            content = self.run_it(mode, **kw)
            self.assertIsInstance(content, str, mode)
            self.assertIn("Picture 1: a caption", content)
            self.assertIn("REFERENCE RULE", content)

    def test_off_sends_the_story_text_only(self):
        content = self.run_it("off")
        self.assertIsInstance(content, str)
        self.assertNotIn("Picture 1", content)
        self.assertNotIn("REFERENCE RULE", content)


class ClipSecondsTests(unittest.TestCase):
    def plan_at(self, seconds, n=2):
        plan = json.loads(plan_json(n))
        for c in plan["clips"]:
            k = len(c["shots"])
            for i, shot_ in enumerate(c["shots"]):
                shot_["seconds"] = seconds / k
        return json.dumps(plan)

    def test_default_prompt_is_unchanged_and_says_15(self):
        explicit = sp.build_user_message("Ana walks.", 3, None, 15)
        self.assertEqual(sp.build_user_message("Ana walks.", 3), explicit)
        self.assertIn("fixed 15-second video clips", explicit)
        self.assertIn("exactly 15 seconds of shots (they must sum to 15, plus", explicit)
        self.assertIn("need the next 15 seconds", explicit)
        self.assertIn("sum to 15. \"ledger", explicit)

    def test_10s_prompt_has_no_stray_15(self):
        out = sp.build_user_message("Ana walks.", 3, None, 10)
        self.assertIn("fixed 10-second video clips", out)
        self.assertIn("exactly 10 seconds of shots (they must sum to 10, plus", out)
        self.assertIn("need the next 10 seconds", out)
        self.assertIn("EXACTLY 3 clips of 10 seconds each (30s total)", out)
        self.assertIn("seconds sum to 10.", out)
        self.assertNotRegex(out, r"\b15\b")
        self.assertIn("decide how many 10-second clips", sp.runtime_instruction("auto", None, 10))

    def test_clip_seconds_is_clamped(self):
        self.assertEqual([sp.clip_seconds(v) for v in (10, "10", 3, 99, None, "x", 12.4)], [10, 10, 5, 15, 15, 15, 12])

    def test_check_uses_the_target_length(self):
        b = sp.parse_breakdown(self.plan_at(10, 1))
        self.assertEqual(sp.check_breakdown(b, 10), [])
        self.assertIn("off the 15s target", " ".join(sp.check_breakdown(b)))

    def test_plan_story_at_10s_prompts_10_and_writes_10s_clips(self):
        seen = []

        def chat(messages):
            seen.append(messages[0]["content"])
            return self.plan_at(10, 6)

        asks = sp.plan_story(chat, "Ana walks.", 6, seconds=10)
        self.assertEqual(len(seen), 1)
        self.assertIn("EXACTLY 6 clips of 10 seconds each (60s total)", seen[0])
        clips = []
        sp.apply_plan(clips, asks, list(range(6)), seconds=10)
        self.assertEqual([c["duration"] for c in clips], [10] * 6)

    def test_apply_plan_default_stays_15_and_fills_an_existing_empty_clip(self):
        clips = [{"id": 0, "title": "Clip 1", "prompt": "", "duration": 15}]
        sp.apply_plan(clips, ["a", "b"], [0, 1])
        self.assertEqual([c["duration"] for c in clips], [15, 15])
        clips = [{"id": 0, "title": "Clip 1", "prompt": "", "duration": 15}]
        sp.apply_plan(clips, ["a", "b"], [0, 1], seconds=10)
        self.assertEqual([c["duration"] for c in clips], [10, 10])

    def test_node_input_is_last_after_planner_refs(self):
        text = (Path(__file__).resolve().parents[1] / "master_node.py").read_text(encoding="utf-8")
        names = re.findall(r'^\s{16}"(\w+)": \(', text, re.M)
        self.assertEqual(names[names.index("planner_refs") + 1], "auto_clip_seconds")
        self.assertRegex(text, r'"auto_clip_seconds": \("INT", \{"default": 15, "min": 5, "max": 15')


if __name__ == "__main__":
    unittest.main()
