import {HelperAuthError,HelperClient,Workflow} from './api';
import type {CategoryState,Platform,Progress,Project,SelectionState} from './api';
import {defaultCategories,categoryNameProblem,nextCategoryColor,unsortedCategory} from './category';
import type {Category} from './category';
type Pairing={schemaVersion:1;address:string;token:string};
function el<T extends HTMLElement>(id:string):T {const node=document.getElementById(id);if(!node)throw new Error('界面元素缺失');return node as T;}
function input(id:string) {return el<HTMLInputElement>(id);}
function formatDuration(ms:number|undefined):string {
  if(ms===undefined)return '';
  return ms<1000?`${Math.max(0,Math.round(ms))} 毫秒`:`${(ms/1000).toFixed(1)} 秒`;
}
let sequence=0;
const pending=new Map<number,{resolve:(value:any)=>void;reject:(error:Error)=>void;timer:ReturnType<typeof setTimeout>}>();
let reportProgress:((value:Progress)=>void)|undefined;
function rpc<T>(type:string,payload:object,timeout=60000):Promise<T> {
  return new Promise((resolve,reject)=>{
    const requestId=++sequence;
    const timer=setTimeout(()=>{pending.delete(requestId);reject(new Error('Figma 响应超时，请关闭并重新打开插件'));},timeout);
    pending.set(requestId,{resolve,reject,timer});
    parent.postMessage({pluginMessage:{type,requestId,...payload}},'*');
  });
}
const platform:Platform={
  validate:project=>rpc('validate',{project}),
  preview:scan=>rpc('preview',{scan}),
  async importResources(scan,progress,cancellation){
    reportProgress=progress;
    // The figure import runs in the plugin main thread; forward cancellation there.
    const stop=cancellation?.onCancel(()=>{void rpc('cancel',{}).catch(()=>{});})||(()=>{});
    // Large projects can take minutes; keep the bridge open until the main thread completes.
    try{return await rpc<import('./api').ImportReport>('import',{scan},15*60*1000);}
    finally{reportProgress=undefined;stop();}
  },
  compare:project=>rpc('compare',{project}),
  tidy:project=>rpc('tidy',{project}),
  selection:project=>rpc('selection',{project}),
  categories:()=>rpc('categories',{}),
  addCategory:(project,name)=>rpc('add-category',{project,name}),
  removeCategory:(project,name)=>rpc('remove-category',{project,name}),
  setCategory:(project,ids,category)=>rpc('set-category',{project,ids,category})
};
let workflow:Workflow|undefined;
// Category choices come from the page; the default seven are only a fallback.
let categoryChoices:readonly Category[]=defaultCategories;
let uiError='';
let pageValidationPending=false;
let remembered=false;
let helperFolderOpened=false;
let editingId:string|undefined;
const dialog=el<HTMLDialogElement>('management');
const pairingDialog=el<HTMLDialogElement>('pairing');
const categoryManager=el<HTMLDialogElement>('category-manager');
const detailsDialog=el<HTMLDialogElement>('details-dialog');
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
function tooltip(button:HTMLButtonElement):HTMLElement {
  const text=button.title;if(!text)return button;
  button.removeAttribute('title');
  const wrap=document.createElement('span');wrap.className='action';
  button.replaceWith(wrap);wrap.append(button);
  const tip=document.createElement('span');tip.className='tooltip';tip.setAttribute('role','tooltip');tip.textContent=text;wrap.append(tip);
  wrap.addEventListener('mouseenter',()=>placeTooltip(wrap));
  wrap.addEventListener('focusin',()=>placeTooltip(wrap));
  const hide=()=>{tip.style.display='none';};
  wrap.addEventListener('mouseleave',hide);wrap.addEventListener('focusout',hide);
  return wrap;
}
document.querySelectorAll<HTMLButtonElement>('button').forEach(tooltip);
document.querySelectorAll<HTMLElement>('.help-wrap').forEach(wrap=>{
  wrap.addEventListener('mouseenter',()=>placeTooltip(wrap));
  wrap.addEventListener('focusin',()=>placeTooltip(wrap));
  const tip=wrap.querySelector<HTMLElement>('.tooltip');
  if(tip){const hide=()=>{tip.style.display='none';};wrap.addEventListener('mouseleave',hide);wrap.addEventListener('focusout',hide);}
});
// 类别标签：页面配置回读的顺序与颜色平铺，名称与选中态不只依赖颜色。
// 标签节点只在配置变化时重建，选中/混合/禁用只更新属性，保留键盘焦点。
let tagSignature='';
let lastCurrentTag='';
// 类别管理弹窗的一次会话状态：删除确认与最近一次变更结果，关闭后不保留。
let pendingCategoryRemoval='';
let categoryNotice='';
function buildTags(container:HTMLElement) {
  container.replaceChildren();
  for(const category of categoryChoices) {
    const button=document.createElement('button');
    button.type='button';
    button.className='category-tag';
    button.dataset.category=category.name;
    button.style.setProperty('--tag',category.color);
    button.setAttribute('aria-pressed','false');
    const dot=document.createElement('span');dot.className='tag-dot';dot.setAttribute('aria-hidden','true');
    const name=document.createElement('span');name.className='tag-name';name.textContent=category.name;
    button.append(dot,name);
    button.onclick=()=>void run(()=>classifyAs(category.name));
    button.title='点击把选中的主组件移到该类别';
    container.append(tooltip(button));
  }
  // 恢复自动分类原先挂在被移除的下拉框里，属于 #8 已确认的能力，仍需可达。
  // 它放在标签区内部的末端，跟随标签区一起滚动，不额外撑高面板。
  const restore=document.createElement('button');
  restore.type='button';
  restore.id='restore-auto';
  restore.className='category-tag category-action';
  restore.textContent='恢复自动分类';
  restore.title='清除人工分类覆盖，按当前名称前缀与尺寸规则重新归类；不确定时回到未分类。';
  restore.onclick=()=>void run(restoreAuto);
  container.append(tooltip(restore));
}
function setTagHint(button:HTMLButtonElement,text:string) {
  const wrap=button.parentElement;
  const tip=wrap&&wrap.classList.contains('action')?wrap.querySelector<HTMLElement>('.tooltip'):undefined;
  if(tip) tip.textContent=text;else button.title=text;
}
function renderTags(selection:SelectionState|undefined,busy:boolean) {
  const container=el('category-tags');
  const signature=categoryChoices.map(category=>`${category.name}\u0000${category.color}`).join('\u0001');
  if(signature!==tagSignature) {tagSignature=signature;buildTags(container);}
  const members=selection?.members||[];
  const inSelection=new Set(members.map(member=>member.category));
  const mixed=!!selection?.mixed||inSelection.size>1;
  const disabled=busy||!members.length;
  container.dataset.mixed=String(mixed);
  container.dataset.disabled=String(disabled);
  container.setAttribute('aria-disabled',String(disabled));
  let currentTag:HTMLButtonElement|undefined;
  container.querySelectorAll<HTMLButtonElement>('button[data-category]').forEach(button=>{
    const name=button.dataset.category!;
    const current=!mixed&&inSelection.has(name);
    button.setAttribute('aria-pressed',String(current));
    button.disabled=disabled;
    setTagHint(button,disabled?'先选中本工具主组件':current?'当前类别，点击不改写':`移到「${name}」`);
    const check=button.querySelector('.tag-check');
    if(current&&!check) {const mark=document.createElement('span');mark.className='tag-check';mark.textContent='✓';mark.setAttribute('aria-hidden','true');button.append(mark);}
    else if(!current&&check) check.remove();
    if(current) currentTag=button;
  });
  const restore=container.querySelector<HTMLButtonElement>('#restore-auto');
  if(restore) {
    restore.disabled=disabled;
    setTagHint(restore,disabled?'先选中本工具主组件':'清除人工覆盖并按当前规则重新归类');
  }
  // 只调整标签区自身的滚动位置：高亮切换后当前类别在四行窗口外时滚到可见，
  // 主面板仍不滚动；同一高亮不反复夺回用户主动滚动的位置。
  const currentName=currentTag?.dataset.category||'';
  if(currentTag&&currentName!==lastCurrentTag&&container.scrollHeight>container.clientHeight) {
    const box=container.getBoundingClientRect(),tag=currentTag.getBoundingClientRect();
    if(tag.top<box.top) container.scrollTop-=(box.top-tag.top);
    else if(tag.bottom>box.bottom) container.scrollTop+=(tag.bottom-box.bottom);
  }
  lastCurrentTag=currentName;
}
async function restoreAuto() {
  const selection=workflow?.state.selection;
  if(!workflow?.state.selected||!selection?.members.length)return;
  await workflow.setCategory('auto');
}
async function classifyAs(category:string) {
  const selection=workflow?.state.selection;
  if(!workflow?.state.selected||!selection?.members.length)return;
  // 点击已高亮的标签不产生写入。
  if(selection.members.every(member=>member.category===category))return;
  await workflow.setCategory(category);
}
function renderCategoryManager(busy:boolean,connected:boolean) {
  const names=categoryChoices.map(category=>category.name);
  if(pendingCategoryRemoval&&!names.includes(pendingCategoryRemoval))pendingCategoryRemoval='';
  const open=categoryManager.open;
  el('category-error').textContent=open?uiError:'';
  el('category-notice').textContent=categoryNotice;
  const list=el('category-list');
  list.replaceChildren();
  for(const category of categoryChoices) {
    const row=document.createElement('li');
    row.className='category-manage-row';
    row.dataset.category=category.name;
    const dot=document.createElement('span');
    dot.className='category-dot';dot.style.setProperty('--tag',category.color);dot.setAttribute('aria-hidden','true');
    const name=document.createElement('span');name.className='category-manage-name';name.textContent=category.name;
    row.append(dot,name);
    if(category.name===unsortedCategory) {
      const fallback=document.createElement('span');fallback.className='chip';fallback.textContent='兜底类别';
      fallback.title='无法确定用途的组件归入此类别，因此不能删除。';
      row.append(fallback);
    } else {
      const remove=document.createElement('button');
      remove.type='button';remove.className='quiet';remove.dataset.remove=category.name;remove.textContent='删除';
      remove.title=`删除类别「${category.name}」：其中的主组件会先移到「未分类」。`;
      remove.disabled=busy||!connected;
      // 不用悬浮提示：删除后确认条紧贴在列表下方出现，浮层会盖住它；改用原生 title。
      remove.onclick=()=>{pendingCategoryRemoval=category.name;categoryNotice='';render();};
      row.append(remove);
    }
    list.append(row);
  }
  const bar=el('category-confirm');
  bar.replaceChildren();
  bar.hidden=!pendingCategoryRemoval;
  if(pendingCategoryRemoval) {
    bar.dataset.confirm=pendingCategoryRemoval;
    const dot=document.createElement('span');
    dot.className='category-dot';
    dot.style.setProperty('--tag',categoryChoices.find(category=>category.name===pendingCategoryRemoval)?.color||'#8b8d98');
    dot.setAttribute('aria-hidden','true');
    const text=document.createElement('span');text.className='category-manage-name';
    text.textContent=`删除「${pendingCategoryRemoval}」？其中的主组件会移到「${unsortedCategory}」`;
    const actions=document.createElement('span');actions.className='confirm-actions';
    const confirm=document.createElement('button');
    confirm.type='button';confirm.className='primary';confirm.textContent='删除类别';
    confirm.disabled=busy||!connected||!workflow?.state.selected;
    const removing=pendingCategoryRemoval;
    confirm.onclick=()=>void run(()=>deleteCategory(removing));
    const cancel=document.createElement('button');
    cancel.type='button';cancel.className='quiet';cancel.textContent='取消';
    cancel.onclick=()=>{pendingCategoryRemoval='';render();};
    actions.append(confirm,cancel);
    bar.append(dot,text,actions);
  } else delete bar.dataset.confirm;
  const value=input('new-category').value.trim();
  const problem=categoryNameProblem(value);
  const duplicate=!!value&&names.includes(value);
  const selected=!!workflow?.state.selected;
  const reason=!connected?'先连接资源助手'
    :busy?'任务执行中，请等待完成'
    :!selected?'先选择游戏':!value?'输入类别名称'
    :problem||(duplicate?'已存在同名类别，请换一个名称':undefined);
  el<HTMLButtonElement>('add-category').disabled=!!reason;
  const note=el('new-category-note');
  note.textContent=reason||'颜色按调色板顺序自动分配，已用颜色不会被改写';
  note.classList.toggle('warning',!!reason&&!!value);
  const color=nextCategoryColor(categoryChoices);
  const dot=el('new-category-dot');
  dot.style.setProperty('--tag',color);
  el('new-category-color').textContent=color;
}
async function addCategory() {
  const name=input('new-category').value.trim();
  categoryNotice='';
  const change=await workflow?.addCategory(name);
  input('new-category').value='';
  categoryNotice=change?.message||'';
  // 页面配置是唯一来源：变更后重新回读，标签区与本弹窗共用同一份列表。
  await loadCategories();
}
async function deleteCategory(name:string) {
  categoryNotice='';
  const change=await workflow?.removeCategory(name);
  pendingCategoryRemoval='';
  categoryNotice=change?.message||'';
  await loadCategories();
}
function render() {
  const s=workflow?.state,busy=!!s?.busy,connected=!!s?.connected;
  const connection=el('connection');connection.textContent=connected?'资源助手：已连接':'资源助手：未连接';connection.classList.toggle('connected',connected);
  el('phase').textContent=uiError?'失败':s?.phase||'未连接';
  el('error').textContent=uiError||s?.error||'';
  const connectButton=el<HTMLButtonElement>('connect');
  const hasHelperPath=!!input('helper-path').value.trim();
  const hasToken=!!input('token').value.trim();
  const configured=hasHelperPath&&hasToken;
  connectButton.classList.toggle('hidden',connected);
  connectButton.disabled=busy||!configured;
  connectButton.textContent=!configured?'先完成设置':helperFolderOpened?'连接资源助手':'启动资源助手';
  const settingsButton=el<HTMLButtonElement>('settings');
  settingsButton.disabled=busy;
  settingsButton.classList.toggle('attention',!configured);
  input('address').disabled=busy;input('token').disabled=busy;input('helper-path').disabled=busy;
  el<HTMLButtonElement>('forget').disabled=busy||!remembered;
  const pairingError=el('pairing-error');pairingError.textContent=el<HTMLDialogElement>('pairing').open?uiError:'';
  for(const id of ['manage','project']) (el(id) as HTMLInputElement).disabled=busy||!connected;
  const options=el<HTMLSelectElement>('project');options.replaceChildren(new Option('请选择游戏',''));
  const choices=workflow?.searchProjects('')||[];
  for(const project of choices)options.add(new Option(`${project.name}（${project.id}）`,project.id));
  if(s?.selected)options.value=choices.some(p=>p.id===s.selected!.id)?s.selected.id:'';
  const pageMessage=s?.page?.message||'';
  const pageText=!s?.selected?'选择游戏后自动检查资源页'
    :pageValidationPending?'当前页已变化，任务结束后重新检查'
    :s?.page?.valid?(pageMessage.includes('已绑定')?'资源页：已绑定，可增量更新':'资源页：可导入')
    :`资源页：${pageMessage}`;
  el('page-status').textContent=pageText;
  el('page-status').title=pageMessage||'扫描或导入时也会再次检查当前页；非空未绑定页和绑定其他游戏的页面会被拒绝。';
  el<HTMLButtonElement>('scan').disabled=busy||pageValidationPending||!connected||!s?.selected||s.page?.valid===false;
  const plan=s?.plan;
  const actionable=!!plan&&plan.added+plan.updated+plan.removed>0;
  el<HTMLButtonElement>('import').disabled=busy||pageValidationPending||!s?.scan||s.page?.valid===false||!actionable;
  el<HTMLButtonElement>('cancel').disabled=!busy||(s?.phase!=='扫描中'&&s?.phase!=='导入中');
  const summary=s?.scan?.summary;
  const diff=plan?`新增 ${plan.added} · 更新 ${plan.updated} · 源缺失 ${plan.removed} · 未变 ${plan.unchanged}${plan.blocked?` · 跳过 ${plan.blocked}`:''}${plan.removalSuppressed?' · 扫描不完整，未标记源删除':''}`:'';
  const layout=summary&&(summary.layoutReferences||summary.layoutNineSlice||summary.layoutIgnored)
    ?` · 布局引用 ${summary.layoutReferences||0} · 九宫格 ${summary.layoutNineSlice||0}${summary.layoutIgnored?` · 公共引用忽略 ${summary.layoutIgnored}`:''}`:'';
  let summaryText=summary?`图集 ${summary.atlases} · 散图 ${summary.sprites} · 独立图片 ${summary.standalone} · 异常 ${summary.errors}${layout}${s?.scan?.complete?'':' · 扫描不完整'} · ${diff}`:plan?`上次操作 · ${diff}`:'尚未扫描';
  if(summary&&s?.scanDurationMs!==undefined)summaryText+=` · 扫描耗时 ${formatDuration(s.scanDurationMs)}`;
  el('summary').textContent=summaryText;
  el<HTMLButtonElement>('compare').disabled=busy||!s?.selected;
  el<HTMLButtonElement>('tidy').disabled=busy||!s?.selected;
  let notice=s?.notice||'';
  if(notice.startsWith('导入')&&s?.importDurationMs!==undefined)notice+=` · 导入耗时 ${formatDuration(s.importDurationMs)}`;
  const noticeEl=el('action-result');noticeEl.textContent=notice;noticeEl.classList.toggle('hidden',!notice);
  const selection=workflow?.state.selection;
  const selectedMembers=selection?.members||[];
  const categoriesInSelection=[...new Set(selectedMembers.map(member=>member.category))];
  const selectionStatus=!s?.selected?'先选择游戏'
    :!selection?'正在读取画布选择…'
    :!selectedMembers.length?'未选中本工具主组件'
    :selection.mixed?`混合分类：${categoriesInSelection.join(' / ')}`
    :`当前分类：${categoriesInSelection[0]}${selectedMembers.some(member=>member.manual)?' · 人工':''}`;
  const selectionStatusEl=el('selection-status');selectionStatusEl.textContent=selectionStatus;
  const viaInstances=selectedMembers.filter(member=>member.viaInstance).length;
  const selectionNotes=[];
  if(viaInstances)selectionNotes.push(`已从 ${viaInstances} 个实例定位主组件`);
  if(selection?.ignored)selectionNotes.push(`已忽略 ${selection.ignored} 个非本工具对象`);
  selectionStatusEl.title=selectionNotes.length?selectionNotes.join('；'):'按 Figma 当前选择处理；实例会定位主组件，无关对象不改动。';
  renderTags(selection,busy);
  const managerOpen=el<HTMLButtonElement>('category-manager-open');
  managerOpen.disabled=busy||!connected;
  renderCategoryManager(busy,connected);
  const detailLines=[...(s?.scan?.errors||[]),...(plan?.messages||[]),...(s?.result?.failures||[]).map(failure=>`失败 ${failure.name}：${failure.reason}`),...(s?.compare?.messages||[])];
  el('details-body').textContent=detailLines.join('\n');
  const detailsButton=el<HTMLButtonElement>('details-open');
  detailsButton.textContent=`详情（${detailLines.length}）`;
  detailsButton.classList.toggle('hidden',!detailLines.length);
  const progress=s?.progress||{done:0,total:0};
  el('progress').textContent=busy&&!progress.total?'进行中':`${progress.done} / ${progress.total}`;
  const bar=el<HTMLProgressElement>('bar');bar.max=progress.total||1;
  if(busy&&!progress.total)bar.removeAttribute('value');else bar.value=progress.done;

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
async function refreshSelection() {
  try{await workflow?.loadSelection();}catch{ /* a changed page clears the transient selection panel */ }
  render();
}
// Page-level categories are the source of truth; the default seven only cover a
// failed readback so the panel stays usable without a configurable page.
async function loadCategories() {
  let choices:readonly Category[]=defaultCategories;
  try {
    const state=await rpc<CategoryState>('categories',{});
    const read=Array.isArray(state?.categories)
      ? state.categories.filter(category=>category&&typeof category.name==='string'&&category.name&&typeof category.color==='string')
      : [];
    if(read.length)choices=read;
  } catch { /* keep the default seven when the page readback fails */ }
  categoryChoices=choices;
  render();
}
async function saveSettings():Promise<void> {
  const token=input('token').value.trim();
  if(!/^[a-f0-9]{64}$/.test(token))throw new Error('请输入 64 位配对令牌');
  await saveHelperPath();
  await rpc('pairing-save',{pairing:{schemaVersion:1,address:input('address').value.trim(),token}});
  remembered=true;
  pairingDialog.close();
}
async function saveHelperPath():Promise<string> {
  const path=input('helper-path').value.trim();
  await rpc('helper-path-save',{path});
  return path;
}
async function openHelperFolder():Promise<void> {
  const path=input('helper-path').value.trim();
  if(!path){openSettings();return;}
  try {
    await saveHelperPath();
    await rpc('open-helper-folder',{path});
    helperFolderOpened=true;
  } catch {
    let copied=false;
    try{await navigator.clipboard.writeText(path);copied=true;}catch{/* sandbox clipboard may be unavailable */}
    openSettings(true);
    throw new Error(copied
      ? `Figma 不允许插件直接打开本地文件夹。路径已复制，请在资源管理器地址栏粘贴打开：${path}`
      : `Figma 不允许插件直接打开本地文件夹。请在设置中复制路径后，在资源管理器地址栏粘贴打开：${path}`);
  }
}
async function connectHelper(address:string,token:string) {
  if(workflow?.state.busy)return;
  if(!token) throw new Error('请输入配对令牌');
  try {
    workflow=new Workflow(new HelperClient(address,token),platform,render);
    await workflow.connect();
  } catch(error) {
    if(error instanceof HelperAuthError) {await clearPairing();input('token').value='';}
    throw error;
  }
  await rpc('pairing-save',{pairing:{schemaVersion:1,address,token}});
  remembered=true;
}
function openSettings(focusPath=false) {
  if(workflow?.state.busy)return;
  uiError='';render();
  if(!pairingDialog.open)pairingDialog.showModal();
  const target=focusPath?input('helper-path'):(input('helper-path').value.trim()?input('token'):input('helper-path'));
  target.focus();
  if(focusPath)target.select();
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
  if(workflow&&!workflow.state.busy&&workflow.state.selected) await refreshSelection();
  render();
}
el('settings').onclick=()=>openSettings();
el('connect').onclick=()=>{
  if(workflow?.state.connected)return;
  const path=input('helper-path').value.trim();
  const token=input('token').value.trim();
  if(!path||!token)return;
  if(!helperFolderOpened) {void run(openHelperFolder);return;}
  void run(()=>connectHelper(input('address').value.trim(),token));
};
el('settings-save').onclick=()=>void run(saveSettings);

el('pairing-close').onclick=()=>pairingDialog.close();
el('forget').onclick=()=>void run(async()=>{await clearPairing();input('token').value='';render();});
el('details-open').onclick=()=>{if(!detailsDialog.open)detailsDialog.showModal();};
el('details-close').onclick=()=>detailsDialog.close();
el('category-manager-open').onclick=()=>{
  if(workflow?.state.busy)return;
  pendingCategoryRemoval='';categoryNotice='';uiError='';
  render();
  if(!categoryManager.open)categoryManager.showModal();
  input('new-category').focus();
};
el('category-manager-close').onclick=()=>{if(!workflow?.state.busy)categoryManager.close();};
categoryManager.addEventListener('cancel',event=>{if(workflow?.state.busy)event.preventDefault();else{pendingCategoryRemoval='';categoryNotice='';}});
input('new-category').oninput=()=>render();
el('add-category').onclick=()=>void run(addCategory);
pairingDialog.addEventListener('cancel',event=>{if(workflow?.state.busy)event.preventDefault();});
el('manage').onclick=()=>dialog.showModal();
el('close').onclick=()=>{if(!workflow?.state.busy)dialog.close();};
dialog.addEventListener('cancel',event=>{if(workflow?.state.busy)event.preventDefault();});
el('new').onclick=()=>resetForm();
el('project').onchange=()=>{const id=el<HTMLSelectElement>('project').value;if(workflow?.state.busy||workflow?.state.selected?.id===id)return;void run(()=>workflow!.selectProject(id));};
el('scan').onclick=()=>void run(()=>workflow!.scan());
el('import').onclick=()=>void run(()=>workflow!.import());
el('cancel').onclick=()=>{workflow?.cancel();};
el('compare').onclick=()=>void run(()=>workflow!.comparePage());
el('tidy').onclick=()=>void run(()=>workflow!.tidy());
el('helper-path').oninput=()=>{helperFolderOpened=false;render();};
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
    void loadCategories();
    if(workflow?.state.busy){pageValidationPending=true;render();}
    else if(workflow){workflow.invalidateScan();void run(()=>workflow!.validatePage());}
    return;
  }
  if(message.type==='selection-changed'){void refreshSelection();return;}
  const task=pending.get(message.requestId);if(!task)return;
  clearTimeout(task.timer);pending.delete(message.requestId);
  if(message.error)task.reject(new Error(message.error));else task.resolve(message.result);
});
render();
async function bootstrap() {
  await loadCategories();
  try {
    const path=await rpc<string>('helper-path-load',{});
    if(typeof path==='string')input('helper-path').value=path;
  } catch { /* optional local setting */ }
  try {
    const pairing=await rpc<Pairing|null>('pairing-load',{});
    if(!pairing)return;
    input('address').value=pairing.address;input('token').value=pairing.token;
    remembered=true;render();
    await run(()=>connectHelper(pairing.address,pairing.token));
  } catch { /* storage unavailable: keep manual pairing available */ }
}
void bootstrap();
