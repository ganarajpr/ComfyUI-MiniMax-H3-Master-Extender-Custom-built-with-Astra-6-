#!/usr/bin/env python3
"""Analyse a master_x0_debug dump: at which pass-1 step does structure/motion settle?

    python tools/x0_step_analysis.py <dump_dir> [--json out.json] [--sheet out.png] [--pool-space 4] [--pool-time 2]

Needs numpy; torch only to read the .pt files; Pillow only for the contact sheet. CPU is fine.
"""

import argparse
import glob
import json
import os
import re
import sys

import numpy as np

EPS = 1e-8
STEP_RE = re.compile(r"step_(\d+)_sigma_([0-9.]+)\.pt$")


def lowpass(x, ps=4, pt=2):
    """Average-pool [C,T,H,W] by ps spatially and pt temporally (edges cropped to a multiple)."""
    c, t, h, w = x.shape
    ps = max(1, min(ps, h, w))
    pt = max(1, min(pt, t))
    t2, h2, w2 = t // pt * pt, h // ps * ps, w // ps * ps
    x = x[:, :t2, :h2, :w2]
    return x.reshape(c, t2 // pt, pt, h2 // ps, ps, w2 // ps, ps).mean(axis=(2, 4, 6))


def highpass(x, ps=4, pt=2):
    """x minus its low-pass, upsampled back by repetition."""
    lp = lowpass(x, ps, pt)
    c, t, h, w = x.shape
    ps = max(1, min(ps, h, w))
    pt = max(1, min(pt, t))
    up = np.repeat(np.repeat(np.repeat(lp, pt, axis=1), ps, axis=2), ps, axis=3)
    return x[:, :up.shape[1], :up.shape[2], :up.shape[3]] - up


def tdiff(x):
    return x[:, 1:] - x[:, :-1]


def rel_l2(a, b):
    return float(np.linalg.norm((a - b).ravel()) / (np.linalg.norm(b.ravel()) + EPS))


def features(x, ps=4, pt=2):
    lp = lowpass(x, ps, pt)
    return {"structure": lp, "detail": highpass(x, ps, pt), "motion": tdiff(lp)}


def analyse(steps, ps=4, pt=2):
    """steps: list of (step, sigma, ndarray [C,T,H,W]) in step order. Returns one row per step."""
    steps = sorted(steps, key=lambda s: s[0])
    feats = [features(x, ps, pt) for _, _, x in steps]
    final = feats[-1]
    rows = []
    for i, (step, sigma, _) in enumerate(steps):
        row = {"step": step, "sigma": sigma}
        for k in ("structure", "detail", "motion"):
            row[f"{k}_vs_final"] = rel_l2(feats[i][k], final[k])
        for k in ("structure", "detail", "motion"):
            row[f"{k}_vs_prev"] = rel_l2(feats[i][k], feats[i - 1][k]) if i else None
        rows.append(row)
    return rows


def format_table(rows):
    cols = ["structure_vs_final", "detail_vs_final", "motion_vs_final",
            "structure_vs_prev", "detail_vs_prev", "motion_vs_prev"]
    head = ["step", "sigma", "struct/fin", "detail/fin", "motion/fin", "struct/prev", "detail/prev", "motion/prev"]
    lines = ["  ".join(f"{h:>11}" for h in head)]
    for r in rows:
        cells = [f"{r['step']:>11d}", f"{r['sigma']:>11.4f}"]
        cells += [f"{'-':>11}" if r[c] is None else f"{r[c]:>11.4f}" for c in cols]
        lines.append("  ".join(cells))
    return "\n".join(lines)


def load_dump(dump_dir):
    import torch
    out = []
    for path in glob.glob(os.path.join(dump_dir, "step_*_sigma_*.pt")):
        m = STEP_RE.search(os.path.basename(path))
        if not m:
            continue
        d = torch.load(path, map_location="cpu")
        x = d["x0"].float().numpy()
        if x.ndim == 5:
            x = x[0]
        out.append((int(m.group(1)), float(m.group(2)), x))
    return sorted(out, key=lambda s: s[0])


def contact_sheet(dump_dir, out_path, thumb_w=320):
    from PIL import Image, ImageDraw
    files = {}
    for p in glob.glob(os.path.join(dump_dir, "step_*_frame_*.png")):
        m = re.search(r"step_(\d+)_frame_(\d+)\.png$", os.path.basename(p))
        if m:
            files.setdefault(int(m.group(1)), {})[int(m.group(2))] = p
    if not files:
        return False
    steps = sorted(files)
    frames = sorted({f for d in files.values() for f in d})
    first = Image.open(next(iter(next(iter(files.values())).values())))
    tw = thumb_w
    th = max(1, round(first.height * tw / first.width))
    label_w = 90
    sheet = Image.new("RGB", (label_w + tw * len(frames), th * len(steps)), "black")
    draw = ImageDraw.Draw(sheet)
    for r, s in enumerate(steps):
        draw.text((6, r * th + 6), f"step {s}", fill="white")
        for c, f in enumerate(frames):
            p = files[s].get(f)
            if p:
                sheet.paste(Image.open(p).convert("RGB").resize((tw, th)), (label_w + c * tw, r * th))
    sheet.save(out_path)
    return True


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("dump_dir")
    ap.add_argument("--json", default=None, help="default: <dump_dir>/analysis.json")
    ap.add_argument("--sheet", default=None, help="default: <dump_dir>/contact_sheet.png")
    ap.add_argument("--pool-space", type=int, default=4)
    ap.add_argument("--pool-time", type=int, default=2)
    a = ap.parse_args(argv)

    steps = load_dump(a.dump_dir)
    if len(steps) < 2:
        print(f"need at least 2 step_*.pt files in {a.dump_dir}", file=sys.stderr)
        return 1
    rows = analyse(steps, a.pool_space, a.pool_time)
    print(format_table(rows))
    jpath = a.json or os.path.join(a.dump_dir, "analysis.json")
    with open(jpath, "w") as fh:
        json.dump({"dump_dir": a.dump_dir, "pool_space": a.pool_space, "pool_time": a.pool_time, "rows": rows}, fh, indent=1)
    print(f"wrote {jpath}")
    spath = a.sheet or os.path.join(a.dump_dir, "contact_sheet.png")
    print(f"wrote {spath}" if contact_sheet(a.dump_dir, spath) else "no frame PNGs found, contact sheet skipped")
    return 0


if __name__ == "__main__":
    sys.exit(main())
