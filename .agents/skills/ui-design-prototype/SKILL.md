---
name: ui-design-prototype
description: 按确认方案制作或修改游戏 UI 的可交互灰阶 HTML，并检查渲染、尺寸和实际操作；不自动写入 Figma。
---

# 制作游戏 UI 交互原型

1. 读[共同约定](../ui-design/references/common.md)，核对需求、现有 HTML、具体方案及确认依据。方案未确认或关键路径有分歧时，先用 `ui-design-align` 补齐受影响部分；明确局部修改直接处理。
2. 制作前读[HTML 制作规范](../ui-design/references/layout-preview.md)和[原型工艺](../ui-design/references/prototype-craft.md)。交付自包含 HTML，覆盖确认范围内的操作和状态；规则落成交互，不照抄为界面旁注。
3. 按[设计台能力适配](../ui-design/references/studio-tools.md)选择实际可用工具，先展示，再看渲染、按确认尺寸测量并修复；按 HTML 规范实际走核心操作。制作自查是本任务的完成条件，无需另加载检查技能。
4. 用户要求组件拆分或拆分验收时，再按[组件拆分与验收](../ui-design/references/component-decomposition.md)由 AI 先准备、人检查和纠偏；工具接入缺口如实说明，不把人工逐个圈选当默认步骤，也不为纯预览强制适配工作台。

**交付与停止**：给出当前 HTML 路径／版本、已完成检查与必要缺口，等待用户体验。渲染、测量、实际操作分别记状态；工具缺失不冒充通过，也不阻止交付已实现 HTML。仅用户明确请求转入 Figma 时，由 `ui-design-figma` 核对版本认可及范围，本任务不主动搭建。
