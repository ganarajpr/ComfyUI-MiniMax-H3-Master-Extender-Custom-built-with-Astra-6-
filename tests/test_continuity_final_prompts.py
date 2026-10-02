import os
import sys
import tempfile
import types
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import prompt_rewriter as pr  # noqa: E402

FINAL = pr.FINAL_PROMPTS

SIX = "shot_1: she opens the door.\nshot_2: she steps out onto the wet street, umbrella up, red coat, lamp light."


def story():
    return [
        {"id": "a", "prompt": SIX, "prompt_raw": "A woman leaves her flat.", "prompt_rewritten": True,
         "rewrite_text": SIX, "duration": 15},
        {"id": "b", "prompt": "She walks to the station.", "duration": 10},
        {"id": "c", "prompt": "She boards the night train.", "duration": 12},
    ]


class BlockTests(unittest.TestCase):
    def test_modes_listed_and_default_kept(self):
        self.assertEqual(pr.CONTINUITY, ["off", "raw asks", "final prompts"])
        self.assertEqual(FINAL, "final prompts")

    def test_raw_asks_unchanged(self):
        self.assertEqual(pr.continuity_block(story(), 2, "raw asks"),
                         "Clip 1 (15s): A woman leaves her flat.\nClip 2 (10s): She walks to the station.")

    def test_first_clip_has_no_block(self):
        self.assertEqual(pr.continuity_block(story(), 0, FINAL), "")

    def test_second_clip_gets_full_final_prompt_only(self):
        block = pr.continuity_block(story(), 1, FINAL)
        self.assertNotIn("Story so far", block)
        self.assertIn(SIX, block)
        self.assertNotIn("A woman leaves her flat.", block)
        self.assertTrue(block.startswith("Previous clip, final prompt (clip 1, 15s"))

    def test_third_clip_gets_memory_then_full_previous_final(self):
        clips = story()
        clips[1].update(prompt="FINAL TWO\nshot_1: ...", prompt_raw="She walks to the station.",
                        prompt_rewritten=True, rewrite_text="FINAL TWO\nshot_1: ...")
        block = pr.continuity_block(clips, 2, FINAL)
        head, tail = block.split("\n\n", 1)
        self.assertEqual(head, "Story so far (raw asks of the earlier clips, memory only):\n"
                               "Clip 1 (15s): A woman leaves her flat.")
        self.assertTrue(tail.startswith("Previous clip, final prompt (clip 2, 10s"))
        self.assertTrue(tail.endswith("FINAL TWO\nshot_1: ..."))
        self.assertNotIn(SIX, block)

    def test_unrewritten_previous_clip_prompt_as_typed_is_final(self):
        block = pr.continuity_block(story(), 2, FINAL)
        self.assertIn("She walks to the station.", block)

    def test_with_previous_goes_before_original_prompt(self):
        out = pr.with_previous("x\noriginal_prompt: go", pr.continuity_block(story(), 1, FINAL))
        self.assertLess(out.index("previous_clips:"), out.index("original_prompt:"))


class StalenessTests(unittest.TestCase):
    def rewritten(self, prev_final):
        clips = story()
        clips[1].update(prompt="TWO", prompt_raw="She walks to the station.", prompt_rewritten=True,
                        rewrite_text="TWO", rewrite_meta={"fingerprint": "f2"})
        if prev_final is not None:
            clips[1]["rewrite_meta"]["prev_final"] = prev_final
        clips[2].update(prompt="THREE", prompt_raw="She boards the night train.", prompt_rewritten=True,
                        rewrite_text="THREE", rewrite_meta={"fingerprint": "f3", "prev_final": pr.final_hash(clips[1])})
        return clips

    CUR = {0: None, 1: "f2", 2: "f3"}

    def current(self, clips):
        cur = dict(self.CUR)
        cur[0] = clips[0].get("rewrite_meta", {}).get("fingerprint")
        return cur

    def test_unchanged_previous_final_is_not_stale(self):
        clips = self.rewritten(pr.final_hash(story()[0]))
        self.assertEqual(pr.pending_indices(clips, "pending clips", self.current(clips), FINAL), [])

    def test_hand_edited_previous_final_makes_next_stale_and_cascades(self):
        clips = self.rewritten(pr.final_hash(story()[0]))
        clips[0]["prompt"] += "\nshot_3: edited by hand."
        self.assertEqual(pr.pending_indices(clips, "pending clips", self.current(clips), FINAL), [1, 2])

    def test_rewritten_in_same_run_cascades(self):
        clips = self.rewritten(pr.final_hash(story()[0]))
        clips[1]["prompt_rewritten"] = False
        self.assertEqual(pr.pending_indices(clips, "pending clips", self.current(clips), FINAL), [1, 2])

    def test_switching_mode_does_not_invalidate(self):
        clips = self.rewritten(None)
        del clips[2]["rewrite_meta"]["prev_final"]
        self.assertEqual(pr.pending_indices(clips, "pending clips", self.current(clips), FINAL), [])
        self.assertEqual(pr.pending_indices(clips, "pending clips", self.current(clips), "raw asks"), [])

    def test_raw_mode_ignores_previous_final_change(self):
        clips = self.rewritten(pr.final_hash(story()[0]))
        clips[0]["prompt"] += " edited"
        self.assertEqual(pr.pending_indices(clips, "pending clips", self.current(clips), "raw asks"), [])

    def test_fingerprint_ignores_continuity_setting(self):
        a = pr.fingerprint("x", 15, "16:9", "T2VA", previous=pr.continuity_block(story(), 1, "raw asks"))
        self.assertTrue(a.startswith("v2:"))


class StoryTests(unittest.TestCase):
    STORY = "Ana leaves home, crosses the city and takes the night train to her sister."

    def test_story_before_previous_clips_before_original_prompt(self):
        prev = pr.continuity_block(story(), 1, FINAL)
        out = pr.with_previous("duration: 10\noriginal_prompt: go", prev, self.STORY)
        self.assertLess(out.index("story:"), out.index("previous_clips:"))
        self.assertLess(out.index("previous_clips:"), out.index("original_prompt:"))
        self.assertTrue(out.endswith("original_prompt: go"))

    def test_story_without_previous_goes_before_original_prompt(self):
        out = pr.with_previous("duration: 10\noriginal_prompt: go", "", self.STORY)
        self.assertEqual(out, f"duration: 10\nstory:\n{self.STORY}\noriginal_prompt: go")
        self.assertNotIn("previous_clips:", out)

    def test_no_story_no_change(self):
        self.assertEqual(pr.with_previous("a\noriginal_prompt: x", "", ""), "a\noriginal_prompt: x")
        self.assertEqual(pr.with_previous("a\noriginal_prompt: x", "P"), "a\nprevious_clips:\nP\noriginal_prompt: x")

    def test_story_does_not_touch_fingerprint(self):
        import inspect
        self.assertNotIn("story", inspect.signature(pr.fingerprint).parameters)
        self.assertIn("film story", pr.fingerprint.__doc__)


class FakeServer:
    def __init__(self, log):
        self.log = log

    def chat(self, messages, **kw):
        user = messages[1]["content"]
        ask = user.rsplit("original_prompt:", 1)[1].strip()
        self.log.append((ask, messages))
        return f"FINAL[{ask}]"


class OrderingTests(unittest.TestCase):
    def run_rewrite(self, continuity, clips, mode="pending clips", story=""):
        log = []
        gguf = tempfile.NamedTemporaryFile(suffix=".gguf", delete=False)
        gguf.close()
        self.addCleanup(os.unlink, gguf.name)
        choice = types.SimpleNamespace(local=True, reference=gguf.name, mmproj="")
        nodes = types.SimpleNamespace(
            _resolve_writer_choice=lambda label: choice, _resolve_captioner_choice=lambda label: choice,
            DEFAULT_OPTIONS={}, caption_question=lambda *a: "?")
        import contextlib

        @contextlib.contextmanager
        def session(*a, **kw):
            self.session_kw = kw
            yield FakeServer(log)

        def build(guide, task, prompt, resolution, duration, refs, system=""):
            return [{"role": "system", "content": "SYS"},
                    {"role": "user", "content": f"duration: {duration}\noriginal_prompt: {prompt}"}]

        mods = {
            "nodes": nodes,
            "paths": types.SimpleNamespace(),
            "guides": types.SimpleNamespace(text=lambda *a: "GUIDE"),
            "guide_prompt": types.SimpleNamespace(
                GUIDE_FOR_MODE={"T2VA": 1}, FIELDS_FOR_MODE={"T2VA": ["a"]}, build_messages=build,
                context_needed=lambda messages, budget: 4096),
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
        try:
            settings = {"rewrite_mode": mode, "rewrite_writer_model": "w", "rewrite_caption_model": "c",
                        "rewrite_task": "T2VA", "rewrite_parallel": 3, "rewrite_previous_clips": continuity,
                        "rewrite_max_new_tokens": 100, "rewrite_story": story}
            notes = pr.rewrite_clips(clips, {}, settings, aspect_text="1280x720")
        finally:
            pr._mod, pr.available, pr._load_cache = saved
        return log, notes

    def fresh(self):
        return [{"id": str(i), "prompt": f"ask{i}", "duration": 10} for i in (1, 2, 3)]

    def test_final_mode_is_sequential_and_feeds_new_output(self):
        clips = self.fresh()
        log, _ = self.run_rewrite(FINAL, clips)
        self.assertEqual([a for a, _ in log], ["ask1", "ask2", "ask3"])
        self.assertEqual(self.session_kw["pool_ctx"], 4096)
        msg2 = log[1][1][1]["content"]
        self.assertIn("FINAL[ask1]", msg2)
        msg3 = log[2][1][1]["content"]
        self.assertIn("FINAL[ask2]", msg3)
        self.assertIn("Clip 1 (10s): ask1", msg3)
        self.assertNotIn("FINAL[ask1]", msg3)
        self.assertIn("LAST shot", log[2][1][0]["content"])
        self.assertEqual(clips[2]["rewrite_meta"]["prev_final"], pr.final_hash(clips[1]))
        self.assertNotIn("prev_final", clips[0]["rewrite_meta"])

    def test_raw_mode_still_parallel_pool_and_raw_asks(self):
        clips = self.fresh()
        log, _ = self.run_rewrite("raw asks", clips)
        self.assertEqual(self.session_kw["pool_ctx"], 4096 * 3)
        msg3 = [m for a, m in log if a == "ask3"][0][1]["content"]
        self.assertIn("Clip 2 (10s): ask2", msg3)
        self.assertNotIn("FINAL[", msg3)
        self.assertNotIn("prev_final", clips[2]["rewrite_meta"])

    def test_story_in_every_continuity_mode_and_rule_only_with_story(self):
        for mode in ("off", "raw asks", FINAL):
            log, _ = self.run_rewrite(mode, self.fresh(), story="THE WHOLE STORY")
            for ask, messages in log:
                self.assertIn("story:\nTHE WHOLE STORY\n", messages[1]["content"], mode)
                self.assertIn("Story: the task message may carry a 'story' block", messages[0]["content"], mode)
                self.assertLess(messages[1]["content"].index("story:"), messages[1]["content"].index("original_prompt:"))
            log, _ = self.run_rewrite(mode, self.fresh())
            for ask, messages in log:
                self.assertNotIn("story:", messages[1]["content"], mode)
                self.assertNotIn("'story' block", messages[0]["content"], mode)

    def test_story_changes_nothing_already_written(self):
        clips = self.fresh()
        self.run_rewrite(FINAL, clips)
        log, _ = self.run_rewrite(FINAL, clips, story="NEW STORY")
        self.assertEqual(log, [])

    def test_clip3_full_task_message(self):
        clips = self.fresh()
        log, _ = self.run_rewrite(FINAL, clips, story="THE WHOLE STORY")
        self.assertEqual(
            log[2][1][1]["content"],
            "duration: 10.0\nstory:\nTHE WHOLE STORY\nprevious_clips:\n"
            "Story so far (raw asks of the earlier clips, memory only):\nClip 1 (10s): ask1\n\n"
            "Previous clip, final prompt (clip 2, 10s, already rendered; this clip starts where its last shot ends):\n"
            "FINAL[ask2]\noriginal_prompt: ask3")

    def test_only_rewrites_the_stale_tail(self):
        clips = self.fresh()
        self.run_rewrite(FINAL, clips)
        clips[1]["prompt"] += " hand edit"
        log, _ = self.run_rewrite(FINAL, clips)
        self.assertEqual([a for a, _ in log], ["ask3"])


if __name__ == "__main__":
    unittest.main()
