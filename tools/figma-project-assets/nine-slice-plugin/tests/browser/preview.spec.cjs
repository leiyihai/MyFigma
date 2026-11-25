const { test, expect } = require('@playwright/test');
const { pathToFileURL } = require('node:url');
const path = require('node:path');

async function openPreview(page, batchMode = false) {
  await page.goto(pathToFileURL(path.resolve('dist/ui.html')).href);
  await page.evaluate(async batchMode => {
    window.postMessage({ pluginMessage: { type: 'init-settings', settings: {
      top: 10, bottom: 10, left: 10, right: 10, all: 10,
      overlap: false, keepOriginal: true, batchMode, lang: 'zh'
    } } }, '*');
    const canvas = document.createElement('canvas');
    canvas.width = 100; canvas.height = 80;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#f80'; ctx.fillRect(0, 0, 100, 80);
    const blob = await new Promise(resolve => canvas.toBlob(resolve));
    window.postMessage({ pluginMessage: { type: 'update-preview',
      bytes: new Uint8Array(await blob.arrayBuffer()), width: 100, height: 80,
      plainImage: { id: 'layer-1', name: '测试图片', width: 100, height: 80 } } }, '*');
  }, batchMode);
  await expect(page.locator('#preview-img')).toBeVisible();
  await page.locator('#preview-img').evaluate(img => img.decode());
  // Wait for the real fit-to-view transition, not a synthetic event dispatch.
  await page.waitForTimeout(150);
}

test('preview controls describe their action and batch state leaves empty-selection guidance visible', async ({ page }) => {
  await openPreview(page, true);
  for (const button of await page.locator('button').all()) {
    await expect(button).toHaveAttribute('title', /.+/);
  }
  await page.evaluate(() => window.postMessage({ pluginMessage: { type: 'update-preview', bytes: null } }, '*'));
  await expect(page.locator('#empty-hint')).toBeVisible();
});

test('user can zoom, pan, reset and set margins while batch and source deletion stay unavailable', async ({ page }) => {
  await openPreview(page);
  const image = page.locator('#preview-img');
  const fitted = await image.boundingBox();
  await page.locator('button[onclick="changeZoom(0.1)"]').click();
  await expect.poll(async () => (await image.boundingBox()).width).toBeGreaterThan(fitted.width + 5);
  await page.locator('button[onclick="changeZoom(-0.1)"]').click();
  await expect.poll(async () => Math.abs((await image.boundingBox()).width - fitted.width)).toBeLessThan(1);
  await page.locator('#btn-pan').click();
  await page.mouse.move(fitted.x + fitted.width / 2, fitted.y + fitted.height / 2);
  await page.mouse.down();
  await page.mouse.move(fitted.x + fitted.width / 2 + 20, fitted.y + fitted.height / 2 + 10);
  await page.mouse.up();
  await expect.poll(async () => (await image.boundingBox()).x).toBeCloseTo(fitted.x + 20, 0);
  await page.locator('button[onclick="resetView()"]').click();
  await expect.poll(async () => (await image.boundingBox()).x).toBeCloseTo(fitted.x, 0);
  await page.locator('#all').fill('12.5');
  for (const side of ['top', 'bottom', 'left', 'right']) await expect(page.locator(`#${side}`)).toHaveValue('12.5');
  await page.locator('#right').fill('7');
  // A plain image layer gets exactly the two compact actions; the legacy batch
  // path (which could delete the source) is not reachable from this panel.
  await expect(page.locator('#compact-btn')).toBeVisible();
  await expect(page.locator('#compact-btn')).toHaveText('生成九宫格图片');
  await expect(page.locator('#main-btn')).toHaveText('生成九宫格组件');
  await expect(page.locator('#main-btn')).toBeEnabled();
  // Batch keeps its existing entry; it is the legacy original-image path, not
  // a hidden no-op. Keep Original only applies to that path, and the compact
  // actions always force the 0.5px seam overlap off.
  await expect(page.locator('#batchMode')).toBeEnabled();
  await expect(page.locator('#batchMode')).not.toBeChecked();
  await expect(page.locator('#keepOriginal')).toBeDisabled();
  // The compact actions always keep the source, so the locked switch says so.
  await expect(page.locator('#keepOriginal')).toBeChecked();
  await expect(page.locator('#overlap')).toBeDisabled();
  await expect(page.locator('#overlap')).not.toBeChecked();
  await expect(page.locator('.help-wrap').nth(1).locator('.tooltip')).toContainText(/0.5px 重叠|关闭消除缝隙/);
  await expect(page.locator('#restore-btn')).toBeHidden();
  await expect(page.locator('#locate-btn')).toBeHidden();
});

test('compact image and component actions send analysed pixels, size, margins and source id', async ({ page }) => {
  await openPreview(page);
  await page.evaluate(() => {
    window.compactMessages = [];
    window.legacyGenerateMessages = [];
    window.addEventListener('message', e => {
      const message = e.data?.pluginMessage;
      if (!message) return;
      if (message.type === 'generate') window.legacyGenerateMessages.push(message);
      if (message.type === 'generate-compact-image' || message.type === 'generate-compact-component') {
        window.compactMessages.push({
          type: message.type, width: message.width, height: message.height,
          margins: message.margins, overlap: message.overlap, sourceId: message.sourceId,
          length: message.bytes.length, signature: [...message.bytes.slice(0, 4)]
        });
      }
    });
  });

  // The new plain layer starts at zero; set the margins explicitly for this
  // compact fixture.
  for (const side of ['top', 'bottom', 'left', 'right']) await page.locator('#' + side).fill('10');
  await page.locator('#compact-btn').click();
  await expect.poll(() => page.evaluate(() => window.compactMessages.length)).toBe(1);
  let request = await page.evaluate(() => window.compactMessages[0]);
  // A solid 100x80 image with 10px margins collapses both stretchable axes.
  expect(request.type).toBe('generate-compact-image');
  expect([request.width, request.height]).toEqual([21, 21]);
  expect(request.margins).toEqual({ left: 10, top: 10, right: 10, bottom: 10 });
  expect(request.sourceId).toBe('layer-1');
  expect(request.overlap).toBe(false);
  expect(request.signature).toEqual([137, 80, 78, 71]);
  expect(request.length).toBeGreaterThan(8);

  await page.locator('#main-btn').click();
  await expect.poll(() => page.evaluate(() => window.compactMessages.length)).toBe(2);
  request = await page.evaluate(() => window.compactMessages[1]);
  expect(request.type).toBe('generate-compact-component');
  expect([request.width, request.height]).toEqual([21, 21]);
  expect(request.margins).toEqual({ left: 10, top: 10, right: 10, bottom: 10 });
  expect(request.sourceId).toBe('layer-1');
  expect(request.signature).toEqual([137, 80, 78, 71]);
  expect(await page.evaluate(() => window.legacyGenerateMessages)).toEqual([]);
});

test('invalid margins keep the compact actions available and explain the failure', async ({ page }) => {
  await openPreview(page);
  await page.evaluate(() => {
    window.compactMessages = [];
    window.addEventListener('message', e => {
      const message = e.data?.pluginMessage;
      if (message?.type === 'generate-compact-image') window.compactMessages.push(message);
    });
  });
  // 100 is not smaller than the 100px source width.
  await page.locator('#left').fill('100');
  await page.locator('#compact-btn').click();
  await expect(page.locator('#edit-status')).toHaveClass(/error/);
  await expect(page.locator('#edit-status')).toContainText(/边距/);
  expect(await page.evaluate(() => window.compactMessages)).toEqual([]);
  await expect(page.locator('#compact-btn')).toBeVisible();
  await expect(page.locator('#compact-btn')).toBeEnabled();
});

test('unreadable images and non-image selections disable both compact actions', async ({ page }) => {
  await openPreview(page);
  for (const [reason, text] of [
    ['image-unreadable', /无法读取/],
    ['not-image', /不是普通图片图层/]
  ]) {
    await page.evaluate(reason => window.postMessage({ pluginMessage: {
      type: 'update-preview', bytes: null, edit: null, unsupported: reason
    } }, '*'), reason);
    await expect(page.locator('#edit-status')).toContainText(text);
    await expect(page.locator('#compact-btn')).toBeHidden();
    await expect(page.locator('#main-btn')).toBeDisabled();
  }
});

test('fractional margins are rounded once, then reused by the request and the panel', async ({ page }) => {
  await openPreview(page);
  await page.evaluate(() => {
    window.compactMessages = [];
    window.addEventListener('message', e => {
      const message = e.data?.pluginMessage;
      if (message?.type === 'generate-compact-image') window.compactMessages.push({
        width: message.width, height: message.height, margins: message.margins, overlap: message.overlap });
    });
  });
  await page.locator('#all').fill('12.5');
  // A stale checked state must never turn the seam overlap on for compact output.
  await page.evaluate(() => { document.getElementById('overlap').checked = true; });
  await page.locator('#compact-btn').click();
  await expect.poll(() => page.evaluate(() => window.compactMessages.length)).toBe(1);
  const request = await page.evaluate(() => window.compactMessages[0]);
  // 100x80 source with 13px margins: 100 - 26 = 74 and 80 - 26 = 54, both solid,
  // so each axis collapses to 1px and the output is 27x27.
  expect(request.margins).toEqual({ left: 13, top: 13, right: 13, bottom: 13 });
  expect([request.width, request.height]).toEqual([27, 27]);
  expect(request.overlap).toBe(false);
  // The panel shows the same integers it just used, so the next edit cannot
  // drift from the pixels that were sliced.
  for (const side of ['top', 'bottom', 'left', 'right']) {
    await expect(page.locator('#' + side)).toHaveValue('13');
    await expect.poll(async () => page.locator('#g-' + side).evaluate((guide, side) => {
      const image = document.getElementById('preview-img').getBoundingClientRect();
      const line = guide.getBoundingClientRect();
      const scale = image.width / 100;
      if (side === 'top') return (line.y + line.height / 2 - image.y) / scale;
      if (side === 'bottom') return (image.bottom - line.y - line.height / 2) / scale;
      if (side === 'left') return (line.x + line.width / 2 - image.x) / scale;
      return (image.right - line.x - line.width / 2) / scale;
    }, side)).toBeCloseTo(13, 1);
  }
  // The All shortcut now shows the same rounded value as the four sides.
  await expect(page.locator('#all')).toHaveValue('13');
});

test('a plain image layer is FILL-cropped to its visible pixels before compacting', async ({ page }) => {
  await page.goto(pathToFileURL(path.resolve('dist/ui.html')).href);
  await page.evaluate(async () => {
    window.postMessage({ pluginMessage: { type: 'init-settings', settings: {
      top: 0, bottom: 0, left: 0, right: 0, all: 0,
      overlap: false, keepOriginal: false, batchMode: false, lang: 'zh'
    } } }, '*');
    // 100x200 natural pixels shown in a 100x80 layer. FILL covers the layer by
    // keeping rows 60-140, so the 20px magenta band at the top disappears;
    // stretching would keep it as the top 8 rows.
    const canvas = document.createElement('canvas');
    canvas.width = 100; canvas.height = 200;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#00f'; ctx.fillRect(0, 0, 100, 200);
    ctx.fillStyle = '#f0f'; ctx.fillRect(0, 0, 100, 20);
    const blob = await new Promise(resolve => canvas.toBlob(resolve));
    window.postMessage({ pluginMessage: { type: 'update-preview',
      bytes: new Uint8Array(await blob.arrayBuffer()), width: 100, height: 80,
      plainImage: { id: 'layer-fill', name: '裁切图片', width: 100, height: 80, scaleMode: 'FILL' } } }, '*');
  });
  await expect(page.locator('#preview-img')).toBeVisible();
  await page.locator('#preview-img').evaluate(img => img.decode());
  await page.waitForTimeout(150);
  // The preview shows what the layer shows, not a stretched image.
  await expect(page.locator('#preview-img')).toHaveCSS('object-fit', 'cover');
  await page.evaluate(() => {
    window.compactMessages = [];
    window.addEventListener('message', e => {
      const message = e.data?.pluginMessage;
      if (message?.type === 'generate-compact-image') window.compactMessages.push(message);
    });
  });
  // Give this fixture real margins so both stretchable axes are compacted;
  // zero/zero margins intentionally preserve the axis now.
  for (const side of ['top', 'bottom', 'left', 'right']) await page.locator('#' + side).fill('10');
  await page.locator('#compact-btn').click();
  await expect.poll(() => page.evaluate(() => window.compactMessages.length)).toBe(1);
  const sampled = await page.evaluate(async () => {
    const message = window.compactMessages[0];
    const bitmap = await createImageBitmap(new Blob([message.bytes], { type: 'image/png' }));
    const canvas = document.createElement('canvas');
    canvas.width = bitmap.width; canvas.height = bitmap.height;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(bitmap, 0, 0);
    return { width: bitmap.width, height: bitmap.height, pixel: [...ctx.getImageData(0, 0, 1, 1).data] };
  });
  // Every visible pixel is blue, so both axes collapse to 1px plus the 10px
  // margins. A stretch would keep the magenta band instead.
  expect([sampled.width, sampled.height]).toEqual([21, 21]);
  expect(sampled.pixel).toEqual([0, 0, 255, 255]);
});

test('batch mode keeps the legacy original-image path and says it does not compact', async ({ page }) => {
  await openPreview(page, true);
  await expect(page.locator('#batchMode')).toBeEnabled();
  await expect(page.locator('#batchMode')).toBeChecked();
  await expect(page.locator('#keepOriginal')).toBeEnabled();
  await expect(page.locator('#overlap')).toBeEnabled();
  await expect(page.locator('#batch-overlay')).toBeVisible();
  await expect(page.locator('#edit-status')).toContainText('批量模式使用原始图片、不精简');
  await expect(page.locator('#main-btn')).toHaveAttribute('title', /原始图片|不精简/);
  // A still only handles the current image.
  await expect(page.locator('#compact-btn')).toBeVisible();
  await page.evaluate(() => {
    window.legacyMessages = [];
    window.compactMessages = [];
    window.addEventListener('message', e => {
      const message = e.data?.pluginMessage;
      if (message?.type === 'generate') window.legacyMessages.push({
        type: message.type, batchMode: message.batchMode, keepOriginal: message.keepOriginal, overlap: message.overlap });
      if (message?.type === 'generate-compact-image' || message?.type === 'generate-compact-component') {
        window.compactMessages.push(message.type);
      }
    });
  });
  await page.locator('#main-btn').click();
  await expect.poll(() => page.evaluate(() => window.legacyMessages.length)).toBe(1);
  expect(await page.evaluate(() => window.legacyMessages[0])).toEqual({
    type: 'generate', batchMode: true, keepOriginal: true, overlap: false });
  // The batch entry never posts compacted pixels, so it cannot claim the compact promise.
  expect(await page.evaluate(() => window.compactMessages)).toEqual([]);
  await page.locator('#compact-btn').click();
  await expect.poll(() => page.evaluate(() => window.compactMessages.length)).toBe(1);
  expect(await page.evaluate(() => window.compactMessages[0])).toBe('generate-compact-image');
  // Turning batch off returns the main button to the compact component path and
  // restores the locked Keep Original / Fix Gaps state without a new selection.
  await page.locator('.row:has(#batchMode) label.switch').click();
  await expect(page.locator('#batch-overlay')).toBeHidden();
  await expect(page.locator('#keepOriginal')).toBeDisabled();
  await expect(page.locator('#keepOriginal')).toBeChecked();
  await expect(page.locator('#overlap')).toBeDisabled();
  await expect(page.locator('#edit-status')).not.toContainText('批量模式使用原始图片');
  await page.locator('#main-btn').click();
  await expect.poll(() => page.evaluate(() => window.compactMessages.length)).toBe(2);
  expect(await page.evaluate(() => window.compactMessages[1])).toBe('generate-compact-component');
  expect(await page.evaluate(() => window.legacyMessages.length)).toBe(1);
});

test('selecting an existing component enters update mode with its margins', async ({ page }) => {
  await openPreview(page);
  await page.evaluate(() => window.postMessage({ pluginMessage: {
    type: 'update-preview', bytes: null,
    edit: { margins: { left: 20, right: 8, top: 10, bottom: 12 }, overlap: false, target: 'component', name: '已有底板' }
  } }, '*'));
  await expect(page.locator('#main-btn')).toHaveText('更新九宫格组件');
  await expect(page.locator('#compact-btn')).toBeHidden();
  await expect(page.locator('#edit-status')).toContainText('已有底板');
  await expect(page.locator('#left')).toHaveValue('20');
  await expect(page.locator('#top')).toHaveValue('10');
  await expect(page.locator('#batchMode')).toBeDisabled();
  await expect(page.locator('#keepOriginal')).toBeDisabled();

  await page.evaluate(() => window.postMessage({ pluginMessage: {
    type: 'update-preview', bytes: null,
    edit: { margins: { left: 20, right: 8, top: 10, bottom: 12 }, overlap: false, target: 'instance', name: '底板实例', editable: false }
  } }, '*'));
  await expect(page.locator('#main-btn')).toBeDisabled();
  await expect(page.locator('#main-btn')).toHaveText('请选中主组件后编辑');
  await expect(page.locator('#edit-status')).toContainText('请定位主组件');
});

test('a resized component previews and drags margins in original image pixels', async ({ page }) => {
  await openPreview(page);
  await page.evaluate(async () => {
    const canvas = document.createElement('canvas');
    canvas.width = 256; canvas.height = 256;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#4a8'; ctx.fillRect(0, 0, 256, 256);
    const blob = await new Promise(resolve => canvas.toBlob(resolve));
    // This is what the main thread sends for an 858×769 component whose record
    // still keeps 256×256 original image pixels.
    window.postMessage({ pluginMessage: { type: 'update-preview',
      bytes: new Uint8Array(await blob.arrayBuffer()), width: 256, height: 256,
      edit: {
        margins: { left: 60, right: 40, top: 50, bottom: 80 }, overlap: false,
        target: 'component', name: '放大底板', editable: true, legacy: false, override: true,
        imageSize: { width: 256, height: 256 }
      }
    } }, '*');
  });
  await page.locator('#preview-img').evaluate(img => img.decode());
  await page.waitForTimeout(150);
  for (const side of ['top', 'bottom', 'left', 'right']) {
    await expect(page.locator(`#${side}`)).toHaveValue(String({ top: 50, bottom: 80, left: 60, right: 40 }[side]));
  }
  const image = await page.locator('#preview-img').boundingBox();
  expect(Math.abs(image.width - image.height)).toBeLessThan(1);
  for (const side of ['top', 'bottom', 'left', 'right']) {
    await expect.poll(async () => page.locator(`#g-${side}`).evaluate((guide, { side, size }) => {
      const preview = document.getElementById('preview-img').getBoundingClientRect();
      const line = guide.getBoundingClientRect();
      const scale = preview.width / size;
      if (side === 'top') return (line.y + line.height / 2 - preview.y) / scale;
      if (side === 'bottom') return (preview.bottom - line.y - line.height / 2) / scale;
      if (side === 'left') return (line.x + line.width / 2 - preview.x) / scale;
      return (preview.right - line.x - line.width / 2) / scale;
    }, { side, size: 256 })).toBeCloseTo({ top: 50, bottom: 80, left: 60, right: 40 }[side], 1);
  }

  const scale = image.width / 256;
  await page.mouse.move(image.x + 60 * scale, image.y + 128 * scale);
  await page.mouse.down();
  await page.mouse.move(image.x + 70.5 * scale, image.y + 128 * scale, { steps: 5 });
  await page.mouse.up();
  const dragged = Number(await page.locator('#left').inputValue());
  expect(dragged).toBeGreaterThanOrEqual(69);
  expect(dragged).toBeLessThanOrEqual(71);
  // The old canvas coordinate (about 405 for a 858-wide component) must never
  // appear in the image-pixel input or guide space.
  expect(dragged).toBeLessThanOrEqual(256);
});

test('help tooltip stays inside the narrow plugin viewport', async ({ page }) => {
  await openPreview(page);
  const help = page.locator('.help-icon').first();
  await help.hover();
  const tooltip = page.locator('.help-wrap').first().locator('.tooltip');
  await expect(tooltip).toBeVisible();
  const bounds = await tooltip.evaluate(el => {
    const r = el.getBoundingClientRect();
    return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: innerWidth, height: innerHeight };
  });
  expect(bounds.left >= 0 && bounds.top >= 0 && bounds.right <= bounds.width && bounds.bottom <= bounds.height).toBe(true);
});

test('fractional margins put every visible guide at the submitted slice boundary', async ({ page }) => {
  await openPreview(page);
  await page.locator('#all').fill('12.5');
  for (const side of ['top', 'bottom', 'left', 'right']) {
    await expect.poll(async () => page.locator('#g-' + side).evaluate((guide, side) => {
      const image = document.getElementById('preview-img').getBoundingClientRect();
      const line = guide.getBoundingClientRect();
      const scale = image.width / 100;
      if(side === 'top')return (line.y + line.height / 2 - image.y) / scale;
      if(side === 'bottom')return (image.bottom - line.y - line.height / 2) / scale;
      if(side === 'left')return (line.x + line.width / 2 - image.x) / scale;
      return (image.right - line.x - line.width / 2) / scale;
    }, side)).toBeCloseTo(12.5, 1);
  }
});

test('a small selected image keeps the top guide draggable at fit-to-view zoom', async ({ page }) => {
  await openPreview(page);
  await page.locator('#all').fill('0');
  await page.evaluate(async () => {
    const bytes = new Uint8Array(await (await fetch(document.querySelector('#preview-img').src)).arrayBuffer());
    window.postMessage({ pluginMessage: { type: 'update-preview', bytes, width: 16, height: 16 } }, '*');
  });
  await page.waitForTimeout(150);
  const image = await page.locator('#preview-img').boundingBox();
  await page.mouse.move(image.x + image.width / 2, image.y);
  await page.mouse.down();
  await page.mouse.move(image.x + image.width / 2, image.y + image.height / 8, { steps: 5 });
  await page.mouse.up();
  await expect(page.locator('#top')).toHaveValue('2');
  await expect(page.locator('#right')).toHaveValue('0');
  const guide = page.locator('#g-top .guide-visual');
  // A scaled glow used to make short guide lines look several pixels thick.
  await expect(guide).toHaveCSS('box-shadow', 'none');
  expect((await guide.boundingBox()).height).toBeLessThan(2);
});

for (const batchMode of [false, true]) {
  test(`selected image allows dragging all four margins (batch=${batchMode})`, async ({ page }) => {
    await openPreview(page, batchMode);
    // New layers start at zero; establish the 10px starting guides for this
    // drag fixture explicitly.
    for (const side of ['top', 'bottom', 'left', 'right']) await page.locator('#' + side).fill('10');
    const image = await page.locator('#preview-img').boundingBox();
    const scale = image.width / 100;
    for (const [side, startX, startY, endX, endY] of [
      ['top', 50, 10, 50, 20], ['bottom', 50, 70, 50, 60],
      ['left', 10, 40, 20, 40], ['right', 90, 40, 80, 40]
    ]) {
      await page.mouse.move(image.x + startX * scale, image.y + startY * scale);
      await page.mouse.down();
      await page.mouse.move(image.x + endX * scale, image.y + endY * scale, { steps: 5 });
      await page.mouse.up();
      await expect(page.locator(`#${side}`)).toHaveValue('20');
    }
  });
}

test('manual project margins expose a restore action that explains manual priority', async ({ page }) => {
  await openPreview(page);
  await page.evaluate(() => {
    window.restoreMessages = [];
    window.addEventListener('message', e => {
      if (e.data?.pluginMessage?.type === 'restore-project') window.restoreMessages.push(e.data.pluginMessage);
    });
    window.postMessage({ pluginMessage: {
      type: 'update-preview', bytes: null,
      edit: {
        margins: { left: 20, right: 8, top: 10, bottom: 12 }, overlap: false,
        target: 'component', name: '已有底板', editable: true, legacy: false, override: true,
        project: { left: 6, right: 6, top: 6, bottom: 6 }
      }
    } }, '*');
  });
  await expect(page.locator('#main-btn')).toHaveText('更新九宫格组件');
  await expect(page.locator('#main-btn')).toHaveAttribute('title', /人工.*优先|恢复项目参数/);
  const restore = page.locator('#restore-btn');
  await expect(restore).toBeVisible();
  await expect(restore).toHaveAttribute('title', /恢复项目参数|清除手动/);
  await restore.click();
  await expect.poll(() => page.evaluate(() => window.restoreMessages)).toEqual([{ type: 'restore-project' }]);

  // Project-driven margins have no manual state to clear.
  await page.evaluate(() => window.postMessage({ pluginMessage: {
    type: 'update-preview', bytes: null,
    edit: {
      margins: { left: 6, right: 6, top: 6, bottom: 6 }, overlap: false,
      target: 'component', name: '项目底板', editable: true, legacy: false, override: false,
      project: { left: 6, right: 6, top: 6, bottom: 6 }
    }
  } }, '*'));
  await expect(page.locator('#restore-btn')).toBeHidden();
  await expect(page.locator('#edit-status')).toContainText('项目参数');
});

test('an unrecognized component is explained and never offered an update action', async ({ page }) => {
  await openPreview(page);
  await page.evaluate(() => window.postMessage({ pluginMessage: {
    type: 'update-preview', bytes: null, edit: null, unsupported: 'component'
  } }, '*'));
  await expect(page.locator('#edit-status')).toBeVisible();
  await expect(page.locator('#edit-status')).toContainText('无法识别');
  await expect(page.locator('#main-btn')).toBeDisabled();
  await expect(page.locator('#restore-btn')).toBeHidden();
});

test('a plain image main component offers a manual 9-slice upgrade and explains the disabled restore entry', async ({ page }) => {
  await openPreview(page);
  await page.evaluate(() => window.postMessage({ pluginMessage: {
    type: 'update-preview', bytes: null,
    edit: {
      margins: { left: 0, right: 0, top: 0, bottom: 0 }, overlap: false, target: 'upgrade',
      name: '底板/普通底板', editable: true, legacy: false, override: true, imageSize: { width: 64, height: 40 }
    }
  } }, '*'));
  await expect(page.locator('#main-btn')).toHaveText('升级为九宫格组件');
  await expect(page.locator('#compact-btn')).toBeHidden();
  await expect(page.locator('#edit-status')).toContainText('原图 64×40');
  // No importer marker is required, so the source hint stays absent.
  await expect(page.locator('#edit-status')).not.toContainText('导入器来源');
  const restore = page.locator('#restore-btn');
  await expect(restore).toBeVisible();
  await expect(restore).toBeDisabled();
  await expect(restore).toHaveAttribute('title', /没有记录项目参数/);
  await expect(page.locator('#locate-btn')).toBeHidden();

  // The optional marker only adds a source hint; the upgrade entry is unchanged.
  await page.evaluate(() => window.postMessage({ pluginMessage: {
    type: 'update-preview', bytes: null,
    edit: {
      margins: { left: 0, right: 0, top: 0, bottom: 0 }, overlap: false, target: 'upgrade',
      name: '底板/普通底板', editable: true, legacy: false, override: true, imported: true,
      imageSize: { width: 64, height: 40 }
    }
  } }, '*'));
  await expect(page.locator('#edit-status')).toContainText('导入器来源');
  await expect(page.locator('#main-btn')).toHaveText('升级为九宫格组件');
});

test('a finished upgrade switches the panel from the upgrade entry to the edit entry', async ({ page }) => {
  await openPreview(page);
  await page.evaluate(() => window.postMessage({ pluginMessage: {
    type: 'update-preview', bytes: null,
    edit: {
      margins: { left: 16, right: 8, top: 4, bottom: 2 }, overlap: false, target: 'upgrade',
      name: '底板/普通底板', editable: true, legacy: false, override: true, imageSize: { width: 64, height: 40 }
    }
  } }, '*'));
  await expect(page.locator('#main-btn')).toHaveText('升级为九宫格组件');
  await expect(page.locator('#edit-status')).toContainText('原图 64×40');
  await expect(page.locator('#restore-btn')).toBeDisabled();

  // After the upgrade the main thread refreshes the same selection; the panel
  // must leave the upgrade entry and offer the normal in-place update.
  await page.evaluate(() => window.postMessage({ pluginMessage: {
    type: 'update-preview', bytes: null,
    edit: {
      margins: { left: 16, right: 8, top: 4, bottom: 2 }, overlap: false, target: 'component',
      name: '底板/普通底板', editable: true, legacy: false, override: true, imageSize: { width: 64, height: 40 }
    }
  } }, '*'));
  await expect(page.locator('#main-btn')).toHaveText('更新九宫格组件');
  await expect(page.locator('#main-btn')).toBeEnabled();
  await expect(page.locator('#edit-status')).toContainText('正在编辑现有组件');
  await expect(page.locator('#edit-status')).toContainText('人工边距优先');
  await expect(page.locator('#edit-status')).not.toContainText('普通单图组件');
  await expect(page.locator('#left')).toHaveValue('16');
  await expect(page.locator('#top')).toHaveValue('4');
  await expect(page.locator('#batchMode')).toBeDisabled();
  await expect(page.locator('#keepOriginal')).toBeDisabled();
  // No project parameter was recorded during a standalone upgrade.
  await expect(page.locator('#restore-btn')).toBeVisible();
  await expect(page.locator('#restore-btn')).toBeDisabled();
  await expect(page.locator('#restore-btn')).toHaveAttribute('title', /没有记录项目参数/);

  // A project-driven record keeps the restore entry usable in the same view.
  await page.evaluate(() => window.postMessage({ pluginMessage: {
    type: 'update-preview', bytes: null,
    edit: {
      margins: { left: 16, right: 8, top: 4, bottom: 2 }, overlap: false, target: 'component',
      name: '底板/普通底板', editable: true, legacy: false, override: true,
      project: { left: 6, right: 6, top: 6, bottom: 6 }, imageSize: { width: 64, height: 40 }
    }
  } }, '*'));
  await expect(page.locator('#restore-btn')).toBeEnabled();
  await expect(page.locator('#restore-btn')).toHaveAttribute('title', /清除手动|项目统计/);
});

test('a rejected plain image structure explains why the upgrade is unavailable', async ({ page }) => {
  await openPreview(page);
  for (const [reason, text] of [
    ['image-child-not-filled', /铺满/],
    ['image-child-decorated', /圆角|描边|效果/],
    ['multiple-children', /多个|额外|一张/],
    ['extra-content', /额外|其他内容/],
    ['auto-layout', /Auto Layout|自动布局/]
  ]) {
    await page.evaluate(reason => window.postMessage({ pluginMessage: {
      type: 'update-preview', bytes: null, edit: null, unsupported: reason
    } }, '*'), reason);
    await expect(page.locator('#edit-status')).toContainText(text);
    await expect(page.locator('#main-btn')).toBeDisabled();
  }
});

test('an instance exposes a locate action that never submits an upgrade', async ({ page }) => {
  await openPreview(page);
  await page.evaluate(() => {
    window.locateMessages = [];
    window.generatedMessages = [];
    window.addEventListener('message', e => {
      const message = e.data?.pluginMessage;
      if (message?.type === 'locate-main-component') window.locateMessages.push(message);
      if (message?.type === 'generate') window.generatedMessages.push(message);
    });
    window.postMessage({ pluginMessage: {
      type: 'update-preview', bytes: null,
      edit: {
        margins: { left: 4, right: 4, top: 4, bottom: 4 }, overlap: false, target: 'upgrade',
        name: '底板/普通底板', editable: false, legacy: false, override: true, imageSize: { width: 20, height: 20 }
      }
    } }, '*');
  });
  await expect(page.locator('#edit-status')).toContainText('定位主组件');
  await expect(page.locator('#main-btn')).toBeDisabled();
  const locate = page.locator('#locate-btn');
  await expect(locate).toBeVisible();
  await expect(locate).toHaveAttribute('title', /不会修改/);
  await locate.click();
  await expect.poll(() => page.evaluate(() => window.locateMessages)).toEqual([{ type: 'locate-main-component' }]);
  expect(await page.evaluate(() => window.generatedMessages)).toEqual([]);
});

test('switching plain image layers resets margins and guides to the image edges', async ({ page }) => {
  await openPreview(page);
  // A first image keeps its current margins while the same layer is selected.
  await page.locator('#all').fill('10');
  await expect(page.locator('#left')).toHaveValue('10');
  // A different, smaller layer must not inherit the previous layer's margins.
  await page.evaluate(async () => {
    const canvas = document.createElement('canvas');
    canvas.width = 37; canvas.height = 36;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#4af'; ctx.fillRect(0, 0, 37, 36);
    const blob = await new Promise(resolve => canvas.toBlob(resolve));
    window.postMessage({ pluginMessage: { type: 'update-preview',
      bytes: new Uint8Array(await blob.arrayBuffer()), width: 37, height: 36,
      plainImage: { id: 'layer-2', name: '小图', width: 37, height: 36 } } }, '*');
  });
  for (const side of ['top', 'bottom', 'left', 'right', 'all']) {
    await expect(page.locator('#' + side)).toHaveValue('0');
  }
  // The guide lines sit at 0/edge, not at the previous layer's position.
  await expect.poll(async () => page.locator('#g-top').evaluate(guide => {
    const image = document.getElementById('preview-img').getBoundingClientRect();
    const line = guide.getBoundingClientRect();
    return (line.y + line.height / 2 - image.y) / (image.height / 36);
  })).toBeCloseTo(0, 0);
  await expect.poll(async () => page.locator('#g-left').evaluate(guide => {
    const image = document.getElementById('preview-img').getBoundingClientRect();
    const line = guide.getBoundingClientRect();
    return (line.x + line.width / 2 - image.x) / (image.width / 37);
  })).toBeCloseTo(0, 0);
  // The second image remembers its own values; returning to the first restores
  // the first image's values, not the second image's.
  await page.locator('#all').fill('5');
  await page.evaluate(() => window.postMessage({ pluginMessage: { type: 'update-preview',
    bytes: new Uint8Array([137,80,78,71]), width: 100, height: 80,
    plainImage: { id: 'layer-1', name: '测试图片', width: 100, height: 80 } } }, '*'));
  for (const side of ['top', 'bottom', 'left', 'right']) await expect(page.locator('#' + side)).toHaveValue('10');
  await page.evaluate(() => window.postMessage({ pluginMessage: { type: 'update-preview',
    bytes: new Uint8Array([137,80,78,71]), width: 37, height: 36,
    plainImage: { id: 'layer-2', name: '小图', width: 37, height: 36 } } }, '*'));
  for (const side of ['top', 'bottom', 'left', 'right']) await expect(page.locator('#' + side)).toHaveValue('5');
});
