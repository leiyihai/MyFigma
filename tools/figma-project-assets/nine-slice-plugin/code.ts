import { createNineSlicePlan } from '../packages/nine-slice/src/index';
import type { Margins } from '../packages/nine-slice/src/index';
import { applyNineSliceComponent, createNineSliceComponent } from '../packages/nine-slice/src/figma';

type Language = 'zh' | 'en' | 'ja' | 'ko' | 'ru' | 'de' | 'fr';
type Settings = {
  top: number; bottom: number; left: number; right: number; all: number;
  overlap: boolean; keepOriginal: boolean; batchMode: boolean;
  lang: Language | 'auto'; settingsVersion: number;
};
type PluginMessage = (Settings & { type: 'save-only' | 'generate' }) | { type: 'ui-ready' };
type ImageNode = SceneNode & GeometryMixin;
type SavedSlice = { schemaVersion: 1; margins: Margins; overlap: boolean; width: number; height: number };
type EditableSlice = { component: ComponentNode; margins: Margins; overlap: boolean; fill: ImagePaint; width: number; height: number; target: 'component' | 'instance' };
const NINE_SLICE_DATA = 'myfigma.nineSlice.v1';

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
function isLanguage(value: string): value is Language {
  return Object.prototype.hasOwnProperty.call(notifications, value);
}
function isImageNode(node: SceneNode): node is ImageNode {
  return 'fills' in node && Array.isArray(node.fills) && node.fills.some(fill => fill.type === 'IMAGE');
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
function savedMargins(component: ComponentNode): SavedSlice | undefined {
  try {
    const raw = component.getPluginData(NINE_SLICE_DATA);
    if (!raw) return undefined;
    const saved = JSON.parse(raw) as SavedSlice;
    return saved.schemaVersion === 1 && saved.margins ? saved : undefined;
  } catch {
    return undefined;
  }
}
function findEditable(node: SceneNode | undefined): EditableSlice | null {
  if (!node) return null;
  const component = node.type === 'COMPONENT' ? node : null;
  if (!component || !component.children.length || !component.children.every(isSliceNode)) return null;
  const fills = component.children.map(child => imageFill(child)).filter((fill): fill is ImagePaint => !!fill);
  if (!fills.length || new Set(fills.map(fill => fill.imageHash)).size !== 1) return null;
  const saved = savedMargins(component);
  const derived = deriveSlice(component);
  const margins = saved?.margins ?? derived.margins;
  const overlap = saved?.overlap ?? derived.overlap;
  try {
    createNineSlicePlan(component, margins, overlap);
  } catch {
    return null;
  }
  return { component, margins, overlap, fill: fills[0], width: component.width, height: component.height, target: 'component' };
}
function rememberSlice(component: ComponentNode, settings: Settings, overlap: boolean): void {
  const margins: Margins = { left: settings.left, top: settings.top, right: settings.right, bottom: settings.bottom };
  try {
    component.setPluginData(NINE_SLICE_DATA, JSON.stringify({ schemaVersion: 1, margins, overlap, width: component.width, height: component.height }));
  } catch (error) {
    console.error('保存九宫格信息失败', error);
  }
}
function editPayload(edit: EditableSlice, editable: boolean) {
  return { margins: edit.margins, overlap: edit.overlap, target: edit.target, name: edit.component.name, editable };
}

let previewVersion = 0;
async function sendSelectionToUI() {
  const version = ++previewVersion;
  const node = figma.currentPage.selection[0];
  const edit = findEditable(node);
  let instanceComponent: ComponentNode | null = null;
  if (node?.type === 'INSTANCE') {
    try {
      instanceComponent = await node.getMainComponentAsync();
    } catch (error) {
      console.error('读取实例主组件失败', error);
    }
  }
  if (version !== previewVersion) return;
  const instanceEdit = instanceComponent ? findEditable(instanceComponent) : null;
  const view = edit ?? instanceEdit;
  const payload = edit ? editPayload(edit, true) : instanceEdit ? editPayload(instanceEdit, false) : null;
  const fill = view?.fill ?? (node && isImageNode(node) ? imageFill(node) : undefined);
  const width = view?.width ?? (node && 'width' in node ? node.width : 0);
  const height = view?.height ?? (node && 'height' in node ? node.height : 0);
  try {
    const hash = fill?.imageHash;
    const image = hash ? figma.getImageByHash(hash) : null;
    if (image) {
      const bytes = await image.getBytesAsync();
      if (version === previewVersion) {
        figma.ui.postMessage({ type: 'update-preview', bytes, width, height, edit: payload });
      }
      return;
    }
  } catch (error) {
    console.error('读取图片预览失败', error);
  }
  if (version === previewVersion) figma.ui.postMessage({ type: 'update-preview', bytes: null, edit: payload });
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
    rememberSlice(component, msg, msg.overlap);
    return component;
  } catch (error) {
    component.remove();
    throw error;
  }
}

let generating = false;
figma.ui.onmessage = async (msg: PluginMessage) => {
  if (msg?.type === 'ui-ready') { void sendSelectionToUI(); return; }
  if (!msg || (msg.type !== 'save-only' && msg.type !== 'generate')) return;
  if (isLanguage(msg.lang)) currentLang = msg.lang;
  try {
    await figma.clientStorage.setAsync('nineSliceSettings', { ...msg, settingsVersion: 2 });
  } catch (error) {
    console.error('保存设置失败', error);
  }
  if (msg.type !== 'generate' || generating) return;
  const edit = findEditable(figma.currentPage.selection[0]);
  if (edit) {
    try {
      createNineSlicePlan({ width: edit.width, height: edit.height }, msg, msg.overlap);
    } catch {
      figma.notify(currentLang === 'zh'
        ? '边距必须为非负数，且左右之和小于宽度、上下之和小于高度。'
        : 'Margins must be non-negative; their sums must be smaller than the component width and height.', { error: true });
      return;
    }
    generating = true;
    try {
      applyNineSliceComponent(figma, edit.component, { width: edit.width, height: edit.height, fill: edit.fill }, msg, { overlap: msg.overlap });
      rememberSlice(edit.component, msg, msg.overlap);
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
  const targets = figma.currentPage.selection.filter(isImageNode);
  if (targets.length === 0) { notify('no_img'); return; }
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
