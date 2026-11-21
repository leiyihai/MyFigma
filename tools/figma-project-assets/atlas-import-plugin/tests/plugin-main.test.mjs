import 'ses';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fixture } from '../../local-helper/tests/fixture.mjs';
import { figmaFixture } from './platform-fixture.mjs';

test('built main script loads in an import-rejecting sandbox and handles validate and import messages', async () => {
  const code = await readFile(new URL('../dist/code.js', import.meta.url), 'utf8');
  const { api: figma, page } = figmaFixture();
  const replies = [];
  const events = new Map();
  let shownHtml;
  figma.showUI = html => { shownHtml = html; };
  figma.ui = { postMessage: message => replies.push(message) };
  figma.on = (name, handler) => events.set(name, handler);
  // Use a real secure evaluator, not a regex pretending to be the Figma runtime.
  // SES catches the same import-expression rejection; it does not emulate rendering.
  const sandbox = new globalThis.Compartment({ figma, __html__: '<p>plugin UI</p>', setTimeout });
  sandbox.evaluate(code);
  assert.equal(shownHtml, '<p>plugin UI</p>');
  await figma.ui.onmessage({ type: 'validate', requestId: 1, project: { id: 'g2', name: '测试游戏' } });
  assert.equal(replies.find(reply => reply.requestId === 1).result.valid, true);

  const f = await fixture();
  try {
    await f.request('/v1/projects', 'PUT', { id: 'g2', name: '测试游戏', path: f.project, maintained: true });
    const scan = await (await f.request('/v1/scan', 'POST', { projectId: 'g2' })).json();
    await figma.ui.onmessage({ type: 'import', requestId: 2, scan });
    const result = replies.find(reply => reply.requestId === 2);
    assert.equal(result.error, undefined);
    assert.equal(result.result, null);
    assert.equal(page.name, '测试游戏（g2）- 分类资源');
    assert.equal(page.children[0].children.length, 2);
    assert.equal(replies.filter(reply => reply.type === 'progress').at(-1).progress.done, 2);
    events.get('currentpagechange')();
    assert.equal(replies.at(-1).type, 'page-changed');
  } finally { await f.cleanup(); }
});
