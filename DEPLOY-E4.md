# Deploying `story_engine=e4` to the box

Branch `e4-story-engine` of the founder's fork (`ganarajpr/ComfyUI-MiniMax-H3-Master-Extender-Custom-built-with-Astra-6-`). It is based on `b12b03d`, the commit the box runs. **Nothing here has been done on the box.** Deployment needs the founder's OK and an empty queue.

## Before you start

1. The founder says yes.
2. ComfyUI has nothing running or pending and no ninfer lane is busy:
   ```
   curl -s http://5090.tail3cca41.ts.net:9000/comfyui/queue      # {"queue_running": [], "queue_pending": []}
   curl -s http://5090.tail3cca41.ts.net:9000/status             # every "inflight" is 0
   ```
3. Note the commit now deployed, for the rollback: `git -C <ext> rev-parse HEAD` must print `b12b03d272ec89acabb663cad79c094cdb84af8b` and `git -C <ext> status --short` must print nothing.
   `<ext>` = `C:\Users\user\Projects\ComfyUI_windows_portable\ComfyUI\custom_nodes\ComfyUI_MiniMax_H3_Master_Extender`

## The update (on disk only; this does not restart anything)

```
ssh h3box
cd <ext>
git fetch origin e4-story-engine
git checkout e4-story-engine          # or: git merge --ff-only origin/e4-story-engine from the branch the box is on
```

The branch adds `e4_engine.py`, the `e4/` folder (about 1 MB of plain JavaScript, no npm package, no build step) and changes `prompt_rewriter.py`, `master_node.py` and `web/master_extender.js`. `.gitattributes` marks `e4/**` as `-text`, so Git on Windows does not rewrite its line endings (the verify script would notice).

## Node

E4 is plain Node.js 18 or newer. The box already has one: `C:\Users\user\tools\node-v20.20.2-win-x64\node.exe`. Tell the extender where it is, either way:

- one line in `C:\Users\user\Projects\ComfyUI_windows_portable\ComfyUI\user\minimax_h3_master\e4_node.txt`:
  ```
  C:\Users\user\tools\node-v20.20.2-win-x64\node.exe
  ```
- or the environment variable `MINIMAX_H3_E4_NODE` for the ComfyUI process (the file is easier: it needs no restart of anything to change).

Order of lookup: `MINIMAX_H3_E4_NODE`, then `e4_node.txt`, then `node` on PATH. A path that is not a file, or a Node older than 18, is skipped and named in the error.

## Verify, without ComfyUI

```
"C:\Users\user\tools\node-v20.20.2-win-x64\node.exe" e4\verify-frozen.mjs
```
Expected last line: `e4 E4.6 (e4.6-frozen): 89 files checked, 4 patched (patches reversed), 74 against the freeze record (offline: ...), 0 problem(s)`. Any other line means a file was changed after vendoring (or Git converted line endings): do not use story_engine=e4 until it is clean. The four patches are listed with their reasons in `e4\PATCHES.json`; with the eval repo at hand, `--eval-repo <path to h3-prompt-eval>` also compares every file with the git tag `e4.6-frozen`.

The tests need the embedded Python of ComfyUI (numpy and Pillow are there) and no GPU:
```
cd <ext>
..\..\..\python_embeded\python.exe -m unittest discover -s tests -p "test_e4_engine.py"
"C:\Users\user\tools\node-v20.20.2-win-x64\node.exe" --test e4\bridge\test\bridge.test.mjs
```
`BuilderUnchanged` in that module is the proof that `story_engine=builder` makes the same requests as `b12b03d`.

## It takes effect when ComfyUI is restarted

Python and the panel's JavaScript are read when ComfyUI starts, and the browser must be refreshed. **Restart only with an empty queue and the founder's OK** (the `never-restart-comfyui-with-queue` rule). Until then the running ComfyUI is still `b12b03d` in memory, whatever is on disk.

After the restart:
- the Master node has five new widgets at the end of its list: `story_engine` (default `builder`), `e4_language`, `e4_score`, `e4_decision_budget`, `e4_picture_notes`. Saved workflows load with the defaults, so they behave as before.
- the example workflows carry the new values (`builder`).

## First real use

In the Story Auto workflow: connect the reference pictures, put the story in `rewrite_story`, `auto_clips` at 1 or more (it only switches planning on), one empty clip, `rewrite_mode` = `pending clips`, the Swift 1.5 NInfer writer, `story_engine` = `e4`. Queue it. Expected:
- the panel's progress line walks through `story_engine=e4: planning and writing the film ...`, `E4: story planned`, `E4: film bible written`, `E4: reference pictures bound to the film's entities`, `E4: clip 1/N staged and referenced`, `E4: clip 1/N written` ...
- the clip list fills with N finished clips (a ✎ badge, titles `Clip 1: <beat>`, 15 s), and the note `e4: planned and wrote N of N clip(s)` is in the status.
- every request and reply is in `ComfyUI\user\minimax_h3_master\e4\<run>\story\` (`calls.jsonl` in `<run>` lists them; `story\pictures\map.json` is the picture binding; `clips.json` is what was put into the clip list).
- a first run of the ninfer server loads the model once (about 20 s) and the whole film takes minutes, not seconds (the planner, the bible, one decision per clip, one writer per clip with up to 4 at a time, plus repairs).

If it fails, the error names the cause (no Node, no server-backed writer, no picture, E4's last stderr lines) and the run directory; running the same story again **resumes** from the stored plan, bible and picture binding.

## Roll back

Same moment rules as the update (empty queue, founder's OK for the restart):
```
cd <ext>
git checkout b12b03d          # or the branch the box was on, e.g. all-features
```
then restart ComfyUI. Notes:
- `user\minimax_h3_master\e4\` and `e4_node.txt` stay on disk and are not read by the old code; delete them if you like.
- A workflow saved while the branch was installed carries five more widget values before the panel's own empty `master_ui` value. The old code loads it fine (the extra values land on the DOM widget `master_ui` and are ignored); `story_engine` is simply absent.
- Clips already written by E4 stay as written (they are ordinary rewritten clips); `Rewrite again` on one of them uses `builder.md` on the planned ask.

## What was and was not tested

- Mock (replaying a stored real run through the real Node subprocess), builder-mode byte identity, the verify script, the Python and Node units: `tests/test_e4_engine.py`, `e4/bridge/test/bridge.test.mjs`.
- One story, end to end outside ComfyUI against the lane of the 5090 (`tests/e2e/e4_outside_comfyui.py`), with the extender's own code and the pack stubbed. See the PR description for the result.
- **Not tested here:** the extender's own private `ninfer-serve` session (the lane was used instead: same model and the same `/v1/messages` wire, but not the process the node would start), the Windows paths of the box (the Windows-sensitive spots of the vendored code are patched, see `e4\PATCHES.json`), the panel (JavaScript syntax-checked only), and rendering the produced prompts (unattached pictures that a clip does not cite are still attached to the render, see the README).
