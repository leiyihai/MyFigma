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
  assert.equal(shownOptions.height, 600);
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
    // 训练样本 RPC 只回人工覆盖的「来源身份 + 类别」，自动分类不进入。
    // 与本文其他 RPC 用例的 requestId 错开，避免与类别新增/删除用例相互覆盖回复。
    const manual = page.findAll(node => node.type === 'COMPONENT')[0];
    manual.setPluginData('atlas.category.manual', '按钮');
    await figma.ui.onmessage({ type: 'training-samples', requestId: 26, project: { id: 'g2', name: '测试游戏' } });
    const samplesReply = replies.find(reply => reply.requestId === 26);
    assert.equal(samplesReply.error, undefined);
    assert.deepEqual(samplesReply.result.samples, [{
      identity: JSON.parse(manual.getPluginData('atlas.source')).identity, category: '按钮'
    }]);
    // 命名规律 RPC：回读摘要（条数 + 预计命中），清空写入空规则且不立即重学。
    for (const node of page.findAll(node => node.type === 'COMPONENT')) {
      node.setPluginData('atlas.category.manual', '按钮');
    }
    await figma.ui.onmessage({ type: 'categories', requestId: 31 });
    const rulesReply = replies.find(reply => reply.requestId === 31);
    assert.equal(rulesReply.error, undefined);
    assert.deepEqual(Object.keys(rulesReply.result.rules).sort(), ['count', 'estimatedHits']);
    assert.equal(Number.isInteger(rulesReply.result.rules.count), true);
    assert.equal(Number.isInteger(rulesReply.result.rules.estimatedHits), true);
    await figma.ui.onmessage({ type: 'clear-category-rules', requestId: 32, project: { id: 'g2', name: '测试游戏' } });
    const clearedRules = replies.find(reply => reply.requestId === 32);
    assert.equal(clearedRules.error, undefined);
    assert.deepEqual(clearedRules.result.rules, { count: 0, estimatedHits: 0 });
    // 清空提示只来自平台返回的 message，主线程不再另写一份文案。
    assert.match(clearedRules.result.message, /已清空命名规律/);
    assert.deepEqual(JSON.parse(page.getPluginData('atlas.category.rules.v1')), { schemaVersion: 1, rules: [] });
    await figma.ui.onmessage({ type: 'categories', requestId: 33 });
    assert.deepEqual(replies.find(reply => reply.requestId === 33).result.rules, { count: 0, estimatedHits: 0 });
    await figma.ui.onmessage({ type: 'clear-category-rules', requestId: 34 });
    assert.match(replies.find(reply => reply.requestId === 34).error, /项目信息无效/);
    await figma.ui.onmessage({ type: 'tidy', requestId: 4, project: { id: 'g2', name: '测试游戏' } });
    const tidied = replies.find(reply => reply.requestId === 4);
    assert.equal(tidied.error, undefined);
    assert.equal(tidied.result.frames, 1);
    assert.equal(page.children[0].x, 0);
    assert.equal(page.children[0].y, 0);
    assert.equal(page.children[0].children.length, 2);
    // 类别新增/删除走同一主线程入口：先用已绑定资源页新增，再删除并回读。
    await figma.ui.onmessage({ type: 'add-category', requestId: 21, project: { id: 'g2', name: '测试游戏' }, name: '特效' });
    const addedCategory = replies.find(reply => reply.requestId === 21);
    assert.equal(addedCategory.error, undefined);
    assert.deepEqual(addedCategory.result.categories.at(-1), { name: '特效', color: '#0091ff' });
    assert.equal(addedCategory.result.moved, 0);
    assert.equal(page.children.at(-1).name, '特效');
    await figma.ui.onmessage({ type: 'add-category', requestId: 22, project: { id: 'g2', name: '测试游戏' }, name: '特效' });
    assert.match(replies.find(reply => reply.requestId === 22).error, /已存在类别/);
    await figma.ui.onmessage({ type: 'add-category', requestId: 23, project: { id: 'g2', name: '测试游戏' } });
    assert.match(replies.find(reply => reply.requestId === 23).error, /类别名称无效/);
    await figma.ui.onmessage({ type: 'remove-category', requestId: 24, project: { id: 'g2', name: '测试游戏' }, name: '特效' });
    const removedCategory = replies.find(reply => reply.requestId === 24);
    assert.equal(removedCategory.error, undefined);
    assert.equal(removedCategory.result.categories.some(category => category.name === '特效'), false);
    assert.equal(removedCategory.result.moved, 0);
    await figma.ui.onmessage({ type: 'remove-category', requestId: 25, project: { id: 'g2', name: '测试游戏' }, name: '未分类' });
    assert.match(replies.find(reply => reply.requestId === 25).error, /不能删除/);
    // 改名走同一主线程入口：未分类拒绕，成功后分类 Frame 与配置一起换名。
    await figma.ui.onmessage({ type: 'rename-category', requestId: 27, project: { id: 'g2', name: '测试游戏' }, from: '未分类', to: '其它' });
    assert.match(replies.find(reply => reply.requestId === 27).error, /不能改名/);
    await figma.ui.onmessage({ type: 'add-category', requestId: 28, project: { id: 'g2', name: '测试游戏' }, name: '特效' });
    await figma.ui.onmessage({ type: 'rename-category', requestId: 29, project: { id: 'g2', name: '测试游戏' }, from: '特效', to: '特效字' });
    const renamedCategory = replies.find(reply => reply.requestId === 29);
    assert.equal(renamedCategory.error, undefined);
    assert.equal(renamedCategory.result.categories.at(-1).name, '特效字');
    assert.equal(page.children.at(-1).name, '特效字');
    await figma.ui.onmessage({ type: 'rename-category', requestId: 30, project: { id: 'g2', name: '测试游戏' }, from: '特效字' });
    assert.match(replies.find(reply => reply.requestId === 30).error, /类别名称无效/);
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
