import { test } from 'node:test';
import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { projectFixture, writePng, solid, writeAtlas } from '../../local-helper/tests/atlas-fixture.mjs';
import { figmaFixture } from './platform-fixture.mjs';
import * as api from '../dist/api.mjs';

const imageset = project => join(project, 'res', 'imageset', 'Static');
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
const identityOf = (component) => JSON.parse(component.getPluginData('atlas.source')).identity;
const componentNamed = (page, name) => page.findAll(node => node.type === 'COMPONENT' && node.name === name)[0];

test('训练样本只导出人工覆盖的来源身份与当前类别，自动分类与旧类别不进入', async () => {
  const { f, workflow, platform, page } = await setup();
  try {
    await sprite(f, 'btn_ok.json', 'btn_ok', 64, 24);
    await sprite(f, 'icon_coin.json', 'icon_coin', 32, 32);
    await workflow.scan();
    await workflow.import();
    const button = componentNamed(page, '按钮/btn_ok');
    const icon = componentNamed(page, '图标/icon_coin');
    assert.ok(button && icon);

    // 自动分类结果不是训练真值：没有人工覆盖时导出的样本为空。
    assert.deepEqual(await platform.trainingSamples({ id: 'g8', name: '分类测试' }), {
      schemaVersion: 1, projectId: 'g8', samples: [], ignored: 0
    });

    // 人工点击类别标签后，来源身份保持不变，类别取人工覆盖。
    page.selection = [button];
    await workflow.loadSelection();
    await workflow.setCategory('艺术字');
    assert.equal(button.getPluginData('atlas.category.manual'), '艺术字');
    const identity = identityOf(button);
    const exported = await platform.trainingSamples({ id: 'g8', name: '分类测试' });
    assert.deepEqual(exported, {
      schemaVersion: 1, projectId: 'g8',
      samples: [{ identity, category: '艺术字' }], ignored: 0
    });
    // 自动分类的图标仍被过滤；身份来自 atlas.source，不是显示名。
    assert.equal(exported.samples.some(sample => sample.identity === identityOf(icon)), false);

    // 旧类别值不算当前人工覆盖（页面配置里没有它），不进入样本。
    icon.setPluginData('atlas.category.manual', '九宫格底板');
    const filtered = await platform.trainingSamples({ id: 'g8', name: '分类测试' });
    assert.deepEqual(filtered.samples, [{ identity, category: '艺术字' }]);

    // 非本项目的资源页拒绝导出，而不是导出一份错身份的样本。
    await assert.rejects(platform.trainingSamples({ id: 'g99', name: '别的游戏' }), /其他项目/);
  } finally { await f.cleanup(); }
});

test('提交训练样本写入项目级本机文件，重复提交按最新人工标签整体覆盖', async () => {
  const { f, workflow, page } = await setup();
  try {
    await sprite(f, 'btn_ok.json', 'btn_ok', 64, 24);
    await sprite(f, 'icon_coin.json', 'icon_coin', 32, 32);
    await workflow.scan();
    await workflow.import();
    const button = componentNamed(page, '按钮/btn_ok');
    const icon = componentNamed(page, '图标/icon_coin');
    page.selection = [button];
    await workflow.loadSelection();
    await workflow.setCategory('艺术字');

    await workflow.submitTraining();
    assert.equal(workflow.state.phase, '就绪');
    assert.match(workflow.state.notice, /1/);
    assert.match(workflow.state.notice, /训练/);
    const path = join(f.data, 'samples', 'g8.json');
    const first = JSON.parse(await readFile(path, 'utf8'));
    assert.equal(first.projectId, 'g8');
    assert.deepEqual(first.samples, [{ identity: identityOf(button), category: '艺术字' }]);
    // 响应和落盘都不含本机绝对路径。
    assert.equal(JSON.stringify(first).includes(f.data), false);

    // 第二个组件也人工覆盖后再次提交：文件包含最新两条。
    page.selection = [icon];
    await workflow.loadSelection();
    await workflow.setCategory('底板');
    await workflow.submitTraining();
    assert.match(workflow.state.notice, /2/);
    const second = JSON.parse(await readFile(path, 'utf8'));
    assert.deepEqual(second.samples.map(sample => sample.category).sort(), ['底板', '艺术字'].sort());
    assert.deepEqual(second.samples.map(sample => sample.identity).sort(),
      [identityOf(button), identityOf(icon)].sort());

    // 修改人工类别后重复提交是覆盖而不是追加。
    page.selection = [button];
    await workflow.loadSelection();
    await workflow.setCategory('背景');
    await workflow.submitTraining();
    const replaced = JSON.parse(await readFile(path, 'utf8')).samples;
    assert.equal(replaced.length, 2);
    assert.equal(replaced.find(sample => sample.identity === identityOf(button)).category, '背景');
  } finally { await f.cleanup(); }
});

test('同一来源身份重复出现时只导出第一条，并报告被忽略的重复身份数量', async () => {
  const { f, workflow, platform, page, api: figma } = await setup();
  try {
    await sprite(f, 'btn_ok.json', 'btn_ok', 64, 24);
    await workflow.scan();
    await workflow.import();
    const button = componentNamed(page, '按钮/btn_ok');
    page.selection = [button];
    await workflow.loadSelection();
    await workflow.setCategory('艺术字');

    // 手工制造同一来源身份的第二个主组件（例如复制粘贴后仍带来源记录）。
    const duplicate = figma.createComponent();
    page.appendChild(duplicate);
    duplicate.name = '按钮/btn_ok 副本';
    duplicate.setPluginData('atlas.source', button.getPluginData('atlas.source'));
    duplicate.setPluginData('atlas.category.manual', '背景');

    // 只导出第一条，不静默丢弃重复项，而是把忽略数量返回给调用方。
    const exported = await platform.trainingSamples({ id: 'g8', name: '分类测试' });
    assert.equal(exported.samples.length, 1);
    assert.equal(exported.ignored, 1);
    assert.equal(exported.samples[0].identity, identityOf(button));

    // 成功提示里体现忽略数量，落盘仍只有一条样本。
    await workflow.submitTraining();
    assert.match(workflow.state.notice, /已提交 1 个标签/);
    assert.match(workflow.state.notice, /忽略 1 个重复身份/);
    const written = JSON.parse(await readFile(join(f.data, 'samples', 'g8.json'), 'utf8'));
    assert.deepEqual(written.samples, exported.samples);
  } finally { await f.cleanup(); }
});

test('没有人工覆盖时明确提示且不写入空样本', async () => {
  const { f, workflow } = await setup();
  try {
    await sprite(f, 'btn_ok.json', 'btn_ok', 64, 24);
    await workflow.scan();
    await workflow.import();
    await workflow.submitTraining();
    assert.equal(workflow.state.phase, '就绪');
    assert.match(workflow.state.notice, /人工/);
    let exists = true;
    try { await access(join(f.data, 'samples', 'g8.json')); } catch { exists = false; }
    assert.equal(exists, false);
  } finally { await f.cleanup(); }
});
