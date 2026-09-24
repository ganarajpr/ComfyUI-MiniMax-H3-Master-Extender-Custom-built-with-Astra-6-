import hashlib
import json
from pathlib import Path
import re
import shutil

from aiohttp import web
import folder_paths
import nodes
from server import PromptServer

from .motion_context_disk import _chain_paths, _ensure_cache_root, _preview_temp_root


def load_reference_images(refs_json):
    config = json.loads(refs_json) if isinstance(refs_json, str) else refs_json
    if not isinstance(config, dict):
        raise ValueError("Invalid reference picture configuration.")
    images = config.get("images", [])
    if not isinstance(images, list) or len(images) > 9:
        raise ValueError("Reference images must contain at most nine picture slots.")
    root = Path(folder_paths.get_input_directory()).resolve()
    refs = {}
    for index, name in enumerate(images):
        if name is None:
            continue
        if not isinstance(name, str) or not name:
            raise ValueError(f"Picture {index + 1}: invalid image filename.")
        path = Path(folder_paths.get_annotated_filepath(name)).resolve()
        if not path.is_relative_to(root) or not path.is_file():
            raise ValueError(f"Picture {index + 1}: image is missing or outside the input folder. Attach it again.")
        refs[f"ref_image_{index}"] = nodes.LoadImage().load_image(str(path))[0][:1].clone()
    return refs


def _clip_identity(clip):
    """What a clip *is* for caching: the text, length and LoRAs it renders from."""
    try:
        duration = float(clip.get("duration", 15))
    except (TypeError, ValueError):
        duration = str(clip.get("duration"))
    loras = clip.get("loras", [])
    if isinstance(loras, str):
        try:
            loras = json.loads(loras)
        except ValueError:
            pass
    return [str(clip.get("prompt", "")), duration, loras]


def _chain_key(clips):
    """Disk-cache key of a project: its opening clip.

    Keyed by content instead of node id, so two workflows (tabs) whose Master
    nodes share an id no longer share -- and truncate -- one cache chain. The
    same project reopened later finds its chain again.
    """
    blob = json.dumps(_clip_identity(clips[0]), sort_keys=True, default=str)
    return "c_" + hashlib.sha256(blob.encode()).hexdigest()[:16]


def _clip_fingerprint(previous, clip, seed):
    """Fingerprint of clip i = its inputs + seed + everything before it."""
    blob = json.dumps([previous or "", _clip_identity(clip), int(seed)], sort_keys=True, default=str)
    return hashlib.sha256(blob.encode()).hexdigest()[:16]


def clip_cache_states(clips):
    """Per clip: 'cached' (on disk, rendered from exactly these inputs), 'stale' (on disk,
    inputs changed since), 'unverified' (on disk, cached before fingerprints) or 'none'.

    Reads the chain manifest as-is (no recovery), so it is safe while a clip renders.
    """
    data_path, manifest_path = _chain_paths(f"master_v2_{_chain_key(clips)}")
    try:
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        manifest = {}
    count = len(manifest.get("segments", []))
    stored = list(manifest.get("clip_fingerprints") or [])[:count]
    states, previous = [], None
    for index, clip in enumerate(clips):
        try:
            previous = _clip_fingerprint(previous, clip, clip.get("seed", 42))
        except (TypeError, ValueError):
            previous = None
        if index >= count:
            states.append("none")
        elif index >= len(stored) or not stored[index]:
            states.append("unverified")
        else:
            states.append("cached" if stored[index] == previous else "stale")
    return states, _clip_videos(data_path, count)


def _clip_videos(data_path, count):
    """The per-clip final segments Final Decode joins, as /view parameters (output folder only)."""
    final_dir = Path(data_path).with_suffix(".final.video")
    try:
        subfolder = final_dir.resolve().relative_to(Path(folder_paths.get_output_directory()).resolve()).as_posix()
    except ValueError:
        return [None] * count
    videos = []
    for index in range(count):
        found = sorted(final_dir.glob(f"ref2va_{index:04d}.mp4"))
        videos.append({"filename": found[0].name, "subfolder": subfolder,
                       "mtime": int(found[0].stat().st_mtime)} if found else None)
    return videos


def clear_project_cache(clips_list, final_ids):
    """Delete the disk-cache chains of the given projects (their clips_json).

    The chain key is derived from the clips exactly as the Master node does,
    so a button only ever clears the project currently on screen -- never a
    chain another tab/workflow is building under the same node id.
    """
    if not isinstance(clips_list, list) or len(clips_list) > 100:
        raise ValueError("Invalid project clips.")
    if not isinstance(final_ids, list) or len(final_ids) > 100:
        raise ValueError("Invalid Final Decode node IDs.")
    if any(not isinstance(value, str) or not re.fullmatch(r"[A-Za-z0-9_-]{1,80}", value) for value in final_ids):
        raise ValueError("Invalid node ID.")
    owners = []
    for raw in clips_list:
        try:
            clips = json.loads(raw) if isinstance(raw, str) else raw
        except ValueError:
            continue
        if isinstance(clips, list) and clips and isinstance(clips[0], dict):
            owners.append(_chain_key(clips))
    root = _ensure_cache_root().resolve()
    preview_root = _preview_temp_root().resolve()
    targets = []
    for owner in set(owners):
        for stem in (f"chain_master_v2_{owner}", f"chain_master_v2_{owner}_draft"):
            targets.extend(root.glob(stem + ".*"))
    for final_id in set(final_ids):
        targets.extend(preview_root.glob(f"h3_motion_preview_{final_id}_*.mp4"))
        targets.append(preview_root / f"h3_motion_preview_{final_id}.mp4")
    for path in set(targets):
        # Resolve before removing directories; never follow a cache link outside its root.
        resolved = path.resolve()
        if not any(resolved.is_relative_to(base) and resolved != base for base in (root, preview_root)):
            raise ValueError("Cache path points outside the cache directory.")
        if path.is_dir():
            shutil.rmtree(path)
        else:
            path.unlink(missing_ok=True)


@PromptServer.instance.routes.post("/minimax_master/cache_status")
async def cache_status(request):
    body = await request.json()
    clips = json.loads(body.get("clips") or "[]") if isinstance(body, dict) else None
    if not isinstance(clips, list) or not clips or not all(isinstance(c, dict) for c in clips):
        return web.json_response({"states": [], "videos": []})
    states, videos = clip_cache_states(clips)
    return web.json_response({"states": states, "videos": videos})


@PromptServer.instance.routes.post("/minimax_master/clear_cache")
async def clear_cache(request):
    body = await request.json()
    if not isinstance(body, dict):
        return web.json_response({"error": "Invalid cache request."}, status=400)
    if PromptServer.instance.prompt_queue.get_tasks_remaining():
        return web.json_response({"error": "Wait for the running and queued jobs to finish before clearing cache or switching projects."}, status=409)
    try:
        clear_project_cache(body.get("clips", []), body.get("final_ids", []))
    except ValueError as error:
        return web.json_response({"error": str(error)}, status=400)
    return web.json_response({"ok": True})
