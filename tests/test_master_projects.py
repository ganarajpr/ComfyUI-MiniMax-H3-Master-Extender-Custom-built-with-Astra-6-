import ast
import hashlib
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
            "json": json, "hashlib": hashlib, "Path": Path, "re": re, "shutil": shutil,
            "_ensure_cache_root": lambda: self.cache,
            "_preview_temp_root": lambda: self.preview,
            "_chain_paths": lambda owner: (self.cache / f"chain_{owner}.h3cache", self.cache / f"chain_{owner}.json"),
            "folder_paths": SimpleNamespace(
                get_input_directory=lambda: str(self.inputs),
                get_output_directory=lambda: str(self.root),
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
        clips = [{"id": 0, "prompt": "a", "duration": 15, "loras": []}]
        other = [{"id": 0, "prompt": "b", "duration": 15, "loras": []}]
        key = self.ns["_chain_key"](clips)
        other_key = self.ns["_chain_key"](other)
        self.assertNotEqual(key, other_key)
        for stem in (f"chain_master_v2_{key}", f"chain_master_v2_{key}_draft",
                     f"chain_master_v2_{other_key}", "chain_master_v2_6"):
            (self.cache / f"{stem}.h3cache").touch()
            directory = self.cache / f"{stem}.final.video"
            directory.mkdir()
            (directory / "guide.pt").touch()
        for name in ("h3_motion_preview_7_0.mp4", "h3_motion_preview_70_0.mp4"):
            (self.preview / name).touch()
        (self.inputs / "picture.png").touch()
        self.ns["clear_project_cache"]([json.dumps(clips)], ["7"])
        self.assertFalse((self.cache / f"chain_master_v2_{key}.h3cache").exists())
        self.assertFalse((self.cache / f"chain_master_v2_{key}_draft.final.video").exists())
        # Another project's chain and legacy node-id chains are never touched.
        self.assertTrue((self.cache / f"chain_master_v2_{other_key}.h3cache").exists())
        self.assertTrue((self.cache / "chain_master_v2_6.final.video/guide.pt").exists())
        self.assertTrue((self.inputs / "picture.png").exists())
        self.assertFalse((self.preview / "h3_motion_preview_7_0.mp4").exists())
        self.assertTrue((self.preview / "h3_motion_preview_70_0.mp4").exists())

    def test_chain_key_ignores_seed_and_validation_but_not_content(self):
        base = {"id": 0, "prompt": "a", "duration": 15, "loras": [], "seed": 1, "validated": False}
        key = self.ns["_chain_key"]([base])
        self.assertEqual(key, self.ns["_chain_key"]([dict(base, seed=2, validated=True, id=9)]))
        self.assertEqual(key, self.ns["_chain_key"]([dict(base, duration="15", loras="[]")]))
        for change in ({"prompt": "b"}, {"duration": 10}, {"loras": [{"lora": "x"}]}):
            self.assertNotEqual(key, self.ns["_chain_key"]([dict(base, **change)]))
        self.assertRegex(key, r"^c_[0-9a-f]{16}$")

    def test_cache_states_follow_fingerprints(self):
        clips = [{"id": i, "prompt": f"clip {i}", "duration": 15, "loras": [], "seed": 10 + i} for i in range(4)]
        fps, previous = [], None
        for clip in clips[:3]:
            previous = self.ns["_clip_fingerprint"](previous, clip, clip["seed"])
            fps.append(previous)
        manifest = {"segments": [{}, {}, {}], "clip_fingerprints": [fps[0], None, fps[2]]}
        key = self.ns["_chain_key"](clips)
        (self.cache / f"chain_master_v2_{key}.json").write_text(json.dumps(manifest))
        final_dir = self.cache / f"chain_master_v2_{key}.final.video"
        final_dir.mkdir()
        (final_dir / "ref2va_0000.mp4").write_bytes(b"x")
        (final_dir / "ref2va_0.guide.pt").write_bytes(b"x")
        videos = self.ns["clip_cache_states"](clips)[1]
        self.assertEqual([v and (v["filename"], v["subfolder"]) for v in videos],
                         [("ref2va_0000.mp4", f"cache/chain_master_v2_{key}.final.video"), None, None])
        self.assertEqual(self.ns["clip_cache_states"](clips)[0], ["cached", "unverified", "cached", "none"])
        clips[1]["seed"] = 99   # an earlier clip changed -> every later cached clip is stale too
        self.assertEqual(self.ns["clip_cache_states"](clips)[0], ["cached", "unverified", "stale", "none"])
        other = [dict(clips[0], prompt="another project")]
        self.assertEqual(self.ns["clip_cache_states"](other)[0], ["none"])

    def test_clear_rejects_bad_input(self):
        for final in ("*", "../", "6.*", "", "6/7"):
            with self.assertRaises(ValueError):
                self.ns["clear_project_cache"]([], [final])
        with self.assertRaises(ValueError):
            self.ns["clear_project_cache"]("not a list", [])
        # Unparseable project clips are skipped, never turned into a glob.
        self.ns["clear_project_cache"](["{not json", "[]", "*"], [])


if __name__ == "__main__":
    unittest.main()
