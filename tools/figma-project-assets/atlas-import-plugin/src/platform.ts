import type { ImportPlan, Platform, Progress, PublicProject, Resource, Scan, Source } from './api';
const bindingKey = 'atlas.binding';
const sourceKey = 'atlas.source';
const syncKey = 'atlas.sync.v1';
const categoryKey = 'atlas.category';
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
type SyncState = {
  schemaVersion: 1; identity: string; contentHash: string; imageHash?: string;
  sourceSize: { w: number; h: number }; status: 'current' | 'source-missing';
};
type Existing = { component: ComponentNode; source: Source; sync?: SyncState; blocked?: string };
type Candidate = { resource: Resource; source: Source; hash: string; existing?: Existing };
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
function isSimpleComponent(component: ComponentNode): boolean {
  return Array.isArray(component.children) && component.children.length === 0 &&
    Array.isArray(component.fills) && component.fills.length === 1 && component.fills[0].type === 'IMAGE';
}
function managedCategory(node: ComponentNode): boolean {
  const parent = node.parent;
  if(!parent || parent.type !== 'FRAME' || parent.name !== '未分类') return false;
  return parent.getPluginData(categoryKey) === 'unsorted' || parent.children.some(child => child.getPluginData(sourceKey));
}
function existingComponents(page: PageNode, project: PublicProject): { items: Existing[]; corrupt: string[] } {
  const result: Existing[] = [], corrupt: string[] = [];
  for(const node of page.findAll(() => true)) {
    if(node.type !== 'COMPONENT') continue;
    const source = parseStoredSource(node, project);
    if(!source) {
      if(node.getPluginData(sourceKey) || managedCategory(node)) corrupt.push(node.name);
      continue;
    }
    const sync = parseSync(node,source.identity);
    const imageHash = Array.isArray(node.fills) && node.fills.length === 1 && node.fills[0].type === 'IMAGE' ? node.fills[0].imageHash : undefined;
    const blocked = !isSimpleComponent(node) ? '内部结构已修改或不是普通图片组件，已跳过'
      : sync?.imageHash && imageHash && sync.imageHash !== imageHash ? '图片填充已被手动修改，已跳过'
      : sync && Array.isArray(node.fills) && node.fills[0]?.type === 'IMAGE' && node.fills[0].scaleMode !== 'FILL' ? '图片填充缩放方式已被手动修改，已跳过' : undefined;
    result.push({component:node,source,sync,blocked});
  }
  return {items:result,corrupt};
}
function buildPlan(scan: Scan, page: PageNode): PlanState {
  if(scan.schemaVersion !== 2 || !scan.project || !/^[a-zA-Z0-9_-]{1,64}$/.test(scan.project.id) ||
     typeof scan.project.name !== 'string' || !scan.project.name.trim() || scan.project.name.length > 200 ||
     !Array.isArray(scan.resources) || scan.resources.length > 20000 || typeof scan.complete !== 'boolean') throw new Error('扫描协议版本不兼容');
  const plan: ImportPlan = {schemaVersion:1,added:0,updated:0,removed:0,unchanged:0,blocked:0,removalSuppressed:false,messages:[]};
  const messages = new Set<string>();
  const parsed = existingComponents(page, scan.project);
  if(parsed.corrupt.length) throw new Error('存在来源记录损坏的组件，已停止增量导入；请修复或移除后重试：' + parsed.corrupt.join('、'));
  const existing = parsed.items;
  const groups = new Map<string, Existing[]>();
  for(const item of existing) {
    if(!item.source.identity) continue;
    const group = groups.get(item.source.identity) || [];
    group.push(item); groups.set(item.source.identity, group);
  }
  for(const [identity, group] of groups) {
    if(group.length > 1) for(const item of group) {
      item.blocked = '存在重复来源组件，已跳过';
      messages.add(`${item.component.name}：${item.blocked}`);
    }
  }
  const scanItems = new Map<string, Candidate>();
  for(const resource of scan.resources) {
    const source = sourceFor(resource, scan.project);
    if(scanItems.has(source.identity)) throw new Error('扫描包含重复资源身份');
    scanItems.set(source.identity,{resource,source,hash:contentHash(resource,source)});
    const group = groups.get(source.identity);
    if(group && group.length === 1 && !group[0].blocked) scanItems.get(source.identity)!.existing = group[0];
  }
  for(const item of scanItems.values()) {
    const group = groups.get(item.source.identity);
    if(!group) {plan.added++; continue;}
    const target = group[0];
    if(target.blocked || group.length !== 1) {
      plan.blocked++;
      messages.add(`${target.component.name}：${target.blocked || '存在重复来源组件，已跳过'}`);
      continue;
    }
    if(isUnchanged(target,item)) plan.unchanged++;
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
      return !!group && group.length === 1 && !group[0].blocked && !isUnchanged(group[0], item);
    }),
    removals: [...groups.values()].filter(group => group.length === 1 && !group[0].blocked &&
      !scanItems.has(group[0].source.identity) && scan.complete).map(group => group[0])
  };
}
function isUnchanged(existing: Existing, item: Candidate): boolean {
  return !!existing.sync && existing.sync.status === 'current' && existing.sync.contentHash === item.hash &&
    existing.sync.sourceSize.w === item.resource.width && existing.sync.sourceSize.h === item.resource.height &&
    existing.component.width === item.resource.width && existing.component.height === item.resource.height;
}
function categoryFrame(page: PageNode): FrameNode | undefined {
  return page.children.find(node => {
    if(node.type !== 'FRAME' || node.name !== '未分类') return false;
    if(node.getPluginData(categoryKey) === 'unsorted') return true;
    // Legacy #3 frames have no category marker; identify them by their managed children.
    return Array.isArray(node.children) && node.children.some(child => child.getPluginData(sourceKey));
  }) as FrameNode | undefined;
}
function ensureCategoryFrame(page: PageNode, api: Pick<PluginAPI,'createFrame'>): FrameNode {
  const found = categoryFrame(page);
  if(found) return found;
  const frame = api.createFrame();
  page.appendChild(frame);
  frame.name = '未分类';
  frame.fills = [];
  frame.resize(1200,100); frame.layoutMode = 'HORIZONTAL'; frame.layoutWrap = 'WRAP';
  frame.primaryAxisSizingMode = 'FIXED'; frame.counterAxisSizingMode = 'AUTO';
  frame.itemSpacing = 16; frame.counterAxisSpacing = 16;
  frame.paddingTop = frame.paddingRight = frame.paddingBottom = frame.paddingLeft = 16;
  frame.setPluginData(categoryKey,'unsorted');
  return frame;
}
function writeSync(component: ComponentNode, item: Candidate, imageHash: string): void {
  const sync: SyncState = {schemaVersion:1,identity:item.source.identity,contentHash:item.hash,imageHash,
    sourceSize:{w:item.resource.width,h:item.resource.height},status:'current'};
  component.setPluginData(syncKey,JSON.stringify(sync));
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
function updateComponent(component: ComponentNode, item: Candidate, image: ImagePaint): void {
  component.resize(item.resource.width,item.resource.height);
  component.fills = [{...image,scaleMode:'FILL'}];
  component.setPluginData(sourceKey,JSON.stringify(item.source));
  writeSync(component,item,image.imageHash || '');
}
function createComponent(api: Pick<PluginAPI,'createComponent'>, target: FrameNode, item: Candidate, image: ImagePaint): ComponentNode {
  const component = api.createComponent();
  target.appendChild(component);
  component.name = `未分类/${item.source.frameName} · ${item.source.relativePath}`;
  component.resize(item.resource.width,item.resource.height);
  component.fills = [{...image,scaleMode:'FILL'}];
  component.setPluginData(sourceKey,JSON.stringify(item.source));
  writeSync(component,item,image.imageHash || '');
  return component;
}
async function loadPage(page: PageNode): Promise<void> {
  // dynamic-page documents require explicit loading before findAll().
  if(typeof page.loadAsync === 'function') await page.loadAsync();
}
export function createFigmaPlatform(api: Pick<PluginAPI,'currentPage'|'createFrame'|'createComponent'|'createImage'|'base64Decode'>): Platform {
  let busy = false;
  return {
    async validate(project) {return validate(api.currentPage,project);},
    async preview(scan) {
      if(busy) throw new Error('导入任务正在执行');
      const page = api.currentPage;
      await loadPage(page);
      return buildPlan(scan,page).plan;
    },
    async importResources(scan, progress) {
      if(busy) throw new Error('导入任务正在执行');
      busy = true;
      const page = api.currentPage;
      const oldName = page.name, oldBinding = page.getPluginData(bindingKey);
      let frame: FrameNode | undefined;
      let createdFrame = false;
      let writtenName = '', writtenBinding = '';
      const created: ComponentNode[] = [];
      const updated: Array<{component: ComponentNode; width: number; height: number; fills: Paint[]; source: string; sync: string}> = [];
      const marked: Array<{component: ComponentNode; sync: string}> = [];
      let instances: InstanceSize[] = [];
      let updatedIds = new Set<string>();
      try {
        await loadPage(page);
        if(api.currentPage.id !== page.id) throw new Error('当前页已改变，请重新扫描');
        const status = validate(page,scan.project);
        if(!status.valid) throw new Error(status.message);
        const state = buildPlan(scan,page);
        const plan = state.plan;
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
        for(const item of state.updates) {
          if(api.currentPage.id !== page.id) throw new Error('当前页已改变，已撤销本次导入');
          const component = item.existing?.component;
          if(!component) throw new Error('待更新组件已消失');
          updated.push({component,width:component.width,height:component.height,fills:Array.isArray(component.fills) ? [...component.fills] : [],
            source:component.getPluginData(sourceKey),sync:component.getPluginData(syncKey)});
          const image = api.createImage(api.base64Decode(item.resource.png));
          updateComponent(component,item,{type:'IMAGE',imageHash:image.hash,scaleMode:'FILL'});
          progress({done:++done,total});
          await new Promise(resolve=>setTimeout(resolve,0));
        }
        if(state.adds.length) {
          const found = categoryFrame(page);
          frame = found || ensureCategoryFrame(page,api);
          createdFrame = !found;
        }
        for(const item of state.adds) {
          if(api.currentPage.id !== page.id) throw new Error('当前页已改变，已撤销本次导入');
          const image = api.createImage(api.base64Decode(item.resource.png));
          const component = createComponent(api,frame!,item,{type:'IMAGE',imageHash:image.hash,scaleMode:'FILL'});
          created.push(component);
          progress({done:++done,total});
          await new Promise(resolve=>setTimeout(resolve,0));
        }
        for(const item of state.removals) {
          if(api.currentPage.id !== page.id) throw new Error('当前页已改变，已撤销本次导入');
          marked.push({component:item.component,sync:item.component.getPluginData(syncKey)});
          markMissing(item);
          progress({done:++done,total});
          await new Promise(resolve=>setTimeout(resolve,0));
        }
        restoreInstances(instances, updatedIds);
        return plan;
      } catch(error) {
        for(const snapshot of updated) {
          snapshot.component.resize(snapshot.width,snapshot.height);
          snapshot.component.fills = snapshot.fills;
          snapshot.component.setPluginData(sourceKey,snapshot.source);
          snapshot.component.setPluginData(syncKey,snapshot.sync);
        }
        for(const snapshot of marked) snapshot.component.setPluginData(syncKey,snapshot.sync);
        restoreInstances(instances, updatedIds);
        for(const component of created) component.remove();
        if(createdFrame && frame) frame.remove();
        // Roll back our writes only; preserve concurrent edits made by the user.
        if(page.name === writtenName)page.name=oldName;
        if(page.getPluginData(bindingKey) === writtenBinding)page.setPluginData(bindingKey,oldBinding);
        throw error;
      } finally {busy=false;}
    }
  };
}
