# Project Agent Guide

## 协作规则

- 默认使用中文沟通，回答简洁，优先执行当前任务。
- 需求不明确且影响结构或修改范围时先确认；其余必要假设在交付时说明。
- 代码标识符使用清晰的英文命名；Figma 设计稿名称使用便于设计者阅读的中文，具体规则见设计规范。界面文案遵循用户要求。
- 修改限于任务范围；回退限于本次自动化修改，避免撤销用户同期操作。
- 安装或更新依赖、插件，变更 MCP 配置前先征得用户同意。

## 规范维护

维护本仓库的技能与规范时，优先修订现有条款、删除重复或失效内容；仅当独立分支确需按需加载时新增参考文件，不为补充规则机械拆文件或扩增问卷。

## UI 任务入口

游戏 UI 方案讨论用 `ui-design-align`，HTML 制作／修改用 `ui-design-prototype`，只读检查界面或组件拆分结果用 `ui-design-review`，Figma 搭建／修改用 `ui-design-figma`。用户主动选择 `ui-design` 时串联全流程；技能与工具导航见 [README](README.md)。

## 工程任务入口

创建或更新 Issue、发布规格、分流任务时，阅读 [Issue 跟踪约定](docs/agents/issue-tracker.md) 和 [分流标签](docs/agents/triage-labels.md)。

开发图集导入工具时，遵循 [工具开发约定](tools/figma-project-assets/AGENTS.md)。
