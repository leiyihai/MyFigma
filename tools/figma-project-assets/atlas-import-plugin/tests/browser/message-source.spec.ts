import {test,expect} from '@playwright/test';
import {readFile} from 'node:fs/promises';

for(const origin of ['https://www.figma.com','https://untrusted.example']) {
  test(`nested plugin accepts ancestor replies only from the Figma host (${origin})`,async({page})=>{
    // This regression isolates the real UI's message boundary. Real helper HTTP is
    // exercised in ui.spec.ts; no network permission is needed for this topology test.
    await page.addInitScript(()=>{
      if(location.pathname!=='/acceptance-ui.html')return;
      window.fetch=async()=>new Response(JSON.stringify({schemaVersion:1,status:'ready',
        projects:[{id:'g2',name:'嵌套窗口测试',path:'test-fixture',maintained:true}]}),
        {headers:{'Content-Type':'application/json'}});
    });
    await page.route(origin+'/acceptance-ui.html',async route=>route.fulfill({
      contentType:'text/html; charset=utf-8',body:await readFile(new URL('../../dist/ui.html',import.meta.url),'utf8')}));
    await page.route(origin+'/acceptance-bridge.html',route=>route.fulfill({
      contentType:'text/html; charset=utf-8',body:`
        <iframe title="plugin" sandbox="allow-scripts" src="${origin}/acceptance-ui.html" style="width:460px;height:750px"></iframe>
        <script>addEventListener('message',e=>{if(e.source===frames[0]&&e.data?.pluginMessage)parent.postMessage(e.data,'*');});</script>`}));
    const host=origin+'/plugin-message-acceptance';
    await page.route(host,route=>route.fulfill({contentType:'text/html; charset=utf-8',body:`
      <iframe title="bridge" src="${origin}/acceptance-bridge.html" style="width:500px;height:800px"></iframe>
      <script>addEventListener('message',e=>{
        const m=e.data?.pluginMessage;
        if(!m?.requestId||e.source!==frames[0])return;
        if(m.type==='validate'){
          window.validationRequest=m.requestId;
          frames[0].frames[0].postMessage({pluginMessage:{type:'result',requestId:m.requestId,result:{valid:true,message:'顶层宿主校验完成'}}},'*');
        }
      });</script>`}));
    await page.goto(host);
    const ui=page.frameLocator('iframe[title="bridge"]').frameLocator('iframe[title="plugin"]');
    await ui.locator('#token').fill('0'.repeat(64));
    await ui.locator('#connect').click();
    await expect(ui.locator('#connection')).toHaveText('已连接');
    await ui.locator('#project').selectOption('g2');
    await expect.poll(()=>page.evaluate(()=>(window as any).validationRequest)).toBe(1);
    if(origin==='https://www.figma.com') {
      await expect(ui.locator('#page-status')).toHaveText('顶层宿主校验完成');
      await expect(ui.locator('#phase')).toHaveText('就绪');
      await expect(ui.locator('#scan')).toBeEnabled();
    } else {
      await expect(ui.locator('#phase')).toHaveText('页面校验');
      await expect(ui.locator('#page-status')).not.toHaveText('顶层宿主校验完成');
      await expect(ui.locator('#scan')).toBeDisabled();
    }
  });
}
