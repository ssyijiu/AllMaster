#!/usr/bin/env python3
"""image_render.py — 生图 CLI（图生图 / 文生图，OpenAI Images API 兼容后端）

后端：apinebula（https://apinebula.ai/v1），模型 gpt-image-2 / gpt-image-2.5。
2026-10-28 起替换原 val-perler.qq.com 活动后端（接口不公开、无 SLA，不适合收费产品）。

接口（同步返回，无轮询）：

    POST {base}/images/edits        图生图：multipart image + prompt [size] [quality] [background] [output_format]
    POST {base}/images/generations  文生图：JSON 同上（无 image）
    响应 data[0].b64_json 优先，其次 data[0].url（自动下载）

凭据（由 generate.js spawn 时注入环境变量，密钥不进代码）：

    PERLER_IMAGE_BASE_URL  默认 https://apinebula.ai/v1
    PERLER_IMAGE_API_KEY   必填，缺失时报错退出
    PERLER_IMAGE_MODEL     默认 gpt-image-2.5

用法（统一入口 val_perler.py 转发到本脚本）：
    python3 scripts/val_perler.py render -p prompt.md -i ref.png -o out.png
    python3 scripts/val_perler.py render --health      # 连通性 + 鉴权检查
    python3 scripts/val_perler.py render --check-id    # 校验 API Key（兼容旧 env-check 调用）
    python3 scripts/val_perler.py render --set-id <值>  # 已废弃，仅保留兼容

与 GPT Image 参数对齐说明：
    quality  支持 auto/low/medium/high；旧档位 xhigh/max 就近映射为 high（打 WARN）。
    size     支持 1024x1024 / 1536x1024 / 1024x1536 / auto；其他 WxH 就近映射为 1024x1024（打 WARN）。
    background 支持 auto/opaque/transparent（与 GPT Image 一致）。
"""

from __future__ import annotations

import argparse
import base64
import json
import mimetypes
import os
import re
import sys
import time
from pathlib import Path

import requests

DEFAULT_BASE = "https://apinebula.ai/v1"
BASE_ENV = "PERLER_IMAGE_BASE_URL"
KEY_ENV = "PERLER_IMAGE_API_KEY"
MODEL_ENV = "PERLER_IMAGE_MODEL"
DEFAULT_MODEL = "gpt-image-2.5"
# 兼容 gen_and_recover.py 对本模块常量与 render_base() 的引用（词汇表与 GPT Image 原生对齐）
DEFAULT_SIZE = "1024x1024"
DEFAULT_QUALITY = "low"
DEFAULT_BACKGROUND = "transparent"
DEFAULT_OUTPUT_FORMAT = "png"
VALID_SIZES = {"auto", "1024x1024", "1536x1024", "1024x1536"}
VALID_QUALITIES = {"auto", "low", "medium", "high"}
RETRY_ATTEMPTS = 2          # 仅连接层错误与 502/503 重试（项目重试纪律）
RETRY_BACKOFF = 2.0
HTTP_TIMEOUT = 300          # gpt-image 同步出图实测 30~120s，放宽到 5 分钟
KEY_MASK_RE = re.compile(r"^(.{4}).*(.{4})$")


def fail(message: str) -> None:
    print(f"[ERROR] {message}", file=sys.stderr)
    sys.exit(1)


def render_base() -> str:
    """服务地址：env 覆盖 → 默认 apinebula。"""
    return (os.environ.get(BASE_ENV, "").strip() or DEFAULT_BASE).rstrip("/")


def resolve_key() -> tuple[str, str]:
    """返回 (api_key, 来源)。只认 env（generate.js 从 .pixelart-config.json 读好注入）。"""
    value = (os.environ.get(KEY_ENV) or "").strip()
    if value:
        return value, "env"
    fail("没有找到生图 API Key（环境变量 PERLER_IMAGE_API_KEY 为空）。"
         "请在服务器 .pixelart-config.json 的 promptLLM.apiKey 配好 Key，并重启 allmaster 服务。")


def resolve_model() -> str:
    return (os.environ.get(MODEL_ENV, "").strip() or DEFAULT_MODEL)


def mask_key(value: str) -> str:
    m = KEY_MASK_RE.match(value)
    return f"{m.group(1)}…{m.group(2)}" if m else "***"


def headers_with_auth() -> dict:
    key, _ = resolve_key()
    return {"Authorization": f"Bearer {key}"}


def service_error(resp: requests.Response) -> str:
    try:
        body = resp.json()
    except ValueError:
        return resp.text[:2000]
    if isinstance(body, dict):
        err = body.get("error")
        if isinstance(err, dict) and err.get("message"):
            return str(err["message"])[:2000]
        if isinstance(err, str) and err:
            return err[:2000]
        for key in ("detail", "error", "message"):
            if body.get(key):
                value = body[key]
                return value if isinstance(value, str) else json.dumps(value, ensure_ascii=False)[:2000]
    return json.dumps(body, ensure_ascii=False)[:2000]


def request_with_retry(method: str, url: str, step: str, **kwargs) -> requests.Response:
    """只对连接层错误与 502/503 重试（重试纪律：不确定是否计费的失败不重试）。"""
    last_err = None
    for attempt in range(1, RETRY_ATTEMPTS + 1):
        try:
            resp = requests.request(method, url, **kwargs)
        except requests.RequestException as exc:
            last_err = f"{exc.__class__.__name__}: {exc}"
        else:
            if resp.status_code in (502, 503) and attempt < RETRY_ATTEMPTS:
                last_err = f"HTTP {resp.status_code}"
                print(f"[WARN] {step}：{last_err}，{RETRY_BACKOFF}s 后重试 {attempt}/{RETRY_ATTEMPTS - 1}", flush=True)
                time.sleep(RETRY_BACKOFF)
                continue
            return resp
        if attempt < RETRY_ATTEMPTS:
            print(f"[WARN] {step}：{last_err}，{RETRY_BACKOFF}s 后重试 {attempt}/{RETRY_ATTEMPTS - 1}", flush=True)
            time.sleep(RETRY_BACKOFF)
    fail(f"{step}：连不上生图服务 {url}（{last_err}）")


def health() -> None:
    """连通性 + 鉴权一次验掉：GET /models 需要 Bearer，401/403 即 Key 无效。"""
    base = render_base()
    url = f"{base}/models"
    print(f"[INFO] 连通性测试: {url}", flush=True)
    resp = request_with_retry("GET", url, "连通性测试",
                              headers=headers_with_auth(), timeout=20)
    if resp.status_code in (401, 403):
        fail(f"连通性测试：HTTP {resp.status_code}（API Key 无效或无权限），{service_error(resp)}")
    if resp.status_code != 200:
        fail(f"连通性测试：HTTP {resp.status_code}，{service_error(resp)}")
    key, source = resolve_key()
    print(f"[SUCCESS] 服务连通：HTTP 200，模型 {resolve_model()}，API Key {mask_key(key)}（来源 {source}）")


def check_id() -> None:
    """兼容旧 env-check 的深度自检入口：实际校验 API Key 可用性。"""
    key, source = resolve_key()
    base = render_base()
    resp = request_with_retry("GET", f"{base}/models", "Key 校验",
                              headers={"Authorization": f"Bearer {key}"}, timeout=20)
    if resp.status_code in (401, 403):
        fail(f"Key 校验失败：HTTP {resp.status_code}（Key 无效或无权限）")
    if resp.status_code != 200:
        fail(f"Key 校验失败：HTTP {resp.status_code}，{service_error(resp)}")
    print(f"[SUCCESS] 生图 API 可用，模型 {resolve_model()}，Key {mask_key(key)}，来源：{source}")


def set_id(raw: str) -> None:
    print("[WARN] --set-id 已废弃（apinebula 后端不需要 WB ID）；凭据请在 .pixelart-config.json 配置。", flush=True)


def normalize_size(size: str) -> str:
    value = (size or "").strip().lower()
    if value in VALID_SIZES:
        return value
    print(f"[WARN] 生图尺寸 {size} 不被 GPT Image 支持，回落 1024x1024", flush=True)
    return "1024x1024"


def normalize_quality(quality: str) -> str:
    value = (quality or "").strip().lower()
    if value in VALID_QUALITIES:
        return value
    if value in ("xhigh", "max"):
        print(f"[WARN] 画质档位 {quality} 映射为 high", flush=True)
        return "high"
    print(f"[WARN] 画质档位 {quality} 不识别，回落 auto", flush=True)
    return "auto"


def extract_image_bytes(body: dict, headers: dict) -> bytes:
    """从响应取图：b64_json 优先；url 兜底（部分网关只回链接）。"""
    data = body.get("data") if isinstance(body, dict) else None
    if not isinstance(data, list) or not data:
        fail(f"生图响应缺少 data 数组：{json.dumps(body, ensure_ascii=False)[:500]}")
    item = data[0] if isinstance(data[0], dict) else {}
    if item.get("b64_json"):
        return base64.b64decode(item["b64_json"])
    url = item.get("url")
    if url:
        resp = request_with_retry("GET", url, "取图", headers=headers, timeout=HTTP_TIMEOUT)
        if resp.status_code != 200:
            fail(f"取图：HTTP {resp.status_code}，{service_error(resp)}")
        return resp.content
    fail(f"生图响应既无 b64_json 也无 url：{json.dumps(body, ensure_ascii=False)[:500]}")


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

    key, key_source = resolve_key()
    model = resolve_model()
    base = render_base()
    size_n = normalize_size(size)
    quality_n = normalize_quality(quality)
    auth = {"Authorization": f"Bearer {key}"}

    print(f"[INFO] 生图服务: {base}（OpenAI Images 兼容）")
    print(f"[INFO] 模型: {model}，API Key {mask_key(key)}（来源 {key_source}）")
    print(f"[INFO] 参考图: {image}（{image.stat().st_size:,} bytes），prompt {len(prompt)} 字符" if image
          else f"[INFO] 文生图（无参考图），prompt {len(prompt)} 字符")
    print(f"[INFO] size={size_n} quality={quality_n} "
          f"background={background} output_format={output_format}", flush=True)

    form = {
        "model": model,
        "prompt": prompt,
        "size": size_n,
        "quality": quality_n,
        "background": background,
        "output_format": output_format,
        "n": 1,
    }
    if image is None:
        resp = request_with_retry("POST", f"{base}/images/generations", "提交",
                                  headers=dict(auth, **{"Content-Type": "application/json"}),
                                  json=form, timeout=HTTP_TIMEOUT)
    else:
        mime = mimetypes.guess_type(image.name)[0] or "application/octet-stream"
        with image.open("rb") as fh:
            resp = request_with_retry("POST", f"{base}/images/edits", "提交",
                                      headers=auth, data=form,
                                      files={"image": (image.name, fh, mime)}, timeout=HTTP_TIMEOUT)
    if resp.status_code in (401, 403):
        fail(f"提交：HTTP {resp.status_code}（API Key 无效或无权限），{service_error(resp)}")
    if resp.status_code != 200:
        fail(f"提交：HTTP {resp.status_code}，{service_error(resp)}")
    try:
        body = resp.json()
    except ValueError:
        fail(f"提交：响应不是 JSON：{resp.text[:300]}")

    image_bytes = extract_image_bytes(body, auth)
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_bytes(image_bytes)
    print(f"[SUCCESS] 已保存: {output}（{len(image_bytes):,} bytes）")
    return output


def main() -> None:
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--health", action="store_true", help="请求 /models 测试连通性与鉴权，不生图")
    parser.add_argument("--check-id", action="store_true", help="校验生图 API Key（兼容旧调用方），不生图")
    parser.add_argument("--set-id", metavar="UUID", help="已废弃，仅保留参数兼容")
    parser.add_argument("--prompt", "-p", type=Path, help="prompt 文件（全文作为提示词）")
    parser.add_argument("--image", "-i", type=Path, help="参考图；不传即文生图")
    parser.add_argument("--output", "-o", type=Path, help="输出 PNG 路径")
    parser.add_argument("--size", "-s", default=DEFAULT_SIZE, help=f"默认 {DEFAULT_SIZE}")
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
        parser.error("生图需要 --prompt 和 --output（--image 不传即文生图）；仅测试连通性请用 --health")
    render(args.prompt, args.image, args.output, args.size,
           args.quality, args.background, args.output_format)


if __name__ == "__main__":
    main()
