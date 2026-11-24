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
- `@myfigma/nine-slice/compact`：`createCompactPlan(size, margins, {horizontal, vertical})`、`analyzeCompactUniformity(image, margins)`、`compactImage(image, margins)`。
  四角保持原像素；可拉伸方向近似纯色时目标为 `1px`，渐变／非均匀时目标为 `max(1, round(原尺寸 × 25%))`，不设上限。`image` 为 `{width, height, data}` 的 RGBA `Uint8ClampedArray`，宽高必须是整数且数据长度匹配；面积重采样在预乘颜色上计算并还原透明通道，四角逐像素复制。非法尺寸、边距或像素数据抛出 `RangeError`，不钳制。该模块不依赖 DOM 或 Figma，插件 UI 只负责 Canvas 解码与 PNG 编码。
- `@myfigma/nine-slice/figma`：`createNineSliceComponent(figma, {width, height, fill}, margins, {overlap?})`。
  返回无 Auto Layout 的主组件；失败移除本次半成品，并尽力恢复已移除的旧子层与原填充、尺寸、布局。Figma 不提供事务原语，恢复本身仍可能失败。调用方负责父级、名称、坐标、选择、来源状态和原图删除。
  `fill` 为 Figma `ImagePaint`；消费适配入口的工程需要 `@figma/plugin-typings`。
- `@myfigma/nine-slice/record`：两个插件共用的 Figma shared plugin data 记录读写（namespace `myfigma`、key `nineSlice.v1`，旧私有 `myfigma.nineSlice.v1` 仅兼容回退）。
  必填 `margins`、`overlap`、`width`、`height` 兼容旧版；新增 `project`（项目统计参数）、`current`（当前参数）、`override`（人工覆盖）和可选 `imageSize`（原图像素尺寸）。
  `width`／`height` 是组件画布尺寸，`margins`／`current` 始终是原图像素空间的边距：普通导入组件两者相同；手动九宫格升级保留设计者当前画布，因此用 `imageSize` 记录原图像素尺寸。
  `nineSliceImageSize(record)` 返回边距所属的原图像素尺寸（旧记录回退为画布），`scaleMargins(margins, from, to)` 在原图与画布空间之间换算。
  旧记录缺少 `project` 时按人工覆盖读取，避免增量导入改动既有手工边距。
  同一模块提供跨插件来源标记 `myfigma`／`atlas.origin`：资源导入器写入 `{schemaVersion:1, identity}`，只保留项目内来源身份、不写本机路径。该标记只是可选的来源提示，不是普通单图组件**手动九宫格升级**的前置条件。读取与写入入口为 `readImportMarker`、`writeImportMarker`。

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

纯核心测试证明切片规划、非法输入校验和真实 RGBA 数组上的精简几何／均匀性判断／面积重采样：四角逐像素保持、水平／垂直／双轴方向分别按 1px 或 25% 处理、无上限、透明通道保留。插件 UI 用同一份 `compact` 源码 bundle 到单文件 HTML，不复制第二套算法。Figma 适配由独立插件的公开消息入口回归覆盖；这些平台替身**不证明**真实图片裁剪、约束传播、不同尺寸拉伸或透明边缘接缝。

生成适配沿用旧插件的切片裁剪和可选重叠公式。重叠默认关闭；透明图建议关闭。原图有自定义裁剪／平铺／旋转、多填充、遮罩、特效或 Auto Layout 父级时不保证视觉兼容。共享记录已支持项目参数、当前参数、人工覆盖状态与原图像素尺寸；独立九宫格插件已实现人工编辑标记、恢复项目参数、不可识别组件提示，以及不要求来源标记的普通单图组件手动九宫格升级（根填充或唯一完整铺满的图片子层）；导入插件按同一记录尊重人工边距，并在失效时跳过等待恢复。真实 Figma 126.10.7 已用实际 API、构建后的主线程 bundle 和当前开发插件面板验证组件身份、实例关联、宽高、四角/边/中心约束及真实重新导入 unchanged；无标记根填充与唯一完整铺满的图片子层均可升级，升级后面板立即进入更新状态。实例逐像素导出及父级变换下的极端几何仍未覆盖。
