#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { startStudio, parseSize } from './server.mjs';
import { inspectBrowser } from './browser.mjs';

export const HELP = `Design Studio — 独立、零依赖、本地 HTML 预览与保守检查 (Node >= 22)

用法:
  node tools/design-studio/cli.mjs serve <file.html> [--size 1280x720] [--duration 60000]
  node tools/design-studio/cli.mjs inspect <file.html> [--size 1280x720]
       [--screenshot <new.png>] [--report <new.json>]
       [--timeout 15000] [--browser <Chrome/Edge executable>]
  node tools/design-studio/cli.mjs --help

serve: 仅绑定 127.0.0.1，输出浏览器地址；Ctrl+C 退出。--duration 毫秒后自动关闭。
inspect: 临时干净无头浏览器，sandbox 内容与 serve 相同；stdout 输出 JSON。
尺寸: 宽高均 100..4096 CSS px，设备像素比固定 1。PNG 为指定尺寸视口，不是整页。
--timeout: 3000..60000 毫秒加载观察预算 (默认 15000)；单次 CDP 另有 5 秒上限。
--duration: 100..3600000 毫秒；省略则持续到退出。
浏览器默认查找 Chrome/Edge；也可设置 DESIGN_STUDIO_BROWSER。
未知/重复选项、无效值失败；证据路径必须不存在，不覆盖 HTML 或已有文件。
只读 DOM 检查，不点击/输入/提交；拦截非 GET/HEAD/OPTIONS 与服务源外请求。
内容 CSP 禁外链资源、fetch/XHR/WebSocket 和表单；依赖这些能力的 HTML 不完全兼容。
预览、渲染截图、尺寸检查是三类不同证据；零问题不代表交互或需求通过。
固定栏遮挡、文本互相重叠、完整交互/可访问性等未覆盖；详见 README.md。
安全: 原型可执行 JS，非恶意代码安全审计沙箱；勿检查不可信来源 HTML。
`;
function parse(argv) {
  if (argv.length === 1 && ['--help', '-h'].includes(argv[0])) return { help: true };
  const [command, file, ...rest] = argv;
  if (!['serve', 'inspect'].includes(command) || !file || file.startsWith('--')) throw new Error('需要 serve|inspect <file.html>；使用 --help');
  const allowed = command === 'serve' ? ['size', 'duration'] : ['size', 'screenshot', 'report', 'timeout', 'browser'];
  const values = {};
  for (let i = 0; i < rest.length; i += 2) {
    const key = rest[i].startsWith('--') ? rest[i].slice(2) : '';
    if (!allowed.includes(key) || key in values || !rest[i + 1] || rest[i + 1].startsWith('--')) throw new Error(`未知、重复或缺值选项: ${rest[i]}`);
    values[key] = rest[i + 1];
  }
  const size = parseSize(values.size);
  for (const [key, min, max] of [['timeout', 3000, 60000], ['duration', 100, 3600000]]) if (values[key] !== undefined && (!/^\d+$/.test(values[key]) || +values[key] < min || +values[key] > max)) throw new Error(`${key} 必须为 ${min}..${max} 毫秒`);
  return { command, file, ...values, size, timeout: +(values.timeout || 15000), duration: values.duration ? +values.duration : undefined };
}
export async function main(argv = process.argv.slice(2)) {
  const options = parse(argv);
  if (options.help) { console.log(HELP); return; }
  let studio;
  const reserved = [];
  let complete = false;
  try {
    // Reserve exclusively before browser launch; never overwrite existing evidence, links or source.
    for (const key of ['screenshot', 'report']) if (options[key]) {
      options[key] = path.resolve(options[key]);
      if (reserved.includes(options[key])) throw new Error('截图和报告不能使用同一路径');
      const handle = await fs.open(options[key], 'wx'); reserved.push(options[key]); await handle.close();
    }
    studio = await startStudio(options.file, options.size);
    if (options.command === 'serve') {
      console.log(JSON.stringify({ evidence: 'preview', url: studio.url, source: studio.source, sourceHash: studio.sourceHash, size: options.size, note: '人工预览入口；不是交互验收' }));
      await new Promise(resolve => {
        const finish = () => { clearTimeout(timer); process.off('SIGINT', finish); process.off('SIGTERM', finish); resolve(); };
        const timer = options.duration ? setTimeout(finish, options.duration) : undefined;
        process.once('SIGINT', finish); process.once('SIGTERM', finish);
      });
      complete = true;
      return;
    }
    const data = await inspectBrowser(studio, options);
    const afterHash = createHash('sha256').update(await fs.readFile(studio.source)).digest('hex');
    const report = {
      schemaVersion: 1, evidence: ['real-render', 'size-check'], timestamp: new Date().toISOString(),
      source: { path: studio.source, sha256: studio.sourceHash, sha256After: afterHash, unchanged: afterHash === studio.sourceHash, hashScope: 'entry HTML bytes only; referenced assets are not hashed' },
      requestedViewport: options.size, ...data.measurements,
      runErrors: data.errors, resources: data.resources, blockedRequests: data.blockedRequests,
      screenshot: options.screenshot ? { path: options.screenshot, width: options.size.width, height: options.size.height, type: 'viewport PNG, device scale 1' } : null,
      runtime: { browser: data.browser, elapsedMs: data.elapsedMs, cleanup: 'browser exited and temporary profile removed before report; servers close before CLI exit' },
      scope: { automaticActions: 'read-only DOM measurement, no clicks, input or form submissions; non-GET/HEAD/OPTIONS and outside-preview-origin requests blocked', contentPolicy: 'CSP limits resources to self/data/blob, scripts/styles to self/inline; connections and forms disabled', sandbox: 'allow-scripts only, separate loopback origin; identical prototype frame in preview and inspect', covered: ['visible horizontal overflow', 'direct text element overflow clipping heuristic', 'unavailable visible images', 'small text', 'small target heuristic', 'simple opaque color contrast heuristic', 'observed runtime/console errors and failed HTTP/resources'], notCovered: ['fixed/sticky bar occlusion and bottom spacing', 'text overlap, long lines and short-word wrapping', 'offscreen/lazy-loaded states and full-page scroll checks', 'CSS pseudo-elements, canvas/WebGL pixels, shadow DOM and nested frames', 'image aspect-ratio distortion', 'link destination existence', 'full accessibility, interactions, navigation and requirements acceptance', 'all asynchronous failures after bounded observation window', 'complex clipping paths, rotated/3D transforms and containing-block clipping relationships', 'external resources and fetch/XHR/WebSocket dependent prototypes (blocked by policy)', 'local ES modules/fonts requiring CORS from opaque sandbox origins', 'external asset reproducibility and adversarial/malicious prototype safety'], verdict: 'Observations only. Zero findings does not mean interactions or requirements passed.' },
    };
    if (!report.source.unchanged) throw new Error('检查期间入口 HTML 发生变化；拒绝生成混合版本证据');
    if (options.screenshot) await fs.writeFile(options.screenshot, data.screenshot);
    if (options.report) await fs.writeFile(options.report, JSON.stringify(report, null, 2) + '\n');
    console.log(JSON.stringify(report, null, 2));
    complete = true;
  } finally {
    if (studio) await studio.close();
    if (!complete) await Promise.all(reserved.map(file => fs.unlink(file).catch(() => {})));
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) main().catch(error => { console.error(`Design Studio: ${error.message}`); process.exitCode = 1; });
