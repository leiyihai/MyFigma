import {test,expect} from '@playwright/test';
import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';

test('unconnected start action opens the saved helper folder, then offers pairing', async ({page}) => {
  const helperPath = 'E:\\Tools\\resource-helper\\release';
  const server = createServer(async (req,res) => {
    res.setHeader('Content-Type','text/html; charset=utf-8');
    if (req.url === '/ui.html') return res.end(await readFile(new URL('../../dist/ui.html',import.meta.url)));
    res.end(`<iframe title="plugin" sandbox="allow-scripts" src="/ui.html" style="width:350px;height:540px"></iframe>
    <script>
    window.helperPath=${JSON.stringify(helperPath)};window.openedPath=null;
    addEventListener('message',e=>{
      const m=e.data?.pluginMessage;if(!m)return;
      const reply=(result,error)=>e.source.postMessage({pluginMessage:{type:'result',requestId:m.requestId,result,error}},'*');
      if(m.type==='pairing-load'){reply(null);return;}
      if(!m.requestId)return;
      if(m.type==='helper-path-load'){reply(window.helperPath);return;}
      if(m.type==='helper-path-save'){window.helperPath=m.path;reply(true);return;}
      if(m.type==='open-helper-folder'){window.openedPath=m.path;reply(true);return;}
      if(m.type==='pairing-save'||m.type==='pairing-clear'){reply(true);return;}
    });</script>`);
  });
  await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));
  try {
    await page.goto('http://127.0.0.1:'+(server.address() as {port:number}).port);
    const ui=page.frameLocator('iframe');
    await expect(ui.getByRole('button',{name:'先完成设置',exact:true})).toBeDisabled();
    expect(await ui.getByLabel('资源助手文件夹（用于启动）').inputValue()).toBe(helperPath);
    await ui.getByRole('button',{name:'资源助手设置',exact:true}).click();
    await ui.getByLabel('配对令牌').fill('0'.repeat(64));
    await ui.locator('#settings-save').click();
    const start=ui.getByRole('button',{name:'启动资源助手',exact:true});
    await expect(start).toBeVisible();
    await start.click();
    await expect.poll(()=>page.evaluate(()=>(window as any).openedPath)).toBe(helperPath);
    await expect(ui.getByRole('button',{name:'连接资源助手',exact:true})).toBeVisible();
    await ui.getByRole('button',{name:'资源助手设置',exact:true}).click();
    await expect(ui.locator('#pairing')).toBeVisible();
    await expect(ui.getByLabel('资源助手文件夹（用于启动）')).toHaveValue(helperPath);
    expect(await ui.locator('body').evaluate(el=>el.scrollHeight<=el.clientHeight)).toBe(true);
  } finally {await new Promise<void>(r=>server.close(()=>r()));}
});

test('when Figma rejects file URLs the start action copies and selects the path instead of pretending to open it', async ({page}) => {
  const helperPath = 'E:\\Tools\\resource-helper\\release';
  const server = createServer(async (req,res) => {
    res.setHeader('Content-Type','text/html; charset=utf-8');
    if (req.url === '/ui.html') return res.end(await readFile(new URL('../../dist/ui.html',import.meta.url)));
    res.end(`<iframe title="plugin" sandbox="allow-scripts" src="/ui.html" style="width:350px;height:540px"></iframe>
    <script>
    window.helperPath=${JSON.stringify(helperPath)};
    addEventListener('message',e=>{
      const m=e.data?.pluginMessage;if(!m)return;
      const reply=(result,error)=>e.source.postMessage({pluginMessage:{type:'result',requestId:m.requestId,result,error}},'*');
      if(m.type==='pairing-load'){reply(null);return;}
      if(!m.requestId)return;
      if(m.type==='helper-path-load'){reply(window.helperPath);return;}
      if(m.type==='helper-path-save'){window.helperPath=m.path;reply(true);return;}
      if(m.type==='pairing-save'||m.type==='pairing-clear'){reply(true);return;}
      if(m.type==='open-helper-folder'){reply(null,'invalid url protocol "file:"');return;}
    });</script>`);
  });
  await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));
  try {
    await page.goto('http://127.0.0.1:'+(server.address() as {port:number}).port);
    const ui=page.frameLocator('iframe');
    await ui.getByRole('button',{name:'资源助手设置',exact:true}).click();
    await ui.getByLabel('配对令牌').fill('0'.repeat(64));
    await ui.locator('#settings-save').click();
    await ui.getByRole('button',{name:'启动资源助手',exact:true}).click();
    await expect(ui.locator('#pairing')).toBeVisible();
    await expect(ui.locator('#error')).toContainText('Figma 不允许插件直接打开本地文件夹');
    await expect(ui.getByLabel('资源助手文件夹（用于启动）')).toHaveValue(helperPath);
  } finally {await new Promise<void>(r=>server.close(()=>r()));}
});
