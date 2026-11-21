# 项目图集导入工具

本批实现 GitHub [#1](https://github.com/leiyihai/MyFigma/issues/1) 和 [#2](https://github.com/leiyihai/MyFigma/issues/2) 的首个可测试版本；尚未完成真实 Figma 验收，不是完整资源管理版本。

## 组成与启动

- [Rust 本地助手](local-helper/README.md)：登记游戏并拆分简单图集。独立运行，不依赖 ui-studio。
- [图集导入插件](atlas-import-plugin/README.md)：配对助手、维护项目登记、扫描并将散图导入空白页。
- [独立九宫格插件](nine-slice-plugin/README.md)：保留单张／批量转换，修复预览拖动；与导入插件分别构建。
- [共用九宫格核心](packages/nine-slice/README.md)：构建时复用，不运行时调用另一个插件。

在 `local-helper` 执行 `cargo run --release --locked` 启动助手；按该目录 README 从本机令牌文件手动配对，不把令牌贴到聊天或 Issue。

在两个插件目录分别执行 `npm ci` 和 `npm run build`。图集导入插件导入其根目录的 `manifest.json`；独立九宫格插件导入其 `dist/manifest.json`。客户端要求有效开发插件身份时需自行注册，实际 manifest 加载和本地网络权限仍待 Figma 验证。

最小演示将助手的 `examples` 目录登记为资源目录，可得到红、绿两个独立素材。当前图集导入只支持小型直接目录，普通主组件暂归未分类；并非三个实际项目全量导入版本。

## 验证

从各自目录运行：

| 目录 | 命令 | 验证边界 |
| --- | --- | --- |
| `packages/nine-slice` | `npm ci && npm run typecheck && npm test` | 公共切片规划 |
| `nine-slice-plugin` | `npm ci && npm run typecheck && npm test` | 插件入口与真实浏览器预览交互 |
| `local-helper` | `npm ci && cargo fmt --check && cargo check --locked && cargo clippy --all-targets --locked -- -D warnings && cargo test --locked && npm test` | 构建检查与真实 Rust 子进程 HTTP／像素集成测试 |
| `atlas-import-plugin` | `npm ci && npm run test:all` | 助手至插件任务链路与浏览器管理界面 |

浏览器测试需要 Playwright Chromium（九宫格）和系统 Chrome（图集导入）。Rust 原生测试当前没有单元用例；真实 HTTP 集成测试由 Node 驱动，不能把 `cargo test` 的构建通过当作全部行为验证。

### 集成审查修复

- 失败回滚只恢复仍保留插件写入值的页面名称与绑定，保留用户同期修改及无关节点；回归先失败，再通过。
- 扫描期间切页会记录待校验状态，结束后重新校验，并在校验前禁用导入；自动重验保留原任务的失败提示及失败显示，不吞掉断连后的启动指引。浏览器用受控网络等待和断连复现并回归。
- 小数边距辅助线与提交参数使用一致数值，四边实际位置经过浏览器验证；详见 [九宫格验证记录](nine-slice-plugin/VALIDATION.md)。

## 尚未实现／验收

- 完整递归扫描、独立图片、增量更新、取消与补齐、自动九宫格导入、已有九宫格原位编辑、自动或手动分类、可选图集对照页、托盘及真实项目性能验收，分别属于后续 #3–12。
- 未操作用户已有设计，未在隔离 Figma 文件验收真实加载、资源搜索、组件图像、实例关联、拉伸和透明接缝。
- 原独立九宫格目录未覆盖，Issues 保持打开；仅自动化通过不代表平台验收完成。
