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
      bytes: new Uint8Array(await blob.arrayBuffer()), width: 100, height: 80 } }, '*');
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

test('user can zoom, pan, reset, set margins and submit original standalone options', async ({ page }) => {
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
  // Drive visible switches, not hidden checkboxes or private handlers.
  await page.locator('.switch').nth(0).click();
  await page.locator('.switch').nth(1).click();
  await page.locator('.switch').nth(2).click();
  await page.evaluate(() => {
    window.generatedMessages = [];
    window.addEventListener('message', e => {
      if (e.data?.pluginMessage?.type === 'generate') window.generatedMessages.push(e.data.pluginMessage);
    });
  });
  await page.locator('#main-btn').click();
  await expect.poll(() => page.evaluate(() => window.generatedMessages)).toEqual([{
    type: 'generate', top: 12.5, bottom: 12.5, left: 12.5, right: 7, all: 12.5,
    keepOriginal: false, batchMode: true, overlap: true, lang: 'zh'
  }]);
});

test('selecting an existing component enters update mode with its margins', async ({ page }) => {
  await openPreview(page);
  await page.evaluate(() => window.postMessage({ pluginMessage: {
    type: 'update-preview', bytes: null,
    edit: { margins: { left: 20, right: 8, top: 10, bottom: 12 }, overlap: false, target: 'component', name: '已有底板' }
  } }, '*'));
  await expect(page.locator('#main-btn')).toHaveText('更新九宫格组件');
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
