import { createNineSlicePlan } from '../packages/nine-slice/src/index';
import type { Margins, Size } from '../packages/nine-slice/src/index';
import { applyNineSliceComponent, createNineSliceComponent } from '../packages/nine-slice/src/figma';
import {
  NINE_SLICE_RECORD_KEY, createNineSliceRecord, nineSliceImageSize, parseNineSliceRecord,
  readImportMarker, readNineSliceRecord, scaleMargins, writeNineSliceRecord, serializeNineSliceRecord,
  type NineSliceRecord
} from '../packages/nine-slice/src/record';

type Language = 'zh' | 'en' | 'ja' | 'ko' | 'ru' | 'de' | 'fr';
type Settings = {
  top: number; bottom: number; left: number; right: number; all: number;
  overlap: boolean; keepOriginal: boolean; batchMode: boolean;
  lang: Language | 'auto'; settingsVersion: number;
};
type PluginMessage = (Settings & { type: 'save-only' | 'generate' }) |
  { type: 'ui-ready' } | { type: 'restore-project' } | { type: 'locate-main-component' };
type ImageNode = SceneNode & GeometryMixin;

type EditableSlice = {
  component: ComponentNode; margins: Margins; overlap: boolean; fill: ImagePaint;
  width: number; height: number; target: 'component' | 'instance';
  imageSize: Size; record?: NineSliceRecord; legacy: boolean;
};

const UPGRADE_REJECTIONS = ['auto-layout', 'image-child-not-filled', 'image-child-decorated',
  'multiple-children', 'extra-content'] as const;
type UpgradeRejection = (typeof UPGRADE_REJECTIONS)[number];
// A plain single-image component keeps its image either on the root or on one
// direct child that fully covers the component.
type PlainImageInspection =
  | { ok: true; fill: ImagePaint }
  | { ok: false; reason: UpgradeRejection };
// Figma can report a hairline difference between a child and its canvas even
// when the designer placed the image at 0,0 with the same size.
const COVERAGE_TOLERANCE = 0.01;

/** A plain single-image main component that can be upgraded manually. */
type Upgradeable = {
  component: ComponentNode; fill: ImagePaint; imageSize: Size;
  margins: Margins; overlap: boolean; record?: NineSliceRecord; imported: boolean;
};

figma.showUI(__html__, { width: 360, height: 740, themeColors: true });
let currentLang: Language = 'en';
const defaults: Settings = {
  top: 0, bottom: 0, left: 0, right: 0, all: 0,
  overlap: false, keepOriginal: false, batchMode: false, lang: 'auto', settingsVersion: 2
};
const notifications = {
  zh: { no_img: '❌ 请在画布选中图片图层', success: '✅ 九宫格组件已生成' },
  en: { no_img: '❌ Please select at least one image layer', success: '✅ 9-Slice Component Generated' },
  ja: { no_img: '❌ 画像レイヤーを選択してください', success: '✅ コンポーネント作成完了' },
  ko: { no_img: '❌ 이미지 레이어를 선택하세요', success: '✅ 구성 요소 생성 완료' },
  ru: { no_img: '❌ Выберите слой с изображением', success: '✅ Компонент создан' },
  de: { no_img: '❌ Bildebene auswählen', success: '✅ Komponente erstellt' },
  fr: { no_img: '❌ Sélectionnez un calque image', success: '✅ Composant généré' }
};
function notify(key: 'no_img' | 'success') {
  figma.notify(notifications[currentLang][key]);
}
function notifyLocalized(zh: string, en: string, options?: NotificationOptions) {
  figma.notify(currentLang === 'zh' ? zh : en, options);
}
function sameMargins(left: Margins | undefined, right: Margins | undefined): boolean {
  if (!left || !right) return left === right;
  return left.left === right.left && left.top === right.top && left.right === right.right && left.bottom === right.bottom;
}
function isLanguage(value: string): value is Language {
  return Object.prototype.hasOwnProperty.call(notifications, value);
}
function isImageNode(node: SceneNode): node is ImageNode {
  return 'fills' in node && Array.isArray(node.fills) && node.fills.some(fill => fill.type === 'IMAGE');
}
function visibleFills(node: SceneNode): readonly Paint[] {
  if (node.visible === false) return [];
  return 'fills' in node && Array.isArray(node.fills) ? node.fills.filter(fill => fill.visible !== false) : [];
}
function visibleImageFills(node: SceneNode): ImagePaint[] {
  return visibleFills(node).filter((fill): fill is ImagePaint => fill.type === 'IMAGE');
}
function usesAutoLayout(node: SceneNode): boolean {
  return 'layoutMode' in node && node.layoutMode !== 'NONE';
}
function hasVisibleStrokes(node: SceneNode): boolean {
  return node.visible !== false && 'strokes' in node && Array.isArray(node.strokes) &&
    node.strokes.some(stroke => stroke.visible !== false);
}
function hasVisibleEffects(node: SceneNode): boolean {
  return node.visible !== false && 'effects' in node && Array.isArray(node.effects) &&
    node.effects.some(effect => effect.visible !== false);
}
function hasRoundedCorners(node: SceneNode): boolean {
  const corner = node as SceneNode & {
    cornerRadius?: number | symbol; topLeftRadius?: number; topRightRadius?: number;
    bottomLeftRadius?: number; bottomRightRadius?: number;
  };
  return (typeof corner.cornerRadius === 'number' && corner.cornerRadius > 0) ||
    [corner.topLeftRadius, corner.topRightRadius, corner.bottomLeftRadius, corner.bottomRightRadius]
      .some(radius => typeof radius === 'number' && radius > 0);
}
function hasVisibleContent(node: SceneNode): boolean {
  return visibleFills(node).length > 0 || hasVisibleStrokes(node) || hasVisibleEffects(node);
}
function childCount(node: SceneNode): number {
  return 'children' in node ? node.children.length : 0;
}
function hasVisibleAppearance(node: SceneNode): boolean {
  return hasRoundedCorners(node) || hasVisibleStrokes(node) || hasVisibleEffects(node);
}
function hasVisibleExtraContent(node: SceneNode): boolean {
  return hasVisibleContent(node) || hasRoundedCorners(node);
}
function coversComponent(child: SceneNode, component: ComponentNode): boolean {
  return Math.abs(child.x) <= COVERAGE_TOLERANCE && Math.abs(child.y) <= COVERAGE_TOLERANCE &&
    Math.abs(child.width - component.width) <= COVERAGE_TOLERANCE &&
    Math.abs(child.height - component.height) <= COVERAGE_TOLERANCE;
}
// Converting an existing main component or an instance would break the source
// identity and every linked instance, so only plain layers are convertible.
function isConvertibleImageNode(node: SceneNode): node is ImageNode {
  return node.type !== 'INSTANCE' && node.type !== 'COMPONENT' && isImageNode(node);
}
function imageFill(node: ImageNode): ImagePaint | undefined {
  return Array.isArray(node.fills) ? node.fills.find((fill): fill is ImagePaint => fill.type === 'IMAGE') : undefined;
}
function isSliceNode(node: SceneNode): node is RectangleNode {
  return node.type === 'RECTANGLE' && /^切片 [1-3]-[1-3]$/.test(node.name);
}
function deriveSlice(component: ComponentNode): { margins: Margins; overlap: boolean } {
  const byName = new Map(component.children.filter(isSliceNode).map(node => [node.name, node]));
  const children = [...byName.values()];
  const overlap = children.some(child => !Number.isInteger(child.x) || !Number.isInteger(child.y));
  const centerX = byName.get('切片 1-2');
  const centerY = byName.get('切片 2-1');
  const right = byName.get('切片 1-3');
  const bottom = byName.get('切片 3-1');
  return {
    overlap,
    margins: {
      left: centerX ? centerX.x + (overlap ? 0.5 : 0) : 0,
      top: centerY?.y ?? 0,
      right: right ? right.width - (overlap ? 0.5 : 0) : 0,
      bottom: bottom?.height ?? 0
    }
  };
}
function savedMargins(component: ComponentNode): NineSliceRecord | undefined {
  return parseNineSliceRecord(readNineSliceRecord(component));
}
// The record may keep the designer's current canvas while its margins stay in
// original image pixels; convert before comparing against component geometry.
function canvasMargins(imageSize: Size, canvas: Size, margins: Margins): Margins {
  return imageSize.width === canvas.width && imageSize.height === canvas.height
    ? margins : scaleMargins(margins, imageSize, canvas);
}
function planFits(size: Size, margins: Margins, overlap: boolean): boolean {
  try { createNineSlicePlan(size, margins, overlap); return true; } catch { return false; }
}
function findEditable(node: SceneNode | undefined): EditableSlice | null {
  if (!node) return null;
  const component = node.type === 'COMPONENT' ? node : null;
  if (!component || !component.children.length || !component.children.every(isSliceNode)) return null;
  const fills = component.children.map(child => imageFill(child)).filter((fill): fill is ImagePaint => !!fill);
  if (!fills.length || new Set(fills.map(fill => fill.imageHash)).size !== 1) return null;
  const saved = savedMargins(component);
  const derived = deriveSlice(component);
  const canvas: Size = { width: component.width, height: component.height };
  const imageSize: Size = saved ? nineSliceImageSize(saved) : canvas;
  let margins = saved?.current ?? derived.margins;
  let overlap = saved?.overlap ?? derived.overlap;
  if (!planFits(canvas, canvasMargins(imageSize, canvas, margins), overlap)) {
    // A saved manual value can become invalid after the source shrinks. The
    // component is still structurally editable, so fall back to geometry and
    // let the UI offer "restore project parameter" instead of treating it as
    // an unrelated image layer. Geometry is already canvas space; only the
    // value returned to the UI is converted back into original image pixels.
    if (!saved) return null;
    margins = scaleMargins(derived.margins, canvas, imageSize);
    overlap = derived.overlap;
    if (!planFits(canvas, derived.margins, overlap)) return null;
  }
  return { component, margins, overlap, fill: fills[0], width: component.width, height: component.height,
    target: 'component', imageSize, record: saved, legacy: !saved };
}
// The source marker is only a provenance hint. Structure decides whether a
// component is a plain single image, so hand-made components upgrade too.
function inspectPlainImageComponent(node: SceneNode | undefined): PlainImageInspection | null {
  if (!node || node.type !== 'COMPONENT') return null;
  const component = node;
  const children = component.children;
  const rootImages = visibleImageFills(component);
  if (children.length === 0) {
    if (rootImages.length === 0) return null;
    if (usesAutoLayout(component)) return { ok: false, reason: 'auto-layout' };
    // One visible fill, and it must be the image itself.
    if (visibleFills(component).length !== 1) return { ok: false, reason: 'extra-content' };
    // The root is the image container here, so its own strokes, effects and
    // corner radius are extra visible content too.
    if (hasVisibleAppearance(component)) return { ok: false, reason: 'extra-content' };
    return { ok: true, fill: rootImages[0] };
  }
  if (children.length > 1) {
    if (rootImages.length === 0 && !children.some(child => visibleImageFills(child).length > 0)) return null;
    return { ok: false, reason: 'multiple-children' };
  }
  const child = children[0];
  const childImages = visibleImageFills(child);
  if (childImages.length === 0) return rootImages.length ? { ok: false, reason: 'extra-content' } : null;
  if (usesAutoLayout(component) || usesAutoLayout(child)) return { ok: false, reason: 'auto-layout' };
  // Structure B: the root must not add visible content of its own, including
  // strokes, effects and corner radius.
  if (hasVisibleExtraContent(component)) return { ok: false, reason: 'extra-content' };
  if (visibleFills(child).length !== 1) return { ok: false, reason: 'extra-content' };
  if (childCount(child) > 0) return { ok: false, reason: 'extra-content' };
  if (hasVisibleAppearance(child)) return { ok: false, reason: 'image-child-decorated' };
  if (!coversComponent(child, component)) return { ok: false, reason: 'image-child-not-filled' };
  return { ok: true, fill: childImages[0] };
}
function upgradeRejection(node: SceneNode | undefined): UpgradeRejection | null {
  const inspection = inspectPlainImageComponent(node);
  return inspection && !inspection.ok ? inspection.reason : null;
}
async function imagePixelSize(fill: ImagePaint): Promise<Size | null> {
  if (!fill.imageHash) return null;
  try {
    const image = figma.getImageByHash(fill.imageHash);
    const size = image ? await image.getSizeAsync() : null;
    if (size && Number.isFinite(size.width) && size.width > 0 && Number.isFinite(size.height) && size.height > 0)
      return { width: size.width, height: size.height };
  } catch (error) {
    console.error('读取原图尺寸失败', error);
  }
  return null;
}
async function findUpgradeable(node: SceneNode | undefined): Promise<Upgradeable | null> {
  if (!node || node.type !== 'COMPONENT') return null;
  const inspection = inspectPlainImageComponent(node);
  if (!inspection?.ok) return null;
  const imageSize = await imagePixelSize(inspection.fill);
  if (!imageSize) return null;
  const record = savedMargins(node);
  const usable = !!record && planFits(imageSize, record.current, record.overlap);
  return {
    component: node, fill: inspection.fill, imageSize,
    margins: usable ? record!.current : { left: 0, top: 0, right: 0, bottom: 0 },
    overlap: usable ? record!.overlap : false,
    record,
    // The importer marker only labels the source; it never gates the upgrade.
    imported: !!readImportMarker(node)
  };
}
function rememberSlice(component: ComponentNode, margins: Margins, overlap: boolean, override: boolean,
  imageSize?: Size): boolean {
  try {
    const existing = savedMargins(component);
    // Keep the project parameter that the atlas importer recorded so both
    // plugins read the same state; anything the designer changed is an override.
    const record = createNineSliceRecord(margins, { width: component.width, height: component.height },
      { project: existing?.project, overlap, override, imageSize: imageSize ?? existing?.imageSize });
    writeNineSliceRecord(component, serializeNineSliceRecord(record));
    return true;
  } catch (error) {
    console.error('保存九宫格信息失败', error);
    return false;
  }
}
function editPayload(edit: EditableSlice, editable: boolean) {
  return { margins: edit.margins, overlap: edit.overlap, target: edit.target, name: edit.component.name, editable,
    legacy: edit.legacy, project: edit.record?.project, override: edit.record?.override ?? true,
    imageSize: { width: edit.imageSize.width, height: edit.imageSize.height } };
}
function upgradePayload(upgrade: Upgradeable, editable: boolean) {
  return { margins: upgrade.margins, overlap: upgrade.overlap, target: 'upgrade', name: upgrade.component.name,
    editable, legacy: false, project: upgrade.record?.project, override: upgrade.record?.override ?? true,
    imported: upgrade.imported,
    imageSize: { width: upgrade.imageSize.width, height: upgrade.imageSize.height } };
}

let previewVersion = 0;
async function sendSelectionToUI() {
  const version = ++previewVersion;
  // dynamic-page: a large page may not have its contents/selection available
  // until it is explicitly loaded. Without this, currentPage.selection is empty
  // and the plugin falls back to "generate" even when a component is selected.
  try { await figma.currentPage.loadAsync(); } catch (error) { console.error('加载当前页失败', error); }
  if (version !== previewVersion) return;
  const node = figma.currentPage.selection[0];
  const edit = findEditable(node);
  let instanceComponent: ComponentNode | null = null;
  if (!edit && node?.type === 'INSTANCE') {
    try {
      instanceComponent = await node.getMainComponentAsync();
    } catch (error) {
      console.error('读取实例主组件失败', error);
    }
  }
  if (version !== previewVersion) return;
  const view = edit ?? (instanceComponent ? findEditable(instanceComponent) : null);
  let upgrade: Upgradeable | null = null;
  const upgradeTarget = node?.type === 'COMPONENT' ? node : instanceComponent ?? undefined;
  if (!view && upgradeTarget) {
    upgrade = await findUpgradeable(upgradeTarget);
    if (version !== previewVersion) return;
  }
  const payload = edit ? editPayload(edit, true) : view ? editPayload(view, false)
    : upgrade ? upgradePayload(upgrade, node?.type === 'COMPONENT') : null;
  const unsupported = payload || !node ? null
    : node.type === 'INSTANCE' ? 'instance'
    : node.type === 'COMPONENT' ? upgradeRejection(node) ?? 'component' : null;
  const fill = view?.fill ?? upgrade?.fill ?? (node && isImageNode(node) ? imageFill(node) : undefined);
  // A plain image main component is previewed and validated in original image
  // pixels, not at its current (possibly resized) canvas size.
  const width = view?.width ?? upgrade?.imageSize.width ?? (node && 'width' in node ? node.width : 0);
  const height = view?.height ?? upgrade?.imageSize.height ?? (node && 'height' in node ? node.height : 0);
  try {
    const hash = fill?.imageHash;
    const image = hash ? figma.getImageByHash(hash) : null;
    if (image) {
      const bytes = await image.getBytesAsync();
      if (version === previewVersion) {
        figma.ui.postMessage({ type: 'update-preview', bytes, width, height, edit: payload, unsupported });
      }
      return;
    }
  } catch (error) {
    console.error('读取图片预览失败', error);
  }
  if (version === previewVersion) figma.ui.postMessage({ type: 'update-preview', bytes: null, edit: payload, unsupported });
}

async function initSettings() {
  let saved: Partial<Settings> = {};
  try {
    saved = await figma.clientStorage.getAsync('nineSliceSettings') || {};
  } catch (error) {
    console.error('读取设置失败', error);
  }
  const settings = { ...defaults, ...saved };
  if (saved.settingsVersion !== 2) {
    // One-time migration: earlier releases defaulted these three switches on.
    settings.overlap = false; settings.keepOriginal = false; settings.batchMode = false;
    settings.settingsVersion = 2;
  }
  if (isLanguage(settings.lang)) currentLang = settings.lang;
  figma.ui.postMessage({ type: 'init-settings', settings });
}
figma.on('selectionchange', () => { void sendSelectionToUI(); });
void initSettings();
void sendSelectionToUI();

function validateMargins(msg: Settings, targets: readonly ImageNode[]) {
  try {
    for (const node of targets) createNineSlicePlan(node, msg);
    return true;
  } catch {
    return false;
  }
}

function generate(source: ImageNode, msg: Settings): ComponentNode {
  const fill = imageFill(source);
  if (!fill) throw new Error('图片填充不存在');
  const component = createNineSliceComponent(figma, { width: source.width, height: source.height, fill }, msg, { overlap: msg.overlap });
  try {
    const parent = source.parent;
    if (parent && 'appendChild' in parent) parent.appendChild(component);
    component.name = source.name;
    component.x = msg.keepOriginal ? source.x + source.width + 50 : source.x;
    component.y = source.y;
    if (!rememberSlice(component, { left: msg.left, top: msg.top, right: msg.right, bottom: msg.bottom }, msg.overlap, true))
      throw new Error('九宫格共享记录写入失败');
    return component;
  } catch (error) {
    component.remove();
    throw error;
  }
}

function notifyInvalidMargins(where: 'image' | 'canvas'): void {
  figma.notify(currentLang === 'zh'
    ? where === 'image'
      ? '边距必须为非负数，且左右之和小于原图宽度、上下之和小于原图高度（升级前请先确认原图像素尺寸）。'
      : '边距必须为非负数，且左右之和小于组件宽度、上下之和小于组件高度。'
    : where === 'image'
      ? 'Margins must be non-negative; their sums must be smaller than the original image width and height.'
      : 'Margins must be non-negative; their sums must be smaller than the component width and height.', { error: true });
}

/** Manually upgrade the selected plain single-image main component, keeping its identity and canvas size. */
async function upgradePlainComponent(upgrade: Upgradeable, msg: Settings): Promise<void> {
  const canvas: Size = { width: upgrade.component.width, height: upgrade.component.height };
  const margins: Margins = { left: msg.left, top: msg.top, right: msg.right, bottom: msg.bottom };
  if (!planFits(upgrade.imageSize, margins, msg.overlap)) { notifyInvalidMargins('image'); return; }
  const scaled = canvasMargins(upgrade.imageSize, canvas, margins);
  if (!planFits(canvas, scaled, msg.overlap)) { notifyInvalidMargins('canvas'); return; }
  const existing = upgrade.record;
  const recordUsable = !!existing && planFits(upgrade.imageSize, existing.current, existing.overlap);
  // Re-submitting the recorded values must not turn a project-driven component
  // into a manual override.
  const unchanged = recordUsable && sameMargins(existing!.current, margins) && existing!.overlap === msg.overlap;
  const override = unchanged ? existing!.override : true;
  generating = true;
  const previousRecord = readNineSliceRecord(upgrade.component);
  // Write the shared record before changing structure: if it fails, nothing was
  // upgraded and the success message cannot claim the source/project parameters
  // were preserved. A later structural failure attempts to restore the previous
  // record; this is a best-effort rollback, not a fabricated transaction.
  if (!rememberSlice(upgrade.component, margins, msg.overlap, override, upgrade.imageSize)) {
    generating = false;
    notifyLocalized('共享九宫格记录写入失败，未升级；组件保持普通图片。请重试或检查插件权限。',
      'The shared nine-slice record could not be written, so the component was not upgraded. Retry or check plugin permissions.', { error: true });
    return;
  }
  try {
    applyNineSliceComponent(figma, upgrade.component,
      { width: canvas.width, height: canvas.height, fill: upgrade.fill }, scaled, { overlap: msg.overlap });
    figma.viewport.scrollAndZoomIntoView([upgrade.component]);
    notifyLocalized('已在同一个主组件上完成手动九宫格升级；组件 ID、当前宽高与实例关联均保留。',
      'Manual 9-slice upgrade finished on the same main component; its ID, current size and instances stay intact.');
  } catch (error) {
    console.error('升级普通单图组件失败', error);
    try { writeNineSliceRecord(upgrade.component, previousRecord); }
    catch (recordError) { console.error('回滚九宫格记录失败', recordError); }
    notifyLocalized('升级失败；已尽力保留原组件，若内容不完整请查看插件控制台。',
      'Upgrade failed; the original component was kept as far as possible. Check the plugin console if its content looks incomplete.', { error: true });
  } finally {
    generating = false;
  }
}

let generating = false;
async function restoreProject(): Promise<void> {
  if (generating) return;
  const edit = findEditable(figma.currentPage.selection[0]);
  if (!edit) {
    notifyUnsupported();
    return;
  }
  const project = edit.record?.project;
  if (!project) {
    notifyLocalized('该组件没有记录项目参数，无法恢复；未做修改。',
      'This component has no recorded project parameter, so it cannot be restored. Nothing changed.', { error: true });
    return;
  }
  try {
    createNineSlicePlan(edit.imageSize, project, edit.record?.overlap);
    createNineSlicePlan({ width: edit.width, height: edit.height },
      canvasMargins(edit.imageSize, { width: edit.width, height: edit.height }, project), edit.record?.overlap);
  } catch {
    notifyLocalized('项目参数无法应用到当前组件尺寸，未做修改。',
      'The project parameter does not fit the current component size. Nothing changed.', { error: true });
    return;
  }
  generating = true;
  try {
    applyNineSliceComponent(figma, edit.component, { width: edit.width, height: edit.height, fill: edit.fill },
      canvasMargins(edit.imageSize, { width: edit.width, height: edit.height }, project), { overlap: edit.record?.overlap });
    const recorded = rememberSlice(edit.component, project, edit.record?.overlap === true, false, edit.record?.imageSize);
    void sendSelectionToUI();
    if (recorded) notifyLocalized('已恢复项目参数，并清除手动边距。', 'Project parameters restored; manual margins cleared.');
    else notifyLocalized('切片已按项目参数重建，但共享九宫格记录写入失败；来源与人工覆盖状态未能确认保存。',
      'Slices were rebuilt from the project parameter, but the shared nine-slice record could not be written; source and override state are not confirmed saved.',
      { error: true });
  } catch (error) {
    console.error('恢复项目参数失败', error);
    notifyLocalized('恢复失败，请查看插件控制台。', 'Restore failed. Check the plugin console.', { error: true });
  } finally {
    generating = false;
  }
}
const upgradeRejectionText: Record<UpgradeRejection, { zh: string; en: string }> = {
  'auto-layout': {
    zh: '该组件使用了 Auto Layout，普通单图组件升级不支持自动布局；未做修改。',
    en: 'This component uses Auto Layout, which the plain single-image upgrade does not support. Nothing changed.'
  },
  'image-child-not-filled': {
    zh: '图片子层未完整铺满组件（需位于 0,0 且尺寸等于组件画布）；未做修改。',
    en: 'The image child does not fully cover the component (it must sit at 0,0 with the component canvas size). Nothing changed.'
  },
  'image-child-decorated': {
    zh: '图片子层带圆角、描边或效果；升级会丢失这些视觉属性，因此未做修改。',
    en: 'The image child uses corner radius, strokes or effects that the upgrade would drop. Nothing changed.'
  },
  'multiple-children': {
    zh: '普通单图组件只能包含一张可见图片；该组件有多个子层，未做修改。',
    en: 'A plain single-image component may contain only one visible image; this component has multiple child layers. Nothing changed.'
  },
  'extra-content': {
    zh: '普通单图组件不能混入额外可见内容；该组件除一张图片外还有其他内容，未做修改。',
    en: 'A plain single-image component cannot contain extra visible content; this component has more than one image or an additional fill. Nothing changed.'
  }
};
function notifyUnsupported(reason?: UpgradeRejection | null): void {
  const detail = reason ? upgradeRejectionText[reason] : null;
  notifyLocalized(detail?.zh ?? '无法识别该组件：请选择本工具生成的九宫格主组件、普通单图组件或普通图片图层。未做修改。',
    detail?.en ?? 'Unrecognized component. Select a 9-slice main component created by this tool, a plain single-image component, or an image layer. Nothing changed.',
    { error: true });
}
async function locateMainComponent(): Promise<void> {
  const node = figma.currentPage.selection[0];
  if (node?.type !== 'INSTANCE') {
    notifyLocalized('请选中实例后再定位主组件。', 'Select an instance first, then locate its main component.', { error: true });
    return;
  }
  let main: ComponentNode | null = null;
  try {
    main = await node.getMainComponentAsync();
  } catch (error) {
    console.error('读取实例主组件失败', error);
  }
  if (!main) {
    notifyLocalized('无法读取该实例的主组件；实例和主组件都未修改。',
      'The main component of this instance cannot be read; nothing changed.', { error: true });
    return;
  }
  // Locating only selects the shared master; it never edits the instance or master.
  figma.currentPage.selection = [main];
  figma.viewport.scrollAndZoomIntoView([main]);
  notifyLocalized('已定位到主组件；修改会影响所有实例。', 'Located the main component; changes affect every instance.');
  void sendSelectionToUI();
}
figma.ui.onmessage = async (msg: PluginMessage) => {
  if (msg?.type === 'ui-ready') { void sendSelectionToUI(); return; }
  if (msg?.type === 'restore-project') { await restoreProject(); return; }
  if (msg?.type === 'locate-main-component') { await locateMainComponent(); return; }
  if (!msg || (msg.type !== 'save-only' && msg.type !== 'generate')) return;
  if (isLanguage(msg.lang)) currentLang = msg.lang;
  try {
    await figma.clientStorage.setAsync('nineSliceSettings', { ...msg, settingsVersion: 2 });
  } catch (error) {
    console.error('保存设置失败', error);
  }
  if (msg.type !== 'generate' || generating) return;
  const selection = figma.currentPage.selection[0];
  const edit = findEditable(selection);
  if (edit) {
    const canvas: Size = { width: edit.width, height: edit.height };
    if (!planFits(edit.imageSize, msg, msg.overlap)) { notifyInvalidMargins('image'); return; }
    const scaled = canvasMargins(edit.imageSize, canvas, msg);
    if (!planFits(canvas, scaled, msg.overlap)) { notifyInvalidMargins('canvas'); return; }
    generating = true;
    try {
      const margins: Margins = { left: msg.left, top: msg.top, right: msg.right, bottom: msg.bottom };
      // Pressing update without changing the effective values must not turn a
      // project-driven component into a manual override.
      const unchanged = sameMargins(edit.record?.current ?? edit.margins, margins) && (edit.record?.overlap ?? edit.overlap) === msg.overlap;
      const override = edit.record && unchanged ? edit.record.override : true;
      applyNineSliceComponent(figma, edit.component, { width: canvas.width, height: canvas.height, fill: edit.fill },
        scaled, { overlap: msg.overlap });
      const recorded = rememberSlice(edit.component, margins, msg.overlap, override, edit.record?.imageSize);
      figma.viewport.scrollAndZoomIntoView([edit.component]);
      if (recorded) notify('success');
      else notifyLocalized('九宫格切片已按边距更新，但共享记录写入失败；来源、项目参数与人工覆盖状态未能确认保存。',
        'The slices were updated, but the shared nine-slice record could not be written; source, project parameter and override state are not confirmed saved.',
        { error: true });
    } catch (error) {
      console.error('更新九宫格失败', error);
      figma.notify(currentLang === 'zh' ? '更新失败，请查看插件控制台。' : 'Update failed. Check the plugin console.', { error: true });
    } finally {
      generating = false;
    }
    return;
  }
  const upgrade = await findUpgradeable(selection);
  if (upgrade) {
    await upgradePlainComponent(upgrade, msg);
    return;
  }
  const targets = figma.currentPage.selection.filter(isConvertibleImageNode);
  if (targets.length === 0) {
    const first = figma.currentPage.selection[0];
    if (first?.type === 'INSTANCE') {
      notifyLocalized('选中的是实例；请定位主组件后编辑，不会自动改造实例。',
        'An instance is selected. Locate its main component to edit; instances are never converted automatically.',
        { error: true });
    } else if (first?.type === 'COMPONENT') {
      notifyUnsupported(upgradeRejection(first));
    } else notify('no_img');
    return;
  }
  const finalTargets = msg.batchMode ? targets : [targets[0]];
  if (!validateMargins(msg, finalTargets)) {
    figma.notify(currentLang === 'zh'
      ? '边距必须为非负数，且左右之和小于宽度、上下之和小于高度（批量时每张图均须满足）。'
      : 'Margins must be non-negative; their sums must be smaller than every target’s width and height.', { error: true });
    return;
  }
  generating = true;
  const generated: ComponentNode[] = [];
  try {
    for (const source of finalTargets) generated.push(generate(source, msg));
    // 所有组件成功后才删除原图；中途失败时保留原始素材。
    if (!msg.keepOriginal) finalTargets.forEach(source => source.remove());
    figma.currentPage.selection = generated;
    figma.viewport.scrollAndZoomIntoView(generated);
    notify('success');
  } catch (error) {
    generated.forEach(node => { if (!node.removed) node.remove(); });
    console.error('生成失败', error);
    figma.notify(currentLang === 'zh' ? '生成失败，请查看插件控制台。' : 'Generation failed. Check the plugin console.', { error: true });
  } finally {
    generating = false;
  }
};
