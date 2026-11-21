export type Margins = { left: number; top: number; right: number; bottom: number };
export type Size = { width: number; height: number };
export type Slice = Size & { x: number; y: number; row: number; column: number;
  horizontal: 'MIN' | 'STRETCH' | 'MAX'; vertical: 'MIN' | 'STRETCH' | 'MAX' };
export type NineSlicePlan = Size & { slices: Slice[] };
export function createNineSlicePlan(size: Size, margins: Margins, overlap = false): NineSlicePlan {
  const { width, height } = size;
  if (![width, height].every(value => Number.isFinite(value) && value > 0) ||
      ![margins.left, margins.top, margins.right, margins.bottom].every(value => Number.isFinite(value) && value >= 0) ||
      margins.left + margins.right >= width || margins.top + margins.bottom >= height) {
    throw new RangeError('边距必须为有限非负数，且左右之和小于宽度、上下之和小于高度；图片尺寸必须为有限正数。');
  }
  const columns = [margins.left, width - margins.left - margins.right, margins.right];
  const rows = [margins.top, height - margins.top - margins.bottom, margins.bottom];
  const xs = [0, margins.left, width - margins.right];
  const ys = [0, margins.top, height - margins.bottom];
  const constraints = ['MIN', 'STRETCH', 'MAX'] as const;
  const slices: Slice[] = [];
  for (let row = 0; row < 3; row++) {
    for (let column = 0; column < 3; column++) {
      if (columns[column] === 0 || rows[row] === 0) continue;
      let x = xs[column], sliceWidth = columns[column], sliceHeight = rows[row];
      // Preserve the standalone plugin's opt-in seam overlap; transparent edges need platform inspection.
      if (overlap) {
        if (column < 2) sliceWidth += 1;
        if (row < 2) sliceHeight += 1;
        if (column > 0) { x -= 0.5; sliceWidth += 0.5; }
      }
      slices.push({ x, y: ys[row], width: sliceWidth, height: sliceHeight,
        row, column, horizontal: constraints[column], vertical: constraints[row] });
    }
  }
  return { width, height, slices };
}
