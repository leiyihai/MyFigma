# Design Studio 基础工具

独立 Node 原生工具，无 DSH 源码或运行时依赖，无需安装 npm 包。需要 Node ≥22（已验证 v24.15.0）及本机 Chrome/Edge。它不修改 HTML，不要求 manifest、SDK 或组件拆分。

## CLI

从仓库根目录执行：

```powershell
node tools/design-studio/cli.mjs --help
node tools/design-studio/cli.mjs serve path/to/index.html --size 1280x720
node tools/design-studio/cli.mjs inspect path/to/index.html --size 1280x720 --screenshot path/to/new.png --report path/to/new.json
node tools/design-studio/tests/test.mjs
```

`serve` 输出仅绑定 `127.0.0.1` 的浏览器地址，数字输入调整原型视口；Ctrl+C 停止。也可 `--duration 60000` 有限运行（毫秒）。不启动或替换 DSH 服务。

`inspect` 使用临时干净无头 Chrome/Edge、DPR=1、真实指定视口；PNG 只截视口，不是整页。stdout 是 JSON；可选报告文件。新证据路径必须不存在，父目录需已存在，拒绝覆盖已有文件、符号链接或源 HTML。同一路径不能同时用于报告和截图。默认 Chrome 查找失败可 `--browser <executable>` 或 `DESIGN_STUDIO_BROWSER`。宽高 100..4096；加载观察预算 `--timeout 3000..60000`（默认 15000ms），单条 CDP 命令另有 5 秒上限，清理另需有限时间。未知、重复、缺值选项失败。

## 三种证据，不能混同

1. **预览**：人工浏览器看到的隔离 iframe；入口和 source SHA-256 可追溯。
2. **真实渲染**：同样 iframe / 内容策略 / 尺寸，干净浏览器渲染的视口 PNG。
3. **尺寸检查**：viewport、page width/height、CSS selector、实际矩形、字体/滚动尺寸等保守观测，以及运行错误和失败资源。入口 HTML 渲染前后 hash 不同会拒绝输出混合版本证据。hash 仅覆盖入口 HTML，不覆盖引用资产。

自动 CLI **不点击、不输入、不提交**，不遍历交互状态。零问题不代表交互或全需求通过。截图/报告是采样时刻结果，不是认证。

## 安全边界与兼容性

- shell 与原型使用**不同端口、不同源**；iframe 仅 `sandbox="allow-scripts"`，不开放 same-origin、表单、顶层导航、弹窗。原型不能读写控制页面 DOM。
- 两个服务只绑定 loopback，且 Host 必须等于实际 `127.0.0.1:port`，降低 DNS rebinding 风险。控制服务不提供原型文件。
- 内容服务仅提供入口 HTML 的**真实父目录**内文件；逐请求 realpath 验证，拒绝 `..`、反斜杠、空字节、路径穿越和符号链接/junction 逃逸，无目录列表。不要将包含秘密文件的宽泛目录作为入口目录。路径检查不构成对抗本机恶意并发替换文件的原子安全边界。
- 内容 CSP：资源限定 self/data/blob；脚本/样式允许 self/inline，禁远程资源、eval、网络连接（fetch/XHR/WebSocket）、表单和 object。CLI 另通过 CDP 拦截非 GET/HEAD/OPTIONS 和预览两源之外的请求。源目录静态服务拒绝非 GET/HEAD。
- **不是任意网页的无损兼容工具**：自包含常规 HTML/CSS/inline JS 可直接运行，普通相对 CSS/经典脚本/图片可加载；依赖远程 CDN、连接 API、表单提交、localStorage/同源能力、eval 的原型可能失效。sandbox 为 opaque origin；本地外链 ES modules、字体等需要 CORS 的资源可能被浏览器拒绝，工具不放宽全目录 CORS。失败会进入错误/资源报告，应依据报告解释而非声称原型本身必有缺陷。
- 这不是恶意 HTML 安全执行产品。原型脚本仍会执行；自身 iframe 导航、浏览器缺陷以及 GET 本身带副作用等并非完整隔绝。仅使用已知可信本地原型。自动工具不会主动触发真实业务操作。
- finally 清理浏览器进程、临时 profile、HTTP 服务；失败输出占位文件移除。不修改浏览器配置或原始 HTML。用户强制终止整个 Node 进程/系统崩溃不在 finally 保证内。

## 检查范围与局限

覆盖：祖先常规 overflow 裁剪后仍可见的元素横向出界、直接文本且 overflow hidden/clip 的溢出启发式、可见图片不可用、小文字（<12px）、小点击框（<24px）、简单不透明前景/背景对比度启发式、采样窗口内 Runtime/console error、HTTP/资源加载错误。报告含 selector 和数值；启发式可能误报（有意省略号、扩展点击区、装饰文字等），需人工确认。遍历最多 20000 元素、最多 1000 条布局问题；其余事件也有采样上限。

**未覆盖**：固定/粘性栏遮挡及底部间距、文本互相重叠、长行/短字断行、图片拉伸、全页滚动/懒加载、所有后续异步状态、伪元素、shadow DOM、嵌套 frame、canvas/WebGL 内像素语义、死链、完整可访问性、交互和业务验收。对比度遇图片、渐变、混合、祖先透明／滤镜合成时跳过，不宣称完整 WCAG 审计。裁剪只按常规轴对齐矩形估算，不覆盖 clip-path、旋转／3D 和复杂包含块关系。page height 为当前文档滚动尺寸，不是固定栏遮挡证明。系统字体、滚动条、GPU/浏览器版本可能影响渲染。

## 公开模块 API（显式受控交互另算证据）

```js
import { startStudio } from './tools/design-studio/server.mjs';
import { inspectBrowser } from './tools/design-studio/browser.mjs';
const size = { width: 1280, height: 720 };
const studio = await startStudio('path/to/index.html', size, { query: 'demo=1' });
try {
  const result = await inspectBrowser(studio, {
    size, timeout: 15000, screenshot: true,
    onReady: async ({ send, frameId, contextId, url }) => {
      // contextId 是已加载原型 frame 的隔离测量世界；可读 DOM，非业务全局变量。
      const bounds = await send('Runtime.evaluate', {
        contextId, expression: 'document.querySelector("button").getBoundingClientRect().toJSON()', returnByValue: true,
      });
      // 仅可信调用方自行决定是否执行 Input；CLI 不暴露 hook。
      const { x, y, width, height } = bounds.result.value;
      const point = { x: x + width / 2, y: y + height / 2, button: 'left', clickCount: 1 };
      await send('Input.dispatchMouseEvent', { type: 'mousePressed', ...point });
      await send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...point });
      return { action: 'explicit native input', frameId, url };
    },
  });
  // result.screenshot 是 PNG Buffer；interactionResult 是 hook 返回值。
  // result.measurements/errors/resources/blockedRequests 是本次采样。
} finally { await studio.close(); }
```

`startStudio` 的 query 在预览和检查入口一致，最长 2048 字符；CLI 暂不提供 query 选项。hook 最长 `timeout`，失败也会清理浏览器。hook 执行的交互必须另行描述操作、断言与未测范围，不能借此宣称默认检查已覆盖交互。`inspectBrowser` 不自动关闭调用者持有的 studio，调用者必须 finally close。

## 测试

`node tools/design-studio/tests/test.mjs` 通过真实 Chrome 和公开 CLI/module API 验证：帮助/非法参数、PNG IHDR 与真实视口、故意坏 HTML、祖先裁剪／透明合成误报回归、前后源 hash、报告/源覆盖保护、浏览器启动失败清理、CSP 外网/POST 阻断、sandbox 父页面访问阻断、Host 检查、HEAD、路径穿越、junction 逃逸、server close、有限期 serve、显式 native Input hook、成功/失败 profile 清理与浏览器 PID 退出。测试临时证据会删除，测试自身不留服务。
