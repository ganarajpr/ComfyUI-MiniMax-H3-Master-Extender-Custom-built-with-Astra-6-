import ast
import unittest
from pathlib import Path

import torch

SOURCE = Path(__file__).resolve().parents[1] / "pdd_pure_engine.py"


def _load(*names):
    tree = ast.parse(SOURCE.read_text(encoding="utf-8"))
    wanted = [n for n in tree.body if isinstance(n, ast.FunctionDef) and n.name in names]
    ns = {}
    exec(compile(ast.Module(body=wanted, type_ignores=[]), str(SOURCE), "exec"), ns)
    return ns


class HyperFlowModeTests(unittest.TestCase):
    ns = _load("pass_sampler_name", "hyperflow_tail_sigmas")

    def test_non_turbo_modes_sample_with_euler(self):
        pick = self.ns["pass_sampler_name"]
        self.assertEqual(pick(False, "res_multistep"), "euler")
        self.assertEqual(pick(True, "res_multistep"), "res_multistep")

    def test_pass2_tail_is_cut_from_the_trained_grid(self):
        cut = self.ns["hyperflow_tail_sigmas"]
        grid = torch.tensor([1.0, 0.9, 0.8, 0.7, 0.6, 0.5, 0.4, 0.2, 0.0])
        tail = cut(grid, 0.25)
        self.assertEqual(tail.tolist(), grid[-3:].tolist())
        self.assertEqual(cut(grid, 1.0).tolist(), grid.tolist())
        self.assertEqual(cut(grid, 0.05).tolist(), grid[-2:].tolist())


if __name__ == "__main__":
    unittest.main()
