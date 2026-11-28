(() => {
  'use strict';
  const protocol='workbench-bridge-v1';
  let port, manifest, originalNavigate, mode='preview', pageId, stateId, selection=[];
  // Install before business scripts: clocks are suspended, not allowed to catch up on resume.
  const nativeTimeout=window.setTimeout.bind(window), nativeClear=window.clearTimeout.bind(window);
  const nativeRAF=window.requestAnimationFrame.bind(window), nativeCancelRAF=window.cancelAnimationFrame.bind(window);
  let nextTimer=0,nextFrame=0;
  const timers=new Map(),frames=new Map(),pausedAnimations=new Set();
  function schedule(timer){timer.due=performance.now()+timer.remaining;timer.native=nativeTimeout(()=>{
    if(mode==='edit')return;
    if(!timer.repeat)timers.delete(timer.id);
    timer.callback.apply(window,timer.args);
    if(timer.repeat&&timers.has(timer.id)){timer.remaining=timer.delay;schedule(timer);}
  },timer.remaining);}
  function clock(callback,delay,repeat,args){
    if(typeof callback!=='function')throw Error('接入协议仅支持函数形式计时器');
    const timer={id:++nextTimer,callback,delay:Math.max(0,Number(delay)||0),remaining:Math.max(0,Number(delay)||0),repeat,args};
    timers.set(timer.id,timer);if(mode!=='edit')schedule(timer);return timer.id;
  }
  window.setTimeout=(callback,delay,...args)=>clock(callback,delay,false,args);
  window.setInterval=(callback,delay,...args)=>clock(callback,delay,true,args);
  window.clearTimeout=window.clearInterval=id=>{const timer=timers.get(id);if(timer){nativeClear(timer.native);timers.delete(id);}};
  function scheduleFrame(frame){frame.native=nativeRAF(time=>{frames.delete(frame.id);frame.callback(time);});}
  window.requestAnimationFrame=callback=>{const frame={id:++nextFrame,callback};frames.set(frame.id,frame);if(mode!=='edit')scheduleFrame(frame);return frame.id;};
  window.cancelAnimationFrame=id=>{const frame=frames.get(id);if(frame){nativeCancelRAF(frame.native);frames.delete(id);}};
  function pauseAnimations(){for(const animation of document.getAnimations())if(animation.playState==='running'||animation.pending){pausedAnimations.add(animation);animation.pause();}}
  const animate=Element.prototype.animate;
  Element.prototype.animate=function(...args){const animation=animate.apply(this,args);if(mode==='edit'){pausedAnimations.add(animation);animation.pause();}return animation;};
  new MutationObserver(()=>{if(mode==='edit')pauseAnimations();}).observe(document,{subtree:true,childList:true,attributes:true});
  // 页面/状态/模式变化时通知桥接特性清理仅属于当前画面的检查状态（如临时隐藏）。
  function announceScreenChange(){document.dispatchEvent(new CustomEvent('workbench:screen-change',{detail:{mode,pageId,stateId}}));}
  async function changeMode(payload){
    const next=payload.mode;if(!['preview','edit'].includes(next))throw Error('未知工作模式');
    if(next===mode){await window.WorkbenchPrototype.setMode(next);return {mode};}
    if(next==='edit'){
      mode='edit';
      for(const timer of timers.values()){nativeClear(timer.native);timer.remaining=Math.max(0,timer.due-performance.now());}
      for(const frame of frames.values())nativeCancelRAF(frame.native);
      pauseAnimations();
      await window.WorkbenchPrototype.setMode('edit');
      pauseAnimations();
    }else{
      await window.WorkbenchPrototype.setMode('preview');mode='preview';
      for(const timer of timers.values())schedule(timer);
      for(const frame of frames.values())scheduleFrame(frame);
      for(const animation of pausedAnimations)if(animation.playState==='paused')animation.play();pausedAnimations.clear();
      clearMarks();
    }
    announceScreenChange();
    return {mode};
  }
  function clearMarks(){document.querySelectorAll('[data-wb-selected],[data-wb-hover]').forEach(node=>{node.removeAttribute('data-wb-selected');node.removeAttribute('data-wb-hover');});}
  function markSelection(){document.querySelectorAll('[data-wb-selected]').forEach(node=>node.removeAttribute('data-wb-selected'));for(const id of selection)getNode(id)?.setAttribute('data-wb-selected','');}
  const inputEvents=['click','dblclick','auxclick','pointerdown','pointerup','pointerover','pointerout','pointerenter','pointerleave','pointercancel','mousedown','mouseup','mousemove','mouseover','mouseout','mouseenter','mouseleave','keydown','keyup','keypress','beforeinput','input','change','submit','wheel','touchstart','touchmove','touchend','dragstart','drop','contextmenu'];
  for(const type of inputEvents)window.addEventListener(type,event=>{
    if(mode!=='edit')return;
    if(type==='click'){
      const node=event.target.closest?.('[data-wb-node]');
      if(node){const id=node.dataset.wbNode;selection=event.shiftKey?(selection.includes(id)?selection.filter(value=>value!==id):[...selection,id]):[id];markSelection();emit('selection',{nodeIds:selection,pageId,stateId,clickedId:id});}
    }
    event.preventDefault();event.stopImmediatePropagation();
  },{capture:true,passive:false});
  window.addEventListener('pointermove',event=>{if(mode!=='edit')return;document.querySelectorAll('[data-wb-hover]').forEach(node=>node.removeAttribute('data-wb-hover'));event.target.closest?.('[data-wb-node]')?.setAttribute('data-wb-hover','');event.stopImmediatePropagation();},true);
  window.addEventListener('DOMContentLoaded',()=>{const style=document.createElement('style');style.textContent='[data-wb-hover]{outline:1px solid #285bd5!important;outline-offset:1px}[data-wb-selected]{outline:2px solid #285bd5!important;outline-offset:2px}';document.head.append(style);});
  const handlers=new Map();
  const getNode=id=>Array.from(document.querySelectorAll('[data-wb-node]')).find(node=>node.dataset.wbNode===id);
  const context=()=>({manifest:structuredClone(manifest),mode,pageId,stateId,selection:[...selection]});
  window.WorkbenchBridge={register(type,handler){if(handlers.has(type))throw Error('重复桥接命令：'+type);handlers.set(type,handler);},getNode,getContext:context};
  const emit=(type,payload)=>port?.postMessage({protocol,type,payload});
  function nodes() {
    const all=Array.from(document.querySelectorAll('[data-wb-node]'));
    const ids=all.map(n=>n.dataset.wbNode);
    if(!ids.length || ids.some(id=>!id.trim()) || new Set(ids).size!==ids.length)throw Error('稳定节点标识缺失、为空或重复');
    return all.map(node=>({id:node.dataset.wbNode,tag:node.tagName.toLowerCase(),parentId:node.parentElement?.closest('[data-wb-node]')?.dataset.wbNode||null,bounds:node.getBoundingClientRect().toJSON()}));
  }
  async function navigate(location) {
    const page=manifest.pages.find(p=>p.id===location.pageId);
    if(!page?.states.some(s=>s.id===location.stateId))throw Error('未知页面或状态');
    await originalNavigate.call(window.WorkbenchPrototype,location);
    pageId=location.pageId;stateId=location.stateId;selection=[];clearMarks();
    if(mode==='edit')pauseAnimations();
    announceScreenChange();
    emit('location',{pageId,stateId});
    return {pageId,stateId};
  }
  handlers.set('navigate',navigate);
  handlers.set('mode',changeMode);
  handlers.set('inspect',()=>nodes());
  handlers.set('selection',payload=>{
    if(!Array.isArray(payload.nodeIds)||payload.nodeIds.some(id=>!getNode(id)))throw Error('无效选择节点');
    selection=[...new Set(payload.nodeIds)];markSelection();emit('selection',{nodeIds:selection,pageId,stateId});return selection;
  });
  window.addEventListener('message',async event=>{
    if(event.source!==parent || event.data?.protocol!==protocol || event.data?.type!=='connect' || port || event.ports.length!==1)return;
    port=event.ports[0];
    port.onmessage=async ({data})=>{
      if(data?.protocol!==protocol || typeof data.requestId!=='string' || !handlers.has(data.type))return;
      try {const payload=await handlers.get(data.type)(data.payload);port.postMessage({protocol,type:'response',requestId:data.requestId,payload});}
      catch(error){port.postMessage({protocol,type:'response',requestId:data.requestId,error:error.message});}
    };
    try {
      manifest=JSON.parse(document.getElementById('workbench-manifest').textContent);
      if(typeof window.WorkbenchPrototype?.navigate!=='function'||typeof window.WorkbenchPrototype?.setMode!=='function')throw Error('缺少原型适配能力 navigate / setMode');
      await Promise.race([
        Promise.all([document.fonts.ready,...Array.from(document.images).map(image=>image.decode().catch(()=>{throw Error('图片资源不可用：'+(image.dataset.wbNode||image.alt||'未标识图片'));}))]),
        new Promise((_,reject)=>nativeTimeout(()=>reject(Error('原型资源就绪超时，请检查内联图片与字体')),3000))
      ]);
      nodes();
      originalNavigate=window.WorkbenchPrototype.navigate;
      window.WorkbenchPrototype.navigate=navigate;
      const first=manifest.pages[0];await navigate({pageId:first.id,stateId:first.states[0].id});
      emit('ready',{manifest});
    }catch(error){emit('failed',{message:error.message});}
  });
})();
