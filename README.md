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
/skill:ui-design 仅做布局预览，需求见 需求/活动主界面功能整理与归纳.md
/skill:ui-design 新建活动任务界面，先根据需求制作布局预览，等我确认
/skill:ui-design 修改指定 Figma 文件中的奖励列表，保留其他布局和原型连接
/skill:ui-design 只读检查指定 Frame 的布局、自适应、组件复用和原型连接
```

示例中的目标名称和需求路径按实际情况替换。技能支持自然语言，不要求固定参数；同一任务反馈时直接继续对话即可。

### 技能没有出现？

本项目将技能放在 Pi 支持发现的 `.agents/skills/ui-design/` 中。确认从本仓库启动或已信任本项目，再执行 `/reload`，检查加载诊断及是否存在同名技能冲突。

`/skill:ui-design` 是 Pi 的显式调用命令；其他客户端使用各自的技能调用方式。不支持自动发现时，可直接要求 AI 阅读 [.agents/skills/ui-design/SKILL.md](.agents/skills/ui-design/SKILL.md) 并执行。

## 一次任务如何推进

1. 提供需求，AI 先生成单文件 HTML 灰阶块面布局预览；这个阶段不需要连接 Figwright。
2. 你与 AI 讨论布局并明确确认当前版本，之后才开始 Figma 搭建。仅预览任务在此等待反馈。
3. AI 通过 Figwright 搭建，将换皮维护源集中组织在“待替换”区，演示场景使用这些源头的实例。
4. 交付时检查确认版布局、自适应、换皮同步和原型运行，提供维护入口及未验证项。

主要布局改变时重新确认；不改变主要布局的局部修改和只读检查不必重走预览流程。详细标准见技能参考文件。

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
| [SKILL.md](.agents/skills/ui-design/SKILL.md) | 调用后的启动行为、执行顺序和阶段完成标准 |
| [figma-ui.md](.agents/skills/ui-design/references/figma-ui.md) | 默认值、修改边界、工具、布局、组件、维护源、原型与验收 |
| [layout-preview.md](.agents/skills/ui-design/references/layout-preview.md) | 灰阶预览与用户确认关卡 |
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
   ├─ layout-preview.md
   └─ GLOSSARY.md
```

## 换皮与原型

换皮从 Figma 的“待替换”区开始，修改共享主组件、必要变体、代表性布局及资源；区外演示场景不应要求逐张重新换皮，例外需明确列出。

HTML 是布局讨论稿，Figma Prototype 是操作和反馈的模拟，均不实现真实扣费、发奖、存档或后端逻辑。“连接配置正确”不等于“实际演示可用”，无法运行时提供人工走查清单并标为未验证。

## 在其他项目使用

将完整 `ui-design` 技能目录放入目标客户端支持的技能位置，保留 `SKILL.md` 与 `references/` 的相对结构。Pi 项目级位置为 `.agents/skills/ui-design/`，用户级也可使用 `~/.agents/skills/ui-design/`；避免同名重复安装。通用协作规则仍遵循目标项目的 `AGENTS.md`。

移动或修改技能后需重载客户端资源。文档与路径检查不代表技能已成功加载，也不代表 Figma 桥接和原型已经实测。
