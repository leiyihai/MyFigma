import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { projectFixture, writePng, solid, writeAtlas } from '../../local-helper/tests/atlas-fixture.mjs';
import { figmaFixture } from './platform-fixture.mjs';
import * as api from '../dist/api.mjs';

const atlas = (project, image = 'buttons.png') => join(project, 'res', 'imageset', 'Static', 'buttons.json');
const image = project => join(project, 'res', 'imageset', 'Static', 'buttons.png');

async function setup() {
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
  const workflow = new api.Workflow(new api.HelperClient(f.base, f.token), api.createFigmaPlatform(fixture.api));
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
