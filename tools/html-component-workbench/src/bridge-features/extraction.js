(() => {
  'use strict';
  const bridge=window.WorkbenchBridge;
  let hiddenIds=[];
  const hiddenStyle=document.createElement('style');
  function restoreHidden(){hiddenIds=[];hiddenStyle.textContent='';}
  const observer=new MutationObserver(()=>{if(bridge.getContext().mode!=='edit')restoreHidden();});
  window.addEventListener('DOMContentLoaded',()=>{document.head.append(hiddenStyle);observer.observe(document.documentElement,{subtree:true,attributes:true,attributeFilter:['data-wb-selected','data-wb-hover']});});
  const required=()=>{if(bridge.getContext().mode!=='edit')throw Error('请先进入编辑模式');};
  bridge.register('extraction:visibility',payload=>{
    required();
    if(payload.restore)restoreHidden();else{hiddenIds=[...new Set([...hiddenIds,...payload.nodeIds])];hiddenStyle.textContent=hiddenIds.map(id=>'[data-wb-node="'+CSS.escape(id)+'"],[data-wb-node="'+CSS.escape(id)+'"] *{visibility:hidden!important}').join('\n');}
    return {hiddenIds};
  });
  bridge.register('extraction:hierarchy',payload=>{
    required();const node=bridge.getNode(payload.nodeId);if(!node)throw Error('来源节点不存在');
    if(payload.direction==='parent')return node.parentElement?.closest('[data-wb-node]')?.dataset.wbNode||null;
    return Array.from(node.querySelectorAll('[data-wb-node]')).filter(child=>child.parentElement?.closest('[data-wb-node]')===node).map(child=>child.dataset.wbNode);
  });
  bridge.register('extract',async payload=>{
    required();
    const context=bridge.getContext(),ids=payload.nodeIds,excluded=payload.excludedNodeIds||[];
    if(!Array.isArray(ids)||!ids.length)throw Error('请先选择要提取的内容');
    const roots=ids.map(id=>bridge.getNode(id));if(roots.some(node=>!node))throw Error('选区来源已失效');
    const exclusions=excluded.map(id=>bridge.getNode(id));
    const selected=node=>roots.some(root=>root===node||root.contains(node))&&!exclusions.some(root=>root&&(root===node||root.contains(node)));
    const relevant=node=>selected(node)||roots.some(root=>node.contains(root));
    const marks=Array.from(document.querySelectorAll('[data-wb-selected],[data-wb-hover]')).map(node=>[node,node.hasAttribute('data-wb-selected'),node.hasAttribute('data-wb-hover')]);
    for(const [node] of marks){node.removeAttribute('data-wb-selected');node.removeAttribute('data-wb-hover');}
    hiddenStyle.disabled=true;
    try{
      await document.fonts.ready;
      const rects=roots.map(node=>node.getBoundingClientRect());
      if(rects.some(rect=>!rect.width||!rect.height))throw Error('选区包含不可见或零尺寸节点');
      const x=Math.floor(Math.min(...rects.map(r=>r.left))),y=Math.floor(Math.min(...rects.map(r=>r.top)));
      const width=Math.ceil(Math.max(...rects.map(r=>r.right)))-x,height=Math.ceil(Math.max(...rects.map(r=>r.bottom)))-y;
      const bounds={x,y,width,height};let index=0;const rules=[];
      const blocked=new Set(['CANVAS','IFRAME','OBJECT','EMBED','VIDEO','AUDIO']);
      // view-transition-* are identity hooks, not visuals: copying the document element's
      // "root" name onto a wrapper div would make it a view-transition root and promote a
      // composited layer, which changes text antialiasing of overlapping content.
      function styleText(style){return Array.from(style).filter(key=>!['animation','animation-name','transition','cursor','outline','outline-color','outline-style','outline-width','outline-offset','view-transition-name','view-transition-class','view-transition-group','view-transition-scope'].includes(key)).map(key=>key+':'+style.getPropertyValue(key)+';').join('');}
      function clone(node){
        if(node.nodeType===Node.TEXT_NODE)return document.createTextNode(selected(node.parentElement)?node.textContent:'');
        if(node.nodeType!==Node.ELEMENT_NODE)return null;
        if(['SCRIPT','STYLE','LINK','META','BASE','NOSCRIPT'].includes(node.tagName))return null;
        const active=relevant(node),computed=getComputedStyle(node);
        if(active){
          const label=node.dataset.wbNode||node.tagName.toLowerCase();
          if(blocked.has(node.tagName)||node.shadowRoot)throw Error('无法保真提取节点 '+label+'：不支持 '+node.tagName.toLowerCase()+' / Shadow DOM');
          if(computed.perspective!=='none'||computed.transform.startsWith('matrix3d')||computed.backdropFilter!=='none'||computed.filter!=='none'||computed.mixBlendMode!=='normal')throw Error('无法保真提取节点 '+label+'：不支持 3D、滤镜或混合模式');
          if(computed.position==='fixed'||computed.position==='sticky')throw Error('无法保真提取节点 '+label+'：不支持 fixed / sticky 定位');
        }
        const copy=node.cloneNode(false);
        for(const attr of Array.from(copy.attributes))if(/^on/i.test(attr.name)||['href','srcdoc','action','formaction','autofocus','data-wb-selected','data-wb-hover'].includes(attr.name))copy.removeAttribute(attr.name);
        if(copy.hasAttribute('src')&&!/^data:image\//i.test(copy.getAttribute('src')))copy.removeAttribute('src');
        copy.removeAttribute('srcset');
        copy.style.cssText=styleText(computed);
        // CSSOM matrices round rotation coefficients; Typed OM keeps the authored transform precision.
        const preciseTransform=node.computedStyleMap?.().get('transform');
        if(preciseTransform)copy.style.transform=preciseTransform.toString();
        copy.style.setProperty('animation','none','important');copy.style.setProperty('transition','none','important');
        // Keep the original layout and stacking-context forest; only chosen branches paint.
        copy.style.setProperty('visibility',active&&computed.visibility!=='hidden'?'visible':'hidden','important');
        if(active&&!selected(node)){copy.style.background='none';copy.style.borderColor='transparent';copy.style.boxShadow='none';}
        if(!active){copy.removeAttribute('data-wb-node');copy.removeAttribute('id');}
        const token='e'+(++index);copy.setAttribute('data-wb-snapshot',token);
        if(selected(node))for(const pseudo of ['::before','::after']){
          const style=getComputedStyle(node,pseudo);
          if(style.content!=='none'&&style.content!=='normal')rules.push('[data-wb-snapshot="'+token+'"]'+pseudo+'{'+styleText(style)+'}');
        }
        if(node instanceof HTMLImageElement){if(selected(node)){copy.src=node.currentSrc;copy.width=node.width;copy.height=node.height;}else copy.removeAttribute('src');}
        if(node instanceof HTMLInputElement){copy.setAttribute('value',node.value);if(node.checked)copy.setAttribute('checked','');else copy.removeAttribute('checked');}
        if(node instanceof HTMLTextAreaElement)copy.textContent=node.value;
        else for(const child of node.childNodes){const result=clone(child);if(result)copy.append(result);}
        if(node instanceof HTMLSelectElement)Array.from(copy.options).forEach((option,i)=>option.selected=node.options[i].selected);
        return copy;
      }
      const body=clone(document.body);
      const html=document.createElement('div');html.style.cssText=styleText(getComputedStyle(document.documentElement));html.style.width=context.manifest.viewport.width+'px';html.style.height=context.manifest.viewport.height+'px';html.style.background='transparent';html.append(body);
      const fonts=[];for(const sheet of document.styleSheets){try{for(const rule of sheet.cssRules)if(rule.type===CSSRule.FONT_FACE_RULE)fonts.push(rule.cssText);}catch{throw Error('无法读取必要字体样式');}}
      return {source:{prototypeId:context.manifest.id,contentVersion:context.manifest.contentVersion,pageId:context.pageId,stateId:context.stateId,nodeIds:[...ids],excludedNodeIds:[...excluded],bounds},content:{html:'<div style="position:absolute;left:0;top:0;transform:translate('+(-x)+'px,'+(-y)+'px);width:'+context.manifest.viewport.width+'px;height:'+context.manifest.viewport.height+'px">'+html.outerHTML+'</div>',css:fonts.join('\n')+'\n'+rules.join('\n'),width,height,assets:[]}};
    }finally{hiddenStyle.disabled=false;for(const [node,selection,hover] of marks){if(selection)node.setAttribute('data-wb-selected','');if(hover)node.setAttribute('data-wb-hover','');}}
  });
})();
