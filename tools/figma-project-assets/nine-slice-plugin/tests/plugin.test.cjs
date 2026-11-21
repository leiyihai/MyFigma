const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');

function setup(sizes = [[100, 80]], options = {}) {
  const created = [], notices = [], messages = [], saved = [], events = {};
  const parent = { appendChild(node) { node.parent = this; } };
  const sources = sizes.map(([width, height]) => ({
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
    getImageByHash(hash) { return { getBytesAsync: options.getBytes || (async () => new Uint8Array([1])) }; },
    notify(text) { notices.push(text); }, viewport: { scrollAndZoomIntoView() {} },
    createComponent() { const result = node('COMPONENT'); created.push(result); return result; },
    createRectangle: node
  };
  vm.runInNewContext(fs.readFileSync('dist/code.js', 'utf8'), { figma, __html__: '', console });
  const settings = {
    type: 'generate', left: 10, right: 10, top: 10, bottom: 10, all: 10,
    overlap: false, keepOriginal: true, batchMode: false, lang: 'zh'
  };
  return { figma, created, sources, notices, messages, settings, saved, events };
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
  assert.deepEqual(saved.margins, { left: 20, right: 5, top: 6, bottom: 7 });
  assert.equal(component.children.find(child => child.name === '切片 2-1').width, 20);
});

test('editing a legacy overlap component preserves overlap and derives margins', async () => {
  const env = setup();
  const settings = { ...env.settings, overlap: true };
  await env.figma.ui.onmessage(settings);
  const component = env.created[0];
  component.data = {};
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
  component.setPluginData('myfigma.nineSlice.v1', JSON.stringify({
    schemaVersion: 1, margins: { left: 10, top: 10, right: 10, bottom: 10 }, overlap: false,
    width: 100, height: 80, project: { left: 8, top: 8, right: 8, bottom: 8 },
    current: { left: 10, top: 10, right: 10, bottom: 10 }, override: false
  }));
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
}
function atlasRecord(override = false) {
  return {
    schemaVersion: 1, margins: { left: 10, top: 10, right: 10, bottom: 10 }, overlap: false,
    width: 100, height: 80, project: { left: 8, top: 8, right: 8, bottom: 8 },
    current: { left: 10, top: 10, right: 10, bottom: 10 }, override
  };
}

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
