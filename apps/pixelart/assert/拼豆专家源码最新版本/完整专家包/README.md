# 无畏契约拼豆专家

将一张无畏契约参考图转成 36/52/78/104/156 多规格拼豆色号矩阵、总览图与交互 HTML 图纸。

这是外网版专家包。底稿由团队渲染服务（`https://val-perler.qq.com`）生成透明平面像素图，再由本地确定性脚本生成豆位矩阵和 HTML。主交付物为 `output/` 下带时间戳的图纸页（`【拼豆专家】{任务名}-{M月D日}_{H点M分S秒}.html`）。

## 生图服务

默认流程不需要任何凭据，只要能访问 `https://val-perler.qq.com`。

服务支持图生图和文生图：传参考图走图生图，不传走文生图（文生图须玩家同意）。任务在服务端保留 2 小时，脚本拿到结果会立即落盘。

生图失败时，脚本以非零状态退出，并写明失败步骤（提交、轮询、取图）和服务返回的原文，例如 `提交：HTTP 400，参数不合法: size 999x999 宽高必须是 16 的倍数`。连不上服务时报 `连不上渲染服务`，先检查网络连接。

## 默认流程

```bash
python3 skills/valorant-perler/scripts/val_perler.py generate <用户原图> \
  --work-dir <独立工作目录> \
  --prompt <提示词配置.json> \
  --task-name "<WorkBuddy 拟定的本次任务名>"
```

过程文件统一保存在工作目录的 `.wip/`，最终交付文件保存在 `output/`。脚本默认清理 `.wip/过程文件/` 过程文件；需保留时加 `--keep-process`。原图、底稿与色号数据内联在 HTML 中，表格可在页面内导出。

WorkBuddy 在 HTML 渲染前根据玩家目标与画面主体拟定任务名。页面副标题自动记录实际 HTML 渲染时间。

一条命令依次生成：

- `.wip/提示词/提示词.md`：slot 组装提示词。
- `.wip/评审/尺寸对比.png`：五档规格对比卡片，供 AI 核验默认尺寸。
- `.wip/转换图/转换图.png`：唯一平面像素底稿。
- `.wip/过程文件/`：36/52/78/104/156 色号矩阵（默认完成后清理）。
- `output/【拼豆专家】{任务名}-{M月D日}_{H点M分S秒}.html`：交互 HTML，`output/` 里唯一的文件。
- `.wip/运行记录.json`：输入、参数、状态和产物路径。

生图只使用用户原图作为视觉参考。默认参数为 `quality=low`、`background=transparent`、PNG、`1024x1024`。MARD 221 色通过文字约束与下游 CSV 映射完成。

## 目录

```text
valorant-perler-expert/
├── .codebuddy-plugin/plugin.json
├── agents/valorant-perler-expert.md
├── avatars/expert.png
└── skills/
    ├── valorant-perler/
    │   ├── SKILL.md
    │   ├── scripts/
    │   ├── templates/
    │   └── image_prompts/
    └── valorant-knowledge/
```

运行包只保留执行所需的脚本、模板、文本参考和头像。

## 安装

不需要申请 token 或配置任何凭据，也不需要额外网络环境。

把整个专家包放到 WorkBuddy 的专家目录并注册：

```bash
export WB="${WORKBUDDY_CONFIG_DIR:-$HOME/.workbuddy}"
export EXPERTS="$WB/plugins/marketplaces/my-experts/plugins"
mkdir -p "$EXPERTS"
cp -r <专家包目录> "$EXPERTS/valorant-perler-expert"

pip install Pillow numpy opencv-python scikit-image scikit-learn requests

SCRIPT=$(find "$WB/plugins/cache" -name register_expert.py -path "*expert-manager*" | head -1)
python3 "$SCRIPT" "$EXPERTS/valorant-perler-expert"
```

依赖要装进 WorkBuddy 执行专家脚本时用的 Python；装错环境会在出图时报 `No module named ...`。

注册成功后，刷新专家中心或重启 WorkBuddy，「我的专家」里才会出现「无畏契约拼豆专家」。

更新：把新版专家包整包覆盖到同一目录，再次执行注册脚本，然后刷新专家中心。

插件版本位于 `.codebuddy-plugin/plugin.json`。同一版本号下 WorkBuddy 会复用已生成的缓存目录；覆盖安装新版本后，确认缓存路径包含当前版本号，再开始测试。