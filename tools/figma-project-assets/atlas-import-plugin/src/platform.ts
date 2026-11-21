import type { ImportPlan, ImportReport, LayoutUsage, Platform, Progress, PublicProject, Resource, Scan, Source, TidyResult } from './api';
import { Cancellation } from './api';
import { categoryIndex, classify, componentName, isCategoryName, type CategoryName } from './category';
import { createNineSlicePlan, type Margins } from '../../packages/nine-slice/src/index';
import { applyNineSliceComponent, createNineSliceComponent } from '../../packages/nine-slice/src/figma';
import {
  NINE_SLICE_RECORD_KEY, createNineSliceRecord, parseNineSliceRecord,
  readNineSliceRecord, writeNineSliceRecord, serializeNineSliceRecord, type NineSliceRecord
} from '../../packages/nine-slice/src/record';

const bindingKey = 'atlas.binding';
const sourceKey = 'atlas.source';
const syncKey = 'atlas.sync.v1';
const categoryKey = 'atlas.category';
const compareKey = 'atlas.compare';
const compareGroupKey = 'atlas.compare.group';
const compareItemKey = 'atlas.compare.item';
function pageName(project: PublicProject): string { return `${project.name}（${project.id}）- 分类资源`; }
function validate(page: PageNode, project: PublicProject) {
  let binding: {schemaVersion?:number;projectId?:string} | undefined;
  const raw = page.getPluginData(bindingKey);
  if(raw) {try {binding = JSON.parse(raw);} catch {return {valid:false,message:'页面绑定损坏，请使用新的空白页'};}}
  if(binding && (binding.schemaVersion !== 1 || binding.projectId !== project.id)) return {valid:false,message:'页面已绑定其他项目或不兼容版本'};
  if(binding && page.name !== pageName(project)) return {valid:false,message:'页面名称与绑定不符，请恢复为：'+pageName(project)};
  if(!binding && page.children.length) return {valid:false,message:'非空且未绑定页面不可导入，请选择空白页'};
  return {valid:true,message:binding ? '页面已绑定当前游戏，可增量更新' : '空白页可导入，将绑定当前游戏'};
}
function safeName(name: unknown): name is string {
  return typeof name === 'string' && name.length > 0 && name.length <= 256 && !/[\\:\x00-\x1f]/.test(name) && !name.startsWith('/') && !name.split('/').includes('..');
}
function int(n: unknown, max = 4096): n is number {return Number.isInteger(n) && Number(n) >= 0 && Number(n) <= max;}
// Scan scopes are recursive, so source paths carry `/` separators. Each segment
// must stay a plain name; the value never contains a local absolute path.
function relativePath(path: unknown): path is string {
  if(typeof path !== 'string' || path.length === 0 || path.length > 512 || /[\\:\x00-\x1f]/.test(path) || path.startsWith('/')) return false;
  return path.split('/').every(segment=>segment.length > 0 && segment.length <= 256 && segment !== '.' && segment !== '..');
}
function sourceFor(resource: Resource, project: PublicProject): Source {
  const s = resource.source;
  if(!s || s.schemaVersion !== 1 || s.projectId !== project.id || !relativePath(s.relativePath) || !safeName(s.frameName)) throw new Error('散图来源身份无效');
  let identity: string, engineReference: string;
  if(s.kind === 'atlas') {
    identity = JSON.stringify([project.id,'atlas',s.relativePath,s.frameName]);
    engineReference = `set:${s.relativePath} image:${s.frameName}`;
  } else if(s.kind === 'standalone') {
    if(!s.relativePath.toLowerCase().endsWith('.png')) throw new Error('散图来源身份无效');
    identity = JSON.stringify([project.id,'standalone',s.relativePath]);
    engineReference = `image:${s.relativePath}`;
  } else throw new Error('散图来源身份无效');
  if(s.identity !== identity || !int(resource.width) || !int(resource.height) || !resource.width || !resource.height || !s.crop || !s.offset || !s.sourceSize || s.sourceSize.w !== resource.width || s.sourceSize.h !== resource.height || !Object.values(s.crop).every(n=>int(n)) || !int(s.crop.x) || !int(s.crop.y) || !int(s.crop.w) || !int(s.crop.h) || !s.crop.w || !s.crop.h || !int(s.offset.x) || !int(s.offset.y) || s.offset.x+s.crop.w>resource.width || s.offset.y+s.crop.h>resource.height || typeof resource.png !== 'string' || resource.png.length > 64*1024*1024) throw new Error('散图尺寸或来源数据无效');
  if(s.kind === 'standalone' && (s.crop.x !== 0 || s.crop.y !== 0 || s.crop.w !== resource.width || s.crop.h !== resource.height || s.offset.x !== 0 || s.offset.y !== 0)) throw new Error('散图尺寸或来源数据无效');
  // Deliberate whitelist: no local paths, credentials or unknown helper fields enter the document.
  return {schemaVersion:1,projectId:project.id,kind:s.kind,relativePath:s.relativePath,frameName:s.frameName,identity,
    engineReference,sourceSize:{w:resource.width,h:resource.height},
    crop:{x:s.crop.x,y:s.crop.y,w:s.crop.w,h:s.crop.h},offset:{x:s.offset.x,y:s.offset.y}};
}
function marginsValue(value: unknown): Margins | undefined {
  if(!value || typeof value !== 'object') return undefined;
  const m = value as Partial<Margins>;
  if(![m.left,m.top,m.right,m.bottom].every(item=>typeof item === 'number' && Number.isFinite(item) && item >= 0)) return undefined;
  return {left:m.left!,top:m.top!,right:m.right!,bottom:m.bottom!};
}
function layoutFor(resource: Resource) {
  if(resource.layout === undefined) return undefined;
  const layout = resource.layout;
  if(!layout || !Number.isInteger(layout.references) || layout.references < 0 || layout.references > 1_000_000) throw new Error('扫描布局引用数据无效');
  if(layout.nineSlice === undefined) return {references: layout.references};
  const margins = marginsValue(layout.nineSlice.margins);
  if(!margins || !Number.isInteger(layout.nineSlice.usage) || layout.nineSlice.usage <= 0) throw new Error('扫描九宫格参数无效');
  try { createNineSlicePlan({width:resource.width,height:resource.height}, margins); }
  catch { throw new Error('扫描九宫格参数无法应用到图片尺寸'); }
  return {references: layout.references, nineSlice: {margins, usage: layout.nineSlice.usage}};
}
function validFor(margins: Margins, width: number, height: number): boolean {
  try { createNineSlicePlan({width,height}, margins); return true; } catch { return false; }
}
type SyncState = {
  schemaVersion: 1; identity: string; contentHash: string; imageHash?: string;
  sourceSize: { w: number; h: number }; status: 'current' | 'source-missing';
};
type ComponentShape = 'image' | 'slices';
type Existing = {
  component: ComponentNode; source: Source; sync?: SyncState; blocked?: string;
  record?: NineSliceRecord; shape?: ComponentShape; imageHash?: string;
};
type Planned = {
  shape: ComponentShape; margins?: Margins; project?: Margins; override: boolean;
  overlap: boolean; record?: NineSliceRecord; blocked?: string;
};
type Candidate = { resource: Resource; source: Source; hash: string; layout?: LayoutUsage; existing?: Existing; planned: Planned };
type PlanState = {
  plan: ImportPlan; adds: Candidate[]; updates: Candidate[]; removals: Existing[];
};
function parseStoredSource(component: ComponentNode, project: PublicProject): Source | undefined {
  const raw = component.getPluginData(sourceKey);
  if(!raw) return undefined;
  try {
    const s = JSON.parse(raw) as Partial<Source>;
    if(s.schemaVersion !== 1 || s.projectId !== project.id || (s.kind !== 'atlas' && s.kind !== 'standalone') ||
       !relativePath(s.relativePath) || !safeName(s.frameName) || typeof s.identity !== 'string') return undefined;
    if(s.kind === 'atlas' && s.identity !== JSON.stringify([project.id,'atlas',s.relativePath,s.frameName])) return undefined;
    if(s.kind === 'standalone' && (!s.relativePath.toLowerCase().endsWith('.png') || s.identity !== JSON.stringify([project.id,'standalone',s.relativePath]))) return undefined;
    return s as Source;
  } catch { return undefined; }
}
function parseSync(component: ComponentNode, identity: string): SyncState | undefined {
  try {
    const sync = JSON.parse(component.getPluginData(syncKey)) as SyncState;
    return sync && sync.schemaVersion === 1 && sync.identity === identity &&
      typeof sync.contentHash === 'string' && sync.sourceSize && int(sync.sourceSize.w) && int(sync.sourceSize.h) &&
      (sync.status === 'current' || sync.status === 'source-missing') ? sync : undefined;
  } catch { return undefined; }
}
function hashText(value: string): string {
  // Stable, dependency-free content fingerprint. This is change detection, not
  // a cryptographic signature; dimensions and source metadata are included.
  let fnv = 2166136261, djb2 = 5381;
  for(let i=0;i<value.length;i++) {
    const code = value.charCodeAt(i);
    fnv = Math.imul(fnv ^ code, 16777619) >>> 0;
    djb2 = ((djb2 << 5) + djb2 + code) >>> 0;
  }
  return `${value.length}:${fnv.toString(16)}:${djb2.toString(16)}`;
}
function contentHash(resource: Resource, source: Source): string {
  return hashText(resource.png + '|' + resource.width + 'x' + resource.height + '|' +
    JSON.stringify([source.kind, source.relativePath, source.frameName, source.crop, source.offset]));
}
function imageFillOf(node: ComponentNode, shape: ComponentShape | undefined): ImagePaint | undefined {
  const fills = Array.isArray(node.fills) ? node.fills : [];
  if(shape === 'image') return fills.find((fill): fill is ImagePaint => fill.type === 'IMAGE');
  for(const child of node.children) {
    if(!('fills' in child) || !Array.isArray(child.fills)) continue;
    const fill = child.fills.find((item): item is ImagePaint => item.type === 'IMAGE');
    if(fill) return fill;
  }
  return undefined;
}
function verifyNineSlice(component: ComponentNode, record: NineSliceRecord): boolean {
  if(component.layoutMode !== 'NONE') return false;
  if(!Array.isArray(component.fills) || component.fills.length !== 0) return false;
  let plan;
  try { plan = createNineSlicePlan({width:component.width,height:component.height}, record.current, record.overlap); }
  catch { return false; }
  if(component.children.length !== plan.slices.length) return false;
  const expected = new Map(plan.slices.map(slice => [`切片 ${slice.row + 1}-${slice.column + 1}`, slice]));
  const seen = new Set<string>();
  let imageHash: string | undefined;
  for(const child of component.children) {
    if(child.type !== 'RECTANGLE' || !expected.has(child.name) || seen.has(child.name)) return false;
    seen.add(child.name);
    const slice = expected.get(child.name)!;
    if(Math.abs(child.x - slice.x) > 0.001 || Math.abs(child.y - slice.y) > 0.001 ||
       Math.abs(child.width - slice.width) > 0.001 || Math.abs(child.height - slice.height) > 0.001) return false;
    if(child.constraints.horizontal !== slice.horizontal || child.constraints.vertical !== slice.vertical) return false;
    if(!Array.isArray(child.fills) || child.fills.length !== 1) return false;
    const fill = child.fills[0];
    if(fill.type !== 'IMAGE' || fill.scaleMode !== 'CROP') return false;
    if(imageHash === undefined) imageHash = fill.imageHash;
    else if(fill.imageHash !== imageHash) return false;
  }
  return seen.size === expected.size;
}
function storedRecord(component: ComponentNode): {record?: NineSliceRecord; corrupt: boolean} {
  const raw = readNineSliceRecord(component);
  if(!raw) return {corrupt:false};
  const record = parseNineSliceRecord(raw);
  // Migrate records written before the shared-data change. Private plugin data
  // is scoped to this importer's plugin ID, so the nine-slice plugin cannot read
  // it until the same raw value is copied into shared plugin data.
  if(record) writeNineSliceRecord(component, raw);
  return {record, corrupt:!record};
}
// Category frames are tool-managed page children. New frames store the category
// name in `atlas.category`; `unsorted` is the legacy #3 marker for 未分类.
const categoryGap = 48;
function frameCategory(node: FrameNode): CategoryName | undefined {
  const raw = node.getPluginData(categoryKey);
  if(raw === 'unsorted') return '未分类';
  if(isCategoryName(raw)) return raw;
  // Legacy #3 frames carry no marker; their managed children identify them.
  if(node.name === '未分类' && Array.isArray(node.children) && node.children.some(child => child.getPluginData(sourceKey))) return '未分类';
  return undefined;
}
function managedCategoryFrames(page: PageNode): FrameNode[] {
  return page.children.filter((node): node is FrameNode => node.type === 'FRAME' && !!frameCategory(node as FrameNode));
}
function managedCategory(node: ComponentNode): boolean {
  const parent = node.parent;
  return !!parent && parent.type === 'FRAME' && !!frameCategory(parent as FrameNode);
}
// Category frames are tool-owned, but users may drop unrelated components into
// them. Only components carrying tool records (or children of legacy frames) can
// have a damaged source record; plain user components are left alone.
function carriesToolRecord(node: ComponentNode): boolean {
  return Boolean(node.getPluginData(sourceKey) || node.getPluginData(syncKey) ||
    readNineSliceRecord(node));
}
function legacyManagedParent(node: ComponentNode): boolean {
  const parent = node.parent;
  return !!parent && parent.type === 'FRAME' && !parent.getPluginData(categoryKey) &&
    parent.name === '未分类' && !!frameCategory(parent as FrameNode);
}
// If every tool record was cleared, the derived display name is the remaining
// evidence that this was a managed component; a plain user name is not flagged.
function looksManagedName(node: ComponentNode): boolean {
  const separator = node.name.indexOf('/');
  return separator > 0 && isCategoryName(node.name.slice(0,separator));
}
function findCategoryFrame(page: PageNode, category: CategoryName): FrameNode | undefined {
  return managedCategoryFrames(page).find(frame => frameCategory(frame) === category);
}
function nextCategoryFrameY(page: PageNode): number {
  const frames = managedCategoryFrames(page);
  if(!frames.length) return 0;
  return Math.max(...frames.map(frame => frame.y + frame.height)) + categoryGap;
}
function createCategoryFrame(page: PageNode, api: Pick<PluginAPI,'createFrame'>, category: CategoryName): FrameNode {
  const y = nextCategoryFrameY(page);
  const frame = api.createFrame();
  page.appendChild(frame);
  frame.name = category;
  frame.fills = [];
  frame.resize(1200,100); frame.layoutMode = 'HORIZONTAL'; frame.layoutWrap = 'WRAP';
  frame.primaryAxisSizingMode = 'FIXED'; frame.counterAxisSizingMode = 'AUTO';
  frame.itemSpacing = 16; frame.counterAxisSpacing = 16;
  frame.paddingTop = frame.paddingRight = frame.paddingBottom = frame.paddingLeft = 16;
  frame.setPluginData(categoryKey, category);
  // New frames are placed below the existing ones; normal imports never reflow
  // existing frame positions, only 重新整理 does.
  frame.x = 0; frame.y = y;
  return frame;
}
function ensureCategoryFrame(page: PageNode, api: Pick<PluginAPI,'createFrame'>, category: CategoryName,
  created: FrameNode[]): FrameNode {
  const found = findCategoryFrame(page, category);
  if(found) return found;
  const frame = createCategoryFrame(page, api, category);
  created.push(frame);
  return frame;
}
function plannedCategory(item: Candidate): CategoryName {
  return classify({frameName:item.source.frameName,width:item.resource.width,height:item.resource.height,
    nineSlice:item.planned.shape === 'slices'});
}
function existingComponents(page: PageNode, project: PublicProject): { items: Existing[]; corrupt: string[] } {
  const result: Existing[] = [], corrupt: string[] = [];
  for(const node of page.findAll(() => true)) {
    if(node.type !== 'COMPONENT') continue;
    const source = parseStoredSource(node, project);
    if(!source) {
      if(carriesToolRecord(node) || (managedCategory(node) &&
         (legacyManagedParent(node) || looksManagedName(node)))) corrupt.push(node.name);
      continue;
    }
    const sync = parseSync(node,source.identity);
    const stored = storedRecord(node);
    const fills = Array.isArray(node.fills) ? node.fills : [];
    let shape: ComponentShape | undefined;
    let blocked: string | undefined;
    if(stored.corrupt) blocked = '九宫格记录损坏，已跳过';
    else if(node.children.length === 0) {
      if(stored.record) blocked = '九宫格记录与组件结构不符，已跳过';
      else if(fills.length === 1 && fills[0].type === 'IMAGE') {
        shape = 'image';
        if(sync?.imageHash && fills[0].imageHash && sync.imageHash !== fills[0].imageHash) blocked = '图片填充已被手动修改，已跳过';
        else if(sync && fills[0].scaleMode !== 'FILL') blocked = '图片填充缩放方式已被手动修改，已跳过';
      } else blocked = '内部结构已修改或不是普通图片组件，已跳过';
    } else {
      if(!stored.record) blocked = '内部结构已修改或不是普通图片组件，已跳过';
      else if(!verifyNineSlice(node, stored.record)) blocked = '内部结构已修改或不是普通图片组件，已跳过';
      else shape = 'slices';
    }
    const imageHash = imageFillOf(node, shape)?.imageHash || undefined;
    if(!blocked && shape === 'slices' && sync?.imageHash && imageHash && sync.imageHash !== imageHash)
      blocked = '图片填充已被手动修改，已跳过';
    result.push({component:node,source,sync,blocked,record:stored.record,shape,imageHash});
  }
  return {items:result,corrupt};
}
function planState(existing: Existing | undefined, item: Candidate): Planned {
  const project = item.layout?.nineSlice?.margins;
  const record = existing?.record;
  const width = item.resource.width, height = item.resource.height;
  if(record?.override) {
    if(!validFor(record.current,width,height)) {
      // Never clamp a designer's margins; explain how to recover and retry instead.
      const hint = project || record.project ? '；可在九宫格插件恢复项目参数后重试' : '';
      return {
        shape:'slices', override:true, overlap:record.overlap,
        blocked:`人工九宫格边距无法应用到新尺寸 ${width}×${height}，已跳过${hint}`
      };
    }
    const effectiveProject = project || record.project;
    return {shape:'slices', margins:record.current, project:effectiveProject, override:true, overlap:record.overlap,
      record:createNineSliceRecord(record.current,{width,height},{project:effectiveProject,overlap:record.overlap,override:true})};
  }
  if(project) {
    if(!validFor(project,width,height)) return {
      shape:'slices', override:false, overlap:record?.overlap === true,
      blocked:`项目九宫格边距无法应用到 ${width}×${height}，已跳过`
    };
    return {shape:'slices', margins:project, project, override:false, overlap:record?.overlap === true,
      record:createNineSliceRecord(project,{width,height},{project,overlap:record?.overlap === true,override:false})};
  }
  if(existing?.shape === 'slices' && record) {
    // Usage disappeared: keep the existing stretch behavior instead of downgrading.
    if(!validFor(record.current,width,height)) return {
      shape:'slices', override:record.override, overlap:record.overlap,
      blocked:`九宫格边距无法应用到新尺寸 ${width}×${height}，已跳过`
    };
    return {shape:'slices', margins:record.current, project:record.project, override:record.override, overlap:record.overlap,
      record:createNineSliceRecord(record.current,{width,height},{project:record.project,overlap:record.overlap,override:record.override})};
  }
  return {shape:'image', override:false, overlap:false};
}
function sameMargins(left: Margins | undefined, right: Margins | undefined): boolean {
  if(!left || !right) return left === right;
  return left.left === right.left && left.top === right.top && left.right === right.right && left.bottom === right.bottom;
}
function isUnchanged(existing: Existing, item: Candidate, planned: Planned): boolean {
  if(!existing.sync || existing.sync.status !== 'current' || existing.sync.contentHash !== item.hash ||
     existing.sync.sourceSize.w !== item.resource.width || existing.sync.sourceSize.h !== item.resource.height ||
     existing.component.width !== item.resource.width || existing.component.height !== item.resource.height) return false;
  if(existing.shape !== planned.shape) return false;
  if(planned.shape === 'image') return true;
  const record = existing.record;
  return !!record && sameMargins(record.current, planned.margins) && record.overlap === planned.overlap &&
    record.override === planned.override && sameMargins(record.project, planned.project);
}
function buildPlan(scan: Scan, page: PageNode): PlanState {
  if(scan.schemaVersion !== 3 || !scan.project || !/^[a-zA-Z0-9_-]{1,64}$/.test(scan.project.id) ||
     typeof scan.project.name !== 'string' || !scan.project.name.trim() || scan.project.name.length > 200 ||
     !Array.isArray(scan.resources) || scan.resources.length > 20000 || typeof scan.complete !== 'boolean' ||
     !Array.isArray(scan.warnings ?? []) || (scan.warnings || []).some(message => typeof message !== 'string' || message.length > 2000)) throw new Error('扫描协议版本不兼容');
  const plan: ImportPlan = {schemaVersion:1,added:0,updated:0,removed:0,unchanged:0,blocked:0,removalSuppressed:false,messages:[]};
  const messages = new Set<string>();
  for(const warning of (scan.warnings || []).slice(0, 50)) messages.add(warning);
  const parsed = existingComponents(page, scan.project);
  if(parsed.corrupt.length) throw new Error('存在来源记录损坏的组件，已停止增量导入；请修复或移除后重试：' + parsed.corrupt.join('、'));
  const existing = parsed.items;
  const groups = new Map<string, Existing[]>();
  for(const item of existing) {
    if(!item.source.identity) continue;
    const group = groups.get(item.source.identity) || [];
    group.push(item); groups.set(item.source.identity, group);
  }
  for(const group of groups.values()) {
    if(group.length > 1) for(const item of group) {
      item.blocked = '存在重复来源组件，已跳过';
      messages.add(`${item.component.name}：${item.blocked}`);
    }
  }
  const scanItems = new Map<string, Candidate>();
  for(const resource of scan.resources) {
    const source = sourceFor(resource, scan.project);
    const layout = layoutFor(resource);
    if(scanItems.has(source.identity)) throw new Error('扫描包含重复资源身份');
    const item: Candidate = {resource,source,hash:contentHash(resource,source),
      planned:{shape:'image',override:false,overlap:false}};
    if(layout) item.layout = layout;
    scanItems.set(source.identity,item);
    const group = groups.get(source.identity);
    if(group && group.length === 1 && !group[0].blocked) item.existing = group[0];
  }
  for(const item of scanItems.values()) {
    const group = groups.get(item.source.identity);
    if(!group) {
      item.planned = planState(undefined,item);
      plan.added++;
      continue;
    }
    const target = group[0];
    if(target.blocked || group.length !== 1) {
      item.planned = {shape:'image',override:false,overlap:false};
      plan.blocked++;
      messages.add(`${target.component.name}：${target.blocked || '存在重复来源组件，已跳过'}`);
      continue;
    }
    item.planned = planState(target,item);
    if(item.planned.blocked) {
      plan.blocked++;
      messages.add(`${target.component.name}：${item.planned.blocked}`);
      continue;
    }
    if(isUnchanged(target,item,item.planned)) plan.unchanged++;
    else {
      plan.updated++;
      if(!target.sync) messages.add(`${target.component.name}：旧版组件缺少同步记录，本次将按扫描结果更新`);
    }
  }
  for(const [identity, group] of groups) {
    if(scanItems.has(identity)) continue;
    const target = group[0];
    if(target.blocked || group.length !== 1) {
      plan.blocked++;
      messages.add(`${target.component.name}：${target.blocked || '存在重复来源组件，已跳过'}`);
      continue;
    }
    if(!scan.complete) { plan.removalSuppressed = true; continue; }
    plan.removed++;
  }
  plan.messages = [...messages];
  return {
    plan,
    adds: [...scanItems.values()].filter(item => !groups.has(item.source.identity)),
    updates: [...scanItems.values()].filter(item => {
      const group = groups.get(item.source.identity);
      return !!group && group.length === 1 && !group[0].blocked && !item.planned.blocked && !isUnchanged(group[0], item, item.planned);
    }),
    removals: [...groups.values()].filter(group => group.length === 1 && !group[0].blocked &&
      !scanItems.has(group[0].source.identity) && scan.complete).map(group => group[0])
  };
}
function orderedCategoryFrames(page: PageNode): FrameNode[] {
  const index = new Map<SceneNode, number>();
  page.children.forEach((node, position) => index.set(node, position));
  // Canonical category order is the layout contract; duplicates of one category
  // stay stacked in their previous visual/page order to keep the move minimal.
  return [...managedCategoryFrames(page)].sort((left, right) => {
    const category = categoryIndex(frameCategory(left)!) - categoryIndex(frameCategory(right)!);
    if(category) return category;
    if(left.y !== right.y) return left.y - right.y;
    if(left.x !== right.x) return left.x - right.x;
    return (index.get(left) || 0) - (index.get(right) || 0);
  });
}
// 重新整理 only touches category frame coordinates. Components, their source
// records, instance links and nine-slice child constraints stay untouched.
function tidyCategoryFrames(page: PageNode): TidyResult {
  const frames = orderedCategoryFrames(page);
  if(!frames.length) return {schemaVersion:1,frames:0,moved:0,
    messages:['当前页没有本工具创建的分类 Frame，无需整理']};
  let y = 0, moved = 0;
  for(const frame of frames) {
    if(frame.x !== 0 || frame.y !== y) {
      frame.x = 0; frame.y = y;
      moved++;
    }
    y += (frame.height || 0) + categoryGap;
  }
  return {schemaVersion:1,frames:frames.length,moved,messages:[]};
}
// Display names are derived, never part of the resource identity. Same-name
// components in one category add their source location so both stay unique.
function refreshDisplayNames(page: PageNode, project: PublicProject, messages: string[]): void {
  const groups = new Map<string, Array<{component: ComponentNode; source: Source; category: CategoryName}>>();
  for(const frame of managedCategoryFrames(page)) {
    const category = frameCategory(frame);
    if(!category) continue;
    for(const child of frame.children) {
      if(child.type !== 'COMPONENT') continue;
      const source = parseStoredSource(child, project);
      if(!source) continue;
      const key = category + '\u0000' + source.frameName;
      const group = groups.get(key) || [];
      group.push({component:child,source,category});
      groups.set(key,group);
    }
  }
  for(const group of groups.values()) {
    group.sort((left,right) => left.source.identity < right.source.identity ? -1 : left.source.identity > right.source.identity ? 1 : 0);
    const used = new Set<string>();
    group.forEach((entry,index) => {
      let name = componentName(entry.category,entry.source.frameName,
        group.length > 1 ? entry.source.relativePath : undefined);
      if(used.has(name)) name = `${name} #${index + 1}`;
      used.add(name);
      if(entry.component.name === name) return;
      try { entry.component.name = name; }
      catch { messages.push(`${name}：显示名更新失败`); }
    });
  }
}
function writeSync(component: ComponentNode, item: Candidate, imageHash: string): void {
  const sync: SyncState = {schemaVersion:1,identity:item.source.identity,contentHash:item.hash,imageHash,
    sourceSize:{w:item.resource.width,h:item.resource.height},status:'current'};
  component.setPluginData(syncKey,JSON.stringify(sync));
}
function writeRecord(component: ComponentNode, planned: Planned): void {
  if(planned.record) writeNineSliceRecord(component, serializeNineSliceRecord(planned.record));
  else if(readNineSliceRecord(component)) writeNineSliceRecord(component, '');
}
function markMissing(existing: Existing): void {
  const sync: SyncState = existing.sync || {schemaVersion:1,identity:existing.source.identity,contentHash:'',
    sourceSize:{w:existing.component.width,h:existing.component.height},status:'current'};
  existing.component.setPluginData(syncKey,JSON.stringify({...sync,status:'source-missing'}));
}
type InstanceSize = { mainId: string; width: number; height: number; node: InstanceNode };
async function snapshotInstances(page: PageNode): Promise<InstanceSize[]> {
  if(typeof page.findAll !== 'function') return [];
  const result: InstanceSize[] = [];
  for(const node of page.findAll(candidate => candidate.type === 'INSTANCE') as InstanceNode[]) {
    try {
      const main = await node.getMainComponentAsync();
      if(main) result.push({mainId:main.id,width:node.width,height:node.height,node});
    } catch { /* a detached or inaccessible instance is not a reason to fail the import */ }
  }
  return result;
}
function restoreInstances(sizes: InstanceSize[], mainIds: Set<string>): void {
  for(const item of sizes) {
    if(!mainIds.has(item.mainId)) continue;
    try { if(item.node.width !== item.width || item.node.height !== item.height) item.node.resize(item.width,item.height); }
    catch { /* an auto-layout parent may own the instance size */ }
  }
}
type UpdateSnapshot = {
  component: ComponentNode; width: number; height: number; fills: Paint[]; imageFill?: ImagePaint;
  source: string; sync: string; record: string; shape?: ComponentShape; parsedRecord?: NineSliceRecord;
};
function snapshot(component: ComponentNode, existing: Existing): UpdateSnapshot {
  return {
    component, width:component.width, height:component.height,
    fills:Array.isArray(component.fills) ? [...component.fills] : [],
    imageFill:imageFillOf(component, existing.shape),
    source:component.getPluginData(sourceKey), sync:component.getPluginData(syncKey),
    record:readNineSliceRecord(component),
    shape:existing.shape, parsedRecord:existing.record
  };
}
function restoreSnapshot(api: Pick<PluginAPI,'createRectangle'>, snap: UpdateSnapshot): void {
  try {
    for(const child of [...snap.component.children]) child.remove();
    snap.component.resize(snap.width,snap.height);
    snap.component.fills = snap.fills;
    snap.component.setPluginData(sourceKey,snap.source);
    snap.component.setPluginData(syncKey,snap.sync);
    writeNineSliceRecord(snap.component,snap.record);
    if(snap.shape === 'slices' && snap.parsedRecord && snap.imageFill) {
      applyNineSliceComponent(api,snap.component,
        {width:snap.width,height:snap.height,fill:snap.imageFill},snap.parsedRecord.current,
        {overlap:snap.parsedRecord.overlap});
    }
  } catch { /* rollback is best effort; never hide the original import failure */ }
}
function applyComponent(api: Pick<PluginAPI,'createRectangle'>, component: ComponentNode, item: Candidate, image: ImagePaint): void {
  const planned = item.planned;
  if(planned.shape === 'slices' && planned.margins) {
    applyNineSliceComponent(api,component,
      {width:item.resource.width,height:item.resource.height,fill:image},planned.margins,
      {overlap:planned.overlap});
  } else {
    component.resize(item.resource.width,item.resource.height);
    component.fills = [{...image,scaleMode:'FILL'}];
  }
  component.setPluginData(sourceKey,JSON.stringify(item.source));
  writeSync(component,item,image.imageHash || '');
  writeRecord(component,planned);
}
function createComponent(api: Pick<PluginAPI,'createComponent'|'createRectangle'>, target: FrameNode, item: Candidate,
  image: ImagePaint, category: CategoryName): ComponentNode {
  const planned = item.planned;
  const component = planned.shape === 'slices' && planned.margins
    ? createNineSliceComponent(api,{width:item.resource.width,height:item.resource.height,fill:image},
        planned.margins,{overlap:planned.overlap})
    : api.createComponent();
  target.appendChild(component);
  try {
    component.name = componentName(category,item.source.frameName);
    if(planned.shape !== 'slices' || !planned.margins) {
      component.resize(item.resource.width,item.resource.height);
      component.fills = [{...image,scaleMode:'FILL'}];
    }
    component.setPluginData(sourceKey,JSON.stringify(item.source));
    writeSync(component,item,image.imageHash || '');
    writeRecord(component,planned);
    return component;
  } catch(error) {
    // A half-created component must not stay behind looking successful.
    component.remove();
    throw error;
  }
}
function describeCandidate(item: Candidate, category: CategoryName): string {
  return componentName(category,item.source.frameName);
}
async function loadPage(page: PageNode): Promise<void> {
  // dynamic-page documents require explicit loading before findAll().
  if(typeof page.loadAsync === 'function') await page.loadAsync();
}
type CompareBinding = { schemaVersion: 1; projectId: string };
type CompareItem = { identity: string; key: string; name: string; component: ComponentNode };
function comparePageName(project: PublicProject): string { return `${project.name}（${project.id}）- 图集对照`; }
function parseCompareBinding(raw: string): CompareBinding | undefined {
  try {
    const value = JSON.parse(raw) as Partial<CompareBinding> | null;
    return value && value.schemaVersion === 1 && typeof value.projectId === 'string' && /^[a-zA-Z0-9_-]{1,64}$/.test(value.projectId)
      ? {schemaVersion:1,projectId:value.projectId} : undefined;
  } catch { return undefined; }
}
async function managedComparePage(root: DocumentNode, project: PublicProject): Promise<PageNode | undefined> {
  // A page is ours only through its binding; display names never grant ownership.
  let corrupt: string | undefined;
  for(const node of root.children) {
    if(node.type !== 'PAGE') continue;
    await loadPage(node);
    const raw = node.getPluginData(compareKey);
    if(!raw) continue;
    const binding = parseCompareBinding(raw);
    if(!binding) { corrupt = corrupt || node.name; continue; }
    if(binding.projectId === project.id) return node;
  }
  if(corrupt) throw new Error(`对照页「${corrupt}」的绑定已损坏，请删除或修复后重试`);
  return undefined;
}
function createComparePage(root: DocumentNode, project: PublicProject, api: Pick<PluginAPI,'createPage'>): PageNode {
  const page = api.createPage();
  const wanted = comparePageName(project);
  // Figma allows duplicate page names, but a tool suffix keeps an unbound user
  // page visibly separate instead of implying we took it over.
  const taken = root.children.some(node => node.type === 'PAGE' && node.name === wanted);
  page.name = taken ? `${wanted}（工具创建）` : wanted;
  page.setPluginData(compareKey, JSON.stringify({schemaVersion:1,projectId:project.id}));
  return page;
}
async function resourcePages(root: DocumentNode, project: PublicProject): Promise<PageNode[]> {
  const pages: PageNode[] = [];
  for(const node of root.children) {
    if(node.type !== 'PAGE') continue;
    await loadPage(node);
    const raw = node.getPluginData(bindingKey);
    if(!raw) continue;
    try {
      const binding = JSON.parse(raw) as {schemaVersion?:number;projectId?:string};
      if(binding && binding.schemaVersion === 1 && binding.projectId === project.id) pages.push(node);
    } catch { /* import guards report damaged bindings; comparison only reads valid ones */ }
  }
  return pages;
}
async function projectComponents(root: DocumentNode, project: PublicProject): Promise<Existing[]> {
  // Sources live on main components; the comparison page itself is never a data source.
  const result = new Map<string, Existing>();
  for(const page of await resourcePages(root, project)) {
    await loadPage(page);
    const parsed = existingComponents(page, project);
    if(parsed.corrupt.length) throw new Error('存在来源记录损坏的组件，已停止生成对照页；请修复或移除后重试：' + parsed.corrupt.join('、'));
    for(const item of parsed.items) {
      if(!item.source.identity) continue;
      const known = result.get(item.source.identity);
      if(!known || (known.blocked && !item.blocked)) result.set(item.source.identity, item);
    }
  }
  return [...result.values()];
}
function compareItems(existing: Existing[]): Map<string, CompareItem> {
  const items = new Map<string, CompareItem>();
  for(const item of existing) {
    if(items.has(item.source.identity)) continue;
    const atlas = item.source.kind === 'atlas';
    items.set(item.source.identity, {
      identity: item.source.identity,
      // Group by the recorded source atlas, not by display name or category frame.
      key: atlas ? `atlas:${item.source.relativePath}` : 'standalone',
      name: atlas ? `图集：${item.source.relativePath}` : '独立图片',
      component: item.component
    });
  }
  return items;
}
function existingCompareInstances(page: PageNode): Map<string, InstanceNode[]> {
  const found = new Map<string, InstanceNode[]>();
  for(const node of page.findAll(candidate => candidate.type === 'INSTANCE') as InstanceNode[]) {
    const identity = node.getPluginData(compareItemKey);
    if(!identity) continue;
    const list = found.get(identity) || [];
    list.push(node); found.set(identity, list);
  }
  return found;
}
type CompareCounts = { added: number; removed: number; kept: number; groups: number; messages: string[] };
function syncComparePage(page: PageNode, items: Map<string, CompareItem>, api: Pick<PluginAPI,'createFrame'>,
  created: { instances: InstanceNode[]; frames: FrameNode[] }): CompareCounts {
  const messages: string[] = [];
  const existing = existingCompareInstances(page);
  let removed = 0, kept = 0, added = 0;
  // Keep one instance per source identity; stale or duplicated tool instances go away.
  for(const [identity, instances] of existing) {
    const keep = items.has(identity) ? instances[0] : undefined;
    for(const instance of instances) {
      if(instance === keep) continue;
      instance.remove(); removed++;
    }
    if(keep) kept++;
  }
  const keys = [...new Set([...items.values()].map(item => item.key))].sort();
  const names = new Map<string, string>();
  for(const item of items.values()) names.set(item.key, item.name);
  for(const node of [...page.children]) {
    if(node.type !== 'FRAME') continue;
    const key = node.getPluginData(compareGroupKey);
    if(!key || keys.includes(key)) continue;
    if(node.children.length === 0) { node.remove(); continue; }
    messages.push(`对照页分组「${node.name}」仍有用户内容，已保留`);
  }
  const frames = new Map<string, FrameNode>();
  for(const key of keys) {
    let frame = page.children.find(node => node.type === 'FRAME' && node.getPluginData(compareGroupKey) === key) as FrameNode | undefined;
    if(!frame) {
      frame = api.createFrame();
      page.appendChild(frame);
      frame.name = names.get(key) || key;
      frame.fills = [];
      frame.resize(1200,100); frame.layoutMode = 'HORIZONTAL'; frame.layoutWrap = 'WRAP';
      frame.primaryAxisSizingMode = 'FIXED'; frame.counterAxisSizingMode = 'AUTO';
      frame.itemSpacing = 16; frame.counterAxisSpacing = 16;
      frame.paddingTop = frame.paddingRight = frame.paddingBottom = frame.paddingLeft = 16;
      frame.setPluginData(compareGroupKey, key);
      created.frames.push(frame);
    }
    frames.set(key, frame);
  }
  for(const [identity, item] of items) {
    const frame = frames.get(item.key)!;
    const instance = existing.get(identity)?.[0];
    if(instance) {
      if(instance.parent !== frame) frame.appendChild(instance);
      continue;
    }
    const copy = item.component.createInstance();
    frame.appendChild(copy);
    copy.setPluginData(compareItemKey, identity);
    created.instances.push(copy);
    added++;
  }
  // Stack group frames top to bottom after their contents define the height.
  let y = 0;
  for(const key of keys) {
    const frame = frames.get(key)!;
    frame.x = 0; frame.y = y;
    y += (frame.height || 0) + 24;
  }
  return {added, removed, kept, groups: keys.length, messages};
}
export function createFigmaPlatform(api: Pick<PluginAPI,'currentPage'|'root'|'createPage'|'createFrame'|'createComponent'|'createRectangle'|'createImage'|'base64Decode'>): Platform {
  let busy = false;
  return {
    async validate(project) {const page = api.currentPage; await loadPage(page); return validate(page,project);},
    async preview(scan) {
      if(busy) throw new Error('导入任务正在执行');
      const page = api.currentPage;
      await loadPage(page);
      return buildPlan(scan,page).plan;
    },
    async importResources(scan, progress, cancellation = new Cancellation()) {
      if(busy) throw new Error('导入任务正在执行');
      busy = true;
      const page = api.currentPage;
      const oldName = page.name, oldBinding = page.getPluginData(bindingKey);
      const createdFrames: FrameNode[] = [];
      let writtenName = '', writtenBinding = '';
      const created: ComponentNode[] = [];
      let instances: InstanceSize[] = [];
      let updatedIds = new Set<string>();
      const report: ImportReport = {schemaVersion:1,added:0,updated:0,removed:0,unchanged:0,blocked:0,
        removalSuppressed:false,messages:[],applied:{added:0,updated:0,removed:0},failures:[],cancelled:false};
      const fail = (name: string, error: unknown) => {
        report.failures.push({name,reason:error instanceof Error ? error.message : '单项导入失败'});
      };
      const restoreBinding = () => {
        // Roll back only our own page-level writes; keep concurrent user edits.
        if(page.name === writtenName) page.name = oldName;
        if(page.getPluginData(bindingKey) === writtenBinding) page.setPluginData(bindingKey, oldBinding);
      };
      const dropEmptyFrames = () => {
        for(const created of [...createdFrames]) {
          if(created.children.length) continue;
          created.remove();
          createdFrames.splice(createdFrames.indexOf(created),1);
        }
      };
      try {
        await loadPage(page);
        if(api.currentPage.id !== page.id) throw new Error('当前页已改变，请重新扫描');
        const status = validate(page,scan.project);
        if(!status.valid) throw new Error(status.message);
        const state = buildPlan(scan,page);
        const plan = state.plan;
        report.added = plan.added; report.updated = plan.updated; report.removed = plan.removed;
        report.unchanged = plan.unchanged; report.blocked = plan.blocked;
        report.removalSuppressed = plan.removalSuppressed; report.messages = [...plan.messages];
        updatedIds = new Set(state.updates.map(item => item.existing!.component.id));
        const total = state.adds.length + state.updates.length + state.removals.length;
        progress({done:0,total});
        instances = await snapshotInstances(page);
        if(!page.getPluginData(bindingKey)) {
          writtenName = pageName(scan.project);
          writtenBinding = JSON.stringify({schemaVersion:1,projectId:scan.project.id});
          page.name = writtenName;
          page.setPluginData(bindingKey,writtenBinding);
        }
        let done = 0;
        // Yield between items so a cancel message can stop scheduling and the UI can repaint.
        const step = async () => {
          progress({done:++done,total});
          await new Promise(resolve=>setTimeout(resolve,0));
        };
        for(const item of state.updates) {
          if(cancellation.cancelled) { report.cancelled = true; break; }
          if(api.currentPage.id !== page.id) throw new Error('当前页已改变，已停止导入，已完成的项会保留');
          const component = item.existing?.component;
          const category = plannedCategory(item);
          if(!component) { fail(describeCandidate(item,category),new Error('待更新组件已消失')); await step(); continue; }
          const snap = snapshot(component,item.existing!);
          try {
            const image = api.createImage(api.base64Decode(item.resource.png));
            applyComponent(api,component,item,{type:'IMAGE',imageHash:image.hash,scaleMode:'FILL'});
            // A size or nine-slice change may move the component to another
            // purpose category; identity and source stay on the same node.
            const target = ensureCategoryFrame(page,api,category,createdFrames);
            if(component.parent !== target) target.appendChild(component);
            report.applied.updated++;
          } catch(error) {
            // Isolate the failure: restore this item so the next run detects it again.
            restoreSnapshot(api,snap);
            fail(component.name,error);
          }
          await step();
        }
        if(!report.cancelled && state.adds.length) {
          for(const item of state.adds) {
            if(cancellation.cancelled) { report.cancelled = true; break; }
            if(api.currentPage.id !== page.id) throw new Error('当前页已改变，已停止导入，已完成的项会保留');
            const category = plannedCategory(item);
            try {
              const image = api.createImage(api.base64Decode(item.resource.png));
              const target = ensureCategoryFrame(page,api,category,createdFrames);
              created.push(createComponent(api,target,item,{type:'IMAGE',imageHash:image.hash,scaleMode:'FILL'},category));
              report.applied.added++;
            } catch(error) {
              fail(describeCandidate(item,category),error);
            }
            await step();
          }
        }
        if(!report.cancelled) for(const item of state.removals) {
          if(cancellation.cancelled) { report.cancelled = true; break; }
          if(api.currentPage.id !== page.id) throw new Error('当前页已改变，已停止导入，已完成的项会保留');
          const sync = item.component.getPluginData(syncKey);
          try {
            markMissing(item);
            report.applied.removed++;
          } catch(error) {
            item.component.setPluginData(syncKey,sync);
            fail(item.component.name,error);
          }
          await step();
        }
        if(report.applied.added+report.applied.updated > 0) refreshDisplayNames(page,scan.project,report.messages);
        dropEmptyFrames();
        restoreInstances(instances,updatedIds);
        if(report.cancelled) {
          // Cancelled items are neither success nor source deletions; a retry fills them.
          report.messages = [...report.messages,'任务已取消：已完成项保留，未完成项未记成功，可再次运行补齐'];
          if(report.applied.added+report.applied.updated+report.applied.removed === 0) restoreBinding();
        }
        return report;
      } catch(error) {
        // No whole-task atomic rollback: completed items stay valid and retryable.
        if(report.applied.added+report.applied.updated+report.applied.removed === 0) {
          for(const component of created) component.remove();
          dropEmptyFrames();
          restoreBinding();
        }
        restoreInstances(instances,updatedIds);
        throw error;
      } finally {busy=false;}
    },
    async tidy(project) {
      if(!project || typeof project.id !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(project.id) ||
         typeof project.name !== 'string' || !project.name.trim() || project.name.length > 200) throw new Error('项目信息无效');
      if(busy) throw new Error('导入任务正在执行');
      busy = true;
      try {
        const page = api.currentPage;
        await loadPage(page);
        const status = validate(page, project);
        if(!status.valid) throw new Error(status.message);
        return tidyCategoryFrames(page);
      } finally {busy=false;}
    },
    async compare(project) {
      if(busy) throw new Error('导入任务正在执行');
      if(!project || typeof project.id !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(project.id) ||
         typeof project.name !== 'string' || !project.name.trim() || project.name.length > 200) throw new Error('项目信息无效');
      busy = true;
      const created: {instances: InstanceNode[]; frames: FrameNode[]} = {instances:[], frames:[]};
      let createdPage: PageNode | undefined;
      try {
        const items = compareItems(await projectComponents(api.root, project));
        if(!items.size) throw new Error('当前文件还没有该项目的主组件，请先导入主组件');
        let page = await managedComparePage(api.root, project);
        if(!page) { page = createComparePage(api.root, project, api); createdPage = page; }
        await loadPage(page);
        const counts = syncComparePage(page, items, api, created);
        return {schemaVersion:1, pageName:page.name, created:!!createdPage, groups:counts.groups,
          added:counts.added, removed:counts.removed, kept:counts.kept, messages:counts.messages};
      } catch(error) {
        // Only this call's nodes are removed; existing instances and user edits stay.
        for(const instance of created.instances) instance.remove();
        for(const frame of created.frames) frame.remove();
        if(createdPage) createdPage.remove();
        throw error;
      } finally {busy=false;}
    }

  };
}
