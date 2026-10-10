import sys
import types
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import vram_release  # noqa: E402


class VramReleaseTests(unittest.TestCase):
    def setUp(self):
        self.saved = list(vram_release._CALLBACKS)
        vram_release._CALLBACKS.clear()
        self.addCleanup(lambda: vram_release._CALLBACKS.__init__(self.saved))

    def test_release_runs_every_callback_and_survives_a_failing_one(self):
        ran = []

        def boom():
            raise RuntimeError("x")

        vram_release.register(boom)
        vram_release.register(lambda: ran.append(1))
        with self.assertLogs("MiniMaxH3Master.vram_release", level="WARNING"):
            vram_release.release()
        self.assertEqual(ran, [1])

    def test_a_callback_registers_once(self):
        calls = []
        fn = lambda: calls.append(1)  # noqa: E731
        vram_release.register(fn)
        vram_release.register(fn)
        vram_release.release()
        self.assertEqual(calls, [1])

    def test_unload_all_models_also_releases_and_wraps_once(self):
        order = []
        mm = types.SimpleNamespace(unload_all_models=lambda: order.append("unload") or "done")
        vram_release.register(lambda: order.append("release"))
        self.assertTrue(vram_release.install(mm))
        self.assertFalse(vram_release.install(mm))
        self.assertEqual(mm.unload_all_models(), "done")
        self.assertEqual(order, ["unload", "release"])

    def test_without_comfy_nothing_is_wrapped(self):
        self.assertFalse(vram_release.install(types.SimpleNamespace()))


if __name__ == "__main__":
    unittest.main()
