# Game UI Design

通过 **Figwright 桥接 Figma**，让 AI 构建可编辑、可复用、可适配的游戏 UI，并用基础交互原型辅助功能讨论。

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
/skill:ui-design 只读检查指定 Frame 的布局、自适应、组件复用和原型连接
```

示例中的目标名称和需求路径按实际情况替换。技能支持自然语言，不要求固定参数；同一任务反馈时直接继续对话即可。

### 技能没有出现？

本项目将技能放在 Pi 支持发现的 `.agents/skills/ui-design/` 中。确认从本仓库启动或已信任本项目，再执行 `/reload`，检查加载诊断及是否存在同名技能冲突。

`/skill:ui-design` 是 Pi 的显式调用命令；其他客户端使用各自的技能调用方式。不支持自动发现时，可直接要求 AI 阅读 [.agents/skills/ui-design/SKILL.md](.agents/skills/ui-design/SKILL.md) 并执行。

## 一次任务如何推进

1. 提供需求，AI 先围绕界面歧义和设计风险分轮追问，给出建议和取舍；功能基本明确时不重新审问业务规则。
2. 你确认界面方案摘要，AI 才生成可交互的单文件灰阶 HTML；这两个阶段都不需要连接 Figwright。
3. HTML 默认只显示产品界面，通过真实控件体验需求交互；没有附加的评审栏、场景菜单或说明区，必要假设和未验证项仅在对话中简短提示。
4. 当你表达想转入 Figma 制作阶段时，AI 根据上下文理解意图，无需固定口令，并先询问当前 HTML 版本是否满足需求；你明确肯定后才搭建，不把切换阶段的指令直接当作满意确认。仅 HTML 任务停留在反馈阶段，Figma 维护源集中在“待替换”区，演示场景通过实例复用。
5. 交付时检查确认版界面、自适应、换皮同步及原型运行，提供维护入口、能力差异和未验证项。

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
| [figma-ui.md](.agents/skills/ui-design/references/figma-ui.md) | Figma 视觉默认值、修改边界、工具、布局、组件、维护源、原型与验收 |
| [ui-alignment.md](.agents/skills/ui-design/references/ui-alignment.md) | 界面追问、图标文字决策、方案确认与精简交付 |
| [layout-preview.md](.agents/skills/ui-design/references/layout-preview.md) | 可交互 HTML 制作、检查及 Figma 确认关卡 |
| [GLOSSARY.md](.agents/skills/ui-design/references/GLOSSARY.md) | 设计术语 |
| README.md | 面向使用者的操作说明与文档导航 |

规则在对应文件单独维护；策划需求放在具体功能文档中，不混入技能规范。

```text
AGENTS.md
README.md
.agents/skills/ui-design/
├─ SKILL.md
└─ references/
   ├─ figma-ui.md
   ├─ ui-alignment.md
   ├─ layout-preview.md
   └─ GLOSSARY.md
```

## 换皮与原型

换皮从 Figma 的“待替换”区开始，修改共享主组件、必要变体、代表性布局及资源；区外演示场景不应要求逐张重新换皮，例外需明确列出。

HTML 与 Figma Prototype 都用于模拟操作和反馈，均不实现真实扣费、发奖、存档或后端逻辑。HTML 默认补齐需求交互，编辑保存等结果在当前会话中可见；Figma 按原生能力表达，并明确无法等价实现的差异。“代码或连接已配置”不等于“实际演示可用”；HTML 无法运行时简短提示“运行未验证”，Figma 验收按对应规范执行。

## 在其他项目使用

将完整 `ui-design` 技能目录放入目标客户端支持的技能位置，保留 `SKILL.md` 与 `references/` 的相对结构。Pi 项目级位置为 `.agents/skills/ui-design/`，用户级也可使用 `~/.agents/skills/ui-design/`；避免同名重复安装。通用协作规则仍遵循目标项目的 `AGENTS.md`。

移动或修改技能后需重载客户端资源。文档与路径检查不代表技能已成功加载，也不代表 Figma 桥接和原型已经实测。
