#!/usr/bin/env python3
"""拼豆专家 CLI：查知识、生图出图纸都走这一个入口。

  python3 scripts/val_perler.py search assets <search|list|get> ...   搜索与下载端游参考图
  python3 scripts/val_perler.py search <query|list|get|alias|guard> ...   查知识（参数见 valorant-knowledge）
  python3 scripts/val_perler.py generate <参考图> --work-dir ... --prompt ... --task-name ...   生图并出 HTML 图纸
  python3 scripts/val_perler.py render --health | --check-id   生图服务连通性、API Key 校验

generate / render 的参数与同目录 gen_and_recover.py、image_render.py 相同。
render 的客户端由 PERLER_IMAGE_SCRIPT 环境变量决定（默认 image_render.py）。

2026-10-28：生图后端由 val-perler.qq.com（活动服务）切换为 apinebula（OpenAI Images 兼容），
凭据走环境变量（generate.js 注入），原掌瓦扫码 login/logout 命令随旧服务一并移除。
"""
import pathlib
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))  # 同目录的脚本与 val_perler/ 包


def _forward(module: str, name: str, args: list[str]) -> None:
    sys.argv = [f"val_perler.py {name}", *args]
    __import__(module).main()


def main(argv: list[str]) -> int:
    if not argv or argv[0] in ("-h", "--help"):
        print(__doc__.strip())
        return 0 if argv else 1
    cmd, rest = argv[0], argv[1:]
    if cmd == "search" and rest and rest[0] == "assets":
        import importlib.util
        script = (pathlib.Path(__file__).resolve().parents[2] / "valorant-assets"
                  / "scripts" / "buguoguo_asset.py")
        if not script.exists():
            print(f"错误：未找到素材脚本 {script}", file=sys.stderr)
            return 1
        spec = importlib.util.spec_from_file_location("buguoguo_asset", script)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        return module.main(rest[1:])
    elif cmd == "search":
        from val_perler.cli import main as search_main
        search_main(argv)
    elif cmd == "generate":
        _forward("gen_and_recover", cmd, rest)
    elif cmd == "render":
        # 深检客户端跟随 PERLER_IMAGE_SCRIPT（与 gen_and_recover 同一来源），
        # 默认 image_render.py（apinebula）；经典版由 generate.js 注入 image_render_vp.py
        import os
        _forward(pathlib.Path(os.environ.get("PERLER_IMAGE_SCRIPT", "image_render.py")).stem, cmd, rest)
    elif cmd in ("login", "logout"):
        print("[ERROR] 掌瓦扫码登录已随 val-perler 后端一并下线（新后端用 API Key，无需登录）。", file=sys.stderr)
        return 1
    else:
        print(f"val-perler: 未知命令 {cmd}\n\n{__doc__.strip()}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
