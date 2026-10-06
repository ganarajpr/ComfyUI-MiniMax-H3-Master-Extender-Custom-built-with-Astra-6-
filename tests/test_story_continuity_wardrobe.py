import contextlib
import json
import os
import sys
import tempfile
import types
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import prompt_rewriter as pr  # noqa: E402
import story_planner as sp  # noqa: E402

STORY = ("Meera, in her blue kurta, spends the morning in the courtyard of her family home. For the wedding she changes "
         "into a red silk wedding saree with a gold border and a gold necklace, and in the afternoon walks from the "
         "courtyard to the temple at the edge of the village, the wedding party behind her.")

CAPTION = ("Identity: a young woman, slim build, warm brown skin, long black hair in a braid, a small mole under her left eye. "
           "Outfit shown: a plain blue cotton kurta with white churidar.")

BLUE = "as on the reference"
RED = "deep red silk wedding saree with a wide gold border, gold necklace, red glass bangles"


def shot(n, seconds, camera, subject, action):
    return {"shot": n, "seconds": seconds, "camera": camera, "subject": subject, "action": action,
            "has_dialogue": False, "dialogue_speaker": "", "dialogue_line": ""}


def meera(position, wardrobe, props="none", state="calm"):
    return {"name": "Meera", "position": position, "wardrobe": wardrobe, "props": props, "state": state}


def plan_reply():
    def clip(n, beat, shots, end):
        return {"clip": n, "beat": beat, "forward_pull": f"Clip {n} pull.", "state_changes": [], "end_state": end,
                "shots": [shot(i + 1, 5, cam, s, a) for i, (cam, s, a) in enumerate(shots)]}
    return json.dumps({"chapter": "Meera's wedding day", "ledger": {"entities": []}, "clips": [
        clip(1, "morning in the courtyard",
             [("wide_establishing", "The courtyard", "is swept in early light"), ("medium", "Meera", "sweeps the steps"),
              ("close_up", "Her hands", "set down the broom")],
             {"location": "courtyard of the family home, by the tulsi platform", "time_light": "early morning, soft gold light",
              "end_action": "Meera sets the broom against the wall and turns toward the house door",
              "characters": [meera("beside the tulsi platform, facing the house door", BLUE, "none", "calm")]}),
        clip(2, "she dresses for the wedding",
             [("medium", "Meera", "steps out of the house door"), ("close_up", "Her face", "catches the light"),
              ("tracking_following", "Meera", "crosses the courtyard to the gate")],
             {"location": "courtyard gate, family home", "time_light": "late morning, bright overhead light",
              "end_action": "Meera reaches the open gate and lifts the edge of her saree with one hand",
              "characters": [meera("at the gate, facing the lane", RED, "a brass thali of flowers in her left hand", "nervous")]}),
        clip(3, "the walk to the temple",
             [("wide_establishing", "The lane", "winds toward the temple"), ("tracking_following", "Meera", "walks"),
              ("low_angle", "The temple gate", "rises ahead")],
             {"location": "temple gate at the edge of the village", "time_light": "afternoon, warm low light",
              "end_action": "Meera stops at the temple gate and folds her hands",
              "characters": [meera("on the temple steps, facing the gate", RED, "the brass thali of flowers", "resolved")]}),
    ]})


class FakeTensor:
    pass


class Harness(unittest.TestCase):
    def run_story(self, continuity):
        self.writer_calls, self.planner_calls, self.captions_asked = [], [], []
        gguf = tempfile.NamedTemporaryFile(suffix=".gguf", delete=False)
        gguf.close()
        self.addCleanup(os.unlink, gguf.name)
        choice = types.SimpleNamespace(local=True, reference=gguf.name, mmproj="")
        test = self

        class Question:
            def __init__(self, text, add=True):
                self.text, self.add = text, add

        def caption_question(role, length, question=None):
            return f"STOCK {role} {question.text if question else ''}".strip()

        nodes = types.SimpleNamespace(_resolve_writer_choice=lambda l: choice, _resolve_captioner_choice=lambda l: choice,
                                      DEFAULT_OPTIONS={}, caption_question=caption_question, Question=Question)

        class Server:
            def chat(self, messages, **kw):
                text = messages[0]["content"] if messages[0]["role"] == "user" else None
                if text is not None and "Break the chapter below" in text:
                    test.planner_calls.append(text)
                    return plan_reply()
                ask = messages[1]["content"].rsplit("original_prompt:", 1)[1]
                n = int(ask.split("Clip ")[1].split(":")[0]) if "Clip " in ask else 0
                test.writer_calls.append(messages)
                return (f"subject_definitions:\n<Subject 1> clip {n}\nretention_analysis:\n...\ndetailed_description:\n"
                        f"[Shot 1] opening of clip {n}.\n[Shot 2] At 00:05.000, middle of clip {n}.\n"
                        f"[Shot 3] At 00:10.000, FINAL BEAT OF CLIP {n}.\noverall_soundscape:\nwind.\nnon_diegetic_music:\nN/A")

        @contextlib.contextmanager
        def session(*a, **kw):
            yield Server()

        def describe(**kw):
            test.captions_asked.append(kw["instruction"])
            return CAPTION

        def build(guide, task, prompt, resolution, duration, refs, system=""):
            return [{"role": "system", "content": "SYS"},
                    {"role": "user", "content": f"task: {task}\nreference_assets:\n{refs}\noriginal_prompt: {prompt}"}]

        mods = {
            "nodes": nodes, "paths": types.SimpleNamespace(), "guides": types.SimpleNamespace(text=lambda *a: "G"),
            "guide_prompt": types.SimpleNamespace(GUIDE_FOR_MODE={"Ref2VA": 1}, FIELDS_FOR_MODE={"Ref2VA": ["subject_definitions"]},
                                                  build_messages=build, context_needed=lambda m, b: 4096),
            "fields": types.SimpleNamespace(split_fields=lambda t, n: {"subject_definitions": t}, missing=lambda s, n: []),
            "checks": types.SimpleNamespace(looping=lambda t: False),
            "mtmd_engine": types.SimpleNamespace(session=session, describe=describe, clip_note=lambda *a: ""),
            "aspect": types.SimpleNamespace(resolve=lambda a, d: "16:9"),
            "constants": types.SimpleNamespace(answer_only=lambda t: t),
        }
        saved = (pr._mod, pr.available, pr._load_cache, pr._save_cache, pr._image_key)
        pr._mod = lambda name: mods[name]
        pr.available = lambda: True
        pr._load_cache = lambda: {}
        pr._save_cache = lambda c: None
        pr._image_key = lambda *a: "k"
        clips = [{"id": 0, "prompt": "", "duration": 15}]
        try:
            settings = {"rewrite_mode": "pending clips", "rewrite_writer_model": "w", "rewrite_caption_model": "c",
                        "rewrite_task": "Ref2VA", "rewrite_parallel": 1, "rewrite_previous_clips": continuity,
                        "rewrite_max_new_tokens": 100, "rewrite_story": STORY, "auto_clips": 3, "planner_refs": "captions"}
            pr.rewrite_clips(clips, {"ref_image_0": FakeTensor()}, settings, aspect_text="1280x720")
        finally:
            pr._mod, pr.available, pr._load_cache, pr._save_cache, pr._image_key = saved
        return clips


class PlannerStateTests(Harness):
    def test_each_planned_ask_opens_where_the_previous_one_ended(self):
        clips = self.run_story("raw asks")
        one, two, three = (c["prompt_raw"] for c in clips)
        self.assertNotIn("OPENS EXACTLY WHERE", one)
        self.assertIn("AT THE END OF THIS CLIP", one)
        self.assertIn("THIS CLIP OPENS EXACTLY WHERE CLIP 1 ENDED:", two)
        self.assertIn("Last action: Meera sets the broom against the wall and turns toward the house door", two)
        self.assertIn("THIS CLIP OPENS EXACTLY WHERE CLIP 2 ENDED:", three)
        self.assertIn(f"wardrobe: {RED}", three.split("AT THE END OF THIS CLIP")[0])

    def test_planner_is_told_clothing_comes_from_the_story_not_the_picture(self):
        self.run_story("raw asks")
        msg = self.planner_calls[0]
        self.assertIn("WARDROBE comes from the STORY, never from a reference picture", msg)
        self.assertIn("as on the reference", msg)
        self.assertIn("A character's clothing comes from the story, not from the picture", msg)
        self.assertNotIn("matching how they actually look (wardrobe", msg)
        self.assertIn('"end_state"', msg)
        self.assertIn("Outfit shown: a plain blue cotton kurta", msg)

    def test_missing_end_state_is_a_check_issue_and_gets_one_retry(self):
        bare = json.loads(plan_reply())
        for c in bare["clips"]:
            del c["end_state"]
        b = sp.parse_breakdown(json.dumps(bare))
        self.assertEqual(len([i for i in sp.check_breakdown(b) if "end_state" in i]), 3)
        replies = [json.dumps(bare), plan_reply()]
        seen = []

        def chat(messages):
            seen.append(messages[0]["content"])
            return replies[len(seen) - 1]

        asks = sp.plan_story(chat, STORY, 3)
        self.assertEqual(len(seen), 2)
        self.assertIn("no usable end_state", seen[1])
        self.assertIn("OPENS EXACTLY WHERE CLIP 2 ENDED", asks[2])

    def test_no_opens_block_across_a_typed_clip_in_between(self):
        b = sp.parse_breakdown(plan_reply())
        b["clips"][1]["clip"] = 3
        b["clips"][2]["clip"] = 4
        self.assertNotIn("OPENS EXACTLY WHERE", sp.raw_ask_for_clip(b, 3))
        self.assertIn("OPENS EXACTLY WHERE CLIP 3 ENDED", sp.raw_ask_for_clip(b, 4))


class WriterTests(Harness):
    def test_caption_splits_identity_from_outfit_and_old_captions_are_not_reused(self):
        self.run_story("raw asks")
        self.assertEqual(len(self.captions_asked), 1)
        self.assertIn("'Identity:'", self.captions_asked[0])
        self.assertIn("'Outfit shown:'", self.captions_asked[0])

    def test_clip2_writer_call_carries_state_wardrobe_rule_and_previous_final(self):
        self.run_story("final prompts")
        system, user = self.writer_calls[1][0]["content"], self.writer_calls[1][1]["content"]
        self.assertIn("The picture supplies IDENTITY only", system)
        self.assertIn("partially_preserved", system)
        self.assertIn("never write what the character is not wearing", system)
        self.assertIn("OPENS EXACTLY WHERE", system)
        self.assertIn("Picture 1: " + CAPTION, user)
        self.assertIn("THIS CLIP OPENS EXACTLY WHERE CLIP 1 ENDED:", user)
        self.assertIn("Meera sets the broom against the wall", user)
        self.assertIn("Previous clip, final prompt (clip 1", user)
        self.assertIn("Where clip 1 ends", user)
        tail = user.split("Where clip 1 ends", 1)[1]
        self.assertIn("[Shot 3] At 00:10.000, FINAL BEAT OF CLIP 1.", tail)
        self.assertNotIn("overall_soundscape", tail)
        self.assertIn("wardrobe: " + RED, user)
        self.assertIn("the story block", system)
        self.assertIn("comes from: if it says what a character wears", system)

    def test_raw_asks_mode_still_parallel_safe_and_carries_the_same_state(self):
        self.run_story("raw asks")
        user = self.writer_calls[2][1]["content"]
        self.assertIn("THIS CLIP OPENS EXACTLY WHERE CLIP 2 ENDED:", user)
        self.assertNotIn("Where clip", user)


class LastShotTests(unittest.TestCase):
    def test_last_shot_of(self):
        text = ("detailed_description:\n[Shot 1] a.\n[Shot 2] At 00:05.000, b.\nmore b.\n\noverall_soundscape:\nwind\n")
        self.assertEqual(pr.last_shot_of(text), "[Shot 2] At 00:05.000, b.\nmore b.")
        self.assertEqual(pr.last_shot_of("no shots here"), "")
        self.assertEqual(pr.last_shot_of("[Shot 1] only"), "[Shot 1] only")


if __name__ == "__main__":
    unittest.main()
