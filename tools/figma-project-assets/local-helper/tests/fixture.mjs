import { mkdtemp, mkdir, readFile, rm, realpath, copyFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
export const helperDir = fileURLToPath(new URL('../', import.meta.url));
const sleep = ms => new Promise(done => setTimeout(done, ms));
export function helperExecutable() {
  return resolve(helperDir, 'target/debug/resource-helper' + (process.platform === 'win32' ? '.exe' : ''));
}
// 测试通过 --no-tray 显式跳过托盘；托盘默认路径由 tray.test.mjs 单独覆盖。
export async function startHelper(dataDir, options = {}) {
  const { tray = false, exe = helperExecutable(), cwd, args = [] } = options;
  const argv = ['--data-dir', dataDir, '--port', '0', ...(tray ? [] : ['--no-tray']), ...args];
  const child = spawn(exe, argv, { stdio: ['ignore', 'pipe', 'pipe'], ...(cwd ? { cwd } : {}) });
  const output = { stdout: '', stderr: '' };
  child.stdout.on('data', chunk => { output.stdout += chunk; });
  child.stderr.on('data', chunk => { output.stderr += chunk; });
  const exited = new Promise(done => child.once('exit', (code, signal) => done({ code, signal })));
  let listening = false;
  const port = await new Promise((done, fail) => {
    const timer = setTimeout(() => fail(new Error('helper startup timeout: ' + JSON.stringify(output))), 10000);
    const onData = () => {
      const match = output.stdout.match(/LISTEN (\d+)/);
      if (!match) return;
      listening = true;
      clearTimeout(timer);
      child.stdout.off('data', onData);
      done(Number(match[1]));
    };
    child.stdout.on('data', onData);
    child.once('error', error => { clearTimeout(timer); fail(error); });
    child.once('exit', code => {
      if (listening) return;
      clearTimeout(timer);
      fail(new Error('helper exited before listening: ' + code + ' ' + JSON.stringify(output)));
    });
  });
  const token = (await readFile(join(dataDir, 'token'), 'utf8')).trim();
  const base = 'http://localhost:' + port;
  return {
    base, token, port, child, output, exited,
    async waitForOutput(pattern, timeout = 10000) {
      const deadline = Date.now() + timeout;
      while (Date.now() < deadline) {
        if (pattern.test(output.stdout + output.stderr)) return true;
        if (child.exitCode !== null || child.signalCode !== null) return false;
        await sleep(20);
      }
      return false;
    },
    logs() { return output.stdout + output.stderr; },
    async stop() {
      if (child.exitCode !== null || child.signalCode !== null) return;
      child.kill();
      await exited;
    },
    async request(path, method = 'GET', body, headers = {}) {
      return fetch(base + path, { method, headers: { Authorization: 'Bearer ' + token, ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined });
    },
  };
}
export function withTimeout(promise, timeout = 10000, label = 'operation') {
  let timer;
  const expired = new Promise((_, fail) => {
    timer = setTimeout(() => fail(new Error(label + ' timed out after ' + timeout + 'ms')), timeout);
  });
  return Promise.race([promise, expired]).finally(() => clearTimeout(timer));
}
export async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'atlas-issue2-')));
  const project = join(root, 'project'), data = join(root, 'data');
  await mkdir(project); await mkdir(data);
  await copyFile(join(helperDir, 'examples/tiny.png'), join(project, 'tiny.png'));
  await copyFile(join(helperDir, 'examples/tiny.json'), join(project, 'tiny.json'));
  const server = await startHelper(data);
  return { root, project, data, ...server, async cleanup() { await server.stop(); await rm(root, { recursive: true, force: true }); } };
}
