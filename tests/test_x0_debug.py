import importlib.util
import os
import sys
import tempfile
import unittest
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[1]


def _load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    mod = importlib.util.module_from_spec(spec)
    sys.modules[name] = mod
    spec.loader.exec_module(mod)
    return mod


x0d = _load("x0_debug_t", ROOT / "x0_debug.py")
ana = _load("x0_step_analysis_t", ROOT / "tools" / "x0_step_analysis.py")


class FakeTensor:
    is_nested = False
    shape = (1, 1, 1, 1, 1)

    def __init__(self, a):
        self.a = a

    def detach(self):
        return self

    def cpu(self):
        return self


class FlagTests(unittest.TestCase):
    def test_flag_absent_means_disabled(self):
        with tempfile.TemporaryDirectory() as d:
            self.assertFalse(x0d.debug_enabled(d))
            Path(d, "user").mkdir()
            self.assertFalse(x0d.debug_enabled(d))
            Path(d, "user", "master_x0_debug").touch()
            self.assertTrue(x0d.debug_enabled(d))

    def test_engine_gate_is_flag_only(self):
        src = (ROOT / "pdd_pure_engine.py").read_text()
        self.assertIn("if not x0_debug.debug_enabled(folder_paths.base_path):\n                return None", src)
        self.assertIn("if dumper is not None:\n            callback = dumper.wrap(callback)", src)

    def test_wrap_defers_and_records(self):
        with tempfile.TemporaryDirectory() as d:
            saved = []
            dump = x0d.X0Dump(os.path.join(d, "run"), [1.0, 0.5, 0.0], lambda x: x, save=lambda o, p: saved.append(p))
            seen = []
            cb = dump.wrap(lambda *a: seen.append(a[0]))
            cb(0, FakeTensor(1), None, 2)
            cb(1, FakeTensor(2), None, 2)
            self.assertEqual(seen, [0, 1])
            self.assertEqual([os.path.basename(p) for p in saved], ["step_01_sigma_1.0000.pt", "step_02_sigma_0.5000.pt"])

    def test_failure_never_raises(self):
        with tempfile.TemporaryDirectory() as d:
            def boom(o, p):
                raise OSError("disk full")
            dump = x0d.X0Dump(os.path.join(d, "run"), [1.0, 0.0], lambda x: x, save=boom)
            dump.wrap(None)(0, FakeTensor(1), None, 1)
            dump.save_final(FakeTensor(1))

    def test_dump_dir_counts_repeats(self):
        a = x0d.dump_dir("/o", "zz-test")
        b = x0d.dump_dir("/o", "zz-test")
        self.assertTrue(a.endswith("zz-test") and b.endswith("zz-test_2"))

    def test_frame_indices(self):
        self.assertEqual(x0d.frame_indices(91), [9, 45, 81])
        self.assertEqual(x0d.frame_indices(1), [0])


class AnalysisTests(unittest.TestCase):
    def _steps(self):
        rng = np.random.default_rng(0)
        c, t, h, w = 4, 8, 16, 16
        coarse = rng.normal(size=(c, t // 2, h // 4, w // 4))
        final_lp = np.repeat(np.repeat(np.repeat(coarse, 2, 1), 4, 2), 4, 3)
        detail = rng.normal(size=(c, t, h, w)) * 0.3
        final = final_lp + detail
        out = []
        for i in range(1, 5):
            struct_err = 0.0 if i >= 2 else 1.0
            noise = rng.normal(size=final.shape)
            x = final + struct_err * np.repeat(np.repeat(np.repeat(rng.normal(size=coarse.shape), 2, 1), 4, 2), 4, 3)
            x = x + (4 - i) * 0.5 * noise * (i < 4)
            out.append((i, 1.0 - i * 0.2, x if i < 4 else final))
        return out

    def test_final_is_zero_and_structure_settles(self):
        rows = ana.analyse(self._steps())
        self.assertEqual(len(rows), 4)
        for k in ("structure", "detail", "motion"):
            self.assertAlmostEqual(rows[-1][f"{k}_vs_final"], 0.0, places=9)
            self.assertIsNone(rows[0][f"{k}_vs_prev"])
        self.assertGreater(rows[0]["structure_vs_final"], rows[1]["structure_vs_final"])
        self.assertGreater(rows[1]["detail_vs_final"], rows[3]["detail_vs_final"])

    def test_lowpass_highpass_shapes_and_identity(self):
        x = np.random.default_rng(1).normal(size=(2, 6, 8, 8))
        self.assertEqual(ana.lowpass(x).shape, (2, 3, 2, 2))
        self.assertEqual(ana.highpass(x).shape, (2, 6, 8, 8))
        const = np.ones((2, 6, 8, 8))
        self.assertAlmostEqual(float(np.abs(ana.highpass(const)).max()), 0.0)

    def test_table_and_sheet(self):
        rows = ana.analyse(self._steps())
        table = ana.format_table(rows)
        self.assertEqual(len(table.splitlines()), 5)
        try:
            from PIL import Image
        except ImportError:
            return
        with tempfile.TemporaryDirectory() as d:
            for s in (1, 2):
                for f in (0, 5):
                    Image.fromarray(np.full((9, 16, 3), 40 * s, np.uint8)).save(os.path.join(d, f"step_{s:02d}_frame_{f:03d}.png"))
            out = os.path.join(d, "sheet.png")
            self.assertTrue(ana.contact_sheet(d, out, thumb_w=16))
            self.assertEqual(Image.open(out).size, (90 + 32, 18))


if __name__ == "__main__":
    unittest.main()
