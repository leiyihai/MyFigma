import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseNineSliceRecord, createNineSliceRecord, serializeNineSliceRecord,
  nineSliceSourceSize, scaleMargins
} from '../dist/record.js';

const current = { left: 10, top: 8, right: 12, bottom: 6 };
const project = { left: 4, top: 4, right: 4, bottom: 4 };

test('parses legacy manual records as overrides and new records with project state', () => {
  const legacy = parseNineSliceRecord(JSON.stringify({
    schemaVersion: 1, margins: current, overlap: false, width: 100, height: 80
  }));
  assert.deepEqual(legacy, {
    schemaVersion: 1, margins: current, overlap: false, width: 100, height: 80,
    project: undefined, current, override: true
  });
  const importer = parseNineSliceRecord(serializeNineSliceRecord(
    createNineSliceRecord(current, { width: 100, height: 80 }, { project })
  ));
  assert.deepEqual(importer, {
    schemaVersion: 1, margins: current, overlap: false, width: 100, height: 80,
    project, current, override: false
  });
});

test('rejects corrupt or incomplete records instead of guessing margins', () => {
  for (const raw of ['', '{', JSON.stringify({ schemaVersion: 2, margins: current }),
    JSON.stringify({ schemaVersion: 1, margins: { left: -1, top: 0, right: 0, bottom: 0 }, overlap: false, width: 1, height: 1 }),
    JSON.stringify({ schemaVersion: 1, margins: current, overlap: false, width: 0, height: 1 })]) {
    assert.equal(parseNineSliceRecord(raw), undefined);
  }
});

test('a manual upgrade keeps its canvas and records the original image pixel space', () => {
  const upgraded = createNineSliceRecord(
    { left: 4, top: 4, right: 4, bottom: 4 }, { width: 120, height: 60 },
    { source: { width: 20, height: 20 }, override: true }
  );
  assert.deepEqual(nineSliceSourceSize(upgraded), { width: 20, height: 20 });
  assert.deepEqual(nineSliceSourceSize(createNineSliceRecord(current, { width: 100, height: 80 })), { width: 100, height: 80 });
  const parsed = parseNineSliceRecord(serializeNineSliceRecord(upgraded));
  assert.deepEqual(parsed, {
    schemaVersion: 1, margins: { left: 4, top: 4, right: 4, bottom: 4 }, overlap: false,
    width: 120, height: 60, source: { width: 20, height: 20 },
    project: undefined, current: { left: 4, top: 4, right: 4, bottom: 4 }, override: true
  });
  // A half-written source size is dropped instead of corrupting the record.
  const invalid = parseNineSliceRecord(JSON.stringify({
    schemaVersion: 1, margins: current, overlap: false, width: 100, height: 80,
    source: { width: 20 }, current, override: true
  }));
  assert.deepEqual(invalid.source, undefined);
});

test('margins scale between original image pixels and the component canvas', () => {
  const margins = { left: 4, top: 2, right: 6, bottom: 1 };
  assert.deepEqual(scaleMargins(margins, { width: 20, height: 20 }, { width: 120, height: 60 }),
    { left: 24, top: 6, right: 36, bottom: 3 });
  assert.deepEqual(scaleMargins(margins, { width: 20, height: 20 }, { width: 20, height: 20 }), margins);
  // A degenerate size never produces NaN/Infinity margins.
  assert.deepEqual(scaleMargins(margins, { width: 0, height: 20 }, { width: 120, height: 60 }),
    { left: 4, top: 6, right: 6, bottom: 3 });
});
