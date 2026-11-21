import type { Platform, PublicProject, Resource, Scan, Source } from './api';
const bindingKey = 'atlas.binding';
function pageName(project: PublicProject): string { return `${project.name}（${project.id}）- 分类资源`; }
function validate(page: PageNode, project: PublicProject) {
  let binding: {schemaVersion?:number;projectId?:string} | undefined;
  const raw = page.getPluginData(bindingKey);
  if(raw) {try {binding = JSON.parse(raw);} catch {return {valid:false,message:'页面绑定损坏，请使用新的空白页'};}}
  if(binding && (binding.schemaVersion !== 1 || binding.projectId !== project.id)) return {valid:false,message:'页面已绑定其他项目或不兼容版本'};
  if(binding && page.name !== pageName(project)) return {valid:false,message:'页面名称与绑定不符，请恢复为：'+pageName(project)};
  if(page.children.length) return {valid:false,message:binding ? '页面已有导入内容；本版本不支持增量，请使用新的空白页' : '非空且未绑定页面不可导入，请选择空白页'};
  return {valid:true,message:'空白页可导入，将绑定当前游戏'};
}
function safeName(name: unknown): name is string {
  return typeof name === 'string' && name.length > 0 && name.length <= 256 && !/[\\:\x00-\x1f]/.test(name) && !name.startsWith('/') && !name.split('/').includes('..');
}
function int(n: unknown, max = 2048): n is number {return Number.isInteger(n) && Number(n) >= 0 && Number(n) <= max;}
function sourceFor(resource: Resource, project: PublicProject): Source {
  const s = resource.source;
  if(!s || s.schemaVersion !== 1 || s.projectId !== project.id || s.kind !== 'atlas' || !safeName(s.relativePath) || s.relativePath.includes('/') || !safeName(s.frameName)) throw new Error('散图来源身份无效');
  const identity = JSON.stringify([project.id,'atlas',s.relativePath,s.frameName]);
  if(s.identity !== identity || !int(resource.width,1024) || !int(resource.height,1024) || !resource.width || !resource.height || !s.crop || !s.offset || !s.sourceSize || s.sourceSize.w !== resource.width || s.sourceSize.h !== resource.height || !Object.values(s.crop).every(n=>int(n)) || !int(s.crop.x) || !int(s.crop.y) || !int(s.crop.w) || !int(s.crop.h) || !s.crop.w || !s.crop.h || !int(s.offset.x) || !int(s.offset.y) || s.offset.x+s.crop.w>resource.width || s.offset.y+s.crop.h>resource.height || typeof resource.png !== 'string' || resource.png.length > 6*1024*1024) throw new Error('散图尺寸或来源数据无效');
  // Deliberate whitelist: no local paths, credentials or unknown helper fields enter the document.
  return {schemaVersion:1,projectId:project.id,kind:'atlas',relativePath:s.relativePath,frameName:s.frameName,identity,
    engineReference:`set:${s.relativePath} image:${s.frameName}`,sourceSize:{w:resource.width,h:resource.height},
    crop:{x:s.crop.x,y:s.crop.y,w:s.crop.w,h:s.crop.h},offset:{x:s.offset.x,y:s.offset.y}};
}
export function createFigmaPlatform(api: Pick<PluginAPI,'currentPage'|'createFrame'|'createComponent'|'createImage'|'base64Decode'>): Platform {
  let busy = false;
  return {
    async validate(project) {return validate(api.currentPage,project);},
    async importResources(scan: Scan, progress) {
      if(busy) throw new Error('导入任务正在执行');
      busy = true;
      const page = api.currentPage;
      let frame: FrameNode | undefined;
      let writtenName = '', writtenBinding = '';
      const oldName = page.name, oldBinding = page.getPluginData(bindingKey);
      try {
        if(scan.schemaVersion !== 1 || !scan.project || !/^[a-zA-Z0-9_-]{1,64}$/.test(scan.project.id) || typeof scan.project.name !== 'string' || !scan.project.name.trim() || scan.project.name.length > 200 || !Array.isArray(scan.resources) || !scan.resources.length || scan.resources.length > 64) throw new Error('扫描协议无效');
        const status = validate(page,scan.project);
        if(!status.valid) throw new Error(status.message);
        const sources = scan.resources.map(r=>sourceFor(r,scan.project));
        if(new Set(sources.map(s=>s.identity)).size !== sources.length) throw new Error('扫描包含重复资源身份');
        frame = api.createFrame(); page.appendChild(frame); frame.name = '未分类'; frame.fills = [];
        frame.resize(1200,100); frame.layoutMode = 'HORIZONTAL'; frame.layoutWrap = 'WRAP';
        frame.primaryAxisSizingMode = 'FIXED'; frame.counterAxisSizingMode = 'AUTO';
        frame.itemSpacing = 16; frame.counterAxisSpacing = 16;
        frame.paddingTop = frame.paddingRight = frame.paddingBottom = frame.paddingLeft = 16;
        writtenName = pageName(scan.project);
        writtenBinding = JSON.stringify({schemaVersion:1,projectId:scan.project.id});
        page.name = writtenName;
        page.setPluginData(bindingKey,writtenBinding);
        progress({done:0,total:scan.resources.length});
        for(let i=0;i<scan.resources.length;i++) {
          if(api.currentPage.id !== page.id) throw new Error('当前页已改变，已撤销本次导入');
          const resource = scan.resources[i], source = sources[i];
          const image = api.createImage(api.base64Decode(resource.png));
          const component = api.createComponent();
          frame.appendChild(component);
          component.name = `未分类/${source.frameName} · ${source.relativePath}`;
          component.resize(resource.width,resource.height);
          component.fills = [{type:'IMAGE',imageHash:image.hash,scaleMode:'FILL'}];
          component.setPluginData('atlas.source',JSON.stringify(source));
          progress({done:i+1,total:scan.resources.length});
          await new Promise(resolve=>setTimeout(resolve,0));
        }
        if(api.currentPage.id !== page.id) throw new Error('当前页已改变，已撤销本次导入');
      } catch(error) {
        if(frame) {
          frame.remove();
          // Roll back our writes only; preserve concurrent edits made by the user.
          if(page.name === writtenName)page.name=oldName;
          if(page.getPluginData(bindingKey) === writtenBinding)page.setPluginData(bindingKey,oldBinding);
        }
        throw error;
      } finally {busy=false;}
    }
  };
}
