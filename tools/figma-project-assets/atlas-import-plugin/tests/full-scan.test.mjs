import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { projectFixture, writePng, solid, writeAtlas } from '../../local-helper/tests/atlas-fixture.mjs';
import { figmaFixture } from './platform-fixture.mjs';
import * as api from '../dist/api.mjs';

const headshot = [...[1, 2, 3, 255], ...[4, 5, 6, 128], ...[7, 8, 9, 0], ...[10, 11, 12, 255]];

async function nestedProject(f) {
  const imageset = join(f.project, 'res', 'imageset');
  await writePng(join(imageset, 'Static', 'buttons.png'), 2, 1, [...[255, 0, 0, 255], ...[0, 255, 0, 255]]);
  await writeAtlas(join(imageset, 'Static', 'buttons.json'), {
    image: 'buttons.png', size: { w: 2, h: 1 },
    frames: { dup: { frame: { x: 0, y: 0, w: 1, h: 1 } } }
  });
  await writePng(join(imageset, 'Dynamic', 'buttons.png'), 1, 1, solid(1, 1, [0, 0, 255, 255]));
  await writeAtlas(join(imageset, 'Dynamic', 'buttons.json'), {
    image: 'buttons.png', size: { w: 1, h: 1 },
    frames: { dup: { frame: { x: 0, y: 0, w: 1, h: 1 } } }
  });
  await writePng(join(imageset, 'Static', 'default_headshot.png'), 2, 2, headshot);
}

test('task entry imports nested atlas sprites and standalone images with whitelisted sources', async () => {
  const f = await projectFixture();
  try {
    await nestedProject(f);
    const { api: figma, page, images } = figmaFixture();
    const workflow = new api.Workflow(new api.HelperClient(f.base, f.token), api.createFigmaPlatform(figma));
    await workflow.connect();
    await workflow.saveProject({ id: 'g1008', name: '起床战争', path: f.project, maintained: true });
    await workflow.selectProject('g1008');
    await workflow.scan();
    assert.equal(workflow.state.scan.schemaVersion, 3);
    assert.equal(workflow.state.scan.summary.scanRoot, 'res/imageset');
    assert.equal(workflow.state.scan.summary.sprites, 2);
    assert.equal(workflow.state.scan.summary.standalone, 1);
    assert.equal(workflow.state.scan.complete, true);
    await workflow.import();
    assert.equal(images.length, 3);
    assert.equal(workflow.state.progress.done, 3);
    const group = page.children.find(node => node.name === '未分类');
    const components = group.children;
    assert.deepEqual(components.map(node => node.name).sort(), [
      '未分类/default_headshot · Static/default_headshot.png',
      '未分类/dup · Dynamic/buttons.json',
      '未分类/dup · Static/buttons.json'
    ]);
    const sources = components.map(node => JSON.parse(node.data['atlas.source']));
    const duplicated = sources.filter(source => source.frameName === 'dup');
    assert.deepEqual(duplicated.map(source => source.identity).sort(), [
      '["g1008","atlas","Dynamic/buttons.json","dup"]',
      '["g1008","atlas","Static/buttons.json","dup"]'
    ]);
    assert.deepEqual(duplicated.map(source => source.engineReference).sort(), [
      'set:Dynamic/buttons.json image:dup',
      'set:Static/buttons.json image:dup'
    ]);
    const standalone = sources.find(source => source.kind === 'standalone');
    assert.deepEqual(standalone, {
      schemaVersion: 1, projectId: 'g1008', kind: 'standalone',
      relativePath: 'Static/default_headshot.png', frameName: 'default_headshot',
      identity: '["g1008","standalone","Static/default_headshot.png"]',
      engineReference: 'image:Static/default_headshot.png',
      sourceSize: { w: 2, h: 2 }, crop: { x: 0, y: 0, w: 2, h: 2 }, offset: { x: 0, y: 0 }
    });
    const headshotComponent = components.find(node => node.name.includes('default_headshot'));
    assert.deepEqual([headshotComponent.width, headshotComponent.height], [2, 2]);
    // Deliberate whitelist: no local directory, helper fields or credentials reach the document.
    const document = JSON.stringify(page);
    for (const local of [f.project, f.data, f.root]) {
      assert.equal(document.includes(local), false);
      assert.equal(document.includes(local.replaceAll(String.fromCharCode(92), '/')), false);
    }
    assert.equal(document.includes(f.token), false);
  } finally { await f.cleanup(); }
});

test('import task refuses scans produced by an older helper protocol', async () => {
  const { api: figma } = figmaFixture();
  const platform = api.createFigmaPlatform(figma);
  const older = {
    schemaVersion: 1, project: { id: 'g2', name: '测试游戏' },
    resources: [], errors: [], complete: true,
    summary: { atlases: 0, sprites: 0, errors: 0 }
  };
  await assert.rejects(platform.importResources(older, () => {}), /扫描协议/);
});

test('helper client refuses scan responses from an incompatible protocol version', async () => {
  const server = createServer((request, response) => {
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify({ schemaVersion: 1, project: { id: 'g2', name: '测试游戏' }, resources: [] }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const client = new api.HelperClient('http://127.0.0.1:' + server.address().port, '0'.repeat(64));
    await assert.rejects(client.scan('g2'), /协议版本/);
  } finally { await new Promise(resolve => server.close(resolve)); }
});
