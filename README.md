# Game UI Design

用可交互灰阶 HTML 与策划、程序沟通；确认后通过 **Figwright 桥接 Figma**，先搭一个代表性主界面和够用的可复用组件。设计者完成本批换皮后，AI 再复用成果扩展指定界面与状态。

## 从这里开始

在本项目目录启动 Pi。已有会话在更新技能后先输入：

```text
/reload
```

然后直接调用：

```text
/skill:ui-design
```

AI 会询问你要做什么，以及需求或目标位置；无需先读完所有规范。也可以把需求直接写在命令后面：

```text
/skill:ui-design 仅做 HTML 原型，需求见 需求/活动主界面功能整理与归纳.md，先和我对齐界面方案
/skill:ui-design 新建活动任务界面，先追问界面设计，确认方案后做 HTML，等我确认再搭建 Figma
/skill:ui-design 修改指定 Figma 文件中的奖励列表，保留其他布局和原型连接
/skill:ui-design 只读检查指定 Frame 的布局、自适应、美术槽位和组件复用
```

示例中的目标名称和需求路径按实际情况替换。技能支持自然语言，不要求固定参数；同一任务反馈时直接继续对话即可。

### 技能没有出现？

本项目将技能放在 Pi 支持发现的 `.agents/skills/ui-design/` 中。确认从本仓库启动或已信任本项目，再执行 `/reload`，检查加载诊断及是否存在同名技能冲突。

`/skill:ui-design` 是 Pi 的显式调用命令；其他客户端使用各自的技能调用方式。不支持自动发现时，可直接要求 AI 阅读 [.agents/skills/ui-design/SKILL.md](.agents/skills/ui-design/SKILL.md) 并执行。

## 一次任务如何推进

1. 提供需求，AI 先围绕界面歧义和设计风险分轮追问，给出建议和取舍；功能基本明确时不重新审问业务规则。
2. 你确认界面方案摘要，AI 才生成可交互的单文件灰阶 HTML；这两个阶段都不需要连接 Figwright。
3. HTML 默认只显示产品界面，通过真实控件体验需求交互；没有附加的评审栏、场景菜单或说明区，必要假设和未验证项仅在对话中简短提示。
4. 当你表达想转入 Figma 制作阶段时，AI 根据上下文理解意图，无需固定口令，并先询问当前 HTML 版本是否满足需求；你明确肯定后才搭建，不把切换阶段的指令直接当作满意确认。仅 HTML 任务停留在反馈阶段。Figma 只搭界面与必要视觉状态，不制作点击连接或 Flow。
5. 首批保留主界面的主要布局与控件搭配，复用 `待替换` 区够用的组件，让你换皮后能直接看大体效果。同类面板先做一个代表，其他状态、TAB、次级界面和多比例预览暂缓；必要独立样式仍保留，不为了少而少。
6. AI 检查本批替换入口与同步、建立冻结参考后停下。你确认本批已换好并指定继续范围，AI 才读取实际组件、保留你的美术和关联继续搭建；需要新的独立美术时，先确认增量，再按新批次交给你换皮。

重要界面决策改变时重新确认受影响部分；明确的局部调整和只读检查不必重走无关关卡。HTML 阶段默认只交付原型文件，不自动补充说明文档、交互清单或验收报告；确认依据保留在对话中。详细标准见技能参考文件。

## Figma 搭建前的环境准备

```text
AI / MCP 客户端 → Figwright MCP → 本地桥接 → Figma 插件 → Figma 设计稿
```

1. 按 [Figwright 官方说明](https://github.com/awdr74100/figwright#setup) 配置 MCP 服务，并在 Figma 桌面端导入插件。
2. 保持服务与插件版本兼容，在目标文件运行插件，确认 Connected。
3. 在可写的 Figma Design 中打开目标文件，提供文件、页面和修改范围；多文件连接时确认绑定正确目标。

技能提供流程，不自带桥接工具。仅有技能或插件文件不代表服务已连接；默认不切换官方 Figma MCP 或其他编辑器。

## 文档以哪个为准？

| 文件 | 职责 |
| --- | --- |
| [AGENTS.md](AGENTS.md) | 项目通用协作规则及技能入口 |
| [SKILL.md](.agents/skills/ui-design/SKILL.md) | 启动行为、跨阶段默认尺寸、执行顺序和阶段完成标准 |
| [figma-ui.md](.agents/skills/ui-design/references/figma-ui.md) | Figma 修改边界、桥接、布局、状态展示、美术槽位、换皮、冻结参考与验收 |
| [ui-alignment.md](.agents/skills/ui-design/references/ui-alignment.md) | 界面追问、图标文字决策、方案确认与精简交付 |
| [layout-preview.md](.agents/skills/ui-design/references/layout-preview.md) | 可交互 HTML 制作、检查及 Figma 确认关卡 |
| [GLOSSARY.md](.agents/skills/ui-design/references/GLOSSARY.md) | 设计术语 |
| [html-component-workbench/README.md](tools/html-component-workbench/README.md) | HTML 原型组件拆分工作台：启动、接入契约、操作流程与单 HTML 项目文件语义 |
| README.md | 面向使用者的操作说明与文档导航 |

规则在对应文件单独维护；策划需求放在具体功能文档中，不混入技能规范。

```text
AGENTS.md
README.md
.agents/skills/ui-design/
├─ SKILL.md
├─ references/
│  ├─ figma-ui.md
│  ├─ ui-alignment.md
│  ├─ layout-preview.md
│  └─ GLOSSARY.md
└─ scripts/
   ├─ render_assets.py
   └─ test_render_assets.py
```

## 换皮与状态展示

- 换皮从 Figma 的 `待替换` 区开始；共享主组件和美术资源驱动区外状态展示稿，无需逐屏贴图。界面、图层、组件和属性默认中文命名。
- 背景、底板和图标独立于结构内容。背景／场景用固定脚本生成极简 PNG，HTML 与 Figma 共用，不逐层复刻临时场景；纯色背景直接填充。脚本也支持本地图片合成和 HTML 图片内联，只返回简短结果，使用方法见 [占位资源脚本](.agents/skills/ui-design/references/layout-preview.md#占位资源脚本)。
- Figma 占位图标使用透明 PNG，每处是一个无子层实例；共享图标主组件直接使用图片填充，保留同步与交换能力。其他美术可粘入对应主组件再移除占位层，九宫格效果按实际插件输出验证。
- 通常只换内部美术、保留文字和布局；也可以只选择部分按钮实例，交换成自己新建的整套组件。结构不同的组件交换后须检查文字、尺寸和覆盖值。
- 首批换皮前，将待替换区制作成图片快照，放进同尺寸并锁定的 `待替换_原始参考` Frame；后续只追加新增组件的原貌快照，集中放在该区。旧图不覆盖，不重拍已完成组件；修改维护源不会改变参考图。
- Figma 只按当前获准批次搭建，不一次铺满需求中的所有界面和状态；完整交互仍由 HTML 表达。已有任务范围外的内容和原型连接保留，阶段性交付不等于全功能完成。
- 默认只做基准尺寸；明确需要后再追加多比例预览，并检查主组件同步、各自尺寸保持与布局结果。不自动创建 21:9、4:3 版本，也不删除已有预览。

HTML 保留需求交互，编辑保存等结果在当前会话可见，仅用内存模拟，不接真实扣费、发奖、存档或后端。代码实现不等于运行验证，无法运行时简短提示“运行未验证”。

## 在其他项目使用

将完整 `ui-design` 技能目录放入目标客户端支持的技能位置，保留 `SKILL.md` 与 `references/` 的相对结构。Pi 项目级位置为 `.agents/skills/ui-design/`，用户级也可使用 `~/.agents/skills/ui-design/`；避免同名重复安装。通用协作规则仍遵循目标项目的 `AGENTS.md`。

移动或修改技能后需重载客户端资源。文档与路径检查不代表技能已成功加载，也不代表 Figma 桥接、换皮和实例交换已经实测。
