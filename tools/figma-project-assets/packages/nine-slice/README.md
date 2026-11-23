# 共用九宫格核心

只提供四边边距规划和 Figma 生成适配，不依赖任何插件运行环境或 ui-studio。

```sh
npm ci
npm test
npm run typecheck
```

## 公共入口

- `@myfigma/nine-slice`：`createNineSlicePlan({width, height}, {left, top, right, bottom}, overlap?)`。
  尺寸必须为有限正数，边距为有限非负数，两边之和严格小于对应尺寸；否则抛出 `RangeError`，不钳制人工输入。
  返回按行排序的非零切片、位置和约束：角固定、边单向拉伸、中心双向拉伸。
- `@myfigma/nine-slice/figma`：`createNineSliceComponent(figma, {width, height, fill}, margins, {overlap?})`。
  返回无 Auto Layout 的主组件；失败移除本次半成品。调用方负责父级、名称、坐标、选择、来源状态和原图删除。
  `fill` 为 Figma `ImagePaint`；消费适配入口的工程需要 `@figma/plugin-typings`。
- `@myfigma/nine-slice/record`：两个插件共用的 Figma shared plugin data 记录读写（namespace `myfigma`、key `nineSlice.v1`，旧私有 `myfigma.nineSlice.v1` 仅兼容回退）。
  必填 `margins`、`overlap`、`width`、`height` 兼容旧版；新增 `project`（项目统计参数）、`current`（当前参数）和 `override`（人工覆盖）。
  旧记录缺少 `project` 时按人工覆盖读取，避免增量导入改动既有手工边距。

另一个插件可用本地文件依赖安装本包，先在本目录构建，再将入口 bundle 到自己的产物：

```ts
import { createNineSliceComponent } from '@myfigma/nine-slice/figma';

const component = createNineSliceComponent(
  figma,
  { width: 100, height: 80, fill: { type: 'IMAGE', imageHash, scaleMode: 'FILL' } },
  { left: 10, top: 12, right: 20, bottom: 8 },
  { overlap: false }
);
component.name = '九宫格底板';
```

本仓库独立插件直接从 `src/` 导入并 bundle，因此仅在插件目录 `npm ci && npm run build` 即可构建，不要求先安装或构建本包，也不依赖另一个插件。两个插件各自包含核心代码，不运行时互调。

## 验证边界

纯核心测试证明切片规划与非法输入校验。Figma 适配由独立插件的公开消息入口回归覆盖；这些平台替身**不证明**真实图片裁剪、约束传播、不同尺寸拉伸或透明边缘接缝。

生成适配沿用旧插件的切片裁剪和可选重叠公式。重叠默认关闭；透明图建议关闭。原图有自定义裁剪／平铺／旋转、多填充、遮罩、特效或 Auto Layout 父级时不保证视觉兼容。共享记录已支持项目参数、当前参数与人工覆盖状态；独立九宫格插件已实现人工编辑标记、恢复项目参数和不可识别组件提示，导入插件按同一记录尊重人工边距，并在失效时跳过等待恢复。
