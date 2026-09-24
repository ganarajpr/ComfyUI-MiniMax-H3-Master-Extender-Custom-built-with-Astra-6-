# ComfyUI MiniMax H3 Master Extender

Multi-clip MiniMax H3 video generation with two-pass PDD acceleration, learned latent upscaling, motion and audio continuity, clip validation, and project save/load.

Custom build prepared with assistance from Astra 6. This is a community integration, not an official MiniMax or ComfyUI release. Original project authors are credited below.


<img width="2047" height="1216" alt="Screenshot 2026-09-11 020707" src="https://github.com/user-attachments/assets/95bce67e-3703-4238-874d-0e763f0d83d7" />


## Features

- Master Extender: draft generation, 3D latent upscale, and a second refinement pass.
- Clip-by-clip review or full-batch generation, with per-clip prompts, seeds, and LoRAs.
- Up to nine reference pictures and motion continuity between clips.
- Project save/load, cached previews, and final video with audio.
- Final Decode with automatic H.264 NVENC when available and CPU encoding fallback.

The included workflow is deliberately blank: one empty prompt, no reference images, no validated clips, and no saved project content. No model weights, generated media, or cache files are included.

## Installation

1. Use a ComfyUI installation with native MiniMax H3 support. This package was prepared against **ComfyUI 0.34.5**, core commit `7fd919f0caff66a52289ea5b19cb6eaca0da04ef`. That is a source compatibility reference, not a claim of testing on every hardware configuration. The PDD dependency requires at least ComfyUI 0.33.0; the full package has not been verified on that older version.
2. Open a terminal in `ComfyUI/custom_nodes` and run:

   ```sh
   git clone https://github.com/only2uuuu-hub/ComfyUI-MiniMax-H3-Master-Extender-Custom-built-with-Astra-6-.git ComfyUI_MiniMax_H3_Master_Extender
   git clone https://github.com/Jalen-Brunson/ComfyUI-MiniMax-H3-PDD-Acc.git
   git clone https://github.com/xmarre/Comfyui_Minimax_h3_latent_Upscaler.git
   ```

   Alternatively, extract this project's ZIP into `ComfyUI/custom_nodes/ComfyUI_MiniMax_H3_Master_Extender`. The `__init__.py` file must be directly inside that folder. Install the two dependency repositories separately; they are not bundled. If already installed, update the existing copies instead of installing duplicates.

3. Install requirements using **the same Python environment that runs ComfyUI**. From the ComfyUI folder with its environment activated:

   ```sh
   python -m pip install -r custom_nodes/ComfyUI_MiniMax_H3_Master_Extender/requirements.txt
   python -m pip install einops
   ```

   Standard ComfyUI supplies PyTorch, NumPy, Pillow, aiohttp, and safetensors. `einops` is used by the external upscaler. Follow any additional installation instructions in the dependency repositories. Do not replace your ComfyUI PyTorch installation with a generic CPU build.

   **Windows portable:** from the portable installation root:

   ```bat
   .\python_embeded\python.exe -m pip install -r .\ComfyUI\custom_nodes\ComfyUI_MiniMax_H3_Master_Extender\requirements.txt
   .\python_embeded\python.exe -m pip install einops
   ```

   **ComfyUI Desktop:** use the installation's environment terminal and its actual custom-nodes directory. Do not install dependencies into an unrelated system Python.

4. Download the models separately and place them as described below. Restart ComfyUI, then refresh the browser.
5. Open one of the example workflows, select your installed model files, write a prompt, and attach reference pictures if needed:
   - `example_workflows/MiniMax_H3_Master_Extender_Blank.json` — the original PDD 8-step graph.
   - `example_workflows/MiniMax_H3_Master_Extender_Turbo_SLA.json` — the faster graph: Turbo LoRA at 5 steps, comfy kitchen attention with SLA 0.9, chunked refine pass, 608x352 draft to 1280x720, one blank 15 s clip. On an RTX 5090 a 15 s clip renders in roughly 85–90 s. Needs a converted Turbo LoRA in `models/loras` (see `turbo_lora`).

   Start with `clip_by_clip` and one clip. Inspect the preview and validate a clip before continuing the chain.

The PDD Apply and Scheduler nodes must be installed even though they are called internally and do not appear as boxes in the example workflow. H3 Turbo is not a dependency of this workflow. Avoid duplicate installations of the same node classes. The standalone Motion Context pack is not required: the adapted motion-context implementation is included here.

   **Optional: semantic bridge.** The Master node has `semantic_bridge` / `semantic_bridge_alpha` / `semantic_bridge_match` widgets that run the [BUNNY H3 Conditioning Bridge](https://github.com/aa335615543-ux/BUNNY_H3_Conditioning_Bridge) on the conditioning of both passes (model: [JOKER141/BUNNY_H3_Conditioning_Bridge](https://huggingface.co/JOKER141/BUNNY_H3_Conditioning_Bridge)). Install that node and put the adapter in its `models/` folder or in `models/semantic_bridge`; leave `semantic_bridge` at `none` when it is not installed.

## Model files (not included)

These are the filenames selected in the source workflow. Choose compatible alternatives in the dropdowns if you use another supported precision or filename; renaming an incompatible model does not make it compatible.

| Purpose | Folder under `ComfyUI/models` | Source workflow selection |
| --- | --- | --- |
| Ref2VA diffusion model | `diffusion_models` | `MiniMax_H3_Ref2VA_pruned_int8_convrot.safetensors` |
| Qwen3-VL text encoder | `text_encoders` | `qwen3vl_32b_heretic_minimax_h3_nvfp4.safetensors` |
| Video VAE | `vae` | `minimax_h3_video_vae_int8_convrot.safetensors` |
| Audio VAE | `vae` | `minimax_h3_audio_vae_fp32.safetensors` |
| Ref2VA PDD acceleration | `pdd_acc` | `MiniMax-H3-Ref2VA-Acc-8Step.safetensors` |
| Learned 3D latent upscaler | `latent_upscale_models` | `minimax_h3_latent_upscaler_3d_fp16.safetensors` |

Keep the CLIPLoader type set to `minimax`. Pair a **Ref2VA** base model with a **Ref2VA** PDD file. The selected quantized models require compatible ComfyUI kernels and hardware; they are not universal defaults.

- PDD weights: [alibaba-pai/MiniMax-H3-Acc-LoRAs](https://huggingface.co/alibaba-pai/MiniMax-H3-Acc-LoRAs).
- Upscaler weights: [LBH-123-AI/Minimax_h3_latent_Upscaler](https://huggingface.co/LBH-123-AI/Minimax_h3_latent_Upscaler).
- For the base model, encoder, and VAEs, use the model provider's MiniMax H3 instructions and compatible ComfyUI builds. This release does not provide or automatically download them.

Model licenses are separate from the source-code license. Hardware requirements depend on model precision, resolution, clip duration, and offloading. No minimum VRAM guarantee is made.

## ComfyUI launch arguments

No project-specific command-line flag is required. From the ComfyUI folder with its Python environment activated, a simple starting command is:

```sh
python main.py --use-pytorch-cross-attention --preview-method none
```

Windows portable, from the portable installation root:

```bat
.\python_embeded\python.exe -s .\ComfyUI\main.py --windows-standalone-build --use-pytorch-cross-attention --preview-method none
```

For additional memory headroom, you can try:

```sh
python main.py --use-pytorch-cross-attention --preview-method none --reserve-vram 2 --cache-none
```

| Argument | Effect |
| --- | --- |
| `--use-pytorch-cross-attention` | Selects core PyTorch attention globally. |
| `--preview-method none` | Disables core sampler previews; the custom video preview still works. |
| `--reserve-vram 2` | Reserves 2 GB of VRAM for other use; adjust for your machine. |
| `--cache-none` | Disables core node-result caching, reducing its memory use at the expense of re-execution. It does not delete this extension's disk cache. |
| `--cpu-vae` | Optional CPU VAE fallback, generally slower and still requiring system RAM. |
| `--port 8188` | Chooses the server port; 8188 is the default. |

The **Master node's `attention_backend` selection controls both sampling passes independently of the global attention flag**. The blank workflow selects `pytorch attention`. Choose `comfy kitchen attention` or `sage attention 2.2` only when the corresponding backend is installed and supported. Keep ComfyUI's normal precision/offloading defaults unless your hardware needs a specific adjustment. In the inspected core, `--lowvram` has no effect when dynamic VRAM is enabled.

For Desktop, put the desired flags in your existing launch configuration if supported, or use its environment terminal. Check `python main.py --help` for the arguments supported by your installed version.

## Outputs and troubleshooting

- The extension writes working data (cache chains) into `ComfyUI/output/MasterExtender_cache/`; keep it writable and allow sufficient disk space. A `cache/` folder left by older versions inside the node folder is moved there automatically on first use. Caches are generated locally and are not part of the release.
- Leave Final Decode's output directory empty to use the default ComfyUI output location. Use its preview/export controls or the connected SaveVideo node to save a result.
- Missing `MiniMaxH3PDDAccApply` / `MiniMaxH3PDDAccScheduler`: install the PDD dependency before rendering. This build contains a fallback when PDD is absent, but it does not provide the intended accelerated result.
- Missing `MinimaxH3LatentUpscaler3D`: install the upscaler dependency and its model.
- Missing native H3 modules or attention API errors: check the ComfyUI version and startup import errors.
- FFmpeg not found: install this project's requirements into ComfyUI's Python, or provide FFmpeg on PATH. H.264 automatically falls back to software encoding if NVENC is unavailable.
- Memory errors: reduce clip duration/resolution, keep smart offload enabled, and process clips individually. Launch flags cannot make every model fit every GPU.
- Refresh the browser after updates. Avoid running old and new copies of this package together.

## Credits and license

This project brings together adapted code and separately installed dependencies. Credit does not imply endorsement.

| Original author / project | Contribution |
| --- | --- |
| [tritant / ComfyUI_MiniMax_H3_Extender](https://github.com/tritant/ComfyUI_MiniMax_H3_Extender) | Extender foundation and inherited continuity/decode implementation. |
| [NikoDemon80 / ComfyUI-H3-Motion-Context](https://github.com/NikoDemon80/ComfyUI-H3-Motion-Context) | GPL-3.0 motion-context temporal anchor and payload patch foundation. |
| [Jalen-Brunson / ComfyUI-MiniMax-H3-PDD-Acc](https://github.com/Jalen-Brunson/ComfyUI-MiniMax-H3-PDD-Acc) | External PDD acceleration loader and scheduler dependency. |
| [xmarre / Comfyui_Minimax_h3_latent_Upscaler](https://github.com/xmarre/Comfyui_Minimax_h3_latent_Upscaler) | External learned latent upscaling dependency. |
| [alibaba-pai / MiniMax-H3-Acc-LoRAs](https://huggingface.co/alibaba-pai/MiniMax-H3-Acc-LoRAs) | PDD acceleration model artifacts, downloaded separately. |
| [Comfy-Org / ComfyUI](https://github.com/Comfy-Org/ComfyUI) | Runtime and native MiniMax H3 model integration. |

The combined source distribution is provided under **GNU GPL version 3**. Preserve the upstream notices and Apache-2.0 terms for the portions originally provided under Apache-2.0. See [LICENSE](LICENSE), [THIRD_PARTY_NOTICE.md](THIRD_PARTY_NOTICE.md), and [licenses/Apache-2.0.txt](licenses/Apache-2.0.txt). External dependencies retain their own licenses.
