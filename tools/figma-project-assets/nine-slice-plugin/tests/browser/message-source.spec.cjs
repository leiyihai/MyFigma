const { test, expect } = require('@playwright/test');
const { readFile } = require('node:fs/promises');
const path = require('node:path');

for (const origin of ['https://www.figma.com', 'https://untrusted.example']) {
  test(`nested preview accepts ancestor selection and settings only from Figma (${origin})`, async ({ page }) => {
    await page.route(origin + '/acceptance-ui.html', async route => route.fulfill({
      contentType: 'text/html; charset=utf-8', body: await readFile(path.resolve('dist/ui.html'), 'utf8') }));
    await page.route(origin + '/acceptance-bridge.html', route => route.fulfill({
      contentType: 'text/html; charset=utf-8', body:
        `<iframe title="preview" sandbox="allow-scripts" src="${origin}/acceptance-ui.html" style="width:360px;height:740px"></iframe>` }));
    const host = origin + '/nine-slice-message-acceptance';
    await page.route(host, route => route.fulfill({ contentType: 'text/html; charset=utf-8', body:
      `<iframe title="bridge" src="${origin}/acceptance-bridge.html" style="width:400px;height:800px"></iframe>` }));
    await page.goto(host);
    const ui = page.frameLocator('iframe[title="bridge"]').frameLocator('iframe[title="preview"]');
    await expect(ui.locator('#top')).toHaveValue('0');
    await page.evaluate(async () => {
      const target = frames[0].frames[0];
      target.postMessage({ pluginMessage: { type: 'init-settings', settings: {
        top: 12.5, bottom: 10, left: 10, right: 10, all: 0,
        overlap: false, keepOriginal: true, batchMode: false, lang: 'zh'
      } } }, '*');
      const canvas = document.createElement('canvas');
      canvas.width = 100; canvas.height = 80;
      const blob = await new Promise(resolve => canvas.toBlob(resolve));
      target.postMessage({ pluginMessage: { type: 'update-preview',
        bytes: new Uint8Array(await blob.arrayBuffer()), width: 100, height: 80 } }, '*');
    });
    if (origin === 'https://www.figma.com') {
      await expect(ui.locator('#top')).toHaveValue('12.5');
      await expect(ui.locator('#preview-img')).toBeVisible();
      await expect(ui.locator('#empty-hint')).toBeHidden();
    } else {
      await expect(ui.locator('#top')).toHaveValue('0');
      await expect(ui.locator('#preview-img')).toBeHidden();
    }
  });
}
