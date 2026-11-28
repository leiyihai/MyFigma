# 游戏 UI 的 Figma 搭建：一手来源研究

查询日：2026-11-28。本文保存研究事实与取舍依据，引用本地流程的描述以研究当时版本为背景；现行判断标准见[组件拆分与验收](../../.agents/skills/ui-design/references/component-decomposition.md)和[Figma 换皮维护](../../.agents/skills/ui-design/references/figma-ui.md)，不把研究报告再当一套执行规范。采用5份源码全文，另查 GitHub 热度；先 web_search、再 web_fetch 核实，后续一次搜索失败，未覆盖整个热榜。

## 一、事实：能力、条款与证据

1. **Figwright `figma-build` 真正写 Figma。**先查变量、组件、样式，实例化已有组件，仅补缺口；输入可以是代码或描述，不要求先经过 HTML 拆分工作台。主技能是路由，细节按阶段加载。要求一次创建尽量带全样式、一个区块用原子 `batch`、增量搭建并截图核实；`ok:true` 不等于验收通过。[S1]
2. **不要混淆方向。**同仓 `figma-codegen` 是 Figma→项目代码，复用的是代码组件、token；其映射文件和 `design_diff` 增量同步不能直接证明能创建 Figma 主组件或保护换皮成果。[S2] 真正的写入依据是 S1，以及下面官方的 `use_figma`。
3. **官方 `figma-use` 是 Plugin API 执行技能。**先只读检查现有页面、组件、变量、命名；写操作返回受影响 ID、数量或尺寸。最新条款明确：按可安全重试边界批处理，不为固定验证节奏机械拆碎；通常合成后一次截图，有视觉修复才再截，不重复未变化的最终检查。错误后是否读回取决于 `safeToRetryWithoutCanvasRead`。[S3]
4. **官方 `figma-generate-design` 负责组装界面。**重复元素首遍就建主组件并放实例，避免先画 N 份再组件化；保留嵌套实例，优先属性覆盖。更新已有界面时定位原节点，只改需要变化的区域，不整屏重建；交付必须主要是可编辑层，不可拿整屏截图冒充。[S4] 它区别“界面组装”和“可复用库资产”两种任务，但没有证明游戏换皮必须拆成两个技能。
5. **Southleft `component-properties-figma` 能写属性、建实例。**明确使用 `use_figma`，支持 TEXT、BOOLEAN、INSTANCE_SWAP、VARIANT；已有实例可走 `setProperties`，本地未发布组件用 nodeId，发布组件用 key。[S5] 这是组件 API 操作技能，不是完整游戏界面生产流程；其错误原子性等表述不能跨版本替代官方错误恢复契约。[S3][S5]

热度仅作筛选背景：GitHub API 的 `stargazers_count` 为 [Figwright 1586](https://api.github.com/repos/awdr74100/figwright)、[Figma 官方指南仓库 2242](https://api.github.com/repos/figma/mcp-server-guide)、[Southleft 技能仓库 22](https://api.github.com/repos/southleft/skills-for-figma)。均为仓库总星数，非单技能采用量；安装量未知，不能据此认定质量或广泛生产采用。

## 二、建议：本项目怎样减负

**工作台是验收工具，不是人工从零拆分关卡。**上述写入技能直接发现 Figma 资产并组装，没有要求先制作中间组件工作台。[S1][S3][S4] 用户后续决定保留工作台，用于 AI 按规范准备拆分后的人验收、反馈重拆和选区纠偏；这是一项本项目取舍，不是外部技能证明了工具已经支持 AI。保留“AGENTS 短入口→任务技能→按需规范”，不强制普通原型经过工作台；仍需读回、实例关联和视觉证据。具体能力缺口以工作台 README 为准。

**复用落到资产身份，而非相似外观。**每批先检查实际主组件、实例、属性及资源，已有则实例化，差异优先属性覆盖，缺项才新增；复用一次有效清单，不反复全库扫描；相关创建和绑定合批，按风险小批验证，不逐节点截图。[S1][S3][S4][S5] 这些是执行重点，不应复制成多份长规范；当前已收拢为换皮维护的共享规则，去掉全局 Auto Layout 导向及重复通用搭建教程，保留复用与成果保护。

**拆两个明确任务，不急于拆两个技能。**首批任务交付“代表主界面＋够用换皮源”，暂停；用户换皮并确认范围后，另起“基于实际成果的后续搭建”任务，可完成指定全部页面/状态，但新增独立美术源仍分批确认。此门槛在旧流程已经存在；当前保留单一 `ui-design-figma`，按任务加载[首批](../../.agents/skills/ui-design/references/figma-initial.md)或[增量](../../.agents/skills/ui-design/references/figma-expand.md)分支，不复制两套技能。外部支持按交付物分工和增量更新，不能当作必须拆技能的证据。[S4]

## 三、未验证与不适用

本地[工作台说明](../../tools/html-component-workbench/README.md#5-组件稿组引用与映射的语义)明确：组不代表继承，只有显式引用才共享；有效映射须 confirmed 且复核已解决；它不连接 Figma，[真实 Figma 验收未做](../../tools/html-component-workbench/README.md#8-已验证与未验证范围)。因此不能把工作台保存成功当实例同步成功。

未在真实游戏稿比较两条路径的工时、返工或模型调用量，不能断言“按需规范一定够用”。官方 S4 假设已有发布设计系统，且含网页捕获链路，不适合原样强加给本项目本地组件、游戏换皮流程；S1 的动画要求也不应覆盖本地“不制作 Figma 交互流程”的边界。本轮只整理文档，未改工作台代码或验证新 AI 接入闭环，也未在 Figma 中实测精简后的结构。后续须另行确认一小批真实界面，对照实际换皮操作成本，不能仅凭文档删减宣称已经省工。

## 一手全文索引

- [S1：Figwright / figma-build](https://raw.githubusercontent.com/awdr74100/figwright/main/skills/figma-build/SKILL.md)
- [S2：Figwright / figma-codegen](https://raw.githubusercontent.com/awdr74100/figwright/main/skills/figma-codegen/SKILL.md)
- [S3：Figma 官方 / figma-use](https://raw.githubusercontent.com/figma/mcp-server-guide/main/skills/figma-use/SKILL.md)
- [S4：Figma 官方 / figma-generate-design](https://raw.githubusercontent.com/figma/mcp-server-guide/main/skills/figma-generate-design/SKILL.md)
- [S5：Southleft / component-properties-figma](https://raw.githubusercontent.com/southleft/skills-for-figma/main/skills/component-properties-figma/SKILL.md)

以上为查询日 main 分支全文，后续可能变更；未将 Matt Pocock 的通用任务拆分原则充当 Figma 实践证据。

[S1]: https://raw.githubusercontent.com/awdr74100/figwright/main/skills/figma-build/SKILL.md
[S2]: https://raw.githubusercontent.com/awdr74100/figwright/main/skills/figma-codegen/SKILL.md
[S3]: https://raw.githubusercontent.com/figma/mcp-server-guide/main/skills/figma-use/SKILL.md
[S4]: https://raw.githubusercontent.com/figma/mcp-server-guide/main/skills/figma-generate-design/SKILL.md
[S5]: https://raw.githubusercontent.com/southleft/skills-for-figma/main/skills/component-properties-figma/SKILL.md
