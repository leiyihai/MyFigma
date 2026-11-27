const {test} = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const {openWorkbench, root} = require('./support.cjs');
const {readFile} = require('node:fs/promises');

test('本地工作台可导入受控原型，预览卡片、独立按钮和统计条', async t => {
  const {page, prototype} = await openWorkbench(t);
  await page.getByLabel('载入原型 HTML').setInputFiles(path.join(root, 'examples/controlled.html'));
  await page.getByRole('status').filter({hasText:'已载入：受控组件样例'}).waitFor();
  await prototype.getByRole('heading', {name:'林间小屋'}).waitFor();
  await prototype.getByRole('button', {name:'收取木材'}).click();
  assert.equal(await prototype.getByLabel('木材数量').textContent(), '128');
  await prototype.getByRole('button', {name:'查看小屋'}).click();
  await prototype.getByRole('heading', {name:'小屋详情'}).waitFor();
  await prototype.getByRole('button', {name:'关闭详情'}).click();
  await page.getByRole('tab', {name:'组件', exact:true}).click();
  await page.getByRole('heading', {name:'组件关系概览'}).waitFor();
  await page.getByRole('tab', {name:'界面', exact:true}).click();
  await prototype.getByRole('heading', {name:'林间小屋'}).waitFor();
});

test('编辑冻结业务鼠标键盘、计时器与动画，工具仍可直达页面状态并恢复预览', async t => {
  const {page, prototype} = await openWorkbench(t);
  await page.getByRole('button', {name:'打开受控示例'}).click();
  await page.getByRole('status').filter({hasText:'已载入：受控组件样例'}).waitFor();
  const ticks=prototype.getByLabel('自动计数');
  const before=await ticks.textContent();
  await page.waitForTimeout(450);
  assert.notEqual(await ticks.textContent(),before,'预览中定时器真实运行');
  await page.getByRole('button',{name:'编辑',exact:true}).click();
  await page.getByRole('status').filter({hasText:'业务输入与自动变化已冻结'}).waitFor();
  const frozen=await ticks.textContent();
  await prototype.getByRole('button',{name:'收取木材'}).click();
  await prototype.locator('body').press('w');
  await page.waitForTimeout(450);
  assert.equal(await prototype.getByLabel('木材数量').textContent(),'120');
  assert.equal(await ticks.textContent(),frozen,'编辑暂停定时器');
  await page.getByRole('button',{name:'卡片 / 详情',exact:true}).click();
  await prototype.getByRole('dialog',{name:'小屋详情'}).waitFor();
  await prototype.getByRole('button',{name:'关闭详情'}).click();
  assert.equal(await prototype.getByRole('dialog',{name:'小屋详情'}).isVisible(),true,'业务关闭按钮被冻结');
  await page.getByRole('button',{name:'统计 / 生产中',exact:true}).click();
  await prototype.getByText('正在生产木材',{exact:true}).waitFor();
  const spinner=prototype.getByLabel('生产动画');
  const matrix=await spinner.evaluate(el=>getComputedStyle(el).transform);
  await page.waitForTimeout(300);
  assert.equal(await spinner.evaluate(el=>getComputedStyle(el).transform),matrix,'CSS 动画冻结且直达不解除编辑');
  await page.getByRole('button',{name:'预览',exact:true}).click();
  await page.getByRole('status').filter({hasText:'原型交互已恢复'}).waitFor();
  await page.waitForTimeout(300);
  assert.notEqual(await spinner.evaluate(el=>getComputedStyle(el).transform),matrix);
  await prototype.getByRole('button',{name:'返回营地'}).click();
  await prototype.getByRole('button',{name:'收取木材'}).click();
  await prototype.locator('body').press('w');
  assert.equal(await prototype.getByLabel('木材数量').textContent(),'136');
  assert.notEqual(await ticks.textContent(),frozen);
});

test('业务导航同步当前页面，编辑点击发稳定节点选择但不触发业务', async t => {
  const {page,prototype}=await openWorkbench(t);
  await page.getByRole('button',{name:'打开受控示例'}).click();
  await page.getByRole('status').filter({hasText:'已载入：受控组件样例'}).waitFor();
  await prototype.getByRole('button',{name:'查看统计'}).click();
  assert.equal(await page.getByRole('button',{name:'统计 / 默认',exact:true}).getAttribute('aria-current'),'true');
  await page.getByRole('button',{name:'编辑',exact:true}).click();
  await page.getByRole('status').filter({hasText:'业务输入与自动变化已冻结'}).waitFor();
  await prototype.getByRole('button',{name:'开始生产'}).click();
  assert.equal(await prototype.getByText('等待安排生产',{exact:true}).isVisible(),true);
  await page.getByText('start-button',{exact:true}).waitFor();
  await page.getByRole('button',{name:'卡片 / 默认',exact:true}).click();
  await prototype.getByRole('heading',{name:'林间小屋'}).click();
  await page.getByText('name-a',{exact:true}).waitFor();
  await prototype.getByRole('heading',{name:'木工作坊'}).click({modifiers:['Shift']});
  await page.getByText('name-a、name-b',{exact:true}).waitFor();
  await prototype.getByRole('heading',{name:'林间小屋'}).click({modifiers:['Shift']});
  await page.getByText('name-b',{exact:true}).waitFor();
});

test('编辑也冻结业务 hover 输入', async t => {
  const {page,prototype}=await openWorkbench(t);
  const html=(await readFile(path.join(root,'examples/controlled.html'),'utf8')).replace('</body>',`<script>document.getElementById('collect').addEventListener('pointerover',()=>{document.querySelector('[aria-label="木材数量"]').textContent='999';});</script></body>`);
  await page.getByLabel('载入原型 HTML').setInputFiles({name:'hover.html',mimeType:'text/html',buffer:Buffer.from(html)});
  await page.getByRole('status').filter({hasText:'已载入：受控组件样例'}).waitFor();
  await page.getByRole('button',{name:'编辑',exact:true}).click();
  await page.getByRole('status').filter({hasText:'业务输入与自动变化已冻结'}).waitFor();
  await prototype.getByRole('button',{name:'收取木材'}).hover();
  assert.equal(await prototype.getByLabel('木材数量').textContent(),'120');
});

test('适配器拒绝冻结或直达时停止不可靠画布，明确提示并允许重新载入', async t => {
  const {page,prototype}=await openWorkbench(t);
  const source=await readFile(path.join(root,'examples/controlled.html'),'utf8');
  const html=source.replace("setMode(next){mode=next;}","setMode(next){if(next==='edit')throw Error('受控冻结拒绝');mode=next;}");
  await page.getByLabel('载入原型 HTML').setInputFiles({name:'reject-mode.html',mimeType:'text/html',buffer:Buffer.from(html)});
  await page.getByRole('status').filter({hasText:'已载入：受控组件样例'}).waitFor();
  await page.getByRole('button',{name:'编辑',exact:true}).click();
  await page.getByRole('heading',{name:'原型控制失败，画布已停止'}).waitFor();
  assert.equal(await page.locator('iframe[title="原型画布"]').count(),0);
  assert.match(await page.getByRole('status').textContent(),/受控冻结拒绝/);
  await page.getByRole('button',{name:'重新载入当前原型',exact:true}).click();
  await prototype.getByRole('heading',{name:'林间小屋'}).waitFor();
  const badNav=source.replace('function navigate({pageId,stateId}) {',"function navigate({pageId,stateId}) {if(stateId==='detail'){document.querySelector('h1').textContent='半提交';throw Error('受控导航拒绝');}");
  await page.getByLabel('载入原型 HTML').setInputFiles({name:'reject-navigation.html',mimeType:'text/html',buffer:Buffer.from(badNav)});
  await page.getByRole('status').filter({hasText:'已载入：受控组件样例'}).waitFor();
  await page.getByRole('button',{name:'卡片 / 详情',exact:true}).click();
  await page.getByRole('heading',{name:'原型控制失败，画布已停止'}).waitFor();
  assert.equal(await page.locator('iframe[title="原型画布"]').count(),0);
  assert.match(await page.getByRole('status').textContent(),/受控导航拒绝/);
});

test('不兼容、能力缺失、重复节点和不可用资源明确拒绝，不破坏当前预览', async t => {
  const {page,prototype}=await openWorkbench(t);
  await page.getByRole('button',{name:'打开受控示例'}).click();
  await page.getByRole('status').filter({hasText:'已载入：受控组件样例'}).waitFor();
  await prototype.getByRole('button',{name:'收取木材'}).click();
  const source=await readFile(path.join(root,'examples/controlled.html'),'utf8');
  const cases=[
    ['<html><head></head><body>未适配</body></html>',/缺少 workbench-manifest/],
    [source.replace('"version":1','"version":99'),/不支持的原型格式或版本/],
    [source.replace('"freeze",',''),/缺少必要能力/],
    [source.replace('window.WorkbenchPrototype={','window.NotAnAdapter={'),/缺少原型适配能力/],
    [source.replace('data-wb-node="name-b"','data-wb-node="name-a"'),/稳定节点标识缺失、为空或重复/],
    [source.replace('</head>','<link rel="stylesheet" href="https://example.invalid/missing.css"></head>'),/仅支持内联资源/],
    [source.replace('</style>','.art{background-image:url(https://example.invalid/missing.png)}</style>'),/仅支持内联资源/],
    [source.replace('alt="林间小屋示意图" src="data:image','alt="林间小屋示意图" src="https://example.invalid/missing.png#data:image'),/图片资源不可用/]
  ];
  for(const [html,error] of cases){
    t.diagnostic('拒绝边界：'+error.source);
    await page.getByLabel('载入原型 HTML').setInputFiles({name:'incompatible.html',mimeType:'text/html',buffer:Buffer.from(html)});
    await page.waitForFunction(pattern=>new RegExp(pattern).test(document.querySelector('[role="status"]').textContent),error.source);
    assert.equal(await prototype.getByLabel('木材数量').textContent(),'128','失败导入保留当前原型业务状态');
    assert.equal(await page.locator('iframe[title="原型画布"]').count(),1);
  }
});

test('真实 RAF、WAAPI 和一次计时器在编辑中停止，原本暂停动画不被误恢复', async t => {
  const {page,prototype}=await openWorkbench(t);
  const html=(await readFile(path.join(root,'examples/controlled.html'),'utf8')).replace('</body>',`<div style="position:absolute;bottom:0;left:0"><output aria-label="帧计数">0</output><output aria-label="一次任务">等待</output><span aria-label="脚本动画" style="display:inline-block">◆</span><span aria-label="原本暂停动画" style="display:inline-block">◇</span></div><script>(()=>{let frames=0;function step(){document.querySelector('[aria-label="帧计数"]').textContent=++frames;requestAnimationFrame(step);}requestAnimationFrame(step);setTimeout(()=>document.querySelector('[aria-label="一次任务"]').textContent='完成',1200);document.querySelector('[aria-label="脚本动画"]').animate([{transform:'translateX(0)'},{transform:'translateX(100px)'}],{duration:900,iterations:Infinity});const paused=document.querySelector('[aria-label="原本暂停动画"]').animate([{transform:'translateX(0)'},{transform:'translateX(100px)'}],{duration:900,iterations:Infinity});paused.pause();})();</script></body>`);
  await page.getByLabel('载入原型 HTML').setInputFiles({name:'animation.html',mimeType:'text/html',buffer:Buffer.from(html)});
  await page.getByRole('status').filter({hasText:'已载入：受控组件样例'}).waitFor();
  const frames=prototype.getByLabel('帧计数'), animation=prototype.getByLabel('脚本动画'), paused=prototype.getByLabel('原本暂停动画');
  const initial=await frames.textContent();
  const initialTransform=await animation.evaluate(el=>getComputedStyle(el).transform);
  await page.waitForTimeout(100);
  assert.notEqual(await frames.textContent(),initial);
  assert.notEqual(await animation.evaluate(el=>getComputedStyle(el).transform),initialTransform,JSON.stringify(await animation.evaluate(el=>el.getAnimations().map(a=>({playState:a.playState,currentTime:a.currentTime,pending:a.pending})))));
  assert.equal(await prototype.getByLabel('一次任务').textContent(),'等待');
  await page.getByRole('button',{name:'编辑',exact:true}).click();
  await page.getByRole('status').filter({hasText:'业务输入与自动变化已冻结'}).waitFor();
  const frameFrozen=await frames.textContent(), transformFrozen=await animation.evaluate(el=>getComputedStyle(el).transform), pausedTransform=await paused.evaluate(el=>getComputedStyle(el).transform);
  await page.waitForTimeout(1300);
  assert.equal(await frames.textContent(),frameFrozen);
  assert.equal(await animation.evaluate(el=>getComputedStyle(el).transform),transformFrozen);
  assert.equal(await prototype.getByLabel('一次任务').textContent(),'等待');
  await page.getByRole('button',{name:'预览',exact:true}).click();
  await page.getByRole('status').filter({hasText:'原型交互已恢复'}).waitFor();
  assert.equal(await prototype.getByLabel('一次任务').textContent(),'等待','暂停时长不补跑');
  await page.waitForTimeout(1300);
  assert.notEqual(await frames.textContent(),frameFrozen);
  assert.notEqual(await animation.evaluate(el=>getComputedStyle(el).transform),transformFrozen);
  assert.equal(await paused.evaluate(el=>getComputedStyle(el).transform),pausedTransform);
  assert.equal(await prototype.getByLabel('一次任务').textContent(),'完成');
});

test('原型脚本无宿主权限，伪造窗口消息和非预期控制不能更改工作台', async t => {
  const {page,prototype}=await openWorkbench(t);
  const html=(await readFile(path.join(root,'examples/controlled.html'),'utf8')).replace('</body>',`<button id="attack" data-wb-node="attack-button" style="position:absolute;right:10px;top:10px">尝试越权</button><output aria-label="隔离结果" style="position:absolute;right:10px;bottom:10px">尚未尝试</output><script>document.getElementById('attack').onclick=()=>{let result;try{parent.Workbench.updateProject(p=>{p.name='被篡改';});result='越权成功';}catch{result='访问已隔离';}document.querySelector('[aria-label="隔离结果"]').textContent=result;for(const type of ['selection','location','project:update','response','ready'])parent.postMessage({protocol:'workbench-bridge-v1',type,requestId:'forged',payload:{nodeIds:['forged-node'],pageId:'dashboard',stateId:'busy',name:'被篡改'}},'*');};</script></body>`);
  const requests=[];
  page.on('request',request=>{if(/^https?:/.test(request.url()))requests.push(request.url());});
  await page.getByLabel('载入原型 HTML').setInputFiles({name:'isolated.html',mimeType:'text/html',buffer:Buffer.from(html)});
  await page.getByRole('status').filter({hasText:'已载入：受控组件样例'}).waitFor();
  await prototype.getByRole('button',{name:'尝试越权'}).click();
  assert.equal(await prototype.getByLabel('隔离结果').textContent(),'访问已隔离');
  await page.waitForTimeout(100);
  assert.equal(await page.getByRole('button',{name:'卡片 / 默认',exact:true}).getAttribute('aria-current'),'true');
  assert.equal(await page.getByText('未选择内容',{exact:true}).isVisible(),true);
  assert.equal(await page.getByText('被篡改',{exact:true}).count(),0);
  assert.equal(await page.locator('iframe[title="原型画布"]').getAttribute('sandbox'),'allow-scripts');
  assert.deepEqual(requests,[]);
});
