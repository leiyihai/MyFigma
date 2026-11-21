import {test,expect} from '@playwright/test';
import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
// Public helper fixture launches the real Rust binary.
// @ts-ignore JS fixture is intentionally shared across the two owned packages.
import {fixture} from '../../../local-helper/tests/fixture.mjs';

test('management dialog, full search, real scan, task lock, progress and hover guidance',async({page})=>{
  const f=await fixture();
  const server=createServer(async(req,res)=>{
    if(req.url==='/ui.html') {res.setHeader('Content-Type','text/html');res.end(await readFile(new URL('../../dist/ui.html',import.meta.url)));}
    else {res.setHeader('Content-Type','text/html');res.end(`<iframe title="plugin" sandbox="allow-scripts" src="/ui.html" style="width:460px;height:750px"></iframe>
    <script>
    window.imported=null;
    addEventListener('message',e=>{
      const m=e.data.pluginMessage;if(!m||!m.requestId)return;
      const reply=result=>e.source.postMessage({pluginMessage:{type:'result',requestId:m.requestId,result}},'*');
      if(m.type==='validate')reply({valid:true,message:'空白页可导入'});
      if(m.type==='import'){window.imported=m.scan;e.source.postMessage({pluginMessage:{type:'progress',progress:{done:1,total:2}}},'*');window.finish=()=>reply(null);}
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
    await ui.getByRole('button',{name:'关闭管理',exact:true}).click();
    await expect(ui.getByLabel('选择游戏', {exact:true}).locator('option')).toHaveCount(2);
    await ui.getByLabel('搜索名称或编号').fill('g3');
    await expect(ui.getByLabel('选择游戏', {exact:true}).locator('option')).toHaveCount(2);
    await expect(ui.getByLabel('选择游戏', {exact:true})).toContainText('临时游戏');
    await ui.getByLabel('搜索名称或编号').fill('');
    await ui.getByLabel('选择游戏', {exact:true}).selectOption('g2');
    await ui.getByRole('button',{name:'扫描资源',exact:true}).click();
    await expect(ui.getByTestId('summary')).toContainText('散图 2');
    await ui.getByRole('button',{name:'导入主组件',exact:true}).hover();
    await expect(ui.getByRole('tooltip')).toContainText('仅在空白页');
    await ui.getByRole('button',{name:'导入主组件',exact:true}).click();
    await expect(ui.getByLabel('选择游戏', {exact:true})).toBeDisabled();
    await expect(ui.getByRole('button',{name:'扫描资源',exact:true})).toBeDisabled();
    await expect(ui.getByRole('button',{name:'导入主组件',exact:true})).toBeDisabled();
    await expect(ui.getByTestId('progress')).toContainText('1 / 2');
    await page.evaluate(()=>{(window as any).finish();});
    await expect(ui.getByLabel('选择游戏', {exact:true})).toBeEnabled();
    expect(await page.evaluate(()=>(window as any).imported.resources.length)).toBe(2);
    expect(await page.evaluate(()=>'path' in (window as any).imported.project)).toBe(false);
    await f.stop();
    await ui.getByRole('button',{name:'扫描资源',exact:true}).click();
    await expect(ui.getByTestId('connection')).toHaveText('未连接');
    await expect(ui.getByRole('alert')).toContainText('请启动 figma-assets-helper');
    await ui.getByLabel('配对令牌').fill('0'.repeat(64));
    await ui.getByRole('button',{name:'连接助手',exact:true}).click();
    await expect(ui.getByRole('alert')).toContainText('请启动 figma-assets-helper');
  } finally {await new Promise<void>(r=>server.close(()=>r()));await f.cleanup();}
});
