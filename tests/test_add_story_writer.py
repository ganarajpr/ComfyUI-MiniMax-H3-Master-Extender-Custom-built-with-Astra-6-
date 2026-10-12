"""tools/add_story_writer.py: the JSON transform that puts an H3 Story Writer in front of a Master Extender in a UI-format workflow."""

import copy
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "tools"))

import add_story_writer as tool  # noqa: E402

SOURCE = ROOT / "example_workflows" / "MiniMax_H3_Master_Extender_Story_Auto.json"
EXAMPLE = ROOT / "example_workflows" / "MiniMax_H3_Master_Extender_Story_Writer.json"


def load(path=SOURCE):
    return json.loads(Path(path).read_text(encoding="utf-8"))


def node(wf, kind):
    return [n for n in wf["nodes"] if n["type"] == kind]


class TransformTests(unittest.TestCase):
    def setUp(self):
        self.src = load()
        self.out = tool.add_story_writer(self.src)
        self.ext = node(self.out, tool.EXTENDER)[0]
        self.writer = node(self.out, tool.WRITER)[0]

    def test_input_is_not_modified(self):
        self.assertEqual(self.src, load())

    def test_writer_is_added_left_of_everything_and_level_with_the_extender(self):
        self.assertEqual(len(node(self.out, tool.WRITER)), 1)
        self.assertLess(self.writer["pos"][0] + self.writer["size"][0], min(n["pos"][0] for n in self.out["nodes"] if n is not self.writer and n["type"] != tool.PREVIEW))
        self.assertEqual(self.writer["pos"][1], self.ext["pos"][1])

    def test_story_is_wired_into_the_extenders_story_input(self):
        names = [i["name"] for i in self.ext["inputs"]]
        slot = names.index("rewrite_story")
        entry = self.ext["inputs"][slot]
        self.assertIsNotNone(entry["link"])
        self.assertEqual(entry["widget"], {"name": "rewrite_story"})
        link = [l for l in self.out["links"] if l[0] == entry["link"]][0]
        self.assertEqual(link, [entry["link"], self.writer["id"], 0, self.ext["id"], slot, "STRING"])
        self.assertIn(link[0], self.writer["outputs"][0]["links"])
        self.assertEqual(self.writer["outputs"][0]["type"], "STRING")
        self.assertEqual(self.writer["outputs"][0]["name"], "story")

    def test_ids_and_links_are_consistent(self):
        ids = [n["id"] for n in self.out["nodes"]]
        self.assertEqual(len(ids), len(set(ids)))
        link_ids = [l[0] for l in self.out["links"]]
        self.assertEqual(len(link_ids), len(set(link_ids)))
        self.assertEqual(self.out["last_node_id"], max(ids))
        self.assertEqual(self.out["last_link_id"], max(link_ids))
        by_id = {n["id"]: n for n in self.out["nodes"]}
        for link_id, origin, slot, target, target_slot, kind in self.out["links"]:
            self.assertIn(link_id, by_id[origin]["outputs"][slot]["links"])
            self.assertEqual(by_id[target]["inputs"][target_slot]["link"], link_id)

    def test_existing_links_are_untouched(self):
        for link in self.src["links"]:
            self.assertIn(link, self.out["links"])

    def test_writer_defaults(self):
        values = dict(zip(["brief", "clips", "seconds", "language", "seed", "control", "writer_model", "thinking_budget"], self.writer["widgets_values"]))
        self.assertEqual((values["clips"], values["seconds"], values["language"], values["seed"], values["control"], values["thinking_budget"]), (8, 15, "English", 42, "fixed", "4096"))
        self.assertEqual(values["writer_model"], tool.get_widget(self.ext, "rewrite_writer_model"))
        self.assertEqual(values["brief"], tool.get_widget(self.ext, "rewrite_story"))
        self.assertEqual([i["name"] for i in self.writer["inputs"]], ["brief", "clips", "seconds", "language", "seed", "writer_model", "thinking_budget"])

    def test_extender_is_set_to_e4_and_nothing_else_moves(self):
        self.assertEqual(tool.get_widget(self.ext, "story_engine"), "e4.10")
        self.assertEqual(tool.get_widget(self.ext, "auto_clips"), 8)
        before = tool.widget_names(node(self.src, tool.EXTENDER)[0])
        old = node(self.src, tool.EXTENDER)[0]["widgets_values"]
        new = self.ext["widgets_values"]
        self.assertEqual(len(old), len(new))
        changed = {before[i] for i in range(len(before)) if old[i] != new[i]}
        self.assertEqual(changed, {"story_engine", "auto_clips"})

    def test_preview_is_a_core_node_fed_by_the_story(self):
        preview = node(self.out, tool.PREVIEW)[0]
        link = [l for l in self.out["links"] if l[3] == preview["id"]][0]
        self.assertEqual(link[1:3], [self.writer["id"], 0])
        self.assertEqual(preview["inputs"][0]["link"], link[0])
        no_preview = tool.add_story_writer(self.src, preview=False)
        self.assertEqual(node(no_preview, tool.PREVIEW), [])
        self.assertEqual(len(node(no_preview, tool.WRITER)), 1)

    def test_idempotent(self):
        again = tool.add_story_writer(self.out)
        self.assertEqual(again, self.out)
        self.assertEqual(len(node(again, tool.WRITER)), 1)
        self.assertEqual(len(node(again, tool.PREVIEW)), 1)

    def test_second_run_without_preview_then_with_adds_only_the_preview(self):
        bare = tool.add_story_writer(self.src, preview=False)
        full = tool.add_story_writer(bare)
        self.assertEqual(len(node(full, tool.WRITER)), 1)
        self.assertEqual(len(node(full, tool.PREVIEW)), 1)

    def test_user_edits_to_the_writer_survive_a_rerun(self):
        edited = copy.deepcopy(self.out)
        node(edited, tool.WRITER)[0]["widgets_values"][1] = 20
        self.assertEqual(node(tool.add_story_writer(edited), tool.WRITER)[0]["widgets_values"][1], 20)

    def test_custom_clips(self):
        out = tool.add_story_writer(self.src, clips=12, seconds=10)
        w = node(out, tool.WRITER)[0]["widgets_values"]
        self.assertEqual((w[1], w[2]), (12, 10))
        self.assertEqual(tool.get_widget(node(out, tool.EXTENDER)[0], "auto_clips"), 12)

    def test_errors(self):
        no_ext = {"nodes": [n for n in self.src["nodes"] if n["type"] != tool.EXTENDER], "links": []}
        with self.assertRaises(tool.WorkflowError):
            tool.add_story_writer(no_ext)
        busy = copy.deepcopy(self.src)
        ext = node(busy, tool.EXTENDER)[0]
        slot = [i["name"] for i in ext["inputs"]].index("rewrite_story")
        ext["inputs"][slot]["link"] = 99
        busy["links"].append([99, 1, 0, ext["id"], slot, "STRING"])
        with self.assertRaises(tool.WorkflowError):
            tool.add_story_writer(busy)
        two = copy.deepcopy(self.src)
        clone = copy.deepcopy(node(two, tool.EXTENDER)[0])
        clone["id"] = 99
        two["nodes"].append(clone)
        with self.assertRaises(tool.WorkflowError):
            tool.add_story_writer(two)
        self.assertEqual(len(node(tool.add_story_writer(two, node_id=99), tool.WRITER)), 1)


class FilesTests(unittest.TestCase):
    def test_example_workflow_is_the_tools_output(self):
        expected = tool.add_story_writer(load(), workflow_id="9b7e5d21-h3-master-extender-story-writer-example")
        self.assertEqual(load(EXAMPLE), expected)
        self.assertNotEqual(load(EXAMPLE)["id"], load()["id"])

    def test_node_types_exist_in_the_package(self):
        sys.path.insert(0, str(ROOT))
        import story_writer

        self.assertIn(tool.WRITER, story_writer.NODE_CLASS_MAPPINGS)
        inputs = list(story_writer.H3StoryWriter.INPUT_TYPES()["required"])
        writer = node(load(EXAMPLE), tool.WRITER)[0]
        self.assertEqual([i["name"] for i in writer["inputs"]], inputs)
        self.assertTrue(story_writer.H3StoryWriter.INPUT_TYPES()["required"]["seed"][1]["control_after_generate"])

    def test_cli(self):
        with tempfile.TemporaryDirectory() as tmp:
            out = Path(tmp) / "out.json"
            done = subprocess.run([sys.executable, str(ROOT / "tools" / "add_story_writer.py"), str(SOURCE), str(out), "--clips", "5"], capture_output=True, text=True)
            self.assertEqual(done.returncode, 0, done.stderr)
            self.assertEqual(node(json.loads(out.read_text(encoding="utf-8")), tool.WRITER)[0]["widgets_values"][1], 5)
            bad = subprocess.run([sys.executable, str(ROOT / "tools" / "add_story_writer.py"), str(SOURCE), str(Path(tmp) / "x.json"), "--node-id", "12345"], capture_output=True, text=True)
            self.assertEqual(bad.returncode, 1)
            self.assertIn("no MiniMaxH3MasterExtender", bad.stderr)


if __name__ == "__main__":
    unittest.main()
