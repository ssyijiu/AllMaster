#!/usr/bin/env python3
"""同源 A/B：同一张原始模型输出分别跑 v5/v6 规整，量化边缘污染并出对照图。

用法：python 同源AB对比.py 原始输出1.png [原始输出2.png ...]
（原始输出 = PERLER_BLOCK_CLEANUP=0 跑出来的未规整转换图，见 取原始输出.sh）
v5 基线脚本从 git 历史（7bd5d28 上一版）临时导出；当前版 block_cleanup.py 直接用仓库工作区文件。
"""
import os
import subprocess
import sys
import tempfile
import numpy as np
from PIL import Image, ImageDraw
from scipy.ndimage import distance_transform_edt

PY = os.path.expanduser("~/.workbuddy/binaries/python/envs/default/bin/python")
_REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
_V6_REL = "apps/pixelart/assert/valorant-perler-src/valorant-perler/scripts/block_cleanup.py"
V6 = os.path.join(_REPO, _V6_REL)


def _export_v5():
    """v5 = block_cleanup v6 落地前的上一版，从 git 历史导出到临时文件。"""
    out = os.path.join(tempfile.gettempdir(), "block_cleanup_v5.py")
    r = subprocess.run(["git", "-C", _REPO, "show", "7bd5d28~1:" + _V6_REL],
                       capture_output=True, text=True)
    if r.returncode != 0 or not r.stdout.strip():
        return None
    with open(out, "w", encoding="utf-8") as f:
        f.write(r.stdout)
    return out


V5 = _export_v5()


def edge_contamination(path):
    """贴边带（距背景≤4px）颜色与其 10px 内部邻域颜色的偏离占比。"""
    a = np.asarray(Image.open(path).convert("RGBA"))
    opaque = a[..., 3] > 128
    if not opaque.any() or opaque.all():
        return None
    d_bg = distance_transform_edt(opaque)
    ring = opaque & (d_bg <= 4)
    deep = opaque & (d_bg >= 10)
    if not ring.any() or not deep.any():
        return None
    _, (iy, ix) = distance_transform_edt(~deep, return_indices=True)
    rgb = a[..., :3].astype(int)
    diff = np.abs(rgb[ring] - rgb[iy[ring], ix[ring]]).sum(axis=1)
    return float((diff > 120).mean())   # 三通道合计偏差>120 视为异色


def flatness(path):
    a = np.asarray(Image.open(path).convert("RGBA"))
    opaque = a[..., 3] > 128
    rgb = a[..., :3].astype(np.int32)
    sx = np.diff(rgb[..., 0], axis=1) == 0
    sy = np.diff(rgb[..., 0], axis=0) == 0
    for c in (1, 2):
        sx &= np.diff(rgb[..., c], axis=1) == 0
        sy &= np.diff(rgb[..., c], axis=0) == 0
    mx = opaque[:, :-1] & opaque[:, 1:]
    my = opaque[:-1, :] & opaque[1:, :]
    return (sx[mx].mean() + sy[my].mean()) / 2


def preview(path, h=430):
    im = Image.open(path).convert("RGBA")
    bg = Image.new("RGBA", im.size, (255, 255, 255, 255))
    bg.alpha_composite(im)
    a = np.asarray(bg.convert("RGB"))
    op = np.asarray(im)[..., 3] > 128
    ys, xs = np.where(op)
    if len(xs):
        pad = 10
        a = a[max(0, ys.min() - pad):ys.max() + pad, max(0, xs.min() - pad):xs.max() + pad]
    im2 = Image.fromarray(a)
    s = h / im2.height
    return im2.resize((max(1, round(im2.width * s)), h), Image.LANCZOS)


def ab_for(raw):
    base = os.path.dirname(raw)
    outs = []
    if V5:
        outs.append(("v5", V5, f"{base}/clean_v5.png"))
    outs.append(("v6", V6, f"{base}/clean_v6.png"))
    for _, script, dst in outs:
        subprocess.run([PY, script, raw, dst], capture_output=True, text=True)
    for tag, p in [("原始", raw)] + [(t, o) for t, _, o in outs]:
        ec = edge_contamination(p)
        print(f"  {tag}: 平坦度={flatness(p):.3f} 边缘异色率={ec if ec is None else round(ec, 3)}")
    imgs = [("RAW", preview(raw))] + [(t, preview(o)) for t, _, o in outs]
    H = max(im.height for _, im in imgs) + 24
    W = sum(im.width for _, im in imgs) + 20 * (len(imgs) - 1)
    sheet = Image.new("RGB", (W, H), "white")
    dr = ImageDraw.Draw(sheet)
    x = 0
    for t, im in imgs:
        sheet.paste(im, (x, 24))
        dr.text((x + 4, 4), t, fill=("red" if t == "v6" else "black"))
        x += im.width + 20
    out = f"{base}/ab_sheet.png"
    sheet.save(out)
    print(f"  对照图: {out}")


if __name__ == "__main__":
    for raw in sys.argv[1:]:
        print(f"== {raw} ==")
        ab_for(raw)
