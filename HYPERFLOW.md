# HyperFlow 8-step mode

`accel_mode = "HyperFlow 8-step"` is a third acceleration mode next to "PDD 8-step" and "Turbo LoRA". It runs Video Rebirth's HyperFlow: an 8-step LoRA plus two-time `(t, r)` conditioning.

## Requirements

- Node pack: [ComfyUI-HyperFlow-H3](https://github.com/Adudeguyman/ComfyUI-HyperFlow-H3) (v1.4.0 or later) in `custom_nodes`, no extra Python requirements. The extender calls its `ApplyHyperFlowH3` node class. Restart ComfyUI after installing it.
- Weights in `models/hyperflow/`: `custom_node_hyperflow_8step_v1.0_comfyui.safetensors` (full base) and `custom_node_hyperflow_8step_v1.0_comfyui_pruned.safetensors` (pruned base).

## Base and build pairing

| Loaded base | `hyperflow_file` | `hyperflow_curve_refit` |
|---|---|---|
| Full MiniMax-H3 (has `time_embedder`) | the build without `_pruned` | ignored |
| Pruned base with a bundled curve fit (e.g. `Minimax-h3_Singularity_ref2va_Pruned_v1.3_int8`) | the `_pruned` build | on (default) |
| Any other pruned base | the `_pruned` build | LoRA-only, single-time (off-recipe); the log says so |

A mismatched pairing stops the job with the node pack's own message. With refit on and a matching base, the ComfyUI log must not say `curve refit disabled`.

## What the mode does

- Pass 1 uses the MODEL and the trained 9-point SIGMAS returned by `ApplyHyperFlowH3` (applied on the SigmaShift model). Never a BasicScheduler schedule. `pdd_nfe` is ignored (8 fixed), and the sampler is Euler.
- New inputs, appended after every existing widget so saved workflows keep their widget order: `hyperflow_file`, `hyperflow_curve_refit`, `hyperflow_strength`.
- Sparse attention: `sla_enabled` behaves as in the other modes and the log notes what is in effect. HyperFlow's own validated sol-attn recipe is `start_percent 0.16`, `dense_blocks "0,1"`, `tau 1.0`, sink off.

## Pass-2 rule

HyperFlow must never run on a sigma tail that is not cut from its own grid.

- No pass-2 LoRA: pass 2 uses the last `round(8 x pass2_denoise)` steps of HyperFlow's 9-point grid (3 points at the default 0.25), on the HyperFlow model.
- Pass-2 LoRA set: the mode is forced to "replace engine LoRA". Pass 2 runs on the SigmaShift model plus that LoRA, without HyperFlow, on a scheduler tail as in Turbo mode. The log says which case applied.

## Cache

The disk cache does not re-render when settings change. Clear the chain (panel "clear cache", or `POST /comfyui/minimax_master/clear_cache`) before comparing engines.
