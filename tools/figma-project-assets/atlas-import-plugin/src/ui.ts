import {HelperClient,Workflow} from './api';
import type {Platform,Progress,Project} from './api';
function el<T extends HTMLElement>(id:string):T {const node=document.getElementById(id);if(!node)throw new Error('界面元素缺失');return node as T;}
function input(id:string) {return el<HTMLInputElement>(id);}
let sequence=0;
const pending=new Map<number,{resolve:(value:any)=>void;reject:(error:Error)=>void;timer:ReturnType<typeof setTimeout>}>();
let reportProgress:((value:Progress)=>void)|undefined;
function rpc<T>(type:string,payload:object):Promise<T> {
  return new Promise((resolve,reject)=>{
    const requestId=++sequence;
    const timer=setTimeout(()=>{pending.delete(requestId);reject(new Error('Figma 响应超时，请关闭并重新打开插件'));},60000);
    pending.set(requestId,{resolve,reject,timer});
    parent.postMessage({pluginMessage:{type,requestId,...payload}},'*');
  });
}
const platform:Platform={
  validate:project=>rpc('validate',{project}),
  async importResources(scan,progress){reportProgress=progress;try{await rpc('import',{scan});}finally{reportProgress=undefined;}}
};
let workflow:Workflow|undefined;
let uiError='';
let pageValidationPending=false;
const dialog=el<HTMLDialogElement>('management');
function tooltip(button:HTMLButtonElement) {
  const text=button.title;if(!text)return;
  button.removeAttribute('title');
  const wrap=document.createElement('span');wrap.className='action';
  button.replaceWith(wrap);wrap.append(button);
  const tip=document.createElement('span');tip.className='tooltip';tip.setAttribute('role','tooltip');tip.textContent=text;wrap.append(tip);
}
document.querySelectorAll<HTMLButtonElement>('button').forEach(tooltip);
function render() {
  const s=workflow?.state,busy=!!s?.busy,connected=!!s?.connected;
  el('connection').textContent=connected?'已连接':'未连接';
  el('phase').textContent=uiError?'失败':s?.phase||'未连接';
  el('error').textContent=uiError||s?.error||'';
  input('address').disabled=busy;input('token').disabled=busy;
  el<HTMLButtonElement>('connect').disabled=busy;
  for(const id of ['manage','search','project']) (el(id) as HTMLInputElement).disabled=busy||!connected;
  const options=el<HTMLSelectElement>('project');options.replaceChildren(new Option('请选择游戏',''));
  const choices=workflow?.searchProjects(input('search').value)||[];
  for(const project of choices)options.add(new Option(`${project.name}（${project.id}）`,project.id));
  if(s?.selected)options.value=choices.some(p=>p.id===s.selected!.id)?s.selected.id:'';
  el('selected').textContent=s?.selected?`当前游戏：${s.selected.name}（${s.selected.id}）`:'';
  el('page-status').textContent=pageValidationPending?'当前页已变化，任务结束后重新校验':s?.page?.message||'请选择游戏后校验页面';
  el<HTMLButtonElement>('validate').disabled=busy||!s?.selected;
  el<HTMLButtonElement>('scan').disabled=busy||pageValidationPending||!connected||!s?.selected||s.page?.valid===false;
  el<HTMLButtonElement>('import').disabled=busy||pageValidationPending||!s?.scan?.resources.length||s.page?.valid===false;
  const summary=s?.scan?.summary;
  el('summary').textContent=summary?`图集 ${summary.atlases} · 散图 ${summary.sprites} · 异常 ${summary.errors} · 未扫描子目录 ${summary.skippedDirectories}`:'尚未扫描';
  el('details').textContent=s?.scan?.errors.join('\n')||'';
  const progress=s?.progress||{done:0,total:0};
  el('progress').textContent=`${progress.done} / ${progress.total}`;
  el<HTMLProgressElement>('bar').max=progress.total||1;el<HTMLProgressElement>('bar').value=progress.done;
  for(const id of ['save','new','close','game-name','game-path','maintained']) (el(id) as HTMLInputElement).disabled=busy;
  input('game-id').disabled=busy||!!input('game-id').dataset.editing;
  const list=el('project-list');list.replaceChildren();
  for(const project of workflow?.allProjects()||[]) {
    const row=document.createElement('div');row.className='entry';
    const name=document.createElement('div');name.textContent=`${project.name}（${project.id}）${project.maintained?' · 长期维护':''}`;row.append(name);
    const edit=document.createElement('button');edit.textContent='编辑';edit.title='修改此游戏的名称、路径和长期维护标记；项目编号保持不变。';edit.disabled=busy;
    edit.onclick=()=>{input('game-name').value=project.name;input('game-id').value=project.id;input('game-id').dataset.editing='true';input('game-id').disabled=true;input('game-path').value=project.path;input('maintained').checked=project.maintained;};row.append(edit);tooltip(edit);
    const remove=document.createElement('button');remove.textContent='删除登记';remove.title='仅删除本机登记，不删除磁盘资源或已有 Figma 内容。';remove.disabled=busy;
    remove.onclick=()=>void run(async()=>{await workflow!.deleteProject(project.id);resetForm();});row.append(remove);tooltip(remove);list.append(row);
  }
}
function resetForm() {el<HTMLFormElement>('registration').reset();delete input('game-id').dataset.editing;input('game-id').disabled=false;}
async function run(action:()=>Promise<void>) {
  uiError='';
  try{await action();}catch(error){uiError=error instanceof Error?error.message:'操作失败';}
  if(pageValidationPending&&workflow&&!workflow.state.busy) {
    pageValidationPending=false;
    const taskError=uiError;
    await run(()=>workflow!.validatePage());
    if(taskError)uiError=uiError?`${taskError}\n${uiError}`:taskError;
    render();
    return;
  }
  render();
}
el('connect').onclick=()=>void run(async()=>{
  if(workflow?.state.busy)return;
  workflow=new Workflow(new HelperClient(input('address').value.trim(),input('token').value.trim()),platform,render);
  await workflow.connect();
  input('token').value='';
});
el('manage').onclick=()=>dialog.showModal();
el('close').onclick=()=>{if(!workflow?.state.busy)dialog.close();};
dialog.addEventListener('cancel',event=>{if(workflow?.state.busy)event.preventDefault();});
el('new').onclick=()=>{resetForm();render();};
el('search').oninput=render;
el('project').onchange=()=>{const id=el<HTMLSelectElement>('project').value;void run(()=>workflow!.selectProject(id));};
el('validate').onclick=()=>void run(()=>workflow!.validatePage());
el('scan').onclick=()=>void run(()=>workflow!.scan());
el('import').onclick=()=>void run(()=>workflow!.import());
el('registration').onsubmit=event=>event.preventDefault();
el('save').onclick=()=>{if(!el<HTMLFormElement>('registration').reportValidity())return;void run(async()=>{
  const project:Project={id:input('game-id').value.trim(),name:input('game-name').value.trim(),path:input('game-path').value.trim(),maintained:input('maintained').checked};
  await workflow!.saveProject(project);resetForm();
});};
window.addEventListener('message',event=>{
  const fromFigmaHost=event.source===top&&event.origin==='https://www.figma.com';
  if(event.source!==parent&&!fromFigmaHost)return;
  const message=event.data?.pluginMessage;if(!message)return;
  if(message.type==='progress') {reportProgress?.(message.progress);return;}
  if(message.type==='page-changed'){
    if(workflow?.state.busy){pageValidationPending=true;render();}
    else if(workflow)void run(()=>workflow!.validatePage());
    return;
  }
  const task=pending.get(message.requestId);if(!task)return;
  clearTimeout(task.timer);pending.delete(message.requestId);
  if(message.error)task.reject(new Error(message.error));else task.resolve(message.result);
});
render();
