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
import time
from pathlib import Path
import torch
from server import PromptServer

import folder_paths
import nodes
from .master_projects import load_reference_images

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
)
from .pdd_pure_engine import (
    PurePDDEngine,
    parse_resolution,
    duration_to_h3_frames,
)

_LOG = logging.getLogger("minimax_h3_master_extender")
EVENT_PROGRESS = "master_extender_progress"


def _default_clips():
    return [
        {
            "id": 0,
            "title": "Clip 1",
            "prompt": "",
            "duration": 5.1,
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


def _send_progress(owner, clip_index, total_clips, stage, message, pct=0.0):
    """Send real-time progress update to ComfyUI frontend."""
    try:
        PromptServer.instance.send_sync(
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
                    ["608x352 (16:9)", "352x608 (9:16)", "512x512 (1:1)", "704x384", "896x576"],
                    {"default": "608x352 (16:9)", "tooltip": "Stage 1 (Pass 1) draft generation resolution"},
                ),
                "pass2_resolution": (
                    ["1344x768 (16:9)", "768x1344 (9:16)", "1024x1024 (1:1)", "1280x720"],
                    {"default": "1344x768 (16:9)", "tooltip": "Stage 2 (Pass 2) target high-definition resolution"},
                ),
                "pass2_denoise": ("FLOAT", {"default": 0.25, "min": 0.05, "max": 1.0, "step": 0.01, "tooltip": "PDD Quality Tail refinement denoise factor (trained at 0.25)"}),
                "pdd_nfe": (["8", "4", "6"], {"default": "8", "tooltip": "PDD model evaluations (steps). 8 = full trained quality"}),
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

        # Setup persistent disk caching
        cache_owner = f"master_v2_{owner}"
        draft_owner = f"{cache_owner}_draft"
        data_path, manifest_path, manifest = _manifest_for_first(cache_owner, FPS)
        draft_path, draft_manifest_path, draft_manifest = _manifest_for_first(draft_owner, FPS)
        settings = [pass1_resolution, pass2_resolution, pass2_denoise, pdd_nfe,
                    pdd_file, upscaler_model, context_length, audio_context_length,
                    identity_continuity, refs_json]
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

        for i, clip_cfg in enumerate(clips):
            current_manifest = _load_manifest_from_paths(data_path, manifest_path)
            existing_count = len(current_manifest.get("segments", [])) if current_manifest else 0
            is_on_disk = i < existing_count
            is_validated = bool(clip_cfg.get("validated", False))

            # 1. Reuse existing validated clip from disk cache
            if is_validated:
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

            # Render clip through Pure 2-Stage PDD Engine
            sampled_latent, _ = engine.render_clip(
                clip_index=i,
                prompt=clip_cfg.get("prompt", ""),
                duration_sec=float(clip_cfg.get("duration", 5.1)),
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
            )

            # Save clip to disk cache
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
            progress_hook("decode", f"Clip {i + 1} - Decoding and caching preview...", 0.9)
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

        status_msg = f"Completed {rendered_count} clip(s). Validated: {validated_count}/{len(clips)}"
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
