import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  COMPACT_COLOR_TOLERANCE, COMPACT_GRADIENT_RATIO,
  analyzeCompactUniformity, compactImage, createCompactPlan
} from '../dist/compact.js';

function imageOf(width, height, colorAt) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const [r, g, b, a = 255] = colorAt(x, y);
      const i = (y * width + x) * 4;
      data[i] = r; data[i + 1] = g; data[i + 2] = b; data[i + 3] = a;
    }
  }
  return { width, height, data };
}

function pixel(image, x, y) {
  const i = (y * image.width + x) * 4;
  return [image.data[i], image.data[i + 1], image.data[i + 2], image.data[i + 3]];
}

function block(image, x, y, width, height) {
  const pixels = [];
  for (let row = 0; row < height; row++)
    for (let column = 0; column < width; column++) pixels.push(pixel(image, x + column, y + row));
  return pixels;
}

test('uniform axes collapse to one pixel while gradient axes keep 25% without a cap', () => {
  const size = { width: 100, height: 80 };
  const margins = { left: 10, top: 10, right: 10, bottom: 10 };
  const solid = createCompactPlan(size, margins, { horizontal: true, vertical: true });
  assert.deepEqual([solid.width, solid.height], [21, 21]);
  assert.deepEqual(solid.targets, { width: 1, height: 1 });

  // The horizontal target applies to the top and bottom bands and the center.
  const horizontal = createCompactPlan(size, margins, { horizontal: false, vertical: true });
  const vertical = createCompactPlan(size, margins, { horizontal: true, vertical: false });
  // Center width is 80 -> 20; center height is 60 -> 15.
  assert.deepEqual([horizontal.width, horizontal.height], [40, 21]);
  assert.deepEqual([vertical.width, vertical.height], [21, 35]);
  assert.deepEqual(horizontal.targets, { width: 20, height: 1 });
  assert.deepEqual(vertical.targets, { width: 1, height: 15 });

  const dual = createCompactPlan({ width: 4000, height: 4000 }, { left: 0, top: 0, right: 0, bottom: 0 },
    { horizontal: false, vertical: false });
  assert.deepEqual(dual.targets, { width: 1000, height: 1000 });
  assert.deepEqual([dual.width, dual.height], [1000, 1000]);
  assert.equal(COMPACT_GRADIENT_RATIO, 0.25);
});

test('invalid sizes, margins and raster inputs are rejected instead of clamped', () => {
  const margins = { left: 10, top: 10, right: 10, bottom: 10 };
  for (const size of [{ width: 0, height: 80 }, { width: 100, height: -1 }, { width: NaN, height: 80 }])
    assert.throws(() => createCompactPlan(size, margins, { horizontal: true, vertical: true }), RangeError);
  for (const value of [-1, NaN, Infinity, 90])
    assert.throws(() => createCompactPlan({ width: 100, height: 80 }, { ...margins, left: value },
      { horizontal: true, vertical: true }), RangeError);
  assert.throws(() => compactImage({ width: 10, height: 10, data: new Uint8ClampedArray(10) }, margins),
    /像素数据长度/);
});

test('a near-solid image compresses both axes and keeps its colour and alpha', () => {
  const source = imageOf(40, 30, () => [200, 120, 40, 128]);
  const { plan, data } = compactImage(source, { left: 10, top: 10, right: 10, bottom: 10 });
  assert.deepEqual(plan.uniform, { horizontal: true, vertical: true });
  assert.deepEqual([plan.width, plan.height], [21, 21]);
  const result = { width: plan.width, height: plan.height, data };
  for (let y = 0; y < result.height; y++)
    for (let x = 0; x < result.width; x++) {
      const [r, g, b, a] = pixel(result, x, y);
      assert.ok(Math.abs(r - 200) <= 1 && Math.abs(g - 120) <= 1 && Math.abs(b - 40) <= 1);
      assert.equal(a, 128);
    }
  assert.ok(COMPACT_COLOR_TOLERANCE > 0);
});

test('horizontal and vertical gradients are judged separately', () => {
  // Every pixel depends on x, so each horizontal band varies while every column
  // stays vertically constant.
  const horizontal = imageOf(60, 30, x => [Math.round(x * 255 / 59), 20, 20, 255]);
  const horizontalResult = compactImage(horizontal, { left: 10, top: 10, right: 10, bottom: 10 });
  assert.deepEqual(horizontalResult.plan.uniform, { horizontal: false, vertical: true });
  // Center width 40 -> 10; center height 10 -> 1.
  assert.deepEqual([horizontalResult.plan.width, horizontalResult.plan.height], [30, 21]);

  const vertical = imageOf(40, 50, (x, y) => [20, Math.round(y * 255 / 49), 20, 255]);
  const verticalResult = compactImage(vertical, { left: 10, top: 10, right: 10, bottom: 10 });
  assert.deepEqual(verticalResult.plan.uniform, { horizontal: true, vertical: false });
  // Center width 20 -> 1; center height 30 -> round(7.5) = 8.
  assert.deepEqual([verticalResult.plan.width, verticalResult.plan.height], [21, 28]);

  const dual = imageOf(40, 40, (x, y) => [x * 6, y * 6, 30, 255]);
  const dualResult = compactImage(dual, { left: 5, top: 5, right: 5, bottom: 5 });
  assert.deepEqual(dualResult.plan.uniform, { horizontal: false, vertical: false });
  assert.deepEqual([dualResult.plan.width, dualResult.plan.height], [18, 18]);
});

test('a gradient confined to an edge band still keeps that axis instead of the center', () => {
  const topBandOnly = imageOf(60, 30, (x, y) => y < 10
    ? [Math.round(x * 255 / 59), 0, 0, 255] : [10, 10, 10, 255]);
  const uniform = analyzeCompactUniformity(topBandOnly, { left: 10, top: 10, right: 10, bottom: 10 });
  assert.deepEqual(uniform, { horizontal: false, vertical: true });

  const leftBandOnly = imageOf(40, 50, (x, y) => x < 10
    ? [0, Math.round(y * 255 / 49), 0, 255] : [10, 10, 10, 255]);
  const vertical = analyzeCompactUniformity(leftBandOnly, { left: 10, top: 10, right: 10, bottom: 10 });
  assert.deepEqual(vertical, { horizontal: true, vertical: false });
});

test('four corners keep their exact pixels and alpha while the center is resampled', () => {
  const source = imageOf(40, 30, (x, y) => {
    if (x < 10 && y < 10) return [250, 10, 10, 255];
    if (x >= 30 && y < 10) return [10, 250, 10, 120];
    if (x < 10 && y >= 20) return [10, 10, 250, 60];
    if (x >= 30 && y >= 20) return [250, 250, 10, 0];
    // A horizontal gradient in the stretchable area, so the center shrinks.
    return [Math.round((x - 10) * 255 / 19), 90, 90, 255];
  });
  const { plan, data } = compactImage(source, { left: 10, top: 10, right: 10, bottom: 10 });
  assert.equal(plan.uniform.horizontal, false);
  assert.equal(plan.width, 25);
  assert.equal(plan.height, 21);
  const result = { width: plan.width, height: plan.height, data };
  const rightX = plan.pixelMargins.left + plan.targets.width;
  const bottomY = plan.pixelMargins.top + plan.targets.height;

  assert.deepEqual(block(result, 0, 0, 10, 10), block(source, 0, 0, 10, 10));
  assert.deepEqual(block(result, rightX, 0, 10, 10), block(source, 30, 0, 10, 10));
  assert.deepEqual(block(result, 0, bottomY, 10, 10), block(source, 0, 20, 10, 10));
  assert.deepEqual(block(result, rightX, bottomY, 10, 10), block(source, 30, 20, 10, 10));
  assert.equal(pixel(result, rightX, bottomY)[3], 0);

  // The resampled center still carries the gradient rather than a flat colour.
  const center = [];
  for (let x = 10; x < 10 + plan.targets.width; x++) center.push(pixel(result, x, 10)[0]);
  assert.ok(Math.max(...center) - Math.min(...center) > 20);
});

test('zero margins compact the whole image and keep the transparency channel', () => {
  const source = imageOf(20, 20, (x, y) => [40, 80, 120, Math.round((x + y) * 255 / 38)]);
  const { plan, data } = compactImage(source, { left: 0, top: 0, right: 0, bottom: 0 });
  assert.deepEqual(plan.pixelMargins, { left: 0, top: 0, right: 0, bottom: 0 });
  assert.equal(plan.uniform.horizontal, false);
  assert.equal(plan.uniform.vertical, false);
  assert.deepEqual([plan.width, plan.height], [5, 5]);
  const alphas = new Set();
  for (let i = 3; i < data.length; i += 4) alphas.add(data[i]);
  assert.ok(alphas.size > 1, 'transparency variants must survive resampling');
  assert.ok([...alphas].every(alpha => alpha >= 0 && alpha <= 255));
  assert.equal(data.length, plan.width * plan.height * 4);
});
