import type { CategoryOverride, CategoryRestoreResult, CategoryResult, ImportPlan, ImportReport, LayoutUsage, Platform, Progress, PublicProject, Resource, Scan, SelectionState, Source, TidyResult, TrainingExport } from './api';
import { Cancellation } from './api';
import { categoryConfigKey, categoryIndex, categoryOr, classify, componentName, knownCategory, categoryNameProblem,
  categoryRuleIndex, categoryRulesKey, learnCategoryRules, matchCategoryRule, nextCategoryColor, readCategoryConfig,
  readCategoryRules, serializeCategories, serializeCategoryRules, unsortedCategory,
  type CategoryConfig, type CategoryName, type CategoryRule, type CategoryRuleIndex, type CategorySample } from './category';
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
const manualCategoryKey = 'atlas.category.manual';
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
function validStoredSource(s: Partial<Source>, project: Pick<PublicProject,'id'>): s is Source {
  if(s.schemaVersion !== 1 || s.projectId !== project.id || (s.kind !== 'atlas' && s.kind !== 'standalone') ||
     !relativePath(s.relativePath) || !safeName(s.frameName) || typeof s.identity !== 'string') return false;
  if(s.kind === 'atlas') return s.identity === JSON.stringify([project.id,'atlas',s.relativePath,s.frameName]);
  return s.relativePath.toLowerCase().endsWith('.png') &&
    s.identity === JSON.stringify([project.id,'standalone',s.relativePath]);
}
function sourceRecord(component: ComponentNode): {source?: Partial<Source>; sync?: SyncState} {
  try {
    const value = JSON.parse(component.getPluginData(sourceKey)) as {sync?: SyncState} & Partial<Source>;
    return {source:value, sync:value.sync};
  } catch { return {}; }
}
function parseStoredSource(component: ComponentNode, project: Pick<PublicProject,'id'>): Source | undefined {
  const source = sourceRecord(component).source;
  return source && validStoredSource(source,project) ? source as Source : undefined;
}
function parseSync(component: ComponentNode, identity: string): SyncState | undefined {
  const fromSource = sourceRecord(component).sync;
  let sync: SyncState | undefined = fromSource;
  if(!sync) {
    try { sync = JSON.parse(component.getPluginData(syncKey)) as SyncState; } catch { sync = undefined; }
  }
  return sync && sync.schemaVersion === 1 && sync.identity === identity &&
    typeof sync.contentHash === 'string' && sync.sourceSize && int(sync.sourceSize.w) && int(sync.sourceSize.h) &&
    (sync.status === 'current' || sync.status === 'source-missing') ? sync : undefined;
}
function hashParts(parts: string[]): string {
  // Stable, dependency-free content fingerprint. Feed parts directly instead
  // of concatenating large base64 strings; this is change detection, not crypto.
  let fnv = 2166136261, djb2 = 5381, length = 0;
  for(const part of parts) {
    length += part.length;
    for(let i=0;i<part.length;i++) {
      const code = part.charCodeAt(i);
      fnv = Math.imul(fnv ^ code, 16777619) >>> 0;
      djb2 = ((djb2 << 5) + djb2 + code) >>> 0;
    }
  }
  return `${length}:${fnv.toString(16)}:${djb2.toString(16)}`;
}
const contentHashCache = new WeakMap<Resource,string>();
function contentHash(resource: Resource, source: Source): string {
  const cached = contentHashCache.get(resource);
  if(cached) return cached;
  const hash = hashParts([resource.png, `|${resource.width}x${resource.height}|` +
    JSON.stringify([source.kind, source.relativePath, source.frameName, source.crop, source.offset])]);
  contentHashCache.set(resource,hash);
  return hash;
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
// Category frames are tool-managed page children whose `atlas.category` value
// must be one of the page's configured categories. `unsorted` is the legacy #3
// marker for 未分类; frames carrying any other unknown value (for example the old
// 九宫格底板) are left alone instead of being adopted or renamed.
const categoryGap = 48;
const compareGap = 24;
function compareColumns(count: number): number { return Math.max(1, Math.ceil(Math.sqrt(count))); }
function hostPage(node: BaseNode): PageNode | undefined {
  let current: BaseNode | null = node;
  while(current && current.type !== 'PAGE') current = current.parent;
  return current && current.type === 'PAGE' ? current as PageNode : undefined;
}
// Read-through: a page without stored categories simply uses the default seven.
function pageCategories(page: PageNode): CategoryConfig {
  return readCategoryConfig(page.getPluginData(categoryConfigKey)).config;
}
function categoriesFor(node: BaseNode): CategoryConfig {
  const page = hostPage(node);
  return page ? pageCategories(page) : readCategoryConfig('').config;
}
// ---- 学到的命名族规律（#21）---------------------------------------------------
// 规则存在资源页 `atlas.category.rules.v1`：有序、可回读，缺失时按现有标签惰性补算。
type LearnedRules = {raw: string; rules: CategoryRule[]; index: CategoryRuleIndex};
const rulesCache = new WeakMap<PageNode, LearnedRules>();
type PageComponentInput = {frameName: string; manual: boolean};
// 一次全页遍历同时得到学习样本与预计命中的输入，避免阅读规律时扫两遍页面。
type PageCategoryInputs = {samples: CategorySample[]; components: PageComponentInput[]};
// 学习与预计命中都用 `atlas.source` 校验项目与来源完整性；损坏或无关组件跳过，
// 不继承导入时的损坏拦截，也不让单条坏记录拖垮整页学习。
// 同一来源身份只取第一条，避免重复节点把 support 虚增到阈值。
function pageCategoryInputs(page: PageNode, config: CategoryConfig, projectId: string | undefined): PageCategoryInputs {
  const samples: CategorySample[] = [];
  const components: PageComponentInput[] = [];
  if(!projectId) return {samples, components};
  const seen = new Set<string>();
  for(const node of page.findAll(() => true)) {
    if(node.type !== 'COMPONENT') continue;
    const source = parseStoredSource(node, {id: projectId});
    if(!source) continue;
    const category = manualCategory(node, config);
    components.push({frameName:source.frameName, manual:!!category});
    if(!category || seen.has(source.identity)) continue;
    seen.add(source.identity);
    samples.push({frameName:source.frameName, category});
  }
  return {samples, components};
}
function boundProjectId(page: PageNode): string | undefined {
  const raw = page.getPluginData(bindingKey);
  if(!raw) return undefined;
  try {
    const binding = JSON.parse(raw) as {schemaVersion?: unknown; projectId?: unknown} | null;
    return binding?.schemaVersion === 1 && typeof binding.projectId === 'string' && binding.projectId
      ? binding.projectId : undefined;
  } catch { return undefined; }
}
function storeRules(page: PageNode, rules: readonly CategoryRule[]): void {
  const raw = serializeCategoryRules(rules);
  page.setPluginData(categoryRulesKey, raw);
  rulesCache.set(page, {raw, rules:[...rules], index:categoryRuleIndex(rules)});
}
// 事务回滚用：把页面键恢复成操作前原文，并让下一次读取重新解析而不是沿用缓存。
function restoreRules(page: PageNode, raw: string): void {
  page.setPluginData(categoryRulesKey, raw);
  if(!raw) { rulesCache.delete(page); return; }
  const read = readCategoryRules(raw);
  rulesCache.set(page, {raw, rules:read.rules, index:categoryRuleIndex(read.rules)});
}
// 缺失时按现有标签惰性补算一次；损坏时立即按标签重建，而不是读一次就永久清零。
// 与类别配置一样只在已绑定资源页写入，避免把空白页变成「非空未绑定页」。
function rulesFromInputs(page: PageNode, inputs: PageCategoryInputs): LearnedRules {
  const raw = page.getPluginData(categoryRulesKey);
  const cached = rulesCache.get(page);
  if(cached && cached.raw === raw) return cached;
  const read = readCategoryRules(raw);
  const rules = raw && !read.repaired ? read.rules : learnCategoryRules(inputs.samples);
  if((read.repaired || (!raw && rules.length)) && page.getPluginData(bindingKey)) storeRules(page, rules);
  const state = {raw:page.getPluginData(categoryRulesKey), rules, index:categoryRuleIndex(rules)};
  rulesCache.set(page, state);
  return state;
}
function rulesFor(page: PageNode, projectId = boundProjectId(page)): LearnedRules {
  const raw = page.getPluginData(categoryRulesKey);
  const cached = rulesCache.get(page);
  if(cached && cached.raw === raw) return cached;
  const config = pageCategories(page);
  return rulesFromInputs(page, pageCategoryInputs(page, config, projectId));
}
// 重算并落盘：人工标签或类别变化后调用。清空规律走单独入口，不会在这里被立即重学。
function refreshCategoryRules(page: PageNode, projectId: string): void {
  if(!page.getPluginData(bindingKey)) return;
  storeRules(page, learnCategoryRules(pageCategoryInputs(page, pageCategories(page), projectId).samples));
}
// 预计命中只统计当前页没有人工覆盖、且能被规律匹配到的组件。
function estimatedHits(components: readonly PageComponentInput[], config: CategoryConfig,
  index: CategoryRuleIndex): number {
  if(!index.size) return 0;
  let count = 0;
  for(const component of components) {
    if(component.manual) continue;
    if(matchCategoryRule(index, component.frameName, config)) count++;
  }
  return count;
}
function frameCategory(node: FrameNode, config: CategoryConfig): CategoryName | undefined {
  const raw = node.getPluginData(categoryKey);
  if(raw === 'unsorted') return knownCategory(config, unsortedCategory);
  const known = knownCategory(config, raw);
  if(known) return known;
  // Legacy #3 frames carry no marker; their managed children identify them.
  if(node.name === unsortedCategory && Array.isArray(node.children) && node.children.some(child => child.getPluginData(sourceKey))) return unsortedCategory;
  return undefined;
}
function managedCategoryFrames(page: PageNode): FrameNode[] {
  const config = pageCategories(page);
  return page.children.filter((node): node is FrameNode => node.type === 'FRAME' && !!frameCategory(node as FrameNode, config));
}
function managedCategory(node: ComponentNode): boolean {
  const parent = node.parent;
  return !!parent && parent.type === 'FRAME' && !!frameCategory(parent as FrameNode, categoriesFor(parent));
}
// Category frames are tool-owned, but users may drop unrelated components into
// them. Only nodes carrying tool records (or children of legacy frames) can have
// a source record to preserve or migrate; plain user objects are left alone.
function carriesToolRecord(node: SceneNode): boolean {
  return Boolean(node.getPluginData(sourceKey) || node.getPluginData(syncKey) ||
    readNineSliceRecord(node));
}
function legacyManagedParent(node: ComponentNode): boolean {
  const parent = node.parent;
  return !!parent && parent.type === 'FRAME' && !parent.getPluginData(categoryKey) &&
    parent.name === unsortedCategory && !!frameCategory(parent as FrameNode, categoriesFor(parent));
}
// If every tool record was cleared, the derived display name is the remaining
// evidence that this was a managed component; a plain user name is not flagged.
function looksManagedName(node: ComponentNode, config: CategoryConfig): boolean {
  const separator = node.name.indexOf('/');
  return separator > 0 && !!knownCategory(config, node.name.slice(0,separator));
}
function findCategoryFrame(page: PageNode, category: CategoryName): FrameNode | undefined {
  const config = pageCategories(page);
  return managedCategoryFrames(page).find(frame => frameCategory(frame, config) === category);
}
function nextCategoryFrameX(page: PageNode): number {
  const frames = managedCategoryFrames(page);
  if(!frames.length) return 0;
  return Math.max(...frames.map(frame => frame.x + frame.width)) + categoryGap;
}
function createCategoryFrame(page: PageNode, api: Pick<PluginAPI,'createFrame'>, category: CategoryName): FrameNode {
  const x = nextCategoryFrameX(page);
  const frame = api.createFrame();
  page.appendChild(frame);
  frame.name = category;
  frame.fills = [];
  frame.resize(1200,100); frame.layoutMode = 'HORIZONTAL'; frame.layoutWrap = 'WRAP';
  frame.primaryAxisSizingMode = 'FIXED'; frame.counterAxisSizingMode = 'AUTO';
  frame.itemSpacing = 16; frame.counterAxisSpacing = 16;
  frame.paddingTop = frame.paddingRight = frame.paddingBottom = frame.paddingLeft = 16;
  frame.setPluginData(categoryKey, category);
  // New frames are placed to the right of existing ones; normal imports never reflow
  // existing frame positions, only 重新整理 does.
  frame.x = x; frame.y = 0;
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
type CategoryLayout = {
  frame: FrameNode; mode: FrameNode['layoutMode']; wrap: FrameNode['layoutWrap'];
  primary: FrameNode['primaryAxisSizingMode']; counter: FrameNode['counterAxisSizingMode'];
};
function pauseCategoryLayouts(frames: Iterable<FrameNode>): CategoryLayout[] {
  const snapshots: CategoryLayout[] = [];
  for(const frame of frames) {
    if(frame.layoutMode === 'NONE') continue;
    snapshots.push({frame,mode:frame.layoutMode,wrap:frame.layoutWrap,
      primary:frame.primaryAxisSizingMode,counter:frame.counterAxisSizingMode});
    try { frame.layoutMode = 'NONE'; } catch { /* keep importing even if a frame rejects layout changes */ }
  }
  return snapshots;
}
function restoreCategoryLayouts(snapshots: CategoryLayout[]): void {
  for(const snapshot of snapshots) {
    try {
      snapshot.frame.layoutMode = snapshot.mode;
      if(snapshot.mode === 'HORIZONTAL') snapshot.frame.layoutWrap = snapshot.wrap;
      snapshot.frame.primaryAxisSizingMode = snapshot.primary;
      snapshot.frame.counterAxisSizingMode = snapshot.counter;
    } catch { /* best effort; never hide the import result for a layout restore */ }
  }
}
type CategoryJob = {
  component: ComponentNode; page: PageNode; target: CategoryName; targetFrame?: FrameNode;
  // 写入 `atlas.category.manual` 的值（空串即清除人工覆盖）。
  manualData: string;
  // 操作前的原始值，仅在写入失败时回写；撤销流程不需要回写，就不传。
  previousData?: string;
  // 人工分类操作前的类别快照，作为撤销单元的条目。
  previous?: CategoryOverride;
};
// 人工分类与撤销共用同一条流水线：建目标 Frame → 暂停布局 → 逐项移动并写人工覆盖
// （失败按项回写人工覆盖并记入消息）→ 恢复布局 → 按页刷新显示名。
// 按 id 定位与来源校验留在调用方，因为两处的输入合法性规则不同。
function applyCategoryJobs(api: Pick<PluginAPI,'createFrame'>, project: PublicProject, jobs: CategoryJob[],
  createdFrames: FrameNode[], messages: string[], failureLabel: string): {moved: number; done: CategoryJob[]; failed: number} {
  const frames = new Set<FrameNode>();
  for(const job of jobs) {
    job.targetFrame = ensureCategoryFrame(job.page, api, job.target, createdFrames);
    frames.add(job.targetFrame);
  }
  const layouts = pauseCategoryLayouts(frames);
  const done: CategoryJob[] = [];
  let moved = 0, failed = 0;
  try {
    for(const job of jobs) {
      try {
        if(job.component.parent !== job.targetFrame) { job.targetFrame!.appendChild(job.component); moved++; }
        job.component.setPluginData(manualCategoryKey, job.manualData);
        done.push(job);
      } catch(error) {
        if(job.previousData !== undefined) job.component.setPluginData(manualCategoryKey, job.previousData);
        failed++;
        messages.push(`${job.component.name}：${error instanceof Error ? error.message : failureLabel}`);
      }
    }
  } finally {
    restoreCategoryLayouts(layouts);
  }
  for(const host of new Set(jobs.map(job => job.page))) {
    refreshDisplayNames(host, project, messages);
    // 人工标签变化后就地重学，下一次导入/恢复自动分类沿用同一份规则。
    refreshCategoryRules(host, project.id);
  }
  return {moved, done, failed};
}
function manualCategory(component: ComponentNode, config: CategoryConfig): CategoryName | undefined {
  return knownCategory(config, component.getPluginData(manualCategoryKey));
}
function currentCategory(component: ComponentNode, config: CategoryConfig): CategoryName | undefined {
  const parent = component.parent;
  return parent && parent.type === 'FRAME' ? frameCategory(parent as FrameNode, config) : undefined;
}
function automaticCategory(component: ComponentNode, source: Source, config: CategoryConfig,
  learned: CategoryRuleIndex): CategoryName {
  return categoryOr(config, classify({frameName:source.frameName,width:component.width,height:component.height}, learned, config).category);
}
// 优先级：人工覆盖 > 学到的命名族 > 通用前缀/关键词/尺寸。`learned` 标记供预览统计。
function plannedCategory(item: Candidate, config: CategoryConfig,
  learned: CategoryRuleIndex): {category: CategoryName; learned: boolean} {
  const manual = item.existing ? manualCategory(item.existing.component, config) : undefined;
  if(manual) return {category:manual, learned:false};
  const classified = classify({frameName:item.source.frameName,width:item.resource.width,height:item.resource.height}, learned, config);
  return {category:categoryOr(config, classified.category), learned:classified.learned};
}
function existingComponents(page: PageNode, project: PublicProject): { items: Existing[]; corrupt: string[] } {
  const result: Existing[] = [], corrupt: string[] = [];
  for(const node of page.findAll(() => true)) {
    if(node.type !== 'COMPONENT') continue;
    const source = parseStoredSource(node, project);
    if(!source) {
      if(carriesToolRecord(node) || (managedCategory(node) &&
         (legacyManagedParent(node) || looksManagedName(node, categoriesFor(node))))) corrupt.push(node.name);
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
  const adds = [...scanItems.values()].filter(item => !groups.has(item.source.identity));
  const updates = [...scanItems.values()].filter(item => {
    const group = groups.get(item.source.identity);
    return !!group && group.length === 1 && !group[0].blocked && !item.planned.blocked && !isUnchanged(group[0], item, item.planned);
  });
  // 预览先告知这批素材有多少条会被学习到的命名规律直接定类（0 时不加消息）。
  const categoryConfig = pageCategories(page);
  const learned = rulesFor(page, scan.project.id).index;
  const learnedCount = [...adds, ...updates]
    .filter(item => plannedCategory(item, categoryConfig, learned).learned).length;
  if(learnedCount) messages.add(`按学习命名规律预分类 ${learnedCount} 条`);
  plan.messages = [...messages];
  return {
    plan,
    adds,
    updates,
    removals: [...groups.values()].filter(group => group.length === 1 && !group[0].blocked &&
      !scanItems.has(group[0].source.identity) && scan.complete).map(group => group[0])
  };
}
function orderedCategoryFrames(page: PageNode): FrameNode[] {
  const index = new Map<SceneNode, number>();
  page.children.forEach((node, position) => index.set(node, position));
  // Page configuration order is the layout contract; duplicates of one category
  // stay stacked in their previous visual/page order to keep the move minimal.
  const config = pageCategories(page);
  const names = config.categories.map(category => category.name);
  return [...managedCategoryFrames(page)].sort((left, right) => {
    const category = categoryIndex(names, frameCategory(left, config)!) - categoryIndex(names, frameCategory(right, config)!);
    if(category) return category;
    if(left.y !== right.y) return left.y - right.y;
    if(left.x !== right.x) return left.x - right.x;
    return (index.get(left) || 0) - (index.get(right) || 0);
  });
}
// 重新整理 only touches category frame coordinates. Components, their source
// records, instance links and nine-slice child constraints stay untouched.
function tidyCompareGroups(page: PageNode): TidyResult {
  const result = layoutCompareGroups(page);
  return {schemaVersion:1,frames:result.frames,moved:result.moved,
    messages:result.frames?[]:['当前对照页没有图集分组，无需整理']};
}
function tidyCategoryFrames(page: PageNode): TidyResult {
  const frames = orderedCategoryFrames(page);
  if(!frames.length) return {schemaVersion:1,frames:0,moved:0,
    messages:['当前页没有本工具创建的分类 Frame，无需整理']};
  // Categories read as one horizontal shelf. Their internal Auto Layout still
  // wraps components, so the page grows sideways rather than by every frame height.
  let x = 0, moved = 0;
  for(const frame of frames) {
    if(frame.x !== x || frame.y !== 0) {
      frame.x = x; frame.y = 0;
      moved++;
    }
    x += (frame.width || 0) + categoryGap;
  }
  return {schemaVersion:1,frames:frames.length,moved,messages:[]};
}
// Display names are derived, never part of the resource identity. Same-name
// components in one category add their source location so both stay unique.
function refreshDisplayNames(page: PageNode, project: PublicProject, messages: string[]): void {
  const config = pageCategories(page);
  const groups = new Map<string, Array<{component: ComponentNode; source: Source; category: string}>>();
  for(const frame of managedCategoryFrames(page)) {
    const category = frameCategory(frame, config);
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
  // One private record per new component. Legacy `atlas.sync.v1` remains a read fallback.
  component.setPluginData(sourceKey,JSON.stringify({...item.source, sync}));
}
function writeRecord(component: ComponentNode, planned: Planned): void {
  if(planned.record) writeNineSliceRecord(component, serializeNineSliceRecord(planned.record));
  else if(readNineSliceRecord(component)) writeNineSliceRecord(component, '');
}
function markMissing(existing: Existing): void {
  const sync: SyncState = existing.sync || {schemaVersion:1,identity:existing.source.identity,contentHash:'',
    sourceSize:{w:existing.component.width,h:existing.component.height},status:'current'};
  existing.component.setPluginData(sourceKey,JSON.stringify({...existing.source, sync:{...sync,status:'source-missing'}}));
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
  writeSync(component,item,image.imageHash || '');
  writeRecord(component,planned);
}
function createComponent(api: Pick<PluginAPI,'createComponent'|'createRectangle'>, target: FrameNode, item: Candidate,
  image: ImagePaint, category: string): ComponentNode {
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
function describeCandidate(item: Candidate, category: string): string {
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
function compareGroups(page: PageNode): FrameNode[] {
  const indexed = new Map<SceneNode, number>();
  page.children.forEach((node, index) => indexed.set(node, index));
  return page.children.filter((node): node is FrameNode => node.type === 'FRAME' && !!node.getPluginData(compareGroupKey))
    .sort((left, right) => {
      const key = left.getPluginData(compareGroupKey).localeCompare(right.getPluginData(compareGroupKey));
      return key || (indexed.get(left) || 0) - (indexed.get(right) || 0);
    });
}
function layoutCompareGroups(page: PageNode): { frames: number; moved: number } {
  const frames = compareGroups(page);
  if(!frames.length) return {frames:0,moved:0};
  const columns = compareColumns(frames.length);
  let column = 0, rowY = 0, rowHeight = 0, moved = 0;
  for(const frame of frames) {
    const x = column * (1200 + compareGap);
    if(frame.x !== x || frame.y !== rowY) {
      frame.x = x; frame.y = rowY;
      moved++;
    }
    rowHeight = Math.max(rowHeight, frame.height || 0);
    column++;
    if(column === columns) {
      column = 0;
      rowY += rowHeight + compareGap;
      rowHeight = 0;
    }
  }
  return {frames:frames.length,moved};
}

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
  // Grid columns follow group count: 4 -> 2x2, 9 -> 3x3, 10 -> 4x3.
  const columns = compareColumns(keys.length);
  let column = 0, rowY = 0, rowHeight = 0;
  for(const key of keys) {
    const frame = frames.get(key)!;
    frame.x = column * (1200 + compareGap);
    frame.y = rowY;
    rowHeight = Math.max(rowHeight, frame.height || 0);
    column++;
    if(column === columns) {
      column = 0;
      rowY += rowHeight + compareGap;
      rowHeight = 0;
    }
  }
  return {added, removed, kept, groups: keys.length, messages};
}
function readCategoryState(page: PageNode, projectId = boundProjectId(page)) {
  const config = pageCategories(page);
  // 一次遍历同时拿到学习样本与预计命中输入；规律损坏时也直接用同一份样本重建。
  const inputs = pageCategoryInputs(page, config, projectId);
  const learned = rulesFromInputs(page, inputs);
  return {schemaVersion:1 as const, categories:config.categories.map(category => ({name:category.name, color:category.color})),
    rules:{count:learned.rules.length, estimatedHits:estimatedHits(inputs.components, config, learned.index)}};
}
// 类别管理只写已绑定的资源页：空白未绑定页写配置后会变成「非空未绑定页」，
// 反而让后续导入被自己的守卫拒绝。
function assertEditableResourcePage(page: PageNode, project: PublicProject): void {
  const status = validate(page, project);
  if(!status.valid) throw new Error(status.message);
  if(!page.getPluginData(bindingKey)) throw new Error('当前页还不是本工具的资源页：请先导入主组件，再管理类别');
}
export function createFigmaPlatform(api: Pick<PluginAPI,'currentPage'|'root'|'createPage'|'createFrame'|'createComponent'|'createRectangle'|'createImage'|'base64Decode'|'getNodeByIdAsync'>): Platform {
  let busy = false;
  return {
    async validate(project) {const page = api.currentPage; await loadPage(page); return validate(page,project);},
    async categories() {
      // Read-through page configuration: missing means the default seven. A
      // damaged value is repaired on the next read so nothing blocks import or
      // page validation, but only a bound resource page is written to.
      const page = api.currentPage;
      await loadPage(page);
      const raw = page.getPluginData(categoryConfigKey);
      const {config, repaired} = readCategoryConfig(raw);
      if(repaired && page.getPluginData(bindingKey)) page.setPluginData(categoryConfigKey, serializeCategories(config));
      return readCategoryState(page, boundProjectId(page));
    },
    async clearCategoryRules(project) {
      if(busy) throw new Error('任务执行中，请等待完成');
      if(!project || typeof project.id !== 'string' || !project.name) throw new Error('项目信息无效');
      const page = api.currentPage;
      await loadPage(page);
      assertEditableResourcePage(page, project);
      busy = true;
      try {
        // 清空 = 写入空规则，不立即重学；下一次人工分类或类别变更才重新学习。
        storeRules(page, []);
        return {...readCategoryState(page, project.id), moved:0,
          message:'已清空命名规律：分类回退通用规则，下次人工分类或类别变更时重新学习'};
      } finally { busy = false; }
    },
    async addCategory(project, name) {
      if(busy) throw new Error('任务执行中，请等待完成');
      if(!project || typeof project.id !== 'string' || !project.name) throw new Error('项目信息无效');
      const page = api.currentPage;
      await loadPage(page);
      assertEditableResourcePage(page, project);
      const problem = categoryNameProblem(name);
      if(problem) throw new Error(problem);
      const category = (name as string).trim();
      const config = pageCategories(page);
      if(config.categories.some(existing => existing.name === category)) throw new Error(`已存在类别「${category}」，请换一个名称`);
      // 配置读回上限是 64 个：越过上限会让整份配置被判为损坏并回退默认七类，所以先拒绝。
      if(config.categories.length >= 64) throw new Error('类别数量已达上限 64 个，请先删除不用的类别');
      const next: CategoryConfig = {schemaVersion:1,
        categories:[...config.categories, {name:category, color:nextCategoryColor(config.categories)}]};
      busy = true;
      const created: FrameNode[] = [];
      // 配置与规律一起快照：写配置后重学失败时按原文回滚，不留下半改的页面。
      const previousConfig = page.getPluginData(categoryConfigKey);
      const previousRules = page.getPluginData(categoryRulesKey);
      try {
        // 先建 Frame 再写配置：写配置后该 Frame 才被认领，失败时只回滚本次新建的空 Frame。
        ensureCategoryFrame(page, api, category, created);
        page.setPluginData(categoryConfigKey, serializeCategories(next));
        // 新增类别本身不会产生新规则，但配置顺序变了，回读与预计命中要一起刷新。
        refreshCategoryRules(page, project.id);
        return {...readCategoryState(page, project.id), moved:0, message:`已新增类别「${category}」`};
      } catch(error) {
        for(const frame of created) if(!frame.children.length) frame.remove();
        try { page.setPluginData(categoryConfigKey, previousConfig); } catch { /* 保留可见错误 */ }
        try { restoreRules(page, previousRules); } catch { /* 保留可见错误 */ }
        throw error;
      } finally { busy = false; }
    },
    async removeCategory(project, name) {
      if(busy) throw new Error('任务执行中，请等待完成');
      if(!project || typeof project.id !== 'string' || !project.name) throw new Error('项目信息无效');
      const page = api.currentPage;
      await loadPage(page);
      assertEditableResourcePage(page, project);
      const config = pageCategories(page);
      const category = knownCategory(config, name);
      // 定位失败的名称不再走 categoryOr，以免把未分类当成可删除目标。
      if(!category) throw new Error(`当前页没有类别「${typeof name === 'string' ? name : ''}」`);
      if(category === unsortedCategory) throw new Error('「未分类」是兜底类别，不能删除');
      const frames = managedCategoryFrames(page).filter(frame => frameCategory(frame, config) === category);
      // 只迁移带本工具来源记录的子节点：用户自己放进分类 Frame 的对象不被抢走。
      const moved: Array<{node:SceneNode;frame:FrameNode;manual:string}> = [];
      const created: FrameNode[] = [];
      const messages: string[] = [];
      let layouts: CategoryLayout[] = [];
      let movedCount = 0, retained = 0;
      busy = true;
      // 删除会改配置、规律、子节点父级与人工覆盖：全部快照，失败时按原样恢复。
      const previousConfig = page.getPluginData(categoryConfigKey);
      const previousRules = page.getPluginData(categoryRulesKey);
      const frameSnapshots = frames.map(frame => ({frame, marker:frame.getPluginData(categoryKey)}));
      try {
        // 迁移顺序：先把带工具记录的子节点移到未分类并修正人工覆盖，
        // 再刷新显示名，最后才写配置并处理 Frame——任何一步失败都能把已移动的节点放回原处。
        const children = frames.flatMap(frame => frame.children.filter(node => carriesToolRecord(node))
          .map(node => ({node:node as SceneNode, frame})));
        if(children.length) {
          const fallback = ensureCategoryFrame(page, api, unsortedCategory, created);
          layouts = pauseCategoryLayouts([fallback, ...frames]);
          for(const item of children) {
            try {
              fallback.appendChild(item.node);
              const previous = item.node.getPluginData(manualCategoryKey);
              moved.push({...item, manual:previous});
              // 人工覆盖指向被删类别时清除覆盖，而不是改写成「未分类」：
              // 否则工具会把自己的迁移结果当成新的人工标签，学出假规律。
              if(previous === category) item.node.setPluginData(manualCategoryKey, '');
              if(item.node.type === 'COMPONENT') movedCount++;
            } catch(error) {
              throw new Error(`删除类别失败：${item.node.name} 无法移动到未分类，本次未做任何修改（${error instanceof Error ? error.message : '移动失败'}）`);
            }
          }
          restoreCategoryLayouts(layouts); layouts = [];
          // 显示名刷新失败也是删类别的一部分结果，不能传空数组静默丢弃。
          refreshDisplayNames(page, project, messages);
        }
        const next: CategoryConfig = {schemaVersion:1,
          categories:config.categories.filter(existing => existing.name !== category)};
        page.setPluginData(categoryConfigKey, serializeCategories(next));
        // 删除后重学：指向已删除类别的族随之失效，不会把组件重新引回该类别。
        refreshCategoryRules(page, project.id);
        for(const frame of frames) {
          if(!frame.children.length) { frame.remove(); continue; }
          // 还留着非本工具对象：不删 Frame，只清除类别标记，使它不再被本工具认领。
          frame.setPluginData(categoryKey, '');
          retained += frame.children.length;
        }
        const kept = retained ? `，保留 ${retained} 个非本工具对象在原 Frame` : '';
        const skippedNotes = messages.length ? `；${messages.join('；')}` : '';
        return {...readCategoryState(page, project.id), moved:movedCount,
          message:(movedCount ? `已删除类别「${category}」，${movedCount} 个主组件移到「${unsortedCategory}」`
            : `已删除类别「${category}」`) + kept + skippedNotes};
      } catch(error) {
        // 把已移动的子节点、人工覆盖、Frame 标记、配置与规律一并恢复；
        // 显示名由父 Frame 推导，回到原父级后重刷一遍。
        for(const done of moved) {
          try { done.frame.appendChild(done.node); done.node.setPluginData(manualCategoryKey, done.manual); } catch { /* 保留可见错误 */ }
        }
        for(const snapshot of frameSnapshots) {
          try { snapshot.frame.setPluginData(categoryKey, snapshot.marker); } catch { /* 保留可见错误 */ }
        }
        try { page.setPluginData(categoryConfigKey, previousConfig); } catch { /* 保留可见错误 */ }
        try { restoreRules(page, previousRules); } catch { /* 保留可见错误 */ }
        try { refreshDisplayNames(page, project, []); } catch { /* 保留可见错误 */ }
        throw error;
      } finally {
        restoreCategoryLayouts(layouts);
        // 只有本次新建且仍为空的未分类 Frame 需要回滚，已有 Frame 保留。
        for(const frame of created) if(!frame.children.length) frame.remove();
        busy = false;
      }
    },
    async renameCategory(project, from, to) {
      if(busy) throw new Error('任务执行中，请等待完成');
      if(!project || typeof project.id !== 'string' || !project.name) throw new Error('项目信息无效');
      const page = api.currentPage;
      await loadPage(page);
      assertEditableResourcePage(page, project);
      const config = pageCategories(page);
      const category = knownCategory(config, from);
      if(!category) throw new Error(`当前页没有类别「${typeof from === 'string' ? from : ''}」`);
      // 「未分类」是兜底类别：名称在代码与旧数据里都是约定值，改名会弄丢兜底桶。
      if(category === unsortedCategory) throw new Error('「未分类」是兜底类别，不能改名');
      const problem = categoryNameProblem(to);
      if(problem) throw new Error(problem);
      const name = (to as string).trim();
      if(name === category) throw new Error('新名称与当前名称相同，无需改名');
      if(config.categories.some(existing => existing.name === name)) throw new Error(`已存在类别「${name}」，请换一个名称`);
      const frames = managedCategoryFrames(page).filter(frame => frameCategory(frame, config) === category);
      // 改名只动名字：Frame 名与类别标记、人工覆盖、派生显示名一起换，身份与实例不动。
      // 回滚快照要记下每个 Frame 原有的名字与标记（用户可能手改过 Frame 名），
      // 以及页面配置原文，失败时按原样写回。
      const frameSnapshots = frames.map(frame => ({frame, name:frame.name, marker:frame.getPluginData(categoryKey)}));
      const overrides: Array<{node:SceneNode;previous:string}> = [];
      const previousConfig = page.getPluginData(categoryConfigKey);
      const previousRules = page.getPluginData(categoryRulesKey);
      const messages: string[] = [];
      let layouts: CategoryLayout[] = [];
      let synced = 0;
      busy = true;
      try {
        layouts = pauseCategoryLayouts(frames);
        for(const frame of frames) {
          frame.name = name;
          frame.setPluginData(categoryKey, name);
          for(const child of frame.children) {
            if(!carriesToolRecord(child)) continue;
            synced++;
            if(child.getPluginData(manualCategoryKey) !== category) continue;
            overrides.push({node:child as SceneNode, previous:category});
            child.setPluginData(manualCategoryKey, name);
          }
        }
        // 显示名由父 Frame 的类别标记推导，所以必须先写配置让新名称被认领，再刷新显示名；
        // 写配置之后的任何失败都要把配置原文一并回滚。
        const next: CategoryConfig = {schemaVersion:1, categories:config.categories.map(existing =>
          existing.name === category ? {name, color:existing.color} : existing)};
        page.setPluginData(categoryConfigKey, serializeCategories(next));
        refreshDisplayNames(page, project, messages);
        // 改名后重学：指向该类别的族同步改指新名称。
        refreshCategoryRules(page, project.id);
        const notes = messages.length ? `；${messages.join('；')}` : '';
        return {...readCategoryState(page, project.id), moved:synced,
          message:`已将类别「${category}」改名为「${name}」${synced ? `，${synced} 个主组件的分类与显示名已同步` : ''}${notes}`};
      } catch(error) {
        // 失败时把配置、Frame 名与标记、人工覆盖都改回原值，不留下半改的页面。
        for(const item of overrides) { try { item.node.setPluginData(manualCategoryKey, item.previous); } catch { /* 保留可见错误 */ } }
        for(const snapshot of frameSnapshots) {
          try { snapshot.frame.name = snapshot.name; snapshot.frame.setPluginData(categoryKey, snapshot.marker); } catch { /* 保留可见错误 */ }
        }
        try { page.setPluginData(categoryConfigKey, previousConfig); } catch { /* 保留可见错误 */ }
        try { restoreRules(page, previousRules); } catch { /* 保留可见错误 */ }
        try { refreshDisplayNames(page, project, []); } catch { /* 保留可见错误 */ }
        throw error;
      } finally {
        restoreCategoryLayouts(layouts);
        busy = false;
      }
    },
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
      let categoryLayouts: CategoryLayout[] = [];
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
        const categoryConfig = pageCategories(page);
        const learned = rulesFor(page, scan.project.id).index;
        const categories = new Set([...state.adds,...state.updates].map(item => plannedCategory(item, categoryConfig, learned).category));
        const categoryFrames = new Map<string,FrameNode>();
        for(const category of categories) categoryFrames.set(category,ensureCategoryFrame(page,api,category,createdFrames));
        // Bulk append into an active Auto Layout frame reflows the frame for
        // every component. Pause it until all writes are done, then restore the
        // original layout properties once.
        categoryLayouts = pauseCategoryLayouts(categoryFrames.values());
        const total = state.adds.length + state.updates.length + state.removals.length;
        progress({done:0,total});
        instances = await snapshotInstances(page);
        if(!page.getPluginData(bindingKey)) {
          writtenName = pageName(scan.project);
          writtenBinding = JSON.stringify({schemaVersion:1,projectId:scan.project.id});
          page.name = writtenName;
          page.setPluginData(bindingKey,writtenBinding);
        }
        let done = 0, lastProgress = 0;
        // A single progress message per item dominates large imports. Throttle
        // UI updates and yield only periodically so cancellation still works.
        const step = async () => {
          done++;
          const now = Date.now();
          if(done === total || now - lastProgress >= 100) {
            progress({done,total});
            lastProgress = now;
          }
          if(done % 20 === 0) await new Promise(resolve=>setTimeout(resolve,0));
        };
        for(const item of state.updates) {
          if(cancellation.cancelled) { report.cancelled = true; break; }
          if(api.currentPage.id !== page.id) throw new Error('当前页已改变，已停止导入，已完成的项会保留');
          const component = item.existing?.component;
          const category = plannedCategory(item, categoryConfig, learned).category;
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
            const category = plannedCategory(item, categoryConfig, learned).category;
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
        const nameKeys = new Map<string,number>();
        for(const item of [...state.adds,...state.updates]) {
          const key = plannedCategory(item, categoryConfig, learned).category + '\u0000' + item.source.frameName;
          nameKeys.set(key,(nameKeys.get(key)||0)+1);
        }
        // On a fresh page with unique category/name pairs, creation already
        // produced final names; avoid a second full-page rename pass.
        const hadManagedComponents = plan.unchanged + plan.updated + plan.removed + plan.blocked > 0;
        const needsNameRefresh = hadManagedComponents || state.updates.length > 0 ||
          [...nameKeys.values()].some(count=>count > 1);
        restoreCategoryLayouts(categoryLayouts);
        if(report.applied.added+report.applied.updated > 0 && needsNameRefresh) refreshDisplayNames(page,scan.project,report.messages);
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
      } finally {restoreCategoryLayouts(categoryLayouts); busy=false;}
    },
    async selection(project) {
      if(busy) throw new Error('任务执行中，请等待完成');
      if(!project || typeof project.id !== 'string' || !project.name) throw new Error('项目信息无效');
      const page = api.currentPage;
      await loadPage(page);
      const config = pageCategories(page);
      const found = new Map<string, SelectionState['members'][number]>();
      let ignored = 0;
      for(const node of page.selection) {
        let component: ComponentNode | undefined;
        let viaInstance = false;
        if(node.type === 'COMPONENT') component = node;
        else if(node.type === 'INSTANCE') {
          try { component = (await node.getMainComponentAsync()) || undefined; viaInstance = !!component; }
          catch { component = undefined; }
        }
        if(!component) { ignored++; continue; }
        const source = parseStoredSource(component, project);
        const host = hostPage(component);
        if(!source || !host || !validate(host, project).valid) { ignored++; continue; }
        const manual = manualCategory(component, config);
        const category = manual || currentCategory(component, config) ||
          automaticCategory(component, source, config, rulesFor(host, project.id).index);
        const member = {id:component.id,name:component.name,category,manual:!!manual,viaInstance};
        const previous = found.get(component.id);
        if(!previous) found.set(component.id, member);
        else if(viaInstance) previous.viaInstance = true;
      }
      const members = [...found.values()];
      return {schemaVersion:1,members,ignored,mixed:new Set(members.map(member=>member.category)).size > 1};
    },
    async setCategory(project, ids, category) {
      if(busy) throw new Error('任务执行中，请等待完成');
      if(!project || typeof project.id !== 'string' || !project.name) throw new Error('项目信息无效');
      const page = api.currentPage;
      await loadPage(page);
      // 分类合法性由当前页面的类别配置决定，而不是固定七类。
      if(category !== 'auto' && !knownCategory(pageCategories(page), category)) throw new Error('分类无效');
      if(!Array.isArray(ids) || !ids.length || ids.length > 200 ||
         ids.some(id=>typeof id !== 'string' || !/^[A-Za-z0-9:_;-]{1,128}$/.test(id))) throw new Error('主组件选择无效');
      busy = true;
      const createdFrames: FrameNode[] = [];
      const messages: string[] = [];
      try {
        const jobs: CategoryJob[] = [];
        for(const id of [...new Set(ids)]) {
          const node = await api.getNodeByIdAsync(id);
          if(!node || node.type !== 'COMPONENT') { messages.push(`${id}：不是主组件，已跳过`); continue; }
          const component = node as ComponentNode;
          const source = parseStoredSource(component, project);
          const host = hostPage(component);
          if(!source || !host || !validate(host, project).valid) {
            messages.push(`${component.name}：不是本项目资源页中的工具主组件，已跳过`);
            continue;
          }
          const hostConfig = categoriesFor(host);
          const learnedRules = rulesFor(host, project.id).index;
          const target = category === 'auto' ? automaticCategory(component, source, hostConfig, learnedRules) : knownCategory(hostConfig, category);
          if(!target) {
            messages.push(`${component.name}：该页面没有分类「${category}」，已跳过`);
            continue;
          }
          // 操作前的类别按与 selection 相同的优先级解析，并同时快照人工覆盖；
          // 撤销只按这份字符串写回，不会再次调用 classify。
          const manual = manualCategory(component, hostConfig);
          const previousCategory = manual || currentCategory(component, hostConfig) || automaticCategory(component, source, hostConfig, learnedRules);
          jobs.push({component, page:host, target, manualData:category === 'auto' ? '' : target,
            previousData:component.getPluginData(manualCategoryKey),
            previous:{id:component.id, category:previousCategory, manual:!!manual}});
        }
        if(!jobs.length) throw new Error('当前选择中没有可修改的本工具主组件');
        const outcome = applyCategoryJobs(api, project, jobs, createdFrames, messages, '分类移动失败');
        return {schemaVersion:1, action:category === 'auto' ? 'auto' : 'manual',
          updated:outcome.done.length, moved:outcome.moved, messages,
          previous:outcome.done.flatMap(job => job.previous ? [job.previous] : [])};
      } finally {
        busy = false;
      }
    },
    async restoreCategory(project, entries): Promise<CategoryRestoreResult> {
      if(busy) throw new Error('任务执行中，请等待完成');
      if(!project || typeof project.id !== 'string' || !project.name) throw new Error('项目信息无效');
      if(!Array.isArray(entries) || !entries.length || entries.length > 200 ||
         entries.some(entry=>!entry || typeof entry.id !== 'string' || !/^[A-Za-z0-9:_;-]{1,128}$/.test(entry.id) ||
           typeof entry.category !== 'string' || typeof entry.manual !== 'boolean')) throw new Error('撤销记录无效');
      const page = api.currentPage;
      await loadPage(page);
      busy = true;
      const createdFrames: FrameNode[] = [];
      const messages: string[] = [];
      let skipped = 0;
      try {
        const jobs: CategoryJob[] = [];
        for(const entry of entries) {
          const node = await api.getNodeByIdAsync(entry.id);
          if(!node || node.type !== 'COMPONENT') {
            skipped++; messages.push(`${entry.id}：主组件已不存在，已跳过`); continue;
          }
          const component = node as ComponentNode;
          const source = parseStoredSource(component, project);
          const host = hostPage(component);
          if(!source || !host || !validate(host, project).valid) {
            skipped++; messages.push(`${component.name}：不是本项目资源页中的工具主组件，已跳过`); continue;
          }
          const target = knownCategory(categoriesFor(host), entry.category);
          if(!target) {
            skipped++; messages.push(`${component.name}：该页面没有分类「${entry.category}」，已跳过`); continue;
          }
          // 原样写回人工覆盖：false 清除覆盖，但不再按自动规则推算新类别。
          jobs.push({component, page:host, target, manualData:entry.manual ? target : ''});
        }
        if(jobs.length) {
          const outcome = applyCategoryJobs(api, project, jobs, createdFrames, messages, '撤销恢复失败');
          skipped += outcome.failed;
          return {schemaVersion:1,restored:outcome.done.length,skipped,moved:outcome.moved,messages};
        }
        return {schemaVersion:1,restored:0,skipped,moved:0,messages};
      } finally {
        busy = false;
      }
    },
    async trainingSamples(project) {
      if(busy) throw new Error('任务执行中，请等待完成');
      if(!project || typeof project.id !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(project.id) ||
         typeof project.name !== 'string' || !project.name.trim() || project.name.length > 200) throw new Error('项目信息无效');
      const page = api.currentPage;
      await loadPage(page);
      const status = validate(page, project);
      if(!status.valid) throw new Error(status.message);
      const config = pageCategories(page);
      const samples: TrainingExport['samples'] = [];
      const seen = new Set<string>();
      let ignored = 0;
      // 只读当前资源页的主组件：人工覆盖非空且仍在页面类别配置里；
      // 身份取 atlas.source，不用显示名，也不继承导入时的损坏拦截。
      // 同一来源身份重复出现时只保留第一条，并计数告知调用方，不静默丢弃。
      for(const node of page.findAll(() => true)) {
        if(node.type !== 'COMPONENT') continue;
        const source = parseStoredSource(node, project);
        if(!source) continue;
        const category = manualCategory(node, config);
        if(!category) continue;
        if(seen.has(source.identity)) { ignored++; continue; }
        seen.add(source.identity);
        samples.push({identity:source.identity, category});
      }
      return {schemaVersion:1, projectId:project.id, samples, ignored};
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
        if(status.valid) return tidyCategoryFrames(page);
        const compare = parseCompareBinding(page.getPluginData(compareKey));
        if(compare?.projectId === project.id) return tidyCompareGroups(page);
        throw new Error(status.message);
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
