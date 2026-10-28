#!/usr/bin/env python3
"""image_render_vp.py — 经典版生图 CLI（val-perler.qq.com 后端，供 /pixelart 双后端并存）

由原 image_render.py 恢复而来（后端切换 apinebula 前的版本），掌瓦登录依赖已内联桩化。

调用团队渲染服务的异步三步接口：

    POST /render/submit              图生图：multipart image prompt [size] [quality] [background] [output_format]
                                     文生图：不传 image，同样字段以 JSON 提交
    GET  /render/query?task_id=...   每 poll_interval_seconds 秒轮询，succeeded / failed 为终态
    GET  /render/result/{task_id}    PNG 二进制（透明背景 RGBA）

服务地址固定为 DEFAULT_BASE（https://val-perler.qq.com）。
取图地址按配置的服务地址拼接，不使用查询结果里的 result_url。
任务在服务端只保留 2 小时，拿到结果立即落盘。

每个生图请求（提交、查询、取图）的请求头都带玩家的 WorkBuddy ID。取值顺序：
环境变量 ACC_USER_ID → 个人配置目录名 ~/.workbuddy/user-<ID>-personal → 本地缓存
~/.config/valorant-perler/credentials.json（PERLER_CONFIG_DIR 可改目录）。读到前两者就刷新缓存；
三者都没有时不发请求，非零退出并说明下一步。

若 credentials.json 里存了掌瓦 auth_key（通过 `python3 scripts/val_perler.py login` 写入），
每次请求会自动带 `Authorization: Bearer <auth_key>`，ADP 走登录池额度；无 auth_key 则走匿名池。
掌瓦登录在同目录的 login.py，本脚本不处理登录。

用法（统一入口 val_perler.py 转发到本脚本）：
    python3 scripts/val_perler.py render -p prompt.md -i ref.png -o out.png
    python3 scripts/val_perler.py render --health
    python3 scripts/val_perler.py render --check-id         # 只检查 WorkBuddy ID，不生图
    python3 scripts/val_perler.py render --set-id <UUID>    # 校验后写入本地缓存
"""

from __future__ import annotations

import argparse
import json
import mimetypes
import os
import re
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

import requests

DEFAULT_BASE = "https://val-perler.qq.com"
ID_HEADER = "X-WB-Id"
ID_ENV = "ACC_USER_ID"
CONFIG_DIR_ENV = "PERLER_CONFIG_DIR"
CRED_FILE = "credentials.json"
CRED_KEY = "workbuddy_id"
ID_DIR_PATTERN = "user-*-personal"
UUID_RE = re.compile(r"[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}")
DEFAULT_SIZE = "1024x1024"
DEFAULT_QUALITY = "low"
DEFAULT_BACKGROUND = "transparent"
DEFAULT_OUTPUT_FORMAT = "png"
POLL_INTERVAL = 5
POLL_TIMEOUT = 600
POLL_MAX_MISSES = 5   # 轮询连续失败（连不上 / 5xx）多少次才放弃；查询是幂等的，单次抖动不整单失败


def fail(message: str) -> None:
    print(f"[ERROR] {message}", file=sys.stderr)
    sys.exit(1)


def render_base() -> str:
    """服务地址：固定为 DEFAULT_BASE。"""
    return DEFAULT_BASE.rstrip("/")


def normalize_id(value: str | None) -> str | None:
    """标准 UUID 返回小写形式，其余返回 None。"""
    value = (value or "").strip()
    return value.lower() if UUID_RE.fullmatch(value) else None


def mask_id(value: str) -> str:
    return f"{value[:4]}…{value[-4:]}"


def config_dir() -> Path:
    override = os.environ.get(CONFIG_DIR_ENV, "").strip()
    return Path(override) if override else Path.home() / ".config" / "valorant-perler"


def credentials_path() -> Path:
    return config_dir() / CRED_FILE


def read_id_from_env() -> str | None:
    return normalize_id(os.environ.get(ID_ENV))


def read_id_from_dir() -> str | None:
    """个人配置目录名 user-<ID>-personal 里的 ID；多个目录取修改时间最新的。"""
    config = os.environ.get("WORKBUDDY_CONFIG_DIR", "").strip()
    root = Path(config) if config else Path.home() / ".workbuddy"
    found = []
    for path in root.glob(ID_DIR_PATTERN):
        value = normalize_id(path.name[len("user-"):-len("-personal")])
        if value and path.is_dir():
            found.append((path.stat().st_mtime, value))
    return max(found)[1] if found else None


def read_id_cache() -> str | None:
    path = credentials_path()
    if not path.is_file():
        return None
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
        entry = data.get(CRED_KEY) if isinstance(data, dict) else None
        return normalize_id(entry.get("id") if isinstance(entry, dict) else None)
    except (OSError, ValueError, AttributeError):
        return None


def write_id_cache(value: str, source: str) -> None:
    path = credentials_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    data = {}
    if path.is_file():
        try:
            loaded = json.loads(path.read_text(encoding="utf-8"))
            if isinstance(loaded, dict):
                data = loaded
        except (OSError, ValueError):
            pass
    data[CRED_KEY] = {"id": value, "source": source,
                      "saved_at": datetime.now(timezone.utc).isoformat(timespec="seconds")}
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")


def resolve_workbuddy_id() -> tuple[str, str]:
    """返回 (ID, 来源)。实时来源（环境变量、个人配置目录）优先并刷新缓存，其次本地缓存；都没有则退出。"""
    for source, reader in (("env", read_id_from_env), ("dir", read_id_from_dir)):
        value = reader()
        if value:
            try:
                write_id_cache(value, source)
            except OSError as exc:
                print(f"[WARN] WorkBuddy ID 缓存写入失败（{exc.__class__.__name__}: {exc}），本次照常使用", file=sys.stderr)
            return value, source
    value = read_id_cache()
    if value:
        return value, "cache"
    fail("没有找到玩家的 WorkBuddy ID，本次没有发起生图。"
         "请按 skills/valorant-perler/SKILL.md「WorkBuddy ID」一节查找；"
         "找到后运行 `python3 scripts/val_perler.py render --set-id <ID>` 保存，再重新生图。")


def check_id() -> None:
    value, source = resolve_workbuddy_id()
    print(f"[SUCCESS] WorkBuddy ID {mask_id(value)}，来源：{source}")


def set_id(raw: str) -> None:
    value = normalize_id(raw)
    if not value:
        fail("--set-id 需要标准 UUID（形如 xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx）；不要用昵称、手机号或其他字符串代替。")
    try:
        write_id_cache(value, "agent")
    except OSError as exc:
        fail(f"WorkBuddy ID 缓存写入失败（{exc.__class__.__name__}: {exc}）；缓存位置 {credentials_path()}，"
             f"可用环境变量 {CONFIG_DIR_ENV} 改到可写的位置后重试。")
    print(f"[SUCCESS] 已保存 WorkBuddy ID {mask_id(value)}")



def service_error(resp: requests.Response) -> str:
    """服务返回的错误原文（优先取 JSON 里的说明字段）。"""
    try:
        body = resp.json()
    except ValueError:
        return resp.text[:2000]
    if isinstance(body, dict):
        if body.get("error_code"):
            return service_error_from_body(body)
        for key in ("detail", "error", "message"):
            if body.get(key):
                value = body[key]
                return value if isinstance(value, str) else json.dumps(value, ensure_ascii=False)
    return json.dumps(body, ensure_ascii=False)[:2000]


def request(method: str, url: str, step: str, **kwargs) -> requests.Response:
    try:
        return requests.request(method, url, **kwargs)
    except requests.RequestException as exc:
        fail(f"{step}：连不上渲染服务 {url}（{exc.__class__.__name__}: {exc}）")


def health() -> None:
    """检查服务连通性，不提交生图任务。"""
    url = f"{render_base()}/health"
    print(f"[INFO] 连通性测试: {url}", flush=True)
    resp = request("GET", url, "连通性测试", timeout=15, allow_redirects=False)
    if resp.status_code != 200:
        fail(f"连通性测试：HTTP {resp.status_code}，{service_error(resp)}")
    print(f"[SUCCESS] 服务连通：HTTP 200，{resp.text[:2000]}")


def build_form(prompt: str, size: str, quality: str,
               background: str, output_format: str) -> dict:
    return {
        "prompt": prompt,
        "size": size,
        "quality": quality,
        "background": background,
        "output_format": output_format,
    }


def submit(base: str, image: Path | None, form: dict, headers: dict) -> dict:
    if image is None:
        resp = request("POST", f"{base}/render/submit", "提交", headers=headers, json=form, timeout=180)
    else:
        mime = mimetypes.guess_type(image.name)[0] or "application/octet-stream"
        with image.open("rb") as fh:
            resp = request("POST", f"{base}/render/submit", "提交", headers=headers,
                           data=form, files={"image": (image.name, fh, mime)}, timeout=180)
    if resp.status_code != 200:
        fail(f"提交：HTTP {resp.status_code}，{service_error(resp)}")
    body = resp.json()
    if not body.get("task_id"):
        fail(f"提交：服务未返回 task_id，{json.dumps(body, ensure_ascii=False)}")
    return body


def wait(base: str, task_id: str, interval: int, headers: dict) -> dict:
    deadline = time.time() + POLL_TIMEOUT
    last = None
    misses = 0
    while time.time() < deadline:
        time.sleep(interval)
        try:
            resp = requests.request("GET", f"{base}/render/query", params={"task_id": task_id},
                                    headers=headers, timeout=60)
            error = None if resp.status_code < 500 else f"HTTP {resp.status_code}，{service_error(resp)}"
        except requests.RequestException as exc:
            error = f"{exc.__class__.__name__}: {exc}"
        if error:
            misses += 1
            if misses >= POLL_MAX_MISSES:
                fail(f"轮询：连续 {misses} 次失败（task_id={task_id}），最后一次 {error}")
            print(f"[WARN] 轮询失败 {misses}/{POLL_MAX_MISSES}，继续等待：{error}", flush=True)
            continue
        misses = 0
        if resp.status_code != 200:
            fail(f"轮询：HTTP {resp.status_code}，{service_error(resp)}")
        body = resp.json()
        status = body.get("status")
        if status != last:
            print(f"[INFO] 任务状态: {status}", flush=True)
            last = status
        if status == "succeeded":
            return body
        if status == "failed":
            fail(f"生图任务失败（task_id={task_id}）：{service_error_from_body(body)}")
    fail(f"轮询：{POLL_TIMEOUT}s 内未完成（task_id={task_id}）")


def service_error_from_body(body: dict) -> str:
    """失败原因：带上服务的 error_code（如 rate_limited），再接说明原文。"""
    code = body.get("error_code")
    prefix = f"error_code={code}，" if code else ""
    for key in ("error", "detail", "message"):
        if body.get(key):
            value = body[key]
            return prefix + (value if isinstance(value, str) else json.dumps(value, ensure_ascii=False))
    return prefix + json.dumps(body, ensure_ascii=False)


def download(base: str, task_id: str, output: Path, headers: dict) -> int:
    resp = request("GET", f"{base}/render/result/{task_id}", "取图", headers=headers, timeout=180)
    if resp.status_code != 200:
        fail(f"取图：HTTP {resp.status_code}，{service_error(resp)}")
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_bytes(resp.content)
    return len(resp.content)


def render(prompt_path: Path, image: Path | None, output: Path,
           size: str = DEFAULT_SIZE, quality: str = DEFAULT_QUALITY,
           background: str = DEFAULT_BACKGROUND,
           output_format: str = DEFAULT_OUTPUT_FORMAT) -> Path:
    if not prompt_path.is_file():
        fail(f"prompt 文件不存在：{prompt_path}")
    prompt = prompt_path.read_text(encoding="utf-8").strip()
    if not prompt:
        fail(f"prompt 文件为空：{prompt_path}")
    if image is not None and not image.is_file():
        fail(f"参考图不存在：{image}")

    wb_id, id_source = resolve_workbuddy_id()
    headers = {ID_HEADER: wb_id}
    base = render_base()
    # 经典版内联桩：产品链路从不使用掌瓦登录（无 credentials.json auth_key），
    # 原 login.py 依赖随生图后端切换移除，这里以常量替代——永远走 WB ID 活动池。
    def mask_token(t):
        return "stub"

    auth_key = None
    form = build_form(prompt, size, quality, background, output_format)
    print(f"[INFO] 渲染服务: {base}")
    print(f"[INFO] WorkBuddy ID: {mask_id(wb_id)}（来源 {id_source}）"
          + (f"，掌瓦登录态 auth_key {mask_token(auth_key)}" if auth_key else "，匿名模式"))
    print(f"[INFO] 参考图: {image}（{image.stat().st_size:,} bytes），prompt {len(prompt)} 字符" if image
          else f"[INFO] 文生图（无参考图），prompt {len(prompt)} 字符")
    print(f"[INFO] size={size} quality={quality} "
          f"background={background} output_format={output_format}", flush=True)

    body = submit(base, image, form, headers)
    task_id = body["task_id"]
    interval = int(body.get("poll_interval_seconds") or POLL_INTERVAL)
    print(f"[INFO] task_id={task_id}，每 {interval}s 轮询", flush=True)
    if body.get("status") != "succeeded":
        wait(base, task_id, interval, headers)

    size_bytes = download(base, task_id, output, headers)
    print(f"[SUCCESS] 已保存: {output}（{size_bytes:,} bytes）")
    return output


def main() -> None:
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--health", action="store_true", help="请求 /health 测试连通性，不生图")
    parser.add_argument("--check-id", action="store_true", help="检查能否取得 WorkBuddy ID，打印来源与脱敏值，不生图")
    parser.add_argument("--set-id", metavar="UUID", help="校验 WorkBuddy ID 并写入本地缓存，不生图")
    parser.add_argument("--prompt", "-p", type=Path, help="prompt 文件（全文作为提示词）")
    parser.add_argument("--image", "-i", type=Path, help="参考图；不传即文生图（须玩家同意，见 SKILL.md）")
    parser.add_argument("--output", "-o", type=Path, help="输出 PNG 路径")
    parser.add_argument("--size", "-s", default=DEFAULT_SIZE, help=f"WxH，宽高为 16 的倍数，默认 {DEFAULT_SIZE}")
    parser.add_argument("--quality", "-q", default=DEFAULT_QUALITY, help=f"默认 {DEFAULT_QUALITY}")
    parser.add_argument("--background", default=DEFAULT_BACKGROUND, help=f"默认 {DEFAULT_BACKGROUND}")
    parser.add_argument("--output-format", default=DEFAULT_OUTPUT_FORMAT, help=f"默认 {DEFAULT_OUTPUT_FORMAT}")
    args = parser.parse_args()
    if args.health:
        health()
        return
    if args.check_id:
        check_id()
        return
    if args.set_id:
        set_id(args.set_id)
        return
    if not all((args.prompt, args.output)):
        parser.error("生图需要 --prompt 和 --output（--image 不传即文生图）；仅测试连通性请用 --health，检查 ID 请用 --check-id；"
                     "掌瓦登录请用 `python3 scripts/val_perler.py login`")
    render(args.prompt, args.image, args.output, args.size,
           args.quality, args.background, args.output_format)


if __name__ == "__main__":
    main()