#!/usr/bin/env python3
"""login.py — 掌瓦扫码登录。登录后 image_render.py 自动走 ADP 登录池（更高配额）。

用法（统一入口 val_perler.py 转发到本脚本）：
    python3 scripts/val_perler.py login                     # 扫码登录（已登录则直接退出）
    python3 scripts/val_perler.py login --force             # 强制重新扫码（换账号）
    python3 scripts/val_perler.py login --set-auth-key <值> # 手动写入 auth_key（扫码失败兜底）
    python3 scripts/val_perler.py logout                    # 清本地登录凭据
"""

from __future__ import annotations

import argparse
import base64
import json
import os
import platform
import subprocess
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

import requests

# 复用 image_render 的底层工具（配置目录、WorkBuddy ID、服务地址、通用错误处理）。
# 同目录模块：Python 自动把脚本所在目录加入 sys.path；为确保函数内部 import 稳定也显式注入。
_SCRIPT_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(_SCRIPT_DIR))
import image_render as ir  # noqa: E402

# ---------- 常量 ----------

AUTH_KEY_CRED_KEY = "auth_key"
LOGIN_POLL_GAP_FALLBACK = 1.5   # 轮询 /zhawa/auth_key 的兜底间隔（秒）；掌瓦返回 gap 优先
LOGIN_TIMEOUT = 300             # 本地超时（秒）；掌瓦二维码官方 10min 有效，取其半防玩家长时间无响应
LOGIN_QR_FILE = "zhawa_login_qr.png"


# ---------- auth_key 本地缓存读写 ----------

def mask_token(value: str) -> str:
    """脱敏日志：短值回显长度、长值首尾 4 位 + 省略号。"""
    if not value:
        return ""
    if len(value) <= 8:
        return f"<len={len(value)}>"
    return f"{value[:4]}…{value[-4:]}"


def read_auth_key_cache() -> str | None:
    """从 credentials.json 读 auth_key；文件/字段/值任一缺失返回 None（不报错，让 caller 走匿名）。"""
    path = ir.credentials_path()
    if not path.is_file():
        return None
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
        entry = data.get(AUTH_KEY_CRED_KEY) if isinstance(data, dict) else None
        value = entry.get("value") if isinstance(entry, dict) else None
        value = value.strip() if isinstance(value, str) else ""
        return value or None
    except (OSError, ValueError, AttributeError):
        return None


def write_auth_key_cache(value: str, uuid: str = "") -> None:
    """保留文件已有字段（workbuddy_id 等），仅更新 auth_key 条目。写盘失败抛 OSError 给 caller。"""
    path = ir.credentials_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    data = {}
    if path.is_file():
        try:
            loaded = json.loads(path.read_text(encoding="utf-8"))
            if isinstance(loaded, dict):
                data = loaded
        except (OSError, ValueError):
            pass
    data[AUTH_KEY_CRED_KEY] = {
        "value": value,
        "uuid": uuid,
        "saved_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
    }
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")


def clear_auth_key_cache() -> bool:
    """清掉 credentials.json 的 auth_key 字段；返回是否原本有 key。workbuddy_id 不动。"""
    path = ir.credentials_path()
    if not path.is_file():
        return False
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return False
    if not isinstance(data, dict) or AUTH_KEY_CRED_KEY not in data:
        return False
    del data[AUTH_KEY_CRED_KEY]
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
    return True


def set_auth_key(raw: str) -> None:
    value = (raw or "").strip()
    if not value:
        ir.fail("--set-auth-key 的值不能为空；请从浏览器扫码后复制掌瓦返回的 auth_key。")
    try:
        write_auth_key_cache(value)
    except OSError as exc:
        ir.fail(f"auth_key 缓存写入失败（{exc.__class__.__name__}: {exc}）；缓存位置 {ir.credentials_path()}，"
                f"可用环境变量 {ir.CONFIG_DIR_ENV} 改到可写的位置后重试。")
    print(f"[SUCCESS] 已保存 auth_key {mask_token(value)}")


def logout() -> None:
    if clear_auth_key_cache():
        print("[SUCCESS] 已清除本地 auth_key（WorkBuddy ID 保留）")
    else:
        print("[INFO] 本地无 auth_key，无需清理")


# ---------- 扫码登录全流程内部辅助 ----------

def _image_viewer_open(path: Path) -> None:
    """跨平台调起图片查看器；失败不致命——玩家可按日志里的路径或 URL 兜底扫码。"""
    system = platform.system()
    try:
        if system == "Darwin":
            subprocess.run(["open", str(path)], check=False, timeout=5)
        elif system == "Windows":
            os.startfile(str(path))  # type: ignore[attr-defined]
        else:
            subprocess.run(["xdg-open", str(path)], check=False, timeout=5)
    except (OSError, subprocess.SubprocessError) as exc:
        print(f"[WARN] 自动开图失败（{exc.__class__.__name__}: {exc}），请手动打开上面打印的 PNG 路径",
              file=sys.stderr)


def _fetch_qr(base: str, wb_id: str) -> dict:
    """调 /zhawa/qr_code 获取 url + qr_id + qr_image（base64 PNG data URL）。"""
    headers = {ir.ID_HEADER: wb_id}
    try:
        resp = requests.post(f"{base}/zhawa/qr_code", headers=headers, timeout=15)
    except requests.RequestException as exc:
        ir.fail(f"获取二维码：连不上 ADP 服务 {base}（{exc.__class__.__name__}: {exc}）")
    if resp.status_code >= 500:
        ir.fail(f"获取二维码：ADP 服务异常 HTTP {resp.status_code}，{ir.service_error(resp)}")
    try:
        body = resp.json()
    except ValueError:
        ir.fail(f"获取二维码：ADP 响应非 JSON，HTTP {resp.status_code}，{resp.text[:500]}")
    if resp.status_code != 200:
        ir.fail(f"获取二维码：HTTP {resp.status_code}，error_code={body.get('error_code')}，msg={body.get('msg')}")
    if not body.get("qr_id") or not body.get("url"):
        ir.fail(f"获取二维码：响应缺字段，body={json.dumps(body, ensure_ascii=False)[:500]}")
    return body


def _decode_qr_image(data_url: str) -> bytes | None:
    """解码 ADP 返回的 data:image/png;base64,... 为 PNG 二进制；格式异常返回 None。"""
    if not isinstance(data_url, str) or "," not in data_url:
        return None
    header, _, b64 = data_url.partition(",")
    if "base64" not in header:
        return None
    try:
        return base64.b64decode(b64)
    except (ValueError, TypeError):
        return None


def _poll_auth(base: str, wb_id: str, qr_id: str, started: float) -> dict:
    """轮询 /zhawa/auth_key 直到 authorized / expired / 本地超时。
    返回授权成功的 body（含 auth_key、uuid）；其他情况内部 fail 退出。"""
    headers = {ir.ID_HEADER: wb_id, "Content-Type": "application/json"}
    print(f"[INFO] 开始等待扫码授权（最多 {LOGIN_TIMEOUT // 60} 分钟），Ctrl+C 可取消", flush=True)
    while True:
        if time.time() - started > LOGIN_TIMEOUT:
            ir.fail(f"扫码授权：{LOGIN_TIMEOUT}s 内未完成，已取消。请重新运行 `python3 scripts/val_perler.py login`。")
        try:
            resp = requests.post(f"{base}/zhawa/auth_key", headers=headers,
                                 data=json.dumps({"qr_id": qr_id}), timeout=15)
        except requests.RequestException as exc:
            print(f"[WARN] 轮询网络失败，{LOGIN_POLL_GAP_FALLBACK}s 后重试："
                  f"{exc.__class__.__name__}: {exc}", file=sys.stderr, flush=True)
            time.sleep(LOGIN_POLL_GAP_FALLBACK)
            continue
        if resp.status_code >= 500:
            print(f"[WARN] 轮询 ADP 5xx，{LOGIN_POLL_GAP_FALLBACK}s 后重试：HTTP {resp.status_code}",
                  file=sys.stderr, flush=True)
            time.sleep(LOGIN_POLL_GAP_FALLBACK)
            continue
        try:
            body = resp.json()
        except ValueError:
            ir.fail(f"轮询：ADP 响应非 JSON，HTTP {resp.status_code}，{resp.text[:500]}")
        if resp.status_code != 200:
            ir.fail(f"轮询：HTTP {resp.status_code}，error_code={body.get('error_code')}，msg={body.get('msg')}")
        status = body.get("status")
        if status == "authorized":
            return body
        if status == "expired":
            ir.fail("扫码授权：二维码已过期，请重新运行 `python3 scripts/val_perler.py login` 获取新二维码。")
        # pending：按掌瓦返回 gap 轮询，兜底 1.5s
        gap = body.get("gap")
        try:
            gap_sec = float(gap) if gap is not None else LOGIN_POLL_GAP_FALLBACK
        except (TypeError, ValueError):
            gap_sec = LOGIN_POLL_GAP_FALLBACK
        if gap_sec <= 0:
            gap_sec = LOGIN_POLL_GAP_FALLBACK
        time.sleep(gap_sec)


def _verify_existing(base: str, wb_id: str, auth_key: str) -> tuple[bool, bool, str]:
    """验证本地 auth_key 是否对 /zhawa/user_info 仍有效。
    返回 (是否有效, 是否明确失效, 诊断信息)：
    - (True,  False, nick):   有效
    - (False, True,  reason): 明确失效（401）→ 清本地 key 走扫码
    - (False, False, reason): 网络/5xx 等不确定错误 → fail 不动 key
    """
    headers = {ir.ID_HEADER: wb_id, "Authorization": f"Bearer {auth_key}"}
    try:
        resp = requests.get(f"{base}/zhawa/user_info", headers=headers, timeout=15)
    except requests.RequestException as exc:
        return False, False, f"网络失败: {exc.__class__.__name__}: {exc}"
    if resp.status_code >= 500:
        return False, False, f"ADP 服务异常 HTTP {resp.status_code}"
    # 401 即明确失效（HTTP 语义），body 解析失败（网关 HTML/空体）不影响判定：
    # 先判状态码再解析 JSON，避免「非 JSON 401」落进不确定错误分支导致该重登却不重登。
    if resp.status_code == 401:
        detail = "HTTP 401"
        try:
            body = resp.json()
            if body.get("error_code"):
                detail += f" error_code={body['error_code']}"
        except ValueError:
            pass
        return False, True, detail
    try:
        body = resp.json()
    except ValueError:
        return False, False, f"ADP 响应非 JSON HTTP {resp.status_code}"
    if resp.status_code == 200:
        return True, False, body.get("nick_name") or body.get("uuid") or "unknown"
    return False, False, f"HTTP {resp.status_code} error_code={body.get('error_code')}"


def ensure_valid_auth_key(base: str, wb_id: str, auth_key: str) -> str:
    """关键节点（生图）前校验 auth_key 合法性；发现授权被取消则主动重新扫码返回新 key。

    用户在掌瓦 App 端取消授权后，本地缓存的 auth_key 仍残留。若直接带它调生图，
    ADP 会在 render 网关侧返回 401，生图失败——事后才发现失效，太晚。这里前置校验：

    - 有效：原样返回 auth_key，继续带 Bearer 走 ADP 登录池
    - 明确失效（401，含 auth_key_expired）：清本地 key，自动拉起扫码授权（阻塞直到成功），返回新 key
    - 网络/5xx 等不确定：fail 退出（不静默降级匿名、也不带可能失效的 key 冒险撞 401）
    """
    ok, expired, detail = _verify_existing(base, wb_id, auth_key)
    if ok:
        return auth_key
    if not expired:
        ir.fail(f"校验掌瓦登录态失败：{detail}。请检查网络后重试生图。")
    print(f"[WARN] 掌瓦授权已被取消（{detail}），自动重新拉起扫码授权", file=sys.stderr, flush=True)
    try:
        clear_auth_key_cache()
    except OSError as exc:
        print(f"[WARN] 清本地 auth_key 失败（{exc.__class__.__name__}: {exc}），继续重新扫码",
              file=sys.stderr, flush=True)
    login(force=True)   # 重新扫码授权（阻塞直到完成；成功后已写入新 auth_key 缓存）
    new_key = read_auth_key_cache()
    if not new_key:
        ir.fail("重新扫码授权后仍未拿到 auth_key，请重试生图。")
    return new_key


# ---------- 登录主流程 ----------

def login(force: bool = False) -> None:
    """扫码登录掌瓦，拿到 auth_key 存本地 credentials.json。
    - 幂等：无 --force 时若本地 auth_key 仍有效，打印状态直接退出，不重新扫码
    - --force 时跳过验证直接扫码（换号用）
    - 本地 auth_key 失效时清掉并进扫码；网络/5xx 不动 key
    """
    wb_id, id_source = ir.resolve_workbuddy_id()
    base = ir.render_base()
    print(f"[INFO] ADP 服务: {base}")
    print(f"[INFO] WorkBuddy ID: {ir.mask_id(wb_id)}（来源 {id_source}）", flush=True)

    # 幂等检查：有本地 key 且未指定 --force 时先验证
    if not force:
        cached = read_auth_key_cache()
        if cached:
            ok, expired, detail = _verify_existing(base, wb_id, cached)
            if ok:
                print(f"[SUCCESS] 已登录（auth_key {mask_token(cached)}，用户 {detail}）；"
                      f"换号请加 --force 参数。")
                return
            if expired:
                print(f"[INFO] 本地 auth_key 已失效（{detail}），清本地缓存并重新扫码", flush=True)
                try:
                    clear_auth_key_cache()
                except OSError as exc:
                    print(f"[WARN] 清本地 auth_key 失败（{exc.__class__.__name__}: {exc}），继续",
                          file=sys.stderr)
            else:
                ir.fail(f"验证本地 auth_key 时失败：{detail}。为安全起见未动本地缓存，请检查网络后重试，"
                        f"或运行 `python3 scripts/val_perler.py login --force` 强制重登。")

    # 1. 获取二维码
    qr_body = _fetch_qr(base, wb_id)
    qr_id = qr_body["qr_id"]
    scan_url = qr_body["url"]
    png_bytes = _decode_qr_image(qr_body.get("qr_image", ""))

    # 2. PNG 落盘（失败不致命，URL 兜底）
    qr_png = ir.config_dir() / LOGIN_QR_FILE
    png_saved = False
    if png_bytes:
        try:
            qr_png.parent.mkdir(parents=True, exist_ok=True)
            qr_png.write_bytes(png_bytes)
            png_saved = True
        except OSError as exc:
            print(f"[WARN] 二维码 PNG 落盘失败（{exc.__class__.__name__}: {exc}），请用 URL 手动扫码",
                  file=sys.stderr)
    else:
        print("[WARN] ADP 未返回 qr_image 字段或格式异常，请用 URL 手动扫码", file=sys.stderr)

    # 3. 多通道展示
    print("")
    print("请用掌瓦 App 扫码授权（App → 扫一扫）：")
    if png_saved:
        print(f"  二维码图片：{qr_png}")
        print(f"  markdown：  ![掌瓦登录二维码](file://{qr_png})   # agent 对话场景可渲染")
    print(f"  扫码 URL：  {scan_url}")
    print("", flush=True)
    if png_saved:
        _image_viewer_open(qr_png)

    # 4. 轮询 + 保存 + 清理
    started = time.time()
    try:
        auth_body = _poll_auth(base, wb_id, qr_id, started)
    except KeyboardInterrupt:
        if png_saved:
            qr_png.unlink(missing_ok=True)
        print("\n[INFO] 已取消扫码登录（Ctrl+C）", file=sys.stderr)
        sys.exit(130)

    auth_key = (auth_body.get("auth_key") or "").strip()
    uuid_val = (auth_body.get("uuid") or "").strip()
    if not auth_key:
        if png_saved:
            qr_png.unlink(missing_ok=True)
        ir.fail(f"轮询返回 authorized 但 auth_key 为空，响应异常："
                f"{json.dumps(auth_body, ensure_ascii=False)[:500]}")

    try:
        write_auth_key_cache(auth_key, uuid_val)
    except OSError as exc:
        if png_saved:
            qr_png.unlink(missing_ok=True)
        ir.fail(f"扫码成功但 auth_key 写盘失败（{exc.__class__.__name__}: {exc}）；"
                f"请手动执行：python3 scripts/val_perler.py login --set-auth-key '{auth_key}'")

    if png_saved:
        qr_png.unlink(missing_ok=True)
    print(f"[SUCCESS] 扫码登录成功，已保存 auth_key {mask_token(auth_key)}"
          + (f"（掌瓦 uuid={uuid_val}）" if uuid_val else ""))


# ---------- CLI ----------

def main() -> None:
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--login", action="store_true",
                        help="扫码登录掌瓦；本地 auth_key 仍有效时直接退出（加 --force 强制重登）")
    parser.add_argument("--force", action="store_true",
                        help="与 --login 搭配：跳过有效性验证直接扫码（换账号用）")
    parser.add_argument("--set-auth-key", metavar="VALUE", help="手动写入 auth_key 到本地缓存（扫码失败兜底）")
    parser.add_argument("--logout", action="store_true", help="清本地 auth_key（WorkBuddy ID 保留）")
    args = parser.parse_args()

    actions = [bool(args.login), bool(args.set_auth_key), bool(args.logout)]
    if sum(actions) == 0:
        parser.error("必须指定 --login / --set-auth-key / --logout 其中之一")
    if sum(actions) > 1:
        parser.error("--login / --set-auth-key / --logout 互斥，一次只能用一个")
    if args.force and not args.login:
        parser.error("--force 必须与 --login 搭配使用")

    if args.login:
        login(force=args.force)
        return
    if args.set_auth_key:
        set_auth_key(args.set_auth_key)
        return
    if args.logout:
        logout()
        return


if __name__ == "__main__":
    main()
