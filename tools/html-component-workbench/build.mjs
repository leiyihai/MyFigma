import {readFile, readdir, mkdir, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root = path.dirname(fileURLToPath(import.meta.url));
async function files(dir, suffix) {
  try { return (await readdir(path.join(root, dir))).filter(f => f.endsWith(suffix)).sort().map(f => `${dir}/${f}`); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
}
const read = file => readFile(path.join(root, file), 'utf8');
const scripts = await files('src/features', '.js');
const styles = await files('src/features', '.css');
const bridgeFeatures = await files('src/bridge-features', '.js');
const bridge = [await read('src/prototype-bridge.js'), ...await Promise.all(bridgeFeatures.map(read))].join('\n');
const sources = ['src/project.js', 'src/host.js', 'src/shell.js', 'src/app.js'];
const css = [await read('src/shell.css'), ...await Promise.all(styles.map(read))].join('\n');
const boot = `window.WORKBENCH_BUILD=${JSON.stringify({bridge, example:await read('examples/controlled.html')}).replace(/</g, '\\u003c')};`;
const code = [boot, ...await Promise.all(sources.map(read)), ...await Promise.all(scripts.map(read)), 'Workbench.start();'].join('\n');
const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>HTML 组件拆分工作台</title><style>${css}</style></head><body><div id="workbench"></div><script>${code.replace(/<\/script/gi,'<\\/script')}</script></body></html>`;
await mkdir(path.join(root, 'dist'), {recursive:true});
await writeFile(path.join(root, 'dist/workbench.html'), html);
console.log(`Built dist/workbench.html (${Buffer.byteLength(html)} bytes), ${scripts.length} features, ${bridgeFeatures.length} bridge features`);
