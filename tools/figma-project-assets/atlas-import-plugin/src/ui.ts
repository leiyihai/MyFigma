import {HelperAuthError,HelperClient,Workflow} from './api';
import type {Platform,Progress,Project} from './api';
type Pairing={schemaVersion:1;address:string;token:string};
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
  preview:scan=>rpc('preview',{scan}),
  async importResources(scan,progress){reportProgress=progress;try{return await rpc<import('./api').ImportPlan>('import',{scan});}finally{reportProgress=undefined;}}
};
let workflow:Workflow|undefined;
let uiError='';
let pageValidationPending=false;
let remembered=false;
let editingId:string|undefined;
const dialog=el<HTMLDialogElement>('management');
function placeTooltip(wrap:HTMLElement) {
  const tip=wrap.querySelector<HTMLElement>('.tooltip');if(!tip)return;
  const wasHidden=tip.style.display==='none'||getComputedStyle(tip).display==='none';
  if(wasHidden)tip.style.display='block';
  const anchor=wrap.getBoundingClientRect(),width=tip.offsetWidth,height=tip.offsetHeight,margin=8;
  let left=Math.max(margin,Math.min(innerWidth-width-margin,anchor.left));
  let top=anchor.top-height-6;
  if(top<margin)top=Math.min(innerHeight-height-margin,anchor.bottom+6);
  tip.style.left=`${left}px`;tip.style.top=`${top}px`;
}
function tooltip(button:HTMLButtonElement) {
  const text=button.title;if(!text)return;
  button.removeAttribute('title');
  const wrap=document.createElement('span');wrap.className='action';
  button.replaceWith(wrap);wrap.append(button);
  const tip=document.createElement('span');tip.className='tooltip';tip.setAttribute('role','tooltip');tip.textContent=text;wrap.append(tip);
  wrap.addEventListener('mouseenter',()=>placeTooltip(wrap));
  wrap.addEventListener('focusin',()=>placeTooltip(wrap));
  const hide=()=>{tip.style.display='none';};
  wrap.addEventListener('mouseleave',hide);wrap.addEventListener('focusout',hide);
}
document.querySelectorAll<HTMLButtonElement>('button').forEach(tooltip);
document.querySelectorAll<HTMLElement>('.help-wrap').forEach(wrap=>{
  wrap.addEventListener('mouseenter',()=>placeTooltip(wrap));
  wrap.addEventListener('focusin',()=>placeTooltip(wrap));
  const tip=wrap.querySelector<HTMLElement>('.tooltip');
  if(tip){const hide=()=>{tip.style.display='none';};wrap.addEventListener('mouseleave',hide);wrap.addEventListener('focusout',hide);}
});
function render() {
  const s=workflow?.state,busy=!!s?.busy,connected=!!s?.connected;
  const connection=el('connection');connection.textContent=connected?'已连接':'未连接';connection.classList.toggle('connected',connected);
  el('phase').textContent=uiError?'失败':s?.phase||'未连接';
  el('error').textContent=uiError||s?.error||'';
  input('address').disabled=busy;input('token').disabled=busy;
  input('remember').disabled=busy;
  el<HTMLButtonElement>('connect').disabled=busy;
  el<HTMLButtonElement>('forget').disabled=busy||!remembered;
  el('pairing-status').textContent=remembered?'已记住本机配对':input('remember').checked?'首次配对后自动记住':'不会记住配对';
  for(const id of ['manage','search','project']) (el(id) as HTMLInputElement).disabled=busy||!connected;
  const options=el<HTMLSelectElement>('project');options.replaceChildren(new Option('请选择游戏',''));
  const choices=workflow?.searchProjects(input('search').value)||[];
  for(const project of choices)options.add(new Option(`${project.name}（${project.id}）`,project.id));
  if(s?.selected)options.value=choices.some(p=>p.id===s.selected!.id)?s.selected.id:'';
  el('selected').textContent=s?.selected?`当前游戏：${s.selected.name}（${s.selected.id}）`:'';
  el('page-status').textContent=pageValidationPending?'当前页已变化，任务结束后重新校验':s?.page?.message||'请选择游戏后校验页面';
  el<HTMLButtonElement>('validate').disabled=busy||!s?.selected;
  el<HTMLButtonElement>('scan').disabled=busy||pageValidationPending||!connected||!s?.selected||s.page?.valid===false;
  const plan=s?.plan;
  const actionable=!!plan&&plan.added+plan.updated+plan.removed>0;
  el<HTMLButtonElement>('import').disabled=busy||pageValidationPending||!s?.scan||s.page?.valid===false||!actionable;
  const summary=s?.scan?.summary;
  const diff=plan?`新增 ${plan.added} · 更新 ${plan.updated} · 源缺失 ${plan.removed} · 未变 ${plan.unchanged}${plan.blocked?` · 跳过 ${plan.blocked}`:''}${plan.removalSuppressed?' · 扫描不完整，未标记源删除':''}`:'';
  const layout=summary&&(summary.layoutReferences||summary.layoutNineSlice||summary.layoutIgnored)
    ?` · 布局引用 ${summary.layoutReferences||0} · 九宫格 ${summary.layoutNineSlice||0}${summary.layoutIgnored?` · 公共引用忽略 ${summary.layoutIgnored}`:''}`:'';
  el('summary').textContent=summary?`图集 ${summary.atlases} · 散图 ${summary.sprites} · 独立图片 ${summary.standalone} · 异常 ${summary.errors}${layout}${s?.scan?.complete?'':' · 扫描不完整'} · ${diff}`:plan?`上次操作 · ${diff}`:'尚未扫描';
  const details=el('details');details.textContent=[...(s?.scan?.errors||[]),...(plan?.messages||[])].join('\n');details.classList.toggle('hidden',!details.textContent);
  const progress=s?.progress||{done:0,total:0};
  el('progress').textContent=`${progress.done} / ${progress.total}`;
  el<HTMLProgressElement>('bar').max=progress.total||1;el<HTMLProgressElement>('bar').value=progress.done;

  const editing=editingId!==undefined;
  for(const id of ['save','new','close','game-name','game-path','maintained']) (el(id) as HTMLInputElement).disabled=busy;
  input('game-id').disabled=busy||editing;
  el('form-title').textContent=editing?'编辑登记':'新建登记';
  const note=el('game-id-note');
  note.textContent=editing?'编号已锁定；如需修改请删除该登记后重新添加。':'用于识别游戏与资源身份，保存后不可修改。';
  note.classList.toggle('locked',editing);

  const list=el('project-list');list.replaceChildren();
  const projects=workflow?.allProjects()||[];
  el('project-count').textContent=`${projects.length} 个`;
  if(!projects.length) {
    const empty=document.createElement('p');empty.className='empty';empty.textContent='尚无登记';list.append(empty);
  }
  for(const project of projects) {
    const row=document.createElement('div');row.className='entry'+(project.id===editingId?' active':'');
    const name=document.createElement('div');name.className='entry-name';name.textContent=project.name;row.append(name);
    const id=document.createElement('div');id.className='muted small';id.textContent=`${project.id}${project.maintained?' · 长期维护':''}`;row.append(id);
    const path=document.createElement('div');path.className='entry-path';path.textContent=project.path;path.title=project.path;row.append(path);
    const meta=document.createElement('div');meta.className='entry-meta';
    const edit=document.createElement('button');edit.textContent='编辑';edit.title='修改此游戏的名称、路径和长期维护标记；项目编号保持不变。';edit.disabled=busy;
    edit.onclick=()=>{input('game-name').value=project.name;input('game-id').value=project.id;input('game-path').value=project.path;input('maintained').checked=project.maintained;editingId=project.id;render();};
    const remove=document.createElement('button');remove.textContent='删除';remove.title='仅删除本机登记，不删除磁盘资源或已有 Figma 内容。';remove.disabled=busy;
    remove.onclick=()=>void run(async()=>{await workflow!.deleteProject(project.id);resetForm();});
    const actions=document.createElement('div');actions.className='entry-actions';actions.append(edit,remove);meta.append(actions);row.append(meta);list.append(row);
  }
}
function resetForm() {el<HTMLFormElement>('registration').reset();editingId=undefined;render();}
async function clearPairing() {try{await rpc('pairing-clear',{});}catch{}remembered=false;}
async function connectHelper(address:string,token:string) {
  if(workflow?.state.busy)return;
  try {
    workflow=new Workflow(new HelperClient(address,token),platform,render);
    await workflow.connect();
  } catch(error) {
    if(error instanceof HelperAuthError) await clearPairing();
    throw error;
  }
  input('token').value='';
  if(input('remember').checked) {
    await rpc('pairing-save',{pairing:{schemaVersion:1,address,token}});
    remembered=true;
  } else {
    await clearPairing();
  }
}
async function run(action:()=>Promise<void>) {
  uiError='';
  try{await action();}catch(error){uiError=error instanceof Error?error.message:'操作失败';}
  if(pageValidationPending&&workflow&&!workflow.state.busy) {
    pageValidationPending=false;
    workflow.invalidateScan();
    const taskError=uiError;
    await run(()=>workflow!.validatePage());
    if(taskError)uiError=uiError?`${taskError}\n${uiError}`:taskError;
    render();
    return;
  }
  render();
}
el('connect').onclick=()=>void run(()=>connectHelper(input('address').value.trim(),input('token').value.trim()));
el('forget').onclick=()=>void run(async()=>{await clearPairing();input('token').value='';input('remember').checked=false;});
el('remember').onchange=()=>{if(!input('remember').checked&&remembered)void run(()=>clearPairing());else render();};
el('manage').onclick=()=>dialog.showModal();
el('close').onclick=()=>{if(!workflow?.state.busy)dialog.close();};
dialog.addEventListener('cancel',event=>{if(workflow?.state.busy)event.preventDefault();});
el('new').onclick=()=>resetForm();
el('search').oninput=render;
el('project').onchange=()=>{const id=el<HTMLSelectElement>('project').value;if(workflow?.state.busy||workflow?.state.selected?.id===id)return;void run(()=>workflow!.selectProject(id));};
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
    else if(workflow){workflow.invalidateScan();void run(()=>workflow!.validatePage());}
    return;
  }
  const task=pending.get(message.requestId);if(!task)return;
  clearTimeout(task.timer);pending.delete(message.requestId);
  if(message.error)task.reject(new Error(message.error));else task.resolve(message.result);
});
render();
async function bootstrap() {
  try {
    const pairing=await rpc<Pairing|null>('pairing-load',{});
    if(!pairing)return;
    input('address').value=pairing.address;input('token').value=pairing.token;
    input('remember').checked=true;remembered=true;render();
    await run(()=>connectHelper(pairing.address,pairing.token));
  } catch { /* storage unavailable: keep manual pairing available */ }
}
void bootstrap();
