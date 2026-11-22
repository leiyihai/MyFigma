import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import {
  projectFixture, writePng, solid, writeAtlas, writeLayout, layoutImageNode
} from '../../local-helper/tests/atlas-fixture.mjs';
import { figmaFixture } from './platform-fixture.mjs';
import * as api from '../dist/api.mjs';

const imageset = project => join(project, 'res', 'imageset', 'Static');
const layoutPath = project => join(project, 'res', 'layout', 'ui.json');

async function sprite(f, atlas, frameName, width, height) {
  const base = atlas.replace(/\.json$/, '');
  await writePng(join(imageset(f.project), base + '.png'), width, height, solid(width, height, [12, 34, 56, 255]));
  await writeAtlas(join(imageset(f.project), atlas), {
    image: base + '.png', size: { w: width, h: height },
    frames: { [frameName]: { frame: { x: 0, y: 0, w: width, h: height } } }
  });
}

async function setup() {
  const f = await projectFixture();
  const fixture = figmaFixture();
  const platform = api.createFigmaPlatform(fixture.api);
  const workflow = new api.Workflow(new api.HelperClient(f.base, f.token), platform);
  await workflow.connect();
  await workflow.saveProject({ id: 'g8', name: '分类测试', path: f.project, maintained: true });
  await workflow.selectProject('g8');
  return { f, workflow, platform, ...fixture };
}

function categoryFrame(page, category) {
  return page.children.find(node => node.type === 'FRAME' && node.getPluginData('atlas.category') !== ''
    && (node.name === category || node.getPluginData('atlas.category') === category));
}
function displayNames(page) {
  return page.children.flatMap(node => (node.children || []).map(child => child.name));
}

test('按名称与尺寸比例归入七类用途 Frame，九宫格不直接决定用途', async () => {
  const { f, workflow, page, root } = await setup();
  try {
    // 名称规则：按钮 / 进度条 / 底板 / 图标 / 背景 / 艺术字；九宫格只决定拉伸结构。
    await sprite(f, 'btn_ok.json', 'btn_ok', 64, 24);
    await sprite(f, 'panel_base.json', 'panel_base', 40, 30);
    await sprite(f, 'progress_hp.json', 'progress_hp', 160, 16);
    await sprite(f, 'icon_coin.json', 'icon_coin', 32, 32);
    await sprite(f, 'bg_main.json', 'bg_main', 32, 32);
    await sprite(f, 'wordart_title.json', 'wordart_title', 32, 32);
    // 尺寸比例：方形小图 → 图标；宽扁条 → 按钮；大图 → 背景；均无明显线索 → 未分类。
    await sprite(f, 'square_badge.json', 'square_badge', 64, 64);
    await sprite(f, 'wide_strip.json', 'wide_strip', 160, 40);
    await sprite(f, 'huge_scene.json', 'huge_scene', 600, 600);
    await sprite(f, 'dot.json', 'dot', 1, 1);
    await sprite(f, 'odd_piece.json', 'odd_piece', 320, 300);
    await writeLayout(layoutPath(f.project), [
      layoutImageNode('面板', 'set:panel_base.json image:panel_base', '8 8 8 8')
    ]);
    await workflow.scan();
    await workflow.import();

    assert.deepEqual(
      displayNames(page).sort(),
      [
        '未分类/dot',
        '未分类/odd_piece',
        '图标/icon_coin',
        '图标/square_badge',
        '按钮/btn_ok',
        '按钮/wide_strip',
        '底板/panel_base',
        '进度条/progress_hp',
        '背景/bg_main',
        '背景/huge_scene',
        '艺术字/wordart_title'
      ].sort()
    );
    // 每个分类 Frame 独立存在且带本工具标记；主组件只有一套，不创建对照页或副本。
    const components = page.findAll(node => node.type === 'COMPONENT');
    assert.equal(components.length, 11);
    assert.equal(page.children.filter(node => node.type === 'FRAME').length, 7);
    assert.equal(root.children.length, 1);
    for (const category of ['按钮', '底板', '图标', '背景', '艺术字', '进度条', '未分类']) {
      const frame = categoryFrame(page, category);
      assert.ok(frame, category);
      assert.equal(frame.getPluginData('atlas.category'), category);
      assert.equal(frame.layoutMode, 'HORIZONTAL');
      assert.equal(frame.layoutWrap, 'WRAP');
      assert.equal(frame.primaryAxisSizingMode, 'FIXED');
      assert.equal(frame.counterAxisSizingMode, 'AUTO');
      assert.equal(frame.width, 1200);
      assert.equal(frame.itemSpacing, 16);
      assert.equal(frame.counterAxisSpacing, 16);
      assert.equal(frame.paddingTop, 16);
      assert.equal(frame.paddingLeft, 16);
      assert.equal(frame.fills.length, 0);
    }
    // 新建的分类 Frame 初始摆放不重叠，之后普通增量只追加不整体重排。
    assertNoOverlap(page.children.filter(node => node.getPluginData('atlas.category')));
    // 显示名变化不改变资源身份：来源记录保留散图原名。
    const dot = components.find(node => node.name === '未分类/dot');
    const source = JSON.parse(dot.getPluginData('atlas.source'));
    assert.equal(source.frameName, 'dot');
    assert.equal(source.identity, JSON.stringify(['g8', 'atlas', 'Static/dot.json', 'dot']));
    assert.equal(source.sync.identity, source.identity);
  } finally { await f.cleanup(); }
});

function assertNoOverlap(frames) {
  const sorted = [...frames].sort((left, right) => left.x - right.x);
  for (let index = 1; index < sorted.length; index += 1) {
    assert.ok(sorted[index - 1].x + sorted[index - 1].width <= sorted[index].x,
      `${sorted[index - 1].name} 与 ${sorted[index].name} 重叠`);
  }
}

test('同类同名补充来源信息消歧，重复导入复用分类 Frame 与主组件', async () => {
  const { f, workflow, page } = await setup();
  try {
    await sprite(f, 'icons_a.json', 'icon_home', 32, 32);
    await sprite(f, 'icons_b.json', 'icon_home', 32, 32);
    await sprite(f, 'dot.json', 'dot', 1, 1);
    await workflow.scan();
    await workflow.import();
    const iconFrame = categoryFrame(page, '图标');
    const components = page.findAll(node => node.type === 'COMPONENT');
    assert.equal(components.length, 3);
    assert.deepEqual(components.map(node => node.name).sort(), [
      '图标/icon_home · Static/icons_a.json',
      '图标/icon_home · Static/icons_b.json',
      '未分类/dot'
    ]);
    const identities = components.map(node => JSON.parse(node.getPluginData('atlas.source')).identity).sort();
    assert.deepEqual(identities, [
      '["g8","atlas","Static/dot.json","dot"]',
      '["g8","atlas","Static/icons_a.json","icon_home"]',
      '["g8","atlas","Static/icons_b.json","icon_home"]'
    ]);

    // A repeated import reuses the same frames and components; only names are refreshed.
    const componentIds = components.map(node => node.id).sort();
    await workflow.scan();
    assert.deepEqual([workflow.state.plan.added, workflow.state.plan.updated, workflow.state.plan.unchanged], [0, 0, 3]);
    await workflow.import();
    assert.equal(categoryFrame(page, '图标'), iconFrame);
    assert.deepEqual(page.findAll(node => node.type === 'COMPONENT').map(node => node.id).sort(), componentIds);
    assert.deepEqual(page.findAll(node => node.type === 'COMPONENT').map(node => node.name).sort(), [
      '图标/icon_home · Static/icons_a.json',
      '图标/icon_home · Static/icons_b.json',
      '未分类/dot'
    ]);

    // A third same-name sprite joins the same frame and makes the whole group explicit.
    await sprite(f, 'icons_c.json', 'icon_home', 32, 32);
    await workflow.scan();
    await workflow.import();
    const all = page.findAll(node => node.type === 'COMPONENT');
    assert.deepEqual(all.filter(node => node.name.includes('icon_home')).map(node => node.name).sort(), [
      '图标/icon_home · Static/icons_a.json',
      '图标/icon_home · Static/icons_b.json',
      '图标/icon_home · Static/icons_c.json'
    ]);
    assert.equal(categoryFrame(page, '图标').children.length, 3);
    assert.equal(page.children.filter(node => node.type === 'FRAME').length, 2);
  } finally { await f.cleanup(); }
});

test('尺寸变化或九宫格用法出现时保留身份、来源、实例与九宫格结构', async () => {
  const { f, workflow, page } = await setup();
  try {
    await sprite(f, 'shape_thing.json', 'shape_thing', 1, 1);
    await workflow.scan();
    await workflow.import();
    const component = page.findAll(node => node.type === 'COMPONENT')[0];
    const identity = JSON.parse(component.getPluginData('atlas.source')).identity;
    assert.equal(component.name, '未分类/shape_thing');
    assert.equal(component.parent.name, '未分类');

    // Grow the same source identity: a square, medium image becomes an icon.
    await sprite(f, 'shape_thing.json', 'shape_thing', 64, 64);
    await workflow.scan();
    assert.deepEqual([workflow.state.plan.added, workflow.state.plan.updated], [0, 1]);
    await workflow.import();
    const moved = page.findAll(node => node.type === 'COMPONENT')[0];
    assert.equal(moved, component);
    assert.equal(moved.name, '图标/shape_thing');
    assert.equal(moved.parent.name, '图标');
    assert.equal(JSON.parse(moved.getPluginData('atlas.source')).identity, identity);
    assert.equal(JSON.parse(moved.getPluginData('atlas.source')).frameName, 'shape_thing');

    // A nine-slice usage on the same identity moves it again without rebuilding.
    await writeLayout(layoutPath(f.project), [
      layoutImageNode('形状', 'set:shape_thing.json image:shape_thing', '8 8 8 8')
    ]);
    await workflow.scan();
    await workflow.import();
    const slices = page.findAll(node => node.type === 'COMPONENT')[0];
    assert.equal(slices, component);
    assert.equal(slices.name, '图标/shape_thing');
    assert.equal(slices.parent.name, '图标');
    assert.equal(slices.children.length, 9);
    assert.equal(JSON.parse(slices.getPluginData('atlas.source')).identity, identity);
    assert.equal(slices.children.find(child => child.name === '切片 2-2').constraints.horizontal, 'STRETCH');
    assert.equal(page.findAll(node => node.type === 'COMPONENT').length, 1);
  } finally { await f.cleanup(); }
});

test('重新整理按分类顺序摆放分类 Frame 消除重叠，不重建主组件或改变九宫格约束', async () => {
  const { f, workflow, page } = await setup();
  try {
    await sprite(f, 'btn_ok.json', 'btn_ok', 64, 24);
    await sprite(f, 'panel_base.json', 'panel_base', 40, 30);
    await sprite(f, 'progress_hp.json', 'progress_hp', 160, 16);
    await sprite(f, 'icon_coin.json', 'icon_coin', 32, 32);
    await sprite(f, 'bg_main.json', 'bg_main', 32, 32);
    await writeLayout(layoutPath(f.project), [
      layoutImageNode('面板', 'set:panel_base.json image:panel_base', '8 8 8 8')
    ]);
    await workflow.scan();
    await workflow.import();
    const frames = page.children.filter(node => node.getPluginData('atlas.category'));
    const components = page.findAll(node => node.type === 'COMPONENT');
    const panel = components.find(node => node.name === '底板/panel_base');
    const center = panel.children.find(child => child.name === '切片 2-2');
    const constraints = { ...center.constraints };

    // A user (or earlier placements) can leave every category frame stacked at the same spot.
    for (const frame of frames) { frame.x = 120; frame.y = 30; }
    await workflow.tidy();
    assert.equal(workflow.state.tidy.schemaVersion, 1);
    assert.equal(workflow.state.tidy.frames, 5);
    assert.equal(workflow.state.tidy.moved, 5);
    assert.equal(workflow.state.phase, '就绪');
    const ordered = [...frames].sort((left, right) => left.x - right.x);
    assert.deepEqual(ordered.map(frame => frame.name), ['按钮', '底板', '图标', '背景', '进度条']);
    assert.ok(ordered.every(frame => frame.y === 0));
    for (let index = 1; index < ordered.length; index += 1) {
      assert.equal(ordered[index].x, ordered[index - 1].x + ordered[index - 1].width + 48);
    }
    // Only frame positions change: the same main components stay in the same parents.
    assert.deepEqual(page.findAll(node => node.type === 'COMPONENT').map(node => node.id), components.map(node => node.id));
    assert.equal(panel.children.find(child => child.name === '切片 2-2'), center);
    assert.deepEqual(center.constraints, constraints);
    assert.equal(center.parent, panel);

    // Tidy is idempotent.
    await workflow.tidy();
    assert.equal(workflow.state.tidy.moved, 0);

    // A normal incremental import appends to the target category frame without reflowing frames.
    const positions = new Map(frames.map(frame => [frame.name, [frame.x, frame.y]]));
    await sprite(f, 'dot.json', 'dot', 1, 1);
    await workflow.scan();
    await workflow.import();
    for (const frame of frames) assert.deepEqual([frame.x, frame.y], positions.get(frame.name));
    assert.equal(categoryFrame(page, '未分类').children.length, 1);
    assert.equal(categoryFrame(page, '未分类').children[0].name, '未分类/dot');
  } finally { await f.cleanup(); }
});

test('重新整理在空白页说明无事可做，且拒绝对其他项目的资源页操作', async () => {
  const { f, workflow, page } = await setup();
  try {
    await workflow.tidy();
    assert.deepEqual([workflow.state.tidy.frames, workflow.state.tidy.moved], [0, 0]);
    assert.match(workflow.state.tidy.messages.join('\n'), /没有/);
    assert.equal(page.children.length, 0);
    assert.equal(page.getPluginData('atlas.binding'), '');

    await sprite(f, 'dot.json', 'dot', 1, 1);
    await workflow.scan();
    await workflow.import();
    const frame = categoryFrame(page, '未分类');
    frame.x = 30; frame.y = 30;
    page.setPluginData('atlas.binding', JSON.stringify({ schemaVersion: 1, projectId: 'g99' }));
    await assert.rejects(workflow.tidy(), /其他项目/);
    assert.deepEqual([frame.x, frame.y], [30, 30]);
    page.setPluginData('atlas.binding', '');
    page.name = '分类测试（g8）- 分类资源';
    page.setPluginData('atlas.binding', JSON.stringify({ schemaVersion: 1, projectId: 'g8' }));
    await workflow.selectProject('');
    await assert.rejects(workflow.tidy(), /选择游戏/);
  } finally { await f.cleanup(); }
});

test('分类 Frame 内的用户自有组件不阻塞增量导入，也不被改造', async () => {
  const { f, workflow, page, api: figma } = await setup();
  try {
    await sprite(f, 'icon_coin.json', 'icon_coin', 32, 32);
    await workflow.scan();
    await workflow.import();
    const frame = categoryFrame(page, '图标');
    const user = figma.createComponent();
    user.name = '用户自有组件';
    user.resize(10, 10);
    frame.appendChild(user);
    // Adding an unrelated user component must not look like a corrupted source record.
    await workflow.scan();
    assert.deepEqual([workflow.state.plan.added, workflow.state.plan.updated, workflow.state.plan.unchanged], [0, 0, 1]);
    await workflow.import();
    assert.equal(frame.children.includes(user), true);
    assert.equal(user.name, '用户自有组件');
    assert.equal(user.width, 10);
    assert.equal(page.findAll(node => node.type === 'COMPONENT').length, 2);
  } finally { await f.cleanup(); }
});

test('工具记录被整体清除时仍按分类显示名拦截重复创建', async () => {
  const { f, workflow, page } = await setup();
  try {
    await sprite(f, 'icon_coin.json', 'icon_coin', 32, 32);
    await workflow.scan();
    await workflow.import();
    const component = page.findAll(node => node.type === 'COMPONENT')[0];
    for (const key of ['atlas.source', 'atlas.sync.v1', 'myfigma.nineSlice.v1']) component.setPluginData(key, '');
    // The derived display name still identifies a previously managed component.
    await assert.rejects(workflow.scan(), /来源记录损坏/);
    assert.equal(page.findAll(node => node.type === 'COMPONENT').length, 1);
  } finally { await f.cleanup(); }
});


test('批量人工分类保留身份和实例，源更新后仍保留，恢复自动分类按当前规则重算', async () => {
  const { f, workflow, platform, page, api: figma } = await setup();
  const project = { id: 'g8', name: '分类测试' };
  try {
    await sprite(f, 'btn_ok.json', 'btn_ok', 64, 24);
    await sprite(f, 'icon_coin.json', 'icon_coin', 32, 32);
    await workflow.scan();
    await workflow.import();
    const button = page.findAll(node => node.type === 'COMPONENT' && node.name === '按钮/btn_ok')[0];
    const icon = page.findAll(node => node.type === 'COMPONENT' && node.name === '图标/icon_coin')[0];
    assert.ok(button && icon);
    const sourceBefore = button.getPluginData('atlas.source');
    const identity = JSON.parse(sourceBefore).identity;
    const instance = button.createInstance();
    page.appendChild(instance);
    const plain = figma.createComponent();
    page.appendChild(plain);
    plain.name = '用户自己的组件';
    page.selection = [button, instance, icon, plain];

    await workflow.loadSelection();
    const selected = workflow.state.selection;
    assert.equal(selected.members.length, 2);
    assert.equal(selected.mixed, true);
    assert.equal(selected.mixed, true);
    assert.equal(selected.ignored, 1);
    assert.deepEqual(selected.members.map(member => member.category).sort(), ['按钮', '图标'].sort());
    assert.equal(selected.members.find(member => member.id === button.id).viaInstance, true);

    const applied = (await workflow.setCategory('艺术字'), workflow.state.selection);
    assert.equal(workflow.state.phase, '就绪');
    assert.equal(workflow.state.selection.members.length, 2);
    assert.equal(workflow.state.selection.mixed, false);
    assert.equal(workflow.state.selection.members[0].manual, true);
    assert.equal(button.parent.name, '艺术字');
    assert.equal(icon.parent.name, '艺术字');
    assert.equal(button.name, '艺术字/btn_ok');
    assert.equal(icon.name, '艺术字/icon_coin');
    assert.equal(button.getPluginData('atlas.category.manual'), '艺术字');
    assert.equal(JSON.parse(button.getPluginData('atlas.source')).identity, identity);
    assert.equal(JSON.parse(button.getPluginData('atlas.source')).sync.identity, identity);
    assert.ok(page.findAll(node => node.type === 'INSTANCE' && node !== instance));
    assert.equal(plain.name, '用户自己的组件');
    assert.equal(plain.parent, page);
    assert.equal(plain.getPluginData('atlas.category.manual'), '');

    // A normal source update and import must not overwrite the manual choice.
    await writePng(join(imageset(f.project), 'btn_ok.png'), 64, 24, solid(64, 24, [200, 10, 10, 255]));
    await workflow.scan();
    await workflow.import();
    assert.equal(button.parent.name, '艺术字');
    assert.equal(button.name, '艺术字/btn_ok');
    assert.equal(button.getPluginData('atlas.category.manual'), '艺术字');
    assert.equal(JSON.parse(button.getPluginData('atlas.source')).identity, identity);
    assert.equal(await instance.getMainComponentAsync(), button);

    // Restore auto classification uses the current rules and removes the override.
    await workflow.setCategory('auto');
    assert.equal(workflow.state.selection.members.every(member => !member.manual), true);
    assert.equal(button.getPluginData('atlas.category.manual'), '');
    assert.equal(icon.getPluginData('atlas.category.manual'), '');
    assert.equal(button.parent.name, '按钮');
    assert.equal(icon.parent.name, '图标');
    assert.equal(button.name, '按钮/btn_ok');
    assert.equal(icon.name, '图标/icon_coin');
  } finally { await f.cleanup(); }
});

test('撤销人工分类恢复操作前类别与人工覆盖，不重跑自动规则', async () => {
  const { f, workflow, platform, page } = await setup();
  const project = { id: 'g8', name: '分类测试' };
  try {
    await sprite(f, 'btn_ok.json', 'btn_ok', 64, 24);
    await sprite(f, 'icon_coin.json', 'icon_coin', 32, 32);
    await sprite(f, 'panel_base.json', 'panel_base', 40, 30);
    await workflow.scan();
    await workflow.import();
    const button = page.findAll(node => node.type === 'COMPONENT' && node.name === '按钮/btn_ok')[0];
    const icon = page.findAll(node => node.type === 'COMPONENT' && node.name === '图标/icon_coin')[0];
    const panel = page.findAll(node => node.type === 'COMPONENT' && node.name === '底板/panel_base')[0];
    assert.ok(button && icon && panel);
    // panel 的自动规则是底板，先人工改成背景；撤销必须回到人工值，不能重跑规则。
    await platform.setCategory(project, [panel.id], '背景');
    const sources = new Map([button, icon, panel].map(node => [node.id, node.getPluginData('atlas.source')]));
    const instance = panel.createInstance();
    page.appendChild(instance);

    const applied = await platform.setCategory(project, [button.id, icon.id, panel.id], '艺术字');
    assert.equal(applied.action, 'manual');
    assert.equal(applied.updated, 3);
    assert.deepEqual(applied.previous.map(item => [item.id, item.category, item.manual]).sort(), [
      [button.id, '按钮', false],
      [icon.id, '图标', false],
      [panel.id, '背景', true]
    ].sort());
    // 单次人工分类同样返回操作前的类别与人工覆盖状态。
    const single = await platform.setCategory(project, [icon.id], '进度条');
    assert.deepEqual(single.previous, [{ id: icon.id, category: '艺术字', manual: true }]);

    const restored = await platform.restoreCategory(project, applied.previous);
    assert.equal(restored.restored, 3);
    assert.equal(restored.skipped, 0);
    assert.equal(button.parent.name, '按钮');
    assert.equal(icon.parent.name, '图标');
    assert.equal(panel.parent.name, '背景');
    assert.equal(button.name, '按钮/btn_ok');
    assert.equal(icon.name, '图标/icon_coin');
    assert.equal(panel.name, '背景/panel_base');
    assert.equal(button.getPluginData('atlas.category.manual'), '');
    assert.equal(icon.getPluginData('atlas.category.manual'), '');
    assert.equal(panel.getPluginData('atlas.category.manual'), '背景');
    // 恢复不改变来源身份、同步记录和实例关联。
    for (const node of [button, icon, panel]) assert.equal(node.getPluginData('atlas.source'), sources.get(node.id));
    assert.equal(await instance.getMainComponentAsync(), panel);
  } finally { await f.cleanup(); }
});

test('撤销后再次分类覆盖旧记录，已删除与无关组件安全跳过并计数', async () => {
  const { f, workflow, platform, page, api: figma } = await setup();
  const project = { id: 'g8', name: '分类测试' };
  try {
    await sprite(f, 'btn_ok.json', 'btn_ok', 64, 24);
    await sprite(f, 'icon_coin.json', 'icon_coin', 32, 32);
    await workflow.scan();
    await workflow.import();
    const button = page.findAll(node => node.type === 'COMPONENT' && node.name === '按钮/btn_ok')[0];
    const icon = page.findAll(node => node.type === 'COMPONENT' && node.name === '图标/icon_coin')[0];
    const first = await platform.setCategory(project, [button.id, icon.id], '艺术字');
    await platform.restoreCategory(project, first.previous);
    // 再次人工分类返回的是撤销后的状态，旧记录不会残留。
    const second = await platform.setCategory(project, [button.id, icon.id], '背景');
    assert.deepEqual(second.previous.map(item => [item.id, item.category, item.manual]).sort(), [
      [button.id, '按钮', false],
      [icon.id, '图标', false]
    ].sort());

    const foreign = figma.createComponent();
    page.appendChild(foreign);
    foreign.name = '用户自己的组件';
    const skipped = await platform.restoreCategory(project, [
      { id: button.id, category: '图标', manual: true },
      { id: 'component-999', category: '按钮', manual: false },
      { id: foreign.id, category: '按钮', manual: false }
    ]);
    assert.equal(skipped.restored, 1);
    assert.equal(skipped.skipped, 2);
    assert.match(skipped.messages.join('\n'), /已跳过/);
    assert.equal(button.parent.name, '图标');
    assert.equal(button.getPluginData('atlas.category.manual'), '图标');
    assert.equal(foreign.parent, page);
    assert.equal(foreign.name, '用户自己的组件');
    assert.equal(foreign.getPluginData('atlas.category.manual'), '');
  } finally { await f.cleanup(); }
});

test('工作流只保留最近一次人工分类的撤销记录，撤销后清空', async () => {
  const { f, workflow, page } = await setup();
  try {
    await sprite(f, 'btn_ok.json', 'btn_ok', 64, 24);
    await sprite(f, 'icon_coin.json', 'icon_coin', 32, 32);
    await workflow.scan();
    await workflow.import();
    const button = page.findAll(node => node.type === 'COMPONENT' && node.name === '按钮/btn_ok')[0];
    const icon = page.findAll(node => node.type === 'COMPONENT' && node.name === '图标/icon_coin')[0];
    page.selection = [button, icon];
    await workflow.loadSelection();

    await workflow.setCategory('艺术字');
    assert.deepEqual(workflow.state.undo.entries.map(item => [item.id, item.category, item.manual]).sort(), [
      [button.id, '按钮', false],
      [icon.id, '图标', false]
    ].sort());
    // 下一次人工分类替换而不是追加旧记录。
    await workflow.setCategory('背景');
    assert.deepEqual(workflow.state.undo.entries.map(item => [item.id, item.category, item.manual]).sort(), [
      [button.id, '艺术字', true],
      [icon.id, '艺术字', true]
    ].sort());

    await workflow.undoCategory();
    assert.equal(workflow.state.undo, undefined);
    assert.equal(button.parent.name, '艺术字');
    assert.equal(icon.parent.name, '艺术字');
    assert.equal(workflow.state.selection.members.every(member => member.category === '艺术字' && member.manual), true);
    assert.match(workflow.state.notice, /撤销：已恢复 2 个组件/);

    // 恢复自动分类不是撤销单元，旧记录会失效；没有记录时撤销直接拒绝。
    await workflow.setCategory('背景');
    assert.ok(workflow.state.undo);
    await workflow.setCategory('auto');
    assert.equal(workflow.state.undo, undefined);
    await assert.rejects(() => workflow.undoCategory(), /没有可撤销/);
  } finally { await f.cleanup(); }
});

test('批量分类同类重名补充来源，混合无关对象只跳过不改造', async () => {
  const { f, workflow, platform, page, api: figma } = await setup();
  const project = { id: 'g8', name: '分类测试' };
  try {
    await sprite(f, 'icons_a.json', 'icon_home', 32, 32);
    await sprite(f, 'icons_b.json', 'icon_home', 32, 32);
    await workflow.scan();
    await workflow.import();
    const homes = page.findAll(node => node.type === 'COMPONENT' && node.name.startsWith('图标/icon_home'));
    assert.equal(homes.length, 2);
    const before = new Map(homes.map(node => [node.id, node.getPluginData('atlas.source')]));
    const foreign = figma.createComponent();
    page.appendChild(foreign);
    foreign.name = '外部组件';
    page.selection = [...homes, foreign];

    await workflow.loadSelection();
    await workflow.setCategory('背景');
    const result = await platform.setCategory(project, [homes[0].id, foreign.id], '背景');
    assert.equal(result.updated, 1);
    assert.match(result.messages.join('\n'), /外部组件.*跳过/);
    assert.deepEqual(homes.map(node => node.name).sort(), [
      '背景/icon_home · Static/icons_a.json',
      '背景/icon_home · Static/icons_b.json'
    ]);
    for (const home of homes) assert.equal(home.getPluginData('atlas.source'), before.get(home.id));
    assert.equal(foreign.name, '外部组件');
    assert.equal(foreign.parent, page);

    await assert.rejects(() => platform.setCategory(project, [homes[0].id], '不存在的分类'), /分类无效/);
    assert.equal(homes[0].parent.name, '背景');
  } finally { await f.cleanup(); }
});

test('散图原名开头前缀优先定类，token 边界与大小写不敏感', async () => {
  const { f, workflow, page } = await setup();
  try {
    for (const [file, width, height] of [
      ['btn_panel.json', 64, 24],
      ['button_icon.json', 32, 32],
      ['BTN_Bg.json', 32, 32],
      ['btn2_ok.json', 64, 24],
      ['bg_btn.json', 32, 32],
      ['background_panel.json', 40, 30],
      ['icon_btn.json', 32, 32],
      ['panel_btn.json', 40, 30],
      ['progress_row.json', 160, 16],
      ['pbar_btn.json', 160, 16],
      ['font_title.json', 32, 32],
      ['wordart_icon.json', 32, 32]
    ]) await sprite(f, file, file.replace(/\.json$/, ''), width, height);
    // 前缀不匹配时才回退到完整名称关键词与尺寸比例。
    await sprite(f, 'bgm_panel.json', 'bgm_panel', 40, 30);
    await sprite(f, 'game_button_icon.json', 'game_button_icon', 32, 32);
    await sprite(f, 'plain_badge.json', 'plain_badge', 64, 64);
    await sprite(f, 'wide_plain.json', 'wide_plain', 160, 40);
    await sprite(f, 'dot.json', 'dot', 1, 1);
    await workflow.scan();
    await workflow.import();
    assert.deepEqual(
      displayNames(page).sort(),
      [
        '未分类/dot',
        '图标/icon_btn',
        '图标/plain_badge',
        '按钮/btn_panel',
        '按钮/button_icon',
        '按钮/BTN_Bg',
        '按钮/btn2_ok',
        '按钮/game_button_icon',
        '按钮/wide_plain',
        '底板/panel_btn',
        '底板/bgm_panel',
        '背景/bg_btn',
        '背景/background_panel',
        '艺术字/font_title',
        '艺术字/wordart_icon',
        '进度条/progress_row',
        '进度条/pbar_btn'
      ].sort()
    );
    assert.equal(page.children.filter(node => node.getPluginData('atlas.category')).length, 7);
  } finally { await f.cleanup(); }
});

test('九宫格用法只决定拉伸结构，九宫格按钮与进度条仍归按钮与进度条', async () => {
  const { f, workflow, page } = await setup();
  try {
    await sprite(f, 'btn_hp.json', 'btn_hp', 64, 24);
    await sprite(f, 'progress_hp.json', 'progress_hp', 160, 16);
    await sprite(f, 'icon_frame.json', 'icon_frame', 48, 48);
    await writeLayout(layoutPath(f.project), [
      layoutImageNode('按钮', 'set:btn_hp.json image:btn_hp', '8 8 8 8'),
      layoutImageNode('进度', 'set:progress_hp.json image:progress_hp', '4 4 4 4'),
      layoutImageNode('图标', 'set:icon_frame.json image:icon_frame', '6 6 6 6')
    ]);
    await workflow.scan();
    await workflow.import();
    assert.deepEqual(displayNames(page).sort(), ['按钮/btn_hp', '进度条/progress_hp', '图标/icon_frame'].sort());
    assert.equal(page.children.filter(node => node.getPluginData('atlas.category')).length, 3);
    for (const [name, category] of [
      ['按钮/btn_hp', '按钮'],
      ['进度条/progress_hp', '进度条'],
      ['图标/icon_frame', '图标']
    ]) {
      const component = page.findAll(node => node.type === 'COMPONENT' && node.name === name)[0];
      assert.ok(component, name);
      assert.equal(component.parent.name, category);
      assert.equal(component.children.length, 9);
      assert.equal(component.layoutMode, 'NONE');
      assert.equal(component.children.find(child => child.name === '切片 2-2').constraints.horizontal, 'STRETCH');
    }
  } finally { await f.cleanup(); }
});

test('页面没有类别配置时回读默认七类及稳定颜色，缺失不写空白页', async () => {
  const { f, workflow, platform, page } = await setup();
  try {
    const state = await platform.categories();
    assert.equal(state.schemaVersion, 1);
    assert.deepEqual(state.categories.map(category => category.name),
      ['按钮', '底板', '图标', '背景', '艺术字', '进度条', '未分类']);
    for (const category of state.categories) assert.match(category.color, /^#[0-9a-f]{6}$/);
    assert.equal(new Set(state.categories.map(category => category.color)).size, 7);
    // 缺失即默认；只读回读不给空白页写入配置。
    assert.equal(page.getPluginData('atlas.categories.v1'), '');

    // 导入仍按默认七类工作，顺序与颜色不变，页面校验不受影响。
    await sprite(f, 'icon_coin.json', 'icon_coin', 32, 32);
    await workflow.scan();
    await workflow.import();
    assert.equal(workflow.state.page.valid, true);
    const after = await platform.categories();
    assert.deepEqual(after.categories, state.categories);
  } finally { await f.cleanup(); }
});

const defaultNames = ['按钮', '底板', '图标', '背景', '艺术字', '进度条', '未分类'];

test('类别配置损坏时回退默认七类并回写修复，不阻断导入与页面校验', async () => {
  const { f, workflow, platform, page } = await setup();
  try {
    await sprite(f, 'icon_coin.json', 'icon_coin', 32, 32);
    await workflow.scan();
    await workflow.import();

    // 坏 JSON：回读得到默认七类，并把修复结果写回已绑定资源页。
    page.setPluginData('atlas.categories.v1', '{not json');
    const repaired = await platform.categories();
    assert.deepEqual(repaired.categories.map(category => category.name), defaultNames);
    assert.deepEqual(JSON.parse(page.getPluginData('atlas.categories.v1')).categories.map(category => category.name), defaultNames);

    // 配置损坏不阻断页面校验，也不阻断后续导入。
    await workflow.validatePage();
    assert.equal(workflow.state.page.valid, true);
    await sprite(f, 'btn_ok.json', 'btn_ok', 64, 24);
    await workflow.scan();
    await workflow.import();
    assert.equal(page.findAll(node => node.type === 'COMPONENT').length, 2);
    assert.ok(categoryFrame(page, '按钮'));

    // 合法但缺少「未分类」：保留自定义类别，补回未分类。
    page.setPluginData('atlas.categories.v1', JSON.stringify({
      schemaVersion: 1, categories: [{ name: '特殊按钮', color: '#123456' }]
    }));
    const appended = await platform.categories();
    assert.deepEqual(appended.categories, [
      { name: '特殊按钮', color: '#123456' },
      { name: '未分类', color: '#8b8d98' }
    ]);
    assert.deepEqual(JSON.parse(page.getPluginData('atlas.categories.v1')).categories, appended.categories);

    // 非法名称（路径分隔符、控制字符、超长、重复）或非法颜色：整体回退默认七类。
    for (const categories of [
      [{ name: 'a/b', color: '#123456' }, { name: '未分类', color: '#8b8d98' }],
      [{ name: 'a\b', color: '#123456' }, { name: '未分类', color: '#8b8d98' }],
      [{ name: '换\n行', color: '#123456' }, { name: '未分类', color: '#8b8d98' }],
      [{ name: 'x'.repeat(25), color: '#123456' }, { name: '未分类', color: '#8b8d98' }],
      [{ name: '特殊', color: '#123456' }, { name: '特殊', color: '#654321' }, { name: '未分类', color: '#8b8d98' }],
      [{ name: '特殊', color: 'red' }, { name: '未分类', color: '#8b8d98' }],
      [{ name: '', color: '#123456' }, { name: '未分类', color: '#8b8d98' }]
    ]) {
      page.setPluginData('atlas.categories.v1', JSON.stringify({ schemaVersion: 1, categories }));
      assert.deepEqual((await platform.categories()).categories.map(category => category.name), defaultNames);
    }
  } finally { await f.cleanup(); }
});

test('自定义类别按页面配置顺序排序、认领分类 Frame 并回读人工分类', async () => {
  const { f, workflow, platform, page } = await setup();
  try {
    await sprite(f, 'btn_ok.json', 'btn_ok', 64, 24);
    await sprite(f, 'icon_coin.json', 'icon_coin', 32, 32);
    await sprite(f, 'dot.json', 'dot', 1, 1);
    await workflow.scan();
    await workflow.import();
    const icon = page.findAll(node => node.type === 'COMPONENT' && node.name === '图标/icon_coin')[0];

    const config = { schemaVersion: 1, categories: [
      { name: '未分类', color: '#8b8d98' },
      { name: '特殊按钮', color: '#0091ff' },
      { name: '按钮', color: '#e5484d' },
      { name: '底板', color: '#8e4ec6' },
      { name: '图标', color: '#f2a900' },
      { name: '背景', color: '#3e63dd' },
      { name: '艺术字', color: '#d6409f' },
      { name: '进度条', color: '#30a46c' }
    ] };
    page.setPluginData('atlas.categories.v1', JSON.stringify(config));
    assert.deepEqual((await platform.categories()).categories, config.categories);

    // 自定义类别可以被人工分类选中、移动、改名并回读。
    page.selection = [icon];
    await workflow.loadSelection();
    await workflow.setCategory('特殊按钮');
    assert.equal(icon.parent.name, '特殊按钮');
    assert.equal(icon.parent.getPluginData('atlas.category'), '特殊按钮');
    assert.equal(icon.name, '特殊按钮/icon_coin');
    assert.equal(icon.getPluginData('atlas.category.manual'), '特殊按钮');
    assert.deepEqual(workflow.state.selection.members.map(member => [member.category, member.manual]),
      [['特殊按钮', true]]);

    // 重新整理按配置顺序排列，自定义类别参与整理。
    const frames = page.children.filter(node => node.getPluginData('atlas.category'));
    for (const frame of frames) { frame.x = 400; frame.y = 40; }
    await workflow.tidy();
    assert.equal(workflow.state.tidy.frames, 4);
    assert.deepEqual([...frames].sort((left, right) => left.x - right.x).map(frame => frame.name),
      ['未分类', '特殊按钮', '按钮', '图标']);

    // 不在当前配置里的旧 Frame 不被认领、不被搬动、也不改写标记。
    const legacy = frames.find(frame => frame.name === '按钮');
    legacy.setPluginData('atlas.category', '旧分类');
    legacy.x = 900; legacy.y = 50;
    const button = legacy.children[0];
    assert.equal(button.name, '按钮/btn_ok');
    await workflow.tidy();
    assert.equal(workflow.state.tidy.frames, 3);
    assert.deepEqual([legacy.x, legacy.y], [900, 50]);
    assert.equal(legacy.getPluginData('atlas.category'), '旧分类');
    assert.equal(button.name, '按钮/btn_ok');

    // 不在页面配置里的类别名无法应用，也不会误建 Frame。
    page.selection = [icon];
    await workflow.loadSelection();
    await assert.rejects(workflow.setCategory('不存在的类别'), /分类无效/);
    assert.equal(icon.parent.name, '特殊按钮');
    assert.equal(categoryFrame(page, '不存在的类别'), undefined);
  } finally { await f.cleanup(); }
});

test('页面配置里没有的用途类别由自动分类回落到未分类，不生成无主 Frame', async () => {
  const { f, workflow, page } = await setup();
  try {
    page.setPluginData('atlas.categories.v1', JSON.stringify({ schemaVersion: 1, categories: [
      { name: '未分类', color: '#8b8d98' },
      { name: '按钮', color: '#e5484d' }
    ] }));
    await sprite(f, 'btn_ok.json', 'btn_ok', 64, 24);
    await sprite(f, 'wordart_title.json', 'wordart_title', 32, 32);
    await workflow.scan();
    await workflow.import();
    assert.deepEqual(displayNames(page).sort(), ['按钮/btn_ok', '未分类/wordart_title'].sort());
    assert.equal(page.children.filter(node => node.getPluginData('atlas.category')).length, 2);
    assert.equal(categoryFrame(page, '艺术字'), undefined);
  } finally { await f.cleanup(); }
});

test('旧分类不迁移：unsorted 仍读作未分类，未知旧 Frame 不被认领、搬动或改写', async () => {
  const { f, workflow, page } = await setup();
  try {
    await sprite(f, 'btn_ok.json', 'btn_ok', 64, 24);
    await sprite(f, 'dot.json', 'dot', 1, 1);
    await workflow.scan();
    await workflow.import();
    const buttonFrame = categoryFrame(page, '按钮');
    const unclassified = categoryFrame(page, '未分类');
    const button = buttonFrame.children[0];

    // 旧 #3 标记 'unsorted' 仍读作未分类；旧「九宫格底板」既不被认领也不迁移。
    unclassified.setPluginData('atlas.category', 'unsorted');
    unclassified.name = 'unsorted';
    buttonFrame.setPluginData('atlas.category', '九宫格底板');
    buttonFrame.name = '九宫格底板';
    button.setPluginData('atlas.category.manual', '九宫格底板');
    buttonFrame.x = 800; buttonFrame.y = 60;
    unclassified.x = 800; unclassified.y = 60;

    await workflow.tidy();
    assert.equal(workflow.state.tidy.frames, 1);
    assert.deepEqual([unclassified.x, unclassified.y], [0, 0]);
    assert.deepEqual([buttonFrame.x, buttonFrame.y], [800, 60]);
    assert.equal(buttonFrame.getPluginData('atlas.category'), '九宫格底板');
    assert.equal(button.name, '按钮/btn_ok');

    // 旧人工覆盖不落在当前配置里：读回时按当前规则显示，但值不被清除。
    page.selection = [button];
    await workflow.loadSelection();
    const member = workflow.state.selection.members[0];
    assert.equal(member.category, '按钮');
    assert.equal(member.manual, false);
    assert.equal(button.getPluginData('atlas.category.manual'), '九宫格底板');

    // 普通增量导入不认领、不搬动、不改写旧 Frame，也不重命名其主组件。
    await workflow.scan();
    await workflow.import();
    assert.equal(button.parent, buttonFrame);
    assert.equal(button.name, '按钮/btn_ok');
    assert.deepEqual([buttonFrame.x, buttonFrame.y], [800, 60]);
    assert.equal(buttonFrame.getPluginData('atlas.category'), '九宫格底板');
    assert.equal(buttonFrame.name, '九宫格底板');
    assert.equal(unclassified.name, 'unsorted');
  } finally { await f.cleanup(); }
});

test('点击已高亮的当前类别不产生写入，混合选择点标签批量移动实例映射的主组件', async () => {
  const f = await projectFixture();
  const fixture = figmaFixture();
  const platform = api.createFigmaPlatform(fixture.api);
  // 只换掉计数用的公开平台方法，流程仍从 Workflow 入口走。
  let writes = 0;
  const counted = { ...platform, setCategory: (...args) => { writes++; return platform.setCategory(...args); } };
  const workflow = new api.Workflow(new api.HelperClient(f.base, f.token), counted);
  try {
    await workflow.connect();
    await workflow.saveProject({ id: 'g8', name: '分类测试', path: f.project, maintained: true });
    await workflow.selectProject('g8');
    await sprite(f, 'btn_ok.json', 'btn_ok', 64, 24);
    await sprite(f, 'icon_coin.json', 'icon_coin', 32, 32);
    await workflow.scan();
    await workflow.import();
    const button = fixture.page.findAll(node => node.type === 'COMPONENT' && node.name === '按钮/btn_ok')[0];
    const icon = fixture.page.findAll(node => node.type === 'COMPONENT' && node.name === '图标/icon_coin')[0];
    assert.ok(button && icon);

    // 单选：点击与当前类别一致的标签不移动、不写人工覆盖。
    fixture.page.selection = [button];
    await workflow.loadSelection();
    assert.equal(workflow.state.selection.mixed, false);
    assert.equal(workflow.state.selection.members[0].category, '按钮');
    await workflow.setCategory('按钮');
    assert.equal(writes, 0);
    assert.equal(button.parent.name, '按钮');
    assert.equal(button.name, '按钮/btn_ok');
    assert.equal(button.getPluginData('atlas.category.manual'), '');
    assert.equal(workflow.state.phase, '就绪');

    // 混合选择：实例定位到主组件后与另一个主组件一起批量移动。
    const instance = button.createInstance();
    fixture.page.appendChild(instance);
    fixture.page.selection = [instance, icon];
    await workflow.loadSelection();
    assert.equal(workflow.state.selection.mixed, true);
    assert.deepEqual(workflow.state.selection.members.map(member => member.id).sort(), [button.id, icon.id].sort());
    assert.equal(workflow.state.selection.members.find(member => member.id === button.id).viaInstance, true);
    await workflow.setCategory('艺术字');
    assert.equal(writes, 1);
    assert.equal(button.parent.name, '艺术字');
    assert.equal(icon.parent.name, '艺术字');
    assert.equal(button.name, '艺术字/btn_ok');
    assert.equal(icon.name, '艺术字/icon_coin');
    assert.equal(button.getPluginData('atlas.category.manual'), '艺术字');
    assert.equal(icon.getPluginData('atlas.category.manual'), '艺术字');
    assert.equal(await instance.getMainComponentAsync(), button);

    // 再次点击已高亮的标签：不再写入。
    await workflow.setCategory('艺术字');
    assert.equal(writes, 1);
    assert.equal(workflow.state.selection.mixed, false);

    // 无关对象仍只计数；没有可修改组件时不写入也不报成功。
    const foreign = fixture.api.createComponent();
    fixture.page.appendChild(foreign);
    foreign.name = '用户自己的组件';
    fixture.page.selection = [foreign];
    await workflow.loadSelection();
    assert.equal(workflow.state.selection.members.length, 0);
    assert.equal(workflow.state.selection.ignored, 1);
    await assert.rejects(() => workflow.setCategory('按钮'), /没有可修改/);
    assert.equal(writes, 1);
    assert.equal(foreign.parent, fixture.page);
    assert.equal(foreign.name, '用户自己的组件');
    assert.equal(foreign.getPluginData('atlas.category.manual'), '');
  } finally { await f.cleanup(); }
});
