#!/usr/bin/env python3
"""把原图与各规格效果图排成两列尺寸对比卡片，输出宽度固定为 1600px。"""

import argparse
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont, ImageOps

BG = (246, 247, 250)
TEXT = (35, 41, 55)
FONT_PATHS = [
    "/usr/share/fonts/google-noto-cjk/NotoSansCJKsc-Regular.otf",
    "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc",
    "/System/Library/Fonts/PingFang.ttc",
    "C:/Windows/Fonts/msyh.ttc",
    "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
]


def load_font(size: int):
    for path in FONT_PATHS:
        if Path(path).is_file():
            try:
                return ImageFont.truetype(path, size)
            except OSError:
                continue
    return ImageFont.load_default()


def make_overview(source, effect, deliverables, output_path, cell=18):
    """原图可选；规格按边长升序排列，效果图用最近邻缩放保持硬边。

    deliverables 为 [(边长, 图片路径, 可选标注)]。cell 保留为命令调用参数；
    卡片尺寸固定，不随豆版格数增大。effect 是仅在未提供原图时使用的底稿。
    """
    cards = []
    reference = source or effect
    if reference:
        cards.append(("原图" if source else "像素底稿", Path(reference), False))
    for size, path, tag in sorted(deliverables, key=lambda item: item[0]):
        label = f"{size}×{size}"
        if tag:
            label += f" · {tag}"
        cards.append((label, Path(path), True))
    if not deliverables:
        raise ValueError("没有可展示的规格")

    width, pad, gap, title_h, card_h = 1600, 40, 24, 84, 740
    card_w = (width - pad * 2 - gap) // 2
    rows = (len(cards) + 1) // 2
    height = pad * 2 + title_h + rows * card_h + (rows - 1) * gap
    canvas = Image.new("RGB", (width, height), BG)
    draw = ImageDraw.Draw(canvas)
    draw.text((pad, pad), "拼豆尺寸对比", font=load_font(40), fill=TEXT)
    font = load_font(32)
    for index, (label, path, pixelated) in enumerate(cards):
        row, col = divmod(index, 2)
        x = pad + col * (card_w + gap)
        y = pad + title_h + row * (card_h + gap)
        draw.rounded_rectangle((x, y, x + card_w, y + card_h), radius=24, fill="white")
        draw.text((x + 28, y + 24), label, font=font, fill=TEXT)
        with Image.open(path) as raw:
            rgba = raw.convert("RGBA")
            image = Image.new("RGBA", rgba.size, "white")
            image.alpha_composite(rgba)
            image = ImageOps.contain(image.convert("RGB"), (card_w - 56, card_h - 110),
                                     Image.Resampling.NEAREST if pixelated else Image.Resampling.LANCZOS)
        canvas.paste(image, (x + (card_w - image.width) // 2,
                             y + 86 + (card_h - 110 - image.height) // 2))
    output_path = Path(output_path)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    canvas.save(output_path)
    print(f"✓ 尺寸对比图: {output_path} ({width}×{height})")


def parse_deliverable(value):
    """SIZE:PATH[:TAG]；从两端解析，支持 Windows 盘符路径。"""
    size, separator, rest = value.partition(":")
    if not separator or not size.isdigit() or int(size) <= 0 or not rest:
        raise argparse.ArgumentTypeError("格式应为 SIZE:PATH[:TAG]，SIZE 为正整数")
    path = Path(rest)
    tag = None
    if not path.is_file():
        candidate, separator, label = rest.rpartition(":")
        if separator and Path(candidate).is_file():
            path, tag = Path(candidate), label
    return int(size), path, tag


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=Path, help="原始输入图")
    parser.add_argument("--effect", type=Path, help="未提供原图时使用的像素底稿")
    parser.add_argument("--size", dest="sizes", type=parse_deliverable, action="append", required=True,
                        metavar="SIZE:PATH[:TAG]", help="规格效果图")
    parser.add_argument("-o", "--output", type=Path, required=True)
    parser.add_argument("--cell", type=int, default=22, help="调用参数，卡片尺寸固定")
    args = parser.parse_args()
    make_overview(args.source, args.effect, args.sizes, args.output, args.cell)


if __name__ == "__main__":
    main()
