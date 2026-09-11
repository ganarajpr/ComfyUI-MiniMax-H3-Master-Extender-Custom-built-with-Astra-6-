"""
Pure 2-Stage 2-Pass MiniMax H3 PDD 8-Step + 3D Latent Upscaler Engine
====================================================================
Implements the exact engine pipeline from:
MiniMax_H3_REF2VA_PDD8_PURE 8 step (1)-1.json

Stage 1: Pass 1 Low-Res Draft Ref2VA PDD Generation (Euler + full 8-NFE PDD sigmas)
Stage 2: 3D Latent Upscaling (MinimaxH3LatentUpscaler3D) + Concat AV
Stage 3: Pass 2 High-Res Refinement via PDD Quality Tail (denoise 0.25)
"""

import inspect
import math
import logging
import os
import sys
import torch
import comfy.model_management
import comfy.sample
import comfy.samplers
import comfy.nested_tensor
import comfy.utils
from comfy.ldm.modules.attention import get_attention_function
import nodes
import node_helpers
from comfy_extras.nodes_minimax_h3 import (
    MiniMaxH3ReferenceToVideo,
    MiniMaxH3SigmaShift,
    _empty_av_latent,
)
from .motion_context_ram import (
    MiniMaxH3MotionContextRAM,
    _streams_from_latent,
)

_LOG = logging.getLogger("minimax_h3_master_extender.engine")


def parse_resolution(res_str: str, default_w: int, default_h: int):
    """Parse '1344x768 (16:9)' or '1344x768' into (w, h)."""
    if not res_str:
        return default_w, default_h
    try:
        core = res_str.split()[0]
        parts = core.split("x")
        if len(parts) == 2:
            return int(parts[0]), int(parts[1])
    except Exception:
        pass
    return default_w, default_h


def duration_to_h3_frames(duration_sec: float) -> int:
    """Convert duration in seconds to nearest valid H3 frame count (17k + 5)."""
    frames = max(5, int(round(float(duration_sec) * 24.0)))
    while frames % 17 != 5:
        frames += 1
    return frames


def _safe_get_output(obj, idx: int, key: str = None):
    """Safely extracts an output by index or key from tuple, list, dict, or io.NodeOutput."""
    if obj is None:
        return None
    if hasattr(obj, "__getitem__"):
        try:
            return obj[idx]
        except (KeyError, TypeError, IndexError):
            pass
    if hasattr(obj, "result"):
        try:
            return obj.result[idx]
        except Exception:
            pass
    if isinstance(obj, dict):
        if key and key in obj:
            return obj[key]
        vals = list(obj.values())
        if idx < len(vals):
            return vals[idx]
    if hasattr(obj, "as_dict"):
        try:
            d = obj.as_dict()
            if key and key in d:
                return d[key]
            vals = list(d.values())
            if idx < len(vals):
                return vals[idx]
        except Exception:
            pass
    return obj


class PurePDDEngine:
    def __init__(
        self,
        model,
        clip,
        vae,
        audio_vae,
        pdd_file="MiniMax-H3-Ref2VA-Acc-8Step.safetensors",
        upscaler_model="minimax_h3_latent_upscaler_3d_fp16.safetensors",
        pdd_nfe="8",
        pdd_lora_strength=1.0,
        pdd_head_strength=1.0,
        shift_video=12.0,
        shift_audio=3.0,
        attention_backend="comfy kitchen attention",
        smart_offload=True,
        sla_enabled=False,
        sla_sparsity=0.9,
    ):
        self.raw_model = model
        self.sla_enabled = bool(sla_enabled)
        self.sla_sparsity = float(sla_sparsity)
        self.clip = clip
        self.vae = vae
        self.audio_vae = audio_vae
        self.pdd_file = pdd_file
        self.upscaler_model = upscaler_model
        self.pdd_nfe = str(pdd_nfe)
        self.pdd_lora_strength = float(pdd_lora_strength)
        self.pdd_head_strength = float(pdd_head_strength)
        self.shift_video = float(shift_video)
        self.shift_audio = float(shift_audio)
        self.attention_backend = attention_backend
        self.smart_offload = smart_offload

        self.motion_ram = MiniMaxH3MotionContextRAM()
        self.prepared_model = None
        self.pass1_sigmas = None

    def initialize_pdd_model(self):
        """Prepare base model with SigmaShift, PDD Acc Apply, and Attention backend."""
        if self.prepared_model is not None:
            return self.prepared_model, self.pass1_sigmas

        _LOG.info(
            f"Initializing Pure PDD Engine: Shift ({self.shift_video}, {self.shift_audio}), "
            f"PDD LoRA: {self.pdd_file} ({self.pdd_nfe} NFE)"
        )

        # 1. Apply SigmaShift
        try:
            res_shift = MiniMaxH3SigmaShift.execute(
                self.raw_model,
                shift_video=self.shift_video,
                shift_audio=self.shift_audio,
            )
            shifted_model = res_shift[0] if hasattr(res_shift, "__getitem__") else getattr(res_shift, "result", [self.raw_model])[0]
        except Exception as e:
            _LOG.warning(f"Error applying MiniMaxH3SigmaShift: {e}")
            shifted_model = self.raw_model

        # 2. Apply PDD Acc LoRA
        pdd_apply_cls = nodes.NODE_CLASS_MAPPINGS.get("MiniMaxH3PDDAccApply")
        if pdd_apply_cls:
            pdd_node = pdd_apply_cls()
            pdd_model, sigmas_p1, info = pdd_node.apply(
                shifted_model,
                pdd_file=self.pdd_file,
                nfe=self.pdd_nfe,
                lora_strength=self.pdd_lora_strength,
                head_strength=self.pdd_head_strength,
                on_off_grid="error",
                enabled=True,
                partition_check="warn",
            )
        else:
            pdd_model = shifted_model
            # Fallback simple 8-step sigmas if node missing
            sigmas_p1 = torch.linspace(1.0, 0.0, int(self.pdd_nfe) + 1)

        attention_name = {
            "comfy kitchen attention": "comfy_kitchen_int8",
            "sage attention 2.2": "sage",
            "pytorch attention": "pytorch",
        }.get(self.attention_backend)
        if attention_name is None:
            raise ValueError(f"Unknown attention backend: {self.attention_backend}")
        attention_function = get_attention_function(attention_name, None)
        if attention_function is None:
            raise RuntimeError(
                f"Attention backend '{self.attention_backend}' is unavailable. "
                "Check its installation or select another attention backend."
            )
        pdd_model = pdd_model.clone()
        pdd_model.set_model_optimized_attention(attention_function)
        _LOG.info("PDD sampling attention: %s", self.attention_backend)

        # 3. Optional sparse attention (PlagueKind H3SLAAttention). It installs
        # the same transformer_options["optimized_attention_override"] hook as
        # the dense backend above, so it must come LAST or it is never invoked.
        # Its dense fall-through (short sequences, dense_last_steps) uses
        # ComfyUI's default attention, not the backend selected above.
        pdd_model = self._apply_sla(pdd_model)

        self.prepared_model = pdd_model
        self.pass1_sigmas = sigmas_p1
        return self.prepared_model, self.pass1_sigmas

    def _apply_sla(self, model):
        """Block-sparse attention (PlagueKind H3SLAAttention) for both passes.
        On long sequences SLA at 0.9 roughly halves the per-step time
        (measured 39 -> 22 s/step at 1344x768 / 362 frames)."""
        if not self.sla_enabled:
            return model
        sla_cls = nodes.NODE_CLASS_MAPPINGS.get("H3SLAAttention")
        if sla_cls is None:
            _LOG.warning("SLA requested but H3SLAAttention (ComfyUI-PlagueKind-Nodes) is not installed; skipping")
            return model
        try:
            res = sla_cls.execute(model, sparsity_ratio=self.sla_sparsity, block_size="64",
                                  min_seq_len=8192, dense_last_steps=0, protect_audio=True, enabled=True)
            out = _safe_get_output(res, 0, "model")
            if out is not None:
                _LOG.info("SLA sparse attention enabled: sparsity=%.2f block=64 min_seq_len=8192", self.sla_sparsity)
                return out
        except Exception as exc:
            _LOG.warning("SLA could not be applied (%s); continuing dense", exc)
        return model

    # Make room for activations before each sampling pass.
    # With dynamic VRAM enabled, core's free_memory() does not evict one dynamic
    # model for another ("0 models unloaded"), so the 32B text encoder that just
    # encoded the prompt stays resident while the UNet needs tens of GB of
    # activations for a long HD clip -> torch.OutOfMemoryError mid-pass
    # (reproduced on clip 3 of a 3 x 15 s @ 1344x768 project on a 32 GB card).
    # Estimate the activation demand from the packed token count, ask core to
    # evict everything except the sampling model, then return cached blocks to
    # the driver so the allocator can serve one large contiguous request.
    ACTIVATION_BYTES_PER_TOKEN = 64 * 1024      # fc1 output measured ~62 KB/token
    ACTIVATION_LIVE_TENSORS = 3
    # Feed-forward chunking: one chunk per this many packed tokens, so the fc1
    # peak stays roughly constant (~1.6 GB) whatever the clip length/resolution.
    FF_TOKENS_PER_CHUNK = 27000
    FF_CHUNK_THRESHOLD = 16384

    @staticmethod
    def _packed_tokens(samples):
        video = samples
        try:
            video, _ = _streams_from_latent({"samples": samples}, "samples")
        except Exception:
            pass
        shape = tuple(int(s) for s in getattr(video, "shape", ()))
        if len(shape) == 5:
            _, _, t, h, w = shape
        elif len(shape) == 4:
            _, t, h, w = shape
        else:
            t, h, w = 1, 64, 64
        return t * ((h + 1) // 2) * ((w + 1) // 2)

    def _with_ff_chunking(self, model, tokens):
        """Return `model` with KJNodes' MiniMaxChunkFeedForward applied, sized to
        the packed token count of this pass (KJNodes >= 1.5.1). On long/HD clips
        the OOM happens inside block.mlp: the fc1 output alone is
        tokens x 2*ffn_dim (~6.4 GB at 1344x768 / 362 frames, ~13 GB at 1080p).
        Splitting the token axis divides that peak by the chunk count at
        negligible cost; the object patches live on a clone so the prepared
        model is untouched. H3_MASTER_FF_CHUNKS forces a count (1 disables)."""
        chunk_cls = nodes.NODE_CLASS_MAPPINGS.get("MiniMaxChunkFeedForward")
        if chunk_cls is None or tokens <= self.FF_CHUNK_THRESHOLD:
            return model
        forced = os.environ.get("H3_MASTER_FF_CHUNKS")
        if forced:
            chunks = int(forced)
        else:
            chunks = max(2, min(64, math.ceil(tokens / self.FF_TOKENS_PER_CHUNK)))
        if chunks <= 1:
            return model
        try:
            res = chunk_cls.execute(model, chunks=chunks, seq_threshold=self.FF_CHUNK_THRESHOLD)
            chunked = _safe_get_output(res, 0, "model")
            if chunked is not None:
                _LOG.info("PDD engine: feed-forward chunking -- %d tokens -> %d chunks", tokens, chunks)
                return chunked
        except Exception as exc:
            _LOG.warning("PDD engine: could not enable feed-forward chunking (%s)", exc)
        return model

    def _reclaim_vram(self, model_patcher, samples):
        import gc
        mm = comfy.model_management
        try:
            device = mm.get_torch_device()
            tokens = self._packed_tokens(samples)
            required = int(tokens * self.ACTIVATION_BYTES_PER_TOKEN * self.ACTIVATION_LIVE_TENSORS)
            required = max(required, 6 * 1024 ** 3)
            gc.collect()
            before = mm.get_free_memory(device)
            keep = [model_patcher] if model_patcher is not None else []
            mm.free_memory(required, device, keep_loaded=keep)
            mm.soft_empty_cache(force=True)
            after = mm.get_free_memory(device)
            _LOG.info("PDD engine: VRAM reclaim before sampling -- %d tokens, want %.1f GB, free %.1f -> %.1f GB",
                      tokens, required / 1024 ** 3, before / 1024 ** 3, after / 1024 ** 3)
        except Exception as exc:
            _LOG.warning("PDD engine: VRAM reclaim skipped (%s)", exc)

    def _sample_euler(self, model, positive, latent_image, sigmas, seed):
        """Standard Euler sampling using ComfyUI core sampler internals directly.

        NOTE: Do NOT place any bare 'import comfy' statements inside this function.
        comfy.* is imported at module level; a local assignment to 'comfy' would cause
        Python to treat the name as unbound-local, raising UnboundLocalError.

        We directly use comfy.samplers.CFGGuider instead of going through the
        BasicGuider node, because ComfyUI v3 node calls return NodeOutput wrappers
        that don't expose .model_patcher, making them unusable for direct sampling.
        """
        from comfy_extras.nodes_custom_sampler import Noise_RandomNoise
        try:
            import latent_preview as _lp
            _have_lp = True
        except ImportError:
            _have_lp = False

        # Noise_RandomNoise is a plain class: Noise_RandomNoise(seed)
        noise_obj = Noise_RandomNoise(seed)

        # Size the feed-forward chunking to this pass's packed token count.
        model = self._with_ff_chunking(model, self._packed_tokens(latent_image["samples"]))

        # Build guider directly — bypass ComfyUI v3 node wrapper (NodeOutput issue)
        # MiniMax H3 is a pure flow model: no negative conditioning needed.
        # CFGGuider.set_conds(positive, negative) — pass positive for both.
        # With set_cfg(1.0): output = neg + 1.0*(pos-neg) = pos, so negative is never used.
        guider = comfy.samplers.CFGGuider(model)
        guider.set_conds(positive, positive)
        guider.set_cfg(1.0)

        # Build sampler object
        euler_sampler = comfy.samplers.sampler_object("euler")

        # Fix empty latent channels if needed
        latent = dict(latent_image)
        latent["samples"] = comfy.sample.fix_empty_latent_channels(
            guider.model_patcher,
            latent["samples"],
            latent.get("downscale_ratio_spacial"),
            latent.get("downscale_ratio_temporal"),
        )

        noise_mask = latent.get("noise_mask")
        x0_output = {}

        if _have_lp:
            callback = _lp.prepare_callback(guider.model_patcher, sigmas.shape[-1] - 1, x0_output)
        else:
            callback = None

        disable_pbar = not comfy.utils.PROGRESS_BAR_ENABLED

        self._reclaim_vram(guider.model_patcher, latent["samples"])

        samples = guider.sample(
            noise_obj.generate_noise(latent),
            latent["samples"],
            euler_sampler,
            sigmas,
            denoise_mask=noise_mask,
            callback=callback,
            disable_pbar=disable_pbar,
            seed=seed,
        )
        samples = samples.to(comfy.model_management.intermediate_device())

        out = latent.copy()
        out.pop("downscale_ratio_spacial", None)
        out.pop("downscale_ratio_temporal", None)
        out["samples"] = samples
        return out

    def _run_3d_upscaler(self, video_latent_4d_or_5d, target_w, target_h):
        """Upscale video latent using MinimaxH3LatentUpscaler3D."""
        upscaler_cls = nodes.NODE_CLASS_MAPPINGS.get("MinimaxH3LatentUpscaler3D")
        if not upscaler_cls:
            raise RuntimeError("MinimaxH3LatentUpscaler3D node is not installed in ComfyUI.")

        # Ensure 5D tensor [B, C, T, H, W]
        if video_latent_4d_or_5d.ndim == 4:
            v_tensor = video_latent_4d_or_5d.unsqueeze(0)
        else:
            v_tensor = video_latent_4d_or_5d

        # Current Comfyui_Minimax_h3_latent_Upscaler builds expose execute() as
        # (latent, model_name, mode, align, enable_temporal_chunking, force_unload,
        # device, precision); the (keep_proportion, offload_after_upscale) kwargs
        # this engine was written against no longer exist and raise TypeError.
        # Resolve the mode key from the node's own enum when present and pass only
        # the kwargs the installed signature accepts, so either version works.
        mode_key = "target dimensions"
        try:
            _enum = getattr(sys.modules[upscaler_cls.__module__], "UpscaleMode", None)
            if _enum is not None:
                mode_key = getattr(_enum, "TARGET_DIMENSIONS", mode_key)
        except Exception:
            pass
        mode_config = {
            "mode": mode_key,
            "width": int(target_w),
            "height": int(target_h),
        }

        device = "cuda" if torch.cuda.is_available() else "cpu"
        candidate_kwargs = {
            "latent": {"samples": v_tensor},
            "model_name": self.upscaler_model,
            "mode": mode_config,
            "align": 32,
            "keep_proportion": False,
            "device": device,
            "precision": "fp16",
            "offload_after_upscale": self.smart_offload,
            "enable_temporal_chunking": True,
            "force_unload": bool(self.smart_offload),
        }
        try:
            accepted = set(inspect.signature(upscaler_cls.execute).parameters)
            call_kwargs = {k: v for k, v in candidate_kwargs.items() if k in accepted}
        except (TypeError, ValueError):
            call_kwargs = candidate_kwargs
        res = upscaler_cls.execute(**call_kwargs)

        # Result is io.NodeOutput or tuple/dict containing {"samples": out}
        raw_out = _safe_get_output(res, 0, "latent")
        if isinstance(raw_out, dict) and "samples" in raw_out:
            upscaled = raw_out["samples"]
        elif hasattr(raw_out, "get") and raw_out.get("samples") is not None:
            upscaled = raw_out.get("samples")
        else:
            upscaled = raw_out

        if self.smart_offload and torch.cuda.is_available():
            torch.cuda.empty_cache()

        return upscaled

    def render_clip(
        self,
        clip_index: int,
        prompt: str,
        duration_sec: float,
        seed: int,
        pass1_res: tuple[int, int],
        pass2_res: tuple[int, int],
        pass2_denoise: float = 0.25,
        ref_images: dict = None,
        previous_latent: dict = None,
        previous_draft: dict = None,
        context_length: str = "22",
        audio_context_length: int = 0,
        last_frame_guide: torch.Tensor = None,
        progress_cb=None,
    ):
        """Execute the complete 2-Stage 2-Pass Pure PDD Pipeline for a single clip."""
        model, pdd_sigmas_p1 = self.initialize_pdd_model()

        frame_count = duration_to_h3_frames(duration_sec)
        w1, h1 = pass1_res
        w2, h2 = pass2_res
        ref_images = dict(ref_images or {})

        # Explicit pictures keep their numbered slots; continuity uses a free slot.
        if last_frame_guide is not None:
            for index in range(9):
                key = f"ref_image_{index}"
                if key not in ref_images:
                    ref_images[key] = last_frame_guide
                    break

        # =====================================================================
        # STAGE 1: PASS 1 (Low-Res Ref2VA PDD Generation)
        # =====================================================================
        if progress_cb:
            progress_cb("pass1", f"Rendering Clip {clip_index + 1} - Pass 1 (Draft {w1}x{h1})...", 0.1)

        _LOG.info(
            f"Clip {clip_index + 1}: Pass 1 Ref2VA at {w1}x{h1}, {frame_count} frames, seed={seed}"
        )

        # Generate Pass 1 conditioning + empty latent
        out_p1 = MiniMaxH3ReferenceToVideo.execute(
            clip=self.clip,
            vae=self.vae,
            audio_vae=self.audio_vae,
            prompt=prompt,
            width=w1,
            height=h1,
            length=frame_count,
            ref_image_size="match",
            ref_images=ref_images,
        )
        pos_p1 = _safe_get_output(out_p1, 0, "positive")
        latent_p1 = _safe_get_output(out_p1, 1, "latent")

        # If extending (clip_index > 0) and previous latent available: attach motion context
        self.last_trim_frames = 0
        self.last_draft = None
        if clip_index > 0 and previous_draft is not None:
            _LOG.info(f"Clip {clip_index + 1}: Applying Pass 1 motion context ({context_length}f video)")
            pos_p1, trim_p1, _, _, _ = self.motion_ram.apply(
                pos_p1,
                latent_p1,
                previous_draft,
                str(context_length),
                int(audio_context_length),
            )

        # Pass 2 conditioning is encoded NOW, while the text encoder is still
        # resident, instead of between the passes. It only depends on the
        # prompt, the reference images (sized to the target resolution) and the
        # previous clip's final latent, all of which are known here -- so the
        # UNet can stay resident straight through pass 1 -> upscale -> pass 2
        # and the text-encoder/UNet round trip per clip is halved.
        out_p2 = MiniMaxH3ReferenceToVideo.execute(
            clip=self.clip,
            vae=self.vae,
            audio_vae=self.audio_vae,
            prompt=prompt,
            width=w2,
            height=h2,
            length=frame_count,
            ref_image_size="match",
            ref_images=ref_images,
        )
        pos_p2 = _safe_get_output(out_p2, 0, "positive")
        latent_p2 = _safe_get_output(out_p2, 1, "latent")
        if clip_index > 0 and previous_latent is not None:
            pos_p2, trim_p2, _, _, _ = self.motion_ram.apply(
                pos_p2,
                latent_p2,
                previous_latent,
                str(context_length),
                int(audio_context_length),
            )
            self.last_trim_frames = int(trim_p2)
        del out_p1, out_p2

        # Sample Pass 1 with Euler + PDD 8-step sigmas
        sampled_p1 = self._sample_euler(
            model=model,
            positive=pos_p1,
            latent_image=latent_p1,
            sigmas=pdd_sigmas_p1,
            seed=seed,
        )

        # =====================================================================
        # LATENT 3D UPSCALE & ALIGNMENT
        # =====================================================================
        if progress_cb:
            progress_cb("upscale", f"Clip {clip_index + 1} - 3D Latent Upscaling to {w2}x{h2}...", 0.5)

        _LOG.info(f"Clip {clip_index + 1}: Separating AV latent and upscaling video to {w2}x{h2}...")

        self.last_draft = sampled_p1
        # Separate AV latent
        video_p1, audio_p1 = _streams_from_latent(sampled_p1, "samples")

        # 3D Latent Upscaling on video stream
        video_upscaled = self._run_3d_upscaler(video_p1, w2, h2)

        actual_hw = tuple(int(x) for x in video_upscaled.shape[-2:])
        if actual_hw != (h2 // 16, w2 // 16):
            raise ValueError(
                f"Upscaler returned {actual_hw[1] * 16}x{actual_hw[0] * 16}; "
                f"expected {w2}x{h2}. Use dimensions aligned to 32."
            )

        # Rejoin with audio stream
        rejoined_latent = {
            "samples": comfy.nested_tensor.NestedTensor((video_upscaled, audio_p1))
        }

        # =====================================================================
        # STAGE 2: PASS 2 (High-Res Refinement via PDD Quality Tail)
        # =====================================================================
        if progress_cb:
            progress_cb("pass2", f"Clip {clip_index + 1} - Pass 2 (Refine {w2}x{h2} with PDD tail)...", 0.7)

        _LOG.info(
            f"Clip {clip_index + 1}: Pass 2 refining at {w2}x{h2} (conditioning pre-encoded), quality tail denoise={pass2_denoise}"
        )

        # Get PDD Quality Tail sigmas
        scheduler_cls = nodes.NODE_CLASS_MAPPINGS.get("MiniMaxH3PDDAccScheduler")
        if scheduler_cls:
            scheduler_node = scheduler_cls()
            sigmas_p2 = scheduler_node.get_sigmas(nfe=self.pdd_nfe, denoise=float(pass2_denoise))[0]
        else:
            sigmas_p2 = self.pass1_sigmas[-int(len(self.pass1_sigmas) * pass2_denoise):]

        # Sample Pass 2 (High-Res Refine)
        final_sampled = self._sample_euler(
            model=model,
            positive=pos_p2,
            latent_image=rejoined_latent,
            sigmas=sigmas_p2,
            seed=seed,
        )

        # The disk renderer extracts the guide from the corrected preview decode.
        return final_sampled, None
