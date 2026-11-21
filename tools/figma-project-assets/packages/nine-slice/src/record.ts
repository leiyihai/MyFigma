import type { Margins } from './index.js';

export const NINE_SLICE_RECORD_KEY = 'myfigma.nineSlice.v1';

/**
 * Shared nine-slice component record used by both plugins.
 *
 * `margins` stays the effective margins for compatibility with records written
 * by earlier nine-slice plugin releases. `project` is the parameter chosen from
 * project UI JSON, `current` is what the component currently uses, and
 * `override` means a designer changed it by hand.
 */
export type NineSliceRecord = {
  schemaVersion: 1;
  margins: Margins;
  overlap: boolean;
  width: number;
  height: number;
  project?: Margins;
  current: Margins;
  override: boolean;
};

export function validMargins(value: unknown): value is Margins {
  if (!value || typeof value !== 'object') return false;
  const margins = value as Partial<Margins>;
  return [margins.left, margins.top, margins.right, margins.bottom]
    .every(item => typeof item === 'number' && Number.isFinite(item) && item >= 0);
}

function validSize(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 && value <= 1_000_000;
}

export function parseNineSliceRecord(raw: string | null | undefined): NineSliceRecord | undefined {
  if (!raw) return undefined;
  let value: unknown;
  try { value = JSON.parse(raw); } catch { return undefined; }
  if (!value || typeof value !== 'object') return undefined;
  const record = value as Partial<NineSliceRecord>;
  if (record.schemaVersion !== 1 || !validMargins(record.margins) || typeof record.overlap !== 'boolean' ||
      !validSize(record.width) || !validSize(record.height)) return undefined;
  const project = validMargins(record.project) ? record.project : undefined;
  const current = validMargins(record.current) ? record.current : record.margins;
  // Records from older releases only stored manual margins; treat them as an
  // override so an incremental import never silently replaces the designer's values.
  const override = typeof record.override === 'boolean' ? record.override : project === undefined;
  return {
    schemaVersion: 1, margins: current, overlap: record.overlap,
    width: record.width, height: record.height, project, current, override
  };
}

export function createNineSliceRecord(
  current: Margins,
  size: { width: number; height: number },
  options: { project?: Margins; overlap?: boolean; override?: boolean } = {}
): NineSliceRecord {
  return {
    schemaVersion: 1,
    margins: current,
    overlap: options.overlap === true,
    width: size.width,
    height: size.height,
    ...(options.project === undefined ? {} : { project: options.project }),
    current,
    override: options.override === true
  };
}

export function serializeNineSliceRecord(record: NineSliceRecord): string {
  return JSON.stringify(record);
}
