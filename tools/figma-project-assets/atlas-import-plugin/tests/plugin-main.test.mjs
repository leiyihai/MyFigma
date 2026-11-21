import 'ses';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fixture } from '../../local-helper/tests/fixture.mjs';
import { figmaFixture } from './platform-fixture.mjs';

test('built main script loads in an import-rejecting sandbox, stores pairing locally, and handles validate/import', async () => {
  const code = await readFile(new URL('../dist/code.js', import.meta.url), 'utf8');
  const { api: figma, page } = figmaFixture();
  const replies = [];
  const events = new Map();
  let shownHtml,shownOptions;
  figma.showUI = (html,options) => { shownHtml = html; shownOptions = options; };
  figma.ui = { postMessage: message => replies.push(message) };
  figma.on = (name, handler) => events.set(name, handler);
  // Use a real secure evaluator, not a regex pretending to be the Figma runtime.
  // SES catches the same import-expression rejection; it does not emulate rendering.
  const sandbox = new globalThis.Compartment({ figma, __html__: '<p>plugin UI</p>', setTimeout });
  sandbox.evaluate(code);
  assert.equal(shownHtml, '<p>plugin UI</p>');
  assert.equal(shownOptions.width, 520);
  assert.equal(shownOptions.height, 720);
  const pairing={schemaVersion:1,address:'http://localhost:38473',token:'a'.repeat(64)};
  await figma.ui.onmessage({type:'pairing-load',requestId:10});
  assert.equal(replies.find(reply=>reply.requestId===10).result,null);
  await figma.ui.onmessage({type:'pairing-save',requestId:11,pairing});
  assert.equal(replies.find(reply=>reply.requestId===11).result,true);
  await figma.ui.onmessage({type:'pairing-load',requestId:12});
  assert.deepEqual(replies.find(reply=>reply.requestId===12).result,pairing);
  assert.equal(JSON.stringify(page).includes(pairing.token),false);
  await figma.ui.onmessage({type:'pairing-save',requestId:13,pairing:{...pairing,token:'bad'}});
  assert.match(replies.find(reply=>reply.requestId===13).error,/无效/);
  await figma.ui.onmessage({type:'pairing-clear',requestId:14});
  assert.equal(replies.find(reply=>reply.requestId===14).result,true);
  await figma.ui.onmessage({type:'pairing-load',requestId:15});
  assert.equal(replies.find(reply=>reply.requestId===15).result,null);
  await figma.ui.onmessage({ type: 'validate', requestId: 1, project: { id: 'g2', name: '测试游戏' } });
  assert.equal(replies.find(reply => reply.requestId === 1).result.valid, true);

  const f = await fixture();
  try {
    await f.request('/v1/projects', 'PUT', { id: 'g2', name: '测试游戏', path: f.project, maintained: true });
    const scan = await (await f.request('/v1/scan', 'POST', { projectId: 'g2' })).json();
    await figma.ui.onmessage({ type: 'import', requestId: 2, scan });
    const result = replies.find(reply => reply.requestId === 2);
    assert.equal(result.error, undefined);
    assert.equal(result.result.added, 2);
    assert.equal(page.name, '测试游戏（g2）- 分类资源');
    assert.equal(page.children[0].children.length, 2);
    assert.equal(replies.filter(reply => reply.type === 'progress').at(-1).progress.done, 2);
    events.get('currentpagechange')();
    assert.equal(replies.at(-1).type, 'page-changed');
  } finally { await f.cleanup(); }
});
