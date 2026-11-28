# HTML 组件拆分工作台 · 实现与接入契约 v1

独立本地工具，无运行服务器、不连接 Figma。父规格 #29，基础任务 #30。只支持显式适配的原型，不读取用户既有家园文件。

定位与范围：工作台用于承载“AI 按规范主拆，人检查验收/反馈重拆，必要时手工选区纠偏”；当前项目流程与拆分判断以[组件拆分判断规范](../../.agents/skills/ui-design/references/component-decomposition.md)及其所属技能为准，当前能力说明见 [README](README.md)。目标流程不表示 AI 自动拆分已实现。现有载入入口校验合法 v1 项目 HTML（包括组件稿、组、引用、映射）后整项目替换，不是 AI 生成服务、JSON API 或增量合并；AI 批量预拆生产入口、反馈重拆增量接入与确认来源审计尚缺。导入接受 `confirmed` 不等于审计过人工确认来源，字段本身不能证明有人确认。本文以下 v1 数据结构、关系语义与接口保持不变；Issue #29 是历史背景，不覆盖新的流程定位。本轮不新增实现或真实 AI/Figma 验收声明。

**建议接入（见文末「AI 拆分建议文件」）是已确认、待实现的下一层**：该节定义 AI 建议文件的独立格式与「预览→接受才落地」语义，v1 项目结构、既有字段与接口均不改变；本节以下正文仍是 v1 现状，未实现建议接入。

## 文件与并行归属

- 基础：`src/{app,shell,host,project}.js`、`src/shell.css`、`src/prototype-bridge.js`、`build.mjs`、`examples/controlled.html`、`tests/foundation.spec.cjs`。
- 提取任务独占新增 `src/features/extraction.js`、可选 `extraction.css`、`src/bridge-features/extraction.js`、`tests/extraction.spec.cjs`。
- 关系任务独占新增 `src/features/relations.js`、可选 `relations.css`、`tests/relations.spec.cjs`。
- 文件任务独占新增 `src/features/files.js`、可选 `files.css`、`tests/files.spec.cjs`。
- 建议导入任务独占新增 `src/features/proposal.js`、可选 `proposal.css`、`tests/proposal.spec.cjs`；其校验只读当前项目副本，不使用 runCommand/registerGuard/host.request，测试样例放 `tests/fixtures/proposal/`。
- 不并发修改 app/shell/build/本文。需要扩展 Interface 时先通知集成方；测试样例各自放 `tests/fixtures/<任务>/`，不改基础受控样例。
- 共用模块为 `src/features/common.js` 与 `common.css`（按文件名排序先于 `extraction/files/relations` 加载）：只定义 `window.WorkbenchCommon` 的惰性解析、沙箱预览文档、缩放控件、引用图/槽位重叠/有效映射判定，不注册 feature；特性模块不得各自复制这些实现。
- 构建按文件名排序自动收集 features 的 JS/CSS 和 bridge-features JS，内联为 `dist/workbench.html`（可直接 file:// 打开）。features 都是普通 JS IIFE，不用 import、依赖和运行服务。

## 唯一测试 seam 与命令

最高层 seam 已在 #29 确认：Playwright 操作真实工作台公开 UI，检查真实文件。不得调用私有状态/提取算法制造结果。

PowerShell（仓库根）：
```powershell
$node = 'C:\Users\Administrator\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe'
& $node tools/html-component-workbench/build.mjs
$env:WORKBENCH_PLAYWRIGHT_ROOT = 'E:\MyFigma\tools\figma-project-assets\nine-slice-plugin\node_modules'
& $node --test tools/html-component-workbench/tests/*.spec.cjs
# 单任务仅把末尾 glob 换为 tests/foundation.spec.cjs 等
```
测试以系统 Chrome 启动；可用 `WORKBENCH_CHROME` 指定现有可执行路径。不安装依赖，不使用 pnpm run。构建产物不提交；tests/support.cjs 只提供真实浏览器/路径启动工具，可复用但不并发修改。

## 项目资料（所有 ID 都为稳定字符串）

```js
{
  format: 'html-component-workbench', formatVersion: 1,
  id: 'project-…', name: '未命名项目',
  prototype: null /* 或 {manifest, html, fileName}；html 为完整原始 HTML，不含宿主注入 */,
  drafts: [], groups: [], references: [], mappings: [], reviews: [],
  workspace: null /* 或 {mode:'preview'|'edit', pageId, stateId}，仅查看位置/模式 */
}
// manifest 原型格式版本与内容版本分离，详见下节
// Draft
{id, name, source: {prototypeId, contentVersion, pageId, stateId, nodeIds: [], bounds: {x,y,width,height}},
 content: {html, css, width, height, assets: []}, revision: 1}
// Group：顺序保存，不按列表排序猜主体；不代表继承
{id, name, primaryId, memberIds: []}
// Reference（嵌套复用/引用）：使用方指向来源；slotNodeId 是使用方 content 中稳定节点
{id, ownerDraftId, targetDraftId, slotNodeId, overrides: [{nodeId, kind:'text', value}], targetRevision: 1}
// Mapping：候选不成为强制复用依据
{id, draftId, source: {prototypeId, pageId, stateId, nodeIds: []}, status:'candidate' /* confirmed | excluded */, reviewId: null}
// Review：改版后保留人工决定但明确待复核
{id, kind:'source-changed' /* source-missing | source-added | mapping-stale | unsupported */, draftId, mappingId:null, message, resolved:false}
```
`workspace` 只记录重新打开时的查看位置和工作模式，用于恢复界面，不是原型业务状态，也不参与组件身份或来源判断。原型改版导致该页面/状态失效时，载入或改版流程回退到新版首个可用页面/状态，不因此拒绝整份项目。

`references` 的 `slotNodeId` 必须位于 owner 的 `content.html`，且同一 owner 内不得与任何既有引用位置互为祖先/后代（重叠会删除旧位置并造成悬空引用，载入与新建都必须拒绝）。引用建立/更新后，owner 的 `content.html` 必须在 `slotNodeId` 内包含且仅包含一个 `<div data-wb-ref-root="<reference id>" data-wb-ref-target="<target draft id>">`；缺失、重复、目标不符或存在未登记 `data-wb-ref-root` 的项目文件视为关系损坏。被引用组件的 CSS 在嵌入时必须限定在对应 `data-wb-ref-root` 之下；`@keyframes` 等无法安全隔离的规则必须明确拒绝，不能把宽泛选择器直接并入使用方。

`mappings[].reviewId` 与 `reviews[].mappingId` 必须双向一致：映射指向的复核必须回指该映射，复核指向的映射也必须回指该复核。`source-added` 复核聚合原型改版新增的页面、状态或稳定节点，`draftId` 与 `mappingId` 均为 `null`；其他复核必须绑定存在的组件稿。设计者可通过界面“解除复核”保留原绑定，或在编辑模式明确选区后“重新绑定到当前选区”；解除复核不自动改写人工决定，也不按外观/序号猜测重绑。

数据是 JSON 可序列化值；不可放 DOM、函数、blob URL。资源最终须 data URL 或内联（由文件任务验证）。原型改版不得直接清空这些数组。新字段应向前兼容；关系和文件任务负责其领域完整性检查。组件稿 HTML 不能直接插入宿主可执行 DOM，必须沙箱预览；关系模块解析组件稿必须使用 DOMParser 等惰性解析，不得用 `template.innerHTML` 把草稿 HTML 写入宿主 DOM。

## 原型稳定节点协议

原型 HTML 内必须包含 `<script type="application/json" id="workbench-manifest">…</script>`：
```js
{
  format: 'workbench-prototype', version: 1, id:'controlled-kit', contentVersion:'1', name:'受控组件样例',
  viewport:{width:960,height:600},
  capabilities:['navigate','freeze','stable-nodes'],
  pages:[{id:'cards',name:'卡片',states:[{id:'default',name:'默认'},{id:'detail',name:'详情'}]},
         {id:'dashboard',name:'统计',states:[{id:'default',name:'默认'}]}]
}
```
- 页面、状态 ID 各自在原型/页面内唯一；节点 `data-wb-node="card-a"` 在整个文档唯一、非空、跨改版不随顺序改变。每个可选元素都显式标记，保留原有嵌套。隐藏页可以保留节点；动态新节点必须稳定命名且不能复用已删除身份。
- 原型定义 `window.WorkbenchPrototype = { navigate({pageId,stateId}), setMode(mode) }`；两者同步或返回不依赖业务 clock 的 Promise（控制通道不能使用已冻结的 setTimeout 等等待）。navigate 必须直接呈现指定状态；setMode 接收 preview/edit，在 edit 暂停原型专有变化源（音视频/外部回调、基于 Date.now 的自驱时钟、Worker 等）。桥接在业务脚本之前拦截常规鼠标/键盘/hover 输入、函数形式 setTimeout/setInterval、RAF 与 CSS/WAAPI 动画，不宣称可冻结任意未适配脚本。原先暂停的动画不会因恢复预览而播放；计时器保留剩余时间、不补跑暂停时长。
- 资源首版只支持原型自包含的内联 CSS/脚本和 data URL 图片/字体/媒体，不从磁盘邻居或网络加载。清单可选 `resources:[]` 用于说明必要资源（`{id,kind,nodeId}`），实际字节仍在 HTML。握手等待字体与所有 img.decode；缺图、缺能力或不支持的版本明确拒绝，保留已有原型。外链资源不能通过 CSP 阻断后冒充完整导入，文件任务须全面审计 CSS/SVG 等资源可携带性。
- 不允许节点选择器序号、显示名或 DOM 层级作为身份。缺失清单/能力/重复 ID/无 adapter 会阻止载入，保留原项目。
- 原型中不得要求同源宿主权限、打开弹窗、联网依赖、表单提交或任意父窗口数据访问。原型在仅 `allow-scripts` 的不透明来源 iframe 中执行；无 allow-same-origin / top-navigation。

## Host / Bridge Interface

宿主 `Workbench.host`：
- `await load(html, fileName, options={})`：验证并暂存候选 iframe；options 可含 `{mode:'preview'|'edit',pageId,stateId,beforeCommit}`，默认预览及第一页第一个状态。候选完成握手、目标 navigate 和 mode 后才替换当前原型；即使同模式也会调用 adapter.setMode（须幂等）。返回 `{manifest,html,fileName}`。任何校验、导航、模式或超时失败均丢弃候选，旧画布与业务状态不变。
- `beforeCommit(candidatePrototype)` 是可选**同步**校验钩子，接收候选资料副本；在所有可失败异步初始化完成后、替换旧画布前执行。可检查项目快照仍未改变；抛错或返回 false 拒绝提交。不得 await 该钩子；返回 Promise 会被明确拒绝。钩子不要修改项目或产生其他副作用。最终替换后不再导航/切模式/执行可失败异步操作，仅等待不拒绝的可见绘制帧后返回。并发 load 明确拒绝。
- 候选专用 port 的 pending response 可在尚未 active 时响应初始化命令；selection/location 事件始终只接受 active 原型，不向宿主泄漏候选状态。调用方在 await load 成功后同步 replaceProject/updateUI，不再发可失败的初始化命令。
- `await request(type, payload={})`：向当前原型发送有超时的命令，返回 JSON 结果。基础命令 `navigate`、`mode`、`selection`（设置 IDs），`inspect`（返回当前稳定节点的标签、父 ID、bounds）；后续提取扩展注册新命令。
- 原型业务导航也必须调用公开 `window.WorkbenchPrototype.navigate(location)`，不可绕过它调用私有渲染函数；桥接包装此方法并发送 `location`，让宿主当前页面保持一致。
- `subscribe(listener)`：事件 `{type:'location',payload:{pageId,stateId}}` 或 `{type:'selection', payload:{nodeIds, pageId,stateId, clickedId}}`；订阅函数返回 unsubscribe。`clickedId` 仅在编辑点击时给出，是当次点击的稳定节点 ID（纯追加、向后兼容），特性应按它判断加选/减选，不能用选择前后差集推断被点节点。宿主只接受当前 iframe、专用 MessagePort、正确协议和 requestId 的预期消息，任何原型消息都不能直接 patch 项目。
- `stop()` 销毁当前运行画布并拒绝 pending 命令，不修改项目资料。基础 `navigate`/`setMode` 若拒绝或超时，宿主不冒充成功：停止不可靠画布、设置 UI `blockedReason` 并提供“重新载入当前原型”；重新载入会重置原型业务状态，已有组件稿/人工关系保留。
- `element` 当前 iframe（只作布局/可访问定位，不依赖跨源 DOM）；`manifest` 当前清单。

桥接扩展在构建内联的原型隔离世界中执行：
```js
WorkbenchBridge.register('extract', async payload => { /* 验证参数，读取真实 DOM，返回 JSON */ });
```
`WorkbenchBridge` 提供 `getNode(id)`、`getContext()` → `{manifest,mode,pageId,stateId,selection}`；模块自己负责支持条件校验。节点选择事件使用同一个 port，编辑点击只发稳定节点 ID、Shift 加选/再次点减选，`selection` 事件附带当次 `clickedId`（被点击的 `data-wb-node`）。Bridge 不向原型暴露宿主项目资料。直接向 parent.postMessage 伪造 project/update 或 selection 无效。

## 宿主状态与壳层扩展

`window.Workbench` 在 feature 初始化前就绪：
```js
Workbench.registerFeature({id:'extraction', mount(ctx) { /* 只调用一次 */ }, render(ctx) { /* 每次更新 */ }});
```
ctx 为同一个小 Interface：
- `getProject()` / `getUI()` 返回副本；UI `{tab:'screens'|'components',view:'prototype'|'relations'|'draft',mode:'preview'|'edit',blockedReason:null,pageId,stateId,selection:[],selectedDraftIds:[],activeDraftId:null}`。
- `updateProject(mutator)`：先在深副本应用同步 mutator，成功才整体提交、触发统一 render；抛错不提交。`replaceProject(project)` 用于文件载入，文件模块先自行完整验证。
- `selectedDraftIds` 必须保存真实多选顺序，由提取模块的左侧列表维护；关系模块读取该顺序，首项为主体。`activeDraftId` 只负责当前独立预览。
- 组件稿 `content.html` 必须保留 `data-wb-node`，供引用 slot 和文字 overrides 稳定定位。
- `registerGuard(command, async payload => true|false|apply)` 注册提交前检查，返回解除函数。`await runCommand(command,payload,(nextProject,payload)=>{/* 同步原子提交 */})` 按注册顺序等待 guards，false 取消且不提交；guard 抛错或期间项目改变也不提交。guard 可返回同步 `apply(nextProject,payload)` 函数，与主提交在同一副本按顺序执行，任一抛错整体不提交，用于引用展开/覆盖传播的原子更新。统一命令 `draft:update`，payload `{draftId, nextDraft}`；`reference:create`，payload `{ref}`。提取模块在覆盖更新前必须走 `draft:update`，关系模块注册 guard 预览影响、阻止冲突或返回 apply，不改提取内部实现。新建组件稿仍用 updateProject；新建嵌套引用必须走 `reference:create`，其 guard 在会同步既有使用方时先展示影响并等待确认。
- `updateUI(patch)` 更新 UI 并统一重渲染。不能用它偷偷替代 `navigate`/`mode`；这两项使用 `await navigate(pageId,stateId)` / `await setMode(mode)`，桥接成功才更新 UI。
- `host` 即以上 Interface；`notify(message, isError=false)` 可见结果/失败提示。
- `slots` 提供该模块独占的 `{toolbar,left,center,right}` DOM 容器。shell 为每个 feature 在四个位置各创建一块，其他模块不修改、不清空。render 必须仅更新自己的容器；需要显示条件自行用 hidden。`center` 位于原型画布旁，shell 当 view=prototype 显示原型，否则隐藏原型但不销毁 iframe。
- `subscribe(listener)` 在统一 render 后通知，返回 unsubscribe。不要订阅后再次无条件 update 导致循环。

## 单 HTML 导出安全（文件任务）

- 惰性 JSON 建议使用唯一 `script#workbench-project[type="application/json"]`，至少包含以上完整 Project。序列化必须转义 `<` 为 JSON 文本 `\u003c`（JS replacement 字符串写作 `'\\u003c'`）（包括任何大小写的 `</script>`），不能把用户 HTML 当顶层脚本或属性直接拼接。
- 单文件可以封装当前完整工作台（壳层初始化会重建 root）；文件特性 mount 时发现惰性项目记录，先完整校验、`await ctx.host.load(project.prototype.html, fileName, {mode,pageId,stateId,beforeCommit})`，候选初始化全部成功后同步 replaceProject + updateUI；无须改 app/start。空白会话载入也走同一校验流程。不得执行被载入 HTML 顶层脚本来读数据。
- 基础“载入原型／打开受控示例”入口仅用于未整理项目；drafts/groups/references/mappings/reviews 任一非空即阻止直接覆盖，并提示使用文件特性的“更新原型”。文件特性负责预先完整验证、计算 reviews、保存项目快照，并以 beforeCommit 同步确认快照仍未改变。基础故障恢复的“重新载入当前原型”只允许完全相同 HTML，保留既有资料；候选载入期间项目发生变化也拒绝提交。
- 项目载入先验证、暂存再提交；拒绝未知版本、损坏关系、不可携带资源。draft 内容始终在无脚本沙箱中预览，禁止 innerHTML 进入宿主、事件属性/导航/脚本/任意 URL 执行。原型始终由 host 的不透明来源沙箱承载，不能为导出 viewer 取消隔离。
- CSP 只是防护，不是资源完整性证据。文件模块全面审计 CSS/SVG/字体/媒体等必要资源，拒绝缓存、外链、blob URL、开发机路径；新 BrowserContext 离线 file:// 打开下载文件及空工作台重新载入是唯一保存闭环验收。

特性模块只通过此 Interface 更新和重渲染；不编辑 app/shell，不访问私有状态。组件 TAB 默认 `view=relations`；提取模块负责组件列表/独立预览，关系模块负责关系中心/右操作，文件模块负责工具栏载入/保存/改版入口。任何错误显示原因、保留旧成果，不降级为假成功。

## AI 拆分建议文件（#36 导入已实现，预览与落地待后续任务）

本节是**下一层接入的设计契约**：其中建议文件的解析、逐条校验与候选载入（#36）已实现，见「导入实现与 Interface」；「预览→接受才落地」的预览与落地仍待后续任务。它只新增一份 AI 可产出的建议文件格式和「预览→接受才落地」语义；不改 v1 项目 `format/formatVersion`、字段、关系规则或接口。实现前须先把本节完整核对，再按 /to-spec 进入实现。

### 导入实现与 Interface（#36 已实现）

- proposal 特性只读使用 Interface 的 `getProject()` 副本、`notify()` 与自身独占 `slots`（toolbar 提供「载入建议/清除建议」入口，right 呈现候选列表）；不调用 `updateProject/replaceProject/runCommand/registerGuard`，不发 `host.request`、不订阅宿主事件、不注册桥接命令。
- 候选状态只存在于该特性自身的会话内存（建议层），不写入 v1 项目结构；导入不产生 `confirmed`、不生成任何新 draft/group/reference/mapping ID，也不改变画布与当前页面/状态。
- 逐条校验分三态：`有效`（结构合法且 `source`/组件稿引用与当前原型/项目匹配）、`不可用`（结构合法但原型 ID、页面/状态、稳定节点或既有组件稿引用与当前项目不匹配）、`非法`（结构本身无效并附原因）；失配项单独标记，不整批连坐。顶层 `name` 仅对 component 生效，其余 kind 忽略；`group.id` 由工作台在落地时生成。
- 文件级校验：唯一 `script#workbench-proposal[type="application/json"]`、惰性 JSON 转义与项目文件一致、文件大小上限 4 MB、顶层必须是非空 `proposals` 数组；任何失败明确报错并保留当前项目、画布与已载入候选列表。

### 目标与边界

- **单向**：AI 在聊天里产出建议文件，人导入工作台。建议不携带原型、不改现有项目。
- **AI 主拆、人验收**：建议叠加在当前项目上**预览**，只有人接受的才落地为正式 `drafts/groups/references/mappings`。
- **AI 只声明意图**：AI 不能产出 `confirmed`；建议落地时由工作台按现有规则写入状态，人的接受才是确认。
- **稳定身份**：边界用 `data-wb-node` 稳定节点 ID 表达，不写坐标、选择器序号或 DOM 路径。

### 载体与校验

- 建议文件是普通 HTML，含唯一 `<script id="workbench-proposal" type="application/json">…</script>`；惰性 JSON 转义规则与项目文件一致（`<` 写为 `\u003c`）。文件不含原型或项目资料，大小上限 4 MB。
- 载入只解析该区块并逐条校验；原型/项目当前版本与建议 `source` 不匹配时，整批拒绝或把失配项单独标「不可用」，不静默套用。任何情况下不改已有项目。

### 建议内容

每条建议（`proposals[]`）承载**边界 + 关系 + 理由**，最小字段：

```js
{
  kind: 'component' /* 新增组件稿 */ | 'group' /* 归组 */ | 'reference' /* 嵌套引用 */ | 'reuse' /* 来源复用映射 */,
  name: '组件稿名',          // kind=component 必填，其余忽略
  source: {prototypeId, pageId, stateId, nodeIds: []},
  group: {id?, name?, primaryId?, memberIds?},   // kind=group
  reference: {ownerDraftId, targetDraftId, slotNodeId}, // kind=reference
  reuse: {draftId, source},                        // kind=reuse
  reason: '一句为什么这样拆（独立换皮 / 共享结构）'
}
```

`draftId/primaryId/memberIds/ownerDraftId/targetDraftId` 指既有 `drafts` 的稳定 ID；新组件稿由工作台在接受时生成 ID，AI 不填。AI 只产出 `candidate` 意图；`confirmed/excluded` 由工作台写。

### 预览与落地

- **预览**：载入建议后，原画布高亮每条建议的边界（新增稿的节点集合高亮），组件稿可独立预览核对文字/图片/层叠/裁切，关系概览显示建议的同组与引用，来源复用按候选呈现。
- **落地**：人逐条勾选或整批接受；接受的才写正式记录。写入走现有 `runCommand` / `registerGuard`（组件稿 `draft:update` 与新建、`reference:create` 的循环/重叠/覆盖保护），确认前展示引用影响，任一失败整批不落地。AI 建议只作为候选，不越过人的接受写 `confirmed`。
- **拒绝/纠偏**：不接受或拆错的建议保持候选或标记排除，人定位后可导出反馈给 AI 重拆；手工选区仍是兜底。已有 `confirmed` 且无未解决复核的有效约束不被建议静默覆盖。

### 验证 seam

最高层沿用真实浏览器 + 真实 UI + 真实单 HTML 文件闭环：导入建议文件 → 预览边界/组件稿/关系 → 勾选或整批接受 → 保存项目 → 离线重开核对落地结果。不暴露私有算法 API 制造结果。建议文件格式与项目文件格式分离，AI 输出一份、工作台校验同一份，避免各自猜。
