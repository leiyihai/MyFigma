import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import {
  projectFixture, writePng, solid, writeAtlas, writeLayout, layoutImageNode
} from '../../local-helper/tests/atlas-fixture.mjs';
import { figmaFixture } from './platform-fixture.mjs';
import * as api from '../dist/api.mjs';

const imageset = project => join(project, 'res', 'imageset', 'Static');
const layoutPath = project => join(project, 'res', 'layout', 'ui.json');
const nineSliceDir = fileURLToPath(new URL('../../nine-slice-plugin/', import.meta.url));
let pluginCode;
function nineSlicePluginCode() {
  if(pluginCode) return pluginCode;
  const built = join(nineSliceDir, 'dist', 'code.js');
  const source = join(nineSliceDir, 'code.ts');
  // A combined suite may run this package first or reuse a stale sibling build;
  // rebuild when the entry source is newer than dist.
  if(!existsSync(built) || !existsSync(source) || statSync(source).mtimeMs > statSync(built).mtimeMs)
    execFileSync(process.execPath, ['build.mjs'], { cwd: nineSliceDir, stdio: 'ignore' });
  return pluginCode = readFileSync(built, 'utf8');
}
// Drive the real nine-slice plugin entry so the recovery is not a hand-written
// record fixture: the plugin must rebuild the slices in place for the retry.
async function restoreWithNineSlicePlugin(figma, component) {
  const notices = [];
  const host = {
    showUI() {}, on() {},
    ui: { postMessage() {} },
    clientStorage: { async getAsync() { return { lang: 'zh', settingsVersion: 2 }; }, async setAsync() {} },
    currentPage: { selection: [component], async loadAsync() {} },
    getImageByHash() { return { async getBytesAsync() { return new Uint8Array([1]); } }; },
    notify(text) { notices.push(text); },
    viewport: { scrollAndZoomIntoView() {} },
    createRectangle: figma.createRectangle
  };
  vm.runInNewContext(nineSlicePluginCode(), { figma: host, __html__: '', console });
  await host.ui.onmessage({ type: 'restore-project' });
  return notices;
}

async function setup() {
  const f = await projectFixture();
  await writePng(join(imageset(f.project), 'buttons.png'), 40, 30, solid(40, 30, [10, 20, 30, 255]));
  await writeAtlas(join(imageset(f.project), 'buttons.json'), {
    image: 'buttons.png', size: { w: 40, h: 30 },
    frames: {
      panel: { frame: { x: 0, y: 0, w: 40, h: 30 } },
      plain: { frame: { x: 0, y: 0, w: 20, h: 20 }, sourceSize: { w: 20, h: 20 }, offset: { x: 0, y: 0 } }
    }
  });
  const fixture = figmaFixture();
  const workflow = new api.Workflow(new api.HelperClient(f.base, f.token), api.createFigmaPlatform(fixture.api));
  await workflow.connect();
  await workflow.saveProject({ id: 'g6', name: '九宫格测试', path: f.project, maintained: true });
  await workflow.selectProject('g6');
  return { f, workflow, ...fixture };
}

async function writePanelLayout(f, margins = '10 10 10 10', extra = []) {
  await writeLayout(layoutPath(f.project), [
    layoutImageNode('面板', 'set:buttons.json image:panel', margins),
    layoutImageNode('面板二', 'set:buttons.json image:panel', margins),
    layoutImageNode('公共', 'set:public_common.json image:shared'),
    layoutImageNode('无效小图', 'set:buttons.json image:plain', '100 100 100 100'),
    ...extra
  ]);
}

function component(page, name) {
  // The display name is 分类/原名; same-name duplicates add the source path.
  const pattern = new RegExp('(^|/)' + name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '( ·|$)');
  return page.children.flatMap(node => node.children || []).find(node => pattern.test(node.name));
}
function record(node) {
  return JSON.parse(node.data['myfigma.nineSlice.v1']);
}
function pick(plan) {
  return { added: plan.added, updated: plan.updated, removed: plan.removed, unchanged: plan.unchanged, blocked: plan.blocked };
}

test('imports the most used grid margins as one nine-slice main component and keeps unused assets plain', async () => {
  const { f, workflow, page, images } = await setup();
  try {
    await writePanelLayout(f);
    await workflow.scan();
    assert.match(workflow.state.plan.messages.join('\n'), /公共资源引用 1 项/);
    assert.match(workflow.state.plan.messages.join('\n'), /无效小图/);
    assert.deepEqual(pick(workflow.state.plan), { added: 2, updated: 0, removed: 0, unchanged: 0, blocked: 0 });
    await workflow.import();

    const panel = component(page, 'panel');
    const plain = component(page, 'plain');
    assert.ok(panel && plain);
    assert.equal(images.length, 2);
    assert.equal(panel.layoutMode, 'NONE');
    assert.deepEqual(panel.fills, []);
    assert.equal(panel.children.length, 9);
    assert.deepEqual(panel.children.map(child => child.name), [
      '切片 1-1', '切片 1-2', '切片 1-3',
      '切片 2-1', '切片 2-2', '切片 2-3',
      '切片 3-1', '切片 3-2', '切片 3-3'
    ]);
    const center = panel.children.find(child => child.name === '切片 2-2');
    assert.deepEqual(center.constraints, { horizontal: 'STRETCH', vertical: 'STRETCH' });
    assert.equal(center.fills[0].type, 'IMAGE');
    assert.equal(center.fills[0].scaleMode, 'CROP');
    assert.equal(panel.children.every(child => child.fills[0].imageHash === panel.children[0].fills[0].imageHash), true);

    const stored = record(panel);
    assert.equal(stored.schemaVersion, 1);
    assert.deepEqual(stored.margins, { left: 10, top: 10, right: 10, bottom: 10 });
    assert.deepEqual(stored.project, { left: 10, top: 10, right: 10, bottom: 10 });
    assert.deepEqual(stored.current, { left: 10, top: 10, right: 10, bottom: 10 });
    assert.equal(stored.override, false);
    assert.deepEqual([stored.width, stored.height], [40, 30]);
    assert.equal(panel.getPluginData('atlas.source').includes('"frameName":"panel"'), true);

    assert.equal(plain.children.length, 0);
    assert.equal(plain.fills.length, 1);
    assert.equal(plain.data['myfigma.nineSlice.v1'], undefined);
    // The importer leaves a cross-plugin identity marker so the nine-slice
    // plugin can tell its plain components from hand-made masters.
    const marker = JSON.parse(plain.getSharedPluginData('myfigma', 'atlas.origin'));
    assert.equal(marker.schemaVersion, 1);
    assert.equal(marker.identity, JSON.parse(plain.getPluginData('atlas.source')).identity);
  } finally { await f.cleanup(); }
});

test('a scan backfills the cross-plugin origin marker on components imported before it existed', async () => {
  const { f, workflow, page } = await setup();
  try {
    await workflow.scan();
    await workflow.import();
    const plain = component(page, 'plain');
    plain.setSharedPluginData('myfigma', 'atlas.origin', '');
    await workflow.scan();
    const marker = JSON.parse(plain.getSharedPluginData('myfigma', 'atlas.origin'));
    assert.equal(marker.schemaVersion, 1);
    assert.equal(marker.identity, JSON.parse(plain.getPluginData('atlas.source')).identity);
    assert.deepEqual(pick(workflow.state.plan), { added: 0, updated: 0, removed: 0, unchanged: 2, blocked: 0 });
  } finally { await f.cleanup(); }
});

test('upgrades a plain main component in place when a grid usage appears and never downgrades', async () => {
  const { f, workflow, page } = await setup();
  try {
    await workflow.scan();
    await workflow.import();
    const plain = component(page, 'plain');
    assert.equal(plain.children.length, 0);

    await writeLayout(layoutPath(f.project), [
      layoutImageNode('小图九宫格', 'set:buttons.json image:plain', '4 4 4 4')
    ]);
    await workflow.scan();
    assert.deepEqual(pick(workflow.state.plan), { added: 0, updated: 1, removed: 0, unchanged: 1, blocked: 0 });
    await workflow.import();
    assert.equal(component(page, 'plain'), plain);
    assert.equal(plain.children.length, 9);
    assert.deepEqual(record(plain).current, { left: 4, top: 4, right: 4, bottom: 4 });
    assert.equal(record(plain).override, false);

    const instance = {
      type: 'INSTANCE', width: 30, height: 30,
      async getMainComponentAsync() { return plain; },
      resize(width, height) { this.width = width; this.height = height; }
    };
    page.appendChild(instance);
    await rm(layoutPath(f.project));
    await workflow.scan();
    assert.deepEqual(pick(workflow.state.plan), { added: 0, updated: 0, removed: 0, unchanged: 2, blocked: 0 });
    await workflow.import();
    assert.equal(component(page, 'plain'), plain);
    assert.equal(plain.children.length, 9);
    assert.deepEqual(record(plain).current, { left: 4, top: 4, right: 4, bottom: 4 });
    assert.equal(instance.width, 30);
  } finally { await f.cleanup(); }
});

test('keeps a valid manual margin on image updates, reports unappliable margins and never writes bad slices', async () => {
  const { f, workflow, page, api: figma } = await setup();
  try {
    await writeLayout(layoutPath(f.project), [
      layoutImageNode('小图九宫格', 'set:buttons.json image:plain', '6 6 6 6')
    ]);
    await workflow.scan();
    await workflow.import();
    const plain = component(page, 'plain');
    assert.equal(plain.children.length, 9);
    const originalHash = plain.children[0].fills[0].imageHash;

    const manual = record(plain);
    manual.override = true;
    plain.setPluginData('myfigma.nineSlice.v1', JSON.stringify(manual));
    plain.setSharedPluginData('myfigma', 'nineSlice.v1', JSON.stringify(manual));
    await writeLayout(layoutPath(f.project), [
      layoutImageNode('小图九宫格', 'set:buttons.json image:plain', '4 4 4 4')
    ]);
    await writePng(join(imageset(f.project), 'buttons.png'), 40, 30, solid(40, 30, [30, 20, 10, 255]));
    await workflow.scan();
    assert.deepEqual(pick(workflow.state.plan), { added: 0, updated: 2, removed: 0, unchanged: 0, blocked: 0 });
    await workflow.import();
    assert.deepEqual(record(plain).current, { left: 6, top: 6, right: 6, bottom: 6 });
    assert.equal(record(plain).override, true);
    assert.deepEqual(record(plain).project, { left: 4, top: 4, right: 4, bottom: 4 });
    assert.notEqual(plain.children[0].fills[0].imageHash, originalHash);

    const hashBeforeFailure = plain.children[0].fills[0].imageHash;
    // The source shrinks below the manual margins: do not clamp or rebuild bad slices.
    await writePng(join(imageset(f.project), 'buttons.png'), 40, 30, solid(40, 30, [5, 6, 7, 255]));
    await writeAtlas(join(imageset(f.project), 'buttons.json'), {
      image: 'buttons.png', size: { w: 40, h: 30 },
      frames: {
        panel: { frame: { x: 0, y: 0, w: 40, h: 30 } },
        plain: { frame: { x: 0, y: 0, w: 10, h: 10 }, sourceSize: { w: 10, h: 10 }, offset: { x: 0, y: 0 } }
      }
    });
    await workflow.scan();
    assert.deepEqual(pick(workflow.state.plan), { added: 0, updated: 1, removed: 0, unchanged: 0, blocked: 1 });
    assert.match(workflow.state.plan.messages.join(String.fromCharCode(10)), /边距/);
    // The message must tell the designer how to recover instead of silently clamping.
    assert.match(workflow.state.plan.messages.join(String.fromCharCode(10)), /恢复项目参数/);
    await workflow.import();
    assert.equal(plain.children[0].fills[0].imageHash, hashBeforeFailure);
    assert.deepEqual(record(plain).current, { left: 6, top: 6, right: 6, bottom: 6 });
    assert.deepEqual([plain.width, plain.height], [20, 20]);

    // Cross-plugin recovery: the real nine-slice plugin clears the override and
    // rebuilds the slices in place from the importer's project parameter.
    const notices = await restoreWithNineSlicePlugin(figma, plain);
    assert.ok(notices.some(text => /恢复|restored/i.test(text)));
    assert.equal(record(plain).override, false);
    assert.deepEqual(record(plain).current, { left: 4, top: 4, right: 4, bottom: 4 });
    await workflow.scan();
    assert.deepEqual(pick(workflow.state.plan), { added: 0, updated: 1, removed: 0, unchanged: 1, blocked: 0 });
    await workflow.import();
    assert.equal(component(page, 'plain'), plain);
    assert.deepEqual([plain.width, plain.height], [10, 10]);
    assert.equal(plain.children.length, 9);
    assert.deepEqual(record(plain).current, { left: 4, top: 4, right: 4, bottom: 4 });
    assert.deepEqual(record(plain).project, { left: 4, top: 4, right: 4, bottom: 4 });
    assert.equal(record(plain).override, false);
  } finally { await f.cleanup(); }
});

test('skips a nine-slice component whose inner structure was changed by hand', async () => {
  const { f, workflow, page } = await setup();
  try {
    await writePanelLayout(f);
    await workflow.scan();
    await workflow.import();
    const panel = component(page, 'panel');
    const hash = panel.children[0].fills[0].imageHash;
    panel.children.push({ name: '人工新增层', type: 'RECTANGLE', fills: [] });
    await writePng(join(imageset(f.project), 'buttons.png'), 40, 30, solid(40, 30, [9, 8, 7, 255]));
    await workflow.scan();
    assert.deepEqual(pick(workflow.state.plan), { added: 0, updated: 1, removed: 0, unchanged: 0, blocked: 1 });
    assert.match(workflow.state.plan.messages.join('\n'), /内部结构/);
    await workflow.import();
    assert.equal(panel.children.length, 10);
    assert.equal(panel.children[0].fills[0].imageHash, hash);
  } finally { await f.cleanup(); }
});


// Drive the real nine-slice plugin entry so the manual upgrade is produced by
// the plugin itself, not a hand-written record fixture.
async function upgradeWithNineSlicePlugin(figma, component, imageSize, settings) {
  const notices = [];
  const host = {
    showUI() {}, on() {},
    ui: { postMessage() {} },
    clientStorage: { async getAsync() { return { lang: 'zh', settingsVersion: 2 }; }, async setAsync() {} },
    currentPage: { selection: [component], async loadAsync() {} },
    getImageByHash() {
      return {
        async getBytesAsync() { return new Uint8Array([1]); },
        async getSizeAsync() { return imageSize; }
      };
    },
    notify(text) { notices.push(text); },
    viewport: { scrollAndZoomIntoView() {} },
    createRectangle: figma.createRectangle
  };
  vm.runInNewContext(nineSlicePluginCode(), { figma: host, __html__: '', console });
  await host.ui.onmessage({
    type: 'generate', left: 0, right: 0, top: 0, bottom: 0, all: 0, overlap: false,
    keepOriginal: false, batchMode: false, lang: 'zh', ...settings
  });
  return notices;
}

test('manually upgraded plain component keeps manual margins, its current size and instances across incremental imports', async () => {
  const { f, workflow, page, api: figma } = await setup();
  try {
    await workflow.scan();
    await workflow.import();
    const plain = component(page, 'plain');
    assert.equal(plain.children.length, 0);
    const id = plain.id;

    // The designer resized the master and uses an instance at a design size.
    plain.resize(120, 60);
    const instance = {
      type: 'INSTANCE', width: 30, height: 30,
      async getMainComponentAsync() { return plain; },
      resize(width, height) { this.width = width; this.height = height; }
    };
    page.appendChild(instance);

    // Preview and margins are in original image pixels (20x20), not the 120x60 canvas.
    const notices = await upgradeWithNineSlicePlugin(figma, plain, { width: 20, height: 20 }, {
      left: 4, right: 4, top: 4, bottom: 4
    });
    assert.ok(notices.length > 0);
    assert.equal(component(page, 'plain'), plain);
    assert.equal(plain.id, id);
    assert.deepEqual([plain.width, plain.height], [120, 60]);
    assert.equal(plain.children.length, 9);
    const upgraded = record(plain);
    assert.deepEqual(upgraded.current, { left: 4, top: 4, right: 4, bottom: 4 });
    assert.deepEqual(upgraded.imageSize, { width: 20, height: 20 });
    assert.deepEqual([upgraded.width, upgraded.height], [120, 60]);
    assert.equal(upgraded.override, true);
    assert.match(plain.getPluginData('atlas.source'), /"frameName":"plain"/);
    assert.deepEqual([instance.width, instance.height], [30, 30]);

    // An unchanged import recognises the manual upgrade instead of rewriting it.
    await workflow.scan();
    assert.deepEqual(pick(workflow.state.plan), { added: 0, updated: 0, removed: 0, unchanged: 2, blocked: 0 });
    await workflow.import();
    assert.equal(component(page, 'plain'), plain);
    assert.deepEqual([plain.width, plain.height], [120, 60]);
    assert.deepEqual(record(plain).current, { left: 4, top: 4, right: 4, bottom: 4 });
    assert.deepEqual([instance.width, instance.height], [30, 30]);

    // A project parameter appearing never replaces the manual margins.
    await writeLayout(layoutPath(f.project), [
      layoutImageNode('普通', 'set:buttons.json image:plain', '6 6 6 6')
    ]);
    await workflow.scan();
    assert.deepEqual(pick(workflow.state.plan), { added: 0, updated: 1, removed: 0, unchanged: 1, blocked: 0 });
    await workflow.import();
    assert.equal(component(page, 'plain'), plain);
    assert.deepEqual([plain.width, plain.height], [120, 60]);
    assert.deepEqual(record(plain).current, { left: 4, top: 4, right: 4, bottom: 4 });
    assert.deepEqual(record(plain).project, { left: 6, top: 6, right: 6, bottom: 6 });
    assert.equal(record(plain).override, true);

    // Updating the image pixels keeps the manual margins and the current canvas.
    const previousHash = plain.children[0].fills[0].imageHash;
    await writePng(join(imageset(f.project), 'buttons.png'), 40, 30, solid(40, 30, [90, 40, 10, 255]));
    await workflow.scan();
    assert.deepEqual(pick(workflow.state.plan), { added: 0, updated: 2, removed: 0, unchanged: 0, blocked: 0 });
    await workflow.import();
    assert.equal(component(page, 'plain'), plain);
    assert.notEqual(plain.children[0].fills[0].imageHash, previousHash);
    assert.deepEqual([plain.width, plain.height], [120, 60]);
    assert.deepEqual(record(plain).current, { left: 4, top: 4, right: 4, bottom: 4 });
    assert.deepEqual(record(plain).imageSize, { width: 20, height: 20 });
    assert.deepEqual([instance.width, instance.height], [30, 30]);

    // The source shrinks below the manual margins: skip and explain, never clamp.
    const keptHash = plain.children[0].fills[0].imageHash;
    await writeAtlas(join(imageset(f.project), 'buttons.json'), {
      image: 'buttons.png', size: { w: 40, h: 30 },
      frames: {
        panel: { frame: { x: 0, y: 0, w: 40, h: 30 } },
        plain: { frame: { x: 0, y: 0, w: 6, h: 6 }, sourceSize: { w: 6, h: 6 }, offset: { x: 0, y: 0 } }
      }
    });
    await workflow.scan();
    assert.deepEqual(pick(workflow.state.plan), { added: 0, updated: 0, removed: 0, unchanged: 1, blocked: 1 });
    assert.match(workflow.state.plan.messages.join('\n'), /边距/);
    await workflow.import();
    assert.equal(plain.children[0].fills[0].imageHash, keptHash);
    assert.deepEqual([plain.width, plain.height], [120, 60]);
    assert.deepEqual(record(plain).current, { left: 4, top: 4, right: 4, bottom: 4 });
    assert.deepEqual([instance.width, instance.height], [30, 30]);
  } finally { await f.cleanup(); }
});

test('restoring project parameters on a manually upgraded component keeps its canvas and instance sizes', async () => {
  const { f, workflow, page, api: figma } = await setup();
  try {
    await workflow.scan();
    await workflow.import();
    const plain = component(page, 'plain');
    plain.resize(120, 60);
    const instance = {
      type: 'INSTANCE', width: 30, height: 30,
      async getMainComponentAsync() { return plain; },
      resize(width, height) { this.width = width; this.height = height; }
    };
    page.appendChild(instance);
    await upgradeWithNineSlicePlugin(figma, plain, { width: 20, height: 20 }, {
      left: 4, right: 4, top: 4, bottom: 4
    });
    assert.deepEqual(record(plain).project, undefined);

    await writeLayout(layoutPath(f.project), [
      layoutImageNode('普通', 'set:buttons.json image:plain', '6 6 6 6')
    ]);
    await workflow.scan();
    await workflow.import();
    const withProject = record(plain);
    assert.deepEqual(withProject.project, { left: 6, top: 6, right: 6, bottom: 6 });
    assert.deepEqual(withProject.current, { left: 4, top: 4, right: 4, bottom: 4 });
    assert.equal(withProject.override, true);

    // Restoring uses the recorded project parameter in place, keeping the canvas.
    const notices = await restoreWithNineSlicePlugin(figma, plain);
    assert.ok(notices.some(text => /恢复|restored/i.test(text)));
    const restored = record(plain);
    assert.deepEqual(restored.current, { left: 6, top: 6, right: 6, bottom: 6 });
    assert.deepEqual(restored.project, { left: 6, top: 6, right: 6, bottom: 6 });
    assert.equal(restored.override, false);
    assert.deepEqual([plain.width, plain.height], [120, 60]);
    assert.deepEqual(restored.imageSize, { width: 20, height: 20 });
    assert.equal(plain.children.length, 9);
    assert.equal(plain.children.find(child => child.name === '切片 2-1').width, 36);
    assert.deepEqual([instance.width, instance.height], [30, 30]);

    // The importer recognises the restored record without resizing the canvas.
    await workflow.scan();
    assert.deepEqual(pick(workflow.state.plan), { added: 0, updated: 0, removed: 0, unchanged: 2, blocked: 0 });
    await workflow.import();
    assert.deepEqual([plain.width, plain.height], [120, 60]);
    assert.deepEqual(record(plain).current, { left: 6, top: 6, right: 6, bottom: 6 });

    // A source that no longer fits the project parameter is skipped and reported.
    const keptHash = plain.children[0].fills[0].imageHash;
    await writeAtlas(join(imageset(f.project), 'buttons.json'), {
      image: 'buttons.png', size: { w: 40, h: 30 },
      frames: {
        panel: { frame: { x: 0, y: 0, w: 40, h: 30 } },
        plain: { frame: { x: 0, y: 0, w: 8, h: 8 }, sourceSize: { w: 8, h: 8 }, offset: { x: 0, y: 0 } }
      }
    });
    await workflow.scan();
    assert.deepEqual(pick(workflow.state.plan), { added: 0, updated: 0, removed: 0, unchanged: 1, blocked: 1 });
    assert.match(workflow.state.plan.messages.join('\n'), /九宫格边距无法应用/);
    await workflow.import();
    assert.equal(plain.children[0].fills[0].imageHash, keptHash);
    assert.deepEqual([plain.width, plain.height], [120, 60]);
  } finally { await f.cleanup(); }
});
