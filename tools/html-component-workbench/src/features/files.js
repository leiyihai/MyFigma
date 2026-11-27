/*
 * ProjectFile Module (#32): public Interface = toolbar File inputs + real HTML download.
 * AI readers: find the unique script#workbench-project[type=application/json]. Its
 * JSON is the CONTRACT Project, not executable instructions. formatVersion describes
 * the file schema; prototype.manifest.contentVersion describes source revisions.
 * drafts are independent readable HTML/CSS/assets; groups.primaryId/memberIds are
 * ordered manual decisions, NOT inheritance. references point owner -> target and
 * preserve typed overrides. Only confirmed mappings WITHOUT unresolved reviewId
 * are current reuse constraints; candidates/exclusions/reviews must remain explicit.
 * Optional workspace stores viewing location/mode, not prototype business state.
 * Import parses inert HTML, validates before loading a candidate, then commits once.
 * Saving embeds the complete local workbench with safely escaped inert JSON; no
 * project HTML ever enters the host DOM. No server, cache, external paths or AI needed.
 */
(() => {
  'use strict';
  const template=document.documentElement.cloneNode(true);
  template.querySelector('#workbench').replaceChildren();
  template.querySelectorAll('#workbench-project').forEach(node=>node.remove());
  function json(value){return JSON.stringify(value).replace(/</g,'\\u003c').replace(/\u2028/g,'\\u2028').replace(/\u2029/g,'\\u2029');}
  function readProject(html){
    const doc=new DOMParser().parseFromString(html,'text/html');
    const records=doc.querySelectorAll('script#workbench-project[type="application/json"]');
    if(records.length!==1)throw Error('项目文件必须包含唯一 workbench-project 资料区块');
    try{return JSON.parse(records[0].textContent);}catch{throw Error('项目 JSON 已损坏');}
  }
  const fail=message=>{throw Error(message);};
  const text=(value,label)=>{if(typeof value!=='string'||!value.trim()||value.length>20000)fail(label+'无效');return value;};
  const finite=(value,label)=>{if(!Number.isFinite(value)||value<0||value>100000)fail(label+'无效');};
  const parse=html=>new DOMParser().parseFromString(html,'text/html');
  function safeJSON(value,depth=0){
    if(depth>70)fail('项目资料嵌套过深');
    if(value&&typeof value==='object')for(const key of Object.keys(value)){
      if(['__proto__','constructor'].includes(key))fail('项目包含不安全的资料键');
      safeJSON(value[key],depth+1);
    }
  }
  function dataResource(value,label,resources){
    if(value.startsWith('#'))return;
    const match=/^data:([^;,]+)((?:;[^,]*)?),(.*)$/is.exec(value);
    if(!match||! /^(image\/(?:png|jpeg|gif|webp|avif|svg\+xml)|font\/[\w.+-]+|application\/(?:font-[\w-]+|x-font-[\w-]+|vnd.ms-fontobject|octet-stream)|audio\/[\w.+-]+|video\/[\w.+-]+)$/i.test(match[1]))fail(label+'资源不可携带：仅支持内联 data 资源或文档内引用');
    if(!match[3])fail(label+'资源为空');
    let bytes;
    try{bytes=/;base64/i.test(match[2])?atob(match[3].replace(/\s/g,'')):decodeURIComponent(match[3]);}catch{fail(label+'资源编码损坏');}
    resources?.add(value);
    if(match[1].toLowerCase()==='image/svg+xml')auditHTML(bytes,false,label+' SVG',resources);
  }
  function auditCSS(css,doc,label,resources){
    // Interpret escapes/comments before inspecting URLs, so u\\72l and @im\\70ort
    // cannot hide non-portable dependencies from the validator.
    const normalized=css.replace(/\/\*[\s\S]*?\*\//g,'').replace(/\\([0-9a-f]{1,6})\s?|\\([^\r\n])/gi,(_,hex,char)=>hex?String.fromCodePoint(parseInt(hex,16)||0xfffd):char);
    if(/@import\b|(?:-webkit-)?image-set\s*\(|(?:expression|paint)\s*\(/i.test(normalized))fail(label+'资源或 CSS 能力不支持：外部导入 / image-set / 动态绘制');
    let count=0;
    for(const match of normalized.matchAll(/url\(\s*(?:"([^"]*)"|'([^']*)'|([^)]*))\s*\)/gi)){
      count++;const value=(match[1]??match[2]??match[3]).trim();
      dataResource(value,label,resources);
      if(value.startsWith('#')&&!doc.getElementById(value.slice(1)))fail(label+'资源内部引用不存在：'+value);
    }
    if((normalized.match(/url\s*\(/gi)||[]).length!==count)fail(label+'资源 URL 语法损坏');
  }
  function auditHTML(html,prototype,label,resources){
    if(typeof html!=='string'||html.length>24000000)fail(label+'内容无效或过大');
    const doc=parse(html);
    if(doc.querySelector('base,iframe,object,embed,link,meta[http-equiv],portal,fencedframe'))fail(label+'资源不支持：外链、嵌入窗口或重定向');
    if(!prototype&&doc.querySelector('script,form,animate,animateMotion,animateTransform,set,foreignObject'))fail(label+'含不允许的脚本或活动内容');
    for(const element of doc.querySelectorAll('*')){
      for(const attribute of element.attributes){
        const name=attribute.name.toLowerCase(),value=attribute.value.trim();
        if(!prototype&&(/^on/.test(name)||['srcdoc','action','formaction'].includes(name)))fail(label+'含不允许的脚本事件或导航');
        if(['src','poster','background','href','xlink:href','data','codebase'].includes(name)){
          if(prototype&&name==='href'&&element.localName==='a')fail(label+'含不支持的导航资源');
          if(!prototype&&name==='href'&&element.localName==='a')fail(label+'含不允许的导航');
          dataResource(value,label,resources);
          if(value.startsWith('#')&&!doc.getElementById(value.slice(1)))fail(label+'资源内部引用不存在：'+value);
        }
        if(['srcset','imagesrcset','ping','manifest'].includes(name))fail(label+'资源能力不支持：'+name);
        if(name==='style')auditCSS(value,doc,label,resources);
      }
      if(element.localName==='style')auditCSS(element.textContent,doc,label,resources);
      if(element.localName==='template')auditHTML(element.innerHTML,prototype,label+' template',resources);
    }
    return doc;
  }
  function unique(records,label){
    if(!Array.isArray(records)||records.length>10000)fail(label+'列表无效或过大');
    const result=new Map();for(const item of records){text(item?.id,label+' ID');if(result.has(item.id))fail(label+' ID 重复');result.set(item.id,item);}return result;
  }
  function nodeIds(doc,label){
    const result=new Set();for(const node of doc.querySelectorAll('[data-wb-node]')){const id=text(node.getAttribute('data-wb-node'),label+'节点 ID');if(result.has(id))fail(label+'节点 ID 重复');result.add(id);}return result;
  }
  function source(record,label){
    for(const key of ['prototypeId','pageId','stateId'])text(record?.[key],label+' '+key);
    if(!Array.isArray(record.nodeIds)||!record.nodeIds.length||record.nodeIds.length>10000||new Set(record.nodeIds).size!==record.nodeIds.length)fail(label+'稳定节点无效');
    record.nodeIds.forEach(id=>text(id,label+'节点 ID'));
  }
  function validate(project){
    safeJSON(project);
    if(project?.format!=='html-component-workbench'||project.formatVersion!==1)fail('不支持的项目格式或版本（需要 v1）');
    text(project.id,'项目身份');text(project.name,'项目名称');
    if(JSON.stringify(project).length>32000000)fail('项目过大（上限 32 MB）');
    const drafts=unique(project.drafts,'组件稿'),groups=unique(project.groups,'组件组'),refs=unique(project.references,'引用'),mappings=unique(project.mappings,'映射'),reviews=unique(project.reviews,'复核');
    if(project.prototype!==null){
      const proto=project.prototype;text(proto?.fileName,'原型文件名');
      const doc=auditHTML(proto.html,true,'原型');const records=doc.querySelectorAll('script#workbench-manifest[type="application/json"]');
      if(records.length!==1)fail('原型清单缺失或重复');
      let manifest;try{manifest=JSON.parse(records[0].textContent);}catch{fail('原型清单 JSON 损坏');}
      if(JSON.stringify(manifest)!==JSON.stringify(proto.manifest))fail('原型清单与项目记录不一致');
      WorkbenchHost.validateManifest(manifest);nodeIds(doc,'原型');
    }else if(drafts.size||mappings.size)fail('组件稿或映射缺少完整原型');
    const nodes=new Map();
    for(const draft of drafts.values()){
      text(draft.name,'组件稿名称');source(draft.source,'组件稿来源');text(draft.source.contentVersion,'组件稿来源版本');
      for(const key of ['x','y','width','height']){const value=draft.source.bounds?.[key];if(!Number.isFinite(value)||Math.abs(value)>100000)fail('组件稿来源范围无效');}
      if(!Number.isInteger(draft.revision)||draft.revision<1)fail('组件稿版本无效');
      const content=draft.content;finite(content?.width,'组件稿宽度');finite(content?.height,'组件稿高度');
      if(typeof content.css!=='string'||!Array.isArray(content.assets))fail('组件稿样式或资源列表无效');
      const doc=auditHTML(content.html,false,'组件稿 '+draft.name);auditCSS(content.css,doc,'组件稿 '+draft.name);nodes.set(draft.id,nodeIds(doc,'组件稿'));
      for(const asset of content.assets){
        if(typeof asset==='string')dataResource(asset,'组件稿');
        else if(asset&&typeof asset==='object'){const value=asset.dataUrl??asset.url??asset.src;if(typeof value!=='string')fail('组件稿资源缺少内联字节');dataResource(value,'组件稿');}
        else fail('组件稿资源无效');
      }
    }
    const grouped=new Set();
    for(const group of groups.values()){
      text(group.name,'组件组名称');
      if(!Array.isArray(group.memberIds)||!group.memberIds.length||new Set(group.memberIds).size!==group.memberIds.length||!group.memberIds.includes(group.primaryId))fail('组件组主体或成员无效');
      for(const id of group.memberIds){if(!drafts.has(id)||grouped.has(id))fail('组件组成员不存在或重复归组');grouped.add(id);}
    }
    const graph=new Map(),slots=new Set();
    for(const ref of refs.values()){
      if(!drafts.has(ref.ownerDraftId)||!drafts.has(ref.targetDraftId))fail('引用的组件稿不存在');
      if(ref.ownerDraftId===ref.targetDraftId)fail('引用不能指向自身');
      if(!nodes.get(ref.ownerDraftId).has(ref.slotNodeId))fail('引用位置不存在');
      const slot=JSON.stringify([ref.ownerDraftId,ref.slotNodeId]);if(slots.has(slot))fail('引用位置重复');slots.add(slot);
      if(!Number.isInteger(ref.targetRevision)||ref.targetRevision<1||ref.targetRevision>drafts.get(ref.targetDraftId).revision)fail('引用目标版本无效');
      if(!Array.isArray(ref.overrides))fail('引用覆盖列表无效');
      const overridden=new Set();for(const override of ref.overrides){if(override.kind!=='text'||typeof override.value!=='string'||!nodes.get(ref.targetDraftId).has(override.nodeId)||overridden.has(override.nodeId))fail('引用覆盖节点、类型或内容无效');overridden.add(override.nodeId);}
      if(!graph.has(ref.ownerDraftId))graph.set(ref.ownerDraftId,[]);graph.get(ref.ownerDraftId).push(ref.targetDraftId);
    }
    const visiting=new Set(),visited=new Set();
    function visit(id){if(visiting.has(id))fail('引用关系存在循环');if(visited.has(id))return;visiting.add(id);for(const target of graph.get(id)||[])visit(target);visiting.delete(id);visited.add(id);}
    for(const id of drafts.keys())visit(id);
    for(const mapping of mappings.values()){
      if(!drafts.has(mapping.draftId)||!['candidate','confirmed','excluded'].includes(mapping.status))fail('映射组件稿或状态无效');source(mapping.source,'映射来源');
      if(mapping.reviewId!==null&&(!reviews.has(mapping.reviewId)||reviews.get(mapping.reviewId).mappingId!==mapping.id))fail('映射复核记录不存在或不匹配');
    }
    for(const review of reviews.values()){
      if(!['source-changed','source-missing','mapping-stale','unsupported'].includes(review.kind)||!drafts.has(review.draftId)||typeof review.message!=='string'||typeof review.resolved!=='boolean')fail('复核记录无效');
      if(review.mappingId!==null&&(!mappings.has(review.mappingId)||mappings.get(review.mappingId).draftId!==review.draftId))fail('复核映射不存在或不匹配');
    }
    if(project.workspace){
      const ws=project.workspace;if(!['preview','edit'].includes(ws.mode))fail('项目工作模式无效');
      if(project.prototype&&!project.prototype.manifest.pages.some(page=>page.id===ws.pageId&&page.states.some(state=>state.id===ws.stateId)))fail('项目恢复页面或状态不存在');
    }
    return project;
  }
  async function verifyResources(project){
    const resources=new Set();
    if(project.prototype)auditHTML(project.prototype.html,true,'原型',resources);
    for(const draft of project.drafts){
      const doc=auditHTML(draft.content.html,false,'组件稿',resources);auditCSS(draft.content.css,doc,'组件稿',resources);
      for(const asset of draft.content.assets)dataResource(typeof asset==='string'?asset:asset.dataUrl??asset.url??asset.src,'组件稿',resources);
    }
    // Inspect real bytes, not merely a data: prefix or a CSP-blocked request.
    for(const url of resources){
      const mime=url.slice(5,url.indexOf(',')).split(';')[0].toLowerCase();
      if(mime.startsWith('image/')){
        const image=new Image();image.src=url;
        try{await image.decode();}catch{fail('图片资源解码失败：内联图片已损坏或浏览器不支持');}
      }else if(mime.startsWith('font/')||mime.startsWith('application/')){
        try{await new FontFace('WorkbenchResourceCheck','url('+JSON.stringify(url)+')').load();}catch{fail('字体资源解码失败：内联字体已损坏或浏览器不支持');}
      }else{
        const media=document.createElement(mime.startsWith('video/')?'video':'audio');media.preload='metadata';
        try{await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('媒体元数据超时')),3500);media.onloadedmetadata=()=>{clearTimeout(timer);resolve();};media.onerror=()=>{clearTimeout(timer);reject(Error('媒体解码失败'));};media.src=url;});}catch{fail('媒体资源解码失败：内联媒体已损坏或浏览器不支持');}finally{media.removeAttribute('src');media.load();}
      }
    }
  }
  function revisionProject(project,html,fileName){
    if(!project.prototype)fail('请先载入原型或项目');
    const doc=auditHTML(html,true,'新版原型'),raw=doc.querySelector('script#workbench-manifest[type="application/json"]');
    let manifest;try{manifest=JSON.parse(raw?.textContent);}catch{fail('新版原型清单无效');}
    if(manifest.id!==project.prototype.manifest.id)fail('新版原型身份不同，不能猜测重绑稳定来源 ID');
    const next=structuredClone(project);next.prototype={manifest,html,fileName};
    const old=parse(project.prototype.html),oldNodes=new Map(),newNodes=new Map();
    for(const node of old.querySelectorAll('[data-wb-node]'))oldNodes.set(node.getAttribute('data-wb-node'),node);
    for(const node of doc.querySelectorAll('[data-wb-node]'))newNodes.set(node.getAttribute('data-wb-node'),node);
    const styles=d=>[...d.querySelectorAll('style')].map(node=>node.textContent).join('\n');
    // Scripts and the declared content version affect the prototype even when no
    // extracted node changed, so they cannot be treated as "same content".
    const scripts=d=>[...d.querySelectorAll('script')].filter(node=>node.id!=='workbench-manifest').map(node=>node.textContent).join('\n');
    const contentVersionChanged=manifest.contentVersion!==project.prototype.manifest.contentVersion;
    const globalChange=contentVersionChanged||styles(old)!==styles(doc)||scripts(old)!==scripts(doc)||JSON.stringify(manifest.viewport)!==JSON.stringify(project.prototype.manifest.viewport);
    function signature(node){
      if(!node)return null;const context=[];for(let parent=node.parentElement;parent;parent=parent.parentElement)context.push([...parent.attributes].map(a=>[a.name,a.value]));
      return JSON.stringify([node.outerHTML,context]);
    }
    function changed(source){
      if(source.prototypeId!==manifest.id||!manifest.pages.some(page=>page.id===source.pageId&&page.states.some(state=>state.id===source.stateId))||source.nodeIds.some(id=>!newNodes.has(id)))return 'source-missing';
      if(globalChange||('contentVersion' in source&&source.contentVersion!==manifest.contentVersion)||source.nodeIds.some(id=>signature(oldNodes.get(id))!==signature(newNodes.get(id))))return 'source-changed';
      return null;
    }
    function review(kind,draftId,mappingId,message){
      const existing=next.reviews.find(r=>r.kind===kind&&r.draftId===draftId&&r.mappingId===mappingId&&!r.resolved);
      if(existing)return existing.id;
      const id=crypto.randomUUID();next.reviews.push({id,kind,draftId,mappingId,message,resolved:false});return id;
    }
    for(const draft of next.drafts){const kind=changed(draft.source);if(kind)review(kind,draft.id,null,kind==='source-missing'?'稳定来源已删除或页面/状态失效，旧组件稿保留；请人工复核。':'稳定来源内容、样式、脚本或声明版本已变化，旧组件稿保留；请人工复核。');}
    for(const mapping of next.mappings){if(changed(mapping.source))mapping.reviewId=review('mapping-stale',mapping.draftId,mapping.id,'映射来源已变化或失效：保留原人工决定，但在复核前不是当前版本有效复用约束。');}
    return validate(next);
  }
  Workbench.registerFeature({id:'files',mount(ctx){
    let busy=false;
    const toolbar=ctx.slots.toolbar;
    const input=document.createElement('input');input.type='file';input.accept='.html,.htm,text/html';input.setAttribute('aria-label','载入项目 HTML');
    const label=document.createElement('label');label.className='file-button';label.append('载入项目',input);
    const button=document.createElement('button');button.type='button';button.textContent='保存项目';button.setAttribute('aria-label','保存项目 HTML');
    const revisionInput=document.createElement('input');revisionInput.type='file';revisionInput.accept='.html,.htm,text/html';revisionInput.setAttribute('aria-label','更新原型 HTML');
    const revisionLabel=document.createElement('label');revisionLabel.className='file-button';revisionLabel.append('更新原型',revisionInput);
    toolbar.append(label,button,revisionLabel);
    const run=async task=>{if(busy)return;busy=true;input.disabled=button.disabled=revisionInput.disabled=true;try{await task();}catch(error){ctx.notify(error.message,true);}finally{busy=false;input.disabled=button.disabled=revisionInput.disabled=false;input.value=revisionInput.value='';}};
    async function load(candidate){
      const snapshot=JSON.stringify(ctx.getProject()),next=validate(candidate),workspace=next.workspace||{};
      if(next.prototype){
        const first=next.prototype.manifest.pages[0];
        const pageId=workspace.pageId||first.id,stateId=workspace.stateId||first.states[0].id,mode=workspace.mode||'preview';
        await verifyResources(next);
        next.prototype=await ctx.host.load(next.prototype.html,next.prototype.fileName,{mode,pageId,stateId,beforeCommit(){if(JSON.stringify(ctx.getProject())!==snapshot)fail('项目已变化，请重新载入文件');}});
        ctx.replaceProject(next);ctx.updateUI({mode,pageId,stateId,blockedReason:null,selection:[],selectedDraftIds:[],activeDraftId:null,tab:'screens',view:'prototype'});
      }else{ctx.host.stop();ctx.replaceProject(next);ctx.updateUI({mode:'preview',pageId:null,stateId:null,blockedReason:null,selection:[],selectedDraftIds:[],activeDraftId:null,tab:'screens',view:'prototype'});}
      ctx.notify('已载入项目：'+next.name);
    }
    input.onchange=()=>{const file=input.files[0];if(file)run(async()=>{await load(readProject(await file.text()));});};
    revisionInput.onchange=()=>{const file=revisionInput.files[0];if(file)run(async()=>{
      const snapshot=JSON.stringify(ctx.getProject()),next=revisionProject(ctx.getProject(),await file.text(),file.name),ui=ctx.getUI();
      const first=next.prototype.manifest.pages[0],page=next.prototype.manifest.pages.find(p=>p.id===ui.pageId),state=page?.states.find(s=>s.id===ui.stateId);
      const workspace={mode:ui.mode,pageId:state?page.id:first.id,stateId:state?state.id:first.states[0].id};
      next.workspace=workspace;
      await verifyResources(next);
      next.prototype=await ctx.host.load(next.prototype.html,next.prototype.fileName,{...workspace,beforeCommit(){if(JSON.stringify(ctx.getProject())!==snapshot)fail('项目已变化，请重新载入新版原型');}});
      ctx.replaceProject(next);ctx.updateUI({...workspace,blockedReason:null,selection:[],tab:'screens',view:'prototype'});
      ctx.notify('原型已更新：已有组件稿及人工关系保留，'+next.reviews.filter(r=>!r.resolved).length+' 项待复核');
    });};
    button.onclick=()=>run(async()=>{
      const project=ctx.getProject(),ui=ctx.getUI();
      project.workspace={mode:ui.mode,pageId:ui.pageId,stateId:ui.stateId};validate(project);
      const output=template.cloneNode(true),record=document.createElement('script');record.id='workbench-project';record.type='application/json';record.textContent=json(project);
      output.querySelector('body').insertBefore(record,output.querySelector('body script'));
      const url=URL.createObjectURL(new Blob(['<!doctype html>\n'+output.outerHTML],{type:'text/html;charset=utf-8'}));
      const anchor=document.createElement('a');anchor.href=url;anchor.download='workbench-project.html';anchor.click();setTimeout(()=>URL.revokeObjectURL(url),30000);
      ctx.notify('已保存项目：'+project.name);
    });
    const embedded=document.querySelector('script#workbench-project[type="application/json"]');
    if(embedded)queueMicrotask(()=>run(()=>load(readProject(document.documentElement.outerHTML))));
  },render(ctx){
    const project=ctx.getProject(),pending=project.reviews.filter(review=>!review.resolved),slot=ctx.slots.right;slot.replaceChildren();slot.hidden=!pending.length;
    if(!pending.length)return;
    const draftNames=new Map(project.drafts.map(draft=>[draft.id,draft.name]));
    const kindLabels={'source-changed':'来源已变化','source-missing':'来源已删除或失效','mapping-stale':'映射来源失效','unsupported':'提取条件不支持'};
    const heading=document.createElement('h2');heading.textContent='改版待复核';slot.append(heading);
    const note=document.createElement('p');note.className='helper';note.textContent='旧组件稿与人工决定已保留。带未解决复核记录的确认映射不是当前版本有效复用约束。';slot.append(note);
    const list=document.createElement('ul');for(const review of pending){const item=document.createElement('li');item.textContent=(draftNames.get(review.draftId)||review.draftId)+' · '+(kindLabels[review.kind]||review.kind)+'：'+review.message;list.append(item);}slot.append(list);
  }});
})();
