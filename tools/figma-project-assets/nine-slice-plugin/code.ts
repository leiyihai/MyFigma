import { createNineSlicePlan } from '../packages/nine-slice/src/index';
import type { Margins, Size } from '../packages/nine-slice/src/index';
import { applyNineSliceComponent, createNineSliceComponent } from '../packages/nine-slice/src/figma';
import {
  NINE_SLICE_RECORD_KEY, createNineSliceRecord, nineSliceSourceSize, parseNineSliceRecord,
  readNineSliceRecord, scaleMargins, writeNineSliceRecord, serializeNineSliceRecord, type NineSliceRecord
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
  source: Size; record?: NineSliceRecord; legacy: boolean;
};

/** An importer-created plain image main component that can be upgraded in place. */
type Upgradeable = {
  component: ComponentNode; fill: ImagePaint; source: Size;
  margins: Margins; overlap: boolean; record?: NineSliceRecord;
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
function canvasMargins(source: Size, canvas: Size, margins: Margins): Margins {
  return source.width === canvas.width && source.height === canvas.height
    ? margins : scaleMargins(margins, source, canvas);
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
  const source: Size = saved ? nineSliceSourceSize(saved) : canvas;
  let margins = saved?.current ?? derived.margins;
  let overlap = saved?.overlap ?? derived.overlap;
  if (!planFits(canvas, canvasMargins(source, canvas, margins), overlap)) {
    // A saved manual value can become invalid after the source shrinks. The
    // component is still structurally editable, so fall back to geometry and
    // let the UI offer "restore project parameter" instead of treating it as
    // an unrelated image layer.
    if (!saved) return null;
    margins = derived.margins;
    overlap = derived.overlap;
    if (!planFits(canvas, canvasMargins(source, canvas, margins), overlap)) return null;
  }
  return { component, margins, overlap, fill: fills[0], width: component.width, height: component.height,
    target: 'component', source, record: saved, legacy: !saved };
}
// Only an untouched importer plain image master is safe: one image fill, no
// children, no auto layout. Anything the designer built further is rejected.
function isPlainImageComponent(node: SceneNode | undefined): node is ComponentNode {
  if (!node || node.type !== 'COMPONENT' || node.children.length !== 0 || node.layoutMode !== 'NONE') return false;
  const fills = Array.isArray(node.fills) ? node.fills : [];
  return fills.length === 1 && fills[0].type === 'IMAGE';
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
  if (!isPlainImageComponent(node)) return null;
  const fill = imageFill(node);
  if (!fill) return null;
  const source = await imagePixelSize(fill);
  if (!source) return null;
  const record = savedMargins(node);
  const usable = !!record && planFits(source, record.current, record.overlap);
  return {
    component: node, fill, source,
    margins: usable ? record!.current : { left: 0, top: 0, right: 0, bottom: 0 },
    overlap: usable ? record!.overlap : false,
    record
  };
}
function rememberSlice(component: ComponentNode, margins: Margins, overlap: boolean, override: boolean,
  source?: Size): void {
  try {
    const existing = savedMargins(component);
    // Keep the project parameter that the atlas importer recorded so both
    // plugins read the same state; anything the designer changed is an override.
    const record = createNineSliceRecord(margins, { width: component.width, height: component.height },
      { project: existing?.project, overlap, override, source: source ?? existing?.source });
    writeNineSliceRecord(component, serializeNineSliceRecord(record));
  } catch (error) {
    console.error('保存九宫格信息失败', error);
  }
}
function editPayload(edit: EditableSlice, editable: boolean) {
  return { margins: edit.margins, overlap: edit.overlap, target: edit.target, name: edit.component.name, editable,
    legacy: edit.legacy, project: edit.record?.project, override: edit.record?.override ?? true,
    source: { width: edit.source.width, height: edit.source.height } };
}
function upgradePayload(upgrade: Upgradeable, editable: boolean) {
  return { margins: upgrade.margins, overlap: upgrade.overlap, target: 'upgrade', name: upgrade.component.name,
    editable, legacy: false, project: upgrade.record?.project, override: upgrade.record?.override ?? true,
    source: { width: upgrade.source.width, height: upgrade.source.height } };
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
    : node.type === 'INSTANCE' ? 'instance' : node.type === 'COMPONENT' ? 'component' : null;
  const fill = view?.fill ?? upgrade?.fill ?? (node && isImageNode(node) ? imageFill(node) : undefined);
  // A plain image main component is previewed and validated in original image
  // pixels, not at its current (possibly resized) canvas size.
  const width = view?.width ?? upgrade?.source.width ?? (node && 'width' in node ? node.width : 0);
  const height = view?.height ?? upgrade?.source.height ?? (node && 'height' in node ? node.height : 0);
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
    rememberSlice(component, { left: msg.left, top: msg.top, right: msg.right, bottom: msg.bottom }, msg.overlap, true);
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

/** Upgrade the selected plain image main component in place, keeping its identity and canvas size. */
async function upgradePlainComponent(upgrade: Upgradeable, msg: Settings): Promise<void> {
  const canvas: Size = { width: upgrade.component.width, height: upgrade.component.height };
  const margins: Margins = { left: msg.left, top: msg.top, right: msg.right, bottom: msg.bottom };
  if (!planFits(upgrade.source, margins, msg.overlap)) { notifyInvalidMargins('image'); return; }
  const scaled = canvasMargins(upgrade.source, canvas, margins);
  if (!planFits(canvas, scaled, msg.overlap)) { notifyInvalidMargins('canvas'); return; }
  generating = true;
  try {
    applyNineSliceComponent(figma, upgrade.component,
      { width: canvas.width, height: canvas.height, fill: upgrade.fill }, scaled, { overlap: msg.overlap });
    rememberSlice(upgrade.component, margins, msg.overlap, true, upgrade.source);
    figma.viewport.scrollAndZoomIntoView([upgrade.component]);
    notifyLocalized('已原位升级为九宫格组件；组件 ID、当前宽高、来源与实例关联均保留。',
      'Upgraded in place; component ID, current size, source record and instances stay intact.');
  } catch (error) {
    console.error('升级普通图片主组件失败', error);
    notifyLocalized('升级失败，原组件未被替换。请查看插件控制台。',
      'Upgrade failed; the original component was kept. Check the plugin console.', { error: true });
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
    createNineSlicePlan(edit.source, project, edit.record?.overlap);
    createNineSlicePlan({ width: edit.width, height: edit.height },
      canvasMargins(edit.source, { width: edit.width, height: edit.height }, project), edit.record?.overlap);
  } catch {
    notifyLocalized('项目参数无法应用到当前组件尺寸，未做修改。',
      'The project parameter does not fit the current component size. Nothing changed.', { error: true });
    return;
  }
  generating = true;
  try {
    applyNineSliceComponent(figma, edit.component, { width: edit.width, height: edit.height, fill: edit.fill },
      canvasMargins(edit.source, { width: edit.width, height: edit.height }, project), { overlap: edit.record?.overlap });
    rememberSlice(edit.component, project, edit.record?.overlap === true, false, edit.record?.source);
    void sendSelectionToUI();
    notifyLocalized('已恢复项目参数，并清除手动边距。', 'Project parameters restored; manual margins cleared.');
  } catch (error) {
    console.error('恢复项目参数失败', error);
    notifyLocalized('恢复失败，请查看插件控制台。', 'Restore failed. Check the plugin console.', { error: true });
  } finally {
    generating = false;
  }
}
function notifyUnsupported(): void {
  notifyLocalized('无法识别该组件：请选择本工具生成的九宫格主组件、资源导入器创建的普通图片主组件或普通图片图层。未做修改。',
    'Unrecognized component. Select a 9-slice main component created by this tool, an importer plain image main component, or an image layer. Nothing changed.',
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
    if (!planFits(edit.source, msg, msg.overlap)) { notifyInvalidMargins('image'); return; }
    const scaled = canvasMargins(edit.source, canvas, msg);
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
      rememberSlice(edit.component, margins, msg.overlap, override, edit.record?.source);
      figma.viewport.scrollAndZoomIntoView([edit.component]);
      notify('success');
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
      notifyUnsupported();
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
