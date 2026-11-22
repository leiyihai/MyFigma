import 'ses';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fixture } from '../../local-helper/tests/fixture.mjs';
import { figmaFixture } from './platform-fixture.mjs';

test('built main script loads in an import-rejecting sandbox, stores pairing locally, and handles validate/import', async () => {
  const code = await readFile(new URL('../dist/code.js', import.meta.url), 'utf8');
  const { api: figma, page, root, storage, externalUrls } = figmaFixture();
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
  assert.equal(shownOptions.width, 350);
  assert.equal(shownOptions.height, 540);
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
  await figma.ui.onmessage({type:'helper-path-load',requestId:16});
  assert.equal(replies.find(reply=>reply.requestId===16).result,'');
  await figma.ui.onmessage({type:'helper-path-save',requestId:17,path:'E:\\Tools\\resource-helper'});
  assert.equal(replies.find(reply=>reply.requestId===17).result,'E:\\Tools\\resource-helper');
  await figma.ui.onmessage({type:'helper-path-load',requestId:18});
  assert.equal(replies.find(reply=>reply.requestId===18).result,'E:\\Tools\\resource-helper');
  await figma.ui.onmessage({type:'open-helper-folder',requestId:19,path:'E:\\Tools\\resource-helper'});
  assert.equal(replies.find(reply=>reply.requestId===19).result,true);
  assert.equal(externalUrls.length,1);
  assert.match(externalUrls[0],/^file:\/\/\/E:/);
  await figma.ui.onmessage({ type: 'validate', requestId: 1, project: { id: 'g2', name: '测试游戏' } });
  assert.equal(replies.find(reply => reply.requestId === 1).result.valid, true);
  // The UI reads the ordered page categories over RPC; a blank page uses the default seven.
  await figma.ui.onmessage({ type: 'categories', requestId: 5 });
  const categoriesReply = replies.find(reply => reply.requestId === 5);
  assert.equal(categoriesReply.error, undefined);
  assert.equal(categoriesReply.result.schemaVersion, 1);
  assert.deepEqual(categoriesReply.result.categories.map(category => category.name),
    ['按钮','底板','图标','背景','艺术字','进度条','未分类']);
  assert.equal(page.getPluginData('atlas.categories.v1'), '');

  const f = await fixture();
  try {
    await f.request('/v1/projects', 'PUT', { id: 'g2', name: '测试游戏', path: f.project, maintained: true });
    const scan = await (await f.request('/v1/scan', 'POST', { projectId: 'g2' })).json();
    // Cancelling before the first item must stop scheduling and leave the page untouched.
    const importing = figma.ui.onmessage({ type: 'import', requestId: 20, scan });
    await figma.ui.onmessage({ type: 'cancel' });
    await importing;
    const cancelled = replies.find(reply => reply.requestId === 20);
    assert.equal(cancelled.error, undefined);
    assert.equal(cancelled.result.cancelled, true);
    assert.deepEqual(cancelled.result.applied, { added: 0, updated: 0, removed: 0 });
    assert.equal(page.children.length, 0);
    assert.equal(page.name, 'Page 1');
    assert.equal(page.getPluginData('atlas.binding'), '');
    await figma.ui.onmessage({ type: 'import', requestId: 2, scan });
    const result = replies.find(reply => reply.requestId === 2);
    assert.equal(result.error, undefined);
    assert.equal(result.result.added, 2);
    assert.deepEqual(result.result.applied, { added: 2, updated: 0, removed: 0 });
    assert.deepEqual([result.result.failures.length, result.result.cancelled], [0, false]);
    assert.equal(page.name, '测试游戏（g2）- 分类资源');
    assert.equal(page.children[0].children.length, 2);
    assert.equal(replies.filter(reply => reply.type === 'progress').at(-1).progress.done, 2);
    await figma.ui.onmessage({ type: 'tidy', requestId: 4, project: { id: 'g2', name: '测试游戏' } });
    const tidied = replies.find(reply => reply.requestId === 4);
    assert.equal(tidied.error, undefined);
    assert.equal(tidied.result.frames, 1);
    assert.equal(page.children[0].x, 0);
    assert.equal(page.children[0].y, 0);
    assert.equal(page.children[0].children.length, 2);
    await figma.ui.onmessage({ type: 'compare', requestId: 3, project: { id: 'g2', name: '测试游戏' } });
    const compared = replies.find(reply => reply.requestId === 3);
    assert.equal(compared.error, undefined);
    assert.equal(compared.result.created, true);
    assert.equal(compared.result.added, 2);
    assert.equal(compared.result.groups, 1);
    assert.equal(root.children.length, 2);
    assert.equal(root.children[1].name, '测试游戏（g2）- 图集对照');
    assert.equal(page.children[0].children.length, 2);
    events.get('currentpagechange')();
    assert.equal(replies.at(-1).type, 'page-changed');
  } finally { await f.cleanup(); }
});
