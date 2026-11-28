# Game UI Design

用可交互灰阶 HTML 与策划、程序沟通；确认后通过 **Figwright 桥接 Figma**，先搭一个代表性主界面和够用的可复用组件。设计者完成本批换皮后，AI 再复用成果扩展指定界面与状态。

## 从这里开始

这是服务游戏 UI 的**技能包 + 工具包**。技能按任务决定产出和停止点，工具负责预览、测量或编辑；没有某个客户端的专用面板，也可以交付原型，并如实说明验证缺口。

### 五个统一前缀入口

| 技能 | 做什么 | 交付与停止点 |
| --- | --- | --- |
| [ui-design](.agents/skills/ui-design/SKILL.md) | 用户主动选择的全流程入口 | 串联任务，保留方案与设计版本两道确认 |
| [ui-design-align](.agents/skills/ui-design-align/SKILL.md) | 对齐需求、布局、控件与交互 | 方案摘要及确认状态，不制作界面 |
| [ui-design-prototype](.agents/skills/ui-design-prototype/SKILL.md) | 制作／修改可交互灰阶 HTML，并自查 | 当前原型与必要验证缺口，等待体验 |
| [ui-design-review](.agents/skills/ui-design-review/SKILL.md) | 只读检查 HTML、Figma 或组件拆分结果 | 按影响排序的问题、位置和证据，不修稿 |
| [ui-design-figma](.agents/skills/ui-design-figma/SKILL.md) | 首批搭建或基于换皮成果增量补齐 | 按本批交付；有换皮工作时暂停，不重建整套稿 |

单项任务可以直接接手已有成果。制作时自查不必再跑独立检查任务；明确局部修改归对应产物技能，只重新确认受影响的重要决策。

### DSH

在本项目工作区使用标准模式，从斜杠菜单选择技能，或在消息中输入 `/ui-design-align`、`/ui-design-prototype`、`/ui-design-review`、`/ui-design-figma`；`/ui-design` 为主动调用的总入口。可附 `@` 需求文件与辅助说明。单项技能也可按自然语言意图加载，加载不等于修改授权。

例：`/ui-design-review 只检查这份 HTML 的布局与交互，先别改`。具体菜单发现和工具可用性以当前会话为准；项目文档不保证本机 profile 状态，不自动安装插件或关闭同名入口。

### Pi 与其他客户端

Pi 使用 `/skill:ui-design` 等 `/skill:<技能名>`，已有会话更新技能后执行 `/reload`。其他客户端使用各自的技能调用方式；不支持发现时，明确要求 AI 阅读相应技能入口及其参考后执行。不要把 Pi 命令当作 DSH 语法。

技能未出现时先核对当前工作目录、客户端技能目录、信任设置和同名冲突，再按客户端机制重载。总入口仅供用户主动调用，不出现在模型自动发现列表中是预期行为。

## 工具包与任务链路

- **DSH 专用设计台**：使用宿主提供的预览、真实渲染和尺寸检查工具，明确传入设计尺寸。调用与能力缺口见[设计台能力适配](.agents/skills/ui-design/references/studio-tools.md)。
- **通用设计台**：已提供独立[浏览器预览与命令行工具](tools/design-studio/README.md)，无需安装 npm 包或修改普通自包含 HTML，即可预览、截图和按尺寸检查。需本机 Node 与 Chrome/Edge；外链／网络依赖和部分同源能力受限制，覆盖范围与未覆盖项随报告明确列出，不等同于 DSH 的完整体检。
- **组件工作台**：保留为[拆分检查、验收与纠偏工具](tools/html-component-workbench/README.md)。目标是 AI 按[拆分规范](.agents/skills/ui-design/references/component-decomposition.md)先准备，人检查、反馈重拆或手动纠偏；不是要求人从零逐个圈选。现有文件与操作能力仍可用，但 AI 批量预拆／反馈增量接入闭环尚待实现和验证，不把新定位写成已有自动功能。纯预览不强制适配其协议。
- **占位资源工具**：现有脚本生成、合成和内联 PNG；使用方法见[占位资源脚本](.agents/skills/ui-design/references/layout-preview.md#占位资源脚本)。

全流程是：对齐并确认方案 → 制作原型、自查并等待体验 → 用户请求进入 Figma，确认具体版本及本批范围 → 分批搭建、检查并暂停等换皮。独立任务不强制重跑之前阶段；已有认可的静态稿也能直接交给 Figma 技能。只读检查不写入任何产物。

渲染、尺寸测量、实际操作分别记验证状态。静态代码、截图或无报错不能证明点击路径通过；工具缺失时仍可交付 HTML，但不将未做的检查说成通过。

## Figma 搭建前的环境准备

```text
AI / MCP 客户端 → Figwright MCP → 本地桥接 → Figma 插件 → Figma 设计稿
```

1. 按 [Figwright 官方说明](https://github.com/awdr74100/figwright#setup) 配置 MCP 服务，并在 Figma 桌面端导入插件。
2. 保持服务与插件版本兼容，在目标文件运行插件，确认 Connected。
3. 在可写的 Figma Design 中打开目标文件，提供文件、页面和修改范围；多文件连接时确认绑定正确目标。

技能提供流程，不自带桥接工具。仅有技能或插件文件不代表服务已连接；默认不切换官方 Figma MCP 或其他编辑器。

## 文档以哪个为准？

- [共同约定](.agents/skills/ui-design/references/common.md)：基准尺寸、接手现有成果、版本确认与交付边界。
- [界面对齐](.agents/skills/ui-design/references/ui-alignment.md)：需求分层、追问、方案确认。
- [HTML 制作](.agents/skills/ui-design/references/layout-preview.md)与[原型工艺](.agents/skills/ui-design/references/prototype-craft.md)：制作、状态模拟和自查。
- [Figma 换皮维护](.agents/skills/ui-design/references/figma-ui.md)：必要复用、替换和成果保护约束，不另起视觉布局教程；[首批](.agents/skills/ui-design/references/figma-initial.md)与[增量](.agents/skills/ui-design/references/figma-expand.md)按任务二选一。
- [组件拆分与验收](.agents/skills/ui-design/references/component-decomposition.md)：AI 主拆、人验收／纠偏的判断标准及工具缺口。
- [公开技能研究](docs/research/figma-building-skills.md)：一手来源、借鉴点与不适用范围，按需查阅。
- [讨论记录与 Skill 选择](docs/ui-design-discussion-summary.md)：最终决定、已完成／未验证项及后续技能路线；是状态快照，不替代执行规范。
- [设计台能力适配](.agents/skills/ui-design/references/studio-tools.md)：工具选择、尺寸传递和能力缺口。
- [术语表](.agents/skills/ui-design/references/GLOSSARY.md)：产物与设计概念。

四个单项入口按分支读取参考，参考暂集中存放在总入口目录，便于共享并保留现有脚本路径；这不意味着每个任务要读完整套规范。策划需求仍放在具体功能文档中。

## Figma：一个入口，两种任务

- **首批搭建**：代表主界面 + 够用的换皮源，检查并保留原貌参考后，停下来等你换皮。
- **增量补齐**：换皮就绪后读取实际成果，保留你的美术与组件关联，补齐指定页面／状态。没有新增独立源就不要求再换一遍皮；新增源先说明并确认。
- **换皮维护优先**：布局沿用确认稿，不强制根 Frame 或每层组件使用 Auto Layout；列表等流式区域按收益使用，叠放美术可以用普通 Frame 和必要定位约束。操作标准集中在[Figma 换皮维护](.agents/skills/ui-design/references/figma-ui.md)。

自然语言即可分流，无需新增技能名或固定参数：

```text
/ui-design-figma 先做首批代表界面和换皮源，别铺开其他页面
/ui-design-figma 本批已换好，复用现有成果补齐我指定的其他状态
```

组件拆分验收需要时再用工作台；它提供可视证据而不是额外设计流程，文件能打开不代表拆分或 Figma 同步正确。

## 在其他项目使用

复制全部五个 `ui-design*` 技能目录到目标客户端支持的同一技能父目录，保留它们之间的相对结构及共享参考／脚本；不要仅复制单个入口。工具包按各工具说明单独使用，组件拆分不是技能包运行前提。避免同名重复安装，通用协作规则遵循目标项目。

移动或修改技能后需重载客户端资源。文档与路径检查不代表技能已成功加载，也不代表 Figma 桥接、换皮和实例交换已经实测。
