# MyFigma 独立九宫格插件

由旧独立 9-Slice 插件迁移，保留单张／批量转换、四边及统一边距、保留或替换原图、可选重叠、预览缩放／平移及七种语言。旧插件目录不参与构建，也未写入。

## 独立构建与导入

需要 Node.js（本次验证 v24.15.0）和 npm：

```sh
npm ci
npm run build
npm run typecheck
npx playwright install chromium
npm test
```

Figma 桌面端通过开发插件菜单导入 **`dist/manifest.json`**；同目录包含独立的 `code.js` 和 `ui.html`。无需本地助手、图集导入插件、旧插件、ui-studio 或运行时网络服务。构建只读取仓库的 `packages/nine-slice/src/` 并 bundle 到产物。

没有复用旧发布插件的 ID；如 Figma 客户端要求注册 ID，先创建独立开发插件，使用其新 ID，勿覆盖旧发布插件。实际客户端导入尚未验证。

## 使用

1. 在画布选择含图片填充的图层，运行插件。
2. 输入边距或拖动绿色引导线；滚轮缩放，中键或平移模式拖动预览，适配按钮复位。
3. 批量模式将同一组参数应用到所有选中图片；状态标记不再遮挡操作。
4. 生成组件。默认保留原图；关闭保留原图后，仅在所有目标生成成功时删除原图。

边距单位为图层尺寸，不一定等于源图片像素。左右之和必须小于宽度，上下之和必须小于高度；批量先校验所有目标。零边距不生成空切片。

适用范围沿用旧插件：普通、未旋转、单一图片填充、未自定义裁剪的图片图层。复杂裁剪、平铺、多填充、遮罩、特效与 Auto Layout 父级定位不保证视觉兼容。透明图建议关闭消除缝隙。

## 验证

```sh
npm run test:browser -- --grep 'batch=true'
npm run test:browser -- --grep 'small selected'
npm run build && node --test tests/plugin.test.cjs
npm run typecheck
npm test
```

浏览器测试加载构建产物的真实页面，以平台消息输入图片，使用真实鼠标拖动／点击／输入验证交互。生成测试从 `figma.ui.onmessage` 驱动，只在 Figma API 边界使用替身，不测试私有函数。

红绿证据、根因和未验证项见 [VALIDATION.md](VALIDATION.md)。独立双轴审查、总体集成和 Issue 关闭交由父代理。
