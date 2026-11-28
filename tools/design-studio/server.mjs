import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';

export function parseSize(value = '1280x720') {
  const match = /^(\d{2,4})x(\d{2,4})$/.exec(value);
  if (!match || +match[1] < 100 || +match[2] < 100 || +match[1] > 4096 || +match[2] > 4096) throw new Error('size 必须为 100..4096 范围内的 WIDTHxHEIGHT');
  return { width: +match[1], height: +match[2] };
}
const mime = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript', '.mjs': 'text/javascript', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.woff2': 'font/woff2', '.woff': 'font/woff', '.gif': 'image/gif' };
const listen = server => new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', () => resolve(server.address().port)); });
const stop = server => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
export async function startStudio(file, size = parseSize(), { query = '' } = {}) {
  if (typeof query !== 'string' || query.length > 2048) throw new Error('query 必须是最多 2048 字符的查询字符串');
  size = parseSize(`${size.width}x${size.height}`);
  const source = await fs.realpath(path.resolve(file));
  if (!(await fs.stat(source)).isFile() || !/\.html?$/i.test(source)) throw new Error('需要现存 HTML 文件');
  const root = path.dirname(source);
  const sourceHash = createHash('sha256').update(await fs.readFile(source)).digest('hex');
  const content = http.createServer(async (req, res) => {
    if (req.headers.host !== `127.0.0.1:${content.address()?.port}`) { res.writeHead(403).end(); return; }
    try {
      if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405).end(); return; }
      const raw = req.url.split('?')[0];
      const decoded = decodeURIComponent(raw);
      if (decoded.includes('\\') || decoded.includes('\0') || decoded.split('/').some(p => p === '..' || p === '.')) { res.writeHead(403).end(); return; }
      const candidate = await fs.realpath(path.resolve(root, '.' + decoded));
      const relative = path.relative(root, candidate);
      if (relative.startsWith('..' + path.sep) || relative === '..' || path.isAbsolute(relative) || !(await fs.stat(candidate)).isFile()) { res.writeHead(403).end(); return; }
      const bytes = await fs.readFile(candidate);
      res.writeHead(200, { 'Content-Type': mime[path.extname(candidate).toLowerCase()] || 'application/octet-stream', 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-store', 'Content-Security-Policy': "default-src 'self' data: blob:; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'none'; form-action 'none'; base-uri 'self'; object-src 'none'; frame-ancestors http://127.0.0.1:*" });
      res.end(req.method === 'HEAD' ? undefined : bytes);
    } catch { res.writeHead(404).end(); }
  });
  let control;
  try {
    const contentPort = await listen(content);
    const params = new URLSearchParams(query).toString();
    const contentUrl = `http://127.0.0.1:${contentPort}/${encodeURIComponent(path.basename(source))}${params ? '?' + params : ''}`;
    control = http.createServer((req, res) => {
      if (req.headers.host !== `127.0.0.1:${control.address()?.port}`) { res.writeHead(403).end(); return; }
      const pathname = req.url.split('?')[0];
      if (!['GET', 'HEAD'].includes(req.method) || !['/', '/render'].includes(pathname)) { res.writeHead(404).end(); return; }
      const render = pathname === '/render';
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Security-Policy': `default-src 'none'; frame-src http://127.0.0.1:${contentPort}; script-src 'unsafe-inline'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'` });
      if (req.method === 'HEAD') { res.end(); return; }
      res.end(`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>Design Studio</title><style>html,body{margin:0;font:14px system-ui;background:#ddd}header{padding:12px;background:#fff}label{margin-right:12px}input{width:80px}iframe{display:block;border:0;background:white;width:${render ? '100vw' : size.width + 'px'};height:${render ? '100vh' : size.height + 'px'}}main{${render ? '' : 'padding:16px;overflow:auto'}}p{margin:8px 0}</style>${render ? '' : `<header><strong>Design Studio · 本地 HTML 预览</strong><p>预览不是检查报告，更不代表交互通过。原型位于隔离 sandbox，表单、弹窗和同源权限禁用。</p><label>宽 <input id="w" type="number" min="100" max="4096" value="${size.width}"></label><label>高 <input id="h" type="number" min="100" max="4096" value="${size.height}"></label><button id="apply">应用尺寸</button><span id="status"> ${size.width} × ${size.height}</span></header>`}<main><iframe title="原型预览" sandbox="allow-scripts" src="${contentUrl.replaceAll('&', '&amp;')}"></iframe></main>${render ? '' : `<script>document.querySelector('#apply').onclick=()=>{let w=Number(document.querySelector('#w').value),h=Number(document.querySelector('#h').value);if(!Number.isInteger(w)||!Number.isInteger(h)||w<100||h<100||w>4096||h>4096){alert('尺寸范围 100..4096');return}let f=document.querySelector('iframe');f.style.width=w+'px';f.style.height=h+'px';document.querySelector('#status').textContent=' '+w+' × '+h;};</script>`}</html>`);
    });
    const port = await listen(control);
    let closed = false;
    return { source, root, sourceHash, url: `http://127.0.0.1:${port}`, contentUrl, async close() { if (closed) return; closed = true; await Promise.all([stop(content), stop(control)]); } };
  } catch (error) { await Promise.all([stop(content), ...(control ? [stop(control)] : [])]); throw error; }
}
