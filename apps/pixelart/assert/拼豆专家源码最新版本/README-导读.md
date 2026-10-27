# 拼豆专家源码导读

这是专家包的**完整副本**，在 `完整专家包/` 下（复制自插件缓存 1.2.6，含全部四个技能与专家配置）。改这份不会影响插件本体；想让自己的改动生效，需要改回插件缓存目录，或用改后的包重新走专家包转换/安装。

## 目录结构（完整专家包/）

- `README.md`、`agents/valorant-perler-expert.md` — 专家定义：人设、工作流、说话方式与边界规则。
- `avatars/expert.png` — 专家头像。
- `skills/valorant-perler/` — 图纸生成主技能：
  - `SKILL.md` — 技能总说明：工作目录约定、输入契约、四阶段流程、修改模式、生图服务的调用与失败处理。
  - `scripts/` — Python 图纸生成链路：
    - `val_perler.py` — 命令行总入口，转发到各子命令。
    - `gen_and_recover.py` — `generate` 主流程：拼提示词 → 生图 → 切格 → 建 HTML；`--target-size` 的 15–156 校验在这里。
    - `image_render.py` — 调团队渲染服务生成像素底稿。
    - `alignment_search.py` — 切格对齐搜索，`BOARD_MAX = 156` 在第 31 行附近。
    - `build_html_blueprint.py` — 把多规格矩阵与底稿打包成单文件图纸页。
    - `make_overview.py` — 生成尺寸对比评审图。
    - `palette_mard221.csv` / `palettes/` — 色板数据。
  - `image_prompts/` — 生图提示词的各段文本（基础规格、画风库、主体描述、构图、原图取舍）。
  - `templates/perler_blueprint/` — 图纸页外壳：`index.html`、`css/`、`js/`。自定义尺寸在 `js/custom-size.js`，输入框上限在 `index.html`（`min="15" max="156"`）；构建时按 `/* @include … */` 顺序内联成单文件。
  - `assets/` — 静态资源；`showcase/` — 预制样例图纸（遐思）。
- `skills/perler-repair/` — 图纸局部修复技能（交错色检查与修图流程）。
- `skills/valorant-knowledge/` — 知识检索技能（查询 CLI 的用法说明）。
- `skills/valorant-assets/` — 素材取图技能（官方图与联网参考图的获取流程）。

## 想改尺寸上限（156）需要注意

1. `skills/valorant-perler/scripts/alignment_search.py` 的 `BOARD_MAX` 和 `gen_and_recover.py` 的参数校验。
2. 图纸页 `skills/valorant-perler/templates/perler_blueprint/index.html` 的输入框 `max` 属性和 `custom-size.js` 里的区间检查。
3. 页面现场算自定义尺寸是在浏览器里复刻对齐搜索（见 `custom-size.js` 头部注释），边长越大计算量越大；`build_html_blueprint.py` 打包进页面的搜索场 `D.field` 是按构建时的底稿生成的，超上限只是计算变慢变重，不是数据缺失，但仍需自己在手机上验证流畅度。
4. 改完图纸页模板后要重新构建单文件 HTML（`build_html_blueprint.py` 里的内联逻辑），直接改它产出的 HTML 会在下次构建时被覆盖。

## 运行依赖

Python：requests、Pillow、NumPy、opencv-python、scikit-image、scikit-learn。生图走团队渲染服务（`https://val-perler.qq.com`），需要 WorkBuddy ID。
