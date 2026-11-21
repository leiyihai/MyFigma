import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseNineSliceRecord, createNineSliceRecord, serializeNineSliceRecord
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
