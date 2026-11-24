import type { Margins, Size } from './index.js';

/**
 * Raster compaction for nine-slice images.
 *
 * The four corners keep their source pixels. The three stretchable bands share
 * one target per axis: a uniform (near-solid) direction collapses to a single
 * pixel, while a gradient or non-uniform direction keeps 25% of its original
 * length with no upper cap. Both axes are judged independently.
 *
 * This module is deliberately independent of the DOM and of Figma so the real
 * pixel work can be tested with plain RGBA arrays. The plugin UI only decodes
 * bytes into a canvas and encodes the result back to PNG.
 */
export type RgbaImage = Size & { data: Uint8ClampedArray | Uint8Array };
export type CompactUniformity = { horizontal: boolean; vertical: boolean };
export type CompactPlan = Size & {
  source: Size;
  /** Integer pixel margins used to slice the source raster. */
  pixelMargins: Margins;
  /** Target lengths of the centre column and row. */
  targets: Size;
  uniform: CompactUniformity;
};

/**
 * Maximum per-channel difference (premultiplied RGBA, 0-255) that still counts
 * as "near solid". Smaller differences are visually indistinguishable when the
 * band is stretched, so they collapse to 1px.
 */
export const COMPACT_COLOR_TOLERANCE = 6;
/** Fraction of a non-uniform stretchable length that is preserved. */
export const COMPACT_GRADIENT_RATIO = 0.25;
const MAX_SIZE = 1_000_000;

/** Length kept for one stretchable direction. */
export function compactTarget(original: number, uniform: boolean): number {
  if (!Number.isFinite(original) || original <= 0) {
    throw new RangeError('可拉伸区域的原始尺寸必须为有限正数。');
  }
  return uniform ? 1 : Math.max(1, Math.round(original * COMPACT_GRADIENT_RATIO));
}

function quantizedSize(size: Size): Size {
  const width = Math.round(size.width);
  const height = Math.round(size.height);
  if (!Number.isFinite(size.width) || !Number.isFinite(size.height) ||
      width <= 0 || height <= 0 || width > MAX_SIZE || height > MAX_SIZE) {
    throw new RangeError('图片尺寸必须为有限正数。');
  }
  return { width, height };
}

function quantizedMargins(margins: Margins): Margins {
  const values = [margins.left, margins.top, margins.right, margins.bottom];
  if (!values.every(value => Number.isFinite(value) && value >= 0)) {
    throw new RangeError('边距必须为有限非负数。');
  }
  return {
    left: Math.round(margins.left), top: Math.round(margins.top),
    right: Math.round(margins.right), bottom: Math.round(margins.bottom)
  };
}

function pixelMargins(size: Size, margins: Margins): { source: Size; pixelMargins: Margins;
  center: Size } {
  const source = quantizedSize(size);
  const px = quantizedMargins(margins);
  const center = { width: source.width - px.left - px.right, height: source.height - px.top - px.bottom };
  if (center.width <= 0 || center.height <= 0) {
    throw new RangeError('边距必须为非负数，且左右之和小于宽度、上下之和小于高度。');
  }
  return { source, pixelMargins: px, center };
}

/**
 * Build the compact geometry without looking at pixels. `uniform` lets callers
 * test the 1px / 25% rule directly; `compactImage` derives it from the pixels.
 */
export function createCompactPlan(size: Size, margins: Margins, uniform: CompactUniformity): CompactPlan {
  const { source, pixelMargins: px, center } = pixelMargins(size, margins);
  const targets = {
    width: compactTarget(center.width, uniform.horizontal),
    height: compactTarget(center.height, uniform.vertical)
  };
  return {
    width: px.left + targets.width + px.right,
    height: px.top + targets.height + px.bottom,
    source, pixelMargins: px, targets,
    uniform: { horizontal: uniform.horizontal, vertical: uniform.vertical }
  };
}

function validateImage(image: RgbaImage): void {
  if (!image || !Number.isInteger(image.width) || !Number.isInteger(image.height) ||
      image.width <= 0 || image.height <= 0) {
    throw new RangeError('图片尺寸必须为正整数像素。');
  }
  if (!image.data || image.data.length !== image.width * image.height * 4) {
    throw new RangeError('像素数据长度与图片尺寸不匹配。');
  }
}

/**
 * A direction is uniform when every stretchable line has the same average
 * premultiplied colour. Comparing line averages (rather than adjacent pixels)
 * catches gradual gradients; premultiplication keeps transparent areas from
 * looking like arbitrary colour changes. Only the stretched span is analysed,
 * so fixed corners never decide a direction.
 */
function horizontalUniform(image: RgbaImage, px: Margins, center: Size): boolean {
  const { width, height, data } = image;
  const columns = center.width;
  const bands = [[0, px.top], [px.top, px.top + center.height], [px.top + center.height, height]];
  for (const [y0, y1] of bands) {
    if (y1 <= y0) continue;
    const sums = new Float64Array(columns * 4);
    for (let y = y0; y < y1; y++) {
      let index = (y * width + px.left) * 4;
      for (let x = 0; x < columns; x++, index += 4) {
        const alpha = data[index + 3];
        const offset = x * 4;
        sums[offset] += data[index] * alpha / 255;
        sums[offset + 1] += data[index + 1] * alpha / 255;
        sums[offset + 2] += data[index + 2] * alpha / 255;
        sums[offset + 3] += alpha;
      }
    }
    const count = y1 - y0;
    const mean = [0, 0, 0, 0];
    for (let x = 0; x < columns; x++)
      for (let channel = 0; channel < 4; channel++) mean[channel] += sums[x * 4 + channel] / count;
    for (let channel = 0; channel < 4; channel++) mean[channel] /= columns;
    for (let x = 0; x < columns; x++)
      for (let channel = 0; channel < 4; channel++)
        if (Math.abs(sums[x * 4 + channel] / count - mean[channel]) > COMPACT_COLOR_TOLERANCE) return false;
  }
  return true;
}

function verticalUniform(image: RgbaImage, px: Margins, center: Size): boolean {
  const { width, height, data } = image;
  const rows = center.height;
  const bands = [[0, px.left], [px.left, px.left + center.width], [px.left + center.width, width]];
  for (const [x0, x1] of bands) {
    if (x1 <= x0) continue;
    const sums = new Float64Array(rows * 4);
    for (let y = 0; y < rows; y++) {
      let index = ((px.top + y) * width + x0) * 4;
      for (let x = x0; x < x1; x++, index += 4) {
        const alpha = data[index + 3];
        const offset = y * 4;
        sums[offset] += data[index] * alpha / 255;
        sums[offset + 1] += data[index + 1] * alpha / 255;
        sums[offset + 2] += data[index + 2] * alpha / 255;
        sums[offset + 3] += alpha;
      }
    }
    const count = x1 - x0;
    const mean = [0, 0, 0, 0];
    for (let y = 0; y < rows; y++)
      for (let channel = 0; channel < 4; channel++) mean[channel] += sums[y * 4 + channel] / count;
    for (let channel = 0; channel < 4; channel++) mean[channel] /= rows;
    for (let y = 0; y < rows; y++)
      for (let channel = 0; channel < 4; channel++)
        if (Math.abs(sums[y * 4 + channel] / count - mean[channel]) > COMPACT_COLOR_TOLERANCE) return false;
  }
  return true;
}

export function analyzeCompactUniformity(image: RgbaImage, margins: Margins): CompactUniformity {
  validateImage(image);
  const { pixelMargins: px, center } = pixelMargins(image, margins);
  return { horizontal: horizontalUniform(image, px, center), vertical: verticalUniform(image, px, center) };
}

type Weight = { index: number; weight: number };

function sourceWeights(start: number, end: number, sourceSize: number): Weight[] {
  const total = end - start;
  if (!(total > 0)) {
    const index = Math.min(sourceSize - 1, Math.max(0, Math.floor(start)));
    return [{ index, weight: 1 }];
  }
  const weights: Weight[] = [];
  const first = Math.max(0, Math.floor(start));
  const last = Math.min(sourceSize, Math.ceil(end));
  let sum = 0;
  for (let index = first; index < last; index++) {
    const weight = Math.min(end, index + 1) - Math.max(start, index);
    if (weight > 1e-9) { weights.push({ index, weight }); sum += weight; }
  }
  if (weights.length === 0) {
    const index = Math.min(sourceSize - 1, Math.max(0, Math.floor(start)));
    return [{ index, weight: 1 }];
  }
  for (const entry of weights) entry.weight /= sum;
  return weights;
}

/**
 * Destination pixel i maps to one of three source segments: the fixed left/top
 * corner, the linearly scaled centre, or the fixed right/bottom corner. The
 * same target length is used by every band on that axis.
 */
function axisWeights(sourceSize: number, before: number, centerSource: number, target: number,
  after: number): Weight[][] {
  const weights: Weight[][] = new Array(before + target + after);
  const segments = [
    { sourceStart: 0, sourceEnd: before, targetStart: 0, targetEnd: before },
    { sourceStart: before, sourceEnd: before + centerSource,
      targetStart: before, targetEnd: before + target },
    { sourceStart: before + centerSource, sourceEnd: sourceSize,
      targetStart: before + target, targetEnd: before + target + after }
  ];
  for (const segment of segments) {
    const targetSpan = segment.targetEnd - segment.targetStart;
    if (targetSpan <= 0) continue;
    const scale = (segment.sourceEnd - segment.sourceStart) / targetSpan;
    for (let position = segment.targetStart; position < segment.targetEnd; position++) {
      const start = segment.sourceStart + (position - segment.targetStart) * scale;
      weights[position] = sourceWeights(start, start + scale, sourceSize);
    }
  }
  return weights;
}

/** Area/box resampling on premultiplied colour so transparent edges stay clean. */
function resampleHorizontal(image: RgbaImage, weights: Weight[][], outWidth: number): Float32Array {
  const { width, height, data } = image;
  const out = new Float32Array(outWidth * height * 4);
  for (let y = 0; y < height; y++) {
    const row = y * width * 4;
    const outRow = y * outWidth * 4;
    for (let x = 0; x < outWidth; x++) {
      let red = 0, green = 0, blue = 0, alpha = 0;
      for (const { index, weight } of weights[x]) {
        const source = row + index * 4;
        const sourceAlpha = data[source + 3];
        red += data[source] * sourceAlpha * weight;
        green += data[source + 1] * sourceAlpha * weight;
        blue += data[source + 2] * sourceAlpha * weight;
        alpha += sourceAlpha * weight;
      }
      const target = outRow + x * 4;
      out[target] = red / 255;
      out[target + 1] = green / 255;
      out[target + 2] = blue / 255;
      out[target + 3] = alpha;
    }
  }
  return out;
}

function resampleVertical(premultiplied: Float32Array, width: number, weights: Weight[][],
  outHeight: number): Uint8ClampedArray {
  const out = new Uint8ClampedArray(width * outHeight * 4);
  for (let y = 0; y < outHeight; y++) {
    for (let x = 0; x < width; x++) {
      let red = 0, green = 0, blue = 0, alpha = 0;
      for (const { index, weight } of weights[y]) {
        const source = (index * width + x) * 4;
        red += premultiplied[source] * weight;
        green += premultiplied[source + 1] * weight;
        blue += premultiplied[source + 2] * weight;
        alpha += premultiplied[source + 3] * weight;
      }
      const target = (y * width + x) * 4;
      if (alpha > 0) {
        out[target] = red * 255 / alpha;
        out[target + 1] = green * 255 / alpha;
        out[target + 2] = blue * 255 / alpha;
      }
      out[target + 3] = alpha;
    }
  }
  return out;
}

function copyBlock(source: RgbaImage, target: Uint8ClampedArray, targetWidth: number,
  sourceX: number, sourceY: number, targetX: number, targetY: number, width: number, height: number): void {
  if (width <= 0 || height <= 0) return;
  for (let y = 0; y < height; y++) {
    const sourceRow = ((sourceY + y) * source.width + sourceX) * 4;
    const targetRow = ((targetY + y) * targetWidth + targetX) * 4;
    target.set(source.data.subarray(sourceRow, sourceRow + width * 4), targetRow);
  }
}

/**
 * Compact an RGBA raster. Corners are copied verbatim (exact colour and alpha),
 * the centre is area-resampled, and the output size follows `createCompactPlan`.
 */
export function compactImage(image: RgbaImage, margins: Margins): { plan: CompactPlan; data: Uint8ClampedArray } {
  validateImage(image);
  const uniform = analyzeCompactUniformity(image, margins);
  const plan = createCompactPlan(image, margins, uniform);
  const px = plan.pixelMargins;
  const center = { width: image.width - px.left - px.right, height: image.height - px.top - px.bottom };
  const weightsX = axisWeights(image.width, px.left, center.width, plan.targets.width, px.right);
  const weightsY = axisWeights(image.height, px.top, center.height, plan.targets.height, px.bottom);
  const premultiplied = resampleHorizontal(image, weightsX, plan.width);
  const data = resampleVertical(premultiplied, plan.width, weightsY, plan.height);

  const rightTarget = px.left + plan.targets.width;
  const bottomTarget = px.top + plan.targets.height;
  copyBlock(image, data, plan.width, 0, 0, 0, 0, px.left, px.top);
  copyBlock(image, data, plan.width, image.width - px.right, 0, rightTarget, 0, px.right, px.top);
  copyBlock(image, data, plan.width, 0, image.height - px.bottom, 0, bottomTarget, px.left, px.bottom);
  copyBlock(image, data, plan.width, image.width - px.right, image.height - px.bottom,
    rightTarget, bottomTarget, px.right, px.bottom);
  return { plan, data };
}
