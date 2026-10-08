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
   - `example_workflows/MiniMax_H3_Master_Extender_Blank.json` — the PDD 8-step graph with every input at its default.
   - `example_workflows/MiniMax_H3_Master_Extender_Turbo_SLA.json` — the faster graph: Turbo LoRA (ref2v turbo 4-step), comfy kitchen attention with SLA 0.9, chunked refine pass, 608x352 draft to 1280x720, one blank 15 s clip. On an RTX 5090 a 15 s clip renders in roughly 85–90 s. Needs a converted Turbo LoRA in `models/loras` (see `turbo_lora`).
   - `example_workflows/MiniMax_H3_Master_Extender_HyperFlow_Action.json` — the locked action preset: HyperFlow 8-step (pruned file, curve refit on, LoRA mode bypass) with an empty LoRA stack (any LoRA disables the curve fit), SLA 0.9, and the taomate 3-step LoRA replacing the engine LoRA on pass 2. Base model: Singularity v1.3 int8.
   - `example_workflows/MiniMax_H3_Master_Extender_Story_Builder.json` — the HyperFlow action preset set up for building a story clip by clip: built-in rewriter on `pending clips`, continuity `final prompts` (clip N continues from clip N-1's final rewritten prompt, written one after another) and a sample `rewrite_story` (the whole film's story; each clip's writer uses it only to pick that clip's beat). Two clips, the second saying "Continue the story from previous."
   - `example_workflows/MiniMax_H3_Master_Extender_Story_Auto.json` — the Story Builder preset with one empty clip, a five-sentence sample `rewrite_story` and `auto_clips` = 4: the first run plans the story into four clips, then rewrites them one after another.

   Start with `clip_by_clip` and one clip. Inspect the preview and validate a clip before continuing the chain.

The PDD Apply and Scheduler nodes must be installed even though they are called internally and do not appear as boxes in the example workflow. H3 Turbo is not a dependency of this workflow. Avoid duplicate installations of the same node classes. The standalone Motion Context pack is not required: the adapted motion-context implementation is included here.

   **Optional: semantic bridge.** The Master node has `semantic_bridge` / `semantic_bridge_alpha` / `semantic_bridge_match` widgets that run the [BUNNY H3 Conditioning Bridge](https://github.com/aa335615543-ux/BUNNY_H3_Conditioning_Bridge) on the conditioning of both passes (model: [JOKER141/BUNNY_H3_Conditioning_Bridge](https://huggingface.co/JOKER141/BUNNY_H3_Conditioning_Bridge)). Install that node and put the adapter in its `models/` folder or in `models/semantic_bridge`; leave `semantic_bridge` at `none` when it is not installed.

## Built-in prompt rewriter: system prompt, continuity, story planner

Turn on `rewrite_mode` and each clip's text is rewritten into an H3 prompt on a local GGUF (needs the MiniMax-H3-Prompt-Rewriter-ComfyUI pack).

- **One rewriter model, one call per clip** (`rewrite_writer_model`). The same model looks at the reference pictures and writes the prompts; there is no caption step and no separate caption model (old workflows' `rewrite_caption_model` value is dropped on load). A model sees images when the pack lists it as a captioner, i.e. it ships an mmproj (a ninfer artifact brings its own vision tower), or, for *Strata*, when it is serving with its vision section (the gateway config `strata-iq3_s.gateway.json` has `--vision` in `args` and a `vision` entry whose `strata-vision` and mmproj files exist; a Strata already running is asked through `/v1/models`). The planner call and every clip's writer call then carry the reference pictures themselves, on one server session, with thinking available. **Layout:** each picture is downscaled once to at most 896 px on its long side (a multiple of 28, the vision tower's block size: a square is 1,024 tokens, a 3:4 portrait 768, so nine pictures cost at most 9,216 tokens; 1,024 is also Strata's per-picture ceiling) and sent as a PNG data URI. They come FIRST in the user message, as `Picture 1:` + image ... `Picture N:` + image (N up to 9), in the same order and byte for byte in every call; everything that varies per clip (task, duration, the reference list, story, previous clips, the ask) follows them. The system prompt is also identical in every clip's call (its rules are decided per run, not per clip), so a server that caches the prompt prefix (llama-server, ninfer, possibly Strata) reads the pictures once. The log has one line with the picture count, the sent sizes and the estimated image tokens; with Strata a second line gives the prompt tokens the server reported. Reference *videos* are still captioned on a llama/ninfer session (cached by frame hash); Strata labels them without describing them. A model without vision (a GGUF with no mmproj, or a Strata without the vision section) takes the old path: no image input, text-only rewrite, and the log says `writer has no vision: reference images not interpreted`. The `<Picture N>` labels still reach the writer as plain lines (`Picture 1: an attached reference picture (not described here)`), so the Ref2VA structure is unchanged; a rule is added telling the writer not to guess what a picture shows and to take wardrobe from the ask, the previous clip and the story. The planner then gets the story text alone.
- **Thinking budget** (`rewrite_reasoning_budget`): a dropdown of `1024`, `2048`, `4096` (default `4096`), thinking tokens at most, on top of `rewrite_max_new_tokens`. Saved workflows and API graphs that send another number (`-1`, `0`, `8192`, `16384`...) are mapped to the nearest allowed value (`<=1024` to 1024, above 4096 and `-1`/`0` to 4096).
- **System prompt.** `rewrite_system_prompt_in` (socket) wins, then the `rewrite_system_prompt` widget. **When both are empty the default is now the H3 Prompt Studio's builder, `prompts/builder.md`, for Ref2VA** (reference pictures connected). It is written for ref2va (`<Subject N>` / `<Picture N>`, six sections), so a T2VA run (no references) keeps MiniMax's official guide. To get the official guide in every case, type `@official` in the widget (a value in the existing text widget, so saved widget positions do not move). **Workflows saved with an empty system prompt now get the builder from their next rewrite; clips already rewritten are not redone** (the system prompt is not part of a clip's fingerprint).
- **Continuity for clip N** (`rewrite_previous_clips`): `off`; `raw asks` (default: clips 1..N-1 as you typed them, clips written in parallel); `final prompts` (the full final prompt of clip N-1 plus the raw asks of clips 1..N-2; clips are written one after another, and clip N is rewritten again when N-1's final prompt changes).
- **Film story** (`rewrite_story`): the whole story, given to every clip's writer as a `story:` block so it covers only its own beat. Does not mark rewritten clips stale.
- **Story planner** (`auto_clips`, default 0 = off). With a story set and `auto_clips` = N, the first run plans the story once into exactly N clips of `auto_clip_seconds` each (INT, 5-15, default 15) (the Studio's one-call chapter-breakdown planner, `prompts/planner.md`, on the writer GGUF), writes each clip's shot list into the empty clips as its raw ask (flagged *planned*, editable in the panel), then rewrites them. Clips you typed are kept and planned around: if any clip in the range has text, the planner is shown every clip in order (typed ones verbatim, the empty ones as `[TO PLAN: clip N]`) and plans only the empty ones in one call, each bridging the clip before it to the clip after it (clips after the last typed one simply continue it); with nothing typed it plans the whole story into N. Typed clips are never overwritten. Changing the story or N never plans again (that would discard rendered takes); use **Replan from story** in the Prompt Rewriter section. A run queued from the API without the panel does not store the plan, so it plans again next time. **Plan more:** raise `auto_clips` past the number of clips and only the new ones are planned, numbered after the existing ones, continuing from where the last one ends (the planner is given the whole story, the existing clips' asks in order — your edited text if you edited one — and the state carried out of the last clip). Existing clips, typed or planned, are never touched; lowering `auto_clips` or editing the story does nothing; an empty clip inside the existing range stays empty. With `final prompts` continuity, the first new clip continues from the last existing clip's final prompt. **Reference pictures** (`planner_refs`, default `images`): the planner is shown the connected pictures, each labelled `Picture N:`, with a rule to stage the story only with them and to name a subject by its Picture number the first time it appears in a clip. `images` sends the real pictures (the same ones, in the same order, as the clip writers get) and needs a rewriter model with vision (see above); `captions` is the old name for `images` and now means the same. With a rewriter model that cannot see images the planner gets the story text alone. `off` gives the planner the story text alone. Reference videos are caption lines only. Each picture is budgeted at (width//28)*(height//28) context tokens after the 896 px downscale (at most 1,024). The rule is in code, not in `prompts/planner.md`.

`prompts/builder.md` and `prompts/planner.md` are copies of the Studio's `DEFAULT_REWRITE_SYSTEM_PROMPT` and `CHAPTER_BREAKDOWN_TEMPLATE`; the canonical copy lives here, and the Studio has a test that fails when they drift.

## Story engine: `story_engine` = `builder` | `e4`

Story mode (`rewrite_story` + `auto_clips`) has two engines. **`builder`** (the default) is everything described above: `planner.md` plans the story, then `builder.md` writes every clip from the reference pictures. **`e4`** plans the whole film and writes every clip's FINAL prompt with the E4.6 story-to-film pipeline; `builder.md` is not run for those clips.

**What E4 does that the builder does not.** Every spoken word is written verbatim into the plan, including counting and repeated calls, and checked across clips; every speaker has one id (`(S1)`, `(S2)`) for the whole film; a voice nobody sees is written as an off-screen voice, never as a `<Subject>`, and its cut either shows no face or says the visible character's lips are pressed shut; `non_diegetic_music` is `N/A` unless you ask for a score, and hum/drone/resonance words are swept out of the sound design; one film bible fixes who and what exists, with an acting profile per character; one small decision call per clip chooses who is on screen, the staging and the references, and a ledger carries state (positions, wardrobe, props) from clip to clip; the writer's draft is checked by code (lines verbatim, speakers, cut markers, durations, negations, spatial words) and repaired where it fails. The extender's `final prompts` continuity is therefore not needed for these clips. Frozen at `e4.6-frozen`; the engine is measured and described in the eval repo, not here.

**Settings** (all appended last, so saved workflows keep their widget positions; old workflows load with the defaults, which are the builder):

| widget | values | meaning |
| --- | --- | --- |
| `story_engine` | `builder` (default), `e4` | the engine of the first plan |
| `e4_language` | text, default `English` | the language every spoken line is written in |
| `e4_score` | `off` (default), `on` | `off`: `non_diegetic_music: N/A`. `on`: the film bible writes one instrumental score that every clip carries |
| `e4_decision_budget` | `1024`, `2048` (default), `4096` | thinking tokens at most for each per-clip decision call. The planner, the film bible, the writer and the repairs always get 4096 |
| `e4_picture_notes` | text, one line per picture | `2: the old tailor in a grey kurta`. A hint beside the picture for a model that sees; the only way to bind pictures for a model that cannot |

**How a run goes.** With `story_engine` = `e4`, `rewrite_mode` on, a `rewrite_story`, `auto_clips` of 1 or more, an empty clip list and at least one connected reference picture, the first run does this instead of the planner and the per-clip writer calls (the panel's progress line says each step):
1. The rewriter's model server is opened as always (a ninfer artifact, a llama.cpp model, or Strata), with thinking on and a context sized for E4 (32768 tokens per slot, `MINIMAX_H3_E4_SLOT_CTX` to change it).
2. E4 runs as ONE Node subprocess against that same server: planner, film bible, **picture binding**, one decision call per clip, one writer call per clip (up to 4 at once, at most `rewrite_parallel`), repairs only where a check fails.
3. Its clips are written into the clip list as finished clips; the rest of the run (motion context, rendering) is unchanged.

**The model is the rewriter's model; nothing else is called.** `e4_engine.endpoint_of` reads the server the rewriter opened. A ninfer artifact is called on `/v1/messages` with `thinking.budget_tokens` (a real per-request cap). A llama.cpp server or Strata is called on `/v1/chat/completions` with the top-level fields `reasoning_budget_tokens` and `reasoning_budget_message` (not `chat_template_kwargs`), and `max_tokens` is capped to what a slot holds. The writer must run on a server: a vision model from the pack's list, or Strata (a plain GGUF that runs in-process cannot be called by a subprocess, and the run stops with that message).

**Pictures.** E4 does not render reference images: yours are bound to its characters, props and locations. After the film bible, one decision call shows the model every connected picture (the same 896 px PNG data URIs, `Picture N:` first, that the extender sends everywhere; N is the slot number) with the list of entities, and asks, for each picture, which ONE entity it shows or `unused`. The reply is checked (every picture answered, every id real, an entity gets one picture; one retry with the complaint) and settled in code. The clips then cite `<Subject k> is NAME in <Picture j>, ...` with YOUR Picture numbers, not renumbered per clip, so the connected pictures match the prompts; an entity with no picture stays "described in words only" and cites none; a voice is never a subject. A model without vision binds by `e4_picture_notes`; without notes (or when its reply is unusable) a plain match of the note lines to entity names is the last resort, and without either every entity is described in words only (the log says so). The result is `story/pictures/map.json` in the run directory.

*Example (the stored test, `tests/e2e`): six pictures connected in the order sherwani, shop, Pramod, button, Haroon, tea glass.* See the PR description for the produced clips; the binding was `{EXAMPLE_BINDING}`, and a clip's subject lines read `{EXAMPLE_SUBJECT}`.

**What the clips look like.** Each planned clip becomes an ordinary finished clip: `prompt` is the six-section prompt, `prompt_raw` the planned ask (shots, camera, action, lines), `prompt_rewritten` and `planned` true, `title` `Clip N: <beat>`, `duration` a whole number of seconds (E4 plans on the 17k+5 frame grid, 15.08 s for a 15 s clip, which becomes 15), and `rewrite_meta` carries `engine: "e4"`, the engine version, the picture list, any citation issue and the extender's own fingerprint, so a later run does not rewrite them again. A clip E4 could not write keeps its planned ask as a pending clip and the builder writes it in the normal pass (a note says so).

**Requirements.**
- **Node.js 18 or newer** (plain executable; E4 has no npm package and needs no install). The extender looks for it in this order: the environment variable `MINIMAX_H3_E4_NODE`, the first line of `<ComfyUI>/user/minimax_h3_master/e4_node.txt`, then `node` on PATH. The error names what was tried.
- The `e4/` folder (shipped here). `node e4/verify-frozen.mjs` proves it is the frozen E4.6: every file is hashed against `e4/MANIFEST.json` and against the freeze record `e4/planpath46/E4.6-FROZEN.md`, and the four files that had to be patched (`hybrid3/lib.mjs`: the optional dhee-core `.env`, the llama.cpp wire and a `max_tokens` cap; `planpath46/lib.mjs`: the `.env` and a Windows-safe file path; `hybrid46/validate.mjs`: the vendored audit runner; `film.mjs`: the picture-binding hook) are verified with their declared replacements (`e4/PATCHES.json`) reversed. With the eval repo, `--eval-repo <path>` also compares with the git tag `e4.6-frozen`.
- A server-backed rewriter, at least one reference picture, and the story in `rewrite_story`.

**What the first version supports, and what it does not.**
- It plans a whole film into an EMPTY clip list: the first plan, or the first plan after "Replan from story" (which empties the planned clips as before and starts E4 again, a new sample).
- E4 decides the number of clips from the story and plans 15 s clips. `auto_clips` only switches planning on (a different number is logged, not used) and `auto_clip_seconds` is not used (the planner is the frozen one; other lengths were never measured).
- Typed clips and "Plan more" (a raised `auto_clips` after a plan) are not supported by E4: that run uses the builder planner, and the panel says so. The film's other clips stay as they are.
- Clips are written into positions 1..N; empty clips beyond N are left empty (a note says how many). Every connected picture is attached to every clip's render, as for the builder; a clip's prompt cites only the pictures whose entity is on screen in it.
- "Rewrite again" on one clip uses `builder.md` on the planned ask, not E4. To redo the film with E4, use "Replan from story".
- The planner works from the story text; it does not see the pictures (it plans before the bible exists). Pictures bind to the entities the story names.
- `rewrite_previous_clips` (raw asks / final prompts) is not used for E4's clips: E4's ledger carries continuity. It still applies to clips the builder writes.

**Logs.** `<ComfyUI>/user/minimax_h3_master/e4/<run>/`: `job.json`, `calls.jsonl` (one line per model call), `story/` (`plan.json`, `bible.json`, `pictures/map.json`, per call `*.request.json` / `*.response.raw.txt` / `*.meta.json`, per clip `decisions.json`, `facts.txt`, `final.prose.json`, checks), `clips.json` (what was put into the clip list) and `prompts/`. Pictures are logged by hash, not as base64. A run that stops early resumes from its stored plan and bible when the same story is run again.

**Tests.** `python -m unittest discover -s tests -p "test_e4_engine.py"` (Node, numpy and Pillow; no GPU, no ComfyUI) replays a stored real run through a mock model server and the real Node subprocess, and replays four story-mode scenarios to prove the builder's requests are byte for byte those of commit b12b03d; `node --test e4/bridge/test/bridge.test.mjs`; `tests/e2e/e4_outside_comfyui.py` runs one story against a real model with the extender's own code (ComfyUI and the rewriter pack stubbed). `DEPLOY-E4.md` has the steps to put this on the box.

## HyperFlow 8-step mode

A third acceleration mode next to PDD and Turbo LoRA. See [HYPERFLOW.md](HYPERFLOW.md) for the node pack, weights, base/build pairing and the pass-2 rule.

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
