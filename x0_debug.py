"""Opt-in per-step x0 dump for pass-1 sampling.

Enabled only while the flag file `<ComfyUI base>/user/master_x0_debug` exists. Every function here is wrapped so a
dump failure is logged and never reaches the render.
"""

import json
import logging
import os
import time

_LOG = logging.getLogger("minimax_h3_master_extender.x0_debug")

FLAG_NAME = "master_x0_debug"
DUMP_DIR_NAME = "master_x0_debug"
FRAME_FRACTIONS = (0.1, 0.5, 0.9)

_RUN_COUNTS = {}


def flag_path(base_path):
    return os.path.join(str(base_path), "user", FLAG_NAME)


def debug_enabled(base_path):
    try:
        return os.path.isfile(flag_path(base_path))
    except Exception:
        return False


def _current_prompt_id():
    try:
        import server
        pid = getattr(server.PromptServer.instance, "last_prompt_id", None)
        if pid:
            return str(pid)
    except Exception:
        pass
    return time.strftime("%Y%m%d-%H%M%S")


def dump_dir(output_dir, run_id):
    """`<output>/master_x0_debug/<run_id>`, with `_2`, `_3`... for further pass-1 calls (clips) of the same run."""
    n = _RUN_COUNTS.get(run_id, 0) + 1
    _RUN_COUNTS[run_id] = n
    name = run_id if n == 1 else f"{run_id}_{n}"
    return os.path.join(str(output_dir), DUMP_DIR_NAME, name)


def video_part(x):
    """Video stream of a (possibly nested AV) latent."""
    if getattr(x, "is_nested", False):
        return x.unbind()[0]
    if isinstance(x, (tuple, list)):
        return x[0]
    return x


def frame_indices(num_frames, fractions=FRAME_FRACTIONS):
    out = []
    for f in fractions:
        i = min(num_frames - 1, max(0, int(round(f * (num_frames - 1)))))
        if i not in out:
            out.append(i)
    return out


def step_stem(step, sigma):
    return f"step_{step:02d}_sigma_{sigma:.4f}"


class X0Dump:
    """Saves each pass-1 step's x0 as a `.pt`, then decodes a few frames per step once sampling is over."""

    def __init__(self, out_dir, sigmas, process_latent_out, save=None):
        self.out_dir = out_dir
        self.sigmas = [float(s) for s in sigmas]
        self.process_latent_out = process_latent_out
        self._save = save
        self.steps = []
        self.ok = True
        try:
            os.makedirs(out_dir, exist_ok=True)
            _LOG.info("x0 debug dump: writing to %s", out_dir)
        except Exception:
            _LOG.exception("x0 debug dump: cannot create %s, dump disabled", out_dir)
            self.ok = False

    def _write(self, obj, path):
        if self._save is None:
            import torch
            self._save = torch.save
        self._save(obj, path)

    def wrap(self, base):
        def callback(step, x0, x, total_steps):
            self.record(step, x0)
            if base is not None:
                return base(step, x0, x, total_steps)
        return callback

    def record(self, step, x0):
        if not self.ok:
            return
        try:
            idx = int(step) + 1
            sigma = self.sigmas[int(step)] if int(step) < len(self.sigmas) else float("nan")
            sigma_next = self.sigmas[int(step) + 1] if int(step) + 1 < len(self.sigmas) else float("nan")
            latent = self.process_latent_out(video_part(x0)).detach().cpu()
            path = os.path.join(self.out_dir, step_stem(idx, sigma) + ".pt")
            self._write({"x0": latent, "step": idx, "sigma": sigma, "sigma_next": sigma_next}, path)
            self.steps.append({"step": idx, "sigma": sigma, "sigma_next": sigma_next, "file": os.path.basename(path)})
            _LOG.info("x0 debug dump: step %d/%d sigma %.4f -> %s %s", idx, len(self.sigmas) - 1, sigma,
                      os.path.basename(path), tuple(latent.shape))
        except Exception:
            _LOG.exception("x0 debug dump: step %s failed, continuing", step)

    def save_final(self, samples):
        if not self.ok:
            return
        try:
            self._write({"samples": video_part(samples).detach().cpu()}, os.path.join(self.out_dir, "pass1_final.pt"))
        except Exception:
            _LOG.exception("x0 debug dump: final latent save failed")

    def decode_frames(self, vae, to_png=None):
        """Decode each saved step's x0 with `vae` and write PNGs for frames at 10/50/90%. Whole-latent decode: a
        causal video VAE gives different frames when fed a latent slice on its own, and pass 1 is small."""
        if not self.ok or vae is None:
            return
        meta = {"sigmas": self.sigmas, "steps": self.steps, "frames": {}}
        for rec in self.steps:
            try:
                import torch
                data = torch.load(os.path.join(self.out_dir, rec["file"]), map_location="cpu")
                lat = data["x0"]
                if lat.ndim == 4:
                    lat = lat.unsqueeze(0)
                with torch.no_grad():
                    video = vae.decode(lat)
                video = video.detach().float().cpu()
                if video.ndim == 5:
                    video = video[0]
                n = int(video.shape[0])
                picks = frame_indices(n)
                meta["frames"][str(rec["step"])] = picks
                for f in picks:
                    arr = (video[f].clamp(0, 1) * 255).round().to(torch.uint8).numpy()
                    p = os.path.join(self.out_dir, f"step_{rec['step']:02d}_frame_{f:03d}.png")
                    (to_png or _write_png)(arr, p)
                _LOG.info("x0 debug dump: step %d decoded frames %s of %d", rec["step"], picks, n)
                del video, lat
            except Exception:
                _LOG.exception("x0 debug dump: decode of step %s failed, continuing", rec.get("step"))
        try:
            with open(os.path.join(self.out_dir, "meta.json"), "w") as fh:
                json.dump(meta, fh, indent=1)
        except Exception:
            _LOG.exception("x0 debug dump: meta.json write failed")


def _write_png(arr, path):
    from PIL import Image
    Image.fromarray(arr).save(path)
