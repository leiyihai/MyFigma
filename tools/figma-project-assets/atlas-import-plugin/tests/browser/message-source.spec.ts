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
        <iframe title="plugin" sandbox="allow-scripts" src="${origin}/acceptance-ui.html" style="width:350px;height:540px"></iframe>
        <script>addEventListener('message',e=>{if(e.source===frames[0]&&e.data?.pluginMessage)parent.postMessage(e.data,'*');else if(e.source===parent&&e.data?.pluginMessage)frames[0].postMessage(e.data,'*');});</script>`}));
    const host=origin+'/plugin-message-acceptance';
    await page.route(host,route=>route.fulfill({contentType:'text/html; charset=utf-8',body:`
      <iframe title="bridge" src="${origin}/acceptance-bridge.html" style="width:370px;height:540px"></iframe>
      <script>addEventListener('message',e=>{
        const m=e.data?.pluginMessage;
        if(!m?.requestId||e.source!==frames[0])return;
        if(m.type==='helper-path-load'){frames[0].postMessage({pluginMessage:{type:'result',requestId:m.requestId,result:''}},'*');return;}
        if(m.type==='helper-path-save'){frames[0].postMessage({pluginMessage:{type:'result',requestId:m.requestId,result:true}},'*');return;}
        if(m.type==='open-helper-folder'){window.openedPath=m.path;frames[0].postMessage({pluginMessage:{type:'result',requestId:m.requestId,result:true}},'*');return;}
        if(m.type==='pairing-load'){frames[0].postMessage({pluginMessage:{type:'result',requestId:m.requestId,result:null}},'*');return;}
        if(m.type==='categories'){frames[0].frames[0].postMessage({pluginMessage:{type:'result',requestId:m.requestId,result:{schemaVersion:1,categories:[{name:'按钮',color:'#e5484d'},{name:'未分类',color:'#8b8d98'}]}}},'*');return;}
        if(m.type==='pairing-save'||m.type==='pairing-clear'){frames[0].postMessage({pluginMessage:{type:'result',requestId:m.requestId,result:true}},'*');return;}
        if(m.type==='validate'){
          window.validationRequest=m.requestId;
          window.validationCount=(window.validationCount||0)+1;
          frames[0].frames[0].postMessage({pluginMessage:{type:'result',requestId:m.requestId,result:{valid:true,message:'顶层宿主校验完成'}}},'*');
        }
      });</script>`}));
    await page.goto(host);
    const ui=page.frameLocator('iframe[title="bridge"]').frameLocator('iframe[title="plugin"]');
    await expect(ui.locator('#connect')).toBeDisabled();
    await ui.locator('#settings').click();
    await expect(ui.locator('#pairing')).toBeVisible();
    await ui.locator('#token').fill('0'.repeat(64));
    await ui.locator('#helper-path').fill('E:\\Tools\\helper');
    await ui.locator('#settings-save').click();
    await expect(ui.locator('#pairing')).not.toBeVisible();
    await ui.locator('#connect').click();
    await expect.poll(()=>page.evaluate(()=>(window as any).openedPath)).toBe('E:\\Tools\\helper');
    await ui.locator('#connect').click();
    await expect(ui.locator('#connection')).toHaveText('资源助手：已连接');
    await ui.locator('#project').selectOption('g2');
    await expect.poll(()=>page.evaluate(()=>(window as any).validationCount)).toBe(1);
    if(origin==='https://www.figma.com') {
      await expect(ui.locator('#page-status')).toHaveText('资源页：可导入');
      await expect(ui.locator('#phase')).toHaveText('就绪');
      await expect(ui.locator('#scan')).toBeEnabled();
    } else {
      await expect(ui.locator('#phase')).toHaveText('页面校验');
      await expect(ui.locator('#page-status')).not.toHaveText('资源页：可导入');
      await expect(ui.locator('#scan')).toBeDisabled();
    }
  });
}
