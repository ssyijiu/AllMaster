#!/usr/bin/env python3
"""build_html_blueprint.py — 管线产物 → 交互 HTML 图纸文件夹（一个页面：图纸视图可在平面俯视与 3D 豆板两种看法间切换）。

色板切换不做「MARD 色号 → 目标色板最近色」的二次映射（误差叠加），而是回到对齐阶段的中间态
重新落色：底稿按生产算法聚成 K 个颜色簇（Lab KMeans），每个豆格记下各簇面积票数；换色板时把
簇中心各自映射到目标色板最近色（CIEDE2000），同色票合并取多数。几何（内容尺寸 + 相位）沿用
alignment_search 已选好的对齐结果。颜色数量档位在默认簇上树状拆并，相邻档只动一个簇。

页面数据（window.DEMO_DATA）只打包簇中心 + 格内票数 + 全部色板，玩家点色板 / 调色数时浏览器现场计算。
另带一份搜索场（field：前景框内像素细簇标签 + 评估参照图 + 搜索参数），玩家在侧栏输入自定义方形边长 N 时，
浏览器按 alignment_search 同一套对齐搜索现场出新规格卡。

用法：
    python3 build_html_blueprint.py \
        --process-dir .wip/过程文件 \
        --pixel-art .wip/转换图/转换图.png \
        --source .wip/原图/原图.png [--source .wip/原图/原图2.png] \
        --task-name "捷风的胜利手势" \
        --output output

不传 --source 时页面不出现「原图」页签（文生图等没有原图的场景）。

产出 output/【点豆】捷风的胜利手势-10月15日_9点30分5秒.html：单个自包含文件（数据、three.js、图片全部内联），
玩家可直接转发，双击即开（3D 看法也不需要 http）。文件名带渲染时刻，同一任务多次修改不会互相覆盖。
底稿与原图保存在任务目录 .wip/ 下，供后续改图复用。
"""
from __future__ import annotations

import argparse
import base64
import io
import csv
import json
import re
import sys
import time
import zlib
from datetime import datetime
from html import escape
from pathlib import Path
from zoneinfo import ZoneInfo

import numpy as np
from PIL import Image
from skimage.color import deltaE_ciede2000, rgb2lab

SCRIPT_DIR = Path(__file__).resolve().parent
SKILL_DIR = SCRIPT_DIR.parent
sys.path.insert(0, str(SCRIPT_DIR))
import alignment_search as A  # noqa: E402

# [STYLE-PICKER] 规格页画风选择条：话术数据 + 各画风缩略图（assets/style-picker/<画风>.png，按画风库目录名命名）
STYLE_GUIDE_JSON = SKILL_DIR / "assets" / "style_guide.json"
STYLE_THUMB_DIR = SKILL_DIR / "assets" / "style-picker"


def style_guide_data(thumb_long_side: int = 260) -> dict:
    """读话术数据，给每个画风挂上缩略图 data URI。长边压到 thumb_long_side（JPEG），控制页面体积。"""
    guide = json.loads(STYLE_GUIDE_JSON.read_text(encoding="utf-8"))
    for s in guide.get("styles", []):
        p = STYLE_THUMB_DIR / f"{s['id']}.png"
        if not p.is_file():
            raise FileNotFoundError(f"画风缩略图缺失：{p}（放各画风预览图，文件名 = 画风库目录名）")
        with Image.open(p) as im:
            im = im.convert("RGB")
            im.thumbnail((thumb_long_side, thumb_long_side))
            buf = io.BytesIO()
            im.save(buf, "JPEG", quality=82)
        s["thumb"] = "data:image/jpeg;base64," + base64.b64encode(buf.getvalue()).decode("ascii")
    return guide


def official_card_data(long_side: int = 520) -> str:
    """画风弹层左侧的原图：各画风效果演示共用的同一张捷风原图（assets/style-picker/official.png），压成 JPEG data URI。"""
    p = STYLE_THUMB_DIR / "official.png"
    if not p.is_file():
        raise FileNotFoundError(f"画风条示例卡面缺失：{p}")
    with Image.open(p) as im:
        im = im.convert("RGB")
        im.thumbnail((long_side, long_side))
        buf = io.BytesIO()
        im.save(buf, "JPEG", quality=85)
    return "data:image/jpeg;base64," + base64.b64encode(buf.getvalue()).decode("ascii")

TEMPLATE_DIR = SCRIPT_DIR.parent / "templates"
PALETTES = SCRIPT_DIR / "palettes"
DEFAULT_PALETTE = SCRIPT_DIR / "palette_mard221.csv"

SIZES = ["36", "52", "78", "104", "156"]   # 固定档；其余（含玩家在页面里加的自定义方形）都是上限语义的自定义卡
HTML_TIMEZONE = ZoneInfo("Asia/Shanghai")
VOTE_SCALE = 1000      # 格内面积票数量化精度（每格总票 = 1000）
BUDGET_RATIOS = (0.6, 0.75, 0.9, 1.0, 1.2, 1.4, 1.6)   # 色数档位相对默认色数的倍率；实际档位按命中去重
CUSTOM_MIN_RATIO = 0.8   # 页面自定义方形：内容格数 n 在 ⌊0.8×边长⌋ 到边长之间搜（与 alignment_search.default_min_n 一致）
SPLIT_DEPTH = 3        # 每个默认簇最多递归二分三层（≤8 个细簇），决定「更多色」方向能走多远

# 海外品牌与 Artkal 调色板：(id, 显示名, 分组, 说明, 文件)
BEADCOLORS = [
    ("PERLER", "Perler", "海外", "标准 5mm", "perler.csv"),
    ("PERLER_MINI", "Perler Mini", "海外", "2.6mm", "perler_mini.csv"),
    ("HAMA", "Hama Midi", "海外", "5mm", "hama.csv"),
    ("HAMA_MINI", "Hama Mini", "海外", "2.5mm", "hama_mini.csv"),
    ("HAMA_MAXI", "Hama Maxi", "海外", "10mm", "hama_maxi.csv"),
    ("NABBI", "Nabbi", "海外", "5mm", "nabbi.csv"),
    ("ARTKAL_S", "Artkal S", "Artkal", "5mm 软豆", "artkal_s.csv"),
    ("ARTKAL_R", "Artkal R", "Artkal", "5mm 硬豆", "artkal_r.csv"),
    ("ARTKAL_C", "Artkal C", "Artkal", "2.6mm", "artkal_c.csv"),
    ("ARTKAL_A", "Artkal A", "Artkal", "2.6mm", "artkal_a.csv"),
    ("ARTKAL_M", "Artkal M", "Artkal", "2.6mm", "artkal_m.csv"),
    ("YANT", "Yant", "海外", "5mm", "yant.csv"),
]
# 国产品牌：与 MARD 同一套实物色，色号对照见 palettes/color_system_mapping.json，色值随 MARD
DOMESTIC = [("COCO", "COCO"), ("漫漫", "MANMAN"), ("盼盼", "PANPAN"), ("咪小窝", "MIXIAOWO")]


INCLUDE = re.compile(r"^/\* @include (\S+) \*/$", re.M)
ASSET_SRC = re.compile(r'src="(assets/[^"]+)"')
ASSET_URL = re.compile(r'url\("(assets/[^"]+)"\)')

# 文件名里不允许出现的字符（Windows/macOS/Linux 合并取严），以及首尾的点
UNSAFE_NAME_CHARS = re.compile(r'[/\\:*?"<>|\x00-\x1f]')


def html_file_name(task_name: str, rendered_at: str) -> str:
    """交付 HTML 的文件名：【点豆】{任务名}-{M月D日}_{H点M分S秒}.html。

    rendered_at 是页面副标题用的同一时刻（HTML_TIMEZONE），文件名与页面显示因此天然一致。
    时间只到月日与时分秒，不带年份、不补零；任务名撞名不做区分，版本区分靠页面内保存的 -vN。
    任务名保留原样，仅剔除文件系统非法字符，避免玩家自定任务名导致写盘失败。
    """
    safe = UNSAFE_NAME_CHARS.sub("", task_name).strip().strip(".")
    d = datetime.strptime(rendered_at, "%Y-%m-%d %H:%M:%S")
    stamp = f"{d.month}月{d.day}日_{d.hour}点{d.minute}分{d.second}秒"
    return f"【点豆】{safe}-{stamp}.html"


def img_data_uri(path: Path) -> str:
    """素材内联进页面。图片长边超过 alignment_search.MAX_SIDE 时等比缩小后再内联，页面体积不随原图无限增长；字体原样内联。"""
    mime = {"png": "image/png", "jpg": "image/jpeg", "jpeg": "image/jpeg", "webp": "image/webp", "woff2": "font/woff2"}
    ext = path.suffix.lower().lstrip(".")
    if ext not in mime:
        raise ValueError(f"不支持的素材格式：{path}")
    if ext == "woff2":
        return f"data:{mime[ext]};base64," + base64.b64encode(path.read_bytes()).decode("ascii")
    with Image.open(path) as im:
        big = max(im.size) > A.MAX_SIDE
    if not big:
        return f"data:{mime[ext]};base64," + base64.b64encode(path.read_bytes()).decode("ascii")
    im = A.open_image(path)
    buf = io.BytesIO()
    if im.mode in ("RGBA", "LA", "P"):
        im.convert("RGBA").save(buf, "PNG")
        kind = "image/png"
    else:
        im.convert("RGB").save(buf, "JPEG", quality=90)
        kind = "image/jpeg"
    return f"data:{kind};base64," + base64.b64encode(buf.getvalue()).decode("ascii")


SUBSTAGE = "↳"      # 进度行前缀：本脚本内部的子阶段；整段由外层管线用 `[阶段名] cmd` 宣告


def stage(name: str) -> float:
    """宣告一个子阶段：打印 `[↳ 名]` 供预览页分段时间，返回本时刻供调用方算本段耗时。"""
    now = time.perf_counter()
    print(f"[{SUBSTAGE} {name}]", flush=True)
    return now


def assemble_template(template: Path) -> str:
    """模板目录 = index.html 外壳 + css/、js/ 功能文件；外壳里每行 `/* @include 相对路径 */` 原位替换成该文件内容。"""
    def inline(m):
        part = template / m.group(1)
        if not part.is_file():
            raise FileNotFoundError(f"HTML 模板缺少功能文件：{part}")
        return part.read_text(encoding="utf-8").removesuffix("\n")
    html = INCLUDE.sub(inline, (template / "index.html").read_text(encoding="utf-8"))
    # 模板自带的小图（如编辑工具图标）以 src="assets/…"、字体以 CSS url("assets/…") 引用，内联成 data URI，保证单文件转发后不裂图
    html = ASSET_SRC.sub(lambda m: f'src="{img_data_uri(template / m.group(1))}"', html)
    return ASSET_URL.sub(lambda m: f'url("{img_data_uri(template / m.group(1))}")', html)


def render_html(template: Path, output: Path, task_name: str, rendered_at: str,
                inline: dict[str, str] | None = None) -> None:
    content = assemble_template(template)
    t = datetime.strptime(rendered_at, "%Y-%m-%d %H:%M:%S")
    created = f"{t.year}年{t.month}月{t.day}日 {t:%H:%M:%S}"
    for placeholder, value in {"{{TASK_NAME}}": escape(task_name), "{{RENDERED_AT}}": escape(created)}.items():
        if placeholder not in content:
            raise ValueError(f"HTML 模板缺少占位符：{placeholder}")
        content = content.replace(placeholder, value)
    for key, value in (inline or {}).items():
        marker = f"/* @inline {key} */"
        if marker not in content:
            raise ValueError(f"HTML 模板缺少内联点：{marker}")
        content = content.replace(marker, value)
    output.write_text(content, encoding="utf-8")


# ---------- 色板 ----------
def color(code, name, rgb):
    r, g, b = (int(v) for v in rgb)
    return {"code": code, "name": name, "rgb": [r, g, b], "hex": f"#{r:02X}{g:02X}{b:02X}"}


def _norm_code(code):
    """A01 → A1：各数据源 MARD 色号补零习惯不同，统一成不补零写法。"""
    head = code.rstrip("0123456789")
    tail = code[len(head):]
    return f"{head}{int(tail)}" if tail else code


def _hex_rgb(h):
    return int(h[1:3], 16), int(h[3:5], 16), int(h[5:7], 16)


def load_palettes(names_csv: Path):
    """MARD 9 档套装（默认 221 排第一）+ 国产 4 家 + 海外/Artkal 12 条线。MARD 前 221 色与 names_csv 同值。"""
    with (PALETTES / "mard291.csv").open(encoding="utf-8") as f:
        mard = {r["code"]: r["hex"] for r in csv.DictReader(f)}
    with names_csv.open(encoding="utf-8-sig") as f:
        names = {r["色号"].strip(): r["颜色名称"].strip() for r in csv.DictReader(f)}
    tiers = json.loads((PALETTES / "mard_tiers.json").read_text(encoding="utf-8"))["tiers"]
    pals = []
    for n, codes in tiers.items():
        cols = [color(c, names.get(c, c), _hex_rgb(mard[c])) for c in codes]
        sub = {"221": "默认 · 基础色", "291": "全色"}.get(n, "套装")
        pals.append(dict(id=f"MARD{n}", label=f"MARD {n}", tier=n, group="MARD", sub=sub, colors=cols))
    pals.sort(key=lambda p: p["id"] != "MARD221")   # 前端取 palettes[0] 为默认

    mapping = json.loads((PALETTES / "color_system_mapping.json").read_text(encoding="utf-8"))
    for brand, pid in DOMESTIC:
        cols = [color(v[brand], f"≈ MARD {_norm_code(v['MARD'])}", _hex_rgb(mard[_norm_code(v["MARD"])]))
                for v in mapping.values() if v.get(brand)]
        pals.append(dict(id=pid, label=brand, group="国产", sub="与 MARD 同色", colors=cols))

    for pid, label, group, sub, fname in BEADCOLORS:
        with (PALETTES / "beadcolors" / fname).open(encoding="utf-8") as f:
            cols = [color(row[0].strip(), row[1].strip(), row[3:6]) for row in csv.reader(f)]
        pals.append(dict(id=pid, label=label, group=group, sub=sub, colors=cols))

    for p in pals:
        rgb = np.array([c["rgb"] for c in p["colors"]], float)[None] / 255
        for c, lab in zip(p["colors"], rgb2lab(rgb)[0]):
            c["lab"] = [round(float(v), 3) for v in lab]
        p["sub"] = f"{p['sub']} · {len(p['colors'])} 色"
    return pals


# ---------- 簇与票数 ----------
def cluster_field(rgb, mask, max_colors, merge_close_colors=False, palette_path=DEFAULT_PALETTE):
    """复刻 alignment_search.palette_labels 的聚类，但停在簇级：返回像素簇标签与簇中心 Lab。"""
    from sklearn.cluster import KMeans
    labs = rgb2lab(rgb[mask].astype(float)[None, ...] / 255)[0]
    rng = np.random.default_rng(42)
    sample = labs[rng.choice(len(labs), min(50000, len(labs)), replace=False)]
    k = min(max_colors, len(np.unique(sample, axis=0)))
    model = KMeans(n_clusters=k, random_state=42, n_init=3).fit(sample)
    labels = np.zeros(mask.shape, np.int32)
    labels[mask] = model.predict(labs) + 1
    centers = model.cluster_centers_
    if merge_close_colors:
        centers = A.merge_close_centers(centers, np.bincount(labels[mask] - 1, minlength=k), palette_path)
    return labels, centers


def cell_votes(labels, k, bbox, board, sel):
    """按已选几何取每格各簇（0 = 背景）面积票数，并按生产逻辑居中放上方板。

    与 Sampler 积分图取样结果一致（浮点误差内），但不建 k 张全图积分图：每个像素按它与各格的
    重叠面积把权重直接累加到「格 × 簇」上。一个像素在每个轴上最多跨 ⌈1/pitch⌉+1 个格。"""
    n = sel["n"]
    left, top, pitch = A.geometry(bbox, n, sel["dx"], sel["dy"])
    spans = range(int(np.ceil(1 / pitch)) + 1)

    def axis(start, size):
        edges = start + np.arange(n + 1) * pitch
        p = np.arange(size)
        first = np.floor((p - start) / pitch).astype(int)
        cells, weights = [], []
        for off in spans:
            c = np.clip(first + off, 0, n - 1)
            w = np.clip(np.minimum(p + 1, edges[c + 1]) - np.maximum(p, edges[c]), 0, None)
            weights.append(np.where((first + off >= 0) & (first + off < n), w, 0.0))
            cells.append(c)
        return cells, weights

    (yc, yw), (xc, xw) = axis(top, labels.shape[0]), axis(left, labels.shape[1])
    lab = labels.ravel()
    acc = np.zeros(n * n * (k + 1))
    for cy, wy in zip(yc, yw):
        for cx, wx in zip(xc, xw):
            w = (wy[:, None] * wx[None, :]).ravel()
            hit = w > 0
            idx = (cy[:, None] * n + cx[None, :]).ravel()[hit] * (k + 1) + lab[hit]
            acc += np.bincount(idx, weights=w[hit], minlength=acc.size)
    votes = acc.reshape(n, n, k + 1)
    votes[..., 0] += np.maximum(0, pitch * pitch - votes.sum(axis=-1))
    full = np.zeros((board, board, k + 1))
    full[..., 0] = 1
    off = (board - n) // 2
    full[off:off + n, off:off + n] = votes / (pitch * pitch)
    return full


def encode_votes(full):
    """每格记全部非零簇票数（量化到 VOTE_SCALE）；纯背景格为空串。行内 '|' 分格，格内 '簇.票' 用 ',' 分。"""
    rows = []
    for row in full:
        cells = []
        for v in row:
            q = np.round(v * VOTE_SCALE).astype(int)
            if q[0] >= VOTE_SCALE:
                cells.append("")
                continue
            cells.append(",".join(f"{c}.{q[c]}" for c in np.argsort(-q) if q[c] > 0))
        rows.append("|".join(cells))
    return rows


def decode_votes(rows, k):
    out = []
    for row in rows:
        r = []
        for cell in row.split("|"):
            v = np.zeros(k + 1)
            if not cell:
                v[0] = VOTE_SCALE
            for part in cell.split(",") if cell else []:
                c, w = part.split(".")
                v[int(c)] = int(w)
            r.append(v)
        out.append(r)
    return np.array(out)


def ring_counts(flabels, mask, kf, pitch):
    """每个细簇在剪影外缘一圈 / 全图前景里的像素数（下标 0 为背景），供描边色识别；外缘宽度与 alignment_search 一致。"""
    ring, total = A.outline_ring(flabels, mask, kf + 1, pitch)
    return [int(v) for v in ring], [int(v) for v in total]

def resolve(votes, centers, palette, ring=None):
    """簇中心 → 色板最近色（CIEDE2000），同色票合并取多数，再做高光分票修正与描边断口补齐。与浏览器端 resolveGrid 一致。
    ring 为 (外缘计数, 全图计数)，按细簇；缺省时不做描边补齐。"""
    plab = np.array([c["lab"] for c in palette["colors"]])
    nearest = deltaE_ciede2000(centers[:, None, :], plab[None, :, :]).argmin(axis=1)
    uniq = np.unique(nearest)
    pooled = np.stack([votes[..., 0]] + [votes[..., 1:][..., nearest == u].sum(-1) for u in uniq], -1)
    ulab = np.vstack(([100.0, 0, 0], plab[uniq]))
    pick, _ = A.highlight_fix(pooled.argmax(-1), pooled.astype(float), ulab)
    if ring is not None:
        sums = [np.array([v[0]] + [np.asarray(v[1:])[nearest == u].sum() for u in uniq], float) for v in ring]
        family = A.outline_family(sums[0], sums[1], deltaE_ciede2000(ulab[:, None], ulab[None]))
        if family is not None:
            share = pooled / np.maximum(pooled.sum(-1, keepdims=True), 1e-9)
            pick, _ = A.outline_fix(pick, share, family)
    codes = [""] + [palette["colors"][u]["code"] for u in uniq]
    return [",".join(codes[i] for i in row) for row in pick]


# ---------- 局部修复覆盖层 ----------
def repair_overlay(path: Path, specs: dict, mard: dict) -> dict:
    """读局部修复产出的 page_repairs.json：{tag, sizes: {规格: [[行, 列, 色号或空串], ...]}}，行列从 1 起。

    页面在色板落色之后把这些格子盖上去：色号转成 Lab，换色板时取该色板最近色，空串表示这格不放豆；
    颜色数量档位不影响它们。tag 随修复内容变化，页面用它给本地存档换键，旧存档不会盖住修复版。"""
    raw = json.loads(path.read_text(encoding="utf-8"))
    by_code = {c["code"]: c["lab"] for c in mard["colors"]}
    sizes = {}
    for size, cells in raw["sizes"].items():
        if size not in specs:
            raise ValueError(f"修复覆盖层里的规格 {size} 不在本次图纸里")
        board = len(specs[size]["votes"])
        out = []
        for r, c, code in cells:
            if not (1 <= r <= board and 1 <= c <= board):
                raise ValueError(f"修复覆盖层坐标越界：{size} 格第 {r} 行第 {c} 列")
            if code and code not in by_code:
                raise ValueError(f"修复覆盖层色号不在 {mard['label']} 里：{code}")
            out.append([r - 1, c - 1, by_code[code] if code else None])
        sizes[size] = out
    return dict(tag=str(raw["tag"]), sizes=sizes)


# ---------- 页面现场计算自定义尺寸用的搜索场 ----------
def _pack(arr):
    return base64.b64encode(zlib.compress(np.ascontiguousarray(arr, np.uint8).tobytes(), 9)).decode("ascii")


def search_field(flabels, bbox, rgb, mask, centers, fine_parent, palette_csv, search_meta):
    """玩家在页面里输入自定义边长时，浏览器用它复刻 alignment_search.search 并按细簇出票数。

    labels：前景外接框内每像素的细簇标签（0 = 背景），与 specs 票数同一套细簇，出的票数直接接入色数档位与色板落色。
    searchOf / searchRgb：细簇 → 生产搜索用的调色板色（默认簇中心落到 MARD 221 最近色后合并，同 palette_labels）。
    ref：Evaluator 的评估参照图（RGB + 前景掩码作 alpha），打分逐项与 Evaluator.score 一致。"""
    x0, y0, x1, y1 = bbox
    crop = flabels[y0:y1, x0:x1]
    if crop.max() > 255:
        raise ValueError(f"细簇数超过 255，无法按 uint8 打包：{int(crop.max())}")
    _, pal_rgb = A.load_palette(palette_csv)
    plab = rgb2lab(pal_rgb.astype(float)[None, ...] / 255)[0]
    nearest = deltaE_ciede2000(centers[:, None, :], plab[None, :, :]).argmin(axis=1)
    uniq, inverse = np.unique(nearest, return_inverse=True)
    ev = A.Evaluator(rgb, mask, bbox, search_meta.get("evaluation_side", 384))
    ref = np.dstack([np.round(ev.ref * 255), ev.mask * 255])
    weights = search_meta.get("loss_weights", dict(color=0.5, edge=0.3, local=0.2))
    return dict(bbox=[int(v) for v in bbox], imgW=int(mask.shape[1]), imgH=int(mask.shape[0]), labels=_pack(crop),
                searchOf=[0] + [int(inverse[p]) + 1 for p in fine_parent],
                searchRgb=[[255, 255, 255]] + [[int(v) for v in pal_rgb[u]] for u in uniq],
                evalW=int(ref.shape[1]), evalH=int(ref.shape[0]), ref=_pack(ref),
                phases=int(search_meta.get("phases", 5)), sizeWeight=float(search_meta.get("size_weight", 0.025)),
                lossWeights=[weights["color"], weights["edge"], weights["local"]],
                customRatio=CUSTOM_MIN_RATIO, boardMin=A.BOARD_MIN, boardMax=A.BOARD_MAX, voteScale=VOTE_SCALE)


# ---------- 色数档位：默认簇上树状拆并，相邻档只动一簇 ----------
def _de(a, b):
    return float(deltaE_ciede2000(np.asarray(a, float)[None], np.asarray(b, float)[None])[0])


def _bisect(px):
    from sklearn.cluster import KMeans
    sub = px[np.random.default_rng(1).choice(len(px), min(8000, len(px)), replace=False)]
    if len(px) < 2 or len(np.unique(sub, axis=0)) < 2:
        return None
    return KMeans(2, random_state=42, n_init=3).fit(sub).predict(px)


def split_clusters(labs, parent_px, depth=SPLIT_DEPTH):
    """每个默认簇内递归二分 depth 层，叶子即细簇。splits 每项 = (所属默认簇, 左叶子, 右叶子, 父拆分下标 / -1)。"""
    fine_c, fine_parent, fine_px, splits = [], [], np.zeros(len(labs), int), []

    def grow(idx, c, level, parent_split):
        before = len(fine_c)
        lab = _bisect(labs[idx]) if level < depth else None
        if lab is None:
            fine_px[idx] = len(fine_c)
            fine_c.append(labs[idx].mean(0)); fine_parent.append(c)
            return list(range(before, len(fine_c)))
        me = len(splits); splits.append(None)
        left = grow(idx[lab == 0], c, level + 1, me)
        right = grow(idx[lab == 1], c, level + 1, me)
        splits[me] = (c, left, right, parent_split)
        return left + right

    for c in range(parent_px.max() + 1):
        grow(np.where(parent_px == c)[0], c, 0, -1)
    return np.array(fine_c), np.array(fine_parent), fine_px, splits


def budget_steps(fine_c, fine_parent, mass, k, splits):
    """产出 (step, 细簇分组)。0 = 默认；>0 按「较小一侧面积 × 色差」逐个启用树内二分（子拆分须等父拆分）；<0 默认簇间逐步合并。"""
    yield 0, fine_parent.copy()

    def gain(s):
        _, l, r, _ = splits[s]
        cl = np.average(fine_c[l], axis=0, weights=mass[l] + 1e-9)
        cr = np.average(fine_c[r], axis=0, weights=mass[r] + 1e-9)
        return min(mass[l].sum(), mass[r].sum()) * _de(cl, cr)

    gains = [gain(s) for s in range(len(splits))]
    ready = {s for s, sp in enumerate(splits) if sp[3] == -1}
    g, nxt, step = fine_parent.copy(), k, 0
    while ready:
        s = max(ready, key=lambda s: gains[s])
        ready.discard(s)
        if gains[s] <= 0:
            continue
        g = g.copy(); g[splits[s][2]] = nxt; nxt += 1; step += 1
        ready |= {t for t, sp in enumerate(splits) if sp[3] == s}
        yield step, g
    g, step = fine_parent.copy(), 0
    while len(set(g)) > 3:
        ids = sorted(set(g))
        cen = {i: np.average(fine_c[g == i], axis=0, weights=mass[g == i] + 1e-9) for i in ids}
        ms = {i: mass[g == i].sum() for i in ids}
        _, a, b = min((min(ms[a], ms[b]) * _de(cen[a], cen[b]), a, b) for n, a in enumerate(ids) for b in ids[n + 1:])
        keep, drop = (a, b) if ms[a] >= ms[b] else (b, a)
        g = g.copy(); g[g == drop] = keep; step -= 1
        yield step, g


def level_centers(g, fine_c, fine_parent, mass, centers):
    """每个细簇落色用的目标 Lab。默认档沿用生产簇中心（与生产图纸一致），其余用组内面积加权中心。"""
    if np.array_equal(g, fine_parent):
        return centers[fine_parent]
    cen = {i: np.average(fine_c[g == i], axis=0, weights=mass[g == i] + 1e-9) for i in set(g)}
    return np.array([cen[i] for i in g])


def distinct_colors(grid):
    return len({c for r in grid for c in r.split(",") if c})


def pick_levels(candidates, base_n, ratios):
    """每个倍率取色数最接近 round(base_n × 倍率) 的步（同色数取离默认最近的步），色数重复的档去掉。"""
    picked = {}
    for r in sorted(ratios):
        want = round(base_n * r)
        pool = [c for c in candidates if (c[0] > 0 if r > 1 else c[0] < 0)] if r != 1.0 else []
        if r == 1.0 or not pool:
            s, t, n = next(c for c in candidates if c[0] == 0)
        else:
            s, t, n = min(pool, key=lambda c: (abs(c[2] - want), abs(c[0])))
            if (n <= base_n) if r > 1 else (n >= base_n):
                continue   # 该方向到头了，不出重复档
        if n not in picked or s == 0:
            picked[n] = (s, t, n)
    return [picked[n] for n in sorted(picked)]


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--process-dir", type=Path, required=True, help="alignment_search 输出目录（含 {size}_k{N}/metrics.json）")
    ap.add_argument("--source", type=Path, action="append", help="原始输入图，可重复传入；文生图等没有原图时不传，页面不出现「原图」页签")
    ap.add_argument("--pixel-art", type=Path, required=True, help="像素底稿（alignment_search 的输入）")
    ap.add_argument("--palette", type=Path, default=DEFAULT_PALETTE, help="MARD 221 色板 CSV（取颜色中文名）")
    ap.add_argument("--task-name", required=True, help="WorkBuddy 在渲染 HTML 前拟定的本次任务名")
    ap.add_argument("--output", type=Path, required=True, help="输出目录")
    ap.add_argument("--sizes", nargs="+", default=SIZES, help="板规格列表：每边格数（板为正方形）")
    ap.add_argument("--default-size", type=str, default=None, help="默认展示规格（必须是 --sizes 之一；缺省优先 78，否则第一个）")
    ap.add_argument("--budget-ratios", type=float, nargs="+", default=list(BUDGET_RATIOS),
                    help="色数档位相对默认色数的倍率（默认档 1.0 恒在）")
    ap.add_argument("--repairs", type=Path, default=None, help="局部修复覆盖层（page_repairs.json），缺省不带")
    ap.add_argument("--art-style", default=None,
                    help="这张图按哪个预设画风生成（画风库目录名，如 chibi）；页面据此标出画风。自定义画风、修改过的图不传")
    ap.add_argument("--subject", choices=["character", "prop", "character-prop"], default="character",
                    help="主体类型；character/character-prop 为人像，prop 为非人像，页面可更正")
    args = ap.parse_args()
    args.task_name = args.task_name.strip()
    if not args.task_name:
        ap.error("--task-name 不能为空")
    guide = style_guide_data()
    if args.art_style is not None and args.art_style not in {s["id"] for s in guide.get("styles", [])}:
        ap.error(f"--art-style 不是预设画风：{args.art_style}")
    if args.subject == "prop" and any(s["id"] == args.art_style and s.get("scope") == "character" and s["id"] != "original"
                                      for s in guide.get("styles", [])):
        ap.error(f"--art-style {args.art_style} 只用于人像，非人像可用还原或自定义描述")
    guide["officialThumb"] = official_card_data()

    try:
        boards = [A.parse_board(s) for s in args.sizes]
    except ValueError as e:
        ap.error(str(e))

    stage("读取规格产物与色板")
    specs, max_colors, search_params = {}, None, {}
    merge_modes = set()
    for board in boards:
        name = A.board_name(board)
        d = next((p for p in args.process_dir.glob(f"{name}_k*") if (p / "metrics.json").is_file()), None)
        if d is None:
            print(f"⚠ 跳过 {name}：未找到 {args.process_dir}/{name}_k*/metrics.json")
            continue
        m = json.loads((d / "metrics.json").read_text(encoding="utf-8"))
        max_colors, search_params = m["max_colors"], m.get("search", {})
        merge_modes.add(m.get("merge_close_colors", False))
        specs[name] = dict(board=board, sel=m["selected"],
                           grid=(d / "grid_mard.csv").read_text(encoding="utf-8").splitlines())
    if not specs:
        raise SystemExit("没有找到任何可用的规格产物")

    if len(merge_modes) != 1:
        raise SystemExit("规格产物的近色合并开关不一致，请用相同参数重跑")
    merge_close_colors = merge_modes.pop()
    palettes = load_palettes(args.palette)
    mard = palettes[0]
    rgb, mask, bbox = A.foreground(A.open_image(args.pixel_art))
    stage("主色簇聚类")
    labels, centers = cluster_field(rgb, mask, max_colors, merge_close_colors, args.palette)
    labs = rgb2lab(rgb[mask].astype(float)[None, ...] / 255)[0]
    stage("细分簇树（簇内二分）")
    fine_c, fine_parent, fine_px, splits = split_clusters(labs, labels[mask] - 1)
    flabels = np.zeros(mask.shape, np.int32)
    flabels[mask] = fine_px + 1
    mass = np.bincount(fine_px, minlength=len(fine_c)).astype(float)
    kf = len(fine_c)

    t = stage("逐规格统计格内色票")
    data_specs, fine_votes, fine_ring = {}, {}, {}
    for name, sp in specs.items():
        enc = encode_votes(cell_votes(flabels, kf, bbox, sp["board"], sp["sel"]))
        fine_votes[name] = decode_votes(enc, kf)
        pitch = A.geometry(bbox, sp["sel"]["n"], sp["sel"]["dx"], sp["sel"]["dy"])[2]
        ring, total = ring_counts(flabels, mask, kf, pitch)
        fine_ring[name] = (ring, total)
        data_specs[name] = dict(votes=enc, contentW=sp["sel"]["content_width"], contentH=sp["sel"]["content_height"], ring=ring)
        print(json.dumps({"board": name, "seconds": round(time.perf_counter() - t, 1)}, ensure_ascii=False), flush=True)
        t = time.perf_counter()

    if args.default_size is not None and args.default_size not in data_specs:
        ap.error(f"--default-size 必须在 --sizes 里：{args.default_size}")
    default_size = args.default_size or ("78" if "78" in data_specs else next(iter(data_specs)))
    stage("扫描色数档位")
    candidates = []   # (step, 每个细簇目标 Lab, 默认规格下 MARD 221 用色数)
    for step, g in budget_steps(fine_c, fine_parent, mass, len(centers), splits):
        target = level_centers(g, fine_c, fine_parent, mass, centers)
        candidates.append((step, target, distinct_colors(resolve(fine_votes[default_size], target, mard, fine_ring[default_size]))))
    base = next(c for c in candidates if c[0] == 0)
    for name, sp in specs.items():
        grid = resolve(fine_votes[name], base[1], mard, fine_ring[name])
        diff = sum(a != b for ga, gb in zip(grid, sp["grid"]) for a, b in zip(ga.split(","), gb.split(",")))
        print(f"{name}: 默认档与 alignment_search 图纸差 {diff} 格（票数量化后两色打平的边界格）")
    picked = pick_levels(candidates, base[2], sorted(set(args.budget_ratios) | {1.0}))
    levels = [dict(step=s, isDefault=s == 0, centers=[[round(float(v), 3) for v in c] for c in t]) for s, t, _ in picked]
    print(f"{default_size} 规格 MARD 221 色数档位: " + " / ".join(f"{n}{'*' if s == 0 else ''}" for s, _, n in picked))

    stage("拼装 HTML 与 data.js")
    out = args.output
    out.mkdir(parents=True, exist_ok=True)
    rendered_at = datetime.now(HTML_TIMEZONE).strftime("%Y-%m-%d %H:%M:%S")
    size_list = [dict(key=A.board_name(board), w=board, h=board,
                      isCustom=A.board_name(board) not in SIZES)
                 for board in sorted(boards)]
    size_list = [s for s in size_list if s["key"] in data_specs]
    data = dict(taskName=args.task_name, renderedAt=rendered_at, sizes=size_list, defaultSize=default_size,
                levels=levels, specs=data_specs, ringAll=next(iter(fine_ring.values()))[1], palettes=palettes, images=[img_data_uri(s) for s in (args.source or [])],
                field=search_field(flabels, bbox, rgb, mask, centers, fine_parent, args.palette, search_params))
    if args.repairs is not None:
        data["repairs"] = repair_overlay(args.repairs, data_specs, mard)
    if args.art_style is not None:
        data["artStyle"] = args.art_style
    data["subject"] = args.subject
    data_js = "window.DEMO_DATA = " + json.dumps(data, ensure_ascii=False, separators=(",", ":")) + ";\n"
    index = out / html_file_name(args.task_name, rendered_at)
    render_html(
        TEMPLATE_DIR / "perler_blueprint", index, args.task_name, rendered_at,
        inline={
            "DATA_JS": data_js,
            "THREE_JS": (TEMPLATE_DIR / "vendor" / "three.min.js").read_text(encoding="utf-8"),
            "PIXEL_ART_PNG": img_data_uri(args.pixel_art),
            "STYLE_GUIDE_JSON": "window.STYLE_GUIDE_JSON = " + json.dumps(guide, ensure_ascii=False, separators=(",", ":")) + ";",
        },
    )
    print(f"✓ HTML 图纸: {index}（单文件，可直接转发） ({len(data_specs)} 规格, 色板 {len(palettes)} 套 / "
          f"{sum(len(p['colors']) for p in palettes)} 色, {index.stat().st_size / 1024 / 1024:.1f}MB)")


if __name__ == "__main__":
    main()