import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { access, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { PNG } from 'pngjs';
import { startHelper } from './fixture.mjs';
import { projectFixture, writePng, solid, writeAtlas, register, scan, decode } from './atlas-fixture.mjs';

test('game root registration recursively scans nested imageset atlases and keeps same-named frames distinct', async () => {
  const f = await projectFixture();
  try {
    const imageset = join(f.project, 'res', 'imageset');
    await writePng(join(imageset, 'Static', 'buttons.png'), 2, 1, [...[255, 0, 0, 255], ...[0, 255, 0, 255]]);
    await writeAtlas(join(imageset, 'Static', 'buttons.json'), {
      image: 'buttons.png', size: { w: 2, h: 1 },
      frames: { dup: { frame: { x: 0, y: 0, w: 1, h: 1 } } }
    });
    await writePng(join(imageset, 'Dynamic', 'buttons.png'), 2, 1, [...[0, 0, 255, 255], ...[0, 255, 0, 255]]);
    await writeAtlas(join(imageset, 'Dynamic', 'buttons.json'), {
      image: 'buttons.png', size: { w: 2, h: 1 },
      frames: { dup: { frame: { x: 0, y: 0, w: 1, h: 1 } } }
    });
    await register(f);
    const result = await scan(f);
    assert.equal(result.schemaVersion, 2);
    assert.equal(result.summary.scanRoot, 'res/imageset');
    assert.equal(result.summary.atlases, 2);
    assert.equal(result.complete, true);
    assert.deepEqual(result.resources.map(r => r.source.relativePath).sort(),
      ['Dynamic/buttons.json', 'Static/buttons.json']);
    assert.deepEqual(result.resources.map(r => r.source.identity).sort(), [
      '["g1008","atlas","Dynamic/buttons.json","dup"]',
      '["g1008","atlas","Static/buttons.json","dup"]'
    ]);
    const dynamic = result.resources.find(r => r.source.relativePath === 'Dynamic/buttons.json');
    const fixed = result.resources.find(r => r.source.relativePath === 'Static/buttons.json');
    assert.deepEqual(decode(dynamic.png).data, [0, 0, 255, 255]);
    assert.deepEqual(decode(fixed.png).data, [255, 0, 0, 255]);
    assert.equal(result.resources.every(r => r.source.engineReference.startsWith('set:')), true);
  } finally { await f.cleanup(); }
});

test('direct imageset registration keeps working and scans its own subdirectories', async () => {
  const f = await projectFixture();
  try {
    const imageset = join(f.project, 'res', 'imageset');
    await writePng(join(imageset, 'icon.png'), 1, 1, solid(1, 1, [1, 2, 3, 255]));
    await writeAtlas(join(imageset, 'icon.json'), {
      image: 'icon.png', size: { w: 1, h: 1 },
      frames: { only: { frame: { x: 0, y: 0, w: 1, h: 1 } } }
    });
    await f.request('/v1/projects', 'PUT', { id: 'g2', name: '直接目录', path: imageset, maintained: true });
    const result = await scan(f, 'g2');
    assert.equal(result.summary.scanRoot, '.');
    assert.deepEqual(result.resources.map(r => r.source.relativePath), ['icon.json']);
    assert.equal(result.complete, true);
  } finally { await f.cleanup(); }
});

test('plain project directory without an imageset folder is still scanned directly', async () => {
  const f = await projectFixture();
  try {
    await writePng(join(f.project, 'tiny.png'), 1, 1, solid(1, 1, [9, 9, 9, 255]));
    await writeAtlas(join(f.project, 'tiny.json'), {
      image: 'tiny.png', size: { w: 1, h: 1 },
      frames: { dot: { frame: { x: 0, y: 0, w: 1, h: 1 } } }
    });
    await register(f);
    const result = await scan(f);
    assert.deepEqual(result.resources.map(r => r.source.identity), ['["g1008","atlas","tiny.json","dot"]']);
  } finally { await f.cleanup(); }
});

test('unreferenced images become standalone resources while atlas sheets are never re-imported as standalone', async () => {
  const f = await projectFixture();
  try {
    const imageset = join(f.project, 'res', 'imageset');
    // Sheet stored outside the atlas directory, named by meta.image.
    await writePng(join(imageset, 'Static', 'sheet', 'panel.png'), 2, 1, [...[10, 20, 30, 255], ...[40, 50, 60, 255]]);
    await writeAtlas(join(imageset, 'Static', 'panel.json'), {
      image: 'sheet/panel.png', size: { w: 2, h: 1 },
      frames: { panel: { frame: { x: 1, y: 0, w: 1, h: 1 } } }
    });
    // Default-convention sheet: same stem as its atlas JSON.
    await writePng(join(imageset, 'Static', 'buttons.png'), 1, 1, solid(1, 1, [7, 7, 7, 255]));
    await writeAtlas(join(imageset, 'Static', 'buttons.json'), {
      image: 'buttons.png', size: { w: 1, h: 1 },
      frames: { button: { frame: { x: 0, y: 0, w: 1, h: 1 } } }
    });
    const headshot = [...[1, 2, 3, 255], ...[4, 5, 6, 128], ...[7, 8, 9, 0], ...[10, 11, 12, 255]];
    await writePng(join(imageset, 'Static', 'default_headshot.png'), 2, 2, headshot);
    await register(f);
    const result = await scan(f);
    assert.equal(result.complete, true);
    assert.equal(result.summary.atlases, 2);
    assert.equal(result.summary.sprites, 2);
    assert.equal(result.summary.standalone, 1);
    assert.deepEqual(result.resources.map(r => r.source.kind).sort(), ['atlas', 'atlas', 'standalone']);
    const standalone = result.resources.find(r => r.source.kind === 'standalone');
    assert.deepEqual(Object.keys(standalone.source).sort(), [
      'crop', 'engineReference', 'frameName', 'identity', 'kind', 'offset', 'projectId',
      'relativePath', 'schemaVersion', 'sourceSize'
    ]);
    assert.equal(standalone.source.relativePath, 'Static/default_headshot.png');
    assert.equal(standalone.source.frameName, 'default_headshot');
    assert.equal(standalone.source.identity, '["g1008","standalone","Static/default_headshot.png"]');
    assert.equal(standalone.source.engineReference, 'image:Static/default_headshot.png');
    assert.deepEqual(standalone.source.crop, { x: 0, y: 0, w: 2, h: 2 });
    assert.deepEqual(standalone.source.offset, { x: 0, y: 0 });
    assert.deepEqual([standalone.width, standalone.height], [2, 2]);
    assert.deepEqual(decode(standalone.png).data, headshot);
    assert.deepEqual(result.resources.filter(r => r.source.kind === 'atlas')
      .map(r => r.source.relativePath).sort(), ['Static/buttons.json', 'Static/panel.json']);
    assert.equal((await scan(f)).resources.find(r => r.source.kind === 'standalone').source.identity,
      standalone.source.identity);
  } finally { await f.cleanup(); }
});

test('trimmed frames in nested atlases restore original size, transparent padding and offset pixels', async () => {
  const f = await projectFixture();
  try {
    const imageset = join(f.project, 'res', 'imageset');
    const sheet = [
      ...[10, 20, 30, 255], ...[40, 50, 60, 255], ...[70, 80, 90, 255],
      ...[1, 2, 3, 4], ...[5, 6, 7, 8], ...[9, 10, 11, 12]
    ];
    await writePng(join(imageset, 'Static', 'ui.png'), 3, 2, sheet);
    await writeAtlas(join(imageset, 'Static', 'ui.json'), {
      image: 'ui.png', size: { w: 3, h: 2 },
      frames: {
        dialogue: {
          frame: { x: 1, y: 0, w: 2, h: 1 }, sourceSize: { w: 4, h: 3 },
          offset: { x: 1, y: 2 }, trimmed: true, rotated: false
        },
        plain: { frame: { x: 0, y: 1, w: 1, h: 1 } }
      }
    });
    await register(f);
    const result = await scan(f);
    assert.equal(result.complete, true);
    const dialogue = result.resources.find(r => r.source.frameName === 'dialogue');
    const plain = result.resources.find(r => r.source.frameName === 'plain');
    const transparent = [0, 0, 0, 0];
    assert.equal(dialogue.source.relativePath, 'Static/ui.json');
    assert.deepEqual([dialogue.width, dialogue.height], [4, 3]);
    assert.deepEqual(dialogue.source.crop, { x: 1, y: 0, w: 2, h: 1 });
    assert.deepEqual(dialogue.source.offset, { x: 1, y: 2 });
    assert.deepEqual(dialogue.source.sourceSize, { w: 4, h: 3 });
    // Independent expectation: two opaque pixels inside a transparent 4x3 frame.
    assert.deepEqual(decode(dialogue.png).data, [
      ...transparent, ...transparent, ...transparent, ...transparent,
      ...transparent, ...transparent, ...transparent, ...transparent,
      ...transparent, ...[40, 50, 60, 255], ...[70, 80, 90, 255], ...transparent
    ]);
    assert.deepEqual([plain.width, plain.height], [1, 1]);
    assert.deepEqual(plain.source.offset, { x: 0, y: 0 });
    assert.deepEqual(decode(plain.png).data, [1, 2, 3, 4]);
  } finally { await f.cleanup(); }
});

test('broken, missing and unsupported sources are reported with their location and skipped', async () => {
  const f = await projectFixture();
  try {
    const imageset = join(f.project, 'res', 'imageset', 'Static');
    await writePng(join(imageset, 'broken.png'), 1, 1, solid(1, 1, [5, 5, 5, 255]));
    await writeFile(join(imageset, 'broken.json'), '{"frames": ');
    await writeAtlas(join(imageset, 'missing.json'), {
      image: 'missing.png', size: { w: 1, h: 1 },
      frames: { gone: { frame: { x: 0, y: 0, w: 1, h: 1 } } }
    });
    await writePng(join(imageset, 'rotated.png'), 2, 1, [...[1, 1, 1, 255], ...[2, 2, 2, 255]]);
    await writeAtlas(join(imageset, 'rotated.json'), {
      image: 'rotated.png', size: { w: 2, h: 1 },
      frames: {
        spin: { frame: { x: 0, y: 0, w: 1, h: 1 }, rotated: true },
        still: { frame: { x: 1, y: 0, w: 1, h: 1 } }
      }
    });
    await writePng(join(imageset, 'bounds.png'), 2, 1, [...[3, 3, 3, 255], ...[4, 4, 4, 255]]);
    await writeAtlas(join(imageset, 'bounds.json'), {
      image: 'bounds.png', size: { w: 2, h: 1 },
      frames: { outside: { frame: { x: 1, y: 0, w: 5, h: 1 } } }
    });
    await register(f);
    const result = await scan(f);
    assert.equal(result.complete, false);
    assert.equal(result.truncated, false);
    assert.equal(result.summary.atlases, 4);
    assert.deepEqual(result.resources.map(r => `${r.source.relativePath}#${r.source.frameName}`), [
      'Static/rotated.json#still'
    ]);
    assert.equal(result.errors.length, 4);
    assert.match(result.errors.join('\n'), /Static\/broken\.json/);
    assert.match(result.errors.join('\n'), /Static\/missing\.json/);
    assert.match(result.errors.join('\n'), /Static\/rotated\.json 帧 spin：不支持旋转帧/);
    assert.match(result.errors.join('\n'), /Static\/bounds\.json 帧 outside：帧越界/);
    // A sheet whose JSON failed to parse is still a packed sheet, not a standalone asset.
    assert.deepEqual(result.resources.filter(r => r.source.kind === 'standalone'), []);
    assert.equal(JSON.stringify(result).includes(JSON.stringify(f.project).slice(1, -1)), false);
  } finally { await f.cleanup(); }
});

test('atlases with more than the old frame counts are imported whole and over-limit scans report truncation', async () => {
  const f = await projectFixture();
  try {
    const imageset = join(f.project, 'res', 'imageset', 'Static');
    await writePng(join(imageset, 'many.png'), 1, 1, solid(1, 1, [8, 8, 8, 255]));
    const frames = {};
    for (let index = 0; index < 70; index++) frames[`f${index}`] = { frame: { x: 0, y: 0, w: 1, h: 1 } };
    await writeAtlas(join(imageset, 'many.json'), { image: 'many.png', size: { w: 1, h: 1 }, frames });
    await register(f);
    const whole = await scan(f);
    assert.equal(whole.complete, true);
    assert.equal(whole.resources.length, 70);
    assert.equal(whole.summary.atlasFrames, 70);
    assert.equal(whole.summary.sprites, 70);

    const huge = await projectFixture();
    try {
      const hugeSet = join(huge.project, 'res', 'imageset');
      await writePng(join(hugeSet, 'huge.png'), 1, 1, solid(1, 1, [9, 9, 9, 255]));
      const many = {};
      for (let index = 0; index < 20001; index++) many[`f${index}`] = { frame: { x: 0, y: 0, w: 1, h: 1 } };
      await writeAtlas(join(hugeSet, 'huge.json'), { image: 'huge.png', size: { w: 1, h: 1 }, frames: many });
      await register(huge);
      const limited = await scan(huge);
      assert.equal(limited.complete, false);
      assert.equal(limited.truncated, true);
      assert.match(limited.errors.join('\n'), /超过单次扫描上限/);
      assert.equal(limited.summary.resources, limited.resources.length);
      assert.ok(limited.resources.length >= 10000, 'scan keeps what it restored instead of silently clipping');
    } finally { await huge.cleanup(); }
  } finally { await f.cleanup(); }
});

test('the helper keeps the full scan record on its own disk without local absolute paths', async () => {
  const f = await projectFixture();
  let restarted;
  try {
    const imageset = join(f.project, 'res', 'imageset');
    await writePng(join(imageset, 'Static', 'panel.png'), 1, 1, solid(1, 1, [6, 6, 6, 255]));
    await writeAtlas(join(imageset, 'Static', 'panel.json'), {
      image: 'panel.png', size: { w: 1, h: 1 },
      frames: { panel: { frame: { x: 0, y: 0, w: 1, h: 1 } } }
    });
    await writePng(join(imageset, 'Static', 'loose.png'), 1, 1, solid(1, 1, [7, 7, 7, 255]));
    await register(f);
    const result = await scan(f);
    const cachePath = join(f.data, 'scans', 'g1008.json');
    const cached = JSON.parse(await readFile(cachePath, 'utf8'));
    assert.equal(cached.schemaVersion, 2);
    assert.equal(cached.project.name, '起床战争');
    assert.deepEqual(cached.resources.map(r => r.source.identity), result.resources.map(r => r.source.identity));
    assert.deepEqual(cached.summary, result.summary);
    const raw = await readFile(cachePath, 'utf8');
    assert.equal(raw.includes(JSON.stringify(f.project).slice(1, -1)), false);
    assert.equal(raw.includes(JSON.stringify(f.data).slice(1, -1)), false);
    await f.stop();
    restarted = await startHelper(f.data);
    assert.deepEqual(JSON.parse(await readFile(cachePath, 'utf8')), cached);
    const rescanned = await (await restarted.request('/v1/scan', 'POST', { projectId: 'g1008' })).json();
    assert.deepEqual(rescanned.resources.map(r => r.source.identity), result.resources.map(r => r.source.identity));
  } finally { if (restarted) await restarted.stop(); await f.cleanup(); }
});

test('the real sample subset scans recursively with its standalone image and exact atlas pixels', async (t) => {
  const sample = fileURLToPath(new URL('../../../../交付/图集插件_跨机测试资源/samples/Media/Scripts/Game/g1008', import.meta.url));
  try { await access(sample); } catch { return t.skip('本机未解压跨机测试资源样本包'); }
  const f = await projectFixture();
  try {
    await f.request('/v1/projects', 'PUT', { id: 'g1008', name: '起床战争', path: sample, maintained: true });
    const result = await scan(f);
    assert.equal(result.complete, true);
    assert.equal(result.truncated, false);
    assert.deepEqual(result.errors, []);
    assert.equal(result.summary.scanRoot, 'res/imageset');
    assert.equal(result.summary.atlases, 9);
    assert.equal(result.summary.atlasFrames, 263);
    assert.equal(result.summary.sprites, 263);
    assert.equal(result.summary.standalone, 1);
    assert.equal(result.resources.length, 264);
    const relativePaths = new Set(result.resources.map(r => r.source.relativePath));
    assert.equal(relativePaths.has('Dynamic/bed_war_survey.json'), true);
    assert.equal(relativePaths.has('Static/app_month_card.json'), true);
    const standalone = result.resources.find(r => r.source.kind === 'standalone');
    assert.equal(standalone.source.identity, '["g1008","standalone","Static/default_headshot.png"]');
    assert.equal(standalone.source.frameName, 'default_headshot');
    assert.deepEqual([standalone.width, standalone.height], [128, 128]);
    // Independent expectation: restore by cropping the shipped atlas sheet itself.
    const sheet = PNG.sync.read(await readFile(sample + '/res/imageset/Dynamic/bed_war_custom_shop.png'));
    const cube = result.resources.find(r => r.source.relativePath === 'Dynamic/bed_war_custom_shop.json' && r.source.frameName === 'cube');
    assert.deepEqual(cube.source.crop, { x: 66, y: 1, w: 39, h: 42 });
    assert.deepEqual(decode(cube.png).data, crop(sheet, cube.source.crop));
    assert.equal(JSON.stringify(result).includes(sample.replaceAll(String.fromCharCode(92), '/')), false);
  } finally { await f.cleanup(); }
});

function crop(image, { x, y, w, h }) {
  const pixels = [];
  for (let dy = 0; dy < h; dy++) {
    for (let dx = 0; dx < w; dx++) {
      const offset = ((y + dy) * image.width + (x + dx)) * 4;
      pixels.push(...image.data.subarray(offset, offset + 4));
    }
  }
  return pixels;
}
