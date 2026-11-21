import {test,expect} from '@playwright/test';
import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
// Public helper fixture launches the real Rust binary.
// @ts-ignore JS fixture is intentionally shared across the two owned packages.
import {fixture} from '../../../local-helper/tests/fixture.mjs';

test('management dialog, full search, real scan, task lock, progress and hover guidance',async({page})=>{
  const f=await fixture();
  const server=createServer(async(req,res)=>{
    if(req.url==='/ui.html') {res.setHeader('Content-Type','text/html; charset=utf-8');res.end(await readFile(new URL('../../dist/ui.html',import.meta.url)));}
    else {res.setHeader('Content-Type','text/html; charset=utf-8');res.end(`<iframe title="plugin" sandbox="allow-scripts" src="/ui.html" style="width:520px;height:720px"></iframe>
    <script>
    window.imported=null;window.pairing=null;
    addEventListener('message',e=>{
      const m=e.data.pluginMessage;if(!m)return;
      const reply=result=>e.source.postMessage({pluginMessage:{type:'result',requestId:m.requestId,result}},'*');
      if(m.type==='cancel'){window.cancelRequests=(window.cancelRequests||0)+1;if(m.requestId)reply(true);return;}
      if(!m.requestId)return;
      if(m.type==='pairing-load'){reply(window.pairing);return;}
      if(m.type==='pairing-save'){window.pairing=m.pairing;reply(true);return;}
      if(m.type==='pairing-clear'){window.pairing=null;reply(true);return;}
      if(m.type==='validate')reply(window.currentPageInvalid?{valid:false,message:'非空且未绑定页面不可导入'}:{valid:true,message:'空白页可导入'});
      if(m.type==='preview'){window.plan={schemaVersion:1,added:m.scan.resources.length,updated:0,removed:0,unchanged:0,blocked:0,removalSuppressed:false,messages:[]};reply(window.plan);}
      if(m.type==='import'){window.imported=m.scan;e.source.postMessage({pluginMessage:{type:'progress',progress:{done:1,total:2}}},'*');window.finish=cancelled=>reply({...window.plan,applied:{added:cancelled?1:window.plan.added,updated:0,removed:0},failures:[],cancelled:!!cancelled});}
    });
    </script>`);}
  });
  await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));
  try {
    await page.goto('http://127.0.0.1:'+ (server.address() as {port:number}).port);
    const ui=page.frameLocator('iframe');
    await ui.getByLabel('助手地址').fill(f.base);
    await ui.getByLabel('配对令牌').fill(f.token);
    await ui.getByRole('button',{name:'连接助手',exact:true}).click();
    await expect(ui.getByTestId('connection')).toHaveText('已连接');
    await expect(ui.getByRole('button',{name:'取消任务',exact:true})).toBeDisabled();
    await ui.getByRole('button',{name:'管理项目',exact:true}).hover();
    const floating=ui.locator('#manage').locator('..').locator('.tooltip');
    await expect(floating).toBeVisible();
    const bounds=await floating.evaluate(el=>{const r=el.getBoundingClientRect();return {left:r.left,right:r.right,top:r.top,bottom:r.bottom,width:innerWidth,height:innerHeight};});
    expect(bounds.left>=0&&bounds.top>=0&&bounds.right<=bounds.width&&bounds.bottom<=bounds.height).toBe(true);
    await ui.getByRole('button',{name:'管理项目',exact:true}).click();
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
    await expect(ui.getByLabel('记住本机配对', {exact:true})).toBeChecked();
    expect(await page.evaluate(()=>(window as any).pairing?.token)).toBe(f.token);
    expect(await ui.locator('body').evaluate(el=>el.scrollHeight<=el.clientHeight)).toBe(true);
    await ui.getByLabel('搜索名称或编号').fill('g3');
    await expect(ui.locator('#project option')).toHaveCount(2);
    await expect(ui.locator('#project')).toContainText('临时游戏');
    await ui.getByLabel('搜索名称或编号').fill('');
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
    await expect(ui.locator('#page-status')).toContainText('空白页可导入');
    await ui.getByRole('button',{name:'扫描资源',exact:true}).click();
    await expect(ui.getByTestId('summary')).toContainText('散图 2');
    await expect(ui.getByTestId('summary')).toContainText('新增 2');
    await ui.getByRole('button',{name:'导入主组件',exact:true}).hover();
    await expect(ui.getByRole('tooltip')).toContainText('新增创建主组件');
    await ui.getByRole('button',{name:'导入主组件',exact:true}).click();
    await expect(ui.locator('#project')).toBeDisabled();
    await expect(ui.getByRole('button',{name:'扫描资源',exact:true})).toBeDisabled();
    await expect(ui.getByRole('button',{name:'导入主组件',exact:true})).toBeDisabled();
    await expect(ui.getByTestId('progress')).toContainText('1 / 2');
    await expect(ui.getByRole('button',{name:'取消任务',exact:true})).toBeEnabled();
    await ui.getByRole('button',{name:'取消任务',exact:true}).hover();
    await expect(ui.getByRole('tooltip')).toContainText('已完成的项会保留');
    await ui.getByRole('button',{name:'取消任务',exact:true}).click();
    await expect.poll(()=>page.evaluate(()=>(window as any).cancelRequests)).toBe(1);
    await page.evaluate(()=>{(window as any).finish(true);});
    await expect(ui.locator('#phase')).toHaveText('已取消');
    await expect(ui.getByTestId('summary')).toContainText('成功 1');
    await expect(ui.getByTestId('summary')).toContainText('已取消');
    await expect(ui.getByRole('button',{name:'取消任务',exact:true})).toBeDisabled();
    await expect(ui.getByRole('button',{name:'导入主组件',exact:true})).toBeEnabled();
    expect(await page.evaluate(()=>(window as any).imported.resources.length)).toBe(2);
    expect(await page.evaluate(()=>'path' in (window as any).imported.project)).toBe(false);
    // A second run only fills what the cancelled run left unfinished.
    await ui.getByRole('button',{name:'导入主组件',exact:true}).click();
    await page.evaluate(()=>{(window as any).finish(false);});
    await expect(ui.locator('#phase')).toHaveText('就绪');
    await expect(ui.getByTestId('summary')).toContainText('上次操作');
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
    await expect(ui.getByTestId('connection')).toHaveText('未连接');
    await expect(ui.locator('#page-status')).toContainText('非空且未绑定');
    await expect(ui.getByRole('alert')).toContainText('请启动 figma-assets-helper');
    await expect(ui.locator('#phase')).toHaveText('失败');
    await page.unroute(f.base+'/v1/scan');
    await f.stop();
    await ui.getByLabel('配对令牌').fill('0'.repeat(64));
    await ui.getByRole('button',{name:'连接助手',exact:true}).click();
    await expect(ui.getByRole('alert')).toContainText('请启动 figma-assets-helper');
  } finally {await new Promise<void>(r=>server.close(()=>r()));await f.cleanup();}
});
