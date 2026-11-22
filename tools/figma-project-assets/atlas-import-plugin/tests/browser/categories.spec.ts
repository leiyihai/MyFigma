import {test,expect} from '@playwright/test';
import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
// 默认类别、追加式调色板与颜色分配统一取自实现：伪宿主不再自造一套 nextColor。
import {defaultCategories,categoryPalette,nextCategoryColor} from '../../src/category';
// @ts-ignore JS fixture is intentionally shared across the two owned packages.
import {fixture} from '../../../local-helper/tests/fixture.mjs';

const addedColor=nextCategoryColor(defaultCategories);

test('类别管理弹窗新增、重名提示、删除确认与关闭后标签刷新',async({page})=>{
  // 默认七类就是调色板的前七个槽位，颜色与实现同源。
  expect(defaultCategories.map(category=>category.color)).toEqual(categoryPalette.slice(0,defaultCategories.length));
  const f=await fixture();
  const server=createServer(async(req,res)=>{
    if(req.url==='/ui.html') {res.setHeader('Content-Type','text/html; charset=utf-8');res.end(await readFile(new URL('../../dist/ui.html',import.meta.url)));}
    else {res.setHeader('Content-Type','text/html; charset=utf-8');res.end(`<iframe title="plugin" sandbox="allow-scripts" src="/ui.html" style="width:350px;height:600px"></iframe>
    <script>
    window.categoryConfig=${JSON.stringify(defaultCategories)};
    window.selectionMembers=[{id:'component-1',name:'按钮/ok',category:'按钮',manual:false,viaInstance:false}];
    // 颜色来自实现算出的下一个类别颜色，宿主不自建调色板逻辑。
    window.addedColor=${JSON.stringify(addedColor)};
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
      if(m.type==='categories'){reply({schemaVersion:1,categories:window.categoryConfig});return;}
      if(m.type==='add-category'){
        window.addRequests=(window.addRequests||0)+1;
        const name=typeof m.name==='string'?m.name.trim():'';
        if(window.categoryConfig.some(c=>c.name===name)){reply(null,'已存在类别「'+name+'」');return;}
        window.categoryConfig=[...window.categoryConfig,{name,color:window.addedColor}];
        reply({schemaVersion:1,categories:window.categoryConfig,moved:0,message:'已新增类别「'+name+'」'});return;}
      if(m.type==='remove-category'){
        window.removeRequests=(window.removeRequests||0)+1;
        const name=m.name;
        if(name==='未分类'){reply(null,'「未分类」是兜底类别，不能删除');return;}
        const moved=window.selectionMembers.filter(member=>member.category===name).length;
        window.categoryConfig=window.categoryConfig.filter(c=>c.name!==name);
        window.selectionMembers=window.selectionMembers.map(member=>member.category===name?{...member,category:'未分类',manual:true,name:'未分类/'+member.name.split('/').pop()}:member);
        reply({schemaVersion:1,categories:window.categoryConfig,moved,message:moved?'已删除类别「'+name+'」，'+moved+' 个主组件移到「未分类」':'已删除类别「'+name+'」'});return;}
      if(m.type==='selection'){const members=window.selectionMembers||[];reply({schemaVersion:1,members,ignored:0,mixed:new Set(members.map(x=>x.category)).size>1});return;}
      if(m.type==='validate'){reply({valid:true,message:'空白页可导入'});return;}
      if(m.type==='tidy'){reply({schemaVersion:1,frames:0,moved:0,messages:[]});return;}
      if(m.type==='preview'){reply({schemaVersion:1,added:m.scan.resources.length,updated:0,removed:0,unchanged:0,blocked:0,removalSuppressed:false,messages:[]});return;}
      if(m.type==='import'){reply({schemaVersion:1,added:m.scan.resources.length,updated:0,removed:0,unchanged:0,blocked:0,removalSuppressed:false,messages:[],applied:{added:m.scan.resources.length,updated:0,removed:0},failures:[],cancelled:false});return;}
    });
    </script>`);}
  });
  await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));
  try {
    await page.goto('http://127.0.0.1:'+ (server.address() as {port:number}).port);
    const ui=page.frameLocator('iframe');
    const manager=ui.getByRole('button',{name:'类别管理',exact:true});
    const dialog=ui.locator('#category-manager');
    const list=ui.getByTestId('category-list');
    const input=ui.getByLabel('新类别名称');
    const addButton=ui.getByRole('button',{name:'新增类别',exact:true});
    // 类别配置存在页面里，属于本地操作：未连接助手也能打开类别管理，删除按钮也只受
    // 任务执行中限制；新增需要先选游戏（项目编号用于定位资源页）。
    await expect(manager).toBeEnabled();
    await manager.click();
    await expect(dialog).toBeVisible();
    await expect(list.locator('li')).toHaveCount(7);
    await expect(list.locator('[data-remove="按钮"]')).toBeEnabled();
    await expect(addButton).toBeDisabled();
    await expect(ui.locator('#new-category-note')).toContainText('先选择游戏');
    await ui.getByRole('button',{name:'关闭类别管理',exact:true}).click();
    await expect(dialog).not.toBeVisible();
    // 合并 #16/#17/#18 后动作行为「撤销 + 类别管理 + 提交训练样本」三个按钮。
    expect(await ui.locator('#category-actions button').count()).toBe(3);
    await expect(ui.locator('#category-actions button#undo-category')).toHaveCount(1);
    await expect(ui.locator('#category-actions button#category-manager-open')).toHaveCount(1);
    await expect(ui.locator('#category-actions button#submit-training')).toHaveCount(1);

    await ui.getByRole('button',{name:'资源助手设置',exact:true}).click();
    await ui.locator('#address').evaluate((el, base) => { (el as HTMLInputElement).value = base; }, f.base);
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
    await expect(ui.getByTestId('selection-status')).toContainText('当前分类：按钮');

    // 打开弹窗：列出当前类别，未分类没有删除按钮。
    await manager.click();
    await expect(dialog).toBeVisible();
    await expect(list.locator('li')).toHaveCount(7);
    await expect(list).toContainText('按钮');
    await expect(list.locator('[data-remove="未分类"]')).toHaveCount(0);
    await expect(list.locator('[data-remove="按钮"]')).toBeEnabled();
    // 空输入时新增禁用；输入合法新名称后启用，并显示将要分配的颜色预览。
    await expect(addButton).toBeDisabled();
    await expect(ui.locator('#new-category-note')).toContainText('输入类别名称');
    await input.fill('特效');
    await expect(addButton).toBeEnabled();
    const preview=await ui.locator('#new-category-color').textContent();
    expect(preview).toBe('#0091ff');
    expect(await ui.locator('#new-category-dot').evaluate(node=>getComputedStyle(node).backgroundColor)).toBe('rgb(0, 145, 255)');

    // 新增成功：列表、标签区与提示同步，输入框清空。
    await addButton.click();
    await expect(list.locator('li')).toHaveCount(8);
    await expect(list).toContainText('特效');
    await expect(ui.getByTestId('category-list').locator('[data-remove="特效"]')).toBeEnabled();
    await expect(ui.locator('#category-notice')).toContainText('已新增类别「特效」');
    await expect(input).toHaveValue('');
    expect(await page.evaluate(()=>(window as any).categoryConfig.map((c:any)=>c.name))).toContain('特效');
    // 不加面板整体滚动，动作行按钮高约 24px。
    expect(await ui.locator('body').evaluate(el=>el.scrollHeight<=el.clientHeight)).toBe(true);
    const height=await manager.evaluate(node=>node.getBoundingClientRect().height);
    expect(height).toBeGreaterThanOrEqual(22);
    expect(height).toBeLessThanOrEqual(26);

    // 重名：给出可操作提示并保持禁用，不发起新请求。
    await input.fill('特效');
    await expect(addButton).toBeDisabled();
    await expect(ui.locator('#new-category-note')).toContainText('已存在同名类别');
    await input.fill('按钮');
    await expect(addButton).toBeDisabled();
    await input.fill('特效');
    await addButton.click({force:true}).catch(()=>{});
    expect(await page.evaluate(()=>(window as any).addRequests)).toBe(1);
    // 非法名称（含 /）由同一规则提示，不发送请求。
    await input.fill('特效/2');
    await expect(addButton).toBeDisabled();
    await expect(ui.locator('#new-category-note')).toContainText('不能包含');

    // 删除确认：先出现确认行，取消不改动；确认后类别消失、标签区刷新。
    await input.fill('');
    // 让选中组件位于待删除的类别，删除后它的类别与显示名应当同步回到未分类。
    await page.evaluate(()=>{
      (window as any).selectionMembers=[{id:'component-2',name:'特效/spark',category:'特效',manual:true,viaInstance:false}];
      document.querySelector('iframe')!.contentWindow!.postMessage({pluginMessage:{type:'selection-changed'}},'*');
    });
    await expect(ui.getByTestId('selection-status')).toContainText('当前分类：特效');
    await list.locator('[data-remove="特效"]').click();
    const confirmBar=ui.locator('#category-confirm[data-confirm="特效"]');
    await expect(confirmBar).toBeVisible();
    await expect(confirmBar).toContainText('主组件会移到「未分类」');
    await confirmBar.getByRole('button',{name:'取消',exact:true}).click();
    await expect(ui.locator('#category-confirm')).toBeHidden();
    await expect(list.locator('li')).toHaveCount(8);
    expect(await page.evaluate(()=>(window as any).removeRequests||0)).toBe(0);
    await list.locator('[data-remove="特效"]').click();
    await ui.locator('#category-confirm[data-confirm="特效"]').getByRole('button',{name:'删除类别',exact:true}).click();
    await expect(list.locator('li')).toHaveCount(7);
    await expect(list).not.toContainText('特效');
    await expect(ui.locator('#category-notice')).toContainText('已删除类别「特效」');
    expect(await page.evaluate(()=>(window as any).removeRequests)).toBe(1);
    expect(await page.evaluate(()=>(window as any).selectionMembers[0].category)).toBe('未分类');

    // 关闭后标签区立即与配置一致，主面板不整体滚动，状态卡与底栏仍在可视区。
    await ui.getByRole('button',{name:'关闭类别管理',exact:true}).click();
    await expect(dialog).not.toBeVisible();
    await expect(ui.locator('#category-tags button[data-category="特效"]')).toHaveCount(0);
    await expect(ui.getByTestId('selection-status')).toContainText('当前分类：未分类');
    expect(await ui.locator('body').evaluate(el=>el.scrollHeight<=el.clientHeight)).toBe(true);
    await expect(ui.locator('.status-card')).toBeInViewport();
    await expect(ui.locator('.app-footer')).toBeInViewport();

    // Esc 关闭弹窗，不保留上次的删除确认状态。
    await manager.click();
    await expect(dialog).toBeVisible();
    await list.locator('[data-remove="按钮"]').click();
    await expect(ui.locator('#category-confirm[data-confirm="按钮"]')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(dialog).not.toBeVisible();
    await manager.click();
    await expect(ui.locator('#category-confirm')).toBeHidden();

    // 忙碌时入口禁用：扫描执行期间不能打开类别管理。
    let releaseScan!:()=>void;
    let scanStarted!:()=>void;
    const held=new Promise<void>(resolve=>{releaseScan=resolve;});
    const started=new Promise<void>(resolve=>{scanStarted=resolve;});
    await page.route(f.base+'/v1/scan',async route=>{scanStarted();await held;await route.continue();});
    await ui.getByRole('button',{name:'关闭类别管理',exact:true}).click();
    await ui.getByRole('button',{name:'扫描资源',exact:true}).click();
    await started;
    await expect(manager).toBeDisabled();
    releaseScan();
    await expect(ui.getByRole('button',{name:'扫描资源',exact:true})).toBeEnabled();
    await expect(manager).toBeEnabled();
    await page.unroute(f.base+'/v1/scan');
  } finally { server.close(); await f.cleanup(); }
});
