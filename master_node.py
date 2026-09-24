"""
MiniMax H3 Master Extender Node
===============================
Interactive Master multishot node combining the Pure 2-Stage 2-Pass PDD 8-Step
+ 3D Latent Upscaler Engine with multishot continuity, per-clip controls,
and clip-by-clip validation.
"""

from __future__ import annotations

import json
import hashlib
import logging
import os
import secrets
import threading
import time
from pathlib import Path
import torch
import comfy.samplers
from server import PromptServer

import folder_paths
import nodes
from .master_projects import load_reference_images, _clip_identity, _chain_key
from . import prompt_rewriter

from . import motion_context_disk
from .motion_context_disk import (
    CACHE_TYPE,
    FPS,
    MiniMaxH3MotionContextDiskJoin,
    _manifest_for_first,
    _load_manifest_from_paths,
    _truncate_chain,
    _write_json_atomic,
    _load_guide_frame,
    _cache_guide_frame,
    _render_one_final_video_segment,
    cache_full_batch_ref2va_segment,
    decode_guide_frame,
)
from .motion_context_ram import _streams_from_latent
from .pdd_pure_engine import (
    PurePDDEngine,
    parse_resolution,
    duration_to_h3_frames,
)

_LOG = logging.getLogger("minimax_h3_master_extender")
EVENT_PROGRESS = "master_extender_progress"
EVENT_CLIPS = "master_extender_clips"
EVENT_REWRITE = "master_extender_rewrite"


def _default_clips():
    return [
        {
            "id": 0,
            "title": "Clip 1",
            "prompt": "",
            "duration": 15,
            "seed": secrets.randbelow(10**14),
            "seed_mode": "randomize",
            "validated": False,
            "loras": [],
        }
    ]


def _default_refs():
    return {
        "images": [None] * 9,
    }


class _DecodeWorker:
    """Runs one clip's decode/cache on a worker thread and its own CUDA stream.

    Inference mode is thread-local, so it is re-entered here. The worker never
    evicts other models (DECODE_ALLOW_RECLAIM is cleared for its duration);
    the Master node joins it before anything that writes the shared manifest
    and before any large sampling pass.
    """

    def __init__(self, fn, label=""):
        self.error = None
        self.result = None
        self.label = label
        self.thread = threading.Thread(target=self._run, args=(fn,), daemon=True,
                                       name=f"h3-master-decode-{label}")
        self.thread.start()

    def _run(self, fn):
        try:
            motion_context_disk.DECODE_ALLOW_RECLAIM = False
            with torch.inference_mode():
                if torch.cuda.is_available():
                    stream = torch.cuda.Stream()
                    with torch.cuda.stream(stream):
                        self.result = fn()
                    stream.synchronize()
                else:
                    self.result = fn()
        except BaseException as exc:  # noqa: BLE001 -- re-raised on the main thread
            self.error = exc
        finally:
            motion_context_disk.DECODE_ALLOW_RECLAIM = True

    def busy(self):
        return self.thread.is_alive()

    def wait(self):
        started = time.time()
        self.thread.join()
        waited = time.time() - started
        if waited > 1.0:
            _LOG.info("Background decode (%s): waited %.1f s for it to finish", self.label, waited)
        if self.error is not None:
            raise self.error
        return self.result


def _async_decode_allowed(mode, vae, sampled_latent):
    """auto: only when the decode's own memory estimate is small enough to sit
    beside the resident UNet; a decode that would page just slows both jobs."""
    mode = str(mode or "auto").lower()
    if mode == "off":
        return False
    # comfy-aimdo's dynamic VRAM streamer is not safe across threads/streams:
    # loading the next clip's text encoder while a worker thread decodes died
    # with "hostbuf_file_reader_read: device copy failed". Never overlap there.
    try:
        import comfy.memory_management as cmm
        if getattr(cmm, "aimdo_enabled", False):
            _LOG.info("Background decode: disabled -- dynamic VRAM (comfy-aimdo) cannot stream weights "
                      "from two threads; decoding sequentially (start ComfyUI with --disable-dynamic-vram "
                      "to allow it)")
            return False
    except Exception:
        pass
    if mode == "on":
        return True
    try:
        import comfy.model_management as mm
        video = _streams_from_latent(sampled_latent, "samples")[0]
        needed = int(vae.memory_used_decode(tuple(video.shape), vae.vae_dtype))
        total = int(mm.get_total_memory(mm.get_torch_device()))
        ok = needed <= 0.2 * total
        _LOG.info("Background decode auto: decode needs ~%.1f GB of %.0f GB -> %s",
                  needed / 1024 ** 3, total / 1024 ** 3, "background" if ok else "sequential")
        return ok
    except Exception as exc:
        _LOG.warning("Background decode auto check failed (%s); decoding sequentially", exc)
        return False


def _send_to_queuer(event, payload):
    """Send a panel event only to the browser that queued the running job.

    Broadcasting reached every open tab, and the panel matches by node id --
    so a run in one tab rewrote prompts/seeds in another tab whose Master node
    had the same id. Jobs queued without a client id (API) still broadcast.
    """
    server = PromptServer.instance
    server.send_sync(event, payload, getattr(server, "client_id", None))


def _send_progress(owner, clip_index, total_clips, stage, message, pct=0.0):
    """Send real-time progress update to ComfyUI frontend."""
    try:
        _send_to_queuer(
            EVENT_PROGRESS,
            {
                "owner": str(owner),
                "clip_index": int(clip_index),
                "total_clips": int(total_clips),
                "stage": str(stage),
                "message": str(message),
                "percent": float(pct),
            },
        )
    except Exception:
        pass



def _send_clips(owner, clips, fields=None, chain=None):
    """Hand the clip list back to the panel.

    ``fields`` names what the panel may take over; anything else it keeps as the
    user has it. The rewrite pass sends the prompt fields; the end of the run
    sends only the seeds, so an edit or 'Rewrite again' made while the clips
    were rendering is not undone by stale server-side state.
    """
    payload = {"owner": str(owner), "clips": clips, "fields": list(fields or [])}
    if chain:
        payload["chain"] = str(chain)
    try:
        _send_to_queuer(EVENT_CLIPS, payload)
    except Exception:
        pass


def _clip_fingerprint(previous, clip, seed):
    """Fingerprint of clip i = its inputs + seed + everything before it."""
    blob = json.dumps([previous or "", _clip_identity(clip), int(seed)], sort_keys=True, default=str)
    return hashlib.sha256(blob.encode()).hexdigest()[:16]


def _stored_fingerprints(data_path, manifest_path):
    state = _load_manifest_from_paths(data_path, manifest_path) or {}
    count = len(state.get("segments", []))
    return list(state.get("clip_fingerprints") or [])[:count]


def _store_fingerprints(data_path, manifest_path, fingerprints):
    """Record per-clip fingerprints for the clips currently on disk."""
    state = _load_manifest_from_paths(data_path, manifest_path)
    if not state:
        return
    count = len(state.get("segments", []))
    merged = list(state.get("clip_fingerprints") or [])[:count]
    merged += [None] * (count - len(merged))
    for index, value in fingerprints.items():
        if index < count:
            merged[index] = value
    if merged != state.get("clip_fingerprints"):
        state["clip_fingerprints"] = merged
        _write_json_atomic(manifest_path, state)


def _send_rewrite(owner, index, clip_id, phase, text):
    """Stream one clip's rewrite to the panel while the writer is still going."""
    try:
        _send_to_queuer(
            EVENT_REWRITE,
            {"owner": str(owner), "index": int(index), "clip_id": clip_id, "phase": str(phase), "text": text or ""},
        )
    except Exception:
        pass


def _semantic_bridge_adapters():
    """Adapter files known to the BUNNY H3 Conditioning Bridge pack (optional dependency):
    its bundled models/ folder plus the `semantic_bridge` model category."""
    names = []
    bridge_cls = nodes.NODE_CLASS_MAPPINGS.get("BunnyH3ConditioningBridge")
    if bridge_cls is not None:
        try:
            names = list(bridge_cls.INPUT_TYPES()["required"]["adapter"][0])
        except Exception:
            names = []
    if not names:
        try:
            names = list(folder_paths.get_filename_list("semantic_bridge"))
        except Exception:
            names = []
    return [n for n in names if n.lower().endswith(".safetensors") and not n.startswith("NO_ADAPTER_FOUND")]

class MiniMaxH3MasterExtender:
    """Master node for MiniMax H3 multishot video generation with Pure PDD engine."""

    @classmethod
    def INPUT_TYPES(cls):
        # Scan available PDD models
        pdd_files = []
        if "pdd_acc" in folder_paths.folder_names_and_paths:
            pdd_files.extend(folder_paths.get_filename_list("pdd_acc"))
        lora_list = folder_paths.get_filename_list("loras")
        for f in lora_list:
            if any(k in f.lower() for k in ["pdd", "acc", "8step"]):
                if f not in pdd_files:
                    pdd_files.append(f)
        if not pdd_files:
            pdd_files = ["MiniMax-H3-Ref2VA-Acc-8Step.safetensors"]

        # Scan available 3D upscaler models
        upscaler_files = []
        if "latent_upscale_models" in folder_paths.folder_names_and_paths:
            upscaler_files.extend(folder_paths.get_filename_list("latent_upscale_models"))
        if not upscaler_files:
            upscaler_files = [
                "minimax_h3_latent_upscaler_3d_fp16.safetensors",
                "minimax_h3_latent_upscaler_3d_fp32.pth",
            ]

        return {
            "required": {
                "model": ("MODEL", {"tooltip": "Base MiniMax H3 Ref2VA diffusion model"}),
                "clip": ("CLIP", {"tooltip": "Qwen3-VL text encoder"}),
                "vae": ("VAE", {"tooltip": "MiniMax H3 Video VAE"}),
                "audio_vae": ("VAE", {"tooltip": "MiniMax H3 Audio VAE"}),
                "pdd_file": (pdd_files, {"default": pdd_files[0], "tooltip": "PDD 8-Step Acceleration LoRA file"}),
                "upscaler_model": (upscaler_files, {"default": upscaler_files[0], "tooltip": "Minimax H3 3D Latent Upscaler weights"}),
                "run_mode": (["clip_by_clip", "full_batch"], {"default": "clip_by_clip", "tooltip": "clip_by_clip renders 1 clip then pauses for validation; full_batch renders all pending clips"}),
                "pass1_resolution": (
                    ["608x352 (16:9)", "352x608 (9:16)", "512x512 (1:1)", "704x384", "896x576",
                     "1056x608 (16:9)", "608x1056 (9:16)"],
                    {"default": "608x352 (16:9)", "tooltip": "Stage 1 (Pass 1) draft generation resolution"},
                ),
                "pass2_resolution": (
                    ["1056x608 (16:9)", "608x1056 (9:16)",
                     "1280x720", "720x1280 (9:16)",
                     "1344x768 (16:9)", "768x1344 (9:16)",
                     "1920x1088 (16:9)", "1088x1920 (9:16)",
                     "1024x1024 (1:1)"],
                    {"default": "1344x768 (16:9)", "tooltip": "Stage 2 (Pass 2) target resolution. 1920x1088 is 1080p on H3's 32-px grid; it needs ~2x the VRAM of 1344x768, so keep clips shorter (~5-8 s) at 1080p on a 32 GB card."},
                ),
                "pass2_denoise": ("FLOAT", {"default": 0.25, "min": 0.05, "max": 1.0, "step": 0.01, "tooltip": "PDD Quality Tail refinement denoise factor (trained at 0.25)"}),
                "pdd_nfe": (["8", "4", "6", "5", "10", "12", "16", "20"], {"default": "8", "tooltip": "Sampling steps. PDD mode: model evaluations, only 4 / 6 / 8 are valid (8 = full trained quality). Turbo LoRA mode: the turbo step count (e.g. 4-6 for a 4-step LoRA, 8 for an 8-step one)."}),
                "context_length": (["22", "5", "39", "56"], {"default": "22", "tooltip": "Number of video motion context frames passed to subsequent clips"}),
                "audio_context_length": ("INT", {"default": 0, "min": 0, "max": 240, "step": 1, "tooltip": "Audio context frames (0 = auto-match video context)"}),
                "identity_continuity": ("BOOLEAN", {"default": True, "tooltip": "Use an empty picture slot for the previous clip's last frame. With all nine pictures attached, motion continuity still applies but no extra guide is inserted."}),
                "smart_offload": ("BOOLEAN", {"default": True, "tooltip": "Offload upscaler from VRAM immediately after inference to conserve GPU memory"}),
                "clips_json": ("STRING", {"default": json.dumps(_default_clips(), indent=2), "multiline": True}),
                "refs_json": ("STRING", {"default": json.dumps(_default_refs(), indent=2), "multiline": True}),
            },
            "optional": {
                "ref_image_1": ("IMAGE",),
                "ref_image_2": ("IMAGE",),
                "ref_image_3": ("IMAGE",),
                "ref_image_4": ("IMAGE",),
                "ref_image_5": ("IMAGE",),
                "ref_image_6": ("IMAGE",),
                "ref_image_7": ("IMAGE",),
                "ref_image_8": ("IMAGE",),
                "ref_image_9": ("IMAGE",),
                "attention_backend": (["comfy kitchen attention", "sage attention 2.2", "pytorch attention"], {"default": "comfy kitchen attention", "tooltip": "Attention backend for both sampling passes. Sage uses the installed SageAttention package. Validated clips remain cached."}),
                # --- Block-sparse attention (core BlockSparseAttention, ComfyUI >= 0.35) ---
                "sla_enabled": ("BOOLEAN", {"default": False, "tooltip": "Block-sparse attention on both passes via core's BlockSparseAttention node (ComfyUI >= 0.35). The dense backend above stays the fall-through. Roughly halves pass-2 step time on long clips."}),
                "sla_sparsity": ("FLOAT", {"default": 0.9, "min": 0.0, "max": 0.95, "step": 0.05, "tooltip": "Fraction of key blocks skipped for the sla / vsa methods (0.9 = keep 10%). 0.9 is the validated fast setting; below ~0.6 sparse attention is slower than dense. Ignored by sol-attn (uses tau)."}),
                # --- Pass-2 temporal windows + background decode ---
                "pass2_chunk_frames": ("INT", {"default": 124, "min": 0, "max": 3600, "step": 1, "tooltip": "Refine pass 2 in overlapping temporal windows of this many frames (snapped to H3's 17k+5 grid) via MMH3SplitUpscale, so long/HD clips never outgrow VRAM. 124 = 5 s windows. 0 = refine the whole clip in one pass (original behaviour). Clips at or below the window size are unaffected."}),
                "pass2_chunk_overlap": ("INT", {"default": 22, "min": 0, "max": 240, "step": 1, "tooltip": "Overlap between pass-2 windows, in frames."}),
                "async_decode": (["off", "auto", "on"], {"default": "off", "tooltip": "EXPERIMENTAL, full_batch only: decode/cache the finished clip in a background thread while the next clip encodes and drafts; the identity guide frame is taken from the latent tail so the next clip never waits. Not available with dynamic VRAM (comfy-aimdo cannot stream weights from two threads) and unsafe if the decode triggers model eviction, so it defaults to off. auto = on only when the decode is small enough to sit beside the resident UNet."}),
                "sparse_method": (["sla", "sol-attn", "vsa"], {"default": "sla", "tooltip": "Selection method for core BlockSparseAttention when sla_enabled is on. sla: keep a fixed top-k percent of key blocks (1 - sla_sparsity). sol-attn: training-free adaptive threshold per head/query block (tau), the choice for models without an SLA-distilled LoRA such as PDD. vsa: FastVideo cube attention, only with FastH3-VSA weights."}),
                "sparse_tau": ("FLOAT", {"default": 1.3, "min": 0.0, "max": 4.0, "step": 0.05, "tooltip": "sol-attn threshold in score sigmas. Higher = sparser: 1.0 keeps ~16% of key blocks, 1.5 ~7%, 2.0 ~2.7%."}),
                # --- Acceleration: PDD (default) or any turbo / lightning LoRA ---
                "accel_mode": (["PDD 8-step", "Turbo LoRA"], {"default": "PDD 8-step", "tooltip": "PDD 8-step: the official Parallel Decoding Distillation LoRA + head bank (needs ComfyUI-MiniMax-H3-PDD-Acc). Turbo LoRA: a plain step-distilled LoRA (turbo / lightning / lightx2v) with a regular scheduler; 'steps' above becomes the turbo step count."}),
                "turbo_lora": (["none"] + folder_paths.get_filename_list("loras"), {"default": "none", "tooltip": "Turbo LoRA file (models/loras). Used only in Turbo LoRA mode."}),
                "turbo_lora_strength": ("FLOAT", {"default": 1.0, "min": -10.0, "max": 10.0, "step": 0.01, "tooltip": "Turbo LoRA strength."}),
                "turbo_sampler": (comfy.samplers.KSampler.SAMPLERS, {"default": "res_multistep", "tooltip": "Sampler for Turbo LoRA mode (PDD mode always uses euler)."}),
                "turbo_scheduler": (comfy.samplers.KSampler.SCHEDULERS, {"default": "simple", "tooltip": "Scheduler for Turbo LoRA mode. Pass 2 runs the last round(steps x pass2_denoise) steps of this schedule."}),
                # --- Refine pass (pass 2) LoRA: a different LoRA for the high-res tail ---
                "pass2_lora": (["none"] + folder_paths.get_filename_list("loras"), {"default": "none", "tooltip": "LoRA applied only on the pass-2 refine tail. 'none' keeps the pass-1 model."}),
                "pass2_lora_strength": ("FLOAT", {"default": 1.0, "min": -10.0, "max": 10.0, "step": 0.01, "tooltip": "Strength of the pass-2 LoRA."}),
                "pass2_lora_mode": (["stack on engine LoRA", "replace engine LoRA"], {"default": "stack on engine LoRA", "tooltip": "stack: pass-2 LoRA on top of the PDD heads / turbo LoRA. replace: pass 2 samples base model + pass-2 LoRA only (use for step-distilled LoRAs, e.g. a 3-step turbo)."}),
                "pass2_steps": ("INT", {"default": 0, "min": 0, "max": 50, "step": 1, "tooltip": "Full schedule length pass 2's tail is cut from when a pass-2 LoRA is set (tail = round(steps x pass2_denoise)). 0 = same as the engine steps."}),
                # --- Semantic bridge (BUNNY H3 Conditioning Bridge, optional dependency) ---
                "semantic_bridge": (["none"] + _semantic_bridge_adapters(), {"default": "none", "tooltip": "BUNNY H3 Conditioning Bridge adapter applied to the text conditioning of both passes (needs the BUNNY_H3_Conditioning_Bridge custom node). Improves who-does-what-to-whom, object ownership and state continuity in complex multi-character action. none = off."}),
                "semantic_bridge_alpha": ("FLOAT", {"default": 0.12, "min": 0.0, "max": 1.0, "step": 0.01, "tooltip": "Residual strength of the semantic bridge. 0.10-0.15 recommended by the author; higher is not better."}),
                "semantic_bridge_match": (["per_token", "global", "none"], {"default": "per_token", "tooltip": "How the bridge output is rescaled to the original conditioning magnitude before blending. per_token is the recommended setting."}),
                # --- External prompt inputs: wire a STRING into a clip instead of typing it ---
                "clip_prompt_1": ("STRING", {"forceInput": True, "multiline": True, "tooltip": "Optional: feed Clip 1's prompt from another node (a prompter, a text box). When connected and non-empty it replaces the prompt typed in the panel for that clip."}),
                "clip_prompt_2": ("STRING", {"forceInput": True, "multiline": True, "tooltip": "Optional: feed Clip 2's prompt from another node (a prompter, a text box). When connected and non-empty it replaces the prompt typed in the panel for that clip."}),
                "clip_prompt_3": ("STRING", {"forceInput": True, "multiline": True, "tooltip": "Optional: feed Clip 3's prompt from another node (a prompter, a text box). When connected and non-empty it replaces the prompt typed in the panel for that clip."}),
                "clip_prompt_4": ("STRING", {"forceInput": True, "multiline": True, "tooltip": "Optional: feed Clip 4's prompt from another node (a prompter, a text box). When connected and non-empty it replaces the prompt typed in the panel for that clip."}),
                # --- Built-in prompt rewriter (MiniMax-H3-Prompt-Rewriter-ComfyUI, optional dependency).
                #     Appended last so saved workflows keep their widget order; 'off' = old behaviour.
                "rewrite_mode": (prompt_rewriter.MODES, {"default": "off", "tooltip": "Rewrite the clip prompts into the MiniMax-H3 format at the start of the run, on a local GGUF via llama.cpp (needs the MiniMax-H3-Prompt-Rewriter-ComfyUI pack). 'pending clips' rewrites only clips not rewritten yet (new or restored to raw); 'all clips' rewrites every clip from its raw text again. Reference pictures are described once and cached."}),
                "rewrite_task": (prompt_rewriter.TASKS, {"default": "auto", "tooltip": "auto: Ref2VA (six sections, references described and labelled <Picture N> in slot order) when reference pictures are connected, otherwise T2VA."}),
                "rewrite_writer_model": (prompt_rewriter.writer_choices(), {"tooltip": "GGUF that writes the prompt (the rewriter pack's writer list). Pick the same file as the caption model to run captions and writing on one server, which is also what enables thinking."}),
                "rewrite_caption_model": (prompt_rewriter.captioner_choices(), {"tooltip": "Multimodal GGUF + mmproj that describes the reference pictures (the rewriter pack's captioner list). Must be on disk already."}),
                "rewrite_caption_length": (prompt_rewriter.CAPTION_LENGTHS, {"default": "standard"}),
                "rewrite_greedy": ("BOOLEAN", {"default": True, "tooltip": "Deterministic decoding for the writer. Off samples at rewrite_temperature."}),
                "rewrite_temperature": ("FLOAT", {"default": 0.7, "min": 0.0, "max": 2.0, "step": 0.01}),
                "rewrite_max_new_tokens": ("INT", {"default": 4096, "min": 256, "max": 16384, "step": 64, "tooltip": "Output budget per clip prompt. The context is sized from the guide plus this automatically."}),
                "rewrite_seed": ("INT", {"default": 42, "min": 0, "max": 2147483647}),
                "rewrite_thinking": ("BOOLEAN", {"default": False, "tooltip": "Let a thinking model (Qwen3.x, Swift) deliberate before writing each prompt. Writer only; captions never think. Needs writer and caption model to be the same GGUF."}),
                "rewrite_reasoning_budget": ("INT", {"default": 4096, "min": -1, "max": 32768, "step": 64, "tooltip": "llama.cpp --reasoning-budget: -1 unrestricted, N tokens of thinking at most (added on top of rewrite_max_new_tokens)."}),
                "rewrite_reasoning_budget_message": ("STRING", {"default": "", "multiline": True, "tooltip": "llama.cpp --reasoning-budget-message: injected when the thinking budget runs out, e.g. 'Time is up, write the answer now.'"}),
                "rewrite_parallel": ("INT", {"default": 3, "min": 1, "max": 8, "tooltip": "How many captions, and how many clip prompts, are generated at the same time on the server (one slot each; the KV pool grows with it)."}),
                "rewrite_system_prompt": ("STRING", {"default": "", "multiline": True, "tooltip": "Replace MiniMax's writing guide with your own system prompt (the H3 format lives in that text). Empty = the official guide for the task. The rewrite_system_prompt_in socket overrides this while connected."}),
                "rewrite_system_prompt_in": ("STRING", {"forceInput": True, "multiline": True, "tooltip": "Optional: the rewriter's system prompt from another node. Overrides rewrite_system_prompt while connected and non-empty."}),
                # --- Video / audio references (core MiniMaxH3ReferenceToVideo: <Video k>, <Audio j> after the pictures) ---
                "ref_video_1": ("IMAGE,VIDEO", {"tooltip": "Reference video 1: a Load Video output directly (frames are resampled to 24 fps and its soundtrack is used unless ref_video_audio_1 is wired), or an IMAGE frame batch at 24 fps (2-15 s). Labelled <Video 1> in the prompt; the rewriter describes it from sampled frames."}),
                "ref_video_2": ("IMAGE,VIDEO", {"tooltip": "Reference video 2 (VIDEO or 24 fps frames). <Video 2>."}),
                "ref_video_3": ("IMAGE,VIDEO", {"tooltip": "Reference video 3 (VIDEO or 24 fps frames). <Video 3>."}),
                "ref_video_audio_1": ("AUDIO", {"tooltip": "Soundtrack of reference video 1. Gets its own <Audio j> label, emitted right before <Video 1>."}),
                "ref_video_audio_2": ("AUDIO", {"tooltip": "Soundtrack of reference video 2."}),
                "ref_video_audio_3": ("AUDIO", {"tooltip": "Soundtrack of reference video 3."}),
                "ref_audio_1": ("AUDIO", {"tooltip": "Standalone reference audio (a voice or sound to reuse). <Audio j>, numbered after the video soundtracks."}),
                "ref_audio_2": ("AUDIO", {"tooltip": "Standalone reference audio 2."}),
                "ref_audio_3": ("AUDIO", {"tooltip": "Standalone reference audio 3."}),
                "rewrite_previous_clips": (prompt_rewriter.CONTINUITY, {"default": "raw asks", "tooltip": "What the writer is told about the earlier clips when it writes clip N: 'raw asks' puts clips 1..N-1 as you typed them into the task message (previous_clips), so clip N continues where N-1 ends. Editing an earlier clip's ask re-invalidates the later clips."}),
            },
            "hidden": {
                "unique_id": "UNIQUE_ID",
                "prompt": "PROMPT",
                "extra_pnginfo": "EXTRA_PNGINFO",
            },
        }

    RETURN_TYPES = (CACHE_TYPE, "INT", "INT", "STRING", "IMAGE")
    RETURN_NAMES = ("cache", "clip_count", "validated_count", "status", "last_frame")
    FUNCTION = "extend"
    CATEGORY = "MiniMax H3 Master"
    OUTPUT_NODE = False

    @classmethod
    def IS_CHANGED(cls, **kwargs):
        return float("nan")

    def extend(
        self,
        model,
        clip,
        vae,
        audio_vae,
        pdd_file,
        upscaler_model,
        run_mode,
        pass1_resolution,
        pass2_resolution,
        pass2_denoise,
        pdd_nfe,
        context_length,
        audio_context_length,
        identity_continuity,
        smart_offload,
        clips_json,
        refs_json,
        unique_id=None,
        prompt=None,
        extra_pnginfo=None,
        attention_backend="comfy kitchen attention",
        accel_mode="PDD 8-step",
        turbo_lora="none",
        turbo_lora_strength=1.0,
        turbo_sampler="res_multistep",
        turbo_scheduler="simple",
        sla_enabled=False,
        sla_sparsity=0.9,
        pass2_chunk_frames=124,
        pass2_chunk_overlap=22,
        async_decode="off",
        sparse_method="sla",
        sparse_tau=1.3,
        **kwargs,
    ):
        owner = str(unique_id if unique_id is not None else "master_extender")
        export_profile = None
        for config in (prompt or {}).values():
            if config.get("class_type") != "MiniMaxH3MasterFinalDecode":
                continue
            inputs = config.get("inputs", {})
            if inputs.get("cache") != [owner, 0]:
                continue
            profile = {key: inputs.get(key, default) for key, default in
                       (("codec", "H.264"), ("crf", 17), ("preset", "fast"))}
            if not any(isinstance(value, list) for value in profile.values()):
                export_profile = profile
            break

        # Parse clips configuration
        clips = json.loads(clips_json) if isinstance(clips_json, str) else clips_json
        if not isinstance(clips, list) or not clips:
            raise ValueError("Add a clip and enter its prompt before running this project.")

        # External prompt inputs override the panel text for that clip. A changed
        # prompt invalidates the clip so a validated clip is not reused with stale text.
        for index in range(1, 4 + 1):
            external = kwargs.get(f"clip_prompt_{index}")
            if not isinstance(external, str) or not external.strip() or index - 1 >= len(clips):
                continue
            clip_cfg = clips[index - 1]
            if not isinstance(clip_cfg, dict):
                continue
            if clip_cfg.get("prompt", "") != external:
                clip_cfg["prompt"] = external
                clip_cfg["validated"] = False
                clip_cfg["prompt_source"] = f"clip_prompt_{index}"
                # New text from the socket is raw again as far as the rewriter is concerned.
                clip_cfg["prompt_rewritten"] = False
                clip_cfg.pop("prompt_raw", None)
                clip_cfg.pop("rewrite_meta", None)

        # Parse resolution settings
        w1, h1 = parse_resolution(pass1_resolution, 608, 352)
        w2, h2 = parse_resolution(pass2_resolution, 1344, 768)
        # H3's 2x2 latent patch grid requires pixel dimensions divisible by 32.
        w2, h2 = ((w2 + 31) // 32) * 32, ((h2 + 31) // 32) * 32

        # Collect reference images (up to 9 slots)
        refs = load_reference_images(refs_json)
        for idx in range(1, 10):
            ref_k = f"ref_image_{idx}"
            if f"ref_image_{idx - 1}" not in refs and ref_k in kwargs and kwargs[ref_k] is not None:
                refs[f"ref_image_{idx - 1}"] = kwargs[ref_k]
        # Slot order is <Picture i> order for the text encoder and the rewriter alike.
        refs = dict(sorted(refs.items(), key=lambda item: int(item[0].rsplit("_", 1)[1])))

        # Video / audio references (sockets only): ref_video_N -> <Video k>, soundtracks and
        # standalone audio -> <Audio j>. Keys are 0-based like the pictures, so the core
        # node pairs ref_video_audio_N with ref_video_N.
        def _socket_refs(prefix, count):
            found = {}
            for idx in range(1, count + 1):
                value = kwargs.get(f"{prefix}_{idx}")
                if value is not None:
                    found[f"{prefix}_{idx - 1}"] = value
            return found
        ref_videos = _socket_refs("ref_video", 3)
        ref_video_audios = _socket_refs("ref_video_audio", 3)
        ref_audios = _socket_refs("ref_audio", 3)
        # A VIDEO object straight from Load Video: take its frames (resampled to H3's
        # 24 fps) and, unless a soundtrack socket is wired for it, its own audio.
        for key, value in list(ref_videos.items()):
            if not hasattr(value, "get_components"):
                continue
            comps = value.get_components()
            frames = comps.images
            fps = float(comps.frame_rate) if comps.frame_rate else 24.0
            count = int(frames.shape[0])
            if fps > 0 and abs(fps - 24.0) > 0.25 and count > 1:
                wanted = max(1, int(round(count * 24.0 / fps)))
                index = torch.clamp((torch.arange(wanted, dtype=torch.float64) * (fps / 24.0)).round().long(), 0, count - 1)
                frames = frames[index]
            ref_videos[key] = frames
            audio_key = key.replace("ref_video_", "ref_video_audio_")
            if audio_key not in ref_video_audios and getattr(comps, "audio", None) is not None:
                ref_video_audios[audio_key] = comps.audio
            _LOG.info("%s: VIDEO input -> %d frames at %.3g fps resampled to %d frames at 24 fps%s",
                      key, count, fps, int(frames.shape[0]), ", soundtrack taken from the video" if audio_key in ref_video_audios else "")
        for key in list(ref_video_audios):
            if key.replace("ref_video_audio_", "ref_video_") not in ref_videos:
                _LOG.warning("%s has no matching video; ignored (a standalone sound goes on ref_audio_N)", key)
                ref_video_audios.pop(key)
        if ref_videos or ref_audios:
            _LOG.info("References: %d picture(s), %d video(s) (%d with soundtrack), %d audio",
                      len(refs), len(ref_videos), len(ref_video_audios), len(ref_audios))

        # Built-in prompt rewriter: pending clip prompts become H3 descriptions
        # before anything is rendered; the panel gets the result back.
        rewrite_notes = []
        if str(kwargs.get("rewrite_mode", "off")) != "off":
            def rewrite_progress(stage, message, pct):
                _send_progress(owner, 0, len(clips), stage, message, pct)
            def rewrite_stream(index, clip_id, phase, text):
                _send_rewrite(owner, index, clip_id, phase, text)
            rewrite_notes = prompt_rewriter.rewrite_clips(
                clips, refs, kwargs, aspect_text=str(pass2_resolution),
                progress_cb=rewrite_progress, stream_cb=rewrite_stream,
                videos=ref_videos, video_audios=ref_video_audios, audios=ref_audios,
            )
            for note in rewrite_notes:
                _LOG.info("Rewriter: %s", note)
            _send_clips(owner, clips, fields=["prompt", "prompt_raw", "prompt_rewritten", "rewrite_text", "rewrite_meta", "validated"])

        # Setup persistent disk caching
        chain_key = _chain_key(clips)
        cache_owner = f"master_v2_{chain_key}"
        draft_owner = f"{cache_owner}_draft"
        _LOG.info(f"Disk cache chain: {cache_owner} (keyed by clip 1's prompt, duration and LoRAs)")
        data_path, manifest_path, manifest = _manifest_for_first(cache_owner, FPS)
        draft_path, draft_manifest_path, draft_manifest = _manifest_for_first(draft_owner, FPS)
        settings = [pass1_resolution, pass2_resolution, pass2_denoise, pdd_nfe,
                    pdd_file, upscaler_model, context_length, audio_context_length,
                    identity_continuity, refs_json,
                    bool(sla_enabled), float(sla_sparsity), str(sparse_method), float(sparse_tau),
                    int(pass2_chunk_frames), int(pass2_chunk_overlap),
                    accel_mode, turbo_lora, float(turbo_lora_strength), turbo_sampler, turbo_scheduler,
                    str(kwargs.get("pass2_lora", "none")), float(kwargs.get("pass2_lora_strength", 1.0)),
                    str(kwargs.get("pass2_lora_mode", "stack on engine LoRA")), int(kwargs.get("pass2_steps", 0)),
                    str(kwargs.get("semantic_bridge", "none")), float(kwargs.get("semantic_bridge_alpha", 0.12)),
                    str(kwargs.get("semantic_bridge_match", "per_token"))]
        signature = hashlib.sha256(json.dumps(settings, sort_keys=True).encode()).hexdigest()
        for dp, mp, state in ((data_path, manifest_path, manifest),
                               (draft_path, draft_manifest_path, draft_manifest)):
            if state.get("master_signature") != signature:
                state = _truncate_chain(dp, mp, state, 0)
                state["master_signature"] = signature
                _write_json_atomic(mp, state)
        manifest = _load_manifest_from_paths(data_path, manifest_path)
        draft_manifest = _load_manifest_from_paths(draft_path, draft_manifest_path)
        # Recover interrupted paired writes and removed clips together.
        common = min(len(manifest["segments"]), len(draft_manifest["segments"]), len(clips))
        for dp, mp, state in ((data_path, manifest_path, manifest),
                               (draft_path, draft_manifest_path, draft_manifest)):
            if len(state["segments"]) > common:
                _truncate_chain(dp, mp, state, common)
        manifest = _load_manifest_from_paths(data_path, manifest_path)

        # If clips were removed in the UI, truncate disk cache
        if len(manifest.get("segments", [])) > len(clips):
            manifest = _truncate_chain(data_path, manifest_path, manifest, len(clips))

        disk_join = MiniMaxH3MotionContextDiskJoin()

        # Background decode of the previous clip (full_batch only). The manifest
        # is shared, so anything that writes it -- the next clip's disk join,
        # a validated-clip reuse -- must wait for the worker first, and the
        # engine waits before any large sampling pass.
        background = {"worker": None}

        def _finish_background():
            worker = background["worker"]
            if worker is None:
                return None
            background["worker"] = None
            return worker.wait()

        # Instantiate Pure PDD Engine
        engine = PurePDDEngine(
            model=model,
            clip=clip,
            vae=vae,
            audio_vae=audio_vae,
            pdd_file=pdd_file,
            upscaler_model=upscaler_model,
            pdd_nfe=pdd_nfe,
            shift_video=12.0,
            shift_audio=3.0,
            attention_backend=attention_backend,
            smart_offload=smart_offload,
            accel_mode=accel_mode,
            turbo_lora=turbo_lora,
            turbo_lora_strength=turbo_lora_strength,
            sampler_name=turbo_sampler,
            scheduler_name=turbo_scheduler,
            sla_enabled=sla_enabled,
            sla_sparsity=sla_sparsity,
            pass2_chunk_frames=pass2_chunk_frames,
            pass2_chunk_overlap=pass2_chunk_overlap,
            sparse_method=sparse_method,
            sparse_tau=sparse_tau,
            background_busy=lambda: background["worker"] is not None and background["worker"].busy(),
            wait_background=lambda: _finish_background(),
        )
        engine.configure_pass2_lora(
            kwargs.get("pass2_lora", "none"),
            kwargs.get("pass2_lora_strength", 1.0),
            kwargs.get("pass2_lora_mode", "stack on engine LoRA"),
            kwargs.get("pass2_steps", 0),
        )
        engine.configure_semantic_bridge(
            kwargs.get("semantic_bridge", "none"),
            kwargs.get("semantic_bridge_alpha", 0.12),
            kwargs.get("semantic_bridge_match", "per_token"),
        )

        previous_handle = None
        previous_proxy = None
        draft_handle = None
        previous_draft = None
        last_frame_tensor = torch.zeros([1, h2, w2, 3], dtype=torch.float32)
        rendered_count = 0
        validated_count = 0

        _LOG.info(
            f"MiniMax H3 Master Extender starting: {len(clips)} total clips, mode={run_mode}"
        )

        fingerprints = {}
        previous_fp = None
        unvalidated_any = False
        for i, clip_cfg in enumerate(clips):
            current_manifest = _load_manifest_from_paths(data_path, manifest_path)
            existing_count = len(current_manifest.get("segments", [])) if current_manifest else 0
            is_on_disk = i < existing_count
            is_validated = str(clip_cfg.get("validated", False)).lower() == "true"

            # A validated clip is only reused when the cached clip was rendered
            # from the same inputs (prompt, duration, LoRAs, seed and every
            # earlier clip). Clips cached before fingerprints existed pass.
            if is_validated and is_on_disk:
                try:
                    expected_fp = _clip_fingerprint(previous_fp, clip_cfg, clip_cfg.get("seed", 42))
                except (TypeError, ValueError):
                    expected_fp = None
                stored = _stored_fingerprints(data_path, manifest_path)
                stored_fp = stored[i] if i < len(stored) else None
                if expected_fp and stored_fp and stored_fp != expected_fp:
                    _LOG.warning(
                        f"Clip {i + 1}: marked validated, but the cached clip was rendered from "
                        f"different inputs (prompt, seed, duration, LoRAs or an earlier clip changed) - re-rendering."
                    )
                    clip_cfg["validated"] = False
                    is_validated = False
                    unvalidated_any = True
                elif expected_fp:
                    fingerprints[i] = expected_fp
                    previous_fp = expected_fp

            # 1. Reuse existing validated clip from disk cache
            if is_validated:
                _finish_background()
                if not is_on_disk:
                    _LOG.warning(f"Clip {i + 1} marked validated but not on disk; will re-render.")
                    clip_cfg["validated"] = False
                else:
                    _LOG.info(f"Clip {i + 1}: Validated - reusing disk cache")
                    result = disk_join.join(
                        samples=None,
                        trim_frames=None,
                        validated=True,
                        run_mode=str(run_mode),
                        fps=float(FPS),
                        previous_cache=previous_handle,
                        unique_id=cache_owner,
                    )
                    previous_handle = result[0]
                    previous_proxy = result[1]
                    draft_result = disk_join.join(
                        samples=None, validated=True, run_mode=str(run_mode),
                        fps=float(FPS), previous_cache=draft_handle, unique_id=draft_owner,
                    )
                    draft_handle, previous_draft = draft_result[:2]
                    if identity_continuity:
                        state = _load_manifest_from_paths(data_path, manifest_path)
                        last_frame_tensor = _load_guide_frame(data_path, state["segments"][i])
                        if last_frame_tensor is None:
                            # One-time upgrade for clips saved before guide caching.
                            decoded, _ = _render_one_final_video_segment(
                                data_path, state["segments"], i, vae,
                            )
                            _cache_guide_frame(data_path, manifest_path, state, i, decoded)
                            last_frame_tensor = decoded[-1:].clone()
                            del decoded
                    validated_count += 1
                    continue

            # 2. Check if we should render this clip
            # Drop both suffixes before starting so a failed replacement cannot
            # leave a new draft paired with an old final checkpoint.
            for dp, mp in ((data_path, manifest_path), (draft_path, draft_manifest_path)):
                state = _load_manifest_from_paths(dp, mp)
                if len(state["segments"]) > i:
                    _truncate_chain(dp, mp, state, i)
            _LOG.info(f"Rendering Clip {i + 1}/{len(clips)}: '{clip_cfg.get('prompt', '')[:60]}...'")

            def progress_hook(stage, msg, pct):
                _send_progress(owner, i, len(clips), stage, msg, pct)

            # Resolve seed based on seed_mode
            seed_val = int(clip_cfg.get("seed", 42))
            seed_mode = str(clip_cfg.get("seed_mode", "fixed")).lower()
            if seed_mode == "randomize":
                seed_val = secrets.randbelow(10**14)
                clip_cfg["seed"] = seed_val
            elif seed_mode == "increment":
                seed_val = seed_val + 1
                clip_cfg["seed"] = seed_val
            elif seed_mode == "decrement":
                seed_val = max(0, seed_val - 1)
                clip_cfg["seed"] = seed_val
            clip_fp = _clip_fingerprint(previous_fp, clip_cfg, seed_val)

            # Render clip through Pure 2-Stage PDD Engine
            sampled_latent, _ = engine.render_clip(
                clip_index=i,
                prompt=clip_cfg.get("prompt", ""),
                duration_sec=float(clip_cfg.get("duration", 15)),
                seed=seed_val,
                pass1_res=(w1, h1),
                pass2_res=(w2, h2),
                pass2_denoise=float(pass2_denoise),
                ref_images=refs,
                previous_latent=previous_proxy,
                previous_draft=previous_draft,
                context_length=str(context_length),
                audio_context_length=int(audio_context_length),
                last_frame_guide=last_frame_tensor if (identity_continuity and i > 0) else None,
                progress_cb=progress_hook,
                ref_videos=ref_videos,
                ref_video_audios=ref_video_audios,
                ref_audios=ref_audios,
            )

            # Save clip to disk cache (the manifest is shared with a running
            # background decode, so that must be finished first).
            _finish_background()
            trim_frames = engine.last_trim_frames
            draft_result = disk_join.join(
                samples=engine.last_draft, trim_frames=trim_frames, validated=False,
                run_mode=str(run_mode), fps=float(FPS), previous_cache=draft_handle,
                unique_id=draft_owner, computed=(str(run_mode) == "full_batch"),
            )
            draft_handle, previous_draft = draft_result[:2]
            engine.last_draft = None
            join_result = disk_join.join(
                samples=sampled_latent,
                trim_frames=trim_frames,
                validated=False,
                run_mode=str(run_mode),
                fps=float(FPS),
                previous_cache=previous_handle,
                unique_id=cache_owner,
                computed=(str(run_mode) == "full_batch"),
            )
            previous_handle = join_result[0]
            previous_proxy = join_result[1]
            fingerprints = {k: v for k, v in fingerprints.items() if k < i}
            fingerprints[i] = clip_fp
            previous_fp = clip_fp
            _store_fingerprints(data_path, manifest_path, fingerprints)
            progress_hook("decode", f"Clip {i + 1} - Decoding and caching preview...", 0.9)
            more_clips_pending = any(
                not bool(c.get("validated", False)) for c in clips[i + 1:]
            )
            go_async = (
                str(run_mode) == "full_batch" and more_clips_pending
                and _async_decode_allowed(async_decode, vae, sampled_latent)
            )
            if go_async:
                # The next clip only needs the last frame as its identity guide;
                # take it from the latent tail now and decode the rest while
                # the next clip encodes and drafts.
                video_latent = _streams_from_latent(sampled_latent, "samples")[0]
                last_frame_tensor = decode_guide_frame(vae, video_latent)
                del video_latent
                background["worker"] = _DecodeWorker(
                    lambda idx=i: cache_full_batch_ref2va_segment(
                        data_path, manifest_path, idx, vae, audio_vae, FPS,
                        export_profile=export_profile,
                    ),
                    label=f"clip {i + 1}",
                )
                progress_hook("done", f"Clip {i + 1} sampled; decoding in background", 1.0)
            else:
                motion_context_disk.DECODE_ALLOW_RECLAIM = True
                state, _ = cache_full_batch_ref2va_segment(
                    data_path, manifest_path, i, vae, audio_vae, FPS,
                    export_profile=export_profile,
                )
                last_frame_tensor = _load_guide_frame(data_path, state["segments"][i])
                progress_hook("done", f"Clip {i + 1} completed!", 1.0)
            rendered_count += 1

            # In clip_by_clip mode: stop after rendering the first pending clip so user can validate!
            if str(run_mode) == "clip_by_clip":
                _LOG.info(f"Clip-by-clip mode: paused after rendering Clip {i + 1} for user validation.")
                break

        _finish_background()
        # Re-apply after any background decode rewrote the manifest.
        _store_fingerprints(data_path, manifest_path, fingerprints)
        status_msg = f"Completed {rendered_count} clip(s). Validated: {validated_count}/{len(clips)}"
        if rewrite_notes:
            status_msg += " | " + "; ".join(rewrite_notes)
        _send_clips(owner, clips, fields=["seed", "validated"] if unvalidated_any else ["seed"], chain=chain_key)
        return (
            previous_handle,
            len(clips),
            validated_count,
            status_msg,
            last_frame_tensor,
        )


NODE_CLASS_MAPPINGS = {
    "MiniMaxH3MasterExtender": MiniMaxH3MasterExtender,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "MiniMaxH3MasterExtender": "MiniMax H3 Master Extender",
}
