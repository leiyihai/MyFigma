import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, realpath, copyFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { helperDir, helperExecutable, startHelper, withTimeout } from './fixture.mjs';

async function tempRoot(label) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'atlas-issue11-' + label + '-')));
  await mkdir(join(root, 'data'));
  await mkdir(join(root, 'project'));
  await copyFile(join(helperDir, 'examples/tiny.png'), join(root, 'project', 'tiny.png'));
  await copyFile(join(helperDir, 'examples/tiny.json'), join(root, 'project', 'tiny.json'));
  return root;
}

async function assertPortClosed(base) {
  await assert.rejects(fetch(base + '/v1/health'), '已退出助手的端口必须拒绝新连接');
}

test('explicit show-token reads the existing token without starting a server', async () => {
  const root = await tempRoot('show-token');
  let helper;
  try {
    helper = await startHelper(join(root, 'data'), { tray: false });
    const result = await new Promise((resolve, reject) => {
      const child = spawn(helperExecutable(), ['--data-dir', join(root, 'data'), '--show-token'], { stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '', stderr = '';
      child.stdout.on('data', chunk => { stdout += chunk; });
      child.stderr.on('data', chunk => { stderr += chunk; });
      child.on('error', reject);
      child.on('exit', code => resolve({ code, stdout, stderr }));
    });
    assert.equal(result.code, 0);
    assert.match(result.stdout, new RegExp('PAIRING TOKEN: ' + helper.token));
    assert.equal(result.stderr, '');
  } finally { if (helper) await helper.stop(); await rm(root, { recursive: true, force: true }); }
});

test('built helper runs from a copied artifact without a development server and closes its port after a graceful exit', async () => {
  const root = await tempRoot('artifact');
  try {
    const artifact = join(root, 'artifact');
    await mkdir(artifact);
    const exe = join(artifact, 'figma-assets-helper' + (process.platform === 'win32' ? '.exe' : ''));
    await copyFile(helperExecutable(), exe);
    const data = join(root, 'data'), project = join(root, 'project');
    const helper = await startHelper(data, { exe, cwd: artifact, args: ['--test-exit-after-ms', '2500'] });
    try {
      assert.equal((await helper.request('/v1/health')).status, 200);
      assert.equal((await helper.request('/v1/projects', 'PUT', { id: 'g2', name: '测试游戏', path: project, maintained: true })).status, 200);
      const scan = await (await helper.request('/v1/scan', 'POST', { projectId: 'g2' })).json();
      assert.equal(scan.resources.length, 2);
    } finally {
      const exited = await withTimeout(helper.exited, 10000, 'helper exit');
      assert.deepEqual(exited, { code: 0, signal: null });
    }
    assert.match(helper.output.stdout, /STOP/);
    await assertPortClosed(helper.base);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('default startup installs the tray icon and the tray exit path shuts the helper down', async () => {
  const root = await tempRoot('tray');
  try {
    const data = join(root, 'data');
    // 不带 --no-tray：走生产默认托盘路径；测试钩子只驱动与托盘菜单相同的退出命令。
    const helper = await startHelper(data, { tray: true, args: ['--test-exit-after-ms', '2500'] });
    try {
      assert.equal(await helper.waitForOutput(/TRAY ready/), true, '默认启动必须创建托盘图标：' + JSON.stringify(helper.output));
      assert.equal((await helper.request('/v1/health')).status, 200);
    } finally {
      assert.deepEqual(await withTimeout(helper.exited, 10000, 'tray helper exit'), { code: 0, signal: null });
    }
    assert.match(helper.output.stdout, /STOP/);
    await assertPortClosed(helper.base);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('registration and pairing token persist across a restart served by the tray default path', async () => {
  const root = await tempRoot('restart');
  let helper, restarted;
  try {
    const data = join(root, 'data'), project = join(root, 'project');
    helper = await startHelper(data);
    const projects = [
      { id: 'g2', name: '测试游戏', path: project, maintained: true },
      { id: 'g3', name: '副本游戏', path: project, maintained: false },
    ];
    for (const entry of projects) assert.equal((await helper.request('/v1/projects', 'PUT', entry)).status, 200);
    const token = helper.token;
    await helper.stop();
    restarted = await startHelper(data, { tray: true, args: ['--test-exit-after-ms', '2500'] });
    assert.equal(restarted.token, token, '重启后配对令牌必须保持不变');
    assert.deepEqual((await (await restarted.request('/v1/projects')).json()).projects, projects);
    const scan = await (await restarted.request('/v1/scan', 'POST', { projectId: 'g3' })).json();
    assert.deepEqual(scan.resources.map(resource => resource.source.frameName).sort(), ['green', 'red']);
    assert.deepEqual(await withTimeout(restarted.exited, 10000, 'restarted helper exit'), { code: 0, signal: null });
    await assertPortClosed(restarted.base);
  } finally {
    if (restarted) await restarted.stop();
    if (helper) await helper.stop();
    await rm(root, { recursive: true, force: true });
  }
});

test('helper output never contains the data directory, pairing token or registered project path', async () => {
  const root = await tempRoot('logs');
  try {
    const data = join(root, 'data'), project = join(root, 'project');
    const helper = await startHelper(data, { args: ['--test-exit-after-ms', '2500'] });
    assert.equal((await helper.request('/v1/projects', 'PUT', { id: 'g2', name: '测试游戏', path: project, maintained: true })).status, 200);
    assert.equal((await helper.request('/v1/scan', 'POST', { projectId: 'g2' })).status, 200);
    await withTimeout(helper.exited, 10000, 'helper exit');
    const logs = helper.logs();
    assert.equal(logs.includes(data), false, '日志不得包含本机数据目录');
    assert.equal(logs.includes(project), false, '日志不得包含登记项目路径');
    assert.equal(logs.includes(helper.token), false, '日志不得包含配对令牌');
    assert.equal(logs.includes(helperDir), false, '日志不得包含开发者本机绝对路径');
    assert.equal(helper.token, (await readFile(join(data, 'token'), 'utf8')).trim());
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
