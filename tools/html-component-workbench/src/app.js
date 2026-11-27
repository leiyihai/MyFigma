(() => {
  'use strict';
  let project=WorkbenchProject.create();
  let ui={tab:'screens',view:'prototype',mode:'preview',blockedReason:null,pageId:null,stateId:null,selection:[],selectedDraftIds:[],activeDraftId:null};
  const shell=WorkbenchShell.create(document.getElementById('workbench'));
  const host=WorkbenchHost.create(shell.byId('frame-container'));
  const features=[],listeners=new Set(),guards=new Map();
  let busy=false,projectRevision=0;
  const notify=(message,isError=false)=>{const el=shell.byId('status');el.textContent=message;el.dataset.error=String(isError);};
  const render=()=>{
    shell.render(project,ui,(pageId,stateId)=>navigate(pageId,stateId).catch(error=>notify(error.message,true)));
    for(const feature of features)feature.render?.(feature.ctx);
    listeners.forEach(listener=>listener());
  };
  const updateProject=mutator=>{const next=structuredClone(project);mutator(next);project=next;projectRevision++;render();};
  const updateUI=patch=>{ui={...ui,...structuredClone(patch)};render();};
  function blockPrototype(error){host.stop();updateUI({blockedReason:error.message,selection:[],view:'prototype',tab:'screens'});notify('原型控制失败：'+error.message+'。画布已停止，已整理成果保留。',true);}
  async function navigate(pageId,stateId){try{await host.request('navigate',{pageId,stateId});updateUI({pageId,stateId,selection:[],view:'prototype',tab:'screens'});}catch(error){blockPrototype(error);throw error;}}
  async function setMode(mode){if(!['preview','edit'].includes(mode))throw Error('未知工作模式');try{await host.request('mode',{mode});updateUI({mode,selection:[]});notify(mode==='edit'?'编辑模式：业务输入与自动变化已冻结':'预览模式：原型交互已恢复');}catch(error){blockPrototype(error);throw error;}}
  const base={getProject:()=>structuredClone(project),getUI:()=>structuredClone(ui),updateProject,updateUI,
    replaceProject(next){project=structuredClone(next);projectRevision++;render();},host,notify,navigate,setMode,
    subscribe(listener){listeners.add(listener);return()=>listeners.delete(listener);},
    registerGuard(command,guard){if(!guards.has(command))guards.set(command,new Set());guards.get(command).add(guard);return()=>guards.get(command).delete(guard);},
    async runCommand(command,payload,commit){
      const revision=projectRevision,appliers=[];
      for(const guard of guards.get(command)||[]){const result=await guard(structuredClone(payload));if(result===false)return false;if(typeof result==='function')appliers.push(result);}
      if(projectRevision!==revision)throw Error('项目已变化，请重新检查影响后再提交');
      updateProject(next=>{commit(next,structuredClone(payload));for(const apply of appliers)apply(next,structuredClone(payload));});return true;
    }
  };
  async function importPrototype(html,fileName){
    if(busy)throw Error('正在载入原型，请稍候');busy=true;
    try {
      const prototype=await host.load(html,fileName);
      updateProject(next=>{next.prototype=prototype;if(next.name==='未命名项目')next.name=prototype.manifest.name;});
      const first=prototype.manifest.pages[0];updateUI({mode:'preview',blockedReason:null,pageId:first.id,stateId:first.states[0].id,selection:[],tab:'screens',view:'prototype'});
      notify('已载入：'+prototype.manifest.name);
    }finally{busy=false;}
  }
  shell.root.querySelector('input[type=file]').onchange=async event=>{const file=event.target.files[0];if(!file)return;try{await importPrototype(await file.text(),file.name);}catch(error){notify(error.message,true);}finally{event.target.value='';}};
  shell.byId('reload-prototype').onclick=()=>{const prototype=project.prototype;if(prototype)importPrototype(prototype.html,prototype.fileName).catch(error=>notify(error.message,true));};
  shell.byId('open-example').onclick=()=>importPrototype(window.WORKBENCH_BUILD.example,'controlled.html').catch(error=>notify(error.message,true));
  shell.byId('screens-tab').onclick=()=>updateUI({tab:'screens',view:'prototype'});
  shell.byId('components-tab').onclick=()=>updateUI({tab:'components',view:'relations'});
  shell.byId('preview-mode').onclick=()=>{if(project.prototype)setMode('preview').catch(error=>notify(error.message,true));};
  shell.byId('edit-mode').onclick=()=>setMode('edit').catch(error=>notify(error.message,true));
  host.subscribe(event=>{
    if(event.type==='location')updateUI({pageId:event.payload.pageId,stateId:event.payload.stateId,selection:[]});
    if(event.type==='selection'&&ui.mode==='edit'&&event.payload.pageId===ui.pageId&&event.payload.stateId===ui.stateId)updateUI({selection:event.payload.nodeIds});
  });
  window.Workbench={...base,
    registerFeature(feature){if(features.some(f=>f.id===feature.id))throw Error('重复特性：'+feature.id);feature.ctx={...base,slots:shell.createSlots(feature.id)};features.push(feature);feature.mount?.(feature.ctx);},
    start(){render();}
  };
})();
