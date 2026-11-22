import {test,expect} from '@playwright/test';
import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
// Public helper fixture launches the real Rust binary.
// @ts-ignore JS fixture is intentionally shared across the two owned packages.
import {fixture} from '../../../local-helper/tests/fixture.mjs';

test('management dialog, maintained dropdown, real scan, task lock, progress and hover guidance',async({page})=>{
  const f=await fixture();
  const server=createServer(async(req,res)=>{
    if(req.url==='/ui.html') {res.setHeader('Content-Type','text/html; charset=utf-8');res.end(await readFile(new URL('../../dist/ui.html',import.meta.url)));}
    else {res.setHeader('Content-Type','text/html; charset=utf-8');res.end(`<iframe title="plugin" sandbox="allow-scripts" src="/ui.html" style="width:350px;height:600px"></iframe>
    <script>
    window.imported=null;window.pairing=null;
    addEventListener('message',e=>{
      const m=e.data.pluginMessage;if(!m)return;
      const reply=result=>e.source.postMessage({pluginMessage:{type:'result',requestId:m.requestId,result}},'*');
      if(m.type==='cancel'){window.cancelRequests=(window.cancelRequests||0)+1;if(m.requestId)reply(true);return;}
      if(!m.requestId)return;
      if(m.type==='helper-path-load'){reply(window.helperPath||'');return;}
      if(m.type==='helper-path-save'){window.helperPath=m.path;reply(true);return;}
      if(m.type==='open-helper-folder'){window.openHelperPath=m.path;reply(true);return;}
      if(m.type==='pairing-load'){reply(window.pairing);return;}
      if(m.type==='pairing-save'){window.pairing=m.pairing;reply(true);return;}
      if(m.type==='pairing-clear'){window.pairing=null;reply(true);return;}
      if(m.type==='categories'){reply({schemaVersion:1,categories:window.categoryConfig||[
        {name:'按钮',color:'#e5484d'},{name:'底板',color:'#8e4ec6'},{name:'图标',color:'#f2a900'},
        {name:'背景',color:'#3e63dd'},{name:'艺术字',color:'#d6409f'},{name:'进度条',color:'#30a46c'},
        {name:'未分类',color:'#8b8d98'}]});return;}
      if(m.type==='selection'){const members=window.selectionMembers||[];reply({schemaVersion:1,members,ignored:window.selectionIgnored||0,mixed:new Set(members.map(x=>x.category)).size>1});return;}
      if(m.type==='set-category'){window.categoryRequest=m;window.categoryRequests=(window.categoryRequests||0)+1;const members=(window.categoryMembers||window.selectionMembers||[]).map(x=>({...x,category:m.category,manual:m.category!=='auto'}));window.selectionMembers=members;reply({schemaVersion:1,action:m.category==='auto'?'auto':'manual',updated:members.length,moved:members.length,messages:[]});return;}
      if(m.type==='validate')reply(window.currentPageInvalid?{valid:false,message:'非空且未绑定页面不可导入'}:{valid:true,message:'空白页可导入'});
      if(m.type==='preview'){window.plan={schemaVersion:1,added:m.scan.resources.length,updated:0,removed:0,unchanged:0,blocked:0,removalSuppressed:false,messages:[]};reply(window.plan);}
      if(m.type==='import'){window.imported=m.scan;e.source.postMessage({pluginMessage:{type:'progress',progress:{done:1,total:2}}},'*');window.finish=cancelled=>reply({...window.plan,applied:{added:cancelled?1:window.plan.added,updated:0,removed:0},failures:[],cancelled:!!cancelled});}
      if(m.type==='compare'){window.compareCalls=(window.compareCalls||0)+1;reply({schemaVersion:1,pageName:'测试游戏（g2）- 图集对照',created:true,groups:2,added:2,removed:0,kept:0,messages:[]});}
      if(m.type==='tidy'){window.tidyCalls=(window.tidyCalls||0)+1;reply({schemaVersion:1,frames:3,moved:2,messages:[]});}
    });
    </script>`);}
  });
  await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));
  try {
    await page.goto('http://127.0.0.1:'+ (server.address() as {port:number}).port);
    const ui=page.frameLocator('iframe');
    await expect(ui.getByRole('button',{name:'先完成设置',exact:true})).toBeDisabled();
    await ui.getByRole('button',{name:'资源助手设置',exact:true}).click();
    await expect(ui.locator('#pairing')).toBeVisible();
    await ui.locator('#address').evaluate((el, base) => { (el as HTMLInputElement).value = base; }, f.base);
    await ui.getByLabel('配对令牌').fill(f.token);
    await ui.getByLabel('资源助手文件夹（用于启动）').fill('E:\\Tools\\resource-helper');
    await ui.locator('#settings-save').click();
    await expect(ui.locator('#pairing')).not.toBeVisible();
    await expect(ui.getByTestId('connection')).toHaveText('资源助手：未连接');
    await ui.getByRole('button',{name:'启动资源助手',exact:true}).click();
    await expect.poll(()=>page.evaluate(()=>(window as any).openHelperPath)).toBe('E:\\Tools\\resource-helper');
    await ui.getByRole('button',{name:'连接资源助手',exact:true}).click();
    await expect(ui.getByTestId('connection')).toHaveText('资源助手：已连接');
    await expect(ui.locator('h1')).toHaveCount(0);
    await expect(ui.locator('#connect')).toBeHidden();
    await expect(ui.locator('#search')).toHaveCount(0);
    await expect(ui.locator('#validate')).toHaveCount(0);
    await expect(ui.getByRole('region',{name:'本机助手'})).toHaveCount(0);
    await expect(ui.getByTestId('action-result')).toBeHidden();
    await expect(ui.getByRole('button',{name:'取消任务',exact:true})).toBeDisabled();
    // 重新整理 needs a selected game; its scope is in the button tooltip.
    await expect(ui.getByRole('button',{name:'重新整理',exact:true})).toBeDisabled();
    await ui.getByRole('button',{name:'管理',exact:true}).hover();
    const floating=ui.locator('#manage').locator('..').locator('.tooltip');
    await expect(floating).toBeVisible();
    const bounds=await floating.evaluate(el=>{const r=el.getBoundingClientRect();return {left:r.left,right:r.right,top:r.top,bottom:r.bottom,width:innerWidth,height:innerHeight};});
    expect(bounds.left>=0&&bounds.top>=0&&bounds.right<=bounds.width&&bounds.bottom<=bounds.height).toBe(true);
    await ui.getByRole('button',{name:'管理',exact:true}).click();
    await expect(ui.getByRole('dialog')).toBeVisible();
    await ui.getByLabel('游戏名称', {exact:true}).fill('测试游戏');
    await ui.getByLabel('项目编号', {exact:true}).fill('g2');
    await ui.getByLabel('资源目录', {exact:true}).fill(f.project);
    await ui.getByLabel('长期维护', {exact:true}).check();
    await ui.getByRole('button',{name:'保存登记',exact:true}).click();
    await expect(ui.getByTestId('project-list')).toContainText('测试游戏');
    await ui.getByLabel('游戏名称', {exact:true}).fill('临时游戏');
    await ui.getByLabel('项目编号', {exact:true}).fill('g3');
    await ui.getByLabel('资源目录', {exact:true}).fill(f.project);
    await ui.getByLabel('长期维护', {exact:true}).uncheck();
    await ui.getByRole('button',{name:'保存登记',exact:true}).click();
    await expect(ui.getByTestId('project-list')).toContainText('临时游戏');
    await expect(ui.getByTestId('project-list')).toContainText(f.project);
    expect(await ui.locator('#management').evaluate(el=>el.scrollHeight<=el.clientHeight)).toBe(true);
    await ui.getByRole('note',{name:'项目编号说明'}).hover();
    await expect(ui.locator('#game-id-help').locator('..').locator('.tooltip')).toContainText('保存后不可修改');
    await ui.getByRole('button',{name:'编辑',exact:true}).first().click();
    await expect(ui.getByLabel('项目编号', {exact:true})).toBeDisabled();
    await expect(ui.locator('#game-id-note')).toContainText('编号已锁定');
    await expect(ui.locator('#game-id')).toHaveCSS('border-top-style','dashed');
    await ui.getByRole('button',{name:'新建登记',exact:true}).click();
    await expect(ui.getByLabel('项目编号', {exact:true})).toBeEnabled();
    await ui.getByRole('button',{name:'关闭管理',exact:true}).click();
    await expect(ui.locator('#project option')).toHaveCount(2);
    expect(await page.evaluate(()=>(window as any).pairing?.token)).toBe(f.token);
    expect(await ui.locator('body').evaluate(el=>el.scrollHeight<=el.clientHeight)).toBe(true);
    await ui.locator('#project').selectOption('g2');
    // Hold a real helper request so the page change occurs deterministically during scanning.
    let releaseScan!:()=>void;
    let scanStarted!:()=>void;
    const held=new Promise<void>(resolve=>{releaseScan=resolve;});
    const started=new Promise<void>(resolve=>{scanStarted=resolve;});
    await page.route(f.base+'/v1/scan',async route=>{scanStarted();await held;await route.continue();});
    await ui.getByRole('button',{name:'扫描资源',exact:true}).click();
    await started;
    await page.evaluate(()=>{
      (window as any).currentPageInvalid=true;
      document.querySelector('iframe')!.contentWindow!.postMessage({pluginMessage:{type:'page-changed'}},'*');
    });
    releaseScan();
    await expect(ui.locator('#page-status')).toContainText('非空且未绑定');
    await expect(ui.getByRole('button',{name:'导入主组件',exact:true})).toBeDisabled();
    await page.unroute(f.base+'/v1/scan');
    await page.evaluate(()=>{
      (window as any).currentPageInvalid=false;
      document.querySelector('iframe')!.contentWindow!.postMessage({pluginMessage:{type:'page-changed'}},'*');
    });
    await expect(ui.locator('#page-status')).toContainText('资源页：可导入');
    await ui.getByRole('button',{name:'扫描资源',exact:true}).click();
    await expect(ui.getByTestId('summary')).toContainText('散图 2');
    await expect(ui.getByTestId('summary')).toContainText('新增 2');
    await expect(ui.getByTestId('summary')).toContainText('扫描耗时');
    await ui.getByRole('button',{name:'导入主组件',exact:true}).hover();
    await expect(ui.getByRole('tooltip')).toContainText('新增创建主组件');
    await ui.getByRole('button',{name:'导入主组件',exact:true}).click();
    await expect(ui.locator('#project')).toBeDisabled();
    await expect(ui.getByRole('button',{name:'扫描资源',exact:true})).toBeDisabled();
    await expect(ui.getByRole('button',{name:'导入主组件',exact:true})).toBeDisabled();
    await expect(ui.getByRole('button',{name:'重新整理',exact:true})).toBeDisabled();
    await expect(ui.getByTestId('progress')).toContainText('1 / 2');
    await expect(ui.getByRole('button',{name:'取消任务',exact:true})).toBeEnabled();
    expect(await ui.locator('body').evaluate(el=>el.scrollHeight<=el.clientHeight)).toBe(true);
    await ui.getByRole('button',{name:'取消任务',exact:true}).hover();
    await expect(ui.getByRole('tooltip')).toContainText('已完成的项会保留');
    await ui.getByRole('button',{name:'取消任务',exact:true}).click();
    await expect.poll(()=>page.evaluate(()=>(window as any).cancelRequests)).toBe(1);
    await page.evaluate(()=>{(window as any).finish(true);});
    await expect(ui.locator('#phase')).toHaveText('已取消');
    await expect(ui.getByTestId('action-result')).toContainText('导入已取消');
    await expect(ui.getByRole('button',{name:'取消任务',exact:true})).toBeDisabled();
    await expect(ui.getByRole('button',{name:'导入主组件',exact:true})).toBeEnabled();
    expect(await page.evaluate(()=>(window as any).imported.resources.length)).toBe(2);
    expect(await page.evaluate(()=>'path' in (window as any).imported.project)).toBe(false);
    // A second run only fills what the cancelled run left unfinished.
    await ui.getByRole('button',{name:'导入主组件',exact:true}).click();
    await page.evaluate(()=>{(window as any).finish(false);});
    await expect(ui.locator('#phase')).toHaveText('就绪');
    await expect(ui.getByTestId('action-result')).toContainText('导入：成功 2');
    await expect(ui.getByTestId('action-result')).toContainText('导入耗时');
    // The optional comparison page stays absent through scan/import until requested.
    expect(await page.evaluate(()=>(window as any).compareCalls||0)).toBe(0);
    await ui.getByRole('button',{name:'对照页',exact:true}).hover();
    await expect(ui.getByRole('tooltip')).toContainText('文件负担');
    await ui.getByRole('button',{name:'对照页',exact:true}).click();
    await expect(ui.getByTestId('action-result')).toContainText('对照页：已创建 2 组');
    await expect(ui.getByTestId('action-result')).toContainText('2 个实例');
    expect(await page.evaluate(()=>(window as any).compareCalls)).toBe(1);
    // 重新整理 explains its scope in hover and only repositions category frames.
    await ui.getByRole('button',{name:'重新整理',exact:true}).hover();
    await expect(ui.getByRole('tooltip')).toContainText('近方形网格');
    await ui.getByRole('button',{name:'重新整理',exact:true}).click();
    await expect(ui.getByTestId('action-result')).toContainText('重新整理：3 个分类 Frame');
    await expect(ui.getByTestId('action-result')).toContainText('移动 2 个');
    await expect(ui.locator('#phase')).toHaveText('就绪');
    expect(await page.evaluate(()=>(window as any).tidyCalls)).toBe(1);
    // 分类区是页面配置回读的彩色标签，不是下拉框；点击即分类，没有应用按钮。
    const tags=ui.locator('#category-tags');
    const tag=(name:string)=>ui.locator(`#category-tags button[data-category="${name}"]`);
    await expect(tags).toBeVisible();
    await expect(ui.locator('#category-tags button')).toHaveCount(7);
    await expect(tag('按钮')).toContainText('按钮');
    await expect(tag('未分类')).toContainText('未分类');
    await expect(ui.getByRole('button',{name:'应用',exact:true})).toHaveCount(0);
    await expect(ui.locator('#category-select')).toHaveCount(0);
    // 面板固定 350×600（showUI 尺寸由主线程测试断言），UI 恰好填满且不整体滚动。
    expect(await ui.locator('body').evaluate(el=>[el.clientWidth,el.clientHeight])).toEqual([350,600]);
    // 颜色来自页面配置（不是写死）：每个标签有稳定色点，同时有名称，选中态不只靠颜色。
    expect(await ui.locator('#category-tags .tag-dot').evaluateAll(nodes=>nodes.map(node=>getComputedStyle(node).backgroundColor)))
      .toEqual(['rgb(229, 72, 77)','rgb(142, 78, 198)','rgb(242, 169, 0)','rgb(62, 99, 221)','rgb(214, 64, 159)','rgb(48, 164, 108)','rgb(139, 141, 152)']);
    // 没有选中本工具主组件时整组标签禁用。
    await expect(tag('按钮')).toBeDisabled();
    await expect(tags).toHaveAttribute('data-disabled','true');
    await page.evaluate(()=>{
      const w=window as any;
      w.selectionMembers=[
        {id:'component-1',name:'按钮/ok',category:'按钮',manual:false,viaInstance:true},
        {id:'component-2',name:'图标/coin',category:'图标',manual:false,viaInstance:false}
      ];
      w.selectionIgnored=1;
      document.querySelector('iframe')!.contentWindow!.postMessage({pluginMessage:{type:'selection-changed'}},'*');
    });
    await expect(ui.getByTestId('selection-status')).toContainText('混合分类：按钮 / 图标');
    await expect(ui.getByTestId('selection-status')).toHaveAttribute('title', /已从 1 个实例定位主组件/);
    await expect(ui.getByTestId('selection-status')).toHaveAttribute('title', /已忽略 1 个非本工具对象/);
    // 混合选择明确显示混合，且不高亮任何单一类别。
    await expect(tags).toHaveAttribute('data-mixed','true');
    await expect(ui.locator('#category-tags button[aria-pressed="true"]')).toHaveCount(0);
    await expect(tag('按钮')).toBeEnabled();
    await tag('艺术字').click();
    await expect(ui.getByTestId('selection-status')).toContainText('当前分类：艺术字');
    await expect(tag('艺术字')).toHaveAttribute('aria-pressed','true');
    await expect(tag('艺术字')).toContainText('✓');
    await expect(tags).toHaveAttribute('data-mixed','false');
    expect(await page.evaluate(()=>(window as any).categoryRequest.category)).toBe('艺术字');
    expect(await page.evaluate(()=>(window as any).categoryRequest.ids.length)).toBe(2);
    expect(await page.evaluate(()=>(window as any).categoryRequests)).toBe(1);
    // 再点已高亮的标签不发起分类请求，也不改写组件。
    await tag('艺术字').click();
    await expect(ui.getByTestId('selection-status')).toContainText('当前分类：艺术字');
    expect(await page.evaluate(()=>(window as any).categoryRequests)).toBe(1);
    expect(await ui.locator('body').evaluate(el=>el.scrollHeight<=el.clientHeight)).toBe(true);
    await expect(ui.locator('.status-card')).toBeInViewport();
    await expect(ui.locator('.app-footer')).toBeInViewport();
    // 类别列表仍来自页面配置回读，不是写死的七类。
    await page.evaluate(()=>{
      const w=window as any;
      w.categoryConfig=[{name:'特殊按钮',color:'#0091ff'},{name:'未分类',color:'#8b8d98'}];
      document.querySelector('iframe')!.contentWindow!.postMessage({pluginMessage:{type:'page-changed'}},'*');
    });
    await expect(ui.locator('#category-tags button')).toHaveCount(2);
    await expect(tag('特殊按钮')).toContainText('特殊按钮');
    await expect(tag('按钮')).toHaveCount(0);
    expect(await ui.locator('body').evaluate(el=>el.scrollHeight<=el.clientHeight)).toBe(true);
    // 类别多到超过四行时，只有标签区内部滚动，主面板不滚动也不被裁掉。
    await page.evaluate(()=>{
      const w=window as any;
      w.categoryConfig=[...Array(20)].map((_,index)=>({name:`活动道具${String.fromCharCode(65+index)}`,color:'#0091ff'}));
      w.categoryConfig.push({name:'未分类',color:'#8b8d98'});
      document.querySelector('iframe')!.contentWindow!.postMessage({pluginMessage:{type:'page-changed'}},'*');
    });
    await expect(ui.locator('#category-tags button')).toHaveCount(21);
    const scrollBox=await tags.evaluate(node=>{
      const style=getComputedStyle(node);
      const button=node.querySelector('button')!;
      return {overflowY:style.overflowY,scrollHeight:node.scrollHeight,clientHeight:node.clientHeight,
        rowHeight:button.getBoundingClientRect().height,gap:parseFloat(style.rowGap||style.gap||'0')};
    });
    expect(['auto','scroll'].includes(scrollBox.overflowY)).toBe(true);
    expect(scrollBox.scrollHeight).toBeGreaterThan(scrollBox.clientHeight);
    expect(scrollBox.clientHeight).toBeLessThanOrEqual(Math.round(4*(scrollBox.rowHeight+scrollBox.gap)-scrollBox.gap+1));
    expect(scrollBox.clientHeight).toBeGreaterThanOrEqual(Math.round(3*(scrollBox.rowHeight+scrollBox.gap)-scrollBox.gap));
    await tags.evaluate(node=>{node.scrollTop=node.scrollHeight;});
    expect(await tags.evaluate(node=>node.scrollTop>0)).toBe(true);
    expect(await ui.locator('body').evaluate(el=>el.scrollHeight<=el.clientHeight)).toBe(true);
    await expect(ui.locator('.status-card')).toBeInViewport();
    await expect(ui.locator('.app-footer')).toBeInViewport();
    let releaseFailedScan!:()=>void;
    let failedScanStarted!:()=>void;
    const failedHeld=new Promise<void>(resolve=>{releaseFailedScan=resolve;});
    const failedStarted=new Promise<void>(resolve=>{failedScanStarted=resolve;});
    await page.route(f.base+'/v1/scan',async route=>{failedScanStarted();await failedHeld;await route.abort('connectionfailed');});
    await ui.getByRole('button',{name:'扫描资源',exact:true}).click();
    await failedStarted;
    await page.evaluate(()=>{
      (window as any).currentPageInvalid=true;
      document.querySelector('iframe')!.contentWindow!.postMessage({pluginMessage:{type:'page-changed'}},'*');
    });
    releaseFailedScan();
    await expect(ui.getByTestId('connection')).toHaveText('资源助手：未连接');
    await expect(ui.locator('#page-status')).toContainText('非空且未绑定');
    await expect(ui.getByRole('alert')).toContainText('请启动 resource-helper');
    await expect(ui.locator('#phase')).toHaveText('失败');
    await page.unroute(f.base+'/v1/scan');
    await f.stop();
    await ui.getByRole('button',{name:'连接资源助手',exact:true}).click();
    await expect(ui.getByRole('alert')).toContainText('请启动 resource-helper');
  } finally {await new Promise<void>(r=>server.close(()=>r()));await f.cleanup();}
});
