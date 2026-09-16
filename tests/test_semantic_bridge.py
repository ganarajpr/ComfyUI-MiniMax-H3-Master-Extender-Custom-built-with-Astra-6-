import ast
from pathlib import Path
import unittest

import torch


SOURCE = Path(__file__).resolve().parents[1] / "pdd_pure_engine.py"


class FakeBridge:
    calls = []

    def apply(self, conditioning, adapter, alpha, magnitude_match, enabled):
        FakeBridge.calls.append((adapter, alpha, magnitude_match, enabled))
        out = []
        for tensor, meta in conditioning:
            new_meta = dict(meta)
            new_meta["bunny_h3_bridge"] = True
            out.append([tensor * 2, new_meta])
        return (out,)


class SemanticBridgeTests(unittest.TestCase):
    def setUp(self):
        FakeBridge.calls = []
        tree = ast.parse(SOURCE.read_text(encoding="utf-8"))
        wanted = {"apply_semantic_bridge", "_safe_get_output"}
        body = [n for n in tree.body if isinstance(n, ast.FunctionDef) and n.name in wanted]
        self.assertEqual({n.name for n in body}, wanted)
        self.ns = {}
        exec(compile(ast.Module(body=body, type_ignores=[]), str(SOURCE), "exec"), self.ns)
        self.apply = self.ns["apply_semantic_bridge"]
        self.positive = [[torch.ones(1, 4, 5120), {"minimax_refs": []}]]

    def test_none_and_zero_alpha_pass_through_without_touching_the_node(self):
        mappings = {"BunnyH3ConditioningBridge": FakeBridge}
        for adapter, alpha in (("none", 0.12), ("", 0.12), (None, 0.12), ("x.safetensors", 0.0)):
            out = self.apply(self.positive, adapter, alpha, "per_token", mappings)
            self.assertIs(out, self.positive)
        self.assertEqual(FakeBridge.calls, [])

    def test_bridge_is_called_with_the_configured_settings(self):
        mappings = {"BunnyH3ConditioningBridge": FakeBridge}
        out = self.apply(self.positive, "x.safetensors", 0.15, "global", mappings, label="pass 1")
        self.assertEqual(FakeBridge.calls, [("x.safetensors", 0.15, "global", True)])
        self.assertEqual(len(out), 1)
        self.assertTrue(torch.equal(out[0][0], torch.full((1, 4, 5120), 2.0)))
        self.assertTrue(out[0][1]["bunny_h3_bridge"])
        self.assertEqual(out[0][1]["minimax_refs"], [])

    def test_missing_node_is_an_explicit_error(self):
        with self.assertRaises(RuntimeError) as ctx:
            self.apply(self.positive, "x.safetensors", 0.12, "per_token", {})
        self.assertIn("BUNNY_H3_Conditioning_Bridge", str(ctx.exception))


if __name__ == "__main__":
    unittest.main()
