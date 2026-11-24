const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');

function setup(sizes = [[100, 80]], options = {}) {
  const created = [], notices = [], messages = [], saved = [], events = {};
  const rectangles = [], images = [];
  const parent = { appendChild(node) { node.parent = this; } };
  const sources = sizes.map(([width, height], index) => ({
    id: `source-${index}`,
    width, height, x: 20, y: 30, name: 'Test', parent,
    fills: [{ type: 'IMAGE', imageHash: 'image' }],
    remove() { this.removed = true; }
  }));
  function node(type = 'RECTANGLE') {
    return {
      type, children: [], removed: false,
      data: {},
      getPluginData(key) { return this.data[key] || ''; },
      setPluginData(key, value) { this.data[key] = value; },
      getSharedPluginData(ns, key) { return (this.shared || {})[ns + '/' + key] || ''; },
      setSharedPluginData(ns, key, value) { (this.shared ||= {})[ns + '/' + key] = value; },
      resize(width, height) { this.width = width; this.height = height; },
      appendChild(child) { child.parent = this; this.children.push(child); },
      remove() { this.removed = true; if (this.parent && Array.isArray(this.parent.children)) this.parent.children = this.parent.children.filter(child => child !== this); }
    };
  }
  const figma = {
    showUI() {}, on(name, handler) { events[name] = handler; },
    ui: { postMessage(msg) { messages.push(msg); } },
    clientStorage: { async getAsync() { return options.saved; }, async setAsync(key, value) { saved.push({ key, value }); } },
    currentPage: { selection: sources },
    getImageByHash(hash) {
      const bytes = options.getBytes || (async () => new Uint8Array([1]));
      const imageSize = options.imageSize || { width: 100, height: 80 };
      return { getBytesAsync: bytes, getSizeAsync: async () => ({ ...imageSize }) };
    },
    notify(text) { notices.push(text); }, viewport: { scrollAndZoomIntoView() {} },
    createComponent() { const result = node('COMPONENT'); created.push(result); return result; },
    createRectangle() { const result = node('RECTANGLE'); rectangles.push(result); return result; },
    createImage(bytes) {
      images.push(bytes);
      return { hash: 'created-image-' + images.length,
        getBytesAsync: async () => bytes, getSizeAsync: async () => ({ width: 1, height: 1 }) };
    }
  };
  vm.runInNewContext(fs.readFileSync('dist/code.js', 'utf8'), { figma, __html__: '', console });
  const settings = {
    type: 'generate', left: 10, right: 10, top: 10, bottom: 10, all: 10,
    overlap: false, keepOriginal: true, batchMode: false, lang: 'zh'
  };
  return { figma, created, rectangles, images, sources, notices, messages, settings, saved, events };
}

test('generates nine constrained slices in the original parent', async () => {
  const env = setup();
  await env.figma.ui.onmessage(env.settings);
  const component = env.created[0];
  assert.equal(component.parent, env.sources[0].parent);
  assert.equal(component.x, 170);
  assert.equal(component.children.length, 9);
  assert.equal(component.children[4].constraints.horizontal, 'STRETCH');
  assert.equal(component.children[4].constraints.vertical, 'STRETCH');
  assert.equal(component.children[4].width, 80);
  assert.equal(component.layoutMode, 'NONE');
  assert.deepEqual(JSON.parse(JSON.stringify(component.children[4].fills[0].imageTransform)), [[0.8, 0, 0.1], [0, 0.75, 0.125]]);
  assert.equal(env.sources[0].removed, undefined);
});
test('rejects invalid and non-finite margins without removing originals', async () => {
  for (const left of [-1, NaN, Infinity, 90]) {
    const env = setup();
    await env.figma.ui.onmessage({ ...env.settings, left, keepOriginal: false });
    assert.equal(env.created.length, 0);
    assert.equal(env.sources[0].removed, undefined);
  }
});
test('batch validates even the smallest target before creating anything', async () => {
  const env = setup([[100, 80], [15, 15]]);
  await env.figma.ui.onmessage({ ...env.settings, batchMode: true });
  assert.equal(env.created.length, 0);
});
test('batch keeps every original when retaining them is requested', async () => {
  const env = setup([[100, 80], [60, 60]]);
  await env.figma.ui.onmessage({ ...env.settings, batchMode: true, keepOriginal: true });
  assert.equal(env.created.length, 2);
  assert.equal(env.created[0].parent, env.sources[0].parent);
  assert.ok(env.sources.every(source => source.removed === undefined));
});
test('batch creates components and removes originals only when requested', async () => {
  const env = setup([[100, 80], [60, 60]]);
  await env.figma.ui.onmessage({ ...env.settings, batchMode: true, keepOriginal: false });
  assert.equal(env.created.length, 2);
  assert.ok(env.sources.every(source => source.removed));
});
test('zero margins never generate zero-sized crop transforms', async () => {
  const env = setup();
  await env.figma.ui.onmessage({ ...env.settings, left: 0, right: 0, top: 0, bottom: 0 });
  assert.equal(env.created[0].children.length, 1);
  assert.equal(env.created[0].children[0].fills[0].imageTransform[0][0], 1);
});
test('creation failure rolls back components and preserves originals', async () => {
  const env = setup();
  env.figma.createRectangle = () => { throw new Error('Simulated failure'); };
  await env.figma.ui.onmessage({ ...env.settings, keepOriginal: false });
  assert.ok(env.created[0].removed);
  assert.equal(env.sources[0].removed, undefined);
});
test('single mode converts only the first image and restores saved settings', async () => {
  const env = setup([[100, 80], [60, 60]], { saved: { left: 5, lang: 'zh', overlap: false } });
  await new Promise(setImmediate);
  const init = env.messages.find(msg => msg.type === 'init-settings');
  assert.equal(init.settings.left, 5);
  assert.equal(init.settings.keepOriginal, false);
  assert.equal(init.settings.batchMode, false);
  assert.equal(init.settings.settingsVersion, 2);
  await env.figma.ui.onmessage({ ...env.settings, type: 'save-only', left: 6 });
  assert.equal(env.created.length, 0);
  assert.equal(env.saved.at(-1).value.left, 6);
  await env.figma.ui.onmessage({ ...env.settings, keepOriginal: false });
  assert.equal(env.created.length, 1);
  assert.ok(env.sources[0].removed);
  assert.equal(env.sources[1].removed, undefined);
});

test('new and legacy sessions default the three switches off, then persist deliberate changes', async () => {
  const fresh = setup();
  await new Promise(setImmediate);
  const freshInit = fresh.messages.find(msg => msg.type === 'init-settings').settings;
  assert.deepEqual([freshInit.overlap, freshInit.keepOriginal, freshInit.batchMode], [false, false, false]);

  const legacy = setup([[100, 80]], { saved: { overlap: true, keepOriginal: true, batchMode: true, lang: 'zh', left: 7 } });
  await new Promise(setImmediate);
  const legacyInit = legacy.messages.find(msg => msg.type === 'init-settings').settings;
  assert.deepEqual([legacyInit.overlap, legacyInit.keepOriginal, legacyInit.batchMode], [false, false, false]);
  assert.equal(legacyInit.left, 7);

  await legacy.figma.ui.onmessage({ ...legacy.settings, type: 'save-only', overlap: true, keepOriginal: true, batchMode: true });
  const stored = legacy.saved.at(-1).value;
  assert.equal(stored.settingsVersion, 2);

  const restored = setup([[100, 80]], { saved: stored });
  await new Promise(setImmediate);
  const restoredInit = restored.messages.find(msg => msg.type === 'init-settings').settings;
  assert.deepEqual([restoredInit.overlap, restoredInit.keepOriginal, restoredInit.batchMode], [true, true, true]);
});

test('editing a generated component updates it in place and keeps one component', async () => {
  const env = setup();
  await env.figma.ui.onmessage(env.settings);
  const component = env.created[0];
  env.figma.currentPage.selection = [component];
  await env.figma.ui.onmessage({ ...env.settings, left: 20, right: 5, top: 6, bottom: 7 });
  assert.equal(env.created.length, 1);
  assert.equal(component.children.length, 9);
  const saved = JSON.parse(component.data['myfigma.nineSlice.v1']);
  // An unscaled edit keeps the generated record shape; adding an explicit
  // imageSize would change the importer's canvas-preservation decision.
  assert.equal(saved.imageSize, undefined);
  assert.deepEqual(saved.margins, { left: 20, right: 5, top: 6, bottom: 7 });
  assert.equal(component.children.find(child => child.name === '切片 2-1').width, 20);
});

test('a resized 9-slice component previews margins in original image pixels', async () => {
  const env = setup([[256, 256]], { imageSize: { width: 256, height: 256 } });
  const settings = { ...env.settings, left: 60, right: 40, top: 50, bottom: 80 };
  await env.figma.ui.onmessage(settings);
  const component = env.created[0];
  assert.deepEqual([component.width, component.height], [256, 256]);
  component.resize(858, 769);
  env.figma.currentPage.selection = [component];
  await env.figma.ui.onmessage({ type: 'ui-ready' });
  await new Promise(resolve => setTimeout(resolve, 0));
  const preview = env.messages.filter(message => message.type === 'update-preview').at(-1);
  assert.equal(preview.edit.target, 'component');
  assert.deepEqual(JSON.parse(JSON.stringify(preview.edit.margins)),
    { left: 60, right: 40, top: 50, bottom: 80 });
  assert.deepEqual(JSON.parse(JSON.stringify(preview.edit.imageSize)), { width: 256, height: 256 });
  assert.equal(preview.width, 256);
  assert.equal(preview.height, 256);
});

test('applying margins to a resized 9-slice component keeps its image-pixel record and instances', async () => {
  const env = setup([[256, 256]], { imageSize: { width: 256, height: 256 } });
  await env.figma.ui.onmessage({ ...env.settings, left: 60, right: 40, top: 50, bottom: 80 });
  const component = env.created[0];
  const instance = {
    type: 'INSTANCE', name: '底板实例', width: 300, height: 200, fills: [], children: [],
    async getMainComponentAsync() { return component; },
    resize(width, height) { this.width = width; this.height = height; }
  };
  component.resize(858, 769);
  env.figma.currentPage.selection = [component];
  await env.figma.ui.onmessage({ ...env.settings, left: 70, right: 30, top: 45, bottom: 85 });

  assert.equal(env.created.length, 1);
  assert.equal(env.created[0], component);
  assert.deepEqual([component.width, component.height], [858, 769]);
  assert.equal(await instance.getMainComponentAsync(), component);
  assert.deepEqual([instance.width, instance.height], [300, 200]);

  const saved = JSON.parse(component.data['myfigma.nineSlice.v1']);
  assert.deepEqual(saved.current, { left: 70, right: 30, top: 45, bottom: 85 });
  assert.deepEqual(saved.imageSize, { width: 256, height: 256 });
  assert.deepEqual([saved.width, saved.height], [858, 769]);
  const child = name => component.children.find(node => node.name === name);
  // Submitted values stay image pixels; only the slices use the enlarged canvas.
  assert.equal(child('切片 2-1').width, 70 * 858 / 256);
  assert.equal(child('切片 2-3').width, 30 * 858 / 256);
  assert.equal(child('切片 1-2').height, 45 * 769 / 256);
  assert.equal(child('切片 3-2').height, 85 * 769 / 256);
});

test('editing a legacy overlap component preserves overlap and derives margins', async () => {
  const env = setup();
  const settings = { ...env.settings, overlap: true };
  await env.figma.ui.onmessage(settings);
  const component = env.created[0];
  component.data = {};
  component.shared = {};
  env.figma.currentPage.selection = [component];
  await env.figma.ui.onmessage({ ...settings, left: 14, right: 6, top: 8, bottom: 9 });
  const saved = JSON.parse(component.data['myfigma.nineSlice.v1']);
  assert.deepEqual(saved.margins, { left: 14, right: 6, top: 8, bottom: 9 });
  assert.equal(saved.overlap, true);
});

test('a failed component update leaves the previous slices intact', async () => {
  const env = setup();
  await env.figma.ui.onmessage(env.settings);
  const component = env.created[0];
  env.figma.currentPage.selection = [component];
  env.figma.createRectangle = () => { throw new Error('Simulated update failure'); };
  await env.figma.ui.onmessage({ ...env.settings, left: 18 });
  assert.equal(component.children.length, 9);
  assert.equal(component.children.some(child => child.removed), false);
  assert.ok(env.notices.some(text => text.includes('更新失败')));
});

test('selecting an instance prompts for its main component instead of editing it', async () => {
  const env = setup();
  await env.figma.ui.onmessage(env.settings);
  const component = env.created[0];
  const instance = {
    type: 'INSTANCE', name: '底板实例', width: 120, height: 90, fills: [], children: [],
    async getMainComponentAsync() { return component; }
  };
  env.figma.currentPage.selection = [instance];
  await env.figma.ui.onmessage({ type: 'ui-ready' });
  await new Promise(resolve => setTimeout(resolve, 0));
  const preview = env.messages.filter(message => message.type === 'update-preview').at(-1);
  assert.equal(preview.edit.editable, false);
  assert.equal(preview.edit.name, component.name);
  await env.figma.ui.onmessage({ ...env.settings, left: 25 });
  assert.equal(component.children.length, 9);
  assert.equal(JSON.parse(component.data['myfigma.nineSlice.v1']).margins.left, 10);
});

test('editing a legacy component derives margins and writes the editable metadata', async () => {
  const env = setup();
  await env.figma.ui.onmessage(env.settings);
  const component = env.created[0];
  component.data = {};
  component.shared = {};
  env.figma.currentPage.selection = [component];
  await env.figma.ui.onmessage({ ...env.settings, left: 12, right: 8, top: 9, bottom: 11 });
  assert.equal(env.created.length, 1);
  const saved = JSON.parse(component.data['myfigma.nineSlice.v1']);
  assert.deepEqual(saved.margins, { left: 12, right: 8, top: 9, bottom: 11 });
});

test('a late old image cannot overwrite a newer selection or cleared selection', async () => {
  for (const clear of [false, true]) {
    let release;
    let first = true;
    const env = setup([[100, 80], [60, 60]], { getBytes: () => {
      if (first) { first = false; return new Promise(resolve => { release = resolve; }); }
      return Promise.resolve(new Uint8Array([2]));
    } });
    env.figma.currentPage.selection = clear ? [] : [env.sources[1]];
    env.events.selectionchange();
    await new Promise(setImmediate);
    release(new Uint8Array([1]));
    await new Promise(setImmediate);
    const previews = env.messages.filter(msg => msg.type === 'update-preview');
    assert.equal(previews.length, 1);
    assert.equal(previews[0].bytes?.[0] ?? null, clear ? null : 2);
    if (!clear) assert.equal(previews[0].width, 60);
  }
});

test('a later batch failure removes every partial result, never originals', async () => {
  const env = setup([[100, 80], [60, 60]]);
  const createRectangle = env.figma.createRectangle;
  let rectangles = 0;
  env.figma.createRectangle = () => {
    if (++rectangles === 10) throw new Error('Simulated second source failure');
    return createRectangle();
  };
  await env.figma.ui.onmessage({ ...env.settings, batchMode: true, keepOriginal: false });
  assert.ok(env.created.every(component => component.removed));
  assert.ok(env.sources.every(source => !source.removed));
});

test('no selection reports a notification', async () => {
  const env = setup([]);
  await env.figma.ui.onmessage(env.settings);
  assert.equal(env.created.length, 0);
  assert.ok(env.notices.some(text => text.includes('图片')));
});

test('reads and writes the shared project/current/override record used by the atlas importer', async () => {
  const env = setup();
  await env.figma.ui.onmessage(env.settings);
  const component = env.created[0];
  const generated = JSON.parse(component.data['myfigma.nineSlice.v1']);
  assert.equal(generated.project, undefined);
  assert.deepEqual(generated.current, { left: 10, top: 10, right: 10, bottom: 10 });
  assert.equal(generated.override, true);

  // Simulate an atlas-imported record: project statistics 8, current 10, no manual override yet.
  setRecord(component, {
    schemaVersion: 1, margins: { left: 10, top: 10, right: 10, bottom: 10 }, overlap: false,
    width: 100, height: 80, project: { left: 8, top: 8, right: 8, bottom: 8 },
    current: { left: 10, top: 10, right: 10, bottom: 10 }, override: false
  });
  env.figma.currentPage.selection = [component];
  await env.figma.ui.onmessage({ ...env.settings, left: 12, right: 7, top: 9, bottom: 11 });
  const edited = JSON.parse(component.data['myfigma.nineSlice.v1']);
  assert.deepEqual(edited.project, { left: 8, top: 8, right: 8, bottom: 8 });
  assert.deepEqual(edited.current, { left: 12, top: 9, right: 7, bottom: 11 });
  assert.deepEqual(edited.margins, { left: 12, top: 9, right: 7, bottom: 11 });
  assert.equal(edited.override, true);
});

function setRecord(component, record) {
  component.setPluginData('myfigma.nineSlice.v1', JSON.stringify(record));
  component.setSharedPluginData('myfigma', 'nineSlice.v1', JSON.stringify(record));
}
function atlasRecord(override = false) {
  return {
    schemaVersion: 1, margins: { left: 10, top: 10, right: 10, bottom: 10 }, overlap: false,
    width: 100, height: 80, project: { left: 8, top: 8, right: 8, bottom: 8 },
    current: { left: 10, top: 10, right: 10, bottom: 10 }, override
  };
}

test('an invalid saved manual margin still falls back to slice geometry instead of generating a new component', async () => {
  const env = setup();
  await env.figma.ui.onmessage(env.settings);
  const component = env.created[0];
  setRecord(component, { ...atlasRecord(true), project: { left: 8, top: 8, right: 8, bottom: 8 },
    current: { left: 60, top: 60, right: 60, bottom: 60 },
    margins: { left: 60, top: 60, right: 60, bottom: 60 } });
  env.figma.currentPage.selection = [component];
  await env.figma.ui.onmessage({ ...env.settings, left: 20, right: 5, top: 8, bottom: 9 });
  assert.equal(env.created.length, 1);
  assert.equal(component.children.length, 9);
  const saved = JSON.parse(component.data['myfigma.nineSlice.v1']);
  assert.deepEqual(saved.project, { left: 8, top: 8, right: 8, bottom: 8 });
  assert.deepEqual(saved.current, { left: 20, right: 5, top: 8, bottom: 9 });
  assert.equal(saved.override, true);
});

test('submitting unchanged margins keeps the importer project state without a new manual override', async () => {
  const env = setup();
  await env.figma.ui.onmessage(env.settings);
  const component = env.created[0];
  setRecord(component, atlasRecord(false));
  env.figma.currentPage.selection = [component];
  await env.figma.ui.onmessage(env.settings);
  let saved = JSON.parse(component.data['myfigma.nineSlice.v1']);
  assert.deepEqual(saved.current, { left: 10, right: 10, top: 10, bottom: 10 });
  assert.deepEqual(saved.project, { left: 8, right: 8, top: 8, bottom: 8 });
  assert.equal(saved.override, false);

  await env.figma.ui.onmessage({ ...env.settings, left: 12 });
  saved = JSON.parse(component.data['myfigma.nineSlice.v1']);
  assert.deepEqual(saved.current, { left: 12, right: 10, top: 10, bottom: 10 });
  assert.deepEqual(saved.project, { left: 8, right: 8, top: 8, bottom: 8 });
  assert.equal(saved.override, true);
});

test('restoring project parameters clears the manual override in place and keeps instances linked', async () => {
  const env = setup();
  await env.figma.ui.onmessage(env.settings);
  const component = env.created[0];
  setRecord(component, { ...atlasRecord(true), current: { left: 12, top: 9, right: 7, bottom: 11 },
    margins: { left: 12, top: 9, right: 7, bottom: 11 } });
  const instance = {
    type: 'INSTANCE', name: '底板实例', width: 120, height: 90, fills: [], children: [],
    async getMainComponentAsync() { return component; },
    resize(width, height) { this.width = width; this.height = height; }
  };
  env.figma.currentPage.selection = [component];
  await env.figma.ui.onmessage({ type: 'restore-project' });

  assert.equal(env.created.length, 1);
  assert.equal(env.created[0], component);
  assert.equal(await instance.getMainComponentAsync(), component);
  assert.deepEqual([instance.width, instance.height], [120, 90]);
  const saved = JSON.parse(component.data['myfigma.nineSlice.v1']);
  assert.deepEqual(saved.current, { left: 8, top: 8, right: 8, bottom: 8 });
  assert.deepEqual(saved.project, { left: 8, top: 8, right: 8, bottom: 8 });
  assert.equal(saved.override, false);
  assert.equal(component.children.length, 9);
  assert.equal(component.children.find(child => child.name === '切片 2-1').width, 8);
  assert.ok(env.notices.some(text => text.includes('恢复')));
});

test('restore refuses missing or unappliable project margins and keeps existing slices', async () => {
  const missing = setup();
  await missing.figma.ui.onmessage(missing.settings);
  const generated = missing.created[0];
  const before = generated.data['myfigma.nineSlice.v1'];
  missing.figma.currentPage.selection = [generated];
  await missing.figma.ui.onmessage({ type: 'restore-project' });
  assert.equal(generated.children.length, 9);
  assert.equal(generated.data['myfigma.nineSlice.v1'], before);
  assert.ok(missing.notices.some(text => text.includes('项目参数')));

  const invalid = setup();
  await invalid.figma.ui.onmessage(invalid.settings);
  const component = invalid.created[0];
  setRecord(component, { ...atlasRecord(true), project: { left: 60, top: 60, right: 60, bottom: 60 } });
  const hash = JSON.stringify(component.data['myfigma.nineSlice.v1']);
  invalid.figma.currentPage.selection = [component];
  await invalid.figma.ui.onmessage({ type: 'restore-project' });
  assert.equal(component.children.length, 9);
  assert.equal(JSON.stringify(component.data['myfigma.nineSlice.v1']), hash);
  assert.ok(invalid.notices.some(text => text.includes('无法') || text.includes('边距')));
});

test('selecting an instance with an image fill never converts or deletes it', async () => {
  const env = setup();
  const instance = {
    type: 'INSTANCE', name: '普通组件实例', width: 100, height: 80, children: [],
    fills: [{ type: 'IMAGE', imageHash: 'image' }],
    removed: false,
    async getMainComponentAsync() { return { type: 'COMPONENT', name: '普通组件', children: [], fills: [] }; },
    remove() { this.removed = true; }
  };
  env.figma.currentPage.selection = [instance];
  await env.figma.ui.onmessage({ ...env.settings, keepOriginal: false });
  assert.equal(env.created.length, 0);
  assert.equal(instance.removed, false);
  assert.ok(env.notices.some(text => text.includes('主组件')));
});

test('an unrecognized component gets a clear prompt instead of being rebuilt', async () => {
  const env = setup();
  const component = {
    type: 'COMPONENT', name: '人工复杂组件', width: 100, height: 80, fills: [], data: {},
    children: [{ type: 'RECTANGLE', name: '图层A', fills: [], children: [] }],
    getPluginData(key) { return this.data[key] || ''; },
    setPluginData(key, value) { this.data[key] = value; },
    remove() { this.removed = true; }
  };
  env.figma.currentPage.selection = [component];
  await env.figma.ui.onmessage(env.settings);
  assert.equal(env.created.length, 0);
  assert.equal(component.removed, undefined);
  assert.equal(component.children.length, 1);
  assert.ok(env.notices.some(text => text.includes('无法识别') || text.includes('不是本工具')));
});

test('selection payloads tell the UI whether margins are manual, project-driven or legacy', async () => {
  const env = setup();
  await env.figma.ui.onmessage(env.settings);
  const component = env.created[0];
  component.data = {};
  component.shared = {};
  env.figma.currentPage.selection = [component];
  await env.figma.ui.onmessage({ type: 'ui-ready' });
  await new Promise(resolve => setTimeout(resolve, 0));
  let preview = env.messages.filter(message => message.type === 'update-preview').at(-1);
  assert.equal(preview.edit.legacy, true);
  assert.equal(preview.edit.project, undefined);
  assert.equal(preview.edit.override, true);

  setRecord(component, atlasRecord(false));
  await env.figma.ui.onmessage({ type: 'ui-ready' });
  await new Promise(resolve => setTimeout(resolve, 0));
  preview = env.messages.filter(message => message.type === 'update-preview').at(-1);
  assert.equal(preview.edit.legacy, false);
  assert.deepEqual(JSON.parse(JSON.stringify(preview.edit.project)), { left: 8, right: 8, top: 8, bottom: 8 });
  assert.equal(preview.edit.override, false);
});

function plainComponent(options = {}) {
  const component = {
    type: 'COMPONENT', id: options.id || 'component-id', name: options.name || '底板/普通底板',
    width: options.width ?? 160, height: options.height ?? 120,
    children: [], layoutMode: options.layoutMode || 'NONE', removed: false,
    data: { ...(options.data || {}) }, shared: {},
    fills: options.fills ?? [{ type: 'IMAGE', imageHash: 'plain-image', scaleMode: 'FILL' }],
    getPluginData(key) { return this.data[key] || ''; },
    setPluginData(key, value) { this.data[key] = value; },
    getSharedPluginData(ns, key) { return (this.shared || {})[ns + '/' + key] || ''; },
    setSharedPluginData(ns, key, value) { (this.shared ||= {})[ns + '/' + key] = value; },
    resize(width, height) { this.width = width; this.height = height; },
    appendChild(child) { child.parent = this; this.children.push(child); },
    remove() { this.removed = true; }
  };
  // The importer may write this cross-plugin marker, but it is only an optional
  // source hint; a hand-made single-image component must upgrade too.
  if (options.marked !== false) {
    component.setSharedPluginData('myfigma', 'atlas.origin', JSON.stringify({
      schemaVersion: 1, identity: JSON.stringify(['g1', 'atlas', 'res/buttons.png', 'plain'])
    }));
  }
  return component;
}

// A direct image child is the other Figma structure designers get when they
// drop an image and create a component: the root stays empty and the image is a
// single fully covering child layer.
function imageChild(owner, options = {}) {
  const child = {
    type: options.type || 'RECTANGLE', name: options.name || '图片子层',
    x: options.x ?? 0, y: options.y ?? 0,
    width: options.width ?? owner.width, height: options.height ?? owner.height,
    children: [], removed: false,
    fills: options.fills ?? [{ type: 'IMAGE', imageHash: 'plain-image', scaleMode: 'FILL' }],
    appendChild(node) { node.parent = this; this.children.push(node); },
    remove() { this.removed = true; owner.children = owner.children.filter(item => item !== this); }
  };
  if (options.layoutMode) child.layoutMode = options.layoutMode;
  if (options.cornerRadius !== undefined) child.cornerRadius = options.cornerRadius;
  if (options.strokes) child.strokes = options.strokes;
  if (options.effects) child.effects = options.effects;
  owner.appendChild(child);
  return child;
}
function childImageComponent(options = {}) {
  const component = plainComponent({ ...options, fills: options.rootFills ?? [] });
  const child = imageChild(component, options.child || {});
  return { component, child };
}

test('upgrades an importer plain image main component in place, previewing original pixels and keeping its current size', async () => {
  const env = setup([[10, 10]], { imageSize: { width: 64, height: 40 } });
  const component = plainComponent();
  env.figma.currentPage.selection = [component];
  await env.figma.ui.onmessage({ type: 'ui-ready' });
  await new Promise(resolve => setTimeout(resolve, 0));
  const preview = env.messages.filter(message => message.type === 'update-preview').at(-1);
  assert.equal(preview.width, 64);
  assert.equal(preview.height, 40);
  assert.equal(preview.edit.target, 'upgrade');
  assert.equal(preview.edit.editable, true);
  assert.deepEqual(JSON.parse(JSON.stringify(preview.edit.imageSize)), { width: 64, height: 40 });

  await env.figma.ui.onmessage({ ...env.settings, left: 16, right: 8, top: 4, bottom: 2 });
  // Same component upgraded in place: no replacement component, no second master.
  assert.equal(env.created.length, 0);
  assert.equal(component.removed, false);
  assert.deepEqual([component.width, component.height], [160, 120]);
  assert.equal(component.fills.length, 0);
  assert.equal(component.children.length, 9);
  const child = name => component.children.find(node => node.name === name);
  // Margins are entered in original image pixels and scaled to the current canvas.
  assert.equal(child('切片 2-1').width, 40);
  assert.equal(child('切片 1-2').height, 12);
  assert.equal(child('切片 2-3').width, 20);
  assert.equal(child('切片 3-2').height, 6);
  const saved = JSON.parse(component.data['myfigma.nineSlice.v1']);
  assert.deepEqual(saved.margins, { left: 16, right: 8, top: 4, bottom: 2 });
  assert.deepEqual(saved.current, { left: 16, right: 8, top: 4, bottom: 2 });
  assert.deepEqual(saved.imageSize, { width: 64, height: 40 });
  assert.deepEqual([saved.width, saved.height], [160, 120]);
  assert.equal(saved.override, true);
  assert.equal(saved.project, undefined);
  // The atlas importer reads shared plugin data, not this plugin's private store.
  assert.equal(component.shared['myfigma/nineSlice.v1'], component.data['myfigma.nineSlice.v1']);
});

test('rejects margins that only fit the current canvas but overflow the original image pixels', async () => {
  const env = setup([[10, 10]], { imageSize: { width: 64, height: 40 } });
  const component = plainComponent();
  env.figma.currentPage.selection = [component];
  await env.figma.ui.onmessage({ ...env.settings, left: 40, right: 30, top: 4, bottom: 2 });
  assert.equal(component.children.length, 0);
  assert.equal(component.fills.length, 1);
  assert.equal(component.data['myfigma.nineSlice.v1'], undefined);
  assert.ok(env.notices.some(text => /边距/.test(text)));
});

test('an instance of a plain image component is never upgraded; it only locates the main component', async () => {
  const env = setup([[10, 10]], { imageSize: { width: 64, height: 40 } });
  const component = plainComponent();
  const instance = {
    type: 'INSTANCE', name: '普通底板实例', width: 300, height: 200, fills: [], children: [],
    async getMainComponentAsync() { return component; }
  };
  env.figma.currentPage.selection = [instance];
  await env.figma.ui.onmessage({ type: 'ui-ready' });
  await new Promise(resolve => setTimeout(resolve, 0));
  let preview = env.messages.filter(message => message.type === 'update-preview').at(-1);
  assert.equal(preview.edit.target, 'upgrade');
  assert.equal(preview.edit.editable, false);
  assert.deepEqual([preview.width, preview.height], [64, 40]);
  assert.deepEqual(JSON.parse(JSON.stringify(preview.edit.imageSize)), { width: 64, height: 40 });

  await env.figma.ui.onmessage({ ...env.settings, left: 16 });
  assert.equal(component.children.length, 0);
  assert.equal(component.fills.length, 1);
  assert.equal(component.data['myfigma.nineSlice.v1'], undefined);
  assert.deepEqual([instance.width, instance.height], [300, 200]);

  env.messages.length = 0;
  await env.figma.ui.onmessage({ type: 'locate-main-component' });
  assert.equal(env.figma.currentPage.selection[0], component);
  assert.ok(env.notices.some(text => /主组件/.test(text)));
  assert.equal(component.children.length, 0);
  await new Promise(resolve => setTimeout(resolve, 0));
  preview = env.messages.filter(message => message.type === 'update-preview').at(-1);
  assert.equal(preview.edit.editable, true);
});

test('a manually changed or complex component is rejected without touching its content', async () => {
  const env = setup([[10, 10]], { imageSize: { width: 64, height: 40 } });
  const complex = plainComponent({ name: '人工改造底板' });
  complex.children = [{ type: 'RECTANGLE', name: '自绘边框', fills: [], children: [], data: {} }];
  env.figma.currentPage.selection = [complex];
  await env.figma.ui.onmessage({ ...env.settings, left: 8 });
  assert.equal(env.created.length, 0);
  assert.equal(complex.children.length, 1);
  assert.equal(complex.fills.length, 1);
  assert.equal(complex.data['myfigma.nineSlice.v1'], undefined);
  assert.ok(env.notices.some(text => /无法识别|额外/.test(text)));

  const multiFill = plainComponent({ name: '双层填充' });
  multiFill.fills = [{ type: 'IMAGE', imageHash: 'a' }, { type: 'SOLID', color: { r: 0, g: 0, b: 0 } }];
  env.figma.currentPage.selection = [multiFill];
  await env.figma.ui.onmessage({ ...env.settings, left: 8 });
  assert.equal(multiFill.children.length, 0);
  assert.equal(multiFill.fills.length, 2);
  assert.equal(multiFill.data['myfigma.nineSlice.v1'], undefined);
});

test('a failed upgrade leaves the plain component with its image fill and no partial slices', async () => {
  const env = setup([[10, 10]], { imageSize: { width: 64, height: 40 } });
  const component = plainComponent();
  component.appendChild = function () { throw new Error('Simulated append failure'); };
  env.figma.currentPage.selection = [component];
  await env.figma.ui.onmessage({ ...env.settings, left: 16, right: 8, top: 4, bottom: 2 });
  assert.equal(component.children.length, 0);
  assert.equal(component.fills.length, 1);
  assert.equal(component.fills[0].type, 'IMAGE');
  assert.deepEqual([component.width, component.height], [160, 120]);
  assert.ok(!component.data['myfigma.nineSlice.v1']);
  assert.ok(env.notices.some(text => text.includes('升级失败')));
});


test('an unmarked hand-made root-fill component upgrades without an importer marker', async () => {
  const env = setup([[10, 10]], { imageSize: { width: 64, height: 40 } });
  const component = plainComponent({ marked: false });
  env.figma.currentPage.selection = [component];
  await env.figma.ui.onmessage({ type: 'ui-ready' });
  await new Promise(resolve => setTimeout(resolve, 0));
  const preview = env.messages.filter(message => message.type === 'update-preview').at(-1);
  assert.equal(preview.edit.target, 'upgrade');
  assert.equal(preview.edit.editable, true);
  assert.equal(preview.edit.imported, false);
  assert.deepEqual([preview.width, preview.height], [64, 40]);

  await env.figma.ui.onmessage({ ...env.settings, left: 8, right: 8, top: 4, bottom: 4 });
  assert.equal(env.created.length, 0);
  assert.equal(component.removed, false);
  assert.equal(component.fills.length, 0);
  assert.equal(component.children.length, 9);
  assert.deepEqual([component.width, component.height], [160, 120]);
  assert.deepEqual(JSON.parse(component.data['myfigma.nineSlice.v1']).current,
    { left: 8, right: 8, top: 4, bottom: 4 });
});

test('an importer marker only labels the upgrade source instead of gating it', async () => {
  const env = setup([[10, 10]], { imageSize: { width: 64, height: 40 } });
  const component = plainComponent();
  env.figma.currentPage.selection = [component];
  await env.figma.ui.onmessage({ type: 'ui-ready' });
  await new Promise(resolve => setTimeout(resolve, 0));
  const preview = env.messages.filter(message => message.type === 'update-preview').at(-1);
  assert.equal(preview.edit.target, 'upgrade');
  assert.equal(preview.edit.editable, true);
  assert.equal(preview.edit.imported, true);

  await env.figma.ui.onmessage({ ...env.settings, left: 8, right: 8, top: 4, bottom: 4 });
  assert.equal(component.children.length, 9);
  assert.equal(component.fills.length, 0);
  assert.ok(component.data['myfigma.nineSlice.v1']);
});

test('upgrades a component whose only direct image child fully covers it and replaces that child in place', async () => {
  const env = setup([[10, 10]], { imageSize: { width: 64, height: 40 } });
  const { component, child } = childImageComponent({ marked: false, id: 'component-7' });
  const instance = {
    type: 'INSTANCE', name: '普通底板实例', width: 300, height: 200, fills: [], children: [],
    async getMainComponentAsync() { return component; }
  };
  env.figma.currentPage.selection = [component];
  await env.figma.ui.onmessage({ type: 'ui-ready' });
  await new Promise(resolve => setTimeout(resolve, 0));
  const preview = env.messages.filter(message => message.type === 'update-preview').at(-1);
  assert.equal(preview.edit.target, 'upgrade');
  assert.equal(preview.edit.editable, true);
  assert.equal(preview.edit.imported, false);
  assert.deepEqual([preview.width, preview.height], [64, 40]);

  await env.figma.ui.onmessage({ ...env.settings, left: 16, right: 8, top: 4, bottom: 2 });
  assert.equal(env.created.length, 0);
  assert.equal(component.removed, false);
  assert.equal(component.id, 'component-7');
  assert.deepEqual([component.width, component.height], [160, 120]);
  assert.equal(component.fills.length, 0);
  assert.equal(child.removed, true);
  assert.equal(component.children.length, 9);
  assert.equal(component.children.includes(child), false);
  assert.ok(component.children.every(node => /^切片 [1-3]-[1-3]$/.test(node.name)));
  const slice = name => component.children.find(node => node.name === name);
  assert.equal(slice('切片 2-1').width, 40);
  assert.equal(slice('切片 1-2').height, 12);
  assert.equal(slice('切片 2-3').width, 20);
  assert.equal(slice('切片 3-2').height, 6);
  const saved = JSON.parse(component.data['myfigma.nineSlice.v1']);
  assert.deepEqual(saved.current, { left: 16, right: 8, top: 4, bottom: 2 });
  assert.deepEqual(saved.imageSize, { width: 64, height: 40 });
  assert.deepEqual([saved.width, saved.height], [160, 120]);
  assert.equal(await instance.getMainComponentAsync(), component);
  assert.deepEqual([instance.width, instance.height], [300, 200]);
});

test('rejects a single image child that does not fully cover the component', async () => {
  const env = setup([[10, 10]], { imageSize: { width: 64, height: 40 } });
  const { component, child } = childImageComponent({ marked: false, child: { width: 120, x: 4 } });
  env.figma.currentPage.selection = [component];
  await env.figma.ui.onmessage({ type: 'ui-ready' });
  await new Promise(resolve => setTimeout(resolve, 0));
  const preview = env.messages.filter(message => message.type === 'update-preview').at(-1);
  assert.equal(preview.unsupported, 'image-child-not-filled');
  await env.figma.ui.onmessage({ ...env.settings, left: 8 });
  assert.equal(component.children.length, 1);
  assert.equal(component.children[0], child);
  assert.equal(component.fills.length, 0);
  assert.equal(component.data['myfigma.nineSlice.v1'], undefined);
  assert.ok(env.notices.some(text => /铺满/.test(text)));
});

test('rejects multiple child layers and extra visible content in a plain image component', async () => {
  const multiple = setup([[10, 10]], { imageSize: { width: 64, height: 40 } });
  const doubled = childImageComponent({ marked: false });
  imageChild(doubled.component, { name: '第二张图片' });
  multiple.figma.currentPage.selection = [doubled.component];
  await multiple.figma.ui.onmessage(multiple.settings);
  assert.equal(doubled.component.children.length, 2);
  assert.equal(doubled.component.data['myfigma.nineSlice.v1'], undefined);
  assert.ok(multiple.notices.some(text => /多个|额外|一张/.test(text)));

  const extra = setup([[10, 10]], { imageSize: { width: 64, height: 40 } });
  const mixed = childImageComponent({
    marked: false, rootFills: [{ type: 'SOLID', color: { r: 0, g: 0, b: 0 }, visible: true }]
  });
  extra.figma.currentPage.selection = [mixed.component];
  await extra.figma.ui.onmessage(extra.settings);
  assert.equal(mixed.component.children.length, 1);
  assert.equal(mixed.component.data['myfigma.nineSlice.v1'], undefined);
  assert.ok(extra.notices.some(text => /多个|额外|一张/.test(text)));

  // The image child must not carry its own layers or an extra visible fill.
  for (const decorate of [
    child => imageChild(child, { name: '子层的子层' }),
    child => { child.fills = [{ type: 'IMAGE', imageHash: 'plain-image' },
      { type: 'SOLID', color: { r: 0, g: 0, b: 0 }, visible: true }]; }
  ]) {
    const env = setup([[10, 10]], { imageSize: { width: 64, height: 40 } });
    const nested = childImageComponent({ marked: false });
    decorate(nested.child);
    env.figma.currentPage.selection = [nested.component];
    await env.figma.ui.onmessage(env.settings);
    assert.equal(nested.component.children.length, 1);
    assert.equal(nested.component.data['myfigma.nineSlice.v1'], undefined);
    assert.ok(env.notices.some(text => /多个|额外|一张/.test(text)));
  }
});

test('rejects image children with rounded corners, strokes or effects instead of dropping them', async () => {
  for (const decoration of [{ cornerRadius: 4 }, { strokes: [{ type: 'SOLID', visible: true }] },
    { effects: [{ type: 'DROP_SHADOW', visible: true }] }]) {
    const env = setup([[10, 10]], { imageSize: { width: 64, height: 40 } });
    const { component } = childImageComponent({ marked: false, child: decoration });
    env.figma.currentPage.selection = [component];
    await env.figma.ui.onmessage({ ...env.settings, left: 8 });
    assert.equal(component.children.length, 1);
    assert.equal(component.data['myfigma.nineSlice.v1'], undefined);
    assert.ok(env.notices.some(text => /圆角|描边|效果/.test(text)), `missing hint for ${JSON.stringify(decoration)}`);
  }
});

test('rejects Auto Layout plain image components and keeps them untouched', async () => {
  const env = setup([[10, 10]], { imageSize: { width: 64, height: 40 } });
  const component = plainComponent({ marked: false, layoutMode: 'VERTICAL' });
  env.figma.currentPage.selection = [component];
  await env.figma.ui.onmessage({ type: 'ui-ready' });
  await new Promise(resolve => setTimeout(resolve, 0));
  const preview = env.messages.filter(message => message.type === 'update-preview').at(-1);
  assert.equal(preview.unsupported, 'auto-layout');
  await env.figma.ui.onmessage({ ...env.settings, left: 8 });
  assert.equal(component.children.length, 0);
  assert.equal(component.fills.length, 1);
  assert.equal(component.data['myfigma.nineSlice.v1'], undefined);
  assert.ok(env.notices.some(text => /Auto Layout|自动布局/.test(text)));
});

test('an invalid record falls back to slice geometry in image pixels without scaling it twice', async () => {
  const env = setup([[200, 100]], { imageSize: { width: 200, height: 100 } });
  await env.figma.ui.onmessage({ ...env.settings, left: 20, right: 20, top: 10, bottom: 10 });
  const component = env.created[0];
  // The record keeps the designer's 200x100 canvas while margins stay in 50x25
  // original image pixels; these saved margins no longer fit the canvas.
  setRecord(component, {
    schemaVersion: 1, margins: { left: 120, top: 50, right: 120, bottom: 50 }, overlap: false,
    width: 200, height: 100, imageSize: { width: 50, height: 25 },
    current: { left: 120, top: 50, right: 120, bottom: 50 }, override: true
  });
  env.figma.currentPage.selection = [component];
  await env.figma.ui.onmessage({ type: 'ui-ready' });
  await new Promise(resolve => setTimeout(resolve, 0));
  const preview = env.messages.filter(message => message.type === 'update-preview').at(-1);
  // Canvas geometry 20/10/20/10 divided by the 4x scale belongs to the 50x25 image.
  assert.deepEqual(JSON.parse(JSON.stringify(preview.edit.margins)), { left: 5, top: 2.5, right: 5, bottom: 2.5 });
  assert.deepEqual(JSON.parse(JSON.stringify(preview.edit.imageSize)), { width: 50, height: 25 });

  await env.figma.ui.onmessage({ ...env.settings, left: 5, right: 5, top: 2.5, bottom: 2.5 });
  const saved = JSON.parse(component.data['myfigma.nineSlice.v1']);
  assert.deepEqual(saved.current, { left: 5, top: 2.5, right: 5, bottom: 2.5 });
  assert.deepEqual(saved.imageSize, { width: 50, height: 25 });
  assert.deepEqual([saved.width, saved.height], [200, 100]);
  assert.equal(component.children.find(child => child.name === '切片 2-1').width, 20);
  assert.equal(component.children.find(child => child.name === '切片 1-2').height, 10);
});

test('a failed shared record write aborts the manual upgrade instead of claiming success', async () => {
  const env = setup([[10, 10]], { imageSize: { width: 64, height: 40 } });
  const component = plainComponent();
  component.setSharedPluginData = () => { throw new Error('Simulated shared record failure'); };
  env.figma.currentPage.selection = [component];
  await env.figma.ui.onmessage({ ...env.settings, left: 16, right: 8, top: 4, bottom: 2 });
  assert.equal(component.children.length, 0);
  assert.equal(component.fills.length, 1);
  assert.equal(component.data['myfigma.nineSlice.v1'], undefined);
  assert.ok(env.notices.some(text => /记录/.test(text)));
  assert.equal(env.notices.some(text => /保留/.test(text)), false);
});

test('an unchanged upgrade keeps the existing project override state', async () => {
  const env = setup([[10, 10]], { imageSize: { width: 64, height: 40 } });
  const component = plainComponent();
  setRecord(component, {
    schemaVersion: 1, margins: { left: 8, top: 8, right: 8, bottom: 8 }, overlap: false,
    width: 160, height: 120, imageSize: { width: 64, height: 40 },
    project: { left: 8, top: 8, right: 8, bottom: 8 },
    current: { left: 8, top: 8, right: 8, bottom: 8 }, override: false
  });
  env.figma.currentPage.selection = [component];
  await env.figma.ui.onmessage({ ...env.settings, left: 8, right: 8, top: 8, bottom: 8 });
  const saved = JSON.parse(component.data['myfigma.nineSlice.v1']);
  assert.equal(saved.override, false);
  assert.deepEqual(saved.project, { left: 8, top: 8, right: 8, bottom: 8 });
  assert.deepEqual(saved.current, { left: 8, top: 8, right: 8, bottom: 8 });
  assert.deepEqual(saved.imageSize, { width: 64, height: 40 });
});

test('rejects visible strokes, effects or rounded corners on the root of both plain image structures', async () => {
  const decorations = [
    { name: 'stroke', apply: node => { node.strokes = [{ type: 'SOLID', visible: true }]; } },
    { name: 'effect', apply: node => { node.effects = [{ type: 'DROP_SHADOW', visible: true }]; } },
    { name: 'uniform corner', apply: node => { node.cornerRadius = 4; } },
    { name: 'per-corner radius', apply: node => { node.topLeftRadius = 4; } }
  ];
  const structures = [
    { name: 'root fill', make: () => plainComponent({ marked: false }) },
    { name: 'image child', make: () => childImageComponent({ marked: false }).component }
  ];
  for (const structure of structures) {
    for (const decoration of decorations) {
      const env = setup([[10, 10]], { imageSize: { width: 64, height: 40 } });
      const component = structure.make();
      decoration.apply(component);
      env.figma.currentPage.selection = [component];
      await env.figma.ui.onmessage({ type: 'ui-ready' });
      await new Promise(resolve => setTimeout(resolve, 0));
      const preview = env.messages.filter(message => message.type === 'update-preview').at(-1);
      assert.equal(preview.edit, null, `${structure.name} ${decoration.name} should not offer an upgrade`);
      assert.equal(preview.unsupported, 'extra-content',
        `${structure.name} ${decoration.name} should be rejected as extra visible content`);

      await env.figma.ui.onmessage({ ...env.settings, left: 8 });
      assert.equal(component.children.length, structure.name === 'root fill' ? 0 : 1);
      assert.equal(component.removed, false);
      assert.equal(component.data['myfigma.nineSlice.v1'], undefined);
    }
  }
});

test('a hidden image child is not treated as the covering image', async () => {
  const env = setup([[10, 10]], { imageSize: { width: 64, height: 40 } });
  const { component, child } = childImageComponent({ marked: false });
  child.visible = false;
  env.figma.currentPage.selection = [component];
  await env.figma.ui.onmessage({ type: 'ui-ready' });
  await new Promise(resolve => setTimeout(resolve, 0));
  const preview = env.messages.filter(message => message.type === 'update-preview').at(-1);
  assert.equal(preview.edit, null);
  assert.equal(preview.unsupported, 'component');

  await env.figma.ui.onmessage({ ...env.settings, left: 8 });
  assert.equal(component.children.length, 1);
  assert.equal(component.children[0], child);
  assert.equal(child.removed, false);
  assert.equal(component.fills.length, 0);
  assert.equal(component.data['myfigma.nineSlice.v1'], undefined);
});

test('hidden fills, strokes and effects do not count as visible content', async () => {
  const childEnv = setup([[10, 10]], { imageSize: { width: 64, height: 40 } });
  const withChild = childImageComponent({
    marked: false,
    rootFills: [{ type: 'SOLID', color: { r: 0, g: 0, b: 0 }, visible: false }],
    child: { strokes: [{ type: 'SOLID', visible: false }], effects: [{ type: 'DROP_SHADOW', visible: false }] }
  });
  childEnv.figma.currentPage.selection = [withChild.component];
  await childEnv.figma.ui.onmessage({ ...childEnv.settings, left: 8 });
  assert.equal(withChild.component.children.length, 9);
  assert.equal(withChild.child.removed, true);

  const rootEnv = setup([[10, 10]], { imageSize: { width: 64, height: 40 } });
  const root = plainComponent({ marked: false });
  root.fills = [
    { type: 'IMAGE', imageHash: 'plain-image', scaleMode: 'FILL' },
    { type: 'SOLID', color: { r: 0, g: 0, b: 0 }, visible: false }
  ];
  root.strokes = [{ type: 'SOLID', visible: false }];
  root.effects = [{ type: 'DROP_SHADOW', visible: false }];
  rootEnv.figma.currentPage.selection = [root];
  await rootEnv.figma.ui.onmessage({ ...rootEnv.settings, left: 8 });
  assert.equal(root.children.length, 9);
  assert.equal(root.fills.length, 0);
});

test('accepts sub-pixel coverage differences on a direct image child and still rejects real gaps', async () => {
  const env = setup([[10, 10]], { imageSize: { width: 64, height: 40 } });
  const { component, child } = childImageComponent({
    marked: false,
    child: { x: 0.005, y: -0.005, width: 159.995, height: 120.005 }
  });
  env.figma.currentPage.selection = [component];
  await env.figma.ui.onmessage({ type: 'ui-ready' });
  await new Promise(resolve => setTimeout(resolve, 0));
  const preview = env.messages.filter(message => message.type === 'update-preview').at(-1);
  assert.equal(preview.edit.target, 'upgrade');

  await env.figma.ui.onmessage({ ...env.settings, left: 16, right: 8, top: 4, bottom: 2 });
  assert.equal(component.children.length, 9);
  assert.equal(child.removed, true);

  const gapEnv = setup([[10, 10]], { imageSize: { width: 64, height: 40 } });
  const gap = childImageComponent({ marked: false, child: { width: 159.98 } });
  gapEnv.figma.currentPage.selection = [gap.component];
  await gapEnv.figma.ui.onmessage({ type: 'ui-ready' });
  await new Promise(resolve => setTimeout(resolve, 0));
  const gapPreview = gapEnv.messages.filter(message => message.type === 'update-preview').at(-1);
  assert.equal(gapPreview.unsupported, 'image-child-not-filled');
});

test('a failed child-based upgrade keeps the old image child and writes no partial slices', async () => {
  const env = setup([[10, 10]], { imageSize: { width: 64, height: 40 } });
  const { component, child } = childImageComponent({ marked: false });
  component.appendChild = function () { throw new Error('Simulated append failure'); };
  env.figma.currentPage.selection = [component];
  await env.figma.ui.onmessage({ ...env.settings, left: 16, right: 8, top: 4, bottom: 2 });
  assert.equal(component.children.length, 1);
  assert.equal(component.children[0], child);
  assert.equal(child.removed, false);
  assert.equal(component.fills.length, 0);
  assert.deepEqual([component.width, component.height], [160, 120]);
  assert.equal(component.layoutMode, 'NONE');
  assert.ok(!component.data['myfigma.nineSlice.v1']);
  assert.ok(env.notices.some(text => text.includes('升级失败')));
});

test('a successful upgrade refreshes the selection preview into the editable 9-slice state', async () => {
  const structures = [
    { name: 'root fill', make: () => plainComponent({ marked: false }) },
    { name: 'image child', make: () => childImageComponent({ marked: false }).component }
  ];
  for (const structure of structures) {
    const env = setup([[10, 10]], { imageSize: { width: 64, height: 40 } });
    const component = structure.make();
    env.figma.currentPage.selection = [component];
    await env.figma.ui.onmessage({ type: 'ui-ready' });
    await new Promise(resolve => setTimeout(resolve, 0));
    // Only the refresh caused by the upgrade itself counts; an extra
    // selectionchange-style duplicate would surface below as a second message.
    env.messages.length = 0;
    await env.figma.ui.onmessage({ ...env.settings, left: 16, right: 8, top: 4, bottom: 2 });
    await new Promise(resolve => setTimeout(resolve, 0));
    const previews = env.messages.filter(message => message.type === 'update-preview');
    assert.equal(previews.length, 1, `${structure.name} should refresh exactly once`);
    const preview = previews[0];
    assert.equal(preview.edit.target, 'component', `${structure.name} should switch to the edit entry`);
    assert.equal(preview.edit.editable, true);
    assert.equal(preview.edit.name, component.name);
    assert.deepEqual(JSON.parse(JSON.stringify(preview.edit.margins)),
      { left: 16, right: 8, top: 4, bottom: 2 });
    assert.deepEqual(JSON.parse(JSON.stringify(preview.edit.imageSize)), { width: 64, height: 40 });
    assert.equal(preview.edit.override, true);
    assert.equal(preview.edit.project, undefined);
    assert.equal(preview.unsupported, null);
    // Editing coordinates stay in original image pixels even though the upgraded
    // component keeps its larger canvas.
    assert.equal(preview.width, 64);
    assert.equal(preview.height, 40);
  }
});

test('a failed upgrade never refreshes the UI into the upgraded edit state', async () => {
  const failures = [
    { name: 'shared record write', break: component => {
      component.setSharedPluginData = () => { throw new Error('Simulated shared record failure'); };
    } },
    { name: 'structural append', break: component => {
      component.appendChild = function () { throw new Error('Simulated append failure'); };
    } }
  ];
  for (const failure of failures) {
    const env = setup([[10, 10]], { imageSize: { width: 64, height: 40 } });
    const component = plainComponent({ marked: false });
    failure.break(component);
    env.figma.currentPage.selection = [component];
    env.messages.length = 0;
    await env.figma.ui.onmessage({ ...env.settings, left: 16, right: 8, top: 4, bottom: 2 });
    await new Promise(resolve => setTimeout(resolve, 0));
    // A failed upgrade must not present itself as a finished 9-slice.
    assert.equal(env.messages.filter(message => message.type === 'update-preview' &&
      message.edit?.target === 'component').length, 0, `${failure.name} must not refresh as success`);
    assert.ok(env.notices.some(text => /升级失败|记录/.test(text)), `${failure.name} should report a failure`);
  }
});

test('a failed child removal restores the old image child before reporting the upgrade failure', async () => {
  const env = setup([[10, 10]], { imageSize: { width: 64, height: 40 } });
  const { component, child } = childImageComponent({ marked: false });
  const remove = child.remove;
  child.remove = function () {
    remove.call(this);
    throw new Error('Simulated remove failure');
  };
  env.figma.currentPage.selection = [component];
  await env.figma.ui.onmessage({ ...env.settings, left: 16, right: 8, top: 4, bottom: 2 });
  assert.equal(component.children.length, 1);
  assert.equal(component.children[0], child);
  assert.equal(component.children.includes(child), true);
  assert.equal(component.fills.length, 0);
  assert.deepEqual([component.width, component.height], [160, 120]);
  assert.equal(component.layoutMode, 'NONE');
  assert.ok(!component.data['myfigma.nineSlice.v1']);
  assert.ok(env.notices.some(text => text.includes('升级失败')));
});

test('code and UI rejection reason sets stay in sync', () => {
  const code = fs.readFileSync('code.ts', 'utf8');
  const reasonsMatch = code.match(/const UPGRADE_REJECTIONS = \[([\s\S]*?)\] as const;/);
  assert.ok(reasonsMatch, 'UPGRADE_REJECTIONS must be a single source list in code.ts');
  const codeReasons = [...reasonsMatch[1].matchAll(/'([^']+)'/g)].map(match => match[1]).sort();
  const ui = fs.readFileSync('ui.html', 'utf8');
  const mappingMatch = ui.match(/function unsupportedText\(state\) \{[\s\S]*?var keys = \{([\s\S]*?)\n      \};/);
  assert.ok(mappingMatch, 'unsupportedText must map every rejection reason');
  const uiReasons = [...mappingMatch[1].matchAll(/'([^']+)':/g)].map(match => match[1]).sort();
  assert.deepEqual(uiReasons, codeReasons);
});

function compactRequest(env, overrides = {}) {
  return {
    type: 'generate-compact-image', bytes: new Uint8Array([9, 8, 7]), width: 21, height: 21,
    margins: { left: 10, top: 10, right: 10, bottom: 10 },
    sourceId: env.sources[0].id, lang: 'zh', ...overrides
  };
}

test('a plain image layer previews its real size so only pixel sampling rounds it', async () => {
  const env = setup([[100.4, 80.5]]);
  await env.figma.ui.onmessage({ type: 'ui-ready' });
  await new Promise(resolve => setTimeout(resolve, 0));
  const preview = env.messages.filter(message => message.type === 'update-preview').at(-1);
  // The panel keeps the layer's real geometry; rounding belongs to the compact
  // raster, not to a general preview of an ordinary image layer.
  assert.equal(preview.width, 100.4);
  assert.equal(preview.height, 80.5);
  assert.deepEqual(JSON.parse(JSON.stringify(preview.plainImage)), {
    id: 'source-0', name: 'Test', width: 100.4, height: 80.5, scaleMode: 'FILL'
  });
});

test('compact actions require integer pixel margins so the raster, slices and record cannot drift', async () => {
  for (const margins of [
    { left: 10.5, top: 10, right: 10, bottom: 10 },
    { left: 10, top: 10.4, right: 10, bottom: 10 }
  ]) {
    const env = setup();
    await env.figma.ui.onmessage(compactRequest(env, { margins }));
    assert.equal(env.images.length, 0, JSON.stringify(margins));
    assert.equal(env.rectangles.length, 0);
    assert.equal(env.created.length, 0);
    assert.equal(env.sources[0].removed, undefined);
    assert.ok(env.notices.some(text => /整数/.test(text)), JSON.stringify(margins));
  }
});

test('compact components ignore the seam overlap and keep whole-pixel slice geometry', async () => {
  const env = setup();
  await env.figma.ui.onmessage(compactRequest(env, { type: 'generate-compact-component', overlap: true }));
  const component = env.created[0];
  assert.ok(component.children.every(child =>
    Number.isInteger(child.x) && Number.isInteger(child.y) &&
    Number.isInteger(child.width) && Number.isInteger(child.height)));
  assert.deepEqual(component.children.map(child => [child.x, child.y]), [
    [0, 0], [10, 0], [11, 0],
    [0, 10], [10, 10], [11, 10],
    [0, 11], [10, 11], [11, 11]
  ]);
  const saved = JSON.parse(component.data['myfigma.nineSlice.v1']);
  assert.equal(saved.overlap, false);
  assert.deepEqual(saved.current, { left: 10, top: 10, right: 10, bottom: 10 });
  assert.deepEqual(saved.margins, { left: 10, top: 10, right: 10, bottom: 10 });
});

test('compact image action creates a new plain image layer beside the untouched source', async () => {
  const env = setup();
  const source = env.sources[0];
  await env.figma.ui.onmessage(compactRequest(env));

  assert.equal(env.created.length, 0, 'the image action must not create a component');
  assert.equal(env.rectangles.length, 1);
  const layer = env.rectangles[0];
  assert.equal(layer.name, source.name);
  assert.equal(layer.parent, source.parent);
  assert.deepEqual([layer.width, layer.height], [21, 21]);
  assert.equal(layer.x, source.x + source.width + 50);
  assert.equal(layer.y, source.y);
  assert.equal(layer.fills[0].type, 'IMAGE');
  assert.equal(layer.fills[0].imageHash, 'created-image-1');
  assert.deepEqual([...env.images[0]], [9, 8, 7]);
  assert.equal(source.removed, undefined, 'the source layer must never be deleted');
  assert.deepEqual([source.width, source.height], [100, 80]);
  assert.equal(env.figma.currentPage.selection.length, 1);
  assert.equal(env.figma.currentPage.selection[0], layer);
  assert.ok(env.notices.some(text => text.includes('已生成九宫格图片')));
});

test('compact component action keeps the source and records the compact canvas and original margins', async () => {
  const env = setup();
  const source = env.sources[0];
  await env.figma.ui.onmessage(compactRequest(env, { type: 'generate-compact-component', keepOriginal: false }));

  assert.equal(env.created.length, 1);
  const component = env.created[0];
  assert.equal(component.name, source.name);
  assert.equal(component.parent, source.parent);
  assert.deepEqual([component.width, component.height], [21, 21]);
  assert.equal(component.x, source.x + source.width + 50);
  assert.equal(component.y, source.y);
  assert.equal(component.children.length, 9);
  assert.equal(component.children.find(child => child.name === '切片 2-1').width, 10);
  assert.equal(component.children.find(child => child.name === '切片 1-2').height, 10);
  assert.equal(component.children.find(child => child.name === '切片 1-2').constraints.horizontal, 'STRETCH');
  assert.equal(component.children.find(child => child.name === '切片 2-1').constraints.vertical, 'STRETCH');

  const saved = JSON.parse(component.data['myfigma.nineSlice.v1']);
  assert.deepEqual(saved.current, { left: 10, top: 10, right: 10, bottom: 10 });
  assert.deepEqual(saved.margins, { left: 10, top: 10, right: 10, bottom: 10 });
  assert.deepEqual(saved.imageSize, { width: 21, height: 21 });
  assert.deepEqual([saved.width, saved.height], [21, 21]);
  assert.equal(saved.override, true);
  assert.equal(component.shared['myfigma/nineSlice.v1'], component.data['myfigma.nineSlice.v1']);
  assert.equal(source.removed, undefined, 'generating the component must keep the source layer');
  assert.equal(env.figma.currentPage.selection.length, 1);
  assert.equal(env.figma.currentPage.selection[0], component);
  assert.ok(env.notices.some(text => text.includes('已生成九宫格组件')));
});

test('compact actions reject invalid margins, stale ids and missing bytes without creating anything', async () => {
  for (const request of [
    { margins: { left: 20, top: 10, right: 20, bottom: 10 } },
    { margins: { left: -1, top: 10, right: 10, bottom: 10 } },
    { width: 0 }, { width: NaN }, { height: Infinity },
    { sourceId: 'another-layer' }, { bytes: null }, { bytes: new Uint8Array() }
  ]) {
    const env = setup();
    await env.figma.ui.onmessage(compactRequest(env, request));
    assert.equal(env.images.length, 0, `createImage must not run for ${JSON.stringify(request)}`);
    assert.equal(env.rectangles.length, 0);
    assert.equal(env.created.length, 0);
    assert.equal(env.sources[0].removed, undefined);
    assert.ok(env.notices.some(text => /边距|变化|图片|无法/.test(text)), JSON.stringify(request));
  }
});

test('compact actions reject non-image layers, existing 9-slice components and plain image components', async () => {
  const nonImage = setup();
  const frame = { id: 'frame-1', type: 'FRAME', name: 'Frame', width: 100, height: 80, children: [], fills: [] };
  nonImage.figma.currentPage.selection = [frame];
  await nonImage.figma.ui.onmessage(compactRequest(nonImage, { sourceId: 'frame-1' }));
  assert.equal(nonImage.rectangles.length, 0);
  assert.equal(nonImage.created.length, 0);
  assert.ok(nonImage.notices.some(text => /图片|无法/.test(text)));

  const slice = setup();
  await slice.figma.ui.onmessage(slice.settings);
  const component = slice.created[0];
  slice.figma.currentPage.selection = [component];
  await slice.figma.ui.onmessage(compactRequest(slice, { sourceId: component.id }));
  assert.equal(slice.created.length, 1);
  assert.equal(slice.rectangles.length, 9, 'only the existing slices exist');
  assert.equal(component.children.length, 9);
  assert.ok(slice.notices.some(text => /普通图片图层|未做修改/.test(text)));

  const plain = setup();
  const plainImageComponent = plainComponent({ marked: false });
  plain.figma.currentPage.selection = [plainImageComponent];
  await plain.figma.ui.onmessage(compactRequest(plain, { sourceId: plainImageComponent.id }));
  assert.equal(plain.created.length, 0);
  assert.equal(plain.rectangles.length, 0);
  assert.equal(plainImageComponent.children.length, 0);
  assert.equal(plainImageComponent.fills.length, 1);
  assert.ok(plain.notices.some(text => /普通图片图层|未做修改/.test(text)));
});

test('a failed compact image write removes its partial node and reports the failure', async () => {
  for (const type of ['generate-compact-image', 'generate-compact-component']) {
    const env = setup();
    env.figma.createImage = () => { throw new Error('Simulated image failure'); };
    await env.figma.ui.onmessage(compactRequest(env, { type }));
    assert.equal(env.rectangles.length, 0);
    assert.equal(env.created.length, 0);
    assert.equal(env.sources[0].removed, undefined);
    assert.ok(env.notices.some(text => /失败|无法/.test(text)), type);
  }
});

test('a failed compact component record write removes the partial component and keeps the source', async () => {
  const env = setup();
  const createComponent = env.figma.createComponent;
  env.figma.createComponent = () => {
    const component = createComponent();
    component.setSharedPluginData = () => { throw new Error('Simulated record failure'); };
    return component;
  };
  await env.figma.ui.onmessage(compactRequest(env, { type: 'generate-compact-component' }));
  assert.equal(env.created.length, 1);
  assert.equal(env.created[0].removed, true);
  assert.equal(env.sources[0].removed, undefined);
  assert.ok(env.notices.some(text => /失败|记录/.test(text)));
});
