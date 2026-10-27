#!/usr/bin/env python3
"""repair.py — 对已交付的拼豆图纸做局部修复：放大 → 对比 → 认可后重建 HTML。

三个子命令，按顺序用，每一步都只读或只写图纸工作目录下的 .wip/repair/：

    # 1. 放大。不带 --box 出整幅带行列号的定位图；带 --box 和 --part 开一轮修复，出底稿与格子并排的局部放大图
    python3 repair.py zoom --work-dir <work_dir> --size 52
    python3 repair.py zoom --work-dir <work_dir> --size 52 --box 10,14,18,38 --part 左右眼

    # 2. 对比。校验本轮 changes.json，出修复前 / 修复后 / 改动高亮三栏对比图。不动任何已交付文件
    python3 repair.py compare --work-dir <work_dir> --changes <轮次目录>/changes.json

    # 3. 重建。玩家认可对比图后才运行：记入累计修复，生成一份新的 HTML，原 HTML 保留
    python3 repair.py apply --work-dir <work_dir> --changes <轮次目录>/changes.json --approval "<玩家认可的原话>"

行列号从 1 起，与图纸页标尺一致；--box 写 起始行,起始列,结束行,结束列（含两端）。
「当前图纸」= 该规格的初始矩阵（grid_mard.csv）叠加此前已认可的修复（.wip/repair/repairs.json）。
"""
from __future__ import annotations

import argparse
import hashlib
import json
import re
import subprocess
import sys
from datetime import datetime
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFont

PERLER_SCRIPTS = Path(__file__).resolve().parents[2] / "valorant-perler" / "scripts"
sys.path.insert(0, str(PERLER_SCRIPTS))
import alignment_search as A  # noqa: E402

PALETTE_CSV = PERLER_SCRIPTS / "palette_mard221.csv"
BUILD_HTML = PERLER_SCRIPTS / "build_html_blueprint.py"
FONT_PATHS = [
    "/usr/share/fonts/google-noto-cjk/NotoSansCJKsc-Regular.otf",
    "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc",
    "/System/Library/Fonts/PingFang.ttc",
    "C:/Windows/Fonts/msyh.ttc",
    "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
]
BG = (246, 247, 250)
EMPTY = (255, 255, 255)
LINE = (200, 204, 212)
INK = (35, 41, 55)
RED, GREEN, BOX = (230, 40, 40), (20, 170, 60), (255, 140, 0)
UNSAFE = re.compile(r'[/\\:*?"<>|\x00-\x1f\s]+')


def font(size):
    for p in FONT_PATHS:
        if Path(p).is_file():
            try:
                return ImageFont.truetype(p, size)
            except OSError:
                continue
    return ImageFont.load_default()


# ---------- 工作目录 ----------
class Work:
    def __init__(self, root: Path):
        self.root = root.resolve()
        self.wip = self.root / ".wip"
        self.process = self.wip / "过程文件"
        self.pixel_art = self.wip / "转换图" / "转换图.png"
        self.repair = self.wip / "repair"
        self.ledger = self.repair / "repairs.json"
        run = self.wip / "运行记录.json"
        self.run = json.loads(run.read_text(encoding="utf-8")) if run.is_file() else {}
        if not self.pixel_art.is_file() or not self.process.is_dir():
            raise SystemExit(f"不是一份完整的图纸工作目录（缺 .wip/转换图/转换图.png 或 .wip/过程文件/）：{self.root}")

    def spec_dir(self, size: str) -> Path:
        d = next((p for p in sorted(self.process.glob(f"{size}_k*")) if (p / "metrics.json").is_file()), None)
        if d is None:
            have = sorted(p.name.split("_k")[0] for p in self.process.glob("*_k*"))
            raise SystemExit(f"没有 {size} 规格的图纸产物；可用规格：{'、'.join(have)}")
        return d

    def sizes(self) -> list[str]:
        return sorted({p.name.split("_k")[0] for p in self.process.glob("*_k*") if (p / "metrics.json").is_file()},
                      key=lambda s: A.parse_board(s))

    def ledger_data(self) -> dict:
        if self.ledger.is_file():
            return json.loads(self.ledger.read_text(encoding="utf-8"))
        return {"rounds": []}

    def base_grid(self, size: str) -> list[list[str]]:
        rows = (self.spec_dir(size) / "grid_mard.csv").read_text(encoding="utf-8").splitlines()
        return [r.split(",") for r in rows]

    def current_grid(self, size: str) -> list[list[str]]:
        """初始矩阵叠加已认可修复，按认可顺序依次覆盖。"""
        g = self.base_grid(size)
        for rnd in self.ledger_data()["rounds"]:
            if rnd["size"] == size:
                for c in rnd["changes"]:
                    g[c["row"] - 1][c["col"] - 1] = c["to"]
        return g


def palette():
    codes, rgb = A.load_palette(PALETTE_CSV)
    return {c: tuple(int(v) for v in rgb[i]) for i, c in enumerate(codes)}


def cell_to_pixel(work: Work, size: str):
    """返回 f(row0, col0) -> 底稿上该格的 (x0, y0, x1, y1)；板上居中留出的空边也能算（落在底稿外）。"""
    m = json.loads((work.spec_dir(size) / "metrics.json").read_text(encoding="utf-8"))
    sel, board = m["selected"], A.parse_board(size)
    _, _, bbox = A.foreground(Image.open(work.pixel_art))
    left, top, pitch = A.geometry(bbox, sel["n"], sel["dx"], sel["dy"])
    start = (board - sel["n"]) // 2

    def f(r, c):
        x0, y0 = left + (c - start) * pitch, top + (r - start) * pitch
        return x0, y0, x0 + pitch, y0 + pitch
    return f


def parse_box(text, h, w):
    try:
        r0, c0, r1, c1 = (int(v) for v in text.split(","))
    except ValueError:
        raise SystemExit("--box 格式：起始行,起始列,结束行,结束列（从 1 起，含两端），例如 10,14,18,38")
    r0, r1 = sorted((r0, r1)); c0, c1 = sorted((c0, c1))
    if r0 < 1 or c0 < 1 or r1 > h or c1 > w:
        raise SystemExit(f"--box 超出图纸范围（{h} 行 × {w} 列）")
    return r0, c0, r1, c1


# ---------- 画图 ----------
def draw_grid(grid, pal, box, cell, labels=True, tick=1, codes=False):
    """把 box（1 起含端）内的格子画成色块，外圈留行列号。返回 (图, 左边距, 上边距)。"""
    r0, c0, r1, c1 = box
    rows, cols = r1 - r0 + 1, c1 - c0 + 1
    pad = max(26, cell + 6) if labels else 0
    img = Image.new("RGB", (pad + cols * cell + 2, pad + rows * cell + 2), BG)
    d = ImageDraw.Draw(img)
    f_lab, f_code = font(max(11, min(18, cell // 2))), font(max(9, cell // 3))
    for j in range(rows):
        for i in range(cols):
            code = grid[r0 - 1 + j][c0 - 1 + i]
            x, y = pad + i * cell, pad + j * cell
            rgb = pal.get(code, EMPTY) if code else EMPTY
            d.rectangle((x, y, x + cell, y + cell), fill=rgb, outline=LINE if cell >= 6 else None)
            if codes and code and cell >= 26:
                lum = 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2]
                d.text((x + cell / 2, y + cell / 2), code, font=f_code, anchor="mm",
                       fill=(20, 28, 36) if lum > 140 else (245, 242, 236))
    if labels:
        for i in range(cols):
            n = c0 + i
            if n % tick == 0 or n in (c0, c1):
                d.text((pad + i * cell + cell / 2, pad / 2), str(n), font=f_lab, anchor="mm", fill=INK)
        for j in range(rows):
            n = r0 + j
            if n % tick == 0 or n in (r0, r1):
                d.text((pad / 2, pad + j * cell + cell / 2), str(n), font=f_lab, anchor="mm", fill=INK)
    return img, pad, pad


def draw_source(work: Work, size: str, box, cell, pad):
    """底稿上与 box 同一区域的像素，按同样的格距缩放并叠格线，左上留出与格子图相同的边距。"""
    r0, c0, r1, c1 = box
    f = cell_to_pixel(work, size)
    x0, y0, _, _ = f(r0 - 1, c0 - 1)
    _, _, x1, y1 = f(r1 - 1, c1 - 1)
    art = Image.open(work.pixel_art).convert("RGBA")
    flat = Image.new("RGBA", art.size, EMPTY + (255,))
    flat.alpha_composite(art)
    rows, cols = r1 - r0 + 1, c1 - c0 + 1
    crop = flat.convert("RGB").transform((cols * cell, rows * cell), Image.Transform.EXTENT, (x0, y0, x1, y1),
                                         Image.Resampling.NEAREST, fillcolor=EMPTY)
    img = Image.new("RGB", (pad + cols * cell + 2, pad + rows * cell + 2), BG)
    img.paste(crop, (pad, pad))
    d = ImageDraw.Draw(img)
    if cell >= 6:
        for i in range(cols + 1):
            d.line((pad + i * cell, pad, pad + i * cell, pad + rows * cell), fill=(120, 130, 140))
        for j in range(rows + 1):
            d.line((pad, pad + j * cell, pad + cols * cell, pad + j * cell), fill=(120, 130, 140))
    return img


def titled(panels, titles, gap=24):
    f = font(26)
    th = 46
    w = sum(p.width for p in panels) + gap * (len(panels) + 1)
    h = max(p.height for p in panels) + th + gap
    out = Image.new("RGB", (w, h), BG)
    d = ImageDraw.Draw(out)
    x = gap
    for p, t in zip(panels, titles):
        d.text((x, 10), t, font=f, fill=INK)
        out.paste(p, (x, th))
        x += p.width + gap
    return out


def stack(images, gap=20):
    w = max(i.width for i in images)
    out = Image.new("RGB", (w, sum(i.height for i in images) + gap * (len(images) - 1)), BG)
    y = 0
    for i in images:
        out.paste(i, (0, y)); y += i.height + gap
    return out


def mark(img, pad_x, pad_y, cell, cells, color, box_origin, width=3):
    d = ImageDraw.Draw(img)
    r0, c0 = box_origin
    for r, c in cells:
        x, y = pad_x + (c - c0) * cell, pad_y + (r - r0) * cell
        d.rectangle((x + 1, y + 1, x + cell - 1, y + cell - 1), outline=color, width=width)


def frame(img, pad_x, pad_y, cell, box, origin, color=BOX, width=2):
    r0, c0, r1, c1 = box
    d = ImageDraw.Draw(img)
    x0, y0 = pad_x + (c0 - origin[1]) * cell, pad_y + (r0 - origin[0]) * cell
    d.rectangle((x0 - 1, y0 - 1, x0 + (c1 - c0 + 1) * cell + 1, y0 + (r1 - r0 + 1) * cell + 1), outline=color, width=width)


def actual_size(before, after, pal, gap=12):
    """一格一像素的修复前、修复后，左右并排：放大定位，缩回原大验收读不读得出。"""
    def raw(g):
        a = np.array([[pal.get(c, EMPTY) if c else EMPTY for c in row] for row in g], np.uint8)
        return Image.fromarray(a, "RGB")
    b, a = raw(before), raw(after)
    out = Image.new("RGB", (b.width + a.width + gap, b.height), BG)
    out.paste(b, (0, 0)); out.paste(a, (b.width + gap, 0))
    return out


def zoom_cell(box, limit=1500, lo=18, hi=56):
    rows, cols = box[2] - box[0] + 1, box[3] - box[1] + 1
    return int(max(lo, min(hi, limit // 2 // max(rows, cols))))


# ---------- 子命令 ----------
def cmd_zoom(args):
    work = Work(args.work_dir)
    grid, pal = work.current_grid(args.size), palette()
    h, w = len(grid), len(grid[0])
    work.repair.mkdir(parents=True, exist_ok=True)
    if not args.box:
        box = (1, 1, h, w)
        cell = max(8, min(22, 900 // max(h, w)))
        g, px, _ = draw_grid(grid, pal, box, cell, tick=5)
        src = draw_source(work, args.size, box, cell, px)
        out = work.repair / f"overview_{args.size}.png"
        titled([src, g], [f"底稿（按 {args.size} 格切分）", f"当前图纸 {args.size}×{args.size}"]).save(out)
        print(f"定位图：{out}")
        print("在定位图上找到要修的部位，再用 --box 起始行,起始列,结束行,结束列 --part 部位名 放大。")
        return
    if not args.part:
        raise SystemExit("放大局部时要用 --part 写上部位名（如 左右眼），用于命名本轮修复目录")
    box = parse_box(args.box, h, w)
    nums = [int(p.name[:2]) for p in work.repair.iterdir() if p.is_dir() and p.name[:2].isdigit()]
    n = max(nums, default=0) + 1
    rnd = work.repair / f"{n:02d}_{args.size}_{UNSAFE.sub('_', args.part.strip())}"
    rnd.mkdir(parents=True, exist_ok=False)
    cell = zoom_cell(box)
    g, px, _ = draw_grid(grid, pal, box, cell, codes=True)
    src = draw_source(work, args.size, box, cell, px)
    out = rnd / "zoom.png"
    titled([src, g], [f"底稿 · 第 {box[0]}–{box[2]} 行 × 第 {box[1]}–{box[3]} 列", f"当前图纸 · {args.size} 格 · {args.part}"]).save(out)
    used = sorted({c for r in grid for c in r if c})
    lines = ["行\\列," + ",".join(str(c) for c in range(box[1], box[3] + 1))]
    for r in range(box[0], box[2] + 1):
        lines.append(f"{r}," + ",".join(grid[r - 1][c - 1] or "·" for c in range(box[1], box[3] + 1)))
    (rnd / "cells.csv").write_text("\n".join(lines) + "\n", encoding="utf-8")
    template = dict(size=args.size, part=args.part, box=list(box), consent="<玩家同意修这个部位的原话>",
                    changes=[dict(row=box[0], col=box[1], **{"from": grid[box[0] - 1][box[1] - 1]}, to="<新色号，空串表示拿掉这颗豆>",
                                  reason="<底稿或修复知识里的依据>")])
    (rnd / "changes.template.json").write_text(json.dumps(template, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"本轮目录：{rnd}")
    print(f"局部放大图：{out}")
    print(f"框内色号表：{rnd / 'cells.csv'}（· 表示空位）")
    print(f"图纸已用色号（{len(used)}）：{' '.join(used)}")
    print(f"改格清单照 {rnd / 'changes.template.json'} 的格式写到 {rnd / 'changes.json'}，再运行 compare。")


def parts(grid):
    """上下左右相连的豆分块，返回每块的 (行, 列) 集合（从 1 起）。"""
    h, w = len(grid), len(grid[0])
    seen, out = set(), []
    for i in range(h):
        for j in range(w):
            if not grid[i][j] or (i, j) in seen:
                continue
            comp, stack = set(), [(i, j)]
            seen.add((i, j))
            while stack:
                y, x = stack.pop()
                comp.add((y + 1, x + 1))
                for yy, xx in ((y + 1, x), (y - 1, x), (y, x + 1), (y, x - 1)):
                    if 0 <= yy < h and 0 <= xx < w and grid[yy][xx] and (yy, xx) not in seen:
                        seen.add((yy, xx))
                        stack.append((yy, xx))
            out.append(comp)
    return out


def connectivity_errors(grid, after):
    """拼豆烫完是一整片，散出去的豆会掉：新增的豆要连到原有的豆上，拿掉豆不能把一块切成两块。"""
    errors, after_parts = [], parts(after)
    for comp in after_parts:
        if not any(grid[r - 1][col - 1] for r, col in comp):
            r, col = min(comp)
            errors.append(f"第 {r} 行第 {col} 列起的 {len(comp)} 颗新增豆不与原有的豆相连")
    n0 = len(parts(grid))
    if not errors and len(after_parts) > n0:
        errors.append(f"改完后图纸从 {n0} 块断成 {len(after_parts)} 块：拿掉的豆把主体切开了，挖缝时留至少 1 格相连")
    return errors


def load_changes(work: Work, path: Path):
    path = path.resolve()
    data = json.loads(path.read_text(encoding="utf-8"))
    size = str(data["size"])
    grid, pal = work.current_grid(size), palette()
    h, w = len(grid), len(grid[0])
    box = tuple(int(v) for v in data["box"])
    if len(box) != 4:
        raise SystemExit("box 要写成 [起始行, 起始列, 结束行, 结束列]")
    box = parse_box(",".join(map(str, box)), h, w)
    if not str(data.get("consent", "")).strip() or data["consent"].startswith("<"):
        raise SystemExit("changes.json 缺玩家同意修复的原话（consent）")
    errors, seen = [], set()
    after = [r[:] for r in grid]
    for k, c in enumerate(data["changes"], 1):
        r, col, to = int(c["row"]), int(c["col"]), str(c.get("to", "")).strip()
        where = f"第 {k} 条（第 {r} 行第 {col} 列）"
        if not (box[0] <= r <= box[2] and box[1] <= col <= box[3]):
            errors.append(f"{where} 不在框选范围 {box} 内"); continue
        if (r, col) in seen:
            errors.append(f"{where} 重复"); continue
        seen.add((r, col))
        cur = grid[r - 1][col - 1]
        if str(c.get("from", "")).strip() != cur:
            errors.append(f"{where} 原色号写的是 {c.get('from')!r}，当前图纸是 {cur or '空位'!r}")
        if to and to not in pal:
            errors.append(f"{where} 新色号 {to} 不在色板里")
        if to == cur:
            errors.append(f"{where} 新旧色号相同")
        if not str(c.get("reason", "")).strip() or str(c["reason"]).startswith("<"):
            errors.append(f"{where} 缺理由")
        after[r - 1][col - 1] = to
    errors += connectivity_errors(grid, after)
    if errors:
        raise SystemExit("改格清单没有通过校验：\n- " + "\n- ".join(errors))
    used = {v for row in grid for v in row if v}
    return data, size, box, grid, after, pal, used


def digest(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def cmd_compare(args):
    work = Work(args.work_dir)
    path = args.changes.resolve()
    data, size, box, before, after, pal, used = load_changes(work, path)
    changed = [(int(c["row"]), int(c["col"])) for c in data["changes"] if before[int(c["row"]) - 1][int(c["col"]) - 1]]
    added = [(int(c["row"]), int(c["col"])) for c in data["changes"] if not before[int(c["row"]) - 1][int(c["col"]) - 1]]
    h, w = len(before), len(before[0])
    full = (1, 1, h, w)
    tcell = max(6, min(14, 560 // max(h, w)))
    thumbs = []
    for g, hl in ((before, False), (after, False), (after, True)):
        img, px, py = draw_grid(g, pal, full, tcell, labels=False)
        if hl:
            img = Image.blend(img, Image.new("RGB", img.size, (255, 255, 255)), 0.55)
            mark(img, px, py, tcell, changed, RED, (1, 1), width=2)
            mark(img, px, py, tcell, added, GREEN, (1, 1), width=2)
        frame(img, px, py, tcell, box, (1, 1))
        thumbs.append(img)
    thumbs.append(actual_size(before, after, pal))
    cell = zoom_cell(box)
    zooms = []
    for g, hl in ((before, False), (after, False), (after, True)):
        img, px, py = draw_grid(g, pal, box, cell, codes=True)
        if hl:
            mark(img, px, py, cell, changed, RED, box[:2])
            mark(img, px, py, cell, added, GREEN, box[:2])
        zooms.append(img)
    titles = ["修复前", "修复后", f"改动：红框改色 {len(changed)} · 绿框新增 {len(added)}"]
    out = path.parent / "compare.png"
    stack([titled(thumbs, [f"{t} · 整幅" for t in titles[:2]] + ["改动位置 · 整幅", "原大"]),
           titled(zooms, [f"{t} · {data['part']}" for t in titles[:2]] + [titles[2]])]).save(out)
    fresh = sorted({c["to"] for c in data["changes"] if c["to"] and c["to"] not in used})
    (path.parent / "validated.json").write_text(json.dumps(dict(changes_sha256=digest(path)), indent=2) + "\n", encoding="utf-8")
    print(f"对比图：{out}")
    print(f"共 {len(data['changes'])} 格：改色 {len(changed)}，新增 {len(added)}，全部在框选范围内。")
    if fresh:
        print(f"注意：{'、'.join(fresh)} 是图纸原来没用过的颜色，回复里要说明为什么用它。")
    print("玩家认可这张对比图之后，才运行 apply。")


def cmd_apply(args):
    work = Work(args.work_dir)
    path = args.changes.resolve()
    approval = args.approval.strip()
    if not approval:
        raise SystemExit("--approval 要写玩家认可这张对比图的原话")
    stamp = path.parent / "validated.json"
    if not stamp.is_file() or json.loads(stamp.read_text())["changes_sha256"] != digest(path):
        raise SystemExit("这份改格清单还没出过对比图，或出图后又改过；先运行 compare，给玩家看过再 apply")
    ledger = work.ledger_data()
    if any(Path(r["dir"]) == path.parent for r in ledger["rounds"]):
        raise SystemExit("这一轮已经应用过了；要继续修，用 zoom 开新的一轮")
    data, size, box, before, after, pal, used = load_changes(work, path)
    now = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    rnd = dict(dir=str(path.parent), size=size, part=data["part"], box=list(box), consent=data["consent"],
               approval=approval, applied_at=now,
               changes=[dict(row=int(c["row"]), col=int(c["col"]), **{"from": c["from"]}, to=c["to"], reason=c["reason"])
                        for c in data["changes"]])
    ledger["rounds"].append(rnd)
    record = [f"# 修复记录 · {size} 格 · {data['part']}", "",
              f"- 时间：{now}", f"- 范围：第 {box[0]}–{box[2]} 行 × 第 {box[1]}–{box[3]} 列",
              f"- 玩家同意修复：{data['consent']}", f"- 玩家认可对比图：{approval}", "",
              "| 行 | 列 | 原色号 | 新色号 | 理由 |", "|---|---|---|---|---|"]
    record += [f"| {c['row']} | {c['col']} | {c['from'] or '空位'} | {c['to'] or '拿掉'} | {c['reason']} |" for c in rnd["changes"]]
    (path.parent / "record.md").write_text("\n".join(record) + "\n", encoding="utf-8")

    sizes = work.sizes()
    overlay = {}
    for r in ledger["rounds"]:
        for c in r["changes"]:
            overlay.setdefault(r["size"], {})[(c["row"], c["col"])] = c["to"]
    payload = {s: [[rc[0], rc[1], to] for rc, to in sorted(cells.items())] for s, cells in overlay.items()}
    tag = hashlib.sha256(json.dumps(payload, sort_keys=True).encode()).hexdigest()[:8]
    repairs = work.repair / "page_repairs.json"
    repairs.write_text(json.dumps(dict(tag=tag, sizes=payload), ensure_ascii=False) + "\n", encoding="utf-8")

    task = args.task_name or work.run.get("task_name")
    if not task:
        raise SystemExit("找不到任务名（.wip/运行记录.json 没有 task_name），用 --task-name 传入")
    sources = sorted(p for p in (work.wip / "原图").glob("*") if p.suffix.lower() in (".png", ".jpg", ".jpeg", ".webp"))
    output = work.root / "output"
    before_html = set(output.glob("*.html"))
    cmd = [sys.executable, str(BUILD_HTML), "--process-dir", str(work.process), "--pixel-art", str(work.pixel_art),
           "--palette", str(PALETTE_CSV), "--task-name", task, "--output", str(output),
           "--sizes", *sizes, "--default-size", args.default_size or size, "--repairs", str(repairs)]
    for s in sources:
        cmd += ["--source", str(s)]
    print("正在生成修复后的图纸页……", flush=True)
    subprocess.run(cmd, check=True, stdout=subprocess.DEVNULL)
    new = sorted(set(output.glob("*.html")) - before_html, key=lambda p: p.stat().st_mtime)
    if not new:
        raise SystemExit("没有生成新的 HTML")
    rnd["html"] = str(new[-1])
    work.ledger.write_text(json.dumps(ledger, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    with (path.parent / "record.md").open("a", encoding="utf-8") as f:
        f.write(f"\n新图纸：{new[-1].name}\n")
    print(f"修复记录：{path.parent / 'record.md'}")
    print(f"新图纸（原图纸保留）：{new[-1]}")


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    z = sub.add_parser("zoom", help="整幅定位图，或开一轮修复并出局部放大图")
    z.add_argument("--work-dir", type=Path, required=True)
    z.add_argument("--size", required=True, help="规格，如 52")
    z.add_argument("--box", help="起始行,起始列,结束行,结束列（从 1 起，含两端）")
    z.add_argument("--part", help="部位名，如 左右眼")
    c = sub.add_parser("compare", help="校验改格清单并出对比图")
    c.add_argument("--work-dir", type=Path, required=True)
    c.add_argument("--changes", type=Path, required=True)
    p = sub.add_parser("apply", help="玩家认可后记入修复并生成新的 HTML")
    p.add_argument("--work-dir", type=Path, required=True)
    p.add_argument("--changes", type=Path, required=True)
    p.add_argument("--approval", required=True, help="玩家认可对比图的原话")
    p.add_argument("--task-name", help="缺省取 .wip/运行记录.json 的任务名")
    p.add_argument("--default-size", help="新图纸默认展示的规格，缺省为本次修复的规格")
    args = ap.parse_args()
    {"zoom": cmd_zoom, "compare": cmd_compare, "apply": cmd_apply}[args.cmd](args)


if __name__ == "__main__":
    main()
