#!/usr/bin/env python3
"""同图双后端取材：对同一张原图，分别用两个生图后端出「原始底稿」（未经色块规整）。

产出目录：apps/pixelart/assert/生图对比/raw/G<组号>/
    prompt.md      本次的提示词（两后端共用，保证公平）
    ours_raw.png   apinebula gpt-image-2.5 原始输出（我方链路输入）
    vp_raw.png     val-perler.qq.com 原始输出（参照后端）

只跑到生图为止，不做切格/图纸渲染（慢且用不到），所以每单成本≈一次生图。

用法：
  python3 批量取材.py 20:prop 21:character 28:prop
  python3 批量取材.py 20:prop:" descriptive text "
  python3 批量取材.py --no-vp 20:prop          # 不出 val-perler（活动池额度紧时）
  python3 批量取材.py --style=chibi 20:prop     # 换个画风出一组（画风对标实验用）
"""
import concurrent.futures as cf
import json
import os
import shutil
import subprocess
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]                     # 仓库根
APP = Path(__file__).resolve().parents[1]                      # apps/pixelart
SCRIPTS = APP / "assert" / "valorant-perler-src" / "valorant-perler" / "scripts"
DATA = APP / "assert" / "生图对比"
OUT = DATA / "raw"
PY = os.path.expanduser("~/.workbuddy/binaries/python/envs/default/bin/python")
RETRY_BACKOFF = 2.0


def cfg(key):
    return json.loads((ROOT / ".pixelart-config.json").read_text(encoding="utf-8"))[key]


def original_of(group: str) -> Path | None:
    """组内「原图」= 第一个非 1/2 的图片文件。必须过滤 .DS_Store 之类的隐藏文件：
    它们没有扩展名，前几版会把它当原图拷过去，结果下游找不到图。"""
    imgs = {".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp"}
    for f in sorted((DATA / group).iterdir()):
        if f.is_file() and not f.name.startswith(".") and f.stem not in ("1", "2") \
                and f.suffix.lower() in imgs:
            return f
    return None


def prepare_prompt(group: str, subject: str, desc: str, wd: Path, style: str = "") -> Path:
    """用链路自带的 compose_prompt_json 组提示词（--prompt-only，不生图、不计费）。"""
    orig = original_of(group)
    if orig is None:
        raise SystemExit(f"[G{group}] 找不到原图（组目录里没有可用的图片文件）")
    wd.mkdir(parents=True, exist_ok=True)
    src = wd / ("原图" + orig.suffix.lower())
    if src != orig:
        shutil.copy2(orig, src)
    slots = {
        "game_knowledge": "",
        "subject_description": desc,
        "image_analysis": "参考图为用户上传的原图。保留主体轮廓、主色分区与标志细节。舍弃：背景、阴影与无关内容。",
        "composition": "正方形画面，主体居中完整入画，主体高约占画面 85%，四周留少量透明空白。",
    }
    pj = wd / "prompt.json"
    pj.write_text(json.dumps(slots, ensure_ascii=False, indent=2), encoding="utf-8")
    cmd = [PY, str(SCRIPTS / "gen_and_recover.py"), str(src),
           "--work-dir", str(wd), "--prompt", str(pj),
           "--subject", subject, "--task-name", f"取材G{group}", "--prompt-only"]
    if style:
        cmd += ["--art-style", style]      # 画风对比：同一张原图换个画风再组一次提示词
    r = subprocess.run(cmd, capture_output=True, text=True, check=False)
    md = wd / ".wip" / "提示词" / "提示词.md"
    if not md.is_file():
        print(f"    [提示词失败 G{group}] rc={r.returncode} out={r.stdout[-200:]!r} err={r.stderr[-300:]!r}",
              flush=True)
    return md


def run_render(script: str, prompt: Path, src: Path, dst: Path, env_extra: dict, retries=2):
    """跑一次生图。val-perler 活动后端同一时刻只让一张图在生成（429 user_busy），
    遇到就按它给的 retry_after 等一会儿再来，所以它的重试次数给得多一些。"""
    env = dict(os.environ, NO_PROXY="*", **env_extra)
    tries = 6 if script == "image_render_vp.py" else retries
    for attempt in range(1, tries + 1):
        r = subprocess.run([PY, str(SCRIPTS / script), "--prompt", str(prompt),
                            "--image", str(src), "--output", str(dst)],
                           capture_output=True, text=True, env=env)
        tail = (r.stdout or "")[-400:] + (r.stderr or "")[-400:]
        if dst.is_file() and dst.stat().st_size > 1000:
            return True, tail
        if attempt < tries:
            wait = RETRY_BACKOFF
            if "user_busy" in tail or "429" in tail:
                wait = 20.0     # 活动后端：等前一张出完
            print(f"    [retry {attempt}/{tries - 1}，{wait:.0f}s] {script}: {tail[-160:]}", flush=True)
            time.sleep(wait)
    return False, tail


def one_job(spec: str, with_vp: bool) -> tuple[str, str]:
    group, subject, desc = (spec.split(":", 2) + ["", ""])[:3]
    subject = subject or "prop"
    style = getattr(one_job, "style", "")
    # 目录带 pid：本工具常被拆成「我方并行 + vp 串行」两个进程同时跑，共享临时目录会互相删
    wd = Path("/tmp/pixelart_raw") / f"G{group}-{style or 'base'}-{os.getpid()}"
    if wd.exists():
        shutil.rmtree(wd)
    prompt = prepare_prompt(group, subject, desc, wd, style)
    if not prompt.is_file():
        return group, f"提示词组不出来：{prompt}"
    src = next(wd.glob("原图.*"))
    key_env = {"PERLER_IMAGE_API_KEY": cfg("promptLLM")["apiKey"],
               "PERLER_IMAGE_BASE_URL": cfg("promptLLM")["baseUrl"],
               "PERLER_IMAGE_MODEL": cfg("promptLLM").get("model", "gpt-image-2.5")}
    vp_env = {"ACC_USER_ID": cfg("accUserId")}
    dst_dir = OUT / f"G{group}"
    dst_dir.mkdir(parents=True, exist_ok=True)
    ours_name = f"ours_{style}_raw.png" if style else "ours_raw.png"
    shutil.copy2(prompt, dst_dir / (f"prompt_{style}.md" if style else "prompt.md"))
    msg = []
    skip = getattr(one_job, "skip_ours", False)
    ok = skip or (dst_dir / ours_name).is_file()   # --vp-only 时没有 ours 也继续
    if not skip:
        ok, tail = run_render("image_render.py", prompt, src, dst_dir / ours_name, key_env)
        msg.append(("ours" if ok else "ours失败") + ("：" + tail.strip()[-160:] if not ok else ""))
    if ok and with_vp:
        ok2, tail2 = run_render("image_render_vp.py", prompt, src, dst_dir / "vp_raw.png", vp_env)
        msg.append("vp" if ok2 else "vp失败：" + tail2.strip()[-160:])
    return group, "  ".join(msg)


def _safe_job(spec: str, with_vp: bool) -> tuple[str, str]:
    """包一层：单组炸了（找不到原图、生图接口抽风）不许拖垮整批。"""
    try:
        return one_job(spec, with_vp)
    except Exception as e:      # noqa: BLE001
        return spec.split(":", 1)[0], f"失败：{type(e).__name__}: {e}"


def main(argv=None):
    argv = list(argv or [])
    specs = []
    with_vp = True
    workers = 3
    skip_ours = False
    for a in argv:
        if a == "--no-vp":
            with_vp = False
        elif a == "--vp-only":
            skip_ours = True
        elif a.startswith("--workers="):
            workers = int(a.split("=", 1)[1] or 3)
        elif a.startswith("--style="):
            one_job.style = a.split("=", 1)[1]
        else:
            specs.append(a)
    if not specs:
        print(__doc__)
        return
    one_job.skip_ours = skip_ours
    print(f"取材 {len(specs)} 组（{'双后端' if with_vp else '仅我方'}），并行 {workers}")
    with cf.ThreadPoolExecutor(max_workers=workers) as ex:
        futs = {ex.submit(_safe_job, s, with_vp): s for s in specs}
        for f in cf.as_completed(futs):
            g, m = f.result()
            print(f"[G{g}] {m}", flush=True)
    print("ALL DONE ->", OUT)


if __name__ == "__main__":
    main(sys.argv[1:])
