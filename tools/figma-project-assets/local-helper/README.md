# Rust 本地资源助手（#2）

独立的 Windows 控制台程序；无需 ui-studio，不安装服务、托盘或开机启动项。

## 构建与启动

要求 Rust stable（本次使用 1.95）、Windows。此目录独立维护 `Cargo.toml` / `Cargo.lock`。

```powershell
cargo build --release --locked
.\target\release\figma-assets-helper.exe
```

默认只监听 `127.0.0.1:38473`。标准输出仅含 `LISTEN <port>`，错误不含路径或凭据。关闭终端或 Ctrl+C 停止。端口被占用时不要向未知进程输入令牌。

配置保存在当前用户 `%LOCALAPPDATA%\MyFigmaAssets`：

- `token`：首次启动从操作系统随机源生成的 256 位 bearer 令牌。
- `projects.json`：项目登记表；本机不同 Figma 文件复用。
- `projects.tmp`：登记保存时先独占创建、同步，再替换正式文件；写失败不更新内存登记表。

拆图只在进程内存中处理，本版本不落盘缓存或凭据日志。`--data-dir <directory>`、`--port <port>` 供隔离测试/显式本机配置使用（`0` 表示随机端口）；生产插件 manifest 默认仅放行 38473。不要选择共享目录。Windows 依赖当前用户 Local AppData 的默认 ACL；不会主动扩宽 ACL。Unix 测试环境目录/新文件权限分别是 0700/0600，但不承诺非 Windows 产品支持。

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
| POST `/v1/scan` | `{projectId}` | `project:{id,name}, resources, summary, errors, complete` |

`Project.id` 为 1–64 个 ASCII 字母、数字、下划线或连字符，是稳定项目身份。编辑编号意味着新项目；UI 编辑时锁定编号。名称非空且最多 200 UTF-8 字节。路径仅在助手登记与受认证 UI 中存在，不进入扫描响应的项目字段。

- 监听 IPv4 loopback；同时检查远端为 loopback、Host 精确为 `127.0.0.1:<实际端口>`，拒绝 DNS rebinding 域名。
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

`npm test` 的 pretest 自动构建 Rust，然后运行真实子进程的 HTTP 集成测试（不是 Rust 单元 mock）。`pngjs` 仅用于测试读取恢复 PNG，对照固定样本的 RGBA 字面值；Rust 实际解码、拆图、编码由 `image` 执行。Rust 原生 `cargo test` 当前只有构建检查，没有额外单元用例。

公开边界测试覆盖鉴权、Host/CORS/预检、请求限制、项目增删改和重启持久化、拆图像素与身份、非法/外部资源及缺失恢复信息。记录过的红→绿包括：初始进程退出导致登记用例失败；未实现 `/v1/scan` 返回 400 而非 200；`trimmed:true` 缺元数据仍错误导出，新增回归先失败（多出 green），修复后 6/6 通过。

依赖：`tiny_http`（HTTP）、`serde/serde_json`（协议与登记）、`rand`（随机令牌）、`image` 仅启用 PNG、`base64`；锁文件固定版本。没有运行时 Node 依赖。尚未执行 RustSec 审计，不把 cargo check 当作依赖安全审计。
