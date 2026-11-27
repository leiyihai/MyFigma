# HTML 组件拆分工作台 · 实现与接入契约 v1

独立本地工具，无运行服务器、不连接 Figma。父规格 #29，基础任务 #30。只支持显式适配的原型，不读取用户既有家园文件。

## 文件与并行归属

- 基础：`src/{app,shell,host,project}.js`、`src/shell.css`、`src/prototype-bridge.js`、`build.mjs`、`examples/controlled.html`、`tests/foundation.spec.cjs`。
- 提取任务独占新增 `src/features/extraction.js`、可选 `extraction.css`、`src/bridge-features/extraction.js`、`tests/extraction.spec.cjs`。
- 关系任务独占新增 `src/features/relations.js`、可选 `relations.css`、`tests/relations.spec.cjs`。
- 文件任务独占新增 `src/features/files.js`、可选 `files.css`、`tests/files.spec.cjs`。
- 不并发修改 app/shell/build/本文。需要扩展 Interface 时先通知集成方；测试样例各自放 `tests/fixtures/<任务>/`，不改基础受控样例。
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
  drafts: [], groups: [], references: [], mappings: [], reviews: []
}
// manifest 原型格式版本与内容版本分离，详见下节
// Draft
{id, name, source: {prototypeId, contentVersion, pageId, stateId, nodeIds: [], bounds: {x,y,width,height}},
 content: {html, css, width, height, assets: []}, revision: 1}
// Group：顺序保存，不按列表排序猜主体；不代表继承
{id, name, primaryId, memberIds: []}
// Reference：使用方指向来源；slotNodeId 是使用方 content 中稳定节点
{id, ownerDraftId, targetDraftId, slotNodeId, overrides: [{nodeId, kind:'text', value}], targetRevision: 1}
// Mapping：候选不成为强制复用依据
{id, draftId, source: {prototypeId, pageId, stateId, nodeIds: []}, status:'candidate' /* confirmed | excluded */, reviewId: null}
// Review：改版后保留人工决定但明确待复核
{id, kind:'source-changed' /* source-missing | mapping-stale | unsupported */, draftId, mappingId:null, message, resolved:false}
```
数据是 JSON 可序列化值；不可放 DOM、函数、blob URL。资源最终须 data URL 或内联（由文件任务验证）。原型改版不得直接清空这些数组。新字段应向前兼容；关系和文件任务负责其领域完整性检查。组件稿 HTML 不能直接插入宿主可执行 DOM，必须沙箱预览。

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
- `await load(html, fileName)`：验证并暂存候选 iframe，握手成功才替换当前原型；返回 `{manifest, html, fileName}`，失败抛出可展示错误。
- `await request(type, payload={})`：向当前原型发送有超时的命令，返回 JSON 结果。基础命令 `navigate`、`mode`、`selection`（设置 IDs），`inspect`（返回当前稳定节点的标签、父 ID、bounds）；后续提取扩展注册新命令。
- 原型业务导航也必须调用公开 `window.WorkbenchPrototype.navigate(location)`，不可绕过它调用私有渲染函数；桥接包装此方法并发送 `location`，让宿主当前页面保持一致。
- `subscribe(listener)`：事件 `{type:'location',payload:{pageId,stateId}}` 或 `{type:'selection', payload:{nodeIds, pageId,stateId}}`；订阅函数返回 unsubscribe。宿主只接受当前 iframe、专用 MessagePort、正确协议和 requestId 的预期消息，任何原型消息都不能直接 patch 项目。
- `stop()` 销毁当前运行画布并拒绝 pending 命令，不修改项目资料。基础 `navigate`/`setMode` 若拒绝或超时，宿主不冒充成功：停止不可靠画布、设置 UI `blockedReason` 并提供“重新载入当前原型”；重新载入会重置原型业务状态，已有组件稿/人工关系保留。
- `element` 当前 iframe（只作布局/可访问定位，不依赖跨源 DOM）；`manifest` 当前清单。

桥接扩展在构建内联的原型隔离世界中执行：
```js
WorkbenchBridge.register('extract', async payload => { /* 验证参数，读取真实 DOM，返回 JSON */ });
```
`WorkbenchBridge` 提供 `getNode(id)`、`getContext()` → `{manifest,mode,pageId,stateId,selection}`；模块自己负责支持条件校验。节点选择事件使用同一个 port，编辑点击只发稳定节点 ID、Shift 加选/再次点减选。Bridge 不向原型暴露宿主项目资料。直接向 parent.postMessage 伪造 project/update 或 selection 无效。

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
- `registerGuard(command, async payload => true|false|apply)` 注册提交前检查，返回解除函数。`await runCommand(command,payload,(nextProject,payload)=>{/* 同步原子提交 */})` 按注册顺序等待 guards，false 取消且不提交；guard 抛错或期间项目改变也不提交。guard 可返回同步 `apply(nextProject,payload)` 函数，与主提交在同一副本按顺序执行，任一抛错整体不提交，用于引用展开/覆盖传播的原子更新。统一命令 `draft:update`，payload `{draftId, nextDraft}`；提取模块在覆盖更新前必须走此命令，关系模块注册 guard 预览影响、阻止冲突或返回 apply，不改提取内部实现。新建组件稿仍用 updateProject。
- `updateUI(patch)` 更新 UI 并统一重渲染。不能用它偷偷替代 `navigate`/`mode`；这两项使用 `await navigate(pageId,stateId)` / `await setMode(mode)`，桥接成功才更新 UI。
- `host` 即以上 Interface；`notify(message, isError=false)` 可见结果/失败提示。
- `slots` 提供该模块独占的 `{toolbar,left,center,right}` DOM 容器。shell 为每个 feature 在四个位置各创建一块，其他模块不修改、不清空。render 必须仅更新自己的容器；需要显示条件自行用 hidden。`center` 位于原型画布旁，shell 当 view=prototype 显示原型，否则隐藏原型但不销毁 iframe。
- `subscribe(listener)` 在统一 render 后通知，返回 unsubscribe。不要订阅后再次无条件 update 导致循环。

## 单 HTML 导出安全（文件任务）

- 惰性 JSON 建议使用唯一 `script#workbench-project[type="application/json"]`，至少包含以上完整 Project。序列化必须转义 `<` 为 JSON 文本 `\u003c`（JS replacement 字符串写作 `'\\u003c'`）（包括任何大小写的 `</script>`），不能把用户 HTML 当顶层脚本或属性直接拼接。
- 单文件可以封装当前完整工作台（壳层初始化会重建 root）；文件特性 mount 时发现惰性项目记录，先完整校验、`await ctx.host.load(project.prototype.html, fileName)`，成功后 replaceProject + updateUI；无须改 app/start。空白会话载入也走同一校验流程。不得执行被载入 HTML 顶层脚本来读数据。
- 项目载入先验证、暂存再提交；拒绝未知版本、损坏关系、不可携带资源。draft 内容始终在无脚本沙箱中预览，禁止 innerHTML 进入宿主、事件属性/导航/脚本/任意 URL 执行。原型始终由 host 的不透明来源沙箱承载，不能为导出 viewer 取消隔离。
- CSP 只是防护，不是资源完整性证据。文件模块全面审计 CSS/SVG/字体/媒体等必要资源，拒绝缓存、外链、blob URL、开发机路径；新 BrowserContext 离线 file:// 打开下载文件及空工作台重新载入是唯一保存闭环验收。

特性模块只通过此 Interface 更新和重渲染；不编辑 app/shell，不访问私有状态。组件 TAB 默认 `view=relations`；提取模块负责组件列表/独立预览，关系模块负责关系中心/右操作，文件模块负责工具栏载入/保存/改版入口。任何错误显示原因、保留旧成果，不降级为假成功。
