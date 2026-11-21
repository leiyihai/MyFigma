import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { projectFixture, writePng, solid, writeAtlas } from '../../local-helper/tests/atlas-fixture.mjs';
import { figmaFixture } from './platform-fixture.mjs';
import * as api from '../dist/api.mjs';

const atlas = (project, image = 'buttons.png') => join(project, 'res', 'imageset', 'Static', 'buttons.json');
const image = project => join(project, 'res', 'imageset', 'Static', 'buttons.png');

async function setup(changed = () => {}) {
  const f = await projectFixture();
  await writePng(image(f.project), 3, 1, [
    255, 0, 0, 255,
    0, 255, 0, 255,
    0, 0, 255, 255
  ]);
  await writeAtlas(atlas(f.project), {
    image: 'buttons.png', size: { w: 3, h: 1 },
    frames: {
      red: { frame: { x: 0, y: 0, w: 1, h: 1 } },
      green: { frame: { x: 1, y: 0, w: 1, h: 1 } }
    }
  });
  const fixture = figmaFixture();
  const workflow = new api.Workflow(new api.HelperClient(f.base, f.token), api.createFigmaPlatform(fixture.api), changed);
  await workflow.connect();
  await workflow.saveProject({ id: 'g4', name: '增量测试', path: f.project, maintained: true });
  await workflow.selectProject('g4');
  return { f, workflow, ...fixture };
}

function component(page, name) {
  return page.children.flatMap(node => node.children || []).find(node => node.name.includes('/' + name + ' ·'));
}

test('previews added and unchanged counts, updates in place, and marks source removal without deleting', async () => {
  const { f, workflow, page, images } = await setup();
  try {
    await workflow.scan();
    assert.ok(page.loadCount >= 1, 'dynamic-page preview must load the page before findAll()');
    assert.deepEqual(pick(workflow.state.plan), { added: 2, updated: 0, removed: 0, unchanged: 0, blocked: 0 });
    await workflow.import();
    const red = component(page, 'red');
    const green = component(page, 'green');
    assert.ok(red && green);
    const originalRed = red;
    // Imported page is now non-empty, but a bound page can be updated incrementally.
    await workflow.scan();
    assert.deepEqual(pick(workflow.state.plan), { added: 0, updated: 0, removed: 0, unchanged: 2, blocked: 0 });
    await workflow.import();
    assert.equal(component(page, 'red'), originalRed);
    assert.equal(page.children.flatMap(node => node.children || []).length, 2);

    const originalImageHash = red.fills[0].imageHash;
    const imagesBeforeUpdate = images.length;
    await writePng(image(f.project), 3, 1, [
      0, 0, 255, 255,
      0, 255, 0, 255,
      0, 0, 255, 255
    ]);
    await workflow.scan();
    assert.deepEqual(pick(workflow.state.plan), { added: 0, updated: 1, removed: 0, unchanged: 1, blocked: 0 });
    // A design instance keeps its dimensions when the main component is updated.
    const instance = {
      type: 'INSTANCE', width: 8, height: 8,
      async getMainComponentAsync() { return originalRed; },
      resize(width, height) { this.width = width; this.height = height; }
    };
    page.appendChild(instance);
    const resizeMain = originalRed.resize.bind(originalRed);
    originalRed.resize = (width, height) => { resizeMain(width, height); instance.width = width; instance.height = height; };
    await workflow.import();
    assert.equal(component(page, 'red'), originalRed);
    assert.equal(images.length, imagesBeforeUpdate + 1);
    assert.equal(red.fills[0].imageHash, `image-${imagesBeforeUpdate + 1}`);
    assert.notEqual(red.fills[0].imageHash, originalImageHash);
    assert.equal(instance.width, 8);
    assert.equal(instance.height, 8);

    await writeAtlas(atlas(f.project), {
      image: 'buttons.png', size: { w: 3, h: 1 },
      frames: {
        red: { frame: { x: 0, y: 0, w: 1, h: 1 } },
        green: { frame: { x: 1, y: 0, w: 1, h: 1 }, sourceSize: { w: 2, h: 2 } }
      }
    });
    await workflow.scan();
    assert.deepEqual(pick(workflow.state.plan), { added: 0, updated: 1, removed: 0, unchanged: 1, blocked: 0 });
    await workflow.import();
    assert.deepEqual([component(page, 'green').width, component(page, 'green').height], [2, 2]);

    await rm(atlas(f.project));
    await rm(image(f.project));
    await workflow.scan();
    assert.deepEqual(pick(workflow.state.plan), { added: 0, updated: 0, removed: 2, unchanged: 0, blocked: 0 });
    const before = page.children.flatMap(node => node.children || []).length;
    await workflow.import();
    assert.equal(page.children.flatMap(node => node.children || []).length, before);
    assert.equal(JSON.parse(originalRed.data['atlas.sync.v1']).status, 'source-missing');
  } finally { await f.cleanup(); }
});

test('rename and cross-atlas movement become source removal plus a new identity', async () => {
  const { f, workflow, page } = await setup();
  try {
    await workflow.scan();
    await workflow.import();
    const oldRed = component(page, 'red');
    const moved = join(f.project, 'res', 'imageset', 'Moved', 'moved.json');
    await writeAtlas(moved, {
      image: 'buttons.png', size: { w: 3, h: 1 },
      frames: { renamed: { frame: { x: 0, y: 0, w: 1, h: 1 } } }
    });
    await writePng(join(f.project, 'res', 'imageset', 'Moved', 'buttons.png'), 3, 1, [
      255, 0, 0, 255,
      0, 255, 0, 255,
      0, 0, 255, 255
    ]);
    await rm(atlas(f.project));
    await rm(image(f.project));
    await workflow.scan();
    assert.deepEqual(pick(workflow.state.plan), { added: 1, updated: 0, removed: 2, unchanged: 0, blocked: 0 });
    await workflow.import();
    assert.equal(component(page, 'red'), oldRed);
    assert.ok(component(page, 'renamed'));
    assert.ok(component(page, 'green'));
    assert.equal(JSON.parse(component(page, 'green').data['atlas.sync.v1']).status, 'source-missing');
  } finally { await f.cleanup(); }
});

test('incomplete scans do not mark removals and manual structure changes are skipped', async () => {
  const { f, workflow, page } = await setup();
  try {
    await workflow.scan();
    await workflow.import();
    const red = component(page, 'red');
    const originalHash = red.fills[0].imageHash;
    red.fills[0].imageHash = 'manual-image-hash';
    await workflow.scan();
    assert.deepEqual(pick(workflow.state.plan), { added: 0, updated: 0, removed: 0, unchanged: 1, blocked: 1 });
    assert.match(workflow.state.plan.messages.join('\n'), /图片填充/);
    red.fills[0].imageHash = originalHash;
    red.children.push({ name: '人工新增层', type: 'RECTANGLE' });
    await workflow.scan();
    assert.deepEqual(pick(workflow.state.plan), { added: 0, updated: 0, removed: 0, unchanged: 1, blocked: 1 });
    assert.match(workflow.state.plan.messages.join('\n'), /内部结构/);
    await workflow.import();
    assert.equal(red.children.length, 1);

    red.children = [];
    await rm(atlas(f.project));
    await rm(image(f.project));
    await writeFile(join(f.project, 'res', 'imageset', 'broken.json'), '{');
    await workflow.scan();
    assert.equal(workflow.state.scan.complete, false);
    assert.deepEqual(pick(workflow.state.plan), { added: 0, updated: 0, removed: 0, unchanged: 0, blocked: 0 });
    assert.equal(workflow.state.plan.removalSuppressed, true);
    const before = page.children.flatMap(node => node.children || []).length;
    await workflow.import();
    assert.equal(page.children.flatMap(node => node.children || []).length, before);
  } finally { await f.cleanup(); }
});

function pick(plan) {
  return {
    added: plan.added, updated: plan.updated, removed: plan.removed,
    unchanged: plan.unchanged, blocked: plan.blocked
  };
}

test('a cancelled import leaves pending source removals unmarked and retries idempotently', async () => {
  let current;
  let armed = false;
  let cancelled = false;
  const built = await setup(() => {
    if (armed && !cancelled && current?.state.busy && current.state.phase === '导入中' && current.state.progress.done === 1) {
      cancelled = true;
      current.cancel();
    }
  });
  current = built.workflow;
  const { f, page } = built;
  try {
    await current.scan();
    await current.import();
    const red = component(page, 'red');
    const green = component(page, 'green');
    // Replace the atlas with one new sprite so the next plan adds one item and removes two.
    await writeAtlas(atlas(f.project), {
      image: 'buttons.png', size: { w: 3, h: 1 },
      frames: { blue: { frame: { x: 2, y: 0, w: 1, h: 1 } } }
    });
    await current.scan();
    assert.deepEqual(pick(current.state.plan), { added: 1, updated: 0, removed: 2, unchanged: 0, blocked: 0 });
    armed = true;
    await current.import();
    assert.equal(current.state.result.cancelled, true);
    assert.deepEqual(current.state.result.applied, { added: 1, updated: 0, removed: 0 });
    assert.equal(current.state.phase, '已取消');
    assert.ok(component(page, 'blue'));
    // Cancelled items are neither success nor source deletion.
    assert.equal(JSON.parse(red.data['atlas.sync.v1']).status, 'current');
    assert.equal(JSON.parse(green.data['atlas.sync.v1']).status, 'current');
    // The kept scan reports the unfinished work instead of treating it as done.
    await current.scan();
    assert.deepEqual(pick(current.state.plan), { added: 0, updated: 0, removed: 2, unchanged: 1, blocked: 0 });
    await current.import();
    assert.equal(current.state.result.cancelled, false);
    assert.deepEqual(current.state.result.applied, { added: 0, updated: 0, removed: 2 });
    assert.equal(JSON.parse(red.data['atlas.sync.v1']).status, 'source-missing');
    assert.equal(JSON.parse(green.data['atlas.sync.v1']).status, 'source-missing');
    assert.equal(page.children.flatMap(node => node.children || []).length, 3);
    assert.deepEqual(page.children.flatMap(node => node.children || [])
      .map(node => JSON.parse(node.data['atlas.source']).identity).sort(), [
      '["g4","atlas","Static/buttons.json","blue"]',
      '["g4","atlas","Static/buttons.json","green"]',
      '["g4","atlas","Static/buttons.json","red"]'
    ]);
  } finally { await f.cleanup(); }
});

test('a failed update restores that component and the next run applies it', async () => {
  const { f, workflow, page, api: figma } = await setup();
  try {
    await workflow.scan();
    await workflow.import();
    const red = component(page, 'red');
    const originalHash = red.fills[0].imageHash;
    const originalSync = red.data['atlas.sync.v1'];
    await writePng(image(f.project), 3, 1, [
      0, 255, 0, 255,
      0, 0, 255, 255,
      255, 0, 0, 255
    ]);
    await workflow.scan();
    assert.deepEqual(pick(workflow.state.plan), { added: 0, updated: 2, removed: 0, unchanged: 0, blocked: 0 });
    const createImage = figma.createImage;
    figma.createImage = () => { throw new Error('Figma image rejected'); };
    await workflow.import();
    assert.equal(workflow.state.result.failures.length, 2);
    assert.deepEqual(workflow.state.result.applied, { added: 0, updated: 0, removed: 0 });
    assert.equal(workflow.state.phase, '部分失败');
    // The failed update must not look successful or corrupted.
    assert.equal(red.fills[0].imageHash, originalHash);
    assert.equal(red.data['atlas.sync.v1'], originalSync);
    figma.createImage = createImage;
    await workflow.import();
    assert.equal(workflow.state.result.failures.length, 0);
    assert.deepEqual(workflow.state.result.applied, { added: 0, updated: 2, removed: 0 });
    assert.notEqual(red.fills[0].imageHash, originalHash);
    assert.equal(JSON.parse(red.data['atlas.sync.v1']).status, 'current');
  } finally { await f.cleanup(); }
});

test('a cleared managed source record blocks duplicate recreation', async () => {
  const { f, workflow, page } = await setup();
  try {
    await workflow.scan();
    await workflow.import();
    const red = component(page, 'red');
    red.setPluginData('atlas.source', '');
    await assert.rejects(workflow.scan(), /来源记录损坏/);
  } finally { await f.cleanup(); }
});
