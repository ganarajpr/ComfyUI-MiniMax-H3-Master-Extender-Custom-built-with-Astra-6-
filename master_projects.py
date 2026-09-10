import json
from pathlib import Path
import re
import shutil

from aiohttp import web
import folder_paths
import nodes
from server import PromptServer

from .motion_context_disk import _ensure_cache_root, _preview_temp_root


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


def clear_project_cache(owners, final_ids):
    if not isinstance(owners, list) or not owners or len(owners) > 100:
        raise ValueError("Provide the active Master node IDs.")
    if not isinstance(final_ids, list) or len(final_ids) > 100:
        raise ValueError("Invalid Final Decode node IDs.")
    ids = owners + final_ids
    if any(not isinstance(value, str) or not re.fullmatch(r"[A-Za-z0-9_-]{1,80}", value) for value in ids):
        raise ValueError("Invalid node ID.")
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


@PromptServer.instance.routes.post("/minimax_master/clear_cache")
async def clear_cache(request):
    body = await request.json()
    if not isinstance(body, dict):
        return web.json_response({"error": "Invalid cache request."}, status=400)
    if PromptServer.instance.prompt_queue.get_tasks_remaining():
        return web.json_response({"error": "Wait for the running and queued jobs to finish before clearing cache or switching projects."}, status=409)
    try:
        clear_project_cache(body.get("owners"), body.get("final_ids", []))
    except ValueError as error:
        return web.json_response({"error": str(error)}, status=400)
    return web.json_response({"ok": True})
