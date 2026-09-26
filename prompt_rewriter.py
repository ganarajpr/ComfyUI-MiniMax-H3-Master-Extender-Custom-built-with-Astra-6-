"""Built-in prompt rewriter for the Master Extender.

Turns each clip's panel prompt into a MiniMax-H3 description before the run
renders anything, using the engines of the MiniMax-H3-Prompt-Rewriter pack
(an optional dependency, resolved lazily so this node imports without it):

- one ``llama-server`` per run, holding the writer GGUF (+ its mmproj) once;
- the reference pictures are captioned on it, several at a time, and cached by
  image hash so a re-run does not look at them again;
- every pending clip is written on the same server, several at a time, with
  llama.cpp's thinking budget applied to the writer only (captions never think);
- the rewritten text replaces ``clip["prompt"]``, the original is kept in
  ``clip["prompt_raw"]`` and ``clip["prompt_rewritten"]`` marks it done, so the
  next run leaves it alone until the panel restores the raw text.

Nothing here touches the render path: when ``rewrite_mode`` is off the extender
behaves exactly as before.
"""

from __future__ import annotations

import hashlib
import importlib
import json
import logging
import os
import sys
import threading
import time
import types
from concurrent.futures import ThreadPoolExecutor

_LOG = logging.getLogger("minimax_h3_master_extender.rewriter")

PACK_MODULE = "MiniMax-H3-Prompt-Rewriter-ComfyUI"
PACK_SUB = "minimax_h3_rewriter"
MISSING = "(install MiniMax-H3-Prompt-Rewriter-ComfyUI for the built-in rewriter)"

MODES = ["off", "pending clips", "all clips"]
TASKS = ["auto", "Ref2VA", "T2VA"]
CAPTION_LENGTHS = ["brief", "standard", "detailed"]
CONTINUITY = ["off", "raw asks"]

CONTINUITY_RULE = (
    "\n\nContinuity: the task message may carry a 'previous_clips' block. Those are the earlier "
    "clips of the same continuous video, in order, already rendered. The target video begins "
    "exactly where the last of them ends: keep the subjects, wardrobe, setting, lighting and "
    "visual style continuous with them, do not re-describe or repeat their events, and do not "
    "count them as shots of this clip."
)

CAPTION_TOKENS = 512
CAPTION_CTX_GUESS = 8192

_LOCK = threading.Lock()


# --------------------------------------------------------------------------- pack


def _pack_root() -> str:
    return os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), PACK_MODULE)


def available() -> bool:
    return os.path.isdir(os.path.join(_pack_root(), PACK_SUB))


def _mod(name: str):
    """One module of the rewriter pack, imported the way ComfyUI did (or would).

    ComfyUI registers the pack under its folder name, so its modules are
    ``<folder>.minimax_h3_rewriter.<name>`` in ``sys.modules``. If the pack has
    not been loaded yet (custom nodes load alphabetically and this one sorts
    first), a bare package pointing at the folder is enough to import the
    sub-package without running the pack's own node registration.
    """
    full = f"{PACK_MODULE}.{PACK_SUB}.{name}"
    found = sys.modules.get(full)
    if found is not None:
        return found
    with _LOCK:
        if PACK_MODULE not in sys.modules:
            root = _pack_root()
            if not os.path.isdir(root):
                raise RuntimeError(MISSING)
            shell = types.ModuleType(PACK_MODULE)
            shell.__path__ = [root]
            sys.modules[PACK_MODULE] = shell
        return importlib.import_module(full)


def writer_choices() -> list[str]:
    try:
        return list(_mod("nodes").writer_choices())
    except Exception:
        return [MISSING]


def captioner_choices() -> list[str]:
    try:
        return list(_mod("nodes").captioner_choices())
    except Exception:
        return [MISSING]


# --------------------------------------------------------------------------- helpers


def _same_file(a: str, b: str) -> bool:
    return bool(a and b) and os.path.normcase(os.path.abspath(a)) == os.path.normcase(os.path.abspath(b))


def _writer_file(nodes, paths, label: str) -> str:
    choice = nodes._resolve_writer_choice(label)
    path = choice.reference if choice.local else (paths.catalog_file(choice.reference, choice.file) or "")
    return path if path and os.path.isfile(path) else ""


def _captioner_files(nodes, paths, label: str) -> tuple[str, str]:
    choice = nodes._resolve_captioner_choice(label)
    if choice.local:
        return choice.reference, choice.mmproj
    model = paths.catalog_file(choice.reference, choice.file) or ""
    mmproj = paths.catalog_file(choice.reference, choice.mmproj) or ""
    if model and mmproj and os.path.isfile(model) and os.path.isfile(mmproj):
        return model, mmproj
    return "", ""


def _image_key(tensor, model_path: str, length: str) -> str:
    """A stable id for one reference picture as the captioner will see it."""
    import torch

    frame = tensor[0] if tensor.dim() == 4 else tensor
    small = (frame.detach().float().clamp(0, 1) * 255).to(torch.uint8).cpu().numpy().tobytes()
    digest = hashlib.sha1(small).hexdigest()
    return hashlib.sha1(f"{digest}|{os.path.basename(model_path)}|{length}".encode()).hexdigest()


VIDEO_FRAMES = 8
VIDEO_FPS = 24.0


def _video_key(frames, model_path: str, length: str) -> str:
    """A stable id for one reference clip: the frames the captioner will sample."""
    import torch

    count = int(frames.shape[0]) if frames.dim() == 4 else 1
    if count <= VIDEO_FRAMES:
        picks = list(range(count))
    else:
        step = (count - 1) / (VIDEO_FRAMES - 1)
        picks = sorted({int(round(i * step)) for i in range(VIDEO_FRAMES)})
    digest = hashlib.sha1()
    for index in picks:
        frame = frames[index] if frames.dim() == 4 else frames
        digest.update((frame.detach().float().clamp(0, 1) * 255).to(torch.uint8).cpu().numpy().tobytes())
    return hashlib.sha1(f"video|{count}|{digest.hexdigest()}|{os.path.basename(model_path)}|{length}".encode()).hexdigest()


def _ordered(items: dict, prefix: str) -> list[tuple[int, object]]:
    out = []
    for key, value in (items or {}).items():
        if value is None or not str(key).startswith(prefix):
            continue
        try:
            out.append((int(str(key).rsplit("_", 1)[1]), value))
        except ValueError:
            continue
    out.sort(key=lambda item: item[0])
    return out


def _cache_path() -> str:
    import folder_paths

    folder = os.path.join(folder_paths.get_user_directory(), "minimax_h3_master")
    os.makedirs(folder, exist_ok=True)
    return os.path.join(folder, "ref_captions.json")


def _load_cache() -> dict:
    try:
        with open(_cache_path(), "r", encoding="utf-8") as handle:
            data = json.load(handle)
        return data if isinstance(data, dict) else {}
    except Exception:
        return {}


def _save_cache(cache: dict) -> None:
    try:
        path = _cache_path()
        tmp = path + ".tmp"
        with open(tmp, "w", encoding="utf-8") as handle:
            json.dump(cache, handle, indent=1, ensure_ascii=False)
        os.replace(tmp, path)
    except Exception:
        _LOG.debug("caption cache not saved", exc_info=True)


def _ordered_refs(refs: dict) -> list[tuple[int, object]]:
    """``(slot, tensor)`` pairs in slot order; slot 0 is ``<Picture 1>``."""
    out = []
    for key, value in (refs or {}).items():
        if value is None or not str(key).startswith("ref_image_"):
            continue
        try:
            out.append((int(str(key).rsplit("_", 1)[1]), value))
        except ValueError:
            continue
    out.sort(key=lambda item: item[0])
    return out


def source_of(clip: dict) -> str:
    """The text a rewrite starts from: the kept original, or the prompt as typed."""
    raw = clip.get("prompt_raw")
    if clip.get("prompt_rewritten") and isinstance(raw, str):
        return raw
    prompt = clip.get("prompt") if isinstance(clip.get("prompt"), str) else ""
    # Flag cleared but the text still is the previous rewrite: start from the original,
    # not from the model's own output.
    if isinstance(raw, str) and raw.strip() and prompt and prompt == clip.get("rewrite_text"):
        return raw
    return prompt


def fingerprint(source: str, duration: float, resolution: str, task: str, system_given: str,
                image_keys: list, writer_file: str, caption_model: str, length: str, previous: str = "") -> str:
    """What a rewrite depends on. A clip whose stored fingerprint differs is out of date.

    Raw text, duration, aspect, task, the system prompt, every reference picture
    (by content hash, in slot order), the writer, and the captioner with its
    caption length. Sampling settings and the thinking budget are left out on
    purpose: changing those should not throw every clip's text away.
    """
    payload = json.dumps([
        source.strip(), f"{float(duration):.2f}", resolution, task, system_given.strip(),
        list(image_keys), os.path.basename(writer_file or ""), os.path.basename(caption_model or ""), length,
        previous.strip(),
    ], ensure_ascii=False)
    return hashlib.sha1(payload.encode("utf-8")).hexdigest()


def continuity_block(clips: list, index: int, continuity: str) -> str:
    """What the writer is told about clips 1..index-1: their raw asks, in order.

    Short, in the user's words, and available before any rewrite runs, so
    pending clips can still be written in parallel.
    """
    if continuity == "off" or index <= 0:
        return ""
    lines = []
    for i, clip in enumerate(clips[:index]):
        if not isinstance(clip, dict):
            continue
        ask = " ".join(source_of(clip).split())
        if ask:
            lines.append(f"Clip {i + 1} ({float(clip.get('duration', 15) or 15):g}s): {ask}")
    return "\n".join(lines)


def with_previous(user_prompt: str, previous: str) -> str:
    """Insert a 'previous_clips:' block ahead of the original prompt in the task message."""
    if not previous:
        return user_prompt
    block = f"previous_clips:\n{previous}\n"
    marker = "original_prompt:"
    at = user_prompt.rfind(marker)
    if at < 0:
        return f"{user_prompt.rstrip()}\n{block}"
    return user_prompt[:at] + block + user_prompt[at:]


def pending_indices(clips: list, mode: str, current: dict | None = None) -> list[int]:
    """Which clips this run rewrites.

    ``all clips``: every clip with text. ``pending clips``: clips never
    rewritten, marked pending by the panel, or whose inputs changed since (the
    stored fingerprint in ``rewrite_meta`` differs from ``current[index]``); a
    rewrite from before fingerprints existed counts as out of date once.
    """
    wanted = []
    for index, clip in enumerate(clips):
        if not isinstance(clip, dict):
            continue
        source = source_of(clip)
        if not source.strip():
            continue
        if mode == "all clips" or not clip.get("prompt_rewritten"):
            wanted.append(index)
            continue
        if current is not None:
            stored = (clip.get("rewrite_meta") or {}).get("fingerprint")
            if stored != current.get(index):
                wanted.append(index)
    return wanted


# --------------------------------------------------------------------------- main


def rewrite_clips(clips: list, refs: dict, settings: dict, *, aspect_text: str, progress_cb=None, stream_cb=None,
                  videos: dict | None = None, video_audios: dict | None = None, audios: dict | None = None) -> list[str]:
    """Rewrite the pending clips in place. Returns human-readable notes.

    ``settings`` is the extender's kwargs (the ``rewrite_*`` widgets and the
    ``rewrite_system_prompt_in`` socket). ``refs`` is the extender's reference
    dict (``ref_image_N`` -> IMAGE). ``aspect_text`` is the target frame size,
    e.g. ``"1280x736"``; the pack turns it into the guide's aspect label.
    ``stream_cb(index, clip_id, phase, text, source)`` is called while a clip is being
    written -- phase ``thinking`` / ``writing`` with the text so far, then
    ``done`` with the final answer -- so the panel can show the rewrite live.
    ``videos`` (``ref_video_N`` -> 24 fps frame batch) are described from a few
    sampled frames as <Video k>; ``video_audios`` / ``audios`` cannot be heard by a
    vision-only captioner, so they enter the reference block as labelled but
    undescribed <Audio j> lines, numbered the way the core node numbers them.
    """
    mode = str(settings.get("rewrite_mode", "off"))
    if mode == "off":
        return []
    if not available():
        raise RuntimeError(
            "rewrite_mode is on, but the MiniMax-H3-Prompt-Rewriter-ComfyUI pack is not installed "
            "beside this node. Install it (or set rewrite_mode to off)."
        )

    def say(stage, message, pct=0.0):
        _LOG.info("Rewriter: %s", message)
        if progress_cb is not None:
            try:
                progress_cb(stage, message, pct)
            except Exception:
                pass

    nodes = _mod("nodes")
    paths = _mod("paths")
    guides = _mod("guides")
    guide_prompt = _mod("guide_prompt")
    fields = _mod("fields")
    checks = _mod("checks")
    mtmd = _mod("mtmd_engine")
    aspect = _mod("aspect")
    constants = _mod("constants")

    writer_label = str(settings.get("rewrite_writer_model", ""))
    caption_label = str(settings.get("rewrite_caption_model", ""))
    length = str(settings.get("rewrite_caption_length", "standard"))
    greedy = bool(settings.get("rewrite_greedy", True))
    temperature = float(settings.get("rewrite_temperature", 0.7))
    max_new_tokens = int(settings.get("rewrite_max_new_tokens", 4096))
    seed = int(settings.get("rewrite_seed", 42))
    thinking = bool(settings.get("rewrite_thinking", False))
    budget = int(settings.get("rewrite_reasoning_budget", 4096))
    budget_message = str(settings.get("rewrite_reasoning_budget_message", "") or "")
    slots = max(1, int(settings.get("rewrite_parallel", 3)))
    continuity = str(settings.get("rewrite_previous_clips", "raw asks"))
    if continuity not in CONTINUITY:
        continuity = "raw asks"
    system_given = str(settings.get("rewrite_system_prompt_in") or "").strip() or str(settings.get("rewrite_system_prompt") or "").strip()

    if writer_label.startswith("(") or not writer_label:
        raise RuntimeError("rewrite_writer_model: pick a GGUF from the list (the rewriter pack's model list).")

    writer_file = _writer_file(nodes, paths, writer_label)
    ordered = _ordered_refs(refs)
    ordered_videos = _ordered(videos, "ref_video_")
    ordered_audios = _ordered(audios, "ref_audio_")
    soundtracks = {slot for slot, _value in _ordered(video_audios, "ref_video_audio_")}
    any_refs = bool(ordered or ordered_videos or ordered_audios)
    task = str(settings.get("rewrite_task", "auto"))
    if task == "auto":
        task = "Ref2VA" if any_refs else "T2VA"
    if task == "Ref2VA" and not any_refs:
        say("rewrite", "no references connected, writing T2VA instead of Ref2VA")
        task = "T2VA"

    model_path = mmproj_path = ""
    if task != "T2VA" or writer_file:
        if caption_label and not caption_label.startswith("("):
            model_path, mmproj_path = _captioner_files(nodes, paths, caption_label)
    if task != "T2VA" and not model_path:
        raise RuntimeError(
            "rewrite_caption_model: the captioner (a GGUF with its mmproj) must already be on disk "
            "for the built-in rewriter; pick a local entry."
        )

    writer_on_server = bool(writer_file) and _same_file(writer_file, model_path)
    if thinking and not writer_on_server:
        say("rewrite", "thinking applies only when writer and caption model are the same GGUF; writing without it")
    reasoning = {"enabled": thinking and writer_on_server, "budget": budget, "message": budget_message}
    writer_budget = max_new_tokens + (max(budget, 0) if reasoning["enabled"] else 0)
    resolution = aspect.resolve(aspect_text, "16:9")

    # ---- what is out of date --------------------------------------------------
    image_keys = [(slot, _image_key(tensor, model_path, length)) for slot, tensor in ordered] if task != "T2VA" else []
    video_keys = [(slot, _video_key(frames, model_path, length)) for slot, frames in ordered_videos] if task != "T2VA" else []
    audio_marks = ([f"soundtrack:{slot}" for slot, _f in ordered_videos if slot in soundtracks]
                   + [f"audio:{slot}" for slot, _a in ordered_audios]) if task != "T2VA" else []
    current = {}
    for index, clip in enumerate(clips):
        if isinstance(clip, dict):
            current[index] = fingerprint(
                source_of(clip), float(clip.get("duration", 15) or 15), resolution, task, system_given,
                [key for _slot, key in image_keys] + [key for _slot, key in video_keys] + audio_marks,
                writer_file, model_path, length,
                previous=continuity_block(clips, index, continuity),
            )
    todo = pending_indices(clips, mode, current)
    if not todo:
        _LOG.info("Rewriter: nothing to do (every clip prompt is rewritten, up to date, or empty)")
        return ["rewriter: nothing pending"]
    reasons = []
    for index in todo:
        clip = clips[index]
        if not clip.get("prompt_rewritten"):
            reasons.append(f"clip {index + 1}: pending")
        elif mode == "all clips":
            reasons.append(f"clip {index + 1}: all clips")
        else:
            reasons.append(f"clip {index + 1}: inputs changed")
    _LOG.info("Rewriter: %s", "; ".join(reasons))

    guide = "" if system_given else guides.text(guide_prompt.GUIDE_FOR_MODE[task], True, None)

    # ---- captions -------------------------------------------------------------
    cache = _load_cache()
    captions: dict[int, str] = {}
    to_describe: list[tuple[int, object, str]] = []
    video_captions: dict[int, str] = {}
    videos_to_describe: list[tuple[int, object, str]] = []
    if task != "T2VA":
        for (slot, tensor), (_slot, key) in zip(ordered, image_keys):
            hit = cache.get(key)
            if isinstance(hit, dict) and hit.get("caption"):
                captions[slot] = hit["caption"]
            else:
                to_describe.append((slot, tensor, key))
        for (slot, frames), (_slot, key) in zip(ordered_videos, video_keys):
            hit = cache.get(key)
            if isinstance(hit, dict) and hit.get("caption"):
                video_captions[slot] = hit["caption"]
            else:
                videos_to_describe.append((slot, frames, key))

    # The KV pool must hold the parallel writers (guide + block + answer each).
    stand_in = "" if task == "T2VA" else "x" * (1600 * max(len(ordered) + len(ordered_videos) + len(ordered_audios), 1))
    longest = max((source_of(clips[i]) for i in todo), key=len)
    rough = guide_prompt.build_messages(guide, task, longest, resolution, 15.0, stand_in, system=system_given)
    if continuity != "off" and len(clips) > 1:
        rough[1]["content"] += "\n" + continuity_block(clips, len(clips) - 1, "raw asks")
    writer_ctx = guide_prompt.context_needed(rough, writer_budget)
    writers_at_once = min(len(todo), slots) if writer_on_server else 1
    pool_ctx = writer_ctx * writers_at_once if writer_on_server else 0
    caption_jobs = len(to_describe) + len(videos_to_describe)
    caption_slots = max(1, min(caption_jobs, slots)) if caption_jobs else 1
    server_slots = max(caption_slots, writers_at_once)

    started = time.time()
    notes: list[str] = []
    open_session = caption_jobs > 0 or writer_on_server
    if open_session:
        session = mtmd.session(
            model_path, mmproj_path,
            assets=caption_jobs, attachments=VIDEO_FRAMES if videos_to_describe else 1,
            gpu_layers=-1, n_ctx=0, device="auto", backend="auto", auto_download=True,
            progress=None, slots=server_slots, force=writer_on_server,
            reasoning=reasoning if writer_on_server else None, pool_ctx=pool_ctx,
        )
    else:
        import contextlib

        session = contextlib.nullcontext(None)

    with session as server:
        if to_describe:
            question = nodes.caption_question("Picture", length)
            say("rewrite", f"describing {len(to_describe)} reference picture(s)"
                + (f" at once on {caption_slots} slots" if server is not None and caption_slots > 1 else ""), 0.05)

            def describe(item):
                slot, tensor, key = item
                text = mtmd.describe(
                    model_path=model_path, mmproj_path=mmproj_path, instruction=question,
                    image=tensor, max_frames=8, gpu_layers=-1, n_ctx=0, seed=seed, greedy=True,
                    max_new_tokens=CAPTION_TOKENS, temperature=0.7, top_p=0.8, top_k=20,
                    device="auto", backend="auto", auto_download=True, progress=None, server=server,
                )
                return slot, key, " ".join((text or "").split())

            if server is not None and caption_slots > 1:
                with ThreadPoolExecutor(max_workers=caption_slots) as pool:
                    results = list(pool.map(describe, to_describe))
            else:
                results = [describe(item) for item in to_describe]
            for slot, key, caption in results:
                captions[slot] = caption
                if caption:
                    cache[key] = {"caption": caption, "model": os.path.basename(model_path), "length": length, "at": time.time()}
                else:
                    notes.append(f"Picture {slot + 1}: empty caption")
            _save_cache(cache)

        if videos_to_describe:
            video_question = nodes.caption_question("Video", length)
            say("rewrite", f"describing {len(videos_to_describe)} reference video(s) from {VIDEO_FRAMES} sampled frames each", 0.15)

            def describe_video(item):
                slot, frames, key = item
                count = int(frames.shape[0]) if frames.dim() == 4 else 1
                instruction = f"{mtmd.clip_note(min(count, VIDEO_FRAMES), count / VIDEO_FPS)}\n\n{video_question}"
                text = mtmd.describe(
                    model_path=model_path, mmproj_path=mmproj_path, instruction=instruction,
                    image=frames, max_frames=VIDEO_FRAMES, gpu_layers=-1, n_ctx=0, seed=seed, greedy=True,
                    max_new_tokens=CAPTION_TOKENS, temperature=0.7, top_p=0.8, top_k=20,
                    device="auto", backend="auto", auto_download=True, progress=None, server=server,
                )
                return slot, key, " ".join((text or "").split())

            if server is not None and caption_slots > 1 and len(videos_to_describe) > 1:
                with ThreadPoolExecutor(max_workers=caption_slots) as pool:
                    video_results = list(pool.map(describe_video, videos_to_describe))
            else:
                video_results = [describe_video(item) for item in videos_to_describe]
            for slot, key, caption in video_results:
                video_captions[slot] = caption
                if caption:
                    cache[key] = {"caption": caption, "model": os.path.basename(model_path), "length": length, "kind": "video", "at": time.time()}
                else:
                    notes.append(f"Video {slot + 1}: empty caption")
            _save_cache(cache)

        # The reference block in the core node's label order: pictures, then each
        # video (its soundtrack's <Audio j> right before it), then standalone audio.
        lines = []
        if task != "T2VA":
            for slot, _tensor in ordered:
                lines.append(f"Picture {slot + 1}: {captions.get(slot, '')}".rstrip())
            audio_no = 0
            for k, (slot, _frames) in enumerate(ordered_videos, start=1):
                if slot in soundtracks:
                    audio_no += 1
                    lines.append(f"Audio {audio_no}: the soundtrack of Video {k} (voice and sound to reuse; not described here)")
                lines.append(f"Video {k}: {video_captions.get(slot, '')}".rstrip())
            for _slot, _audio in ordered_audios:
                audio_no += 1
                lines.append(f"Audio {audio_no}: an attached audio reference (voice or sound to reuse; not described here)")
        block = "\n".join(lines)

        # ---- writing ----------------------------------------------------------
        say("rewrite", f"writing {len(todo)} clip prompt(s) as {task}"
            + (f" with thinking (budget {budget})" if reasoning["enabled"] else "")
            + (f", {writers_at_once} at once" if writers_at_once > 1 else ""), 0.3)

        pack_settings = dict(nodes.DEFAULT_OPTIONS)
        pack_settings.update(max_new_tokens=max_new_tokens, temperature=temperature)
        names = guide_prompt.FIELDS_FOR_MODE[task]

        def write_one(index: int) -> tuple[int, str, str, float]:
            clip = clips[index]
            clip_id = clip.get("id")
            source = source_of(clip)
            duration = float(clip.get("duration", 15) or 15)
            messages = guide_prompt.build_messages(guide, task, source, resolution, duration, block, system=system_given)
            previous = continuity_block(clips, index, continuity)
            if previous:
                messages[0]["content"] = messages[0]["content"].rstrip() + CONTINUITY_RULE
                messages[1]["content"] = with_previous(messages[1]["content"], previous)

            last = {"at": 0.0}

            def stream(phase, text, force=False):
                if stream_cb is None:
                    return
                now = time.time()
                if not force and now - last["at"] < 0.3:
                    return
                last["at"] = now
                try:
                    stream_cb(index, clip_id, phase, text, source)
                except Exception:
                    _LOG.debug("stream callback failed", exc_info=True)

            def on_text(whole):
                stream("writing", whole)
                return bool(checks.looping(whole))

            def on_reasoning(whole):
                stream("thinking", whole)

            stream("thinking" if reasoning["enabled"] else "writing", "", force=True)
            t0 = time.time()
            if server is not None and writer_on_server:
                text = server.chat(
                    messages, seed=seed, greedy=greedy, max_new_tokens=writer_budget,
                    temperature=temperature, top_p=0.8, top_k=20, repeat_penalty=1.05,
                    enable_thinking=reasoning["enabled"],
                    on_text=on_text,
                    on_reasoning=on_reasoning if reasoning["enabled"] else None,
                )
            else:
                progress = _mod("progress").NodeProgress(None)
                text = nodes.run_messages(writer_label, messages, greedy, seed, False, pack_settings, progress, label=task)
            text = constants.answer_only((text or "").replace("\r\n", "\n")).strip()
            stream("done", text, force=True)
            return index, source, text, time.time() - t0

        if server is not None and writer_on_server and writers_at_once > 1:
            with ThreadPoolExecutor(max_workers=writers_at_once) as pool:
                written = list(pool.map(write_one, todo))
        else:
            written = [write_one(index) for index in todo]

    for index, source, text, seconds in written:
        clip = clips[index]
        if not text:
            notes.append(f"Clip {index + 1}: rewriter returned nothing, prompt left as typed")
            continue
        sections = fields.split_fields(text, names)
        missing = fields.missing(sections, names)
        if missing:
            notes.append(f"Clip {index + 1}: missing {', '.join(missing)}")
        clip["prompt_raw"] = source
        clip["prompt"] = text
        clip["rewrite_text"] = text
        clip["prompt_rewritten"] = True
        clip["validated"] = False
        clip["rewrite_meta"] = {
            "model": os.path.basename(writer_file or writer_label),
            "task": task,
            "thinking": bool(reasoning["enabled"]),
            "budget": budget if reasoning["enabled"] else 0,
            "seconds": round(seconds, 1),
            "at": time.strftime("%Y-%m-%d %H:%M:%S"),
            "fingerprint": current.get(index),
        }
        _LOG.info("Rewriter: clip %d rewritten in %.1f s (%d chars)", index + 1, seconds, len(text))

    total = time.time() - started
    say("rewrite", f"rewrote {len(written)} clip(s) in {total:.0f} s", 1.0)
    notes.insert(0, f"rewriter: {len(written)} clip(s), {len(to_describe) + len(videos_to_describe)} new caption(s), {total:.0f} s")
    return notes
