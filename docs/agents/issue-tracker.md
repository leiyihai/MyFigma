# Issue tracker: GitHub

规格与任务使用 GitHub Issues，通过 `gh` CLI 操作。当前仓库为 `leiyihai/MyFigma`；首次远端写入前用 `gh repo view --json nameWithOwner` 核对目标，避免写入上游或其他仓库。标题、正文和评论使用简体中文。

## 操作约定

- 技能要求“发布到 issue tracker”时，创建 GitHub Issue；要求“获取任务”时，读取 Issue 正文、标签及评论。
- 发布前确认规格中的待确认项已解决；分流标签遵循 [triage-labels.md](triage-labels.md)。
- 多行正文优先使用 `gh issue create --body-file`，发布后读取 Issue 核对内容和标签。
- 子任务与阻塞关系优先使用 GitHub 原生关联；当前 CLI 或仓库不支持时，在正文记录父任务和阻塞任务编号。
- 关闭任务前发布结果说明；已关闭的任务如需补充说明，单独发布评论。

## Pull requests as a triage surface

**PRs as a request surface: no.**
