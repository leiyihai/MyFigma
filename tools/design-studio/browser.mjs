import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { measure } from './checks.mjs';

class CDP {
  constructor(ws) { this.ws = ws; this.seq = 0; this.pending = new Map(); this.listeners = new Map(); ws.addEventListener('message', event => { const data = JSON.parse(event.data); if (data.id) { const p = this.pending.get(data.id); if (p) { this.pending.delete(data.id); clearTimeout(p.timer); data.error ? p.reject(new Error(data.error.message)) : p.resolve(data.result); } } else for (const callback of this.listeners.get(data.method) || []) callback(data.params); }); }
  on(name, callback) { const list = this.listeners.get(name) || []; list.push(callback); this.listeners.set(name, list); }
  send(method, params = {}) { return new Promise((resolve, reject) => { const id = ++this.seq; const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`CDP timeout: ${method}`)); }, 5000); this.pending.set(id, { resolve, reject, timer }); this.ws.send(JSON.stringify({ id, method, params })); }); }
  close() { for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(new Error('CDP closed')); } this.pending.clear(); this.ws.close(); }
}
async function browserPath(explicit) {
  const candidates = explicit ? [explicit] : [process.env.DESIGN_STUDIO_BROWSER, 'C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', '/usr/bin/google-chrome', '/usr/bin/chromium', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'].filter(Boolean);
  for (const candidate of candidates) { try { await fs.access(candidate); return candidate; } catch {} }
  throw new Error('未找到 Chrome/Edge；使用 --browser <executable>');
}
export async function inspectBrowser(studio, options) {
  const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'design-studio-'));
  let child, cdp, pid, cleanupError;
  const started = Date.now(), errors = [], resources = [], blockedRequests = [];
  try {
    const executable = await browserPath(options.browser);
    child = spawn(executable, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--disable-background-networking', '--disable-extensions', '--disable-sync', '--disable-component-update', '--disable-site-isolation-trials', '--remote-debugging-port=0', '--remote-debugging-address=127.0.0.1', `--user-data-dir=${profile}`, 'about:blank'], { stdio: 'ignore', windowsHide: true });
    pid = child.pid;
    let launchError;
    child.once('error', error => { launchError = error; });
    let port;
    while (Date.now() - started < options.timeout) {
      if (launchError) throw launchError;
      if (child.exitCode !== null) throw new Error(`浏览器提前退出: ${child.exitCode}`);
      try { port = +(await fs.readFile(path.join(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0]; if (port) break; } catch {}
      await delay(80);
    }
    if (!port) throw new Error('浏览器启动超时');
    const response = await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT', signal: AbortSignal.timeout(3000) });
    const target = await response.json();
    const ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => { const timer = setTimeout(() => reject(new Error('WebSocket timeout')), 3000); ws.addEventListener('open', () => { clearTimeout(timer); resolve(); }, { once: true }); ws.addEventListener('error', () => { clearTimeout(timer); reject(new Error('WebSocket connection failed')); }, { once: true }); });
    cdp = new CDP(ws);
    cdp.on('Runtime.exceptionThrown', ({ exceptionDetails: e }) => { if (errors.length < 200) errors.push({ kind: 'runtime-exception', text: e.exception?.description || e.text, url: e.url, line: e.lineNumber }); });
    cdp.on('Runtime.consoleAPICalled', e => { if (e.type === 'error' && errors.length < 200) errors.push({ kind: 'console-error', text: e.args.map(a => a.value ?? a.description ?? '').join(' ') }); });
    cdp.on('Log.entryAdded', ({ entry }) => { if (entry.level === 'error' && errors.length < 200) errors.push({ kind: 'browser-log', source: entry.source, text: entry.text, url: entry.url }); });
    cdp.on('Network.loadingFailed', e => { if (resources.length < 500) resources.push({ kind: 'load-failed', requestId: e.requestId, error: e.errorText, blockedReason: e.blockedReason, type: e.type }); });
    const urls = new Map();
    cdp.on('Network.requestWillBeSent', e => { if (urls.size < 5000) urls.set(e.requestId, e.request.url); });
    cdp.on('Network.responseReceived', e => { if (e.response.status >= 400 && resources.length < 500) resources.push({ kind: 'http-error', url: e.response.url, status: e.response.status, type: e.type }); });
    cdp.on('Fetch.requestPaused', e => {
      let local = false;
      try { const u = new URL(e.request.url); local = [new URL(studio.url).origin, new URL(studio.contentUrl).origin].includes(u.origin) || ['data:', 'blob:', 'about:'].includes(u.protocol); } catch {}
      const allowed = local && ['GET', 'HEAD', 'OPTIONS'].includes(e.request.method);
      if (!allowed && blockedRequests.length < 200) blockedRequests.push({ url: e.request.url, method: e.request.method, reason: local ? 'non-read-only method' : 'outside preview origins' });
      cdp.send(allowed ? 'Fetch.continueRequest' : 'Fetch.failRequest', allowed ? { requestId: e.requestId } : { requestId: e.requestId, errorReason: 'BlockedByClient' }).catch(() => {});
    });
    await cdp.send('Page.enable'); await cdp.send('Runtime.enable'); await cdp.send('Network.enable'); await cdp.send('Log.enable');
    await cdp.send('Fetch.enable', { patterns: [{ urlPattern: '*' }] });
    await cdp.send('Emulation.setDeviceMetricsOverride', { ...options.size, deviceScaleFactor: 1, mobile: false });
    await cdp.send('Page.navigate', { url: studio.url + '/render' });
    let frame, contextId, ready = false;
    while (Date.now() - started < options.timeout - 500) {
      try {
        const tree = await cdp.send('Page.getFrameTree');
        frame = tree.frameTree.childFrames?.find(f => f.frame.url === studio.contentUrl)?.frame;
        if (frame) {
          const world = await cdp.send('Page.createIsolatedWorld', { frameId: frame.id, worldName: 'design-studio-measurement' }); contextId = world.executionContextId;
          const result = await cdp.send('Runtime.evaluate', { expression: 'document.readyState', contextId, returnByValue: true });
          if (result.result.value === 'complete') { ready = true; break; }
        }
      } catch {}
      await delay(100);
    }
    if (!ready) throw new Error('原型加载超时或无法建立隔离测量上下文');
    // Explicit trusted module callers may drive native CDP Input; never exposed by CLI.
    let interactionResult;
    if (options.onReady) {
      let timer;
      try {
        interactionResult = await Promise.race([
          options.onReady({ send: cdp.send.bind(cdp), frameId: frame.id, contextId, url: studio.contentUrl }),
          new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('onReady interaction hook timeout')), options.timeout); }),
        ]);
      } finally { clearTimeout(timer); }
    }
    // A bounded observation window, not a claim of complete async/network quiescence.
    await delay(Math.min(500, Math.max(0, options.timeout - (Date.now() - started) - 200)));
    const result = await cdp.send('Runtime.evaluate', { expression: `(${measure.toString()})()`, contextId, returnByValue: true });
    if (result.exceptionDetails || !result.result.value) throw new Error('DOM 测量失败');
    const screenshot = options.screenshot ? Buffer.from((await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false, fromSurface: true })).data, 'base64') : null;
    return { measurements: result.result.value, screenshot, interactionResult, errors, resources: resources.map(e => ({ ...e, url: e.url || urls.get(e.requestId) })), blockedRequests, browser: { executable, pid, profile }, elapsedMs: Date.now() - started };
  } finally {
    if (cdp) { try { await cdp.send('Browser.close'); } catch {} cdp.close(); }
    if (child?.pid) {
      if (child.exitCode === null && child.signalCode === null) {
        if (process.platform === 'win32') await new Promise(resolve => { const killer = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }); killer.once('exit', resolve); killer.once('error', resolve); });
        else child.kill('SIGKILL');
      }
      for (let i = 0; i < 30 && child.exitCode === null && child.signalCode === null; i++) await delay(100);
      if (child.exitCode === null && child.signalCode === null) cleanupError = '浏览器进程未确认退出';
    }
    try { await fs.rm(profile, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }); } catch (e) { cleanupError = `临时 profile 清理失败: ${e.message}`; }
    if (cleanupError) throw new Error(cleanupError);
  }
}
