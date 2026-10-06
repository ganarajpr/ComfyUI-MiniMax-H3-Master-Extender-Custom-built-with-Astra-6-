import contextlib
import json
import logging
import os
import sys
import tempfile
import types
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import prompt_rewriter as pr  # noqa: E402
import strata_backend as sb  # noqa: E402
from test_story_planner import plan_json  # noqa: E402

try:
    import torch
except ImportError:
    torch = None

ROOT = Path(__file__).resolve().parents[1]
BUILD_LINES = []


def build(guide, task, prompt, resolution, duration, refs, system=""):
    BUILD_LINES.append(refs)
    return [{"role": "system", "content": "SYS"}, {"role": "user", "content": f"refs:\n{refs}\nask: {prompt}"}]


@unittest.skipUnless(torch, "needs torch (the box has it)")
class OneModelTests(unittest.TestCase):
    """rewrite_writer_model is the only model: it captions and writes, or, without vision, only writes."""

    def setUp(self):
        gguf = tempfile.NamedTemporaryFile(suffix=".gguf", delete=False)
        gguf.close()
        self.addCleanup(os.unlink, gguf.name)
        self.gguf = gguf.name
        self.log = types.SimpleNamespace(sessions=[], describes=[], chats=[], run_messages=[], strata=[], texts=[], questions=[])

    def run_rewrite(self, *, vision, strata=False, planner_refs="images", story="", auto_clips=0, refs=2):
        log = self.log
        writer = types.SimpleNamespace(local=True, reference=self.gguf, mmproj="", file="")
        captioner = types.SimpleNamespace(local=True, reference=self.gguf, mmproj="mm.gguf", file="")
        other = types.SimpleNamespace(local=True, reference=self.gguf + ".other", mmproj="mm2.gguf", file="")
        listed = {"cap": captioner} if vision else {"other": other}

        nodes = types.SimpleNamespace(
            _resolve_writer_choice=lambda label: writer, _resolve_captioner_choice=lambda label: listed[label],
            captioner_choices=lambda: list(listed), DEFAULT_OPTIONS={},
            caption_question=lambda *a: "?",
            run_messages=lambda name, messages, *a, label=None, **kw: (
                log.run_messages.append(messages) or (plan_json(2) if "Break the chapter below" in json.dumps(messages) else "FINAL")))

        class Server:
            def chat(self, messages, **kw):
                log.chats.append(messages)
                content = messages[0]["content"]
                text = content if isinstance(content, str) else " ".join(p.get("text", "") for p in content)
                log.texts.append(text)
                return plan_json(2) if "Break the chapter below" in text else "FINAL"

        @contextlib.contextmanager
        def session(model_path, mmproj_path, *a, **kw):
            log.sessions.append((model_path, mmproj_path))
            yield Server()

        @contextlib.contextmanager
        def open_strata(budget, adopt=None, on_wait=None):
            log.strata.append(budget)
            yield Server()

        def describe(**kw):
            log.describes.append(kw)
            return "Identity: a woman. Outfit shown: a blue kurta."

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
                with open(path, "wb") as handle:
                    handle.write(b"PNG")
                return [path]

        mods = {
            "nodes": nodes, "paths": types.SimpleNamespace(), "guides": types.SimpleNamespace(text=lambda *a: "G"),
            "guide_prompt": types.SimpleNamespace(GUIDE_FOR_MODE={"Ref2VA": 1}, FIELDS_FOR_MODE={"Ref2VA": ["a"]},
                                                  build_messages=build, context_needed=lambda m, b: 4096),
            "fields": types.SimpleNamespace(split_fields=lambda t, n: {"a": t}, missing=lambda s, n: []),
            "checks": types.SimpleNamespace(looping=lambda t: False),
            "mtmd_engine": types.SimpleNamespace(session=session, describe=describe, clip_note=lambda *a: ""),
            "aspect": types.SimpleNamespace(resolve=lambda a, d: "16:9"),
            "constants": types.SimpleNamespace(answer_only=lambda t: t),
            "media": Media, "runner": types.SimpleNamespace(_adopt=lambda p: None),
            "progress": types.SimpleNamespace(NodeProgress=lambda x: None),
        }
        saved = (pr._mod, pr.available, pr._load_cache, pr._save_cache, sb.open_strata)
        pr._mod = lambda name: mods[name]
        pr.available = lambda: True
        pr._load_cache = lambda: {}
        pr._save_cache = lambda c: None
        sb.open_strata = open_strata
        messages = []
        class Collect(logging.Handler):
            def emit(self, record):
                messages.append(record.getMessage())

        handler = Collect()
        level = pr._LOG.level
        pr._LOG.setLevel(logging.INFO)
        pr._LOG.addHandler(handler)
        del BUILD_LINES[:]
        try:
            clips = [{"id": 0, "prompt": "" if auto_clips else "ask", "duration": 15}]
            settings = {"rewrite_mode": "pending clips", "rewrite_writer_model": sb.LABEL if strata else "w",
                        "rewrite_task": "Ref2VA", "rewrite_parallel": 1, "rewrite_previous_clips": "raw asks",
                        "rewrite_max_new_tokens": 100, "rewrite_story": story, "auto_clips": auto_clips,
                        "planner_refs": planner_refs}
            tensors = {f"ref_image_{i}": torch.zeros(1, 280, 560, 3) for i in range(refs)}
            pr.rewrite_clips(clips, tensors, settings, aspect_text="1280x720")
        finally:
            pr._LOG.removeHandler(handler)
            pr._LOG.setLevel(level)
            pr._mod, pr.available, pr._load_cache, pr._save_cache, sb.open_strata = saved
        self.messages = messages
        return clips

    def system_of_writer(self):
        return [m for m in self.log.chats if m[0]["role"] == "system"][-1][0]["content"]

    def test_vision_writer_captions_with_the_same_model_in_one_session(self):
        self.run_rewrite(vision=True)
        self.assertEqual(self.log.sessions, [(self.gguf, "mm.gguf")])
        self.assertEqual(len(self.log.describes), 2)
        for kw in self.log.describes:
            self.assertEqual((kw["model_path"], kw["mmproj_path"]), (self.gguf, "mm.gguf"))
        self.assertEqual(len(self.log.chats), 1)
        self.assertEqual(self.log.run_messages, [])
        block = BUILD_LINES[-1]
        self.assertIn("Picture 1: Identity: a woman. Outfit shown: a blue kurta.", block)
        self.assertIn("Picture 2: Identity: a woman. Outfit shown: a blue kurta.", block)
        self.assertNotIn("not described here", block)
        self.assertNotIn("No reference picture is described", self.system_of_writer())
        self.assertFalse([m for m in self.messages if "no vision" in m])

    def test_strata_skips_captions_and_labels_the_pictures_without_empty_lines(self):
        clips = self.run_rewrite(vision=True, strata=True)
        self.assertEqual(self.log.describes, [])
        self.assertEqual(self.log.sessions, [])
        self.assertEqual(self.log.strata, [4096])
        self.assertEqual(clips[0]["prompt"], "FINAL")
        block = BUILD_LINES[-1]
        self.assertEqual(block.split("\n"), [
            "Picture 1: an attached reference picture (not described here)",
            "Picture 2: an attached reference picture (not described here)"])
        self.assertTrue(all(line.split(":", 1)[1].strip() for line in block.split("\n")))
        self.assertIn("No reference picture is described in this task", self.system_of_writer())
        self.assertEqual(len([m for m in self.messages if "writer has no vision: reference images not interpreted" in m]), 1)

    def test_gguf_without_mmproj_is_text_only_through_the_packs_own_path(self):
        clips = self.run_rewrite(vision=False)
        self.assertEqual(self.log.describes, [])
        self.assertEqual(self.log.sessions, [])
        self.assertEqual(len(self.log.run_messages), 1)
        self.assertEqual(clips[0]["prompt"], "FINAL")
        self.assertIn("Picture 1: an attached reference picture (not described here)", BUILD_LINES[-1])
        self.assertEqual(len([m for m in self.messages if "writer has no vision" in m]), 1)

    def test_planner_with_images_degrades_to_the_story_text_when_the_writer_cannot_see(self):
        for kw in ({"vision": False}, {"vision": True, "strata": True}):
            self.log.texts.clear()
            self.log.run_messages.clear()
            self.run_rewrite(planner_refs="images", story="A story.", auto_clips=2, **kw)
            planner = [m for m in self.log.run_messages + self.log.chats if "Break the chapter below" in json.dumps(m[0]["content"])]
            self.assertEqual(len(planner), 1, kw)
            content = planner[0][0]["content"]
            self.assertIsInstance(content, str)
            self.assertNotIn("Picture 1", content)
            self.assertNotIn("REFERENCE RULE", content)

    def test_planner_with_images_keeps_the_pictures_for_a_vision_writer(self):
        self.run_rewrite(vision=True, planner_refs="images", story="A story.", auto_clips=2)
        content = [m for m in self.log.chats if "Break the chapter below" in json.dumps(m[0]["content"])][0][0]["content"]
        self.assertEqual([p["type"] for p in content].count("image_url"), 2)


class BudgetTests(unittest.TestCase):
    def test_old_and_api_values_map_to_the_nearest_allowed_choice(self):
        self.assertEqual(pr.REASONING_BUDGETS, ["1024", "2048", "4096"])
        table = {-1: "4096", 0: "4096", 1: "1024", 1024: "1024", 1500: "1024", 1536: "2048", 2048: "2048",
                 3072: "4096", 4096: "4096", 8192: "4096", 16384: "4096", 32768: "4096",
                 "2048": "2048", "4096": "4096", "": "4096", None: "4096", 4096.0: "4096"}
        for given, want in table.items():
            self.assertEqual(pr.reasoning_budget(given), want, given)

    def test_node_input_is_a_three_choice_combo_defaulting_to_4096(self):
        source = (ROOT / "master_node.py").read_text(encoding="utf-8")
        self.assertIn('"rewrite_reasoning_budget": (prompt_rewriter.REASONING_BUDGETS, {"default": "4096"', source)
        self.assertNotIn("rewrite_caption_model", source)
        self.assertIn("rewrite_reasoning_budget=None", source)

    def test_example_workflows_carry_the_merged_layout(self):
        for path in sorted((ROOT / "example_workflows").glob("*.json")):
            workflow = json.loads(path.read_text(encoding="utf-8"))
            for node in workflow["nodes"]:
                if node["type"] != "MiniMaxH3MasterExtender":
                    continue
                names = [i["name"] for i in node["inputs"] if "widget" in i]
                values = node["widgets_values"]
                self.assertNotIn("rewrite_caption_model", names, path.name)
                self.assertEqual(names[names.index("rewrite_writer_model") + 1], "rewrite_caption_length")
                self.assertEqual(values[names.index("rewrite_reasoning_budget")], "4096", path.name)
                self.assertIn(values[names.index("rewrite_caption_length")], pr.CAPTION_LENGTHS, path.name)


if __name__ == "__main__":
    unittest.main()
