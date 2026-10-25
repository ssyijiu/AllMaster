#!/usr/bin/env python3
"""拼豆专家 CLI：查知识、生图出图纸、掌瓦登录都走这一个入口。

  python3 scripts/val_perler.py search assets <search|list|get> ...   搜索与下载端游参考图
  python3 scripts/val_perler.py search <query|list|get|alias|guard> ...   查知识（参数见 valorant-knowledge）
  python3 scripts/val_perler.py generate <参考图> --work-dir ... --prompt ... --task-name ...   生图并出 HTML 图纸
  python3 scripts/val_perler.py render --health | --check-id | --set-id <UUID>   生图服务连通性、WorkBuddy ID
  python3 scripts/val_perler.py login [--force]            掌瓦扫码登录（已登录直接返回；--force 换号）
  python3 scripts/val_perler.py login --set-auth-key <值>  扫码失败时手动写入登录凭据
  python3 scripts/val_perler.py logout                      清除本机掌瓦登录

generate / render / login 的参数与同目录 gen_and_recover.py、image_render.py、login.py 相同。
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
        _forward("image_render", cmd, rest)
    elif cmd == "login":
        _forward("login", cmd, rest if "--set-auth-key" in rest else ["--login", *rest])
    elif cmd == "logout":
        _forward("login", cmd, ["--logout", *rest])
    else:
        print(f"val-perler: 未知命令 {cmd}\n\n{__doc__.strip()}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
