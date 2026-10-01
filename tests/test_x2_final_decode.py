import ast
import copy
import hashlib
import json
import logging
import os
import tempfile
import time
import sys
import types
import unittest
from pathlib import Path

import torch


SOURCE = Path(__file__).resolve().parents[1] / "motion_context_disk.py"
FUNCTIONS = {
    "normalize_full_batch_export_profile", "_full_batch_export_profile_signature",
    "_profile_is_x2", "_final_decode_record", "_apply_final_decode_record",
    "set_manifest_final_decode", "_decode_pair_video",
    "_render_one_final_video_segment", "_ensure_ref2va_final_segment_cache",
    "_resolve_full_batch_export_profile", "_final_segment_cache_meta_matches",
    "_tag_ref2va_final_segment_cache", "decode_video_latent_x2",
}
CONSTANTS = {"X2_DECODE_SETTINGS", "_X2_GPU_OUTPUT_HEADROOM", "_DECODE_RECLAIM_MARGIN", "FINAL_DECODE_STANDARD", "FINAL_DECODE_X2", "FULL_BATCH_FINAL_PROFILE_VERSION",
             "FULL_BATCH_FINAL_CACHE_VERSION"}


class X2FinalDecodeTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.state = {"segments": [{"index": 0}, {"index": 1, "decoded_seam_shift": -1}]}
        self.render_calls = []
        self.loaded = []
        self.x2_vae = object()
        self.plain_vae = object()
        self.encoded = []
        self.ns = {
            "Path": Path, "os": os, "torch": torch, "time": time, "json": json, "hashlib": hashlib,
            "_LOG": logging.getLogger("test"),
            "_load_manifest_from_paths": lambda *a: copy.deepcopy(self.state),
            "_write_json_atomic": self.write_manifest,
            "_normalize_color_adjustment": lambda v: v or {},
            "_color_adjustment_signature": lambda v: "c",
            "_color_is_neutral": lambda v: True,
            "_ref2va_final_segment_cache_path": lambda *a: self.root / "final.mp4",
            "_encode_final_segment_video": self.encode,
            "_full_batch_export_profile_extension": lambda p: "mp4",
            "shutil": __import__("shutil"),
            "uuid": __import__("uuid"),
            "_x2_decoder_class": lambda: object,
            "load_final_vae": self.load_final_vae,
            "decode_video_latent": lambda vae, latent: ("plain", vae, latent),
            "decode_video_latent_x2": lambda vae, latent: torch.zeros(2, 8, 12, 3),
            "_load_segment_video": lambda *a: "latent",
            "_build_pair_video": lambda *a: ("chain", {"decode_frames": 4, "previous_frames": 1,
                                                       "warmup_frames": 1, "continued_frames": 2}),
            "_auto_early_seam_shift": lambda *a, **k: self.fail("auto shift must not run when forced"),
            "_correct_current_segment": lambda prev, cur: cur,
        }
        tree = ast.parse(SOURCE.read_text(encoding="utf-8"))
        body = [n for n in tree.body if (isinstance(n, ast.FunctionDef) and n.name in FUNCTIONS) or
                (isinstance(n, ast.Assign) and any(getattr(t, "id", None) in CONSTANTS for t in n.targets))]
        exec(compile(ast.Module(body=body, type_ignores=[]), str(SOURCE), "exec"), self.ns)
        self.ns["decode_video_latent_x2"] = lambda vae, latent, info=None: torch.zeros(2, 8, 12, 3)

    def load_final_vae(self, name):
        self.loaded.append(name)
        if name != "X2.safetensors":
            raise RuntimeError("that VAE file is not in models/vae any more")
        return self.x2_vae

    def write_manifest(self, path, manifest):
        self.state = copy.deepcopy(manifest)

    def encode(self, ffmpeg, video, fps, path, token, profile, adjustment=None):
        self.encoded.append(tuple(video.shape))
        Path(path).write_bytes(b"video")

    def x2_profile(self, vae="X2.safetensors"):
        return self.ns["normalize_full_batch_export_profile"](
            {"codec": "H.264", "crf": 17, "preset": "fast", "final_decode": "X2 detail", "final_vae": vae})

    def test_standard_signature_is_unchanged_and_x2_differs(self):
        norm = self.ns["normalize_full_batch_export_profile"]
        sig = self.ns["_full_batch_export_profile_signature"]
        standard = norm({"codec": "H.264", "crf": 17, "preset": "fast"})
        self.assertEqual(standard, {"version": 1, "codec": "H.264", "crf": 17, "preset": "fast"})
        legacy = hashlib.sha256(json.dumps(standard, sort_keys=True, separators=(",", ":")).encode()).hexdigest()
        self.assertEqual(sig(standard), legacy)
        self.assertNotEqual(sig(self.x2_profile()), legacy)
        self.assertNotEqual(sig(self.x2_profile("a.safetensors")), sig(self.x2_profile("b.safetensors")))
        self.assertEqual(norm({"final_decode": "standard"}), norm({}))

    def test_record_forces_profile_mode(self):
        apply = self.ns["_apply_final_decode_record"]
        record = self.ns["_final_decode_record"]("X2 detail", "X2.safetensors")
        self.assertIsNone(self.ns["_final_decode_record"]("standard", "x"))
        self.assertEqual(apply({"codec": "H.264"}, record), self.x2_profile())
        self.assertEqual(apply(self.x2_profile(), None), apply({"codec": "H.264"}, None))

    def test_resolve_profile_keeps_recorded_mode_over_stored_checkpoint(self):
        self.state["final_decode"] = {"mode": "X2 detail", "vae": "X2.safetensors"}
        self.state["batch_in_progress"] = True
        self.state["full_batch_export_profile"] = self.ns["normalize_full_batch_export_profile"]({})
        manifest, profile = self.ns["_resolve_full_batch_export_profile"](
            self.root / "m.json", copy.deepcopy(self.state), {"codec": "H.264", "crf": 17, "preset": "fast"})
        self.assertEqual(profile, self.x2_profile())

    def test_x2_sidecar_decodes_with_final_vae_and_ignores_1x_frames(self):
        def render(data, segments, index, vae, progress=None, decode_fn=None, forced_shift=None):
            self.render_calls.append((index, vae, forced_shift))
            return decode_fn(vae, "latent"), 0
        self.ns["_render_one_final_video_segment"] = render
        manifest, path, decoded = self.ns["_ensure_ref2va_final_segment_cache"](
            self.root / "d", self.root / "m.json", copy.deepcopy(self.state), 1, self.plain_vae, 24.0,
            "ffmpeg", self.x2_profile(), decoded_video=torch.zeros(2, 4, 6, 3),
            encoded_mp4=self.root / "x.mp4", encoded_settings=("H.264", 17, "fast"),
        )
        self.assertEqual(self.loaded, ["X2.safetensors"])
        self.assertEqual(self.render_calls, [(1, self.x2_vae, -1)])
        self.assertEqual(self.encoded, [(2, 8, 12, 3)])
        self.assertTrue(decoded)

    def test_x2_sidecar_with_missing_vae_file_raises_instead_of_decoding_1x(self):
        self.ns["_render_one_final_video_segment"] = lambda *a, **k: self.fail("must not decode")
        with self.assertRaisesRegex(RuntimeError, "not in models/vae"):
            self.ns["_ensure_ref2va_final_segment_cache"](
                self.root / "d", self.root / "m.json", copy.deepcopy(self.state), 0, self.plain_vae,
                24.0, "ffmpeg", self.x2_profile("gone.safetensors"),
            )

    def test_standard_sidecar_path_is_unchanged(self):
        def render(data, segments, index, vae, progress=None):
            self.render_calls.append((index, vae))
            return torch.zeros(2, 4, 6, 3), 0
        self.ns["_render_one_final_video_segment"] = render
        profile = self.ns["normalize_full_batch_export_profile"]({})
        self.ns["_ensure_ref2va_final_segment_cache"](
            self.root / "d", self.root / "m.json", copy.deepcopy(self.state), 0, self.plain_vae,
            24.0, "ffmpeg", profile,
        )
        self.assertEqual(self.render_calls, [(0, self.plain_vae)])
        self.assertEqual(self.encoded, [(2, 4, 6, 3)])

    def test_pair_decode_uses_given_decoder_and_forced_shift(self):
        decoded = torch.zeros(4, 2, 2, 3)
        self.ns["_decode_pair_video"].__globals__["decode_video_latent"] = lambda *a: self.fail("1x decoder used")
        _, previous, current, shift = self.ns["_decode_pair_video"](
            object(), "chain", {"decode_frames": 4, "previous_frames": 1, "warmup_frames": 1,
                                "continued_frames": 2},
            decode_fn=lambda vae, chain: decoded, forced_shift=-1,
        )
        self.assertEqual((shift, previous.shape[0], current.shape[0]), (-1, 1, 2))


def write_safetensors_header(path, tensors):
    import struct
    header = {k: {"dtype": "F32", "shape": list(v), "data_offsets": [0, 0]} for k, v in tensors.items()}
    header["__metadata__"] = {"format": "pt"}
    raw = json.dumps(header).encode()
    Path(path).write_bytes(struct.pack("<Q", len(raw)) + raw)


class PackedVaeDetectionTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.logger = logging.getLogger("test")
        import math
        import struct
        self.ns = {"json": json, "math": math, "os": os, "_LOG": self.logger,
                   "FINAL_DECODE_STANDARD": "standard", "FINAL_DECODE_X2": "X2 detail",
                   "_PACKED_VAE_CACHE": {}, "_x2_decoder_class": lambda: object}
        self.folder_paths = types.SimpleNamespace(
            get_filename_list=lambda kind: sorted(p.name for p in self.root.iterdir()),
            get_full_path=lambda kind, name: str(self.root / name),
        )
        self.ns["folder_paths"] = self.folder_paths
        names = {"_safetensors_header", "_header_packed_factor", "packed_vae_files",
                 "final_decode_options", "normalize_final_decode"}
        consts = {"_H3_DECODER_PATCH_VOLUME"}
        tree = ast.parse(SOURCE.read_text(encoding="utf-8"))
        body = [n for n in tree.body if (isinstance(n, ast.FunctionDef) and n.name in names) or
                (isinstance(n, ast.Assign) and any(getattr(t, "id", None) in consts for t in n.targets))]
        exec(compile(ast.Module(body=body, type_ignores=[]), str(SOURCE), "exec"), self.ns)
        write_safetensors_header(self.root / "stock.safetensors", {"decoder.proj_out.weight": (3072, 2048), "x": (4,)})
        write_safetensors_header(self.root / "X2.safetensors", {"decoder.proj_out.weight": (12288, 2048)})
        write_safetensors_header(self.root / "audio.safetensors", {"decoder.conv.weight": (8, 8)})
        (self.root / "junk.pt").write_bytes(b"not safetensors")

    def test_only_packed_video_vae_is_listed(self):
        self.assertEqual(self.ns["packed_vae_files"](), ["X2.safetensors"])
        self.assertEqual(self.ns["final_decode_options"](), ["standard", "X2.safetensors"])

    def test_no_packed_vae_means_standard_only(self):
        (self.root / "X2.safetensors").unlink()
        self.assertEqual(self.ns["final_decode_options"](), ["standard"])

    def test_header_probe_is_cached_by_name_mtime_size(self):
        self.ns["packed_vae_files"]()
        calls = []
        real = self.ns["_safetensors_header"]
        self.ns["_safetensors_header"] = lambda path: calls.append(path) or real(path)
        self.ns["packed_vae_files"]()
        self.assertEqual(calls, [])
        write_safetensors_header(self.root / "X2.safetensors", {"decoder.proj_out.weight": (3072, 2048)})
        self.assertEqual(self.ns["packed_vae_files"](), [])

    def test_normalize_final_decode(self):
        norm = self.ns["normalize_final_decode"]
        self.assertEqual(norm("X2.safetensors"), "X2.safetensors")
        for stale in (None, "", "standard", "gone.safetensors", "stock.safetensors"):
            self.assertEqual(norm(stale), "standard")
        self.assertEqual(norm("X2 detail"), "X2.safetensors")
        (self.root / "X2.safetensors").unlink()
        self.assertEqual(norm("X2 detail"), "standard")


class X2DeviceChoiceTests(unittest.TestCase):
    # latent 1x4x7x4x6 -> 21 frames at (4*16*2) x (6*16*2) = 128 x 192
    OUT_BYTES = 21 * 128 * 192 * 3 * 4

    def run_decode(self, free, decode):
        calls = []
        mm = types.SimpleNamespace(
            get_torch_device=lambda: "cuda:0", free_memory=lambda *a, **k: None,
            soft_empty_cache=lambda **k: calls.append("empty"),
            get_free_memory=lambda device: free,
        )
        saved = {k: sys.modules.get(k) for k in ("comfy", "comfy.model_management")}
        sys.modules["comfy"] = types.ModuleType("comfy")
        sys.modules["comfy.model_management"] = mm
        self.addCleanup(lambda: [sys.modules.pop(k, None) if v is None else sys.modules.__setitem__(k, v)
                                 for k, v in saved.items()])

        devices = []

        class Node:
            def decode(self, samples, vae, **settings):
                devices.append(settings["output_device"])
                return (decode(settings["output_device"], len(devices)),)

        ns = {"torch": torch, "_LOG": logging.getLogger("test"), "DECODE_ALLOW_RECLAIM": True,
              "_x2_decoder_class": lambda: Node, "_x2_upscale_factor": lambda vae: 2,
              "_frames_from_video_t": lambda t: 21, "_loaded_entries_for": lambda p: [],
              "_DECODE_RECLAIM_MARGIN": 0}
        tree = ast.parse(SOURCE.read_text(encoding="utf-8"))
        body = [n for n in tree.body if (isinstance(n, ast.FunctionDef) and n.name == "decode_video_latent_x2") or
                (isinstance(n, ast.Assign) and any(getattr(t, "id", None) in
                 {"X2_DECODE_SETTINGS", "_X2_GPU_OUTPUT_HEADROOM"} for t in n.targets))]
        exec(compile(ast.Module(body=body, type_ignores=[]), str(SOURCE), "exec"), ns)
        info = {}
        vae = types.SimpleNamespace(output_device="cpu", vae_dtype=None, memory_used_decode=lambda *a: 0)
        out = ns["decode_video_latent_x2"](vae, torch.zeros(1, 4, 7, 4, 6), info=info)
        return out, devices, info

    @staticmethod
    def frames(device, call):
        return torch.zeros(21, 128 + 1, 192 + 1, 3)

    def test_gpu_when_it_fits(self):
        _, devices, info = self.run_decode(int(2.5 * self.OUT_BYTES), self.frames)
        self.assertEqual((devices, info["output_device"]), (["gpu"], "gpu"))

    def test_cpu_when_it_does_not_fit(self):
        _, devices, info = self.run_decode(int(2.5 * self.OUT_BYTES) - 1, self.frames)
        self.assertEqual((devices, info["output_device"]), (["cpu"], "cpu"))

    def test_gpu_oom_retries_once_on_cpu(self):
        def decode(device, call):
            if device == "gpu":
                raise torch.cuda.OutOfMemoryError("Allocation on device 0 would exceed allowed memory")
            return self.frames(device, call)
        _, devices, info = self.run_decode(10 * self.OUT_BYTES, decode)
        self.assertEqual((devices, info["output_device"]), (["gpu", "cpu"], "cpu"))

    def test_cpu_oom_is_not_retried(self):
        def decode(device, call):
            raise torch.cuda.OutOfMemoryError("oom")
        with self.assertRaises(torch.cuda.OutOfMemoryError):
            self.run_decode(0, decode)


if __name__ == "__main__":
    unittest.main()
