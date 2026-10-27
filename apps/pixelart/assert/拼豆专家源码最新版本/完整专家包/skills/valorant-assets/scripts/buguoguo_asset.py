#!/usr/bin/env python3
"""无畏契约官方资产取数脚本（数据源：无畏协议库 val-api.buguoguo.cn/v1）。

给拼豆流程按名字找官方素材图并下载作生图参考：英雄立绘/头像、武器皮肤渲染图、
卡面、喷漆、挂饰、地图、皮肤主题（礼包不进拼豆图纸，不收）。接口数据本地缓存 24 小时，断网或
缓存未过期时不重复请求。

用法：
    python3 buguoguo_asset.py search <关键词> [--type 英雄] [--limit 12] [--refresh] [--offline]
    python3 buguoguo_asset.py list [--type 英雄] [--filter 关键词] [--limit 200] [--refresh] [--offline]
    python3 buguoguo_asset.py get <uuid> [--out 保存目录] [--max 4] [--refresh] [--offline]

    search  按资产名称与字段检索候选，输出 JSON 清单（uuid、名称、可用图链接）。
            对象与款式须核对；查无此项时 found=0 并给下一步建议。
    list    列出某一类资产的全部条目，供确认名称后仍无命中时逐项核对。
    get     按 uuid 下载该条目的官方图（PNG/JPG/GIF/WEBP 校验魔数后落盘）。

退出码：0 成功；1 出错（网络失败、uuid 不存在等）。search 没命中不算出错（found=0）。

只依赖标准库（Python 3.9+）。
"""
from __future__ import annotations

import argparse
import json
import re
import sys
import time
import tempfile
from pathlib import Path
from urllib.request import Request, urlopen

API_BASE = "https://val-api.buguoguo.cn/v1"
LANGUAGE = "zh-CN"
CACHE_TTL = 24 * 3600
HEADERS = {"User-Agent": "Mozilla/5.0"}
IMAGE_EXTS = {".png", ".jpg", ".jpeg", ".webp", ".gif"}

# 皮肤记录里优先取的图字段（按序），其余条目按记录里出现的全部图链兜底。
SKIN_FIELDS = ["fullRender", "displayIcon"]
AGENT_FIELDS = ["fullPortrait", "fullPortraitV2", "displayIcon", "background"]

# --type 的取值：接口资源名与玩家说法都收。
TYPE_ALIASES = {
    "英雄": "agents", "agent": "agents", "agents": "agents",
    "皮肤": "skins", "skin": "skins", "skins": "skins",
    "地图": "maps", "map": "maps", "maps": "maps",
    "喷漆": "sprays", "spray": "sprays", "sprays": "sprays",
    "卡面": "playercards", "playercard": "playercards", "playercards": "playercards",
    "挂饰": "buddies", "buddy": "buddies", "buddies": "buddies",
    "主题": "themes", "theme": "themes", "themes": "themes",
}


def fail(msg: str):
    print(f"错误：{msg}", file=sys.stderr)
    raise SystemExit(1)


def http_json(url: str):
    try:
        with urlopen(Request(url, headers=HEADERS), timeout=60) as resp:
            payload = json.loads(resp.read().decode("utf-8"))
    except Exception as exc:  # noqa: BLE001
        fail(f"接口请求失败（{url}）：{exc}")
    if payload.get("status") != 200:
        fail(f"接口返回异常 status={payload.get('status')}（{url}）")
    return payload["data"]


def cache_dir() -> Path | None:
    for root in (Path.home() / ".cache", Path(tempfile.gettempdir())):
        d = root / "valorant_assets"
        try:
            d.mkdir(parents=True, exist_ok=True)
            probe = d / ".probe"
            probe.write_text("1", encoding="utf-8")
            probe.unlink()
            return d
        except OSError:
            continue
    return None


def load_resource(name: str, refresh: bool = False, offline: bool = False):
    """读一个接口资源，带 24h 缓存。offline 下允许用过期缓存，refresh 强制重拉。"""
    cdir = cache_dir()
    path = cdir / f"{name}.json" if cdir else None
    if path and path.exists() and not refresh:
        try:
            wrapped = json.loads(path.read_text(encoding="utf-8"))
            if offline or time.time() - wrapped["fetched_at"] < CACHE_TTL:
                return wrapped["data"]
        except (OSError, ValueError, KeyError):
            pass
    if offline:
        fail(f"本地没有{name}的缓存且当前不允许联网（--offline），先去掉 --offline 跑一次。")
    data = http_json(f"{API_BASE}/{name}?language={LANGUAGE}")
    if path:
        try:
            path.write_text(json.dumps({"fetched_at": time.time(), "data": data},
                                       ensure_ascii=False), encoding="utf-8")
        except OSError:
            pass
    return data


def norm(text: str) -> str:
    return re.sub(r"\s+", "", (text or "")).lower()


def safe_name(text: str) -> str:
    return re.sub(r"\s+", "_", re.sub(r'[\\/:*?"<>|()]+', "-", text or "")).strip("_-")


def image_assets(record: dict, prefer: list | None = None, cap: int | None = None) -> dict:
    """从一条接口记录里挑图链：先按 prefer 字段序，再收其余图链字段；按 URL 去重。"""
    fields = sorted((k for k, v in (record or {}).items()
                     if isinstance(v, str) and v.startswith("http")
                     and Path(v.split("?")[0]).suffix.lower() in IMAGE_EXTS))
    if prefer:
        fields = [f for f in prefer if f in fields] + [f for f in fields if f not in prefer]
    seen, out = set(), {}
    for f in fields:
        url = record[f]
        if url in seen:
            continue
        seen.add(url)
        out[f] = url
        if cap and len(out) >= cap:
            break
    return out


def skin_images(skin: dict) -> dict:
    return image_assets(skin, prefer=SKIN_FIELDS)


class Index:
    """全部可检索条目的内存索引，懒加载各接口资源。"""

    def __init__(self, refresh=False, offline=False):
        self.refresh = refresh
        self.offline = offline
        self._themes = None

    def _load(self, name):
        return load_resource(name, refresh=self.refresh, offline=self.offline)

    @property
    def themes(self):
        if self._themes is None:
            self._themes = self._load("themes")
        return self._themes

    def _agent_records(self) -> list:
        root = Path(__file__).resolve().parents[3]
        files = [root / "skills/valorant-perler/scripts/val_perler/aliases.json",
                 Path.home() / ".cache/valorant_assets/merged_agents.json"]
        records = self._load("agents")
        snapshot = {}
        for path in files:
            try:
                raw = json.loads(path.read_text(encoding="utf-8"))
            except (OSError, ValueError):
                continue
            raw = raw.get("agent_names", raw) if isinstance(raw, dict) else raw
            for name, values in raw.items() if isinstance(raw, dict) else []:
                for value in values if isinstance(values, list) else []:
                    if isinstance(value, str) and value.strip():
                        snapshot.setdefault(value.strip(), name)
        for a in records:
            a = dict(a)
            name = a.get("displayName") or ""
            a["agent_known_names"] = [n for n, formal in snapshot.items() if formal == name and n != name]
            yield a

    def all_entries(self) -> list:
        tier_names = {t["uuid"]: (t.get("displayName") or "") for t in self._load("contenttiers")}
        entries = []
        for a in self._agent_records():
            entries.append({
                "kind": "英雄", "uuid": a["uuid"], "name": a.get("displayName") or "",
                "search": " ".join(filter(None, [
                    a.get("displayName"), a.get("developerName")])),
                "agent_known_names": a.get("agent_known_names") or [],
                "role": (a.get("role") or {}).get("displayName") or "",
                "images": image_assets(a, prefer=AGENT_FIELDS, cap=6),
            })
        theme_names = {t["uuid"]: (t.get("displayName") or t.get("developerName") or "") for t in self.themes}
        for w in self._load("weapons"):
            wname = w.get("displayName") or ""
            wdev = w.get("developerName") or ""
            for sk in w.get("skins") or []:
                theme = theme_names.get(sk.get("themeUuid") or "", "")
                entries.append({
                    "kind": "皮肤", "uuid": sk["uuid"], "name": sk.get("displayName") or "",
                    "search": " ".join(filter(None, [
                        sk.get("displayName"), wname, wdev, theme,
                        tier_names.get(sk.get("contentTierUuid") or "")])),
                    "theme_uuid": sk.get("themeUuid") or "",
                    "weapon": wname, "tier": tier_names.get(sk.get("contentTierUuid") or "", ""),
                    "theme": theme,
                    "images": skin_images(sk),
                })
        generic = [
            ("地图", "maps", lambda m: m.get("displayName")),
            ("喷漆", "sprays", lambda s: s.get("displayName")),
            ("卡面", "playercards", lambda c: c.get("displayName")),
            ("挂饰", "buddies", lambda b: b.get("displayName")),
        ]
        for kind, resource, name_of in generic:
            for record in self._load(resource):
                entries.append({
                    "kind": kind, "uuid": record["uuid"], "name": name_of(record) or "",
                    "search": name_of(record) or "",
                    "images": image_assets(record, cap=6),
                })
        for t in self.themes:
            entries.append({
                "kind": "主题", "uuid": t["uuid"],
                "name": t.get("displayName") or t.get("developerName") or "",
                "search": " ".join(filter(None, [t.get("displayName"), t.get("developerName")])),
                "images": image_assets(t, cap=4),
            })
        return entries


LIST_ITEMS = {"英雄": "agents", "皮肤": "skins", "主题": "themes", "地图": "maps",
              "喷漆": "sprays", "卡面": "playercards", "挂饰": "buddies"}


def no_hit_hint(query: str, type_name: str) -> str:
    scope = f" {type_name}" if type_name else ""
    return (f"没有匹配「{query}」的{scope or '资产'}。拆分对象、年份、战队、武器和系列关键词，"
            f"用 list --type {type_name or '<相关类型>'} --limit 0 核对该类完整清单（可选 {'、'.join(LIST_ITEMS)}）；"
            "当前来源没有所需素材时，按取图策略转官网，再转通用联网搜索。")


def do_list(args) -> int:
    idx = Index(refresh=args.refresh, offline=args.offline)
    wanted = [LI for LI, resource in LIST_ITEMS.items()
              if not args.type or resource == TYPE_ALIASES.get(args.type.strip().lower(),
                                                              TYPE_ALIASES.get(args.type.strip()))]
    if not wanted:
        fail(f"未知的 --type {args.type}，可选：{'、'.join(LIST_ITEMS)}")
    items = []
    for e in idx.all_entries():
        if e["kind"] not in wanted:
            continue
        item = {"kind": e["kind"], "uuid": e["uuid"], "name": e["name"]}
        if e["kind"] == "皮肤":
            item.update({k: e[k] for k in ("weapon", "tier", "theme") if e.get(k)})
        items.append(item)
    if args.filter:
        needle = norm(args.filter)
        items = [i for i in items if needle in norm(" ".join(str(v) for v in i.values()))]
    total = len(items)
    if args.limit:
        items = items[: args.limit]
    print(json.dumps({"type": "、".join(wanted), "total": total, "count": len(items),
                      "items": items, "truncated": len(items) < total},
                     ensure_ascii=False, indent=2))
    return 0


def do_search(args) -> int:
    if not args.query.strip():
        fail("search 需要关键词，例如：search 2024全球冠军赛")
    idx = Index(refresh=args.refresh, offline=args.offline)
    entries = idx.all_entries()
    if args.type:
        want = TYPE_ALIASES.get(args.type.strip().lower()) or TYPE_ALIASES.get(args.type.strip())
        if not want:
            fail(f"未知的 --type {args.type}，可选：{'、'.join(TYPE_ALIASES)}")
        kind_map = {"agents": "英雄", "skins": "皮肤", "maps": "地图", "sprays": "喷漆",
                    "playercards": "卡面", "buddies": "挂饰", "themes": "主题"}
        entries = [e for e in entries if e["kind"] == kind_map[want]]

    tokens = [norm(t) for t in args.query.split() if norm(t)]
    if not tokens:
        tokens = [norm(args.query)]
    hits = []
    for e in entries:
        text = norm(e.get("search") or e["name"])
        if all(t in text for t in tokens):
            hits.append(e)

    def rank(e):
        name = norm(e["name"])
        exact = 0 if name == norm(args.query) else 1
        prefix = 0 if any(name.startswith(t) for t in tokens) else 1
        kind_order = {"英雄": 0, "皮肤": 1, "主题": 2, "地图": 3, "卡面": 4, "挂饰": 5, "喷漆": 6}
        return (exact, prefix, kind_order.get(e["kind"], 9), len(name))

    hits.sort(key=rank)
    hits = hits[: args.limit]
    out = {
        "query": args.query,
        "platform": args.platform,
        "knowledge_id": args.knowledge_id,
        "found": len(hits),
        "results": [{
            "kind": e["kind"], "uuid": e["uuid"], "name": e["name"],
            **({k: e[k] for k in ("weapon", "tier", "theme", "role") if e.get(k)}),
            "images": e["images"],
            **({"known_names": e["agent_known_names"]} if e.get("agent_known_names") else {}),
        } for e in hits],
    }
    if not hits:
        out["next"] = no_hit_hint(args.query, args.type)
    print(json.dumps(out, ensure_ascii=False, indent=2))
    return 0


def find_record(uuid: str, refresh=False, offline=False):
    """按 uuid 在各资源里找记录，返回 (说明, 图链 dict)。找不到返回 None。"""
    def scan(resource, name_of, images_of):
        for record in load_resource(resource, refresh=refresh, offline=offline):
            if record.get("uuid") == uuid:
                return name_of(record), images_of(record)
        return None

    hit = scan("agents", lambda a: f"英雄 {a.get('displayName')}",
               lambda a: image_assets(a, prefer=AGENT_FIELDS))
    if hit:
        return hit
    weapons = load_resource("weapons", refresh=refresh, offline=offline)

    def skin_hit(w):
        for sk in w.get("skins") or []:
            if sk["uuid"] == uuid:
                return f"皮肤 {sk.get('displayName')}（{w.get('displayName')}）", skin_images(sk)
            for c in sk.get("chromas") or []:
                if c["uuid"] == uuid:
                    return (f"炫彩 {c.get('displayName')}（{sk.get('displayName')}）",
                            image_assets(c, prefer=["fullRender", "displayIcon"]))
            for lv in sk.get("levels") or []:
                if lv["uuid"] == uuid:
                    return (f"等级{lv.get('levelNumber')} {lv.get('displayName')}",
                            image_assets(lv, prefer=["fullRender", "displayIcon"]))
        return None

    for w in weapons:
        hit = skin_hit(w)
        if hit:
            return hit
    for resource, label in (("maps", "地图"), ("sprays", "喷漆"), ("playercards", "卡面"),
                            ("buddies", "挂饰"), ("themes", "主题")):
        hit = scan(resource, lambda r, lb=label: f"{lb} {r.get('displayName')}",
                   lambda r: image_assets(r, cap=8))
        if hit:
            return hit
    return None


MAGIC = {b"\x89PNG": "png", b"GIF8": "gif", b"RIFF": "webp", b"\xff\xd8\xff": "jpg"}


def ext_matches(url_ext: str, head: bytes) -> bool:
    want = {"png": ".png", "gif": ".gif", "webp": ".webp", "jpg": ".jpg"}.get(
        MAGIC.get(head[:4]) or MAGIC.get(head[:3]) or "", "")
    if not want:
        return False
    if url_ext in (".jpeg",):
        url_ext = ".jpg"
    return url_ext == want


def do_get(args) -> int:
    hit = find_record(args.uuid.strip().lower(), refresh=args.refresh, offline=args.offline)
    if not hit:
        fail(f"没有找到 uuid 为 {args.uuid} 的资产。先用 search 确认条目与 uuid。")
    label, images = hit
    if not images:
        fail(f"{label} 在接口里没有可用图片。")
    outdir = Path(args.out)
    outdir.mkdir(parents=True, exist_ok=True)
    files, errors, skipped = [], [], []
    saved_urls = set()
    for field, url in list(images.items())[: args.max]:
        ext = Path(url.split("?")[0]).suffix.lower() or ".png"
        dest = outdir / f"{safe_name(label)}__{safe_name(field)}{ext}"
        try:
            with urlopen(Request(url, headers=HEADERS), timeout=120) as resp:
                body = resp.read()
        except Exception as exc:  # noqa: BLE001
            errors.append({"field": field, "url": url, "error": str(exc)})
            continue
        head = body[:8]
        if len(body) < 16 or not ext_matches(ext, head):
            errors.append({"field": field, "url": url, "error": "返回内容不是图片"})
            continue
        if url in saved_urls:
            skipped.append(field)
            continue
        saved_urls.add(url)
        dest.write_bytes(body)
        files.append({"file": str(dest.resolve()), "bytes": len(body), "field": field})
    if not files:
        fail(f"{label} 的图片全部下载失败：" + "；".join(e["error"] for e in errors))
    print(json.dumps({
        "asset": label, "uuid": args.uuid,
        "platform": args.platform, "knowledge_id": args.knowledge_id,
        "saved": files,
        **({"failed": errors} if errors else {}),
        **({"skipped_duplicates": skipped} if skipped else {}),
    }, ensure_ascii=False, indent=2))
    return 0


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description="无畏契约官方资产取数（搜索与下载）")
    sub = parser.add_subparsers(dest="command", required=True)

    p_search = sub.add_parser("search", help="按资产名称与字段检索候选")
    p_search.add_argument("query", help="关键词，如：捷风、2024全球冠军赛、狂徒")
    p_search.add_argument("--type", default="", help="限定类型：英雄/皮肤/地图/喷漆/卡面/挂饰/主题；礼包不进拼豆图纸，不收")
    p_search.add_argument("--limit", type=int, default=12, help="最多返回条数（默认 12）")
    p_search.add_argument("--refresh", action="store_true", help="忽略缓存，重新拉取接口")
    p_search.add_argument("--offline", action="store_true", help="只用本地缓存，不联网")
    p_search.set_defaults(func=do_search)

    p_list = sub.add_parser("list", help="列出某类资产全部条目，用于确认名称后仍查不到时逐项核对")
    p_list.add_argument("--type", default="", help="资产类型：英雄/皮肤/主题/地图/喷漆/卡面/挂饰，不给则列全部；礼包不收")
    p_list.add_argument("--filter", default="", help="在清单里按关键词过滤")
    p_list.add_argument("--limit", type=int, default=200, help="最多返回条数（默认 200，0 不限）")
    p_list.add_argument("--refresh", action="store_true", help="忽略缓存，重新拉取接口")
    p_list.add_argument("--offline", action="store_true", help="只用本地缓存，不联网")
    p_list.set_defaults(func=do_list)

    p_get = sub.add_parser("get", help="按 uuid 下载官方图")
    p_get.add_argument("uuid", help="条目 uuid（来自 search 结果）")
    p_get.add_argument("--out", default=".", help="保存目录（默认当前目录）")
    p_get.add_argument("--max", type=int, default=4, help="最多下载几张（默认 4）")
    p_get.add_argument("--refresh", action="store_true", help="忽略缓存，重新拉取接口")
    p_get.add_argument("--offline", action="store_true", help="只用本地缓存定位条目")
    p_get.set_defaults(func=do_get)

    for subparser in (p_search, p_list, p_get):
        subparser.add_argument("--platform", choices=["pc", "mb"], default="pc",
                               help="素材平台；当前接口仅提供端游素材")
        subparser.add_argument("--knowledge-id", default="", help="可选的已知知识条目路径，随结果返回")
    args = parser.parse_args(argv)
    if args.platform != "pc":
        fail("当前素材接口仅提供端游图片。手游请进入官网取图，再按需联网搜索。")
    return args.func(args)


if __name__ == "__main__":
    raise SystemExit(main())
