#!/usr/bin/env python3
"""gen_and_recover.py — 用户参考图 → 单张平面像素底稿 → 多规格拼豆图纸 → 交互 HTML。

支持多张原图：多个位置参数全部作为原始素材展示进 HTML（生图视觉参考取第一张）。
没有参考图时不传位置参数：配合 --skip-gen 直接给像素底稿，或带 --t2i-confirmed 走文生图；页面不出现「原图」页签。
传 --edit 时进入修改模式：输入图是玩家已认可的底稿（认可原话经 --confirmed 传入），按修改要求在原图上改，再走同一条图纸链路。
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

SCRIPTS = Path(__file__).resolve().parent
sys.path.insert(0, str(SCRIPTS))

import image_render
from alignment_search import parse_board, board_name, strip_sticker_border
from build_html_blueprint import html_file_name, HTML_TIMEZONE

IMAGE_PROMPTS = SCRIPTS.parent / "image_prompts"
BASE_SPECS_DIR = IMAGE_PROMPTS / "01-base_specs"
ART_STYLE_DIR = IMAGE_PROMPTS / "03-art_style"
SUBJECT_DESC_DIR = IMAGE_PROMPTS / "04-subject_description"
# 画风库：目录名 → 可用的叫法。每个目录里 art_style.md 是画风正文；
# 有 subject_description.md 的画风在人物主体没写描述时用它替换人物默认描述。
ART_STYLES = {
    "original": ("还原",),
    "chibi": ("Q版", "q版", "手绘小人", "简笔小人", "手绘表情包"),
    "mini-sticker": ("贴纸", "迷你贴纸"),
    "misty-pencil": ("柔彩手绘", "粉彩手绘", "低饱和彩铅"),
    "pixel-big-head": ("像素大头小图", "像素大头", "大头小图"),
    "handdraw-bust": ("手绘头像",),
}
# 人像预设从菜单读取；非人像允许还原与自由描述。
CHARACTER_ONLY_STYLES = {s["id"] for s in json.loads(
    (SCRIPTS.parent / "assets" / "style_guide.json").read_text(encoding="utf-8"))["styles"]
    if s.get("scope") == "character" and s["id"] != "original"}
DEFAULT_ART_STYLE = "original"
PALETTE_CSV = SCRIPTS / "palette_mard221.csv"
IMAGE_RENDER = SCRIPTS / "image_render.py"
BLOCK_CLEANUP = SCRIPTS / "block_cleanup.py"
ALIGNMENT_SEARCH = SCRIPTS / "alignment_search.py"
MAKE_OVERVIEW = SCRIPTS / "make_overview.py"
BUILD_HTML = SCRIPTS / "build_html_blueprint.py"
DEFAULT_BOARDS = ["36", "52", "78", "104", "156"]
SMALL_BOARD_MAX = 52   # 玩家指定规格不超过它时，提示词按这块小板子画
_LIVE: dict = {}  # 本次运行的运行记录.json 路径与内容，say() 每次播报都写进去


def target_boards(target: int) -> list[int]:
    """玩家指定边长时出哪几档：小于 52 只附 52 作参考（小图出得快）；52 及以上附上下相邻的固定档。"""
    fixed = [int(b) for b in DEFAULT_BOARDS]
    if target < SMALL_BOARD_MAX:
        return [target, SMALL_BOARD_MAX]
    lower = [b for b in fixed if b < target][-1:]
    upper = [b for b in fixed if b > target][:1]
    return sorted({target, *lower, *upper})
DEFAULT_RENDER_SIZE = image_render.DEFAULT_SIZE
DEFAULT_QUALITY = image_render.DEFAULT_QUALITY
DEFAULT_BACKGROUND = image_render.DEFAULT_BACKGROUND
DEFAULT_SUBJECT_MAP = {
    "character": "subject_description.md",
    "prop": "subject_description_prop.md",
    "character-prop": "subject_description.md",
}
# 固定层在前，可变层按"是谁 → 画成什么样 → 原图取舍 → 构图"排列；修改模式的两段永远在最后。
SLOT_ORDER = ["task_mission", "pixel_style", "target_size", "art_style", "game_knowledge", "subject_description",
              "image_analysis", "composition"]
TAIL_SLOTS = ["edit_mission", "edit_request"]


def newest_html(html_dir: Path) -> Path:
    """取 HTML 目录里最新的图纸文件（build_html 按渲染时刻命名，同一任务多次修改会并存多份）。"""
    pages = [p for p in html_dir.glob("*.html") if p.is_file()]
    if not pages:
        return html_dir / "【拼豆专家】未命名.html"
    return max(pages, key=lambda p: p.stat().st_mtime)


def _ordered_keys(slots: dict) -> list[str]:
    head = [key for key in SLOT_ORDER if key in slots]
    tail = [key for key in TAIL_SLOTS if key in slots]
    middle = [key for key in slots if key not in SLOT_ORDER and key not in TAIL_SLOTS]
    return head + middle + tail


def _resolve_slot_content(slot_value, base_dir: Path) -> str:
    if isinstance(slot_value, dict):
        if "text" in slot_value:
            return str(slot_value["text"])
        if "file" in slot_value:
            path = Path(slot_value["file"])
            if not path.is_absolute():
                path = base_dir / path
            return path.read_text(encoding="utf-8", errors="ignore")
        if "img" in slot_value:
            return ""
    return str(slot_value) if slot_value is not None else ""


def _normalize_input(prompt_path: Path) -> dict:
    raw = json.loads(prompt_path.read_text(encoding="utf-8"))
    if not isinstance(raw, dict):
        raise ValueError(f"prompt JSON 必须是 Object：{prompt_path}")
    return {
        key: value if value is None or isinstance(value, dict) else {"text": str(value)}
        for key, value in raw.items()
    }


def art_style_name(value: str) -> str | None:
    """画风库里的目录名或叫法 → 目录名；不在库里返回 None（当作自定义画风描述）。"""
    key = value.strip()
    for name, aliases in ART_STYLES.items():
        if key == name or key in aliases:
            return name
    return None


def resolve_art_style(value: str | None) -> tuple[str, dict]:
    """--art-style 的取值 → (运行记录.json 里记录的画风, art_style slot)。

    None 取默认画风「还原」；库里的名字读对应正文；其他文字套进 custom.md 当作自定义画风。
    """
    if value is None:
        value = DEFAULT_ART_STYLE
    if not value.strip():
        raise ValueError("画风不能为空")
    name = art_style_name(value)
    if name is not None:
        return name, {"file": ART_STYLE_DIR / name / "art_style.md"}
    template = (ART_STYLE_DIR / "custom.md").read_text(encoding="utf-8")
    return "custom", {"text": template.replace("{TEXT}", value.strip())}


def compose_prompt_json(size: int, subject: str, prompt_json_path: Path | None, base_dir: Path,
                        edit_request: str | None = None, target_size: int | None = None,
                        art_style: str | None = None) -> str:
    """按 SLOT_ORDER 组装 XML slot，并补齐基础规格、画风和主体描述。

    target_size 是玩家指定的小板子边长（≤ SMALL_BOARD_MAX）：补 target_size slot，让底稿按这块板子的粒度画。
    art_style 是画风库里的名字或一段自定义画风描述，优先于配置里的 art_style；两处都没给时补默认画风「还原」。
    配置里的 art_style 写成库里的名字（如 "Q版"）时同样读库里的正文。
    edit_request 非空时为修改模式：参考图本身就是主体，不补 subject_description 和默认画风；
    补 edit_mission，并把修改要求作为最后一个 slot 拼入。
    """
    if size <= 0:
        raise ValueError("目标规格必须为正整数")
    actual = _normalize_input(prompt_json_path) if prompt_json_path else {}
    has_task_mission = "task_mission" in actual
    has_pixel_style = "pixel_style" in actual
    if "task_mission" not in actual:
        actual["task_mission"] = {"file": BASE_SPECS_DIR / "task_mission.md"}
    if "pixel_style" not in actual:
        actual["pixel_style"] = {"file": BASE_SPECS_DIR / "pixel_style.md"}
    if target_size is not None and target_size <= SMALL_BOARD_MAX and "target_size" not in actual:
        text = (BASE_SPECS_DIR / "target_size.md").read_text(encoding="utf-8")
        actual["target_size"] = {"text": text.replace("{N}", str(target_size))
                                 .replace("{BEADS}", str(target_size * target_size))
                                 .replace("{GRID}", str(target_size * 2))}
    style_name = None
    if art_style is not None:
        style_name, actual["art_style"] = resolve_art_style(art_style)
    elif isinstance(actual.get("art_style"), dict) and "text" in actual["art_style"] \
            and art_style_name(str(actual["art_style"]["text"])) is not None:
        style_name, actual["art_style"] = resolve_art_style(str(actual["art_style"]["text"]))
    elif "art_style" not in actual and edit_request is None:
        style_name, actual["art_style"] = resolve_art_style(None)
    if style_name == "misty-pencil" and edit_request is None and not has_task_mission:
        # 灰雾配色由画风控制，拼豆要求使用完整 pixel_style。
        actual["task_mission"] = None
    if subject == "prop" and style_name in CHARACTER_ONLY_STYLES:
        label = ART_STYLES[style_name][0] if style_name in ART_STYLES else "自定义画风"
        raise ValueError(f"「{label}」只用于人像；非人像可按还原或自行描述创作要求")
    style_pixel = ART_STYLE_DIR / str(style_name) / "pixel_style.md"
    if style_name and style_pixel.is_file() and edit_request is None:
        # 画风自带像素化段（如像素大头的大色块、手绘的粗线）时用它，不补默认任务段与细密色块要求。
        if not has_pixel_style:
            actual["pixel_style"] = {"file": style_pixel}
        if not has_task_mission:
            actual["task_mission"] = None
    if edit_request is not None:
        if not edit_request.strip():
            raise ValueError("修改要求不能为空")
        if "edit_mission" not in actual:
            actual["edit_mission"] = {"file": BASE_SPECS_DIR / "edit_mission.md"}
        actual.pop("edit_request", None)
        actual["edit_request"] = {"text": edit_request}
    elif "subject_description" not in actual:
        style_subject = ART_STYLE_DIR / str(style_name) / "subject_description.md"
        if subject != "prop" and style_name and style_subject.is_file():
            actual["subject_description"] = {"file": style_subject}
        else:
            actual["subject_description"] = {"file": SUBJECT_DESC_DIR / DEFAULT_SUBJECT_MAP[subject]}

    style_composition = ART_STYLE_DIR / str(style_name) / "composition.md"
    if edit_request is None and subject != "prop" and "composition" not in actual and style_composition.is_file():
        actual["composition"] = {"file": style_composition}

    parts = []
    for key in _ordered_keys(actual):
        value = actual[key]
        if value is None:
            continue
        content = _resolve_slot_content(value, base_dir)
        if content.strip():
            parts.append(f"<{key}>\n{content.strip()}\n</{key}>")
    if not parts:
        raise ValueError(f"prompt 解析后无可注入内容：{prompt_json_path}")
    return "\n\n".join(parts) + "\n"


def art_style_label(prompt_text: str) -> str | None:
    """从拼好的提示词里认出用了哪个画风：库里的画风记目录名，其他记 custom，没有 art_style 段记 None。"""
    start, end = prompt_text.find("<art_style>\n"), prompt_text.find("\n</art_style>")
    if start < 0 or end < 0:
        return None
    body = prompt_text[start + len("<art_style>\n"):end].strip()
    for name in ART_STYLES:
        path = ART_STYLE_DIR / name / "art_style.md"
        if path.is_file() and path.read_text(encoding="utf-8").strip() == body:
            return name
    return "custom"


def ensure_file(path: Path, label: str) -> None:
    if not path.is_file():
        raise SystemExit(f"找不到{label}：{path}")


def say(text: str) -> None:
    """给玩家看的进度行：WorkBuddy 运行本脚本时玩家能看到，只讲在做什么，不讲算法与参数。

    统一以「进度 · 」开头，便于和其他脚本的内部输出（✓ 对照图、✓ HTML 图纸等）区分；
    不用方括号，避免被开发侧预览页当成阶段行解析。"""
    print(f"\n进度 · {text}", flush=True)
    if _LIVE:
        _LIVE["data"]["progress"] = text
        _LIVE["data"]["progress_at"] = datetime.now(timezone.utc).isoformat()
        _write_json(_LIVE["manifest"], _LIVE["data"])

def _write_json(path: Path, data: dict) -> None:
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")

def run_command(cmd: list[str], stage: str, player: str | None = None) -> None:
    """阶段行 `[阶段] cmd`（便于分段计时）+ 可选的玩家进度行。"""
    if player:
        say(player)
    print(f"\n[{stage}] {' '.join(cmd)}", flush=True)
    try:
        subprocess.run(cmd, check=True)
    except subprocess.CalledProcessError:
        say("这一步卡住了，我看看怎么回事")
        raise


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("input", type=Path, nargs="*",
                        help="本次任务的视觉参考图（可多张，第一张用于生图）；修改模式下是要修改的已有底稿；"
                             "没有参考图时不传：配合 --skip-gen 给像素底稿，或带 --t2i-confirmed 走文生图")
    parser.add_argument("--work-dir", type=Path, required=True,
                        help="独立工作目录；.wip 保存过程文件，output 保存交付文件")
    parser.add_argument("--prompt", type=Path,
                        help="JSON slot 配置或已组装的完整 prompt；修改模式下可省略")
    parser.add_argument("--edit",
                        help="修改模式：用户对已有底稿的修改要求（文字或 .md/.txt 文件路径）；必须同时给 --confirmed")
    parser.add_argument("--t2i-confirmed",
                        help="文生图必填：玩家同意用文字直接生图的原话；没有玩家同意就不能文生图")
    parser.add_argument("--confirmed",
                        help="修改模式必填：玩家认可这张底稿的原话；没有认可就不能修改，改走真实参考图重画")
    parser.add_argument("--task-name", required=True,
                        help="WorkBuddy 在 HTML 渲染前拟定的本次任务名")
    parser.add_argument("--boards", nargs="+", default=DEFAULT_BOARDS, choices=DEFAULT_BOARDS,
                        metavar="板规格", help="输出的固定档位（36/52/78/104/156 的子集）；自定义方形规格由玩家在 HTML 侧栏输入、页面现场计算")
    parser.add_argument("--target-size", type=int, default=None, metavar="边长",
                        help="玩家明确要的方形板边长（15–156）：默认展示这一档；小于 52 时只附 52 作参考，52 及以上附上下相邻的固定档；不超过 52 时提示词按这块小板子画")
    parser.add_argument("--max-colors", type=int, default=28, help="统一颜色预算")
    parser.add_argument("--default-size", default=None,
                        help="HTML 默认展示规格（必须是 --boards 之一，缺省取第一个）；WorkBuddy 可看 .wip/评审/尺寸对比.png 后指定")
    parser.add_argument("--render-size", default=DEFAULT_RENDER_SIZE,
                        help=f"生图输出尺寸（默认 {DEFAULT_RENDER_SIZE}）")
    parser.add_argument("--quality", default=DEFAULT_QUALITY,
                        choices=["auto", "low", "medium", "high", "xhigh", "max"],
                        help=f"GPT Image 画质档位（默认 {DEFAULT_QUALITY}）")
    parser.add_argument("--background", default=DEFAULT_BACKGROUND,
                        choices=["auto", "opaque", "transparent"],
                        help=f"GPT Image 背景模式（默认 {DEFAULT_BACKGROUND}）")
    parser.add_argument("--art-style", default=None, metavar="画风",
                        help="模板名字（还原 / 像素大头小图 / 贴纸 / 手绘头像 / Q版 / 柔彩手绘，或对应目录名；手绘小人归Q版），"
                             "或一段自定义画风描述；不给时用配置里的 art_style，配置也没写就用「还原」。修改模式不能换画风")
    parser.add_argument("--subject", choices=DEFAULT_SUBJECT_MAP, default="character")
    parser.add_argument("--skip-gen", action="store_true", help="复用已有平面像素底稿")
    parser.add_argument("--effect-image", type=Path, help="与 --skip-gen 配合使用")
    parser.add_argument("--merge-close-colors", action="store_true",
                        help="合并近色簇，修复同一区域的交错色（默认关闭）")
    parser.add_argument("--keep-process", action="store_true", help="保留过程文件")
    parser.add_argument("--keep-sticker-border", action="store_true",
                        help="保留底稿外圈的白色贴纸边（默认检出即去掉，再切格与描边补齐）")
    parser.add_argument("--prompt-only", action="store_true", help="只装配提示词")
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    try:
        if args.target_size is not None:
            target = parse_board(args.target_size)
            boards = target_boards(target)
            args.default_size = args.default_size or board_name(target)
        else:
            boards = [parse_board(b) for b in args.boards]
    except ValueError as e:
        raise SystemExit(str(e))
    board_names = [board_name(board) for board in boards]
    if args.default_size is None and "78" in board_names:
        args.default_size = "78"
    if args.default_size is not None and args.default_size not in board_names:
        raise SystemExit(f"--default-size 必须在 --boards 里：{args.default_size} 不在 {board_names}")
    if args.prompt_only and args.skip_gen:
        raise SystemExit("--prompt-only 与 --skip-gen 不能同时使用")
    if args.skip_gen and not args.effect_image:
        raise SystemExit("--skip-gen 时必须指定 --effect-image")
    if args.edit is not None and args.skip_gen:
        raise SystemExit("--edit 与 --skip-gen 不能同时使用")
    if not args.input and args.edit is not None:
        raise SystemExit("修改模式必须给底稿：--edit 的输入图是要修改的已有底稿")
    if not args.input and not args.skip_gen and not args.prompt_only and not (args.t2i_confirmed or "").strip():
        raise SystemExit("没有参考图时，要么 --skip-gen --effect-image <像素底稿>，要么文生图："
                         "文生图必须先征得玩家同意，带 --t2i-confirmed \"<玩家同意原话>\"")
    if args.t2i_confirmed is not None and args.input:
        raise SystemExit("--t2i-confirmed 只用于没有参考图的文生图；有参考图时去掉它")
    if args.edit is not None and not (args.confirmed or "").strip():
        raise SystemExit("未经玩家认可的底稿不能修改：--edit 必须带 --confirmed \"<玩家认可原话>\"。"
                         "玩家没有明确认可时，以真实参考图（玩家原图、官方立绘、游戏截图）按新要求重写 slot 重画。")
    if args.confirmed is not None and args.edit is None:
        raise SystemExit("--confirmed 只用于修改模式，需与 --edit 同时使用")
    if args.art_style is not None and args.edit is not None:
        raise SystemExit("修改模式不能换画风：换画风要以真实参考图重画，去掉 --edit 按新画风重新生成")
    if args.prompt is None and args.edit is None:
        raise SystemExit("缺少 --prompt（仅修改模式可省略）")

    edit_request = None
    if args.edit is not None:
        edit_path = Path(args.edit)
        edit_request = (edit_path.read_text(encoding="utf-8")
                        if edit_path.suffix.lower() in {".md", ".txt"} and edit_path.is_file()
                        else args.edit)

    source = args.input[0].resolve() if args.input else None
    extra_sources = [p.resolve() for p in args.input[1:]]
    prompt_source = args.prompt.resolve() if args.prompt else None
    work_dir = args.work_dir.resolve()
    for p in args.input:
        ensure_file(p.resolve(), "输入图")
    if prompt_source:
        ensure_file(prompt_source, "prompt")

    input_dir = work_dir / ".wip" / "原图"
    prompt_dir = work_dir / ".wip" / "提示词"
    generate_dir = work_dir / ".wip" / "转换图"
    process_dir = work_dir / ".wip" / "过程文件"
    output_dir = work_dir / "output"
    for directory in (input_dir, prompt_dir, generate_dir, process_dir, output_dir):
        directory.mkdir(parents=True, exist_ok=True)

    source_copy = input_dir / f"原图{source.suffix.lower()}" if source else None
    if source_copy and source != source_copy:
        shutil.copy2(source, source_copy)
    if prompt_source:
        config_copy = prompt_dir / ("提示词配置.json" if prompt_source.suffix.lower() == ".json" else "提示词来源.md")
        if prompt_source != config_copy:
            shutil.copy2(prompt_source, config_copy)
    if edit_request is not None:
        (prompt_dir / "修改要求.md").write_text(edit_request.strip() + "\n", encoding="utf-8")
        (prompt_dir / "确认原话.md").write_text(args.confirmed.strip() + "\n", encoding="utf-8")

    if prompt_source is None or prompt_source.suffix.lower() == ".json":
        try:
            prompt_text = compose_prompt_json(max(boards), args.subject, prompt_source,
                                              prompt_source.parent if prompt_source else work_dir,
                                              edit_request=edit_request, target_size=args.target_size,
                                              art_style=args.art_style)
        except ValueError as e:
            raise SystemExit(str(e))
    elif edit_request is not None:
        raise SystemExit("修改模式的 --prompt 只接受 JSON slot 配置")
    else:
        prompt_text = prompt_source.read_text(encoding="utf-8").strip() + "\n"
    prompt_path = prompt_dir / "提示词.md"
    prompt_path.write_text(prompt_text, encoding="utf-8")

    run_data = {
        "started_at": datetime.now(timezone.utc).isoformat(),
        "status": "running",
        "work_dir": str(work_dir),
        "input": str(source_copy) if source_copy else None,
        "prompt": str(prompt_path),
        "task_name": args.task_name,
        "mode": "edit" if edit_request is not None else "create",
        "confirmed_by_user": args.confirmed.strip() if edit_request is not None else None,
        "t2i_confirmed_by_user": (args.t2i_confirmed or "").strip() or None,
        "render_size": args.render_size,
        "quality": args.quality,
        "background": args.background,
        "render_base": image_render.render_base(),
        "boards": board_names,
        "target_size": args.target_size,
        "art_style": art_style_label(prompt_text),
        "max_colors": args.max_colors,
        "sticker_border": None,
        "merge_close_colors": args.merge_close_colors,
        "outputs": {},
    }
    manifest = work_dir / ".wip" / "运行记录.json"
    _LIVE.clear()
    _LIVE.update(manifest=manifest, data=run_data)
    _write_json(manifest, run_data)
    print(f"工作路径：{work_dir}")
    if not args.prompt_only:
        say(f"开工啦，开始做「{args.task_name}」")

    try:
        if args.prompt_only:
            run_data["status"] = "prompt_only"
            run_data["outputs"] = {"prompt": str(prompt_path)}
            return

        pixel_art = generate_dir / "转换图.png"
        if args.skip_gen:
            effect = args.effect_image.resolve()
            ensure_file(effect, "平面像素底稿")
            if effect != pixel_art:
                shutil.copy2(effect, pixel_art)
            say("用你认可的那张图接着做")
        else:
            run_command([
                sys.executable, str(IMAGE_RENDER),
                "--prompt", str(prompt_path),
                *(["--image", str(source_copy)] if source_copy else []),
                "--output", str(pixel_art),
                "--size", args.render_size,
                "--quality", args.quality,
                "--background", args.background,
            ], "按修改要求改写已有底稿" if edit_request is not None else "生成单张平面像素底稿",
                "照你说的改一改，这步最慢，稍等一会儿～" if edit_request is not None
                else "先画一张像素小图，这步最慢，稍等一会儿～")

        # 色块规整：通用生图后端（gpt-image 系）的底稿带纹理噪点与边缘混色（平坦度 ~25%），
        # 洗成硬边平涂（~95%+）再切格，豆色更准、杂色更少。PERLER_BLOCK_CLEANUP=0 关闭。
        if os.environ.get("PERLER_BLOCK_CLEANUP", "") != "0":
            run_command([sys.executable, str(BLOCK_CLEANUP), str(pixel_art)],
                        "色块规整", "把底稿色块熨平整，豆子颜色更准～")

        draft = pixel_art
        if args.keep_sticker_border:
            run_data["sticker_border"] = {"removed": False, "reason": "--keep-sticker-border"}
        else:
            draft = generate_dir / "转换图_去贴纸边.png"
            removed, info = strip_sticker_border(pixel_art, draft)
            run_data["sticker_border"] = {"removed": removed, **info}
            print(f"\n[贴纸白边] {'已去除' if removed else '未检出'} {info}", flush=True)

        run_command([
            sys.executable, str(ALIGNMENT_SEARCH),
            *(["--merge-close-colors"] if args.merge_close_colors else []),
            "--input", str(draft),
            "--palette", str(PALETTE_CSV),
            "--output", str(process_dir),
            "--boards", *[name for name in board_names],
            "--max-colors", str(args.max_colors),
        ], "生成多规格色号矩阵",
            "给每一格挑好豆子颜色，大板小板都备一份")

        rendered_at = datetime.now(HTML_TIMEZONE).strftime("%Y-%m-%d %H:%M:%S")
        delivery_prefix = Path(html_file_name(args.task_name, rendered_at)).stem.rsplit("-", 1)[0]
        review_dir = work_dir / ".wip" / "评审"
        review_dir.mkdir(parents=True, exist_ok=True)
        board_overview = review_dir / "尺寸对比.png"
        overview_cmd = [sys.executable, str(MAKE_OVERVIEW), "--effect", str(draft)]
        if source_copy:
            overview_cmd += ["--source", str(source_copy)]
        for name in board_names:
            overview_cmd.extend([
                "--size", f"{name}:{process_dir / f'{name}_k{args.max_colors}' / 'recovered_mard.png'}"
            ])
        overview_cmd.extend(["--output", str(board_overview), "--cell", "22"])
        run_command(overview_cmd, "生成尺寸对比图")

        html_dir = output_dir
        build_cmd = [
            sys.executable, str(BUILD_HTML),
            "--process-dir", str(process_dir),
            "--pixel-art", str(draft),
            "--palette", str(PALETTE_CSV),
            "--task-name", args.task_name,
            "--output", str(html_dir),
            "--sizes", *[name for name in board_names],
            "--subject", args.subject,
        ]
        if args.default_size is not None:
            build_cmd.extend(["--default-size", args.default_size])
        # 页面只标预设画风：新建作品且画风来自画风库才传；修改模式（改过的图）与自定义画风不标
        if edit_request is None and run_data["art_style"] in ART_STYLES:
            build_cmd.extend(["--art-style", run_data["art_style"]])
        for src in [source_copy, *extra_sources]:
            if src:
                build_cmd.extend(["--source", str(src)])
        run_command(build_cmd, "构建图纸数据与 HTML",
                    "图纸快好了，正在装进页面里")

        html_index = newest_html(html_dir)
        ensure_file(html_index, "HTML 主交付物")


        if not args.keep_process and process_dir.exists():
            shutil.rmtree(process_dir, ignore_errors=True)

        run_data["status"] = "completed"
        run_data["outputs"] = {
            "html": str(html_index),
            "board_overview": str(board_overview),
            "prompt": str(prompt_path),
        }
        say("图纸做好啦！")
        print(f"\n主交付物（先打开）：{html_index}")
        print(f"尺寸对比图：{board_overview}")
        print(f"生图提示词：{prompt_path}")
    except Exception as exc:
        run_data["status"] = "failed"
        run_data["error"] = str(exc)
        raise
    finally:
        run_data["finished_at"] = datetime.now(timezone.utc).isoformat()
        manifest.write_text(json.dumps(run_data, ensure_ascii=False, indent=2), encoding="utf-8")
        print(f"运行清单：{manifest}")


if __name__ == "__main__":
    main()