(() => {
  'use strict';
  const protocol='workbench-bridge-v1';
  function validateManifest(manifest) {
    if(manifest?.format!=='workbench-prototype'||manifest.version!==1)throw Error('不支持的原型格式或版本（需要 workbench-prototype v1）');
    for(const key of ['id','contentVersion','name'])if(typeof manifest[key]!=='string'||!manifest[key].trim())throw Error('原型清单缺少 '+key);
    if(!Number.isFinite(manifest.viewport?.width)||!Number.isFinite(manifest.viewport?.height)||manifest.viewport.width<1||manifest.viewport.height<1||manifest.viewport.width>8192||manifest.viewport.height>8192)throw Error('原型设计尺寸无效');
    if(!['navigate','freeze','stable-nodes'].every(c=>manifest.capabilities?.includes(c)))throw Error('原型缺少必要能力：navigate / freeze / stable-nodes');
    const ids=new Set();
    if(!Array.isArray(manifest.pages)||!manifest.pages.length)throw Error('原型没有可枚举的页面和状态');
    for(const page of manifest.pages){
      if(typeof page.id!=='string'||!page.id.trim()||typeof page.name!=='string'||ids.has(page.id)||!Array.isArray(page.states)||!page.states.length)throw Error('页面 ID、名称或状态列表无效');
      ids.add(page.id);const states=new Set();
      for(const state of page.states){if(typeof state.id!=='string'||!state.id.trim()||typeof state.name!=='string'||states.has(state.id))throw Error('状态 ID 或名称无效');states.add(state.id);}
    }
    return manifest;
  }
  function createHost(container) {
    let active=null;
    const listeners=new Set();
    const dispose=entry=>{if(!entry)return;entry.port.close();entry.frame.remove();for(const pending of entry.pending.values()){clearTimeout(pending.timer);pending.reject(Error('原型已替换'));}};
    async function load(html,fileName='prototype.html') {
      const doc=new DOMParser().parseFromString(html,'text/html');
      const raw=doc.querySelector('script#workbench-manifest[type="application/json"]');
      if(!raw)throw Error('原型未适配：缺少 workbench-manifest 接入清单');
      let manifest;try{manifest=validateManifest(JSON.parse(raw.textContent));}catch(error){throw Error('无法载入：'+error.message);}
      if(doc.querySelector('script[src],link[rel="stylesheet"],base,iframe,object,embed'))throw Error('原型仅支持内联资源，不支持外部脚本、样式、base 或嵌入窗口');
      for(const image of doc.images)if(!image.getAttribute('src')?.startsWith('data:')||image.hasAttribute('srcset'))throw Error('图片资源不可用：仅支持内联 data: 图片，不支持外部 URL / srcset');
      const css=[...doc.querySelectorAll('style')].map(style=>style.textContent).concat([...doc.querySelectorAll('[style]')].map(node=>node.getAttribute('style'))).join('\n');
      if(/@import\b/i.test(css)||[...css.matchAll(/url\(\s*(['"]?)(.*?)\1\s*\)/gi)].some(match=>!match[2].startsWith('data:')&&!match[2].startsWith('#')))throw Error('原型仅支持内联资源：CSS URL 必须为 data: 或文档内引用');
      const frame=document.createElement('iframe');
      frame.title='原型载入校验';frame.setAttribute('sandbox','allow-scripts');frame.setAttribute('referrerpolicy','no-referrer');
      frame.width=manifest.viewport.width;frame.height=manifest.viewport.height;
      frame.className='prototype-frame candidate';
      // Insert bridge before any prototype script; do not grant the prototype same-origin privileges.
      const bridge='<script>'+window.WORKBENCH_BUILD.bridge.replace(/<\/script/gi,'<\\/script')+'<\/script>';
      const injection='<meta http-equiv="Content-Security-Policy" content="default-src &#39;none&#39;; script-src &#39;unsafe-inline&#39;; style-src &#39;unsafe-inline&#39;; img-src data:; font-src data:; media-src data:; connect-src &#39;none&#39;; frame-src &#39;none&#39;; object-src &#39;none&#39;; base-uri &#39;none&#39;; form-action &#39;none&#39;">'+bridge;
      const head=html.match(/<head(?:\s[^>]*)?>/i);
      if(!head)throw Error('原型必须包含 head，不能安全注入桥接');
      frame.srcdoc=html.replace(head[0],head[0]+injection);
      const channel=new MessageChannel();
      const entry={frame,port:channel.port1,manifest,pending:new Map(),ready:false};
      try {
        await new Promise((resolve,reject)=>{
          const timer=setTimeout(()=>reject(Error('原型载入超时：桥接或适配器未就绪')),4000);
          entry.port.onmessage=({data})=>{
            if(data?.protocol!==protocol)return;
            if(!entry.ready){
              if(data.type==='failed'){clearTimeout(timer);reject(Error('原型接入失败：'+data.payload?.message));}
              else if(data.type==='ready'){
                if(JSON.stringify(data.payload?.manifest)!==JSON.stringify(manifest)){clearTimeout(timer);reject(Error('原型清单在运行中被改写'));return;}
                entry.ready=true;clearTimeout(timer);resolve();
              }
              return;
            }
            if(entry!==active)return;
            if(data.type==='response'){
              const pending=entry.pending.get(data.requestId);if(!pending)return;
              clearTimeout(pending.timer);entry.pending.delete(data.requestId);
              data.error?pending.reject(Error(data.error)):pending.resolve(data.payload);
            }else if(data.type==='location'&&manifest.pages.some(page=>page.id===data.payload?.pageId&&page.states.some(state=>state.id===data.payload?.stateId))){
              listeners.forEach(fn=>fn({type:'location',payload:{pageId:data.payload.pageId,stateId:data.payload.stateId}}));
            }else if(data.type==='selection'&&Array.isArray(data.payload?.nodeIds)&&data.payload.nodeIds.every(id=>typeof id==='string')&&data.payload.nodeIds.length<10000){
              listeners.forEach(fn=>fn({type:'selection',payload:data.payload}));
            }
          };
          frame.addEventListener('load',()=>frame.contentWindow.postMessage({protocol,type:'connect'},'*',[channel.port2]),{once:true});
          container.append(frame);
        });
      } catch(error){dispose(entry);throw error;}
      dispose(active);active=entry;frame.title='原型画布';frame.classList.remove('candidate');
      // Candidate frames are initially offscreen. Commit only after a visible paint so native
      // hit-testing and animation timelines are ready before the UI reports a usable import.
      await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
      return {manifest:structuredClone(manifest),html,fileName};
    }
    return {
      load,
      stop(){dispose(active);active=null;},
      request(type,payload={}){
        if(!active)return Promise.reject(Error('请先载入原型'));
        const entry=active,requestId=crypto.randomUUID();
        return new Promise((resolve,reject)=>{
          const timer=setTimeout(()=>{entry.pending.delete(requestId);reject(Error('原型操作超时：'+type));},4000);
          entry.pending.set(requestId,{resolve,reject,timer});entry.port.postMessage({protocol,type,requestId,payload});
        });
      },
      subscribe(listener){listeners.add(listener);return()=>listeners.delete(listener);},
      get element(){return active?.frame||null;},get manifest(){return active?structuredClone(active.manifest):null;}
    };
  }
  window.WorkbenchHost={create:createHost,validateManifest};
})();
