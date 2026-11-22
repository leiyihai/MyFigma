import {test,expect} from '@playwright/test';
import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
// @ts-ignore JS fixture is intentionally shared across the two owned packages.
import {fixture} from '../../../local-helper/tests/fixture.mjs';

const categories=[
  {name:'按钮',color:'#e5484d'},{name:'底板',color:'#8e4ec6'},{name:'图标',color:'#f2a900'},
  {name:'背景',color:'#3e63dd'},{name:'艺术字',color:'#d6409f'},{name:'进度条',color:'#30a46c'},
  {name:'未分类',color:'#8b8d98'}
];

async function host(pairing:unknown) {
  const server=createServer(async(req,res)=>{
    if(req.url==='/ui.html') {res.setHeader('Content-Type','text/html; charset=utf-8');res.end(await readFile(new URL('../../dist/ui.html',import.meta.url)));return;}
    res.setHeader('Content-Type','text/html; charset=utf-8');
    res.end(`<iframe title="plugin" sandbox="allow-scripts" src="/ui.html" style="width:350px;height:600px"></iframe>
    <script>
    window.pairing=${JSON.stringify(pairing)};
    window.trainingCalls=0;
    addEventListener('message',e=>{
      const m=e.data.pluginMessage;if(!m||!m.requestId)return;
      const reply=(result,error)=>e.source.postMessage({pluginMessage:{type:'result',requestId:m.requestId,result,error}},'*');
      if(m.type==='helper-path-load'){reply('');return;}
      if(m.type==='pairing-load'){reply(window.pairing);return;}
      if(m.type==='pairing-save'){window.pairing=m.pairing;reply(true);return;}
      if(m.type==='categories'){reply({schemaVersion:1,categories:${JSON.stringify(categories)}});return;}
      if(m.type==='validate'){reply({valid:true,message:'空白页可导入'});return;}
      if(m.type==='selection'){reply({schemaVersion:1,members:[],ignored:0,mixed:false});return;}
      if(m.type==='training-samples'){
        window.trainingCalls+=1;
        if(window.trainingError){reply(null,window.trainingError);return;}
        reply(window.training||{schemaVersion:1,projectId:m.project&&m.project.id||'',samples:[],ignored:0});
        return;
      }
      reply(null,'未知插件任务');
    });
    </script>`);
  });
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  return {server,url:'http://127.0.0.1:'+(server.address() as {port:number}).port};
}

test('未连接时提交训练样本按钮禁用并说明原因',async({page})=>{
  const {server,url}=await host(null);
  try {
    await page.goto(url);
    const ui=page.frameLocator('iframe');
    const button=ui.locator('#submit-training');
    await expect(button).toBeVisible();
    await expect(button).toBeDisabled();
    await button.hover();
    await expect(ui.getByRole('tooltip')).toContainText('先连接资源助手');
    // 面板仍固定 350×600，新增按钮不撑高主面板。
    expect(await ui.locator('body').evaluate(el=>[el.clientWidth,el.clientHeight])).toEqual([350,600]);
    expect(await ui.locator('body').evaluate(el=>el.scrollHeight<=el.clientHeight)).toBe(true);
  } finally {await new Promise<void>(r=>server.close(()=>r()));}
});

test('提交训练样本按钮随连接启用，提交人工标签、显示条数并在失败时给出可操作错误',async({page})=>{
  const f=await fixture();
  const {server,url}=await host({schemaVersion:1,address:f.base,token:f.token});
  try {
    await f.request('/v1/projects','PUT',{id:'g2',name:'测试游戏',path:f.project,maintained:true});
    await page.goto(url);
    const ui=page.frameLocator('iframe');
    const button=ui.locator('#submit-training');
    const notice=ui.getByTestId('action-result');
    await expect(ui.getByTestId('connection')).toHaveText('资源助手：已连接');
    await expect(button).toBeEnabled();
    await button.hover();
    await expect(ui.getByRole('tooltip')).toContainText('来源身份');
    // 选中游戏后提交属于页面级动作，不要求先选中主组件。
    await ui.locator('#project').selectOption('g2');
    await expect(ui.getByTestId('connection')).toHaveText('资源助手：已连接');

    // 只有自动分类时明确提示，不写入空样本。
    await page.evaluate(()=>{(window as any).training={schemaVersion:1,projectId:'g2',samples:[]};});
    await button.click();
    await expect(notice).toContainText('没有可提交的人工标签');
    await expect(ui.locator('#phase')).toHaveText('就绪');
    let exists=true;
    try { await readFile(join(f.data,'samples','g2.json')); } catch { exists=false; }
    expect(exists).toBe(false);

    // 提交内容只含项目编号与「来源身份 + 类别」；请求在途时按钮禁用。
    const samples=[
      {identity:JSON.stringify(['g2','atlas','tiny.json','red']),category:'按钮'},
      {identity:JSON.stringify(['g2','atlas','tiny.json','green']),category:'图标'}
    ];
    await page.evaluate(value=>{(window as any).training={schemaVersion:1,projectId:'g2',samples:value};},samples);
    let posted:any;
    let release!:()=>void,started!:()=>void;
    const held=new Promise<void>(resolve=>{release=resolve;});
    const startedAt=new Promise<void>(resolve=>{started=resolve;});
    await page.route(f.base+'/v1/samples',async route=>{
      posted=JSON.parse(route.request().postData()||'null');
      started();
      await held;
      await route.continue();
    });
    await button.click();
    await startedAt;
    await expect(button).toBeDisabled();
    expect(posted).toEqual({projectId:'g2',samples});
    release();
    await expect(notice).toContainText('已提交 2 个标签');
    await expect(ui.locator('#phase')).toHaveText('就绪');
    await page.unroute(f.base+'/v1/samples');
    const written=JSON.parse(await readFile(join(f.data,'samples','g2.json'),'utf8'));
    expect(written.projectId).toBe('g2');
    expect(written.samples).toEqual(samples);
    expect(JSON.stringify(written).includes(f.data)).toBe(false);

    // 平台报告重复身份时，成功提示补充被忽略的数量，而不是静默丢弃（B3）。
    await page.evaluate(()=>{(window as any).training={schemaVersion:1,projectId:'g2',
      samples:[{identity:'dup',category:'按钮'}],ignored:1};});
    await page.route(f.base+'/v1/samples',route=>route.fulfill({status:200,contentType:'application/json',
      body:JSON.stringify({schemaVersion:1,count:1})}));
    await button.click();
    await expect(notice).toContainText('已提交 1 个标签');
    await expect(notice).toContainText('忽略 1 个重复身份');
    await expect(ui.locator('#phase')).toHaveText('就绪');
    await page.unroute(f.base+'/v1/samples');

    // 助手拒绝时显示具体、可操作的错误，而不是静默成功。
    await page.route(f.base+'/v1/samples',route=>route.fulfill({status:400,contentType:'application/json',
      body:JSON.stringify({error:'训练样本类别无效'})}));
    await button.click();
    await expect(ui.getByRole('alert')).toContainText('训练样本类别无效');
    await expect(ui.locator('#phase')).toHaveText('失败');
    await expect(button).toBeEnabled();
    await page.unroute(f.base+'/v1/samples');

    // 新增按钮不撑高面板：主面板不整体滚动，动作行与状态卡、底栏都在可视区。
    expect(await ui.locator('body').evaluate(el=>[el.clientWidth,el.clientHeight])).toEqual([350,600]);
    expect(await ui.locator('body').evaluate(el=>el.scrollHeight<=el.clientHeight)).toBe(true);
    await expect(button).toBeInViewport();
    await expect(ui.locator('#category-actions')).toBeInViewport();
    await expect(ui.locator('.status-card')).toBeInViewport();
    await expect(ui.locator('.app-footer')).toBeInViewport();
  } finally {await new Promise<void>(r=>server.close(()=>r()));await f.cleanup();}
});
