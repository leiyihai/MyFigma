import {test,expect} from '@playwright/test';
import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
// Public helper fixture launches the real Rust binary.
// @ts-ignore JS fixture is intentionally shared across the two owned packages.
import {fixture} from '../../../local-helper/tests/fixture.mjs';

test('撤销按钮只在最近一次人工分类后可用，恢复操作前状态且重开不保留',async({page})=>{
  const f=await fixture();
  const server=createServer(async(req,res)=>{
    if(req.url==='/ui.html') {res.setHeader('Content-Type','text/html; charset=utf-8');res.end(await readFile(new URL('../../dist/ui.html',import.meta.url)));}
    else {res.setHeader('Content-Type','text/html; charset=utf-8');res.end(`<iframe title="plugin" sandbox="allow-scripts" src="/ui.html" style="width:350px;height:600px" onload="window.uiLoads=(window.uiLoads||0)+1"></iframe>
    <script>
    window.imported=null;window.pairing=null;window.selectionMembers=[];
    addEventListener('message',e=>{
      const m=e.data.pluginMessage;if(!m)return;
      const reply=(result,error)=>e.source.postMessage({pluginMessage:{type:'result',requestId:m.requestId,result,error}},'*');
      if(m.type==='cancel'){if(m.requestId)reply(true);return;}
      if(!m.requestId)return;
      if(m.type==='helper-path-load'){reply(window.helperPath||'');return;}
      if(m.type==='helper-path-save'){window.helperPath=m.path;reply(true);return;}
      if(m.type==='open-helper-folder'){reply(true);return;}
      if(m.type==='pairing-load'){reply(window.pairing);return;}
      if(m.type==='pairing-save'){window.pairing=m.pairing;reply(true);return;}
      if(m.type==='pairing-clear'){window.pairing=null;reply(true);return;}
      if(m.type==='categories'){reply({schemaVersion:1,categories:[
        {name:'按钮',color:'#e5484d'},{name:'底板',color:'#8e4ec6'},{name:'图标',color:'#f2a900'},
        {name:'背景',color:'#3e63dd'},{name:'艺术字',color:'#d6409f'},{name:'进度条',color:'#30a46c'},
        {name:'未分类',color:'#8b8d98'}]});return;}
      if(m.type==='selection'){const members=window.selectionMembers||[];reply({schemaVersion:1,members,ignored:0,mixed:new Set(members.map(x=>x.category)).size>1});return;}
      if(m.type==='set-category'){
        window.categoryRequest=m;window.categoryRequests=(window.categoryRequests||0)+1;
        const members=window.selectionMembers||[];
        const previous=members.map(x=>({id:x.id,category:x.category,manual:!!x.manual}));
        window.selectionMembers=members.map(x=>({...x,category:m.category==='auto'?'未分类':m.category,manual:m.category!=='auto'}));
        reply({schemaVersion:1,action:m.category==='auto'?'auto':'manual',updated:members.length,moved:members.length,messages:[],previous});return;
      }
      if(m.type==='restore-category'){
        window.restoreRequest=m;window.restoreRequests=(window.restoreRequests||0)+1;
        if(window.restoreFailure){reply(null,window.restoreFailure);return;}
        const entries=m.entries||[];
        window.selectionMembers=(window.selectionMembers||[]).map(x=>{
          const entry=entries.find(e=>e.id===x.id);
          return entry?{...x,category:entry.category,manual:entry.manual}:x;
        });
        reply({schemaVersion:1,restored:entries.length,skipped:0,moved:entries.length,messages:[]});return;
      }
      if(m.type==='validate')reply({valid:true,message:'空白页可导入'});
    });
    </script>`);}
  });
  await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));
  try {
    await page.goto('http://127.0.0.1:'+(server.address() as {port:number}).port);
    const ui=page.frameLocator('iframe');
    await ui.getByRole('button',{name:'资源助手设置',exact:true}).click();
    await ui.locator('#address').evaluate((el,base)=>{(el as HTMLInputElement).value=base;},f.base);
    await ui.getByLabel('配对令牌').fill(f.token);
    await ui.getByLabel('资源助手文件夹（用于启动）').fill('E:\\Tools\\resource-helper');
    await ui.locator('#settings-save').click();
    await ui.getByRole('button',{name:'启动资源助手',exact:true}).click();
    await ui.getByRole('button',{name:'连接资源助手',exact:true}).click();
    await expect(ui.getByTestId('connection')).toHaveText('资源助手：已连接');
    await ui.getByRole('button',{name:'管理',exact:true}).click();
    await ui.getByLabel('游戏名称',{exact:true}).fill('测试游戏');
    await ui.getByLabel('项目编号',{exact:true}).fill('g2');
    await ui.getByLabel('资源目录',{exact:true}).fill(f.project);
    await ui.getByRole('button',{name:'保存登记',exact:true}).click();
    await ui.getByRole('button',{name:'关闭管理',exact:true}).click();
    await ui.locator('#project').selectOption('g2');
    await expect(ui.locator('#page-status')).toContainText('资源页：可导入');

    await page.evaluate(()=>{
      const w=window as any;
      w.selectionMembers=[
        {id:'component-1',name:'按钮/ok',category:'按钮',manual:false,viaInstance:false},
        {id:'component-2',name:'图标/coin',category:'图标',manual:false,viaInstance:false}
      ];
      document.querySelector('iframe')!.contentWindow!.postMessage({pluginMessage:{type:'selection-changed'}},'*');
    });
    const undo=ui.getByRole('button',{name:'撤销',exact:true});
    const tag=(name:string)=>ui.locator(`#category-tags button[data-category="${name}"]`);
    await expect(ui.getByTestId('selection-status')).toContainText('混合分类：按钮 / 图标');
    // 没有撤销记录时禁用，且不占用分类动作行之外的布局高度。
    await expect(undo).toBeDisabled();
    expect(await ui.locator('#category-actions').evaluate(el=>getComputedStyle(el).display)).not.toBe('none');

    await tag('艺术字').click();
    await expect(undo).toBeEnabled();
    expect(await page.evaluate(()=>(window as any).categoryRequest.category)).toBe('艺术字');
    expect(await page.evaluate(()=>(window as any).categoryRequest.ids.slice().sort())).toEqual(['component-1','component-2']);
    await expect(ui.getByTestId('selection-status')).toContainText('当前分类：艺术字');
    await expect(tag('艺术字')).toHaveAttribute('aria-pressed','true');
    expect(await ui.locator('body').evaluate(el=>[el.clientWidth,el.clientHeight])).toEqual([350,600]);
    expect(await ui.locator('body').evaluate(el=>el.scrollHeight<=el.clientHeight)).toBe(true);
    await expect(ui.locator('.status-card')).toBeInViewport();
    await expect(ui.locator('.app-footer')).toBeInViewport();
    await undo.hover();
    await expect(ui.getByRole('tooltip')).toContainText('2 个组件');
    await page.mouse.move(0,0);

    // 下一次人工分类覆盖旧记录：撤销恢复到「艺术字」，而不是更早的「按钮 / 图标」。
    await tag('背景').click();
    await expect.poll(()=>page.evaluate(()=>(window as any).categoryRequests)).toBe(2);
    await undo.click();
    await expect.poll(()=>page.evaluate(()=>(window as any).restoreRequests)).toBe(1);
    const restore=await page.evaluate(()=>(window as any).restoreRequest);
    expect(restore.entries.map((entry:any)=>[entry.id,entry.category,entry.manual]).sort())
      .toEqual([['component-1','艺术字',true],['component-2','艺术字',true]]);
    await expect(ui.getByTestId('selection-status')).toContainText('当前分类：艺术字');
    await expect(tag('艺术字')).toHaveAttribute('aria-pressed','true');
    await expect(tag('背景')).toHaveAttribute('aria-pressed','false');
    await expect(ui.getByTestId('action-result')).toContainText('撤销：已恢复 2 个组件');
    await expect(undo).toBeDisabled();
    // 撤销成功后清空记录，再次点击不会重复发送。
    await undo.click({force:true});
    await expect.poll(()=>page.evaluate(()=>(window as any).restoreRequests)).toBe(1);

    // 失败时保留记录并显示可操作错误，修复后可重试。
    await tag('背景').click();
    await expect(undo).toBeEnabled();
    await page.evaluate(()=>{(window as any).restoreFailure='恢复参数无效，请重试';});
    await undo.click();
    await expect(ui.getByRole('alert')).toContainText('恢复参数无效，请重试');
    await expect(undo).toBeEnabled();
    await page.evaluate(()=>{(window as any).restoreFailure=undefined;});
    await undo.click();
    await expect.poll(()=>page.evaluate(()=>(window as any).restoreRequests)).toBe(3);
    await expect(undo).toBeDisabled();

    // 插件重开（重新加载 UI）后不保留撤销记录，即使重开前刚做过人工分类。
    await tag('背景').click();
    await expect(undo).toBeEnabled();
    await page.locator('iframe').evaluate(el=>{const frame=el as HTMLIFrameElement;frame.src=frame.src;});
    await expect.poll(()=>page.evaluate(()=>(window as any).uiLoads)).toBeGreaterThanOrEqual(2);
    await expect(ui.getByTestId('connection')).toHaveText('资源助手：已连接');
    await ui.locator('#project').selectOption('g2');
    await expect(ui.locator('#page-status')).toContainText('资源页：可导入');
    await page.evaluate(()=>{
      document.querySelector('iframe')!.contentWindow!.postMessage({pluginMessage:{type:'selection-changed'}},'*');
    });
    await expect(ui.getByTestId('selection-status')).toContainText('当前分类：背景');
    await expect(undo).toBeDisabled();
    expect(await page.evaluate(()=>(window as any).restoreRequests)).toBe(3);
    expect(await ui.locator('body').evaluate(el=>el.scrollHeight<=el.clientHeight)).toBe(true);
    await expect(ui.locator('.status-card')).toBeInViewport();
    await expect(ui.locator('.app-footer')).toBeInViewport();
  } finally {await new Promise<void>(r=>server.close(()=>r()));await f.cleanup();}
});
