# Game UI Design

通过 **Figwright 桥接 Figma**，让 AI 构建可编辑、可复用、可适配的游戏 UI，并制作基础交互原型，辅助与策划、程序讨论功能流程。

## 文档以哪个为准？

按职责划分，不是多套并行规范：

| 文件 | 读者与用途 | 修改什么时维护 |
| --- | --- | --- |
| [AGENTS.md](AGENTS.md) | AI 的项目通用规则与 UI 任务入口 | 沟通、命名、授权边界等项目约定 |
| [ui-design/SKILL.md](ui-design/SKILL.md) | AI 的 UI 执行流程 | 操作顺序、阶段完成标准 |
| [ui-design/references/figma-ui.md](ui-design/references/figma-ui.md) | AI 的详细设计规范 | 默认值、设计稿保护、工具用法、布局、组件、原型、验收 |
| README.md | 人的使用与维护说明 | 环境准备、使用示例、文档导航 |

同一条规则只在对应文件维护；本 README 不另行定义设计标准。具体功能需求放在对应功能目录，设计规范不代替策划需求。

## 目录结构

```text
AGENTS.md
README.md
ui-design/
├─ SKILL.md
└─ references/
   └─ figma-ui.md
```

原 `docs/figma-ui.md` 跳转文件和 `ui-design/references/AGENTS.md` 已移除，内容已归入上表对应位置。

## 使用前准备

实际操作链路：

```text
AI / MCP 客户端
  → Figwright MCP
  → 本地 WebSocket 桥接
  → Figma 中运行的 Figwright 插件
  → Figma 设计稿
```

1. 按 [Figwright 官方说明](https://github.com/awdr74100/figwright#setup) 为 MCP 客户端配置服务，并在 Figma 桌面端导入插件。
2. 保持服务与插件版本兼容，在目标文件中运行插件，确认显示 Connected。
3. 在可写的 Figma Design 中打开目标页面，告知 AI 目标文件、修改范围和需求；多文件连接时需确认绑定正确文件。

本技能提供工作流程，不自带桥接工具。仅有技能文件或插件压缩包，并不代表服务已连接。默认不使用官方 Figma MCP 或其他编辑器替代 Figwright。

### 技能如何使用

- **在本项目中**：AI 从根 `AGENTS.md` 进入 `ui-design/SKILL.md`，再读取 reference，无需重复提供三份文档。
- **在其他项目中**：将整个 `ui-design/` 目录作为技能包，按目标客户端支持的方式安装或加载；通用协作规则仍遵循目标项目的 `AGENTS.md`。
- **显式调用**：客户端支持技能调用时选择 `ui-design`；也可以直接要求 AI 读取 `ui-design/SKILL.md` 并执行。

## 使用示例

**新建界面**

> 按 ui-design 技能，在指定 Figma 文件中新建活动任务界面。需求见功能目录中的策划文档，先完成布局和核心交互，再完善视觉。

**修改界面**

> 按 ui-design 技能，修改指定 Frame 的奖励列表，保留现有组件与原型连接，仅调整任务范围内内容。

**检查与验收**

> 按 ui-design 技能，只读检查指定界面的自适应布局、组件复用和原型连接；未实际运行的测试请标为未验证。

## 原型的定位

这里的原型是 **Figma 原生交互模拟**，用于讨论入口、操作顺序、反馈和返回路径，不是真实业务实现。预设的成功、失败或已领取场景即可用于讨论，不需要真实扣费、发奖、存档或连接后端。

“连接配置正确”和“实际演示可用”是两项检查；桥接或操作工具无法运行演示时，应保留运行未验证项，并提供人工走查步骤。详细要求统一见设计规范。

## 维护与验证

- 改通用规则到 `AGENTS.md`，改执行顺序到 `SKILL.md`，改设计细则到 reference；不要复制成第二套规范。
- 调整文件位置后同步更新 Markdown 引用，保持入口到详细规则的路径可达。
- Figwright 升级后，按实际工具 schema 和插件行为确认兼容性；本地插件目录名称不代表运行中版本。
- 文档检查不代表桥接、设计稿或原型已实测；交付时分别说明。
