/*
 * ProposalFile Module (#36): imports AI split proposals from a real proposal HTML file.
 * AI readers: the unique script#workbench-proposal[type="application/json"] block holds
 * candidate intents {proposals:[...]}. Each proposal carries boundary + relations + reason;
 * kind ∈ component|group|reference|reuse, source uses stable data-wb-node IDs. AI never
 * fills new draft/group/reference/mapping IDs and never writes confirmed; import only
 * validates per item and shows a candidate list. Candidate state lives in this module's
 * memory (the proposal layer), never in the v1 project: import never calls
 * updateProject/replaceProject/runCommand/registerGuard, never touches host.request and
 * never changes the canvas. Lazy JSON escaping follows the project-file rule (\u003c);
 * file size limit 4 MB; structural errors mark the item 非法, source/draft mismatches
 * against the current prototype/project mark it 不可用, everything else is 有效.
 */
(() => {
  'use strict';
  const MAX_FILE_BYTES=4*1024*1024;
  const KINDS=['component','group','reference','reuse'];
  const KIND_LABELS={component:'组件稿',group:'归组',reference:'嵌套引用',reuse:'来源复用',unknown:'未知'};
  const STATUS_LABELS={valid:'有效',unavailable:'不可用',invalid:'非法'};
  let ctx=null,loaded=null;
  const fail=message=>{throw Error(message);};
  const isText=value=>typeof value==='string'&&value.trim()!=='';
  const requireText=(value,label,max=20000)=>{if(!isText(value)||value.length>max)fail(label+'无效');return value;};
  function safeKeys(value,depth=0){
    if(depth>70)fail('建议资料嵌套过深');
    if(value&&typeof value==='object')for(const key of Object.keys(value)){
      if(key==='__proto__'||key==='constructor')fail('建议包含不安全的资料键');
      safeKeys(value[key],depth+1);
    }
  }
  function readProposal(html){
    if(typeof html!=='string')fail('建议文件内容无效');
    const bytes=typeof Blob==='function'?new Blob([html]).size:html.length;
    if(bytes>MAX_FILE_BYTES)fail('建议文件过大（上限 4 MB）');
    const doc=new DOMParser().parseFromString(html,'text/html');
    const records=doc.querySelectorAll('script#workbench-proposal[type="application/json"]');
    if(records.length!==1)fail('建议文件必须包含唯一 workbench-proposal 资料区块');
    let data;try{data=JSON.parse(records[0].textContent);}catch{fail('建议 JSON 已损坏');}
    // 顶层不安全键检查；proposals 内的键由逐条校验负责，避免整批连坐。
    if(data&&typeof data==='object')for(const key of Object.keys(data))if(key==='__proto__'||key==='constructor')fail('建议包含不安全的资料键');
    if(!data||typeof data!=='object'||Array.isArray(data)||!Array.isArray(data.proposals))fail('建议文件格式未知：缺少 proposals 列表');
    if(!data.proposals.length)fail('建议文件缺少建议条目');
    if(data.proposals.length>10000)fail('建议条目过多');
    return data.proposals;
  }
  function nodeIds(html){
    const doc=new DOMParser().parseFromString(html,'text/html');
    const result=new Set();
    for(const node of doc.querySelectorAll('[data-wb-node]'))result.add(node.getAttribute('data-wb-node'));
    return result;
  }
  function structural(item){
    if(!item||typeof item!=='object'||Array.isArray(item))fail('建议条目必须是对象');
    safeKeys(item);
    if(!KINDS.includes(item.kind))fail('未知建议类型：'+(typeof item.kind==='string'?item.kind:JSON.stringify(item.kind)));
    if(!isText(item.reason)||item.reason.length>4000)fail('理由（reason）缺失或无效');
    if(item.kind==='component'){
      requireText(item.name,'组件稿名称');
      if(!item.source||typeof item.source!=='object')fail('来源（source）无效');
      requireText(item.source.prototypeId,'来源原型 ID');requireText(item.source.pageId,'来源页面');requireText(item.source.stateId,'来源状态');
      if(!Array.isArray(item.source.nodeIds)||!item.source.nodeIds.length||item.source.nodeIds.length>10000||new Set(item.source.nodeIds).size!==item.source.nodeIds.length)fail('来源稳定节点无效');
      for(const id of item.source.nodeIds)requireText(id,'来源节点 ID');
    }else if(item.kind==='group'){
      const group=item.group;
      if(!group||typeof group!=='object')fail('归组信息（group）无效');
      if(group.id!==undefined&&!isText(group.id))fail('归组 ID 无效');
      if(group.name!==undefined&&(typeof group.name!=='string'||!group.name.trim()||group.name.length>20000))fail('归组名称无效');
      if(!Array.isArray(group.memberIds)||!group.memberIds.length||group.memberIds.length>10000||new Set(group.memberIds).size!==group.memberIds.length)fail('归组成员无效');
      for(const id of group.memberIds)requireText(id,'归组成员 ID');
      if(group.primaryId!==undefined){requireText(group.primaryId,'归组主体 ID');if(!group.memberIds.includes(group.primaryId))fail('归组主体不在成员列表中');}
    }else if(item.kind==='reference'){
      const reference=item.reference;
      if(!reference||typeof reference!=='object')fail('引用信息（reference）无效');
      requireText(reference.ownerDraftId,'引用使用方组件稿');requireText(reference.targetDraftId,'引用目标组件稿');requireText(reference.slotNodeId,'引用位置');
      if(reference.ownerDraftId===reference.targetDraftId)fail('引用不能指向自身');
    }else{
      const reuse=item.reuse;
      if(!reuse||typeof reuse!=='object')fail('复用信息（reuse）无效');
      requireText(reuse.draftId,'复用组件稿');
      if(!reuse.source||typeof reuse.source!=='object')fail('复用来源（source）无效');
      requireText(reuse.source.prototypeId,'复用来源原型 ID');requireText(reuse.source.pageId,'复用来源页面');requireText(reuse.source.stateId,'复用来源状态');
      if(!Array.isArray(reuse.source.nodeIds)||!reuse.source.nodeIds.length||reuse.source.nodeIds.length>10000||new Set(reuse.source.nodeIds).size!==reuse.source.nodeIds.length)fail('复用来源稳定节点无效');
      for(const id of reuse.source.nodeIds)requireText(id,'复用来源节点 ID');
    }
  }
  // 结构合法后核对与当前原型/项目的适用性；失配返回原因（不可用），否则返回 null。
  function applicability(item,env){
    const {drafts,prototypeNodes,draftNodes}=env;
    const checkSource=source=>{
      if(!env.prototype)return '尚未载入原型，无法核对建议来源';
      if(env.prototype.manifest.id!==source.prototypeId)return '来源原型 ID 不匹配：当前原型为 '+env.prototype.manifest.id;
      const page=env.prototype.manifest.pages.find(item=>item.id===source.pageId);
      if(!page?.states.some(state=>state.id===source.stateId))return '来源页面或状态不存在：'+source.pageId+' / '+source.stateId;
      const missing=source.nodeIds.filter(id=>!prototypeNodes.has(id));
      if(missing.length)return '来源稳定节点缺失：'+missing.join('、');
      return null;
    };
    if(item.kind==='component')return checkSource(item.source);
    if(item.kind==='reuse'){
      if(!drafts.has(item.reuse.draftId))return '复用组件稿不存在：'+item.reuse.draftId;
      return checkSource(item.reuse.source);
    }
    if(item.kind==='group'){
      const missing=item.group.memberIds.filter(id=>!drafts.has(id));
      if(missing.length)return '归组成员组件稿不存在：'+missing.join('、');
      return null;
    }
    const reference=item.reference;
    if(!drafts.has(reference.ownerDraftId))return '引用使用方组件稿不存在：'+reference.ownerDraftId;
    if(!drafts.has(reference.targetDraftId))return '引用目标组件稿不存在：'+reference.targetDraftId;
    const owner=drafts.get(reference.ownerDraftId);
    if(!draftNodes.get(reference.ownerDraftId).has(reference.slotNodeId))return '引用位置不存在：组件稿「'+owner.name+'」中没有稳定节点 '+reference.slotNodeId;
    return null;
  }
  function summarize(item,drafts){
    const name=id=>id?drafts.get(id)?.name||id:'未知';
    if(item.kind==='component')return item.name;
    if(item.kind==='group')return item.group?.name||item.group?.memberIds?.map(name).join('、')||'归组';
    if(item.kind==='reference')return name(item.reference?.ownerDraftId)+' → '+name(item.reference?.targetDraftId);
    if(item.kind==='reuse')return name(item.reuse?.draftId);
    return '未知条目';
  }
  function importProposals(items,fileName){
    const project=ctx.getProject();
    const drafts=new Map(project.drafts.map(draft=>[draft.id,draft]));
    const draftNodes=new Map();for(const draft of project.drafts)draftNodes.set(draft.id,nodeIds(draft.content.html));
    const env={drafts,prototypeNodes:project.prototype?nodeIds(project.prototype.html):null,prototype:project.prototype,draftNodes};
    const proposals=items.map(item=>{
      try{structural(item);}catch(error){
        return {kind:KINDS.includes(item?.kind)?item.kind:'unknown',summary:summarize(item||{},drafts),reason:typeof item?.reason==='string'?item.reason:null,status:'invalid',issue:error.message};
      }
      const issue=applicability(item,env);
      return {kind:item.kind,summary:summarize(item,drafts),reason:item.reason,status:issue?'unavailable':'valid',issue};
    });
    return {fileName,proposals};
  }
  function render(){
    if(!ctx)return;const slot=ctx.slots.right;
    if(!loaded){slot.replaceChildren();slot.hidden=true;return;}
    slot.hidden=false;slot.replaceChildren();
    const counts={valid:0,unavailable:0,invalid:0};for(const item of loaded.proposals)counts[item.status]++;
    const el=WorkbenchCommon.element;
    const panel=el('section',undefined,'proposal-panel');panel.setAttribute('aria-label','AI 拆分建议');
    panel.append(el('h2','AI 拆分建议'));
    panel.append(el('p',loaded.fileName+' · 共 '+loaded.proposals.length+' 条：有效 '+counts.valid+' · 不可用 '+counts.unavailable+' · 非法 '+counts.invalid,'proposal-help'));
    panel.append(el('p','候选只存在于建议层：导入不写入项目，也不产生 confirmed 或新组件稿 ID。','proposal-help'));
    const list=el('ul',undefined,'proposal-list');list.setAttribute('aria-label','建议候选列表');
    for(const item of loaded.proposals){
      const row=el('li');row.dataset.kind=item.kind;row.dataset.status=item.status;
      const head=el('div',undefined,'proposal-head');
      head.append(el('span',KIND_LABELS[item.kind]||item.kind,'proposal-kind'));
      const badge=el('span',STATUS_LABELS[item.status],'proposal-status');badge.dataset.status=item.status;head.append(badge);
      row.append(head,el('strong',KIND_LABELS[item.kind]+'：'+item.summary,'proposal-summary'));
      if(item.reason!==null)row.append(el('p',item.reason,'proposal-reason'));
      if(item.issue)row.append(el('p','原因：'+item.issue,'proposal-issue'));
      list.append(row);
    }
    panel.append(list);slot.append(panel);
  }
  Workbench.registerFeature({id:'proposal',mount(context){
    ctx=context;
    const toolbar=ctx.slots.toolbar;
    const input=document.createElement('input');input.type='file';input.accept='.html,.htm,text/html';input.setAttribute('aria-label','载入建议 HTML');
    const label=document.createElement('label');label.className='file-button';label.append('载入建议',input);
    const clear=document.createElement('button');clear.type='button';clear.textContent='清除建议';clear.setAttribute('aria-label','清除建议');clear.disabled=true;
    toolbar.append(label,clear);
    let busy=false;
    const run=async task=>{if(busy)return;busy=true;input.disabled=clear.disabled=true;try{await task();}catch(error){ctx.notify(error.message,true);}finally{busy=false;input.disabled=false;clear.disabled=!loaded;input.value='';}};
    input.onchange=()=>{const file=input.files[0];if(!file)return;run(async()=>{
      const proposals=readProposal(await file.text());
      loaded=importProposals(proposals,file.name);render();
      const counts={valid:0,unavailable:0,invalid:0};for(const item of loaded.proposals)counts[item.status]++;
      ctx.notify('已载入建议：'+loaded.fileName+' · 共 '+loaded.proposals.length+' 条（有效 '+counts.valid+' · 不可用 '+counts.unavailable+' · 非法 '+counts.invalid+'）');
    });};
    clear.onclick=()=>{loaded=null;render();ctx.notify('已清除建议');};
  },render});
})();
