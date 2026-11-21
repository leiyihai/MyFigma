# Rust 本地资源助手（#2、#11）

独立的 Windows 程序：从构建产物启动、驻留通知区域（托盘），无需 ui-studio 或开发服务器。不安装系统服务、计划任务或开机启动项，也不改系统级环境变量。

## 构建与启动

要求 Rust stable（本次使用 1.95）、Windows。此目录独立维护 `Cargo.toml` / `Cargo.lock`。

```powershell
cargo build --release --locked
.\target\release\figma-assets-helper.exe
```

启动后同时出现控制台窗口和托盘图标，两者都能停止进程。默认只监听 `127.0.0.1:38473`，Figma 插件使用 `http://localhost:38473` 访问，以兼容其 manifest 本地开发域名校验。端口被占用时不要向未知进程输入令牌。

## 托盘与退出

- 托盘提示文字：`资源助手运行中 · 端口 38473`。图标使用系统默认应用图标，未附带自定义 .ico。
- 左键或右键图标打开菜单：首项是只读运行状态，其后是「打开数据目录」（用资源管理器打开本机数据目录）和「退出」。
- 「退出」与关闭窗口走同一条退出路径：先请求停止 HTTP，等待监听套接字释放，再删除托盘图标并以状态码 0 结束进程；退出后端口不再接受连接。
- 关闭控制台窗口或 Ctrl+C 时进程同样结束、端口随之关闭。
- 托盘初始化失败（例如没有可用通知区域）时，标准错误输出一行不带路径的提示，助手继续在后台服务，需关闭启动它的终端来停止。
- 不写注册表自启动项；「启动」目录、任务计划程序和服务列表都不会被修改。

配置保存在当前用户 `%LOCALAPPDATA%\MyFigmaAssets`（跨助手重启保留，同机不同 Figma 文件共用）：

- `token`：首次启动从操作系统随机源生成的 256 位 bearer 令牌。
- `projects.json`：项目登记表；本机不同 Figma 文件复用。
- `projects.tmp`：登记保存时先独占创建、同步，再替换正式文件；写失败不更新内存登记表。

拆图只在进程内存中处理，本版本不落盘缓存或凭据日志。`--data-dir <directory>`、`--port <port>` 供隔离测试/显式本机配置使用（`0` 表示随机端口）；生产插件 manifest 默认仅放行 38473。不要选择共享目录。Windows 依赖当前用户 Local AppData 的默认 ACL；不会主动扩宽 ACL。Unix 测试环境目录/新文件权限分别是 0700/0600，但不承诺非 Windows 产品支持。

标准输出只有机器可读事件：`LISTEN <port>`、托盘模式的 `TRAY ready` 和退出时的 `STOP`；标准错误只给不含路径、令牌或项目路径的固定中文提示。日志不记录登记路径、令牌或数据目录。

### 仅测试使用

- `--no-tray`：不创建托盘，直接等待退出请求（CI/无头环境）。生产默认仍是托盘。
- `--test-exit-after-ms <ms>`：延迟投递与托盘「退出」菜单相同的命令；托盘模式经真实窗口消息处理，无托盘模式直接请求退出。用于自动验证退出会关闭端口并以状态码 0 结束。

## 手动配对

1. 启动助手，确认托盘图标出现且菜单首项显示「资源助手运行中」。
2. 在本机用文本查看器打开 `%LOCALAPPDATA%\MyFigmaAssets\token`，将内容粘贴到插件的密码输入框。不要把它贴到 Issue、聊天、Figma 图层或日志。
3. 点击「连接助手」。令牌只留在插件 UI 运行时内存，成功后清空输入框；不使用 Figma 文档、clientStorage、浏览器存储或 URL 保存凭据。关掉插件后重新配对。
4. 令牌泄漏时停止助手，删除本机 `token` 后重新启动、配对；不必删除项目登记。

身份校验是**令牌持有者认证**，不是 Figma 账号认证，也不能防御已控制当前 OS 用户的程序。相同用户的本地恶意进程可读取令牌或冒充监听端口；不承诺抵抗本机账号失陷。

## HTTP v1 协议与安全决策

所有业务请求均需 `Authorization: Bearer <token>`。写请求还需精确的 `Content-Type: application/json`；请求体上限 64 KiB。无 Cookie、无远端网络、无文件上传/任意文件下载/命令执行接口。

| 方法 / 路径 | 输入 | 成功输出（均含 `schemaVersion: 1`） |
| --- | --- | --- |
| GET `/v1/health` | 无 | `status: "ready"` |
| GET `/v1/projects` | 无 | `projects: Project[]` |
| PUT `/v1/projects` | `{id,name,path,maintained}` | 全部 `projects`；编号相同则编辑 |
| DELETE `/v1/projects/<id>` | 无 | 全部 `projects`；只删登记，不删资源 |
| POST `/v1/scan` | `{projectId}` | `project:{id,name}, resources, summary, errors, complete` |

`Project.id` 为 1–64 个 ASCII 字母、数字、下划线或连字符，是稳定项目身份。编辑编号意味着新项目；UI 编辑时锁定编号。名称非空且最多 200 UTF-8 字节。路径仅在助手登记与受认证 UI 中存在，不进入扫描响应的项目字段。

- 监听 IPv4 loopback；同时检查远端为 loopback、Host 精确为 `localhost:<实际端口>` 或 `127.0.0.1:<实际端口>`，拒绝 DNS rebinding 域名。
- Origin 仅允许 `https://www.figma.com` 和 `null`；允许无 Origin 的本机 CLI。Figma 沙箱 UI 使用 opaque origin，故必须支持 `null`，但它**不是身份凭据**。恶意网页也可拥有 opaque origin，仍必须提供不可猜测的 bearer。
- OPTIONS 预检不要求 bearer，不返回业务数据；仅对上述 Origin 返回精确 CORS（绝不 `*`），仅放行 Authorization / Content-Type、固定方法及本机网络预检；不返回 Allow-Credentials。
- 健康和读取接口同样鉴权；错误码为 401 鉴权失败、403 来源/Host 拒绝、413 请求过大、415 类型错误、400 业务错误。错误消息不包含操作系统错误详情或绝对路径。
- 登记目录规范化；扫描 JSON 和 PNG 均解析真实路径，拒绝逃出登记目录的符号链接。图集图片只能是同目录的 PNG 文件名，不接受绝对路径、父目录、URL 或外部公共资源。
- 扫描不修改源项目。单请求串行执行，项目编辑与扫描不会并发改变助手登记。

## 支持的最小图集格式

把**直接包含图集 JSON 与 PNG 的目录**登记为资源目录（例如游戏的 `res/imageset`，不是要求登记整个游戏根）。可直接登记本目录下的 `examples` 来演示：`tiny.png` 是 2×1 红/绿图集，`red` 恢复为 2×2，右下角为红色，其余透明；`green` 为 1×1 绿色。

```json
{
  "frames": {
    "red": {
      "frame": {"x": 0, "y": 0, "w": 1, "h": 1},
      "sourceSize": {"w": 2, "h": 2},
      "spriteSourceSize": {"x": 1, "y": 1},
      "trimmed": true,
      "rotated": false
    }
  },
  "meta": {"image": "tiny.png"}
}
```

对象式 `frames`，整数像素坐标；`sourceSize` 和非负偏移恢复透明留白；也支持 `offset:{x,y}`（有 `spriteSourceSize` 时优先使用它）。无裁切元数据的普通帧默认原大小、零偏移；显式 `trimmed:true` 必须同时提供原尺寸与偏移。PNG 不指定时使用 JSON 同名 PNG。

限制：直接目录最多 16 个 JSON、每图集和每次最多 64 张散图、图集最大 2048×2048、恢复散图最大 1024×1024、单次恢复像素最多 8 Mi；JSON 最大 1 MiB、PNG 最大 16 MiB。输出是**各散图独立 PNG 的 base64**，不是整张图集。

旋转、越界、损坏文件等明确报告并跳过；`complete:false` 表示有错误或未扫描子目录；摘要给出散图/异常/未扫描子目录数。允许导入已成功拆解的散图，但不表示完整扫描。没有删除推断或增量逻辑。未知结构不承诺兼容。子目录不递归、不扫描独立散图文件，不做九宫格、布局引用统计、完整分类或托盘（留给 #3–12）。

## 来源身份

每张散图包含：

- `source.schemaVersion:1`、`kind:"atlas"`、`projectId`；
- `relativePath`（本期 JSON 文件名）、`frameName`（原名）；
- `identity = JSON.stringify([projectId,"atlas",relativePath,frameName])`，分类和像素不影响身份；
- `engineReference`、`sourceSize`、`crop`、`offset`。

Figma 插件只按白名单保存这些字段，不保存绝对路径、令牌或未知响应字段。这个 v1 格式不是与后续共享核心预先绑定的正式跨插件契约；集成时应保持版本检查，不把它擅自扩展为九宫格 schema。

## 验证

```powershell
npm ci
cargo check --locked
cargo fmt --check
cargo clippy --all-targets --locked -- -D warnings
cargo test --locked
npm test
```

`npm test` 的 pretest 自动构建 Rust，然后运行真实子进程的集成测试（不是 Rust 单元 mock）：7 个 HTTP 协议／像素用例，加上 4 个产物与托盘用例，共 11 个。`pngjs` 仅用于测试读取恢复 PNG，对照固定样本的 RGBA 字面值；Rust 实际解码、拆图、编码由 `image` 执行。Rust 原生 `cargo test` 当前只有构建检查，没有额外单元用例。

产物与托盘用例走进程边界（`tests/tray.test.mjs`）：

- 把 `target/debug` 的 exe 复制到临时目录，用该副本、以临时目录为工作目录启动，验证健康检查、登记、扫描、正常退出码 0、退出后端口拒绝连接，证明不依赖开发服务器、ui-studio 或开发者本机路径。
- 默认启动（不加 `--no-tray`）必须打印 `TRAY ready`（`Shell_NotifyIconW` 返回成功）；随后用 `--test-exit-after-ms` 把与托盘「退出」菜单相同的 `WM_COMMAND` 投递给真实托盘窗口，验证同一退出路径关闭端口并结束进程。
- 未配对、登记、退出后再以托盘模式重启，断言令牌与登记（含两个登记与扫描结果）保持不变，扫描仍可用。
- 断言标准输出／错误不出现数据目录、登记路径、令牌和仓库绝对路径。

记录过的红→绿（#11）：新增 `--no-tray` 前，新用例因未知参数直接退出（`助手启动失败`）而全红；实现无托盘等待与退出请求后转绿。插件侧新增「断连提示须指向托盘、重启后可继续扫描导入」用例，先因提示缺少托盘信息而红，更新提示文案后绿。

### 人工验收（托盘点击无法自动驱动）

自动化只证明托盘图标创建成功、退出命令路径有效，不能替代真实鼠标点击。人工步骤：

1. `cargo build --release --locked` 后双击 `target\release\figma-assets-helper.exe`，确认通知区域出现图标、悬停显示「资源助手运行中 · 端口 38473」。
2. 右键图标：确认首项为只读状态，点击「打开数据目录」应打开 `%LOCALAPPDATA%\MyFigmaAssets`。
3. 配对插件、登记项目、扫描并导入；关闭插件后重新打开应自动连接。
4. 在托盘菜单点击「退出」：图标消失、进程从任务管理器消失，`curl http://localhost:38473/v1/health` 连接失败。
5. 重新启动助手：项目登记仍在，无需重新配对即可扫描；此时插件断连后再连接也能继续扫描和导入。

未验证项：真实鼠标点击托盘图标／菜单、「打开数据目录」拉起资源管理器、以及无自定义图标的品牌观感；这些只有人工验收，未计入自动测试结论。

依赖：`tiny_http`（HTTP）、`serde/serde_json`（协议与登记）、`rand`（随机令牌）、`image` 仅启用 PNG、`base64`、`windows-sys`（仅 Windows 目标：托盘图标、弹出菜单、消息循环、打开目录）；锁文件固定版本。没有运行时 Node 依赖，也没有系统服务／自启动依赖。尚未执行 RustSec 审计，不把 cargo check 当作依赖安全审计。
