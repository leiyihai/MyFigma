import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createNineSlicePlan } from '../dist/index.js';

test('invalid sizes and margins fail explicitly without clamping', () => {
  const size = { width: 100, height: 80 };
  const margins = { left: 10, top: 12, right: 20, bottom: 8 };
  for (const value of [-1, NaN, Infinity, 80]) {
    assert.throws(() => createNineSlicePlan(size, { ...margins, left: value }), RangeError);
  }
  for (const value of [0, -1, NaN, Infinity]) {
    assert.throws(() => createNineSlicePlan({ ...size, width: value }, margins), RangeError);
  }
  assert.throws(() => createNineSlicePlan(size, { ...margins, top: 72 }), RangeError);
});

test('zero margins omit empty slices and optional gap overlap preserves legacy geometry', () => {
  const size = { width: 100, height: 80 };
  const zero = createNineSlicePlan(size, { left: 0, top: 0, right: 0, bottom: 0 });
  assert.deepEqual(zero.slices.map(s => [s.x, s.y, s.width, s.height]), [[0, 0, 100, 80]]);
  const overlapped = createNineSlicePlan(size, { left: 10, top: 10, right: 10, bottom: 10 }, true);
  assert.deepEqual(overlapped.slices.map(s => [s.x, s.y, s.width, s.height]), [
    [0, 0, 11, 11], [9.5, 0, 81.5, 11], [89.5, 0, 10.5, 11],
    [0, 10, 11, 61], [9.5, 10, 81.5, 61], [89.5, 10, 10.5, 61],
    [0, 70, 11, 10], [9.5, 70, 81.5, 10], [89.5, 70, 10.5, 10]
  ]);
});

test('four distinct margins define fixed corners, one-axis edges and a stretching center', () => {
  const plan = createNineSlicePlan({ width: 100, height: 80 }, { left: 10, top: 12, right: 20, bottom: 8 });
  assert.deepEqual(plan.slices.map(s => [s.x, s.y, s.width, s.height, s.horizontal, s.vertical]), [
    [0, 0, 10, 12, 'MIN', 'MIN'], [10, 0, 70, 12, 'STRETCH', 'MIN'], [80, 0, 20, 12, 'MAX', 'MIN'],
    [0, 12, 10, 60, 'MIN', 'STRETCH'], [10, 12, 70, 60, 'STRETCH', 'STRETCH'], [80, 12, 20, 60, 'MAX', 'STRETCH'],
    [0, 72, 10, 8, 'MIN', 'MAX'], [10, 72, 70, 8, 'STRETCH', 'MAX'], [80, 72, 20, 8, 'MAX', 'MAX']
  ]);
});
