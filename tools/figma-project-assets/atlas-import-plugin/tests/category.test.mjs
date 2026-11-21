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

test('按名称、九宫格用法与尺寸比例归入分类 Frame，唯一主组件不复制', async () => {
  const { f, workflow, page, root } = await setup();
  try {
    // 名称规则：按钮 / 图标 / 背景 / 艺术字；九宫格底板由布局用法判定。
    await sprite(f, 'btn_ok.json', 'btn_ok', 64, 24);
    await sprite(f, 'panel_base.json', 'panel_base', 40, 30);
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
        '九宫格底板/panel_base',
        '背景/bg_main',
        '背景/huge_scene',
        '艺术字/wordart_title'
      ].sort()
    );
    // 每个分类 Frame 独立存在且带本工具标记；主组件只有一套，不创建对照页或副本。
    const components = page.findAll(node => node.type === 'COMPONENT');
    assert.equal(components.length, 10);
    assert.equal(page.children.filter(node => node.type === 'FRAME').length, 6);
    assert.equal(root.children.length, 1);
    for (const category of ['按钮', '九宫格底板', '图标', '背景', '艺术字', '未分类']) {
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
  const sorted = [...frames].sort((left, right) => left.y - right.y);
  for (let index = 1; index < sorted.length; index += 1) {
    assert.ok(sorted[index - 1].y + sorted[index - 1].height <= sorted[index].y,
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

test('尺寸比例或九宫格用法变化时移动主组件到新分类，保留身份、来源与实例关系统计', async () => {
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
    assert.equal(slices.name, '九宫格底板/shape_thing');
    assert.equal(slices.parent.name, '九宫格底板');
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
    await sprite(f, 'icon_coin.json', 'icon_coin', 32, 32);
    await sprite(f, 'bg_main.json', 'bg_main', 32, 32);
    await writeLayout(layoutPath(f.project), [
      layoutImageNode('面板', 'set:panel_base.json image:panel_base', '8 8 8 8')
    ]);
    await workflow.scan();
    await workflow.import();
    const frames = page.children.filter(node => node.getPluginData('atlas.category'));
    const components = page.findAll(node => node.type === 'COMPONENT');
    const panel = components.find(node => node.name === '九宫格底板/panel_base');
    const center = panel.children.find(child => child.name === '切片 2-2');
    const constraints = { ...center.constraints };

    // A user (or earlier placements) can leave every category frame stacked at the same spot.
    for (const frame of frames) { frame.x = 120; frame.y = 0; }
    await workflow.tidy();
    assert.equal(workflow.state.tidy.schemaVersion, 1);
    assert.equal(workflow.state.tidy.frames, 4);
    assert.equal(workflow.state.tidy.moved, 4);
    assert.equal(workflow.state.phase, '就绪');
    const ordered = [...frames].sort((left, right) => left.y - right.y);
    assert.deepEqual(ordered.map(frame => frame.name), ['按钮', '九宫格底板', '图标', '背景']);
    assert.ok(ordered.every(frame => frame.x === 0));
    for (let index = 1; index < ordered.length; index += 1) {
      assert.equal(ordered[index].y, ordered[index - 1].y + ordered[index - 1].height + 48);
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
