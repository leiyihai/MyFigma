import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { readFile } from 'node:fs/promises';
import {
  projectFixture, writePng, solid, writeAtlas, writeLayout, layoutImageNode, register, scan
} from './atlas-fixture.mjs';

const panelMargins = { left: 10, top: 10, right: 10, bottom: 10 };
const tieMargins = { left: 5, top: 5, right: 5, bottom: 5 };

async function setup() {
  const f = await projectFixture();
  const imageset = join(f.project, 'res', 'imageset', 'Static');
  await writePng(join(imageset, 'buttons.png'), 40, 30, solid(40, 30, [10, 20, 30, 255]));
  await writeAtlas(join(imageset, 'buttons.json'), {
    image: 'buttons.png', size: { w: 40, h: 30 },
    frames: {
      panel: { frame: { x: 0, y: 0, w: 40, h: 30 } },
      plain: { frame: { x: 0, y: 0, w: 20, h: 20 }, sourceSize: { w: 20, h: 20 }, offset: { x: 0, y: 0 } },
      tie: { frame: { x: 0, y: 0, w: 30, h: 30 }, sourceSize: { w: 30, h: 30 }, offset: { x: 0, y: 0 } }
    }
  });
  await writePng(join(imageset, 'loose.png'), 16, 16, solid(16, 16, [1, 2, 3, 255]));
  await writeUi(f);
  await writeTie(f, ['5 5 5 5', '6 6 6 6']);
  await register(f);
  return f;
}

async function writeUi(f) {
  await writeLayout(join(f.project, 'res', 'layout', 'nested', 'ui.json'), [
    layoutImageNode('面板一', 'set:buttons.json image:panel', '10 10 10 10'),
    layoutImageNode('面板二', 'set:buttons.json image:panel', '10 10 10 10'),
    layoutImageNode('面板三', 'set:buttons.json image:panel', '9 9 9 9'),
    layoutImageNode('小图无效', 'set:buttons.json image:plain', '100 100 100 100'),
    layoutImageNode('公共一', 'set:public_common.json image:shared'),
    layoutImageNode('公共二', 'set:public_common.json image:shared'),
    layoutImageNode('独立图片', 'image:Static/loose.png', '4 4 4 4')
  ]);
}

async function writeTie(f, offsets) {
  await writeLayout(join(f.project, 'res', 'layout', 'tie.json'),
    offsets.map((offset, index) => layoutImageNode(`并列${index}`, 'set:buttons.json image:tie', offset)));
}

function resource(result, frameName) {
  return result.resources.find(item => item.source.frameName === frameName);
}

test('scans layout grids recursively, records complete local usage and ignores public references', async () => {
  const f = await setup();
  try {
    const result = await scan(f);
    assert.equal(result.schemaVersion, 3);
    assert.equal(result.complete, true);
    assert.equal(result.summary.layoutFiles, 2);
    assert.equal(result.summary.layoutReferences, 9);
    assert.equal(result.summary.layoutNineSlice, 7);
    assert.equal(result.summary.layoutIgnored, 2);
    assert.equal(result.summary.layoutInvalid, 1);
    assert.deepEqual(resource(result, 'panel').layout, {
      references: 3, nineSlice: { margins: panelMargins, usage: 2 }
    });
    assert.deepEqual(resource(result, 'tie').layout, {
      references: 2, nineSlice: { margins: tieMargins, usage: 1 }
    });
    assert.deepEqual(resource(result, 'plain').layout, { references: 1 });
    assert.deepEqual(resource(result, 'loose').layout, {
      references: 1, nineSlice: { margins: { left: 4, top: 4, right: 4, bottom: 4 }, usage: 1 }
    });
    assert.match(result.warnings.join('\n'), /小图无效/);
    assert.match(result.warnings.join('\n'), /100 100 100 100/);
    assert.match(result.warnings.join('\n'), /2 项/);
    // Public references are only aggregated; their atlas and node names never enter the Figma payload.
    assert.equal(JSON.stringify(result).includes('public_common.json'), false);

    const cached = JSON.parse(await readFile(join(f.data, 'scans', 'g1008.json'), 'utf8'));
    assert.equal(cached.schemaVersion, 3);
    assert.deepEqual(cached.layout.files, ['res/layout/nested/ui.json', 'res/layout/tie.json']);
    assert.equal(cached.layout.usages.length, 9);
    const publicUsage = cached.layout.usages.find(item => item.node === '公共一');
    assert.deepEqual([publicUsage.resolved, publicUsage.reason], [false, 'public']);
    assert.deepEqual(cached.layout.ignored, [{ reference: 'set:public_common.json image:shared', count: 2 }]);
    const cachedPanel = cached.resources.find(item => item.source.frameName === 'panel');
    assert.deepEqual(cachedPanel.layout.nineSliceVariants, [
      { margins: panelMargins, usage: 2 }, { margins: { left: 9, top: 9, right: 9, bottom: 9 }, usage: 1 }
    ]);
    assert.equal(JSON.stringify(cached).includes(JSON.stringify(f.project).slice(1, -1)), false);
  } finally { await f.cleanup(); }
});

test('keeps the previous grid margins while they remain top candidates and otherwise uses a stable order', async () => {
  const f = await setup();
  try {
    assert.deepEqual(resource(await scan(f), 'tie').layout.nineSlice.margins, tieMargins);

    // The previous value is no longer a top candidate, so the new most frequent value wins.
    await writeTie(f, ['6 6 6 6', '6 6 6 6', '5 5 5 5']);
    assert.deepEqual(resource(await scan(f), 'tie').layout.nineSlice.margins,
      { left: 6, top: 6, right: 6, bottom: 6 });

    // A tie keeps the previous value instead of drifting back to the lexicographic first value.
    await writeTie(f, ['5 5 5 5', '5 5 5 5', '6 6 6 6', '6 6 6 6']);
    assert.deepEqual(resource(await scan(f), 'tie').layout.nineSlice.margins,
      { left: 6, top: 6, right: 6, bottom: 6 });

    // With no previous value the first tie uses the explicit stable order (left, top, right, bottom).
    const fresh = await projectFixture();
    try {
      await writePng(join(fresh.project, 'res', 'imageset', 'Static', 'buttons.png'), 30, 30,
        solid(30, 30, [4, 5, 6, 255]));
      await writeAtlas(join(fresh.project, 'res', 'imageset', 'Static', 'buttons.json'), {
        image: 'buttons.png', size: { w: 30, h: 30 },
        frames: { tie: { frame: { x: 0, y: 0, w: 30, h: 30 } } }
      });
      await writeTie(fresh, ['6 6 6 6', '5 5 5 5']);
      await register(fresh);
      assert.deepEqual(resource(await scan(fresh), 'tie').layout.nineSlice.margins, tieMargins);
    } finally { await fresh.cleanup(); }
  } finally { await f.cleanup(); }
});
