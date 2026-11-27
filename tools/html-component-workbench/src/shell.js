(() => {
  function createShell(root) {
    root.innerHTML=`<header class="workbench-header"><div class="identity"><span class="workbench-mark" aria-hidden="true">▣</span><div><h1>组件拆分工作台</h1><p>HTML 原型 · 本地整理</p></div></div><div class="header-actions"><label class="file-button">载入原型<input type="file" accept=".html,.htm,text/html" aria-label="载入原型 HTML"></label><button type="button" id="open-example">打开受控示例</button><div id="toolbar-slots" class="feature-toolbar"></div></div><div class="mode-switch" role="group" aria-label="工作模式"><button id="preview-mode" aria-pressed="true">预览</button><button id="edit-mode" aria-pressed="false">编辑</button></div></header>
    <div class="workbench-layout"><aside class="left-pane" aria-label="资源导航"><div class="tabs" role="tablist" aria-label="工作区域"><button role="tab" aria-selected="true" id="screens-tab">界面</button><button role="tab" aria-selected="false" id="components-tab">组件</button></div><div id="screen-list"></div><div id="component-empty" hidden><p class="empty-note">尚无组件稿<br>进入编辑模式选择原型内容。</p></div><div id="left-slots"></div></aside>
    <main class="center-pane"><div class="canvas-toolbar"><div><strong id="canvas-title">原型画布</strong><span id="canvas-description">尚未载入原型</span></div><div class="canvas-toolbar-meta"><div class="canvas-fit"><span id="canvas-overflow-note" hidden></span><button id="fit-canvas" type="button" aria-pressed="false" disabled>适应窗口</button></div><span class="canvas-mode" id="mode-description">预览 · 可交互</span></div></div><div id="prototype-stage" class="prototype-stage"><div id="canvas-empty" class="canvas-empty"><span aria-hidden="true">▱</span><h2>从一个完整原型开始</h2><p>载入已适配的 HTML，或打开受控示例。<br>预览交互，进入编辑后稳定选择内容。</p></div><div id="prototype-blocked" class="canvas-empty" hidden><h2>原型控制失败，画布已停止</h2><p id="blocked-message"></p><p>已整理成果保留。重新载入会恢复原型初始状态。</p><button id="reload-prototype" type="button">重新载入当前原型</button></div><div id="frame-container"></div></div><div id="relations-empty" class="relations-empty" hidden><h2>组件关系概览</h2><p>暂无组件稿。提取后可在这里检查独立组件与人工关系。</p></div><div id="center-slots"></div></main>
    <aside class="right-pane" aria-label="当前操作"><h2>当前选区</h2><div id="selection-summary">未选择内容</div><p class="helper" id="selection-helper">预览保留原型交互。进入编辑后可选择稳定节点。</p><div id="right-slots"></div><section class="access-note"><h3>独立工作区</h3><p>原型运行于隔离画布。整理结果不会写入 Figma 或资源插件。</p></section></aside></div><footer class="status-bar"><span role="status" aria-live="polite" id="status">就绪 · 所有内容仅在当前会话</span><span id="design-size">本地文件 / 无需服务</span></footer>`;
    const byId=id=>root.querySelector('#'+id);
    let fitCanvas=false,currentProject=null,currentUI=null;
    function currentFrame(){return byId('frame-container').querySelector('iframe.prototype-frame:not(.candidate)');}
    function resetCanvasScale(frame){
      if(frame){frame.style.position='';frame.style.left='';frame.style.top='';frame.style.transform='';frame.style.transformOrigin='';}
      const container=byId('frame-container');
      container.style.position='';container.style.overflow='';container.style.width='';container.style.height='';
    }
    function applyCanvasFit(){
      const button=byId('fit-canvas'),note=byId('canvas-overflow-note'),stage=byId('prototype-stage');
      const frame=currentFrame(),ui=currentUI,project=currentProject;
      const available=Boolean(project?.prototype&&frame)&&ui?.view==='prototype'&&!stage.hidden&&stage.clientWidth>2&&!ui?.blockedReason;
      button.disabled=!available;
      button.setAttribute('aria-pressed',String(fitCanvas));
      if(!available){note.hidden=true;return;}
      if(fitCanvas){
        const style=getComputedStyle(stage),container=byId('frame-container');
        const padX=parseFloat(style.paddingLeft)+parseFloat(style.paddingRight);
        const padY=parseFloat(style.paddingTop)+parseFloat(style.paddingBottom);
        const nativeW=Number(frame.getAttribute('width'))||frame.offsetWidth||1;
        const nativeH=Number(frame.getAttribute('height'))||frame.offsetHeight||1;
        const availW=Math.max(1,stage.clientWidth-padX),availH=Math.max(1,stage.clientHeight-padY);
        const scale=Math.min(1,availW/nativeW,availH/nativeH);
        if(scale<0.985){
          frame.style.position='absolute';frame.style.left='0';frame.style.top='0';
          frame.style.transformOrigin='top left';frame.style.transform='scale('+scale+')';
          container.style.position='relative';container.style.overflow='hidden';
          container.style.width=(nativeW*scale)+'px';container.style.height=(nativeH*scale)+'px';
          note.textContent='已按 '+Math.round(scale*100)+'% 缩放显示完整画布；再次点击恢复 1:1。';
          note.hidden=false;
          return;
        }
      }
      resetCanvasScale(frame);
      const overflow=stage.scrollWidth>stage.clientWidth+4||stage.scrollHeight>stage.clientHeight+4;
      note.textContent=overflow?'画布超出可视区：滚动查看，或点击“适应窗口”。':'';
      note.hidden=!overflow;
    }
    byId('fit-canvas').onclick=()=>{fitCanvas=!fitCanvas;applyCanvasFit();};
    window.addEventListener('resize',()=>applyCanvasFit());
    return {root,byId,
      createSlots(id){const slots={};for(const region of ['toolbar','left','center','right']){const el=document.createElement('section');el.dataset.feature=id;el.className='feature-slot';byId(region+'-slots').append(el);slots[region]=el;}return slots;},
      render(project,ui,navigate){
        currentProject=project;currentUI=ui;
        byId('screens-tab').setAttribute('aria-selected',String(ui.tab==='screens'));
        byId('components-tab').setAttribute('aria-selected',String(ui.tab==='components'));
        byId('preview-mode').setAttribute('aria-pressed',String(ui.mode==='preview'));
        byId('edit-mode').setAttribute('aria-pressed',String(ui.mode==='edit'));
        byId('edit-mode').disabled=!project.prototype||Boolean(ui.blockedReason);
        byId('preview-mode').disabled=Boolean(ui.blockedReason);
        byId('prototype-blocked').hidden=!ui.blockedReason;
        byId('blocked-message').textContent=ui.blockedReason||'';
        byId('screen-list').hidden=ui.tab!=='screens';
        byId('component-empty').hidden=ui.tab!=='components'||project.drafts.length>0;
        byId('prototype-stage').hidden=ui.view!=='prototype';
        byId('relations-empty').hidden=ui.view!=='relations'||project.drafts.length>0;
        byId('canvas-empty').hidden=Boolean(project.prototype);
        byId('selection-summary').textContent=ui.selection.length?ui.selection.join('、'):'未选择内容';
        byId('selection-helper').textContent=ui.blockedReason?'画布已停止。请重新载入当前原型，或载入其他兼容原型。':ui.mode==='edit'?'点击选择稳定节点，Shift 点击加选或减选。原型业务输入和自动变化已暂停。':'预览保留原型交互。进入编辑后可选择稳定节点。';
        byId('mode-description').textContent=ui.blockedReason?'画布已停止':ui.mode==='edit'?'编辑 · 业务已冻结':'预览 · 可交互';
        byId('canvas-title').textContent=ui.view==='prototype'?'原型画布':ui.view==='draft'?'组件稿预览':'组件关系';
        const manifest=project.prototype?.manifest;
        byId('canvas-description').textContent=manifest?manifest.name:'尚未载入原型';
        byId('design-size').textContent=manifest?`${manifest.viewport.width} × ${manifest.viewport.height} · 原型 v${manifest.contentVersion}`:'本地文件 / 无需服务';
        byId('screen-list').replaceChildren();
        if(manifest)for(const page of manifest.pages){
          const section=document.createElement('section');section.className='screen-group';
          const heading=document.createElement('h2');heading.textContent=page.name;section.append(heading);
          for(const state of page.states){const button=document.createElement('button');button.className='state-entry';button.textContent=state.name;button.setAttribute('aria-label',page.name+' / '+state.name);button.setAttribute('aria-current',String(ui.pageId===page.id&&ui.stateId===state.id));button.disabled=Boolean(ui.blockedReason);button.onclick=()=>navigate(page.id,state.id);section.append(button);}
          byId('screen-list').append(section);
        }
        applyCanvasFit();
      }
    };
  }
  window.WorkbenchShell={create:createShell};
})();
