import ast
import json
from pathlib import Path
import re
import shutil
import tempfile
from types import SimpleNamespace
import unittest

import torch


class MasterProjectTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.cache = self.root / "cache"
        self.preview = self.root / "preview"
        self.inputs = self.root / "input"
        for directory in (self.cache, self.preview, self.inputs):
            directory.mkdir()
        self.loaded = []
        self.ns = {
            "json": json, "Path": Path, "re": re, "shutil": shutil,
            "_ensure_cache_root": lambda: self.cache,
            "_preview_temp_root": lambda: self.preview,
            "folder_paths": SimpleNamespace(
                get_input_directory=lambda: str(self.inputs),
                get_annotated_filepath=lambda name: str(self.inputs / name),
            ),
            "nodes": SimpleNamespace(LoadImage=lambda: SimpleNamespace(load_image=self.load_image)),
        }
        path = Path(__file__).resolve().parents[1] / "master_projects.py"
        tree = ast.parse(path.read_text())
        body = [n for n in tree.body if isinstance(n, ast.FunctionDef)]
        exec(compile(ast.Module(body=body, type_ignores=[]), str(path), "exec"), self.ns)

    def load_image(self, name):
        self.loaded.append(name)
        return (torch.ones(2, 3, 4, 3), None)

    def test_nine_slots_keep_numbers_and_load_one_frame(self):
        images = [None] * 9
        for i in (0, 4, 8):
            images[i] = f"picture{i}.png"
            (self.inputs / images[i]).touch()
        refs = self.ns["load_reference_images"](json.dumps({"images": images}))
        self.assertEqual(set(refs), {"ref_image_0", "ref_image_4", "ref_image_8"})
        for image in refs.values():
            self.assertEqual(image.shape, (1, 3, 4, 3))
            self.assertEqual(image.untyped_storage().nbytes(), image.numel() * image.element_size())

    def test_invalid_reference_paths_and_counts_are_rejected(self):
        (self.root / "private.png").touch()
        for images in (["../private.png"], [str(self.root / "private.png")], ["missing.png"], [None] * 10):
            with self.assertRaises(ValueError):
                self.ns["load_reference_images"]({"images": images})
        self.assertEqual(self.loaded, [])
        for config in (None, [], "[]"):
            with self.assertRaises(ValueError):
                self.ns["load_reference_images"](config)

    def test_continuity_never_overwrites_attached_pictures(self):
        path = Path(__file__).resolve().parents[1] / "pdd_pure_engine.py"
        tree = ast.parse(path.read_text(encoding="utf-8"))
        method = next(n for n in ast.walk(tree) if isinstance(n, ast.FunctionDef) and n.name == "render_clip")
        guide_if = next(n for n in method.body if isinstance(n, ast.If)
                        and ast.unparse(n.test) == "last_frame_guide is not None")
        code = compile(ast.Module(body=[guide_if], type_ignores=[]), str(path), "exec")
        guide = object()
        for count in (0, 1, 9):
            refs = {f"ref_image_{i}": object() for i in range(count)}
            original = dict(refs)
            exec(code, {"ref_images": refs, "last_frame_guide": guide})
            for key, image in original.items():
                self.assertIs(refs[key], image)
            if count < 9:
                self.assertIs(refs[f"ref_image_{count}"], guide)
            self.assertLessEqual(len(refs), 9)

    def test_clear_removes_active_cache_only(self):
        for stem in ("chain_master_v2_6", "chain_master_v2_6_draft", "chain_master_v2_60", "chain_other_6"):
            (self.cache / f"{stem}.h3cache").touch()
            directory = self.cache / f"{stem}.final.video"
            directory.mkdir()
            (directory / "guide.pt").touch()
        for name in ("h3_motion_preview_7_0.mp4", "h3_motion_preview_70_0.mp4"):
            (self.preview / name).touch()
        (self.inputs / "picture.png").touch()
        self.ns["clear_project_cache"](["6"], ["7"])
        self.assertFalse((self.cache / "chain_master_v2_6.h3cache").exists())
        self.assertFalse((self.cache / "chain_master_v2_6_draft.final.video").exists())
        self.assertTrue((self.cache / "chain_master_v2_60.h3cache").exists())
        self.assertTrue((self.cache / "chain_other_6.final.video/guide.pt").exists())
        self.assertTrue((self.inputs / "picture.png").exists())
        self.assertFalse((self.preview / "h3_motion_preview_7_0.mp4").exists())
        self.assertTrue((self.preview / "h3_motion_preview_70_0.mp4").exists())

    def test_clear_rejects_wildcards_and_paths(self):
        for owner in ("*", "../", "6.*", "", "6/7"):
            with self.assertRaises(ValueError):
                self.ns["clear_project_cache"]([owner], [])


if __name__ == "__main__":
    unittest.main()
