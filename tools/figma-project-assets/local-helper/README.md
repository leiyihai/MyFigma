# Rust 本地资源助手

独立的 Windows 程序：从构建产物启动、驻留通知区域（托盘），无需 ui-studio 或开发服务器。不安装系统服务、计划任务或开机启动项，也不改系统级环境变量。支持项目私有资源的递归扫描、独立图片与完整来源记录。

## 构建与启动

要求 Rust stable（本次使用 1.95）、Windows。此目录独立维护 `Cargo.toml` / `Cargo.lock`。

```powershell
cargo build --release --locked
.\target\release\resource-helper.exe
```

启动后同时出现控制台窗口和托盘图标，两者都能停止进程。默认只监听 `127.0.0.1:38473`，Figma 插件使用 `http://localhost:38473` 访问，以兼容其 manifest 本地开发域名校验。端口被占用时不要向未知进程输入令牌。

## 托盘与退出

- 托盘提示文字：`资源助手运行中 · 端口 38473`。图标使用系统默认应用图标，未附带自定义 .ico。
- 左键或右键图标打开菜单：首项是只读运行状态，其后是「打开数据目录」（用资源管理器打开本机数据目录）、「显示配对令牌」（仅在控制台输出，便利用户首次/忘记后重新配对）和「退出」。
- 也可显式运行 `resource-helper.exe --show-token` 打印当前令牌；正常启动日志不包含令牌。
- 「退出」与关闭窗口走同一条退出路径：先请求停止 HTTP，等待监听套接字释放，再删除托盘图标并以状态码 0 结束进程；退出后端口不再接受连接。
- 关闭控制台窗口或 Ctrl+C 时进程同样结束、端口随之关闭。
- 托盘初始化失败（例如没有可用通知区域）时，标准错误输出一行不带路径的提示，助手继续在后台服务，需关闭启动它的终端来停止。
- 不写注册表自启动项；「启动」目录、任务计划程序和服务列表都不会被修改。

配置保存在当前用户 `%LOCALAPPDATA%\MyFigmaAssets`（跨助手重启保留，同机不同 Figma 文件共用）：

- `token`：首次启动从操作系统随机源生成的 256 位 bearer 令牌。
- `projects.json`：项目登记表；本机不同 Figma 文件复用。
- `projects.tmp`：登记保存时先独占创建、同步，再替换正式文件；写失败不更新内存登记表。
- `scans/<projectId>.json`：最近一次扫描响应及布局统计的本地副本，可能包含错误或不完整标志，不能把缓存存在视为扫描完整。含恢复图片 base64、来源身份、布局节点引用/边距频次；下次扫描读取已选边距处理并列。增量判定由 Figma 插件读取组件来源及同步状态完成：新组件使用 `atlas.source.sync`，旧 `atlas.sync.v1` 仅兼容读取。缓存体积可能较大，删除登记不会自动清理。
- `samples/<projectId>.json`：该项目最近一次提交的人工训练样本，只含「来源身份 + 类别」；重复提交覆盖旧文件。文件名使用已校验的项目编号，不含图片、令牌或本机路径。

扫描结果先落盘到本机 `scans` 目录再返回，Figma 文档只保存白名单来源字段；不写凭据日志。`--data-dir <directory>`、`--port <port>` 供隔离测试/显式本机配置使用（`0` 表示随机端口）；生产插件 manifest 默认仅放行 38473。不要选择共享目录。Windows 依赖当前用户 Local AppData 的默认 ACL；不会主动扩宽 ACL。Unix 测试环境目录/新文件权限分别是 0700/0600，但不承诺非 Windows 产品支持。

标准输出只有机器可读事件：`LISTEN <port>`、托盘模式的 `TRAY ready`、退出时的 `STOP`，以及用户显式请求时的 `PAIRING TOKEN: <token>`；标准错误只给不含路径、令牌或项目路径的固定中文提示。正常启动日志不记录登记路径、令牌或数据目录。

### 仅测试使用

- `--no-tray`：不创建托盘，直接等待退出请求（CI/无头环境）。生产默认仍是托盘。
- `--test-exit-after-ms <ms>`：延迟投递与托盘「退出」菜单相同的命令；托盘模式经真实窗口消息处理，无托盘模式直接请求退出。用于自动验证退出会关闭端口并以状态码 0 结束。

## 手动配对

1. 启动助手，确认托盘图标出现且菜单首项显示「资源助手运行中」。
2. 在本机用文本查看器打开 `%LOCALAPPDATA%\MyFigmaAssets\token`，将内容粘贴到插件的密码输入框。不要把它贴到 Issue、聊天、Figma 图层或日志。
3. 点击「连接资源助手」。令牌只在插件 UI 与主线程之间传递；连接成功后保存到本机 `figma.clientStorage`，下次打开自动连接，点击「忘记配对」删除。不写入 Figma 文档或上传远端；首次仍需手动复制令牌。
4. 忘记或更换令牌时，在托盘菜单选择「显示配对令牌」，或在终端运行 `--show-token`；不要把令牌贴到 Issue、聊天或日志。
5. 令牌泄漏时停止助手，删除本机 `token` 后重新启动、配对；不必删除项目登记。旧令牌会失效，插件下次连接会提示重新配对。

身份校验是**令牌持有者认证**，不是 Figma 账号认证，也不能防御已控制当前 OS 用户的程序。相同用户的本地恶意进程可读取令牌或冒充监听端口；不承诺抵抗本机账号失陷。

## HTTP v1 协议与安全决策

所有业务请求均需 `Authorization: Bearer <token>`。写请求还需精确的 `Content-Type: application/json`；请求体上限一般 64 KiB，只有训练样本接口为 4 MiB（随资源数增长）。无 Cookie、无远端网络、无文件上传/任意文件下载/命令执行接口。

| 方法 / 路径 | 输入 | 成功输出（各端点版本见说明） |
| --- | --- | --- |
| GET `/v1/health` | 无 | `status: "ready"` |
| GET `/v1/projects` | 无 | `projects: Project[]` |
| PUT `/v1/projects` | `{id,name,path,maintained}` | 全部 `projects`；编号相同则编辑 |
| DELETE `/v1/projects/<id>` | 无 | 全部 `projects`；只删登记，不删资源 |
| POST `/v1/scan` | `{projectId}` | `schemaVersion: 3`、`project:{id,name}`、`resources`、`errors`、`warnings`、`summary`、`truncated`、`complete` |
| POST `/v1/samples` | `{projectId,samples:[{identity,category}]}` | `schemaVersion: 1`、`count`（保存条数）；覆盖 `samples/<projectId>.json` |

`Project.id` 为 1–64 个 ASCII 字母、数字、下划线或连字符，是稳定项目身份。编辑编号意味着新项目；UI 编辑时锁定编号。名称非空且最多 200 UTF-8 字节。路径仅在助手登记与受认证 UI 中存在，不进入扫描响应的项目字段。

- 监听 IPv4 loopback；同时检查远端为 loopback、Host 精确为 `localhost:<实际端口>` 或 `127.0.0.1:<实际端口>`，拒绝 DNS rebinding 域名。
- Origin 仅允许 `https://www.figma.com` 和 `null`；允许无 Origin 的本机 CLI。Figma 沙箱 UI 使用 opaque origin，故必须支持 `null`，但它**不是身份凭据**。恶意网页也可拥有 opaque origin，仍必须提供不可猜测的 bearer。
- OPTIONS 预检不要求 bearer，不返回业务数据；仅对上述 Origin 返回精确 CORS（绝不 `*`），仅放行 Authorization / Content-Type、固定方法及本机网络预检；不返回 Allow-Credentials。
- 健康和读取接口同样鉴权；错误码为 401 鉴权失败、403 来源/Host 拒绝、413 请求过大、415 类型错误、400 业务错误。错误消息不包含操作系统错误详情或绝对路径。
- 登记目录规范化；扫描 JSON 和 PNG 均解析真实路径，拒绝逃出登记目录的符号链接。图集图片只能是同目录的 PNG 文件名，不接受绝对路径、父目录、URL 或外部公共资源。
- 扫描不修改源项目。单请求串行执行，项目编辑与扫描不会并发改变助手登记。

### 训练样本（#18）

`POST /v1/samples` 保存当前资源页中带人工类别覆盖的主组件标签。请求体只有项目编号与数组：

```json
{"projectId":"g2","samples":[{"identity":"[\"g2\",\"atlas\",\"tiny.json\",\"red\"]","category":"按钮"}]}
```

助手严格校验（错误统一为 400，消息不含绝对路径）：项目必须已登记；`samples` 为 1–20 000 条；只允许 `identity` 与 `category` 两个字段（`deny_unknown_fields`，图片等未知字段直接拒绝）；`identity` 必须是与该项目匹配的 `atlas`（四段：项目、`atlas`、相对路径、散图原名）或 `standalone`（三段：项目、`standalone`、相对路径）身份且每段非空、不重复；类别去空白后非空、不超过 200 字节、不含 `/`、`\` 或控制字符。成功返回 `{"schemaVersion":1,"count":N}`。

保存使用独占创建临时文件 + 同步 + `rename` 覆盖 `samples/<projectId>.json`，内容为 `{"schemaVersion":1,"projectId":"<id>","samples":[...]}`；重复提交按最新人工标签整体替换，不追加。该路由单独放宽到 4 MiB，其余请求仍为 64 KiB；超限返回 413。响应只有条数，不返回本机数据目录、项目资源路径或图片。

## 支持的最小图集格式

登记范围保持兼容：登记游戏根时，若存在 `<根>/res/imageset` 就从该私有图集目录递归扫描；否则把登记目录本身作为扫描范围（例如直接登记 `res/imageset`，或用于演示的 `examples`）。只扫描登记范围内部，不向项目外补找公共图集。可由 `examples` 演示：`tiny.png` 是 2×1 红/绿图集，`red` 恢复为 2×2，右下角为红色，其余透明；`green` 为 1×1 绿色。

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

扫描递归遍历全部子目录并导入全部帧，不按布局引用过滤。扫描范围内未被任何图集作为源图引用的 PNG 视为独立图片：`kind:"standalone"`、`crop` 为整图、`offset` 为零，`relativePath` 含扩展名。由图集 `meta.image` 指向的 PNG 不会被当成独立图片；JSON 解析失败或不是对象式 frames 时，其同名 PNG 也按图集源图排除，并报告该 JSON 错误。有效图集若 `meta.image` 指向别的文件，同目录同名 PNG 仍可作为独立图片导入。

规模上限仅用于防止失控：单次最多 20 000 项资源、恢复像素总量 10 亿、扫描条目 200 000、单图 4096×4096；JSON 最大 16 MiB、PNG 最大 64 MiB。触达上限时返回已恢复内容并给出明确错误、`truncated:true`、`complete:false`，不静默截断。输出是**各散图独立 PNG 的 base64**，不是整张图集。

旋转帧、越界帧、缺图、坏 JSON 等明确报告问题位置（图集相对路径与帧名）并跳过该帧或该图集，不生成错误图片；`complete:false` 表示存在错误或扫描未完成，`truncated:true` 表示触达规模上限；摘要给出图集数/图集帧数/散图数/独立图片数/异常数/条目数。允许导入已成功拆解的散图，但不表示完整扫描；失败不会被当作源资源移除。助手不执行删除推断、Figma 增量写入、用途分类或对照页操作，这些由资源导入器负责；助手提供扫描与本机样本保存。未知结构不承诺兼容。

## 布局九宫格统计

登记游戏根且存在 `<根>/res/layout` 时递归读取布局 JSON（最多 32 层；坏文件只警告并跳过）。节点 `Property` 中 `ImageName`、`NormalImage`、`PushedImage`、`LayoutBackImage`、`Progress*Image` 等图片字段按 `set:<图集文件名> image:<散图名>` 或 `image:<项目内相对路径>` 识别；`StretchType: NineGrid` 的 `StretchOffset` 按左、上、右、下解释，四舍五入为整数边距。

同一散图保留全部合法参数及使用次数，扫描响应只发送最高频的一套参数，不创建变体。并列时若上次选值仍在最高频候选中就保留，否则按左、上、右、下的字典序稳定选择；坏 JSON、负边距、四边之和超过图片尺寸会给出警告并排除该参数。布局引用未命中项目内图集/散图时按公共资源汇总忽略，不向项目外补找。返回值只带选择结果、汇总数和警告；`scans/<id>.json` 保存每个布局文件、节点、引用、边距、命中原因及全部参数频次。

## 来源身份

每张散图包含：

- `source.schemaVersion:1`、`kind:"atlas"`、`projectId`；
- `relativePath`（图集 JSON 相对扫描范围的嵌套路径，`/` 分隔）、`frameName`（原名）；
- `identity = JSON.stringify([projectId,"atlas",relativePath,frameName])`，分类和像素不影响身份；
- `engineReference`（`set:<relativePath> image:<frameName>`）、`sourceSize`、`crop`、`offset`。

独立图片的来源记录字段相同，差异为：`kind:"standalone"`、`relativePath` 为项目内相对路径含扩展名、`frameName` 为去扩展名的文件名、`identity = JSON.stringify([projectId,"standalone",relativePath])`、`engineReference = image:<relativePath>`、`crop` 为整图、`offset` 为零。

Figma 插件只按白名单保存这些字段，不保存绝对路径、令牌或未知响应字段。来源记录与九宫格参数是不同契约：前者由资源导入器维护，后者由共用核心通过 shared plugin data 保存；保持各自版本检查，不把来源 schema 当作九宫格 schema。

## 验证

```powershell
npm ci
cargo check --locked
cargo fmt --check
cargo clippy --all-targets --locked -- -D warnings
cargo test --locked
npm test
```

本节描述已有验证方式和历史结果，本轮文档整理未重新运行功能测试。`npm test` 的 pretest 自动构建 Rust，然后运行真实子进程的集成测试（不是 Rust 单元 mock）：HTTP 协议／像素、训练样本、递归扫描／独立图片、布局九宫格统计，以及产物与托盘用例。`pngjs` 仅用于测试读取恢复 PNG，对照固定样本的 RGBA 字面值；Rust 实际解码、拆图、编码由 `image` 执行。Rust 原生 `cargo test` 当前只有构建检查，没有额外单元用例。

公开边界测试覆盖鉴权、Host/CORS/预检、请求限制、项目增删改和重启持久化、拆图像素与身份、非法/外部资源及缺失恢复信息。训练样本用例覆盖未配对/可疑 Origin、缺项目、非法身份形状与重复身份、空/非法类别、未知字段含图片、覆盖旧样本、`samples/<id>.json` 可读回且不泄露本机路径，以及 20 000 条约 1.2 MB 的放宽上限与超过 4 MiB 的 413（其他写接口仍按 64 KiB 拒绝）。新增 #3 回归（`tests/scan.test.mjs`，共 11 例）覆盖：游戏根/直接 imageset 两种登记、嵌套递归、跨图集同名、独立图片与图集排除、透明留白与偏移像素、坏 JSON/缺图/旋转/越界定位、超过旧上限的整本导入与触达上限的显式截断报告、助手侧扫描缓存不含绝对路径，以及本机样本包 g1008 子集（9 图集 263 帧 + 1 独立图片，逐像素对照原图集裁切）。

产物与托盘用例走进程边界（`tests/tray.test.mjs`）：

- 把 `target/debug` 的 exe 复制到临时目录，用该副本、以临时目录为工作目录启动，验证健康检查、登记、扫描、正常退出码 0、退出后端口拒绝连接，证明不依赖开发服务器、ui-studio 或开发者本机路径。
- 默认启动（不加 `--no-tray`）必须打印 `TRAY ready`（`Shell_NotifyIconW` 返回成功）；随后用 `--test-exit-after-ms` 把与托盘「退出」菜单相同的 `WM_COMMAND` 投递给真实托盘窗口，验证同一退出路径关闭端口并结束进程。
- 未配对、登记、退出后再以托盘模式重启，断言令牌与登记（含两个登记与扫描结果）保持不变，扫描仍可用。
- 断言标准输出／错误不出现数据目录、登记路径、令牌和仓库绝对路径。

记录过的红→绿（#11）：新增 `--no-tray` 前，新用例因未知参数直接退出（`助手启动失败`）而全红；实现无托盘等待与退出请求后转绿。插件侧新增「断连提示须指向托盘、重启后可继续扫描导入」用例，先因提示缺少托盘信息而红，更新提示文案后绿。

### 人工验收（托盘点击无法自动驱动）

自动化只证明托盘图标创建成功、退出命令路径有效，不能替代真实鼠标点击。人工步骤：

1. `cargo build --release --locked` 后双击 `target\release\resource-helper.exe`，确认通知区域出现图标、悬停显示「资源助手运行中 · 端口 38473」。
2. 右键图标：确认首项为只读状态，点击「打开数据目录」应打开 `%LOCALAPPDATA%\MyFigmaAssets`。
3. 配对插件、登记项目、扫描并导入；关闭插件后重新打开应自动连接。
4. 在托盘菜单点击「退出」：图标消失、进程从任务管理器消失，`curl http://localhost:38473/v1/health` 连接失败。
5. 重新启动助手：项目登记仍在，无需重新配对即可扫描；此时插件断连后再连接也能继续扫描和导入。

未验证项：真实鼠标点击托盘图标／菜单、「打开数据目录」拉起资源管理器、以及无自定义图标的品牌观感；这些只有人工验收，未计入自动测试结论。

依赖：`tiny_http`（HTTP）、`serde/serde_json`（协议与登记）、`rand`（随机令牌）、`image` 仅启用 PNG、`base64`、`windows-sys`（仅 Windows 目标：托盘图标、弹出菜单、消息循环、打开目录）；锁文件固定版本。没有运行时 Node 依赖，也没有系统服务／自启动依赖。尚未执行 RustSec 审计，不把 cargo check 当作依赖安全审计。
