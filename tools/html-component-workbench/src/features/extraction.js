(() => {
  'use strict';
  let ctx,excluded=[],hidden=[],selectionMode='replace',previous=[],manual=false,previewIds=null,centerKey='',pending=false,nameValue='';
  const shrinkHistory=[];
  function el(tag,text,className){const node=document.createElement(tag);if(text!==undefined)node.textContent=text;if(className)node.className=className;return node;}
  function button(text,action,disabled=false){const node=el('button',text);node.type='button';node.disabled=disabled;node.onclick=()=>perform(action);return node;}
  async function perform(action){if(pending)return;pending=true;try{await action();}catch(error){ctx.notify(error.message,true);}finally{pending=false;render();}}
  async function setSelection(ids){manual=true;try{await ctx.host.request('selection',{nodeIds:[...new Set(ids)]});}finally{manual=false;}previous=ctx.getUI().selection;}
  async function expand(){const ids=ctx.getUI().selection;const next=await Promise.all(ids.map(nodeId=>ctx.host.request('extraction:hierarchy',{nodeId,direction:'parent'})));shrinkHistory.push(ids);excluded=[];await setSelection(next.map((id,i)=>id||ids[i]));}
  async function shrink(){if(shrinkHistory.length){await setSelection(shrinkHistory.pop());return;}const ids=ctx.getUI().selection;const children=await Promise.all(ids.map(nodeId=>ctx.host.request('extraction:hierarchy',{nodeId,direction:'children'})));excluded=[];await setSelection(children.flat().length?children.flat():ids);}
  async function extract(update=false){
    const ui=ctx.getUI(),project=ctx.getProject(),old=project.drafts.find(d=>d.id===ui.activeDraftId);
    if(update&&!old)throw Error('请先定位要更新的组件稿来源');
    const snapshot=await ctx.host.request('extract',{nodeIds:ui.selection,excludedNodeIds:excluded});
    const current=ctx.getUI();if(current.pageId!==ui.pageId||current.stateId!==ui.stateId||ctx.getProject().prototype?.html!==project.prototype?.html)throw Error('原型或界面已变化，请重新提取');
    const name=(nameValue||old?.name||'组件稿 '+(project.drafts.length+1)).trim();
    const draft={id:old&&update?old.id:'draft-'+crypto.randomUUID(),name,...snapshot,revision:old&&update?old.revision+1:1};
    let committed=true;
    if(update)committed=await ctx.runCommand('draft:update',{draftId:old.id,nextDraft:draft},(next,payload)=>{
      const index=next.drafts.findIndex(item=>item.id===payload.draftId);if(index<0)throw Error('组件稿已不存在');next.drafts[index]=payload.nextDraft;
    });else ctx.updateProject(next=>next.drafts.push(draft));
    if(!committed){ctx.notify('已取消更新，组件稿保持不变');return;}
    nameValue='';previewIds=null;ctx.updateUI({tab:'components',view:'draft',activeDraftId:draft.id,selectedDraftIds:[draft.id]});ctx.notify(update?'组件稿提取范围已更新':'已提取独立组件稿：'+draft.name);
  }
  async function locate(draft){
    const project=ctx.getProject();if(project.prototype?.manifest.id!==draft.source.prototypeId)throw Error('来源原型已变化，无法定位；组件稿仍保留');
    await ctx.navigate(draft.source.pageId,draft.source.stateId);if(ctx.getUI().mode!=='edit')await ctx.setMode('edit');
    excluded=draft.source.excludedNodeIds||[];await setSelection(draft.source.nodeIds);ctx.updateUI({activeDraftId:draft.id});ctx.notify('已定位来源：'+draft.source.nodeIds.join('、'));
  }
  function previewDocument(content){
    return '<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; img-src data:; font-src data:; style-src \'unsafe-inline\'; form-action \'none\'; base-uri \'none\'"><style>html,body{margin:0;width:100%;height:100%;overflow:hidden;background:white}'+content.css.replace(/<\/style/gi,'<\\/style')+'</style></head><body>'+content.html+'</body></html>';
  }
  function render(){
    if(!ctx)return;const project=ctx.getProject(),ui=ctx.getUI(),active=project.drafts.find(d=>d.id===ui.activeDraftId);
    if(ui.mode!=='edit'){hidden=[];excluded=[];selectionMode='replace';}
    const {left,right,center}=ctx.slots;left.hidden=ui.tab!=='components';left.replaceChildren();
    if(project.drafts.length){
      left.append(el('p','勾选顺序决定归组主体；点击预览可单独检查。','extraction-help'));
      const list=el('div',undefined,'draft-list');list.setAttribute('aria-label','组件稿列表');
      for(const draft of project.drafts){
        const row=el('div',undefined,'draft-row');const label=el('label');const input=document.createElement('input');input.type='checkbox';input.checked=ui.selectedDraftIds.includes(draft.id);input.setAttribute('aria-label','选择组件稿：'+draft.name);
        input.onchange=()=>{const selected=ctx.getUI().selectedDraftIds;ctx.updateUI({selectedDraftIds:input.checked?[...selected.filter(id=>id!==draft.id),draft.id]:selected.filter(id=>id!==draft.id)});};
        label.append(input,el('span',input.checked?String(ui.selectedDraftIds.indexOf(draft.id)+1):'','draft-order'));row.append(label,button(draft.name,()=>{previewIds=null;ctx.updateUI({activeDraftId:draft.id,view:'draft',tab:'components'});}));list.append(row);
      }
      left.append(list,el('p','选择顺序：'+ui.selectedDraftIds.map(id=>project.drafts.find(d=>d.id===id)?.name).join(' → '),'extraction-help'));
      left.append(button('并排预览所选',()=>{previewIds=[...ui.selectedDraftIds];ctx.updateUI({view:'draft',activeDraftId:previewIds[0]});},ui.selectedDraftIds.length<2));
    }
    right.replaceChildren();right.hidden=!project.prototype;
    if(ui.view==='prototype'&&ui.mode==='edit'&&!ui.blockedReason){
      const controls=el('div',undefined,'extraction-controls');
      const modes=el('div',undefined,'selection-modes');modes.setAttribute('role','group');modes.setAttribute('aria-label','选区操作');
      for(const [value,text] of [['replace','替换选择'],['add','加选模式'],['subtract','减选模式']]){const node=button(text,()=>{selectionMode=value;});node.setAttribute('aria-pressed',String(selectionMode===value));modes.append(node);}controls.append(modes);
      controls.append(el('p','Shift 点击可切换选择。减选模式也可排除已选父级中的子层。','extraction-help'));
      if(excluded.length)controls.append(el('p','已排除：'+excluded.join('、'),'extraction-help'));
      controls.append(button('扩大选区',expand,!ui.selection.length),button('缩小选区',shrink,!ui.selection.length));
      controls.append(button('临时隐藏选区',async()=>{const result=await ctx.host.request('extraction:visibility',{nodeIds:ui.selection});hidden=result.hiddenIds;},!ui.selection.length),button('恢复全部隐藏',async()=>{await ctx.host.request('extraction:visibility',{restore:true});hidden=[];},!hidden.length));
      if(hidden.length)controls.append(el('p','临时隐藏 '+hidden.length+' 项；提取自动使用原始显隐。','extraction-help'));
      const label=el('label','组件稿名称','extraction-field');const input=document.createElement('input');input.type='text';input.value=nameValue;input.placeholder='例如：家园收取卡片';input.oninput=()=>nameValue=input.value;label.append(input);controls.append(label);
      controls.append(button('提取独立组件稿',()=>extract(false),!ui.selection.length));
      if(active)controls.append(button('更新提取范围',()=>extract(true),!ui.selection.length));right.append(controls);
    }
    if(active){
      const details=el('section',undefined,'draft-details');details.append(el('h3',active.name),el('p',active.source.pageId+' / '+active.source.stateId+' · '+active.content.width+' × '+active.content.height+' · 修订 '+active.revision,'extraction-help'));
      details.append(button('定位来源',()=>locate(active)),button('返回原界面',async()=>{await ctx.navigate(active.source.pageId,active.source.stateId);}));
      if(ui.view==='draft'){
        const label=el('label','当前组件稿名称','extraction-field');const input=document.createElement('input');input.value=active.name;label.append(input);details.append(label,button('重命名组件稿',async()=>{const value=input.value.trim();if(!value)throw Error('组件稿名称不能为空');await ctx.runCommand('draft:update',{draftId:active.id,nextDraft:{...active,name:value}},(next,payload)=>{next.drafts[next.drafts.findIndex(d=>d.id===payload.draftId)]=payload.nextDraft;});}));
        const group=project.groups.find(g=>g.memberIds.includes(active.id));if(group)details.append(button('同组并排预览',()=>{previewIds=[group.primaryId,...group.memberIds.filter(id=>id!==group.primaryId)];render();}));
      }
      right.append(details);
    }
    center.hidden=ui.view!=='draft';
    const ids=previewIds||[ui.activeDraftId],drafts=ids.map(id=>project.drafts.find(d=>d.id===id)).filter(Boolean);
    const key=ui.view==='draft'?JSON.stringify(drafts):'';
    if(key!==centerKey){centerKey=key;center.replaceChildren();if(ui.view==='draft'){
      const top=el('div',undefined,'draft-preview-toolbar');top.append(button('返回关系概览',()=>ctx.updateUI({view:'relations',tab:'components'})));center.append(top);
      const previews=el('div',undefined,'draft-previews');for(const draft of drafts){const figure=el('figure',undefined,'draft-preview');figure.append(el('figcaption',draft.name));const frame=document.createElement('iframe');frame.title='组件稿：'+draft.name;frame.setAttribute('sandbox','');frame.width=draft.content.width;frame.height=draft.content.height;frame.srcdoc=previewDocument(draft.content);figure.append(frame);previews.append(figure);}center.append(previews);
    }}
  }
  Workbench.registerFeature({id:'extraction',mount(context){ctx=context;ctx.host.subscribe(async event=>{
    if(event.type==='location'){excluded=[];hidden=[];shrinkHistory.length=0;previous=[];return;}
    if(event.type!=='selection'||manual)return;
    const incoming=event.payload.nodeIds;if(selectionMode==='replace'){previous=incoming;excluded=[];shrinkHistory.length=0;return;}
    // 非 Shift 点击把选择替换为单个节点，前后差集分不清被点与被取消选择的节点；优先使用桥接给出的 clickedId。
    const nodeId=event.payload.clickedId||incoming.find(id=>!previous.includes(id))||previous.find(id=>!incoming.includes(id))||incoming[incoming.length-1];if(!nodeId)return;
    if(selectionMode==='add'){excluded=excluded.filter(id=>id!==nodeId);await setSelection([...previous,nodeId]);}
    else{if(previous.includes(nodeId)){excluded=excluded.filter(id=>id!==nodeId);await setSelection(previous.filter(id=>id!==nodeId));}else{excluded=[...new Set([...excluded,nodeId])];await setSelection(previous);}}
    render();
  });},render});
})();
