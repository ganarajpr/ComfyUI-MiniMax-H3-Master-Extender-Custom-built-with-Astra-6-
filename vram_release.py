"""Give the card back: the extender's own VRAM holders, released on ComfyUI's unload path.

ComfyUI's ``unload_all_models`` (what ``POST /free`` with ``unload_models`` and the
rewriter's pre-launch step both call) knows nothing of what this pack keeps in
module-level caches, so a finished H3 job left about 6 GB reserved and an external
``ninfer-serve`` could not fit. Modules register a callback for each such cache;
``install`` makes ComfyUI's unload run them, then collect garbage and return the
allocator's blocks to the driver.
"""

import gc
import logging

_LOG = logging.getLogger("MiniMaxH3Master.vram_release")

_CALLBACKS = []
_WRAPPED_FLAG = "_h3_master_vram_release"


def register(callback):
    if callback not in _CALLBACKS:
        _CALLBACKS.append(callback)
    return callback


def release(reason=""):
    """Run every registered release, then collect and empty the CUDA caches. Never raises."""
    for callback in list(_CALLBACKS):
        try:
            callback()
        except Exception:
            _LOG.warning("vram_release: %s failed", getattr(callback, "__qualname__", callback), exc_info=True)
    gc.collect()
    try:
        import torch

        if torch.cuda.is_available():
            torch.cuda.empty_cache()
            torch.cuda.ipc_collect()
    except Exception:
        _LOG.debug("vram_release: CUDA cache not emptied", exc_info=True)
    if reason:
        _LOG.info("vram_release: released the extender's cached memory (%s)", reason)


def install(model_management=None):
    """Wrap ``unload_all_models`` once so it also runs :func:`release`. Returns True when wrapped now."""
    if model_management is None:
        try:
            import comfy.model_management as model_management
        except Exception:
            return False
    original = getattr(model_management, "unload_all_models", None)
    if original is None or getattr(original, _WRAPPED_FLAG, False):
        return False

    def unload_all_models(*args, **kwargs):
        result = original(*args, **kwargs)
        release("unload_all_models")
        return result

    setattr(unload_all_models, _WRAPPED_FLAG, True)
    unload_all_models.__wrapped__ = original
    model_management.unload_all_models = unload_all_models
    return True
