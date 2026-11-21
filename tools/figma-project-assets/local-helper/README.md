# Rust 本地资源助手（#3）

独立的 Windows 控制台程序；无需 ui-studio，不安装服务、托盘或开机启动项。本批把 #2 的直接目录扫描扩展为项目私有资源的递归扫描与完整导入。

## 构建与启动

要求 Rust stable（本次使用 1.95）、Windows。此目录独立维护 `Cargo.toml` / `Cargo.lock`。

```powershell
cargo build --release --locked
.\target\release\figma-assets-helper.exe
```

默认只监听 `127.0.0.1:38473`，Figma 插件使用 `http://localhost:38473` 访问，以兼容其 manifest 本地开发域名校验。标准输出仅含 `LISTEN <port>`，错误不含路径或凭据。关闭终端或 Ctrl+C 停止。端口被占用时不要向未知进程输入令牌。

配置保存在当前用户 `%LOCALAPPDATA%\MyFigmaAssets`：

- `token`：首次启动从操作系统随机源生成的 256 位 bearer 令牌。
- `projects.json`：项目登记表；本机不同 Figma 文件复用。
- `projects.tmp`：登记保存时先独占创建、同步，再替换正式文件；写失败不更新内存登记表。
- `scans/<projectId>.json`：最近一次完整扫描结果（含恢复的散图与来源身份），供后续增量导入使用；内容只有项目编号/名称与项目内相对路径。

扫描结果先落盘到本机 `scans` 目录再返回，Figma 文档只保存白名单来源字段；不写凭据日志。`--data-dir <directory>`、`--port <port>` 供隔离测试/显式本机配置使用（`0` 表示随机端口）；生产插件 manifest 默认仅放行 38473。不要选择共享目录。Windows 依赖当前用户 Local AppData 的默认 ACL；不会主动扩宽 ACL。Unix 测试环境目录/新文件权限分别是 0700/0600，但不承诺非 Windows 产品支持。

## 手动配对

1. 启动助手。
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
| POST `/v1/scan` | `{projectId}` | `schemaVersion: 2`、`project:{id,name}`、`resources`、`errors`、`summary`、`truncated`、`complete` |

`Project.id` 为 1–64 个 ASCII 字母、数字、下划线或连字符，是稳定项目身份。编辑编号意味着新项目；UI 编辑时锁定编号。名称非空且最多 200 UTF-8 字节。路径仅在助手登记与受认证 UI 中存在，不进入扫描响应的项目字段。

- 监听 IPv4 loopback；同时检查远端为 loopback、Host 精确为 `localhost:<实际端口>` 或 `127.0.0.1:<实际端口>`，拒绝 DNS rebinding 域名。
- Origin 仅允许 `https://www.figma.com` 和 `null`；允许无 Origin 的本机 CLI。Figma 沙箱 UI 使用 opaque origin，故必须支持 `null`，但它**不是身份凭据**。恶意网页也可拥有 opaque origin，仍必须提供不可猜测的 bearer。
- OPTIONS 预检不要求 bearer，不返回业务数据；仅对上述 Origin 返回精确 CORS（绝不 `*`），仅放行 Authorization / Content-Type、固定方法及本机网络预检；不返回 Allow-Credentials。
- 健康和读取接口同样鉴权；错误码为 401 鉴权失败、403 来源/Host 拒绝、413 请求过大、415 类型错误、400 业务错误。错误消息不包含操作系统错误详情或绝对路径。
- 登记目录规范化；扫描 JSON 和 PNG 均解析真实路径，拒绝逃出登记目录的符号链接。图集图片只能是同目录的 PNG 文件名，不接受绝对路径、父目录、URL 或外部公共资源。
- 扫描不修改源项目。单请求串行执行，项目编辑与扫描不会并发改变助手登记。

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

扫描递归遍历全部子目录并导入全部帧，不按布局引用过滤。扫描范围内未被任何图集作为源图引用的 PNG 视为独立图片：`kind:"standalone"`、`crop` 为整图、`offset` 为零，`relativePath` 含扩展名。与 JSON 同名或由 `meta.image` 指向的图集 PNG 不会被当成独立图片；即使该 JSON 解析失败也按同名规则排除，避免把整张图集二次导入。

规模上限仅用于防止失控：单次最多 20 000 项资源、恢复像素总量 10 亿、扫描条目 200 000、单图 4096×4096；JSON 最大 16 MiB、PNG 最大 64 MiB。触达上限时返回已恢复内容并给出明确错误、`truncated:true`、`complete:false`，不静默截断。输出是**各散图独立 PNG 的 base64**，不是整张图集。

旋转帧、越界帧、缺图、坏 JSON 等明确报告问题位置（图集相对路径与帧名）并跳过该帧或该图集，不生成错误图片；`complete:false` 表示存在错误或扫描未完成，`truncated:true` 表示触达规模上限；摘要给出图集数/图集帧数/散图数/独立图片数/异常数/条目数。允许导入已成功拆解的散图，但不表示完整扫描；失败不会被当作源资源移除。没有删除推断或增量逻辑。未知结构不承诺兼容。不做九宫格统计、分类、对照页或托盘（留给 #4–12）。

## 来源身份

每张散图包含：

- `source.schemaVersion:1`、`kind:"atlas"`、`projectId`；
- `relativePath`（图集 JSON 相对扫描范围的嵌套路径，`/` 分隔）、`frameName`（原名）；
- `identity = JSON.stringify([projectId,"atlas",relativePath,frameName])`，分类和像素不影响身份；
- `engineReference`（`set:<relativePath> image:<frameName>`）、`sourceSize`、`crop`、`offset`。

独立图片的来源记录字段相同，差异为：`kind:"standalone"`、`relativePath` 为项目内相对路径含扩展名、`frameName` 为去扩展名的文件名、`identity = JSON.stringify([projectId,"standalone",relativePath])`、`engineReference = image:<relativePath>`、`crop` 为整图、`offset` 为零。

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

`npm test` 的 pretest 自动构建 Rust，然后运行真实子进程的 HTTP 集成测试（不是 Rust 单元 mock）。`pngjs` 仅用于测试读取恢复 PNG，对照固定样本的 RGBA 字面值；Rust 实际解码、拆图、编码由 `image` 执行。Rust 原生 `cargo test` 当前只有构建检查，没有额外单元用例。

公开边界测试覆盖鉴权、Host/CORS/预检、请求限制、项目增删改和重启持久化、拆图像素与身份、非法/外部资源及缺失恢复信息。新增 #3 回归（`tests/scan.test.mjs`，共 9 例）覆盖：游戏根/直接 imageset 两种登记、嵌套递归、跨图集同名、独立图片与图集排除、透明留白与偏移像素、坏 JSON/缺图/旋转/越界定位、超过旧上限的整本导入与触达上限的显式截断报告、助手侧扫描缓存不含绝对路径，以及本机样本包 g1008 子集（9 图集 263 帧 + 1 独立图片，逐像素对照原图集裁切）。记录过的红→绿包括：初始进程退出导致登记用例失败；未实现 `/v1/scan` 返回 400 而非 200；`trimmed:true` 缺元数据仍错误导出；#3 首次运行时嵌套图集返回 1 个资源而非 2 个、缺少 `summary.scanRoot` 与 `summary.standalone`、扫描缓存文件不存在，修复后通过。共 16 个 HTTP/扫描测试通过。

依赖：`tiny_http`（HTTP）、`serde/serde_json`（协议与登记）、`rand`（随机令牌）、`image` 仅启用 PNG、`base64`；锁文件固定版本。没有运行时 Node 依赖。尚未执行 RustSec 审计，不把 cargo check 当作依赖安全审计。
