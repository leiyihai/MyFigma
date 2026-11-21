import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { projectFixture, writePng, solid, writeAtlas } from '../../local-helper/tests/atlas-fixture.mjs';
import { figmaFixture } from './platform-fixture.mjs';
import * as api from '../dist/api.mjs';

const atlasPath = project => join(project, 'res', 'imageset', 'Static', 'buttons.json');
const atlasImage = project => join(project, 'res', 'imageset', 'Static', 'buttons.png');
const standaloneImage = project => join(project, 'res', 'imageset', 'Static', 'default_headshot.png');
const compareGroupNames = ['图集：Static/buttons.json', '独立图片'];

async function writeAtlasWith(f, names) {
  const frames = { red: { frame: { x: 0, y: 0, w: 1, h: 1 } }, green: { frame: { x: 1, y: 0, w: 1, h: 1 } } };
  const pixels = [[255, 0, 0, 255], [0, 255, 0, 255], [0, 0, 255, 255], [255, 255, 0, 255]].flat();
  if (names.includes('blue')) frames.blue = { frame: { x: 2, y: 0, w: 1, h: 1 } };
  await writePng(atlasImage(f.project), 4, 1, pixels);
  await writeAtlas(atlasPath(f.project), { image: 'buttons.png', size: { w: 4, h: 1 }, frames });
}

async function setup() {
  const f = await projectFixture();
  await writeAtlasWith(f, ['red', 'green']);
  await writePng(standaloneImage(f.project), 1, 1, solid(1, 1, [10, 20, 30, 255]));
  const fixture = figmaFixture();
  const workflow = new api.Workflow(new api.HelperClient(f.base, f.token), api.createFigmaPlatform(fixture.api));
  await workflow.connect();
  await workflow.saveProject({ id: 'g10', name: '对照测试', path: f.project, maintained: true });
  await workflow.selectProject('g10');
  await workflow.scan();
  await workflow.import();
  return { f, workflow, ...fixture };
}

function comparePage(root) {
  return root.children.find(node => node.type === 'PAGE' && node.getPluginData('atlas.compare'));
}
function managedPages(root) {
  return root.children.filter(node => node.type === 'PAGE' && node.getPluginData('atlas.compare'));
}
function instanceIds(page) {
  return page.findAll(node => node.type === 'INSTANCE').map(node => node.id);
}
function groupNames(page) {
  return page.children.map(node => node.name);
}

test('默认扫描与导入不创建对照页', async () => {
  const { f, workflow, root, page } = await setup();
  try {
    assert.equal(workflow.state.compare, undefined);
    assert.equal(root.children.length, 1);
    assert.equal(comparePage(root), undefined);
    assert.deepEqual(root.children.map(node => node.name), ['对照测试（g10）- 分类资源']);
    assert.equal(page.getPluginData('atlas.compare'), '');
  } finally { await f.cleanup(); }
});

test('手动创建对照页按源图集分组，只放关联主组件的实例', async () => {
  const { f, workflow, root, page } = await setup();
  try {
    await workflow.comparePage();
    assert.equal(root.children.length, 2);
    const compare = comparePage(root);
    assert.ok(compare);
    assert.notEqual(compare, page);
    assert.equal(compare.name, '对照测试（g10）- 图集对照');
    assert.equal(JSON.parse(compare.getPluginData('atlas.compare')).projectId, 'g10');
    assert.deepEqual(groupNames(compare), compareGroupNames);
    const [atlas, standalone] = compare.children;
    assert.deepEqual(atlas.children.map(node => node.name).sort(), [
      '未分类/green · Static/buttons.json',
      '未分类/red · Static/buttons.json'
    ]);
    assert.deepEqual(standalone.children.map(node => node.name), [
      '未分类/default_headshot · Static/default_headshot.png'
    ]);
    // Instances point at the existing components; no component copy is created.
    assert.equal(compare.findAll(node => node.type === 'COMPONENT').length, 0);
    const sources = [];
    for (const instance of compare.findAll(node => node.type === 'INSTANCE')) {
      assert.ok(instance.getPluginData('atlas.compare.item'));
      const main = await instance.getMainComponentAsync();
      assert.equal(main.type, 'COMPONENT');
      const source = JSON.parse(main.getPluginData('atlas.source'));
      sources.push(source);
      assert.equal(instance.width, main.width);
      assert.equal(instance.height, main.height);
    }
    assert.equal(new Set(sources.map(source => source.identity)).size, 3);
    assert.deepEqual(sources.filter(source => source.kind === 'atlas').map(source => source.frameName).sort(), ['green', 'red']);
    assert.deepEqual(sources.filter(source => source.kind === 'standalone').map(source => source.relativePath), ['Static/default_headshot.png']);
    // The resource page keeps its own components and stays current.
    assert.equal(page.children.length, 1);
    assert.equal(page.children[0].children.length, 3);
    assert.equal(page.children[0].children.filter(node => node.type === 'COMPONENT').length, 3);
    assert.equal(workflow.state.compare.created, true);
    assert.equal(workflow.state.compare.pageName, '对照测试（g10）- 图集对照');
    assert.equal(workflow.state.compare.groups, 2);
    assert.equal(workflow.state.compare.added, 3);
    assert.equal(workflow.state.compare.kept, 0);
    assert.equal(workflow.state.compare.removed, 0);
  } finally { await f.cleanup(); }
});

test('再次点击更新同一对照页并复用已有实例', async () => {
  const { f, workflow, root } = await setup();
  try {
    await workflow.comparePage();
    const compare = comparePage(root);
    const before = instanceIds(compare);
    await workflow.comparePage();
    assert.equal(comparePage(root), compare);
    assert.equal(managedPages(root).length, 1);
    assert.deepEqual(instanceIds(compare), before);
    assert.deepEqual(groupNames(compare), compareGroupNames);
    assert.equal(compare.findAll(node => node.type === 'INSTANCE').length, 3);
    assert.equal(workflow.state.compare.created, false);
    assert.equal(workflow.state.compare.added, 0);
    assert.equal(workflow.state.compare.kept, 3);
    assert.equal(workflow.state.compare.removed, 0);
  } finally { await f.cleanup(); }
});

test('日常增量更新不动对照页，再次点击才补齐新增素材', async () => {
  const { f, workflow, root, page } = await setup();
  try {
    await workflow.comparePage();
    const compare = comparePage(root);
    const before = instanceIds(compare);
    await writeAtlasWith(f, ['red', 'green', 'blue']);
    await workflow.scan();
    assert.deepEqual([workflow.state.plan.added, workflow.state.plan.updated], [1, 0]);
    await workflow.import();
    // Daily incremental import must not touch the optional comparison page.
    assert.deepEqual(instanceIds(compare), before);
    assert.equal(compare.findAll(node => node.type === 'INSTANCE').length, 3);
    assert.equal(page.children[0].children.length, 4);
    await workflow.comparePage();
    assert.equal(comparePage(root), compare);
    assert.equal(managedPages(root).length, 1);
    assert.deepEqual(groupNames(compare), compareGroupNames);
    assert.equal(compare.findAll(node => node.type === 'INSTANCE').length, 4);
    const after = instanceIds(compare);
    for (const id of before) assert.ok(after.includes(id), '已有实例应复用而不是重建');
    assert.equal(new Set(after).size, 4);
    const blue = compare.findAll(node => node.name.includes('blue'))[0];
    assert.equal(blue.type, 'INSTANCE');
    const main = await blue.getMainComponentAsync();
    assert.equal(JSON.parse(main.getPluginData('atlas.source')).frameName, 'blue');
    assert.deepEqual(JSON.parse(blue.getPluginData('atlas.compare.item')), JSON.parse(JSON.parse(main.getPluginData('atlas.source')).identity));
    assert.equal(workflow.state.compare.added, 1);
    assert.equal(workflow.state.compare.kept, 3);
    assert.equal(workflow.state.compare.removed, 0);
  } finally { await f.cleanup(); }
});

test('仅更新本工具绑定的对照页，不改同名用户页且来源数据不依赖该页', async () => {
  const { f, workflow, root, page, api: figma } = await setup();
  try {
    const user = figma.createPage();
    user.name = '对照测试（g10）- 图集对照';
    const keep = { type: 'FRAME', name: '用户设计', children: [] };
    user.appendChild(keep);
    await workflow.comparePage();
    const ours = comparePage(root);
    assert.ok(ours);
    assert.notEqual(ours, user);
    assert.equal(ours.name, '对照测试（g10）- 图集对照（工具创建）');
    assert.deepEqual(user.children, [keep]);
    assert.equal(user.name, '对照测试（g10）- 图集对照');
    await workflow.comparePage();
    assert.equal(comparePage(root), ours);
    assert.deepEqual(user.children, [keep]);
    // Another game's managed page is not this project's target and is left alone.
    const foreign = figma.createPage();
    foreign.name = '其他游戏对照';
    foreign.setPluginData('atlas.compare', JSON.stringify({ schemaVersion: 1, projectId: 'g99' }));
    await workflow.comparePage();
    assert.equal(comparePage(root), ours);
    assert.deepEqual(foreign.children, []);
    assert.equal(root.children.length, 4);
    // Corrupt binding stops instead of overwriting; the user page is untouched.
    foreign.setPluginData('atlas.compare', '{');
    ours.remove();
    await assert.rejects(workflow.comparePage(), /绑定已损坏/);
    assert.deepEqual(foreign.children, []);
    assert.deepEqual(user.children, [keep]);
    // Saving sources never depends on the comparison page existing.
    foreign.setPluginData('atlas.compare', '');
    await workflow.scan();
    await workflow.import();
    assert.deepEqual([workflow.state.plan.added, workflow.state.plan.updated, workflow.state.plan.removed], [0, 0, 0]);
    assert.equal(page.children[0].children.length, 3);
    await workflow.comparePage();
    const recreated = comparePage(root);
    assert.ok(recreated);
    assert.equal(recreated.findAll(node => node.type === 'INSTANCE').length, 3);
    assert.deepEqual(user.children, [keep]);
  } finally { await f.cleanup(); }
});

test('对照页创建失败时清理本次新建的页面和实例，并可重试', async () => {
  const { f, workflow, root, page } = await setup();
  try {
    const component = page.children[0].children[1];
    const original = component.createInstance;
    component.createInstance = () => { throw new Error('Figma instance rejected'); };
    await assert.rejects(workflow.comparePage(), /Figma instance rejected/);
    assert.equal(comparePage(root), undefined);
    assert.equal(root.children.length, 1);
    assert.equal(workflow.state.busy, false);
    assert.equal(workflow.state.compare, undefined);
    component.createInstance = original;
    await workflow.comparePage();
    assert.equal(comparePage(root).findAll(node => node.type === 'INSTANCE').length, 3);
    assert.equal(managedPages(root).length, 1);
  } finally { await f.cleanup(); }
});

test('没有导入主组件时拒绝创建对照页', async () => {
  const f = await projectFixture();
  try {
    const { api: figma, root } = figmaFixture();
    const workflow = new api.Workflow(new api.HelperClient(f.base, f.token), api.createFigmaPlatform(figma));
    await workflow.connect();
    await workflow.saveProject({ id: 'g10', name: '对照测试', path: f.project, maintained: true });
    await workflow.selectProject('g10');
    await assert.rejects(workflow.comparePage(), /先导入主组件/);
    assert.equal(root.children.length, 1);
    assert.equal(comparePage(root), undefined);
    assert.equal(workflow.state.busy, false);
  } finally { await f.cleanup(); }
});
