import type { Margins, Size } from './index.js';

export const NINE_SLICE_RECORD_KEY = 'myfigma.nineSlice.v1';
export const NINE_SLICE_SHARED_NAMESPACE = 'myfigma';
export const NINE_SLICE_SHARED_KEY = 'nineSlice.v1';
// Cross-plugin proof that the atlas importer created this component. The value
// only keeps the project-relative source identity, never a local machine path.
export const IMPORT_MARKER_NAMESPACE = 'myfigma';
export const IMPORT_MARKER_KEY = 'atlas.origin';

// Atlas importer and nine-slice plugin have different plugin IDs. Figma private
// plugin data is scoped to the writer, so the shared record must use the shared
// plugin-data store; private data remains as a legacy fallback.
export type RecordNode = {
  getPluginData(key: string): string;
  setPluginData(key: string, value: string): void;
  getSharedPluginData?(namespace: string, key: string): string;
  setSharedPluginData?(namespace: string, key: string, value: string): void;
};
export function readNineSliceRecord(node: RecordNode): string {
  return node.getSharedPluginData?.(NINE_SLICE_SHARED_NAMESPACE, NINE_SLICE_SHARED_KEY) || node.getPluginData(NINE_SLICE_RECORD_KEY);
}
export function writeNineSliceRecord(node: RecordNode, value: string): void {
  if (node.setSharedPluginData) node.setSharedPluginData(NINE_SLICE_SHARED_NAMESPACE, NINE_SLICE_SHARED_KEY, value);
  // Keep the legacy private copy for older plugin builds and existing tests.
  node.setPluginData(NINE_SLICE_RECORD_KEY, value);
}

export type ImportMarker = { schemaVersion: 1; identity: string };
export function readImportMarker(node: RecordNode): ImportMarker | undefined {
  const raw = node.getSharedPluginData?.(IMPORT_MARKER_NAMESPACE, IMPORT_MARKER_KEY);
  if (!raw) return undefined;
  try {
    const value = JSON.parse(raw) as Partial<ImportMarker>;
    if (value.schemaVersion === 1 && typeof value.identity === 'string' &&
        value.identity.length > 0 && value.identity.length <= 4096) {
      return { schemaVersion: 1, identity: value.identity };
    }
  } catch { /* a corrupt marker is treated like a missing one */ }
  return undefined;
}
export function writeImportMarker(node: RecordNode, identity: string): void {
  if (!node.setSharedPluginData) return;
  node.setSharedPluginData(IMPORT_MARKER_NAMESPACE, IMPORT_MARKER_KEY, JSON.stringify({ schemaVersion: 1, identity }));
}

/**
 * Shared nine-slice component record used by both plugins.
 *
 * `margins` stays the effective margins for compatibility with records written
 * by earlier nine-slice plugin releases. `project` is the parameter chosen from
 * project UI JSON, `current` is what the component currently uses, and
 * `override` means a designer changed it by hand.
 *
 * `width`/`height` are the component canvas size the margins were laid out for.
 * `current` and `margins` are always expressed in original image pixels. A plain
 * importer component starts with canvas == image pixels; after a manual
 * nine-slice upgrade the designer's canvas stays unchanged, so `imageSize`
 * records the original image pixel size and the canvas is scaled separately.
 */
export type NineSliceRecord = {
  schemaVersion: 1;
  margins: Margins;
  overlap: boolean;
  width: number;
  height: number;
  imageSize?: Size;
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
  const imageSize = validSize(record.imageSize?.width) && validSize(record.imageSize?.height)
    ? { width: record.imageSize!.width, height: record.imageSize!.height } : undefined;
  const current = validMargins(record.current) ? record.current : record.margins;
  // Records from older releases only stored manual margins; treat them as an
  // override so an incremental import never silently replaces the designer's values.
  const override = typeof record.override === 'boolean' ? record.override : project === undefined;
  return {
    schemaVersion: 1, margins: current, overlap: record.overlap,
    width: record.width, height: record.height,
    ...(imageSize === undefined ? {} : { imageSize }),
    project, current, override
  };
}

export function createNineSliceRecord(
  current: Margins,
  size: Size,
  options: { project?: Margins; overlap?: boolean; override?: boolean; imageSize?: Size } = {}
): NineSliceRecord {
  return {
    schemaVersion: 1,
    margins: current,
    overlap: options.overlap === true,
    width: size.width,
    height: size.height,
    ...(options.imageSize === undefined ? {} : { imageSize: options.imageSize }),
    ...(options.project === undefined ? {} : { project: options.project }),
    current,
    override: options.override === true
  };
}

/** Size of the pixels the recorded margins are expressed in. */
export function nineSliceImageSize(record: NineSliceRecord): Size {
  return record.imageSize ?? { width: record.width, height: record.height };
}

/** Convert margins between the original image space and the component canvas. */
export function scaleMargins(margins: Margins, from: Size, to: Size): Margins {
  const scaleX = from.width > 0 && to.width > 0 ? to.width / from.width : 1;
  const scaleY = from.height > 0 && to.height > 0 ? to.height / from.height : 1;
  return {
    left: margins.left * scaleX, top: margins.top * scaleY,
    right: margins.right * scaleX, bottom: margins.bottom * scaleY
  };
}

export function serializeNineSliceRecord(record: NineSliceRecord): string {
  return JSON.stringify(record);
}
