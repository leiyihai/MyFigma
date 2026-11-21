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
  function node() {
    return {
      children: [], removed: false,
      resize(width, height) { this.width = width; this.height = height; },
      appendChild(child) { child.parent = this; this.children.push(child); },
      remove() { this.removed = true; }
    };
  }
  const figma = {
    showUI() {}, on(name, handler) { events[name] = handler; },
    ui: { postMessage(msg) { messages.push(msg); } },
    clientStorage: { async getAsync() { return options.saved; }, async setAsync(key, value) { saved.push({ key, value }); } },
    currentPage: { selection: sources },
    getImageByHash(hash) { return { getBytesAsync: options.getBytes || (async () => new Uint8Array([1])) }; },
    notify(text) { notices.push(text); }, viewport: { scrollAndZoomIntoView() {} },
    createComponent() { const result = node(); created.push(result); return result; },
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
