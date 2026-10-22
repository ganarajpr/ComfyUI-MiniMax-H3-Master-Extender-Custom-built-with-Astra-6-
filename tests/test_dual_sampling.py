import ast
import logging
import re
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
ENGINE = ROOT / "pdd_pure_engine.py"
NODE = ROOT / "master_node.py"

GRID = [1.0, 0.9939, 0.9843, 0.9661, 0.9231, 0.8349, 0.6969, 0.4688, 0.0]

# Every input name before dual sampling existed, in order (INPUT_TYPES required + optional).
OLD_INPUT_NAMES = [
    'model', 'clip', 'vae', 'audio_vae', 'pdd_file', 'upscaler_model', 'run_mode', 'pass1_resolution', 'pass2_resolution',
    'pass2_denoise', 'pdd_nfe', 'context_length', 'audio_context_length', 'identity_continuity', 'smart_offload', 'clips_json',
    'refs_json', 'ref_image_1', 'ref_image_2', 'ref_image_3', 'ref_image_4', 'ref_image_5', 'ref_image_6', 'ref_image_7',
    'ref_image_8', 'ref_image_9', 'attention_backend', 'sla_enabled', 'sla_sparsity', 'pass2_chunk_frames', 'pass2_chunk_overlap',
    'async_decode', 'sparse_method', 'sparse_tau', 'accel_mode', 'turbo_lora', 'turbo_lora_strength', 'turbo_sampler',
    'turbo_scheduler', 'pass2_lora', 'pass2_lora_strength', 'pass2_lora_mode', 'pass2_steps', 'semantic_bridge',
    'semantic_bridge_alpha', 'semantic_bridge_match', 'clip_prompt_1', 'clip_prompt_2', 'clip_prompt_3', 'clip_prompt_4',
    'rewrite_mode', 'rewrite_task', 'rewrite_writer_model', 'rewrite_caption_length', 'rewrite_greedy', 'rewrite_temperature',
    'rewrite_max_new_tokens', 'rewrite_seed', 'rewrite_thinking', 'rewrite_reasoning_budget', 'rewrite_reasoning_budget_message',
    'rewrite_parallel', 'rewrite_system_prompt', 'rewrite_system_prompt_in', 'ref_video_1', 'ref_video_2', 'ref_video_3',
    'ref_video_audio_1', 'ref_video_audio_2', 'ref_video_audio_3', 'ref_audio_1', 'ref_audio_2', 'ref_audio_3',
    'rewrite_previous_clips', 'hyperflow_file', 'hyperflow_curve_refit', 'hyperflow_strength', 'hyperflow_lora_mode',
    'audio_refine_steps', 'audio_refine_denoise', 'audio_refine_cache', 'final_decode', 'rewrite_story', 'auto_clips',
    'planner_refs', 'auto_clip_seconds', 'story_engine', 'e4_language', 'e4_score', 'e4_decision_budget', 'e4_picture_notes',
    'sparse_start_percent', 'sparse_dense_blocks', 'sparse_sink',
]

# p1_settings exactly as master_node built it before dual sampling, for a default HyperFlow job.
P1_TODAY = {
    "p1_res": [1056, 608], "pdd_file": "", "pdd_nfe": "8", "accel_mode": "HyperFlow 8-step", "turbo_lora": "none",
    "turbo_lora_strength": 1.0, "sampler": "res_multistep", "scheduler": "simple", "attention": "comfy kitchen attention",
    "sla": [True, 0.9], "sparse": ["sla", 1.3, -1.0, "auto", "auto"],
    "hyperflow": ["custom_node_hyperflow_8step_v1.0_comfyui_pruned.safetensors", True, 1.0, "bypass"],
    "context": ["22", 0, True], "bridge": ["none", 0.12, "per_token"], "single_te": True, "refs": "digest",
}


def _functions(*names):
    tree = ast.parse(ENGINE.read_text(encoding="utf-8"))
    wanted = [n for n in tree.body if isinstance(n, ast.FunctionDef) and n.name in names]
    ns = {}
    exec(compile(ast.Module(body=wanted, type_ignores=[]), str(ENGINE), "exec"), ns)
    return ns


def _engine_methods(*names):
    """MasterEngine's own methods, lifted out of the class so they run without ComfyUI or torch."""
    tree = ast.parse(ENGINE.read_text(encoding="utf-8"))
    cls = next(n for n in tree.body if isinstance(n, ast.ClassDef) and n.name == "MasterEngine")
    methods = [n for n in cls.body if isinstance(n, ast.FunctionDef) and n.name in names]
    stub = ast.ClassDef(name="Engine", bases=[], keywords=[], body=methods, decorator_list=[])
    ns = dict(_FNS, _LOG=logging.getLogger("test_dual_sampling"))
    exec(compile(ast.fix_missing_locations(ast.Module(body=[stub], type_ignores=[])), str(ENGINE), "exec"), ns)
    return ns["Engine"]


_FNS = _functions("hyperflow_tail_sigmas", "dual_split_index", "dual_pass1_sigmas", "dual_pass2_sigmas", "with_dual_p1_settings")
Engine = _engine_methods("configure_dual_sampling", "_pass2_sigmas", "_pass2_lora_active")


def make_engine(turbo=False, pass2_lora=None):
    e = Engine()
    e.turbo_mode = turbo
    e.hyperflow_mode = not turbo
    e.hyperflow_pruned_refit = False
    e.pass2_lora = pass2_lora
    e.pass2_model = object() if pass2_lora else None
    e.pass2_steps = 4
    e.pass1_sigmas = list(GRID)
    e.dual_active = False
    e.dual_split_step = 2
    e.pass1_early_stop = False
    return e


class DefaultsAreUnchanged(unittest.TestCase):
    def test_pass1_fingerprint_settings_equal_todays(self):
        with_dual = _FNS["with_dual_p1_settings"]
        for active, early in [(False, False), (False, True), (True, False)]:
            self.assertEqual(with_dual(dict(P1_TODAY), active, 2, early), P1_TODAY)
        out = with_dual(P1_TODAY, False, 2, False)
        self.assertIs(out, P1_TODAY)

    def test_master_node_builds_the_same_keys_as_the_fixture(self):
        tree = ast.parse(NODE.read_text(encoding="utf-8"))
        literal = next(n for n in ast.walk(tree) if isinstance(n, ast.Assign) and isinstance(n.value, ast.Dict)
                       and any(getattr(t, "id", "") == "p1_settings" for t in n.targets))
        self.assertEqual([k.value for k in literal.value.keys], list(P1_TODAY))

    def test_early_stop_changes_the_fingerprint_only_when_on(self):
        on = _FNS["with_dual_p1_settings"](dict(P1_TODAY), True, 3, True)
        self.assertEqual(on["dual"], [3, True])
        self.assertEqual({k: v for k, v in on.items() if k != "dual"}, P1_TODAY)
        other = _FNS["with_dual_p1_settings"](dict(P1_TODAY), True, 4, True)
        self.assertNotEqual(on, other)

    def test_default_engine_pass2_sigmas_are_the_denoise_tail(self):
        e = make_engine()
        e.configure_dual_sampling()
        self.assertFalse(e.dual_active)
        self.assertEqual(e._pass2_sigmas(None, 0.25), GRID[-3:])
        self.assertEqual(e._pass2_sigmas(None, 0.75), GRID[-7:])
        e.configure_dual_sampling(False, 4, True)
        self.assertFalse(e.dual_active)
        self.assertFalse(e.pass1_early_stop)
        self.assertEqual(e._pass2_sigmas(None, 0.25), GRID[-3:])

    def test_old_input_names_are_a_prefix_of_the_new_ones(self):
        text = NODE.read_text(encoding="utf-8")
        names = re.findall(r'^\s{16}"(\w+)": \(', text[text.index("def INPUT_TYPES"):], re.M)
        self.assertEqual(names[:len(OLD_INPUT_NAMES)], OLD_INPUT_NAMES)
        self.assertEqual(names[len(OLD_INPUT_NAMES):], ["dual_sampling", "dual_split_step", "pass1_early_stop"])

    def test_new_inputs_default_off(self):
        text = NODE.read_text(encoding="utf-8")
        self.assertRegex(text, r'"dual_sampling": \("BOOLEAN", \{"default": False')
        self.assertRegex(text, r'"dual_split_step": \("INT", \{"default": 2, "min": 1, "max": 6')
        self.assertRegex(text, r'"pass1_early_stop": \("BOOLEAN", \{"default": False')


class DualSampling(unittest.TestCase):
    def test_pass2_is_the_grid_tail_from_the_split(self):
        for k in range(1, 7):
            e = make_engine()
            e.configure_dual_sampling(True, k, False)
            tail = e._pass2_sigmas(None, 0.25)
            self.assertEqual(tail, GRID[k:])
            self.assertEqual(len(tail) - 1, 8 - k)
        e = make_engine()
        e.configure_dual_sampling(True, 2, False)
        self.assertEqual(e._pass2_sigmas(None, 0.25)[0], 0.9843)
        self.assertEqual(e._pass2_sigmas(None, 0.9), e._pass2_sigmas(None, 0.1))

    def test_a_pass2_lora_is_dropped_with_a_warning(self):
        e = make_engine(pass2_lora="refine.safetensors")
        with self.assertLogs("test_dual_sampling", level="WARNING"):
            e.configure_dual_sampling(True, 2, False)
        self.assertIsNone(e.pass2_lora)
        self.assertIsNone(e.pass2_model)
        self.assertEqual(e._pass2_sigmas(None, 0.25), GRID[2:])

    def test_turbo_mode_warns_and_runs_normally(self):
        e = make_engine(turbo=True)
        with self.assertLogs("test_dual_sampling", level="WARNING"):
            e.configure_dual_sampling(True, 2, True)
        self.assertFalse(e.dual_active)
        self.assertFalse(e.pass1_early_stop)

    def test_early_stop_pass1_is_the_grid_head(self):
        for k in range(1, 7):
            self.assertEqual(_FNS["dual_pass1_sigmas"](GRID, k), GRID[:k + 1])
        self.assertEqual(_FNS["dual_pass1_sigmas"](GRID, 2), [1.0, 0.9939, 0.9843])

    def test_pass1_head_and_pass2_tail_share_the_split_sigma(self):
        for k in range(1, 7):
            self.assertEqual(_FNS["dual_pass1_sigmas"](GRID, k)[-1], _FNS["dual_pass2_sigmas"](GRID, k)[0])

    def test_early_stop_needs_dual_sampling(self):
        e = make_engine()
        e.configure_dual_sampling(False, 2, True)
        self.assertFalse(e.pass1_early_stop)
        e.configure_dual_sampling(True, 2, True)
        self.assertTrue(e.pass1_early_stop)

    def test_split_is_clamped_so_pass2_keeps_two_steps(self):
        self.assertEqual(_FNS["dual_split_index"](GRID, 99), 6)
        self.assertEqual(_FNS["dual_split_index"](GRID, 0), 1)


if __name__ == "__main__":
    unittest.main()
