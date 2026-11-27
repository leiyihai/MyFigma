const path = require('node:path');
const { pathToFileURL } = require('node:url');
const root = path.resolve(__dirname, '..');
const { chromium } = require(path.join(process.env.WORKBENCH_PLAYWRIGHT_ROOT || 'E:/MyFigma/tools/figma-project-assets/nine-slice-plugin/node_modules', 'playwright'));
async function openWorkbench(t) {
  const browser = await chromium.launch({executablePath: process.env.WORKBENCH_CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true});
  t.after(() => browser.close());
  const page = await browser.newPage({viewport: {width: 1560, height: 980}, reducedMotion: 'reduce'});
  page.setDefaultTimeout(5000);
  await page.goto(pathToFileURL(path.join(root, 'dist/workbench.html')).href);
  return {browser, page, prototype: page.frameLocator('iframe[title="原型画布"]')};
}
module.exports = {root, openWorkbench};
