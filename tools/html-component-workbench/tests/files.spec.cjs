const {test}=require('node:test');
const assert=require('node:assert/strict');
const path=require('node:path');
const fs=require('node:fs/promises');
const {pathToFileURL}=require('node:url');
const {root,openWorkbench}=require('./support.cjs');
const evidence=path.join(root,'test-results/files');
async function save(page,name){await fs.mkdir(evidence,{recursive:true});const pending=page.waitForEvent('download');await page.getByRole('button',{name:'保存项目 HTML',exact:true}).click();const download=await pending;const file=path.join(evidence,name);await download.saveAs(file);return file;}
async function record(file){const html=await fs.readFile(file,'utf8');const match=html.match(/<script\b[^>]*id="workbench-project"[^>]*>([\s\S]*?)<\/script>/i);assert.ok(match,'下载具有可发现的 machine-readable 项目区块');return JSON.parse(match[1]);}
async function status(page,text){await page.getByRole('status').filter({hasText:text}).waitFor();}
const fixture=path.join(root,'tests/fixtures/files/manual-project.html');
async function importRecord(page,project){const html='<html><head></head><body><script id="workbench-project" type="application/json">'+JSON.stringify(project).replace(/</g,'\\u003c')+'</script></body></html>';await page.getByLabel('载入项目 HTML').setInputFiles({name:'project.html',mimeType:'text/html',buffer:Buffer.from(html)});}

test('人工合法项目保留结构关系与恶意闭合文本，坏文件拒绝且保留旧画布业务状态',async t=>{
  const {page,prototype}=await openWorkbench(t);
  const original=await record(fixture);original.name='边界 </sCrIpT><script>document.body.dataset.escaped="yes"</script> & "';
  await importRecord(page,original);await status(page,'已载入项目');
  await prototype.getByRole('button',{name:'原型业务按钮'}).click();
  const saved=await save(page,'manual-relations.html');const data=await record(saved);
  for(const key of ['drafts','groups','references','mappings','reviews','futureMetadata','name'])assert.deepEqual(data[key],original[key]);
  assert.equal(await page.locator('body').getAttribute('data-escaped'),null);
  const bads=[
    [p=>p.formatVersion=99,/不支持的项目格式或版本/],
    [p=>p.references[0].targetDraftId='missing',/引用.*不存在/],
    [p=>p.groups[0].primaryId='draft-shared',/主体/],
    [p=>p.mappings[0].reviewId='missing',/复核/],
    [p=>p.prototype.html=p.prototype.html.replace('</head>','<style>div{background:url(https://invalid.local/a.png)}</style></head>'),/资源/],
    [p=>p.drafts[0].content.html+='<img src="blob:old-session">',/资源/],
    [p=>p.drafts[0].content.html+='<img src="data:image/svg+xml,%3Csvg%3E%3Cimage%20href=%22https://invalid.local/x%22/%3E%3C/svg%3E">',/资源/],
    [p=>p.drafts[0].content.html+='<span onclick="parent.Workbench.updateProject(()=>{})">恶意</span>',/脚本|事件/]
  ];
  for(const [mutate,message] of bads){const bad=structuredClone(original);mutate(bad);await importRecord(page,bad);await status(page,message);assert.equal(await prototype.getByRole('button',{name:'业务已运行'}).isVisible(),true);}
  await page.getByLabel('载入项目 HTML').setInputFiles({name:'broken.html',mimeType:'text/html',buffer:Buffer.from('<script id="workbench-project" type="application/json">{bad</script>')});await status(page,'JSON 已损坏');
  const after=await record(await save(page,'after-rejections.html'));assert.deepEqual(after.references,original.references);assert.equal(after.id,original.id);
});

test('CSS和字体内联资源字节损坏不能以CSP或data URL冒充可携带成功',async t=>{
  const {page,prototype}=await openWorkbench(t);const original=await record(fixture);
  await page.getByLabel('载入项目 HTML').setInputFiles(fixture);await status(page,'已载入项目');
  await prototype.getByRole('button',{name:'原型业务按钮'}).click();
  const bad=structuredClone(original);bad.prototype.html=bad.prototype.html.replace('</head>','<style>body{background-image:url(data:image/png;base64,bm90LWFuLWltYWdl)}</style></head>');
  await importRecord(page,bad);await status(page,/资源.*解码失败/);
  await prototype.getByRole('button',{name:'业务已运行'}).waitFor();
  const font=structuredClone(original);font.drafts[0].content.css+='@font-face{font-family:Bad;src:url(data:font/woff2;base64,bm90LWEtZm9udA==)}';
  await importRecord(page,font);await status(page,/字体资源.*解码失败/);
  await prototype.getByRole('button',{name:'业务已运行'}).waitFor();
});

test('恢复模式或页面失败的项目候选不替换旧项目及旧画布业务状态',async t=>{
  const {page,prototype}=await openWorkbench(t);const original=await record(fixture);
  await page.getByLabel('载入项目 HTML').setInputFiles(fixture);await status(page,'已载入项目');
  await prototype.getByRole('button',{name:'原型业务按钮'}).click();
  const bad=structuredClone(original);bad.workspace.mode='edit';bad.prototype.html=bad.prototype.html.replace('setMode(){}',"setMode(mode){if(mode==='edit')throw Error('文件恢复冻结拒绝');}");
  await importRecord(page,bad);await status(page,'文件恢复冻结拒绝');
  await prototype.getByRole('button',{name:'业务已运行'}).waitFor();
  assert.equal(await page.getByRole('button',{name:'预览',exact:true}).getAttribute('aria-pressed'),'true');
  const kept=await record(await save(page,'after-candidate-failure.html'));assert.deepEqual(kept.prototype,original.prototype);
});

test('原型改版按稳定ID保留人工关系，变化与删除标记复核，不猜测重绑',async t=>{
  const {page,prototype}=await openWorkbench(t);const original=await record(fixture);
  await page.getByLabel('载入项目 HTML').setInputFiles(fixture);await status(page,'已载入项目');
  const future=original.prototype.html.replace('"version":1','"version":99');
  await page.getByLabel('更新原型 HTML').setInputFiles({name:'future-prototype.html',mimeType:'text/html',buffer:Buffer.from(future)});
  await status(page,/不支持的原型格式或版本/);
  await prototype.getByRole('heading',{name:'手工定义原型'}).waitFor();
  const kept=await record(await save(page,'after-future-prototype.html'));
  assert.deepEqual(kept.prototype,original.prototype,'不支持的原型版本不覆盖当前原型');
  assert.deepEqual(kept.reviews,original.reviews,'失败改版不留下半提交复核');
  const revised=original.prototype.html.replace('"contentVersion":"1"','"contentVersion":"2"').replace('手工定义原型','改版后标题').replace('<span data-wb-node="amount">12</span>','<span data-wb-node="amount-new">99</span>');
  await page.getByLabel('更新原型 HTML').setInputFiles({name:'revision-2.html',mimeType:'text/html',buffer:Buffer.from(revised)});await status(page,'原型已更新');
  await prototype.getByRole('heading',{name:'改版后标题'}).waitFor();
  await page.getByRole('heading',{name:'改版待复核'}).waitFor();
  const updated=await record(await save(page,'revised-project.html'));
  for(const key of ['drafts','groups','references'])assert.deepEqual(updated[key],original[key]);
  assert.equal(updated.formatVersion,1,'文件格式版本不随原型内容版本升级');
  assert.equal(updated.prototype.manifest.version,1,'原型格式版本独立于内容版本');
  assert.equal(updated.prototype.manifest.contentVersion,'2');
  assert.ok(updated.reviews.some(r=>r.kind==='source-missing'&&r.draftId==='draft-shared'));
  assert.ok(updated.reviews.some(r=>r.kind==='source-changed'&&r.draftId==='draft-card'));
  assert.equal(updated.mappings[0].status,'confirmed','保留人工决定但不能当作现版本有效映射');
  assert.ok(updated.mappings.every(m=>m.reviewId&&updated.reviews.some(r=>r.id===m.reviewId&&r.kind==='mapping-stale'&&!r.resolved)));
  assert.deepEqual(updated.mappings[2].source.nodeIds,['amount'],'不按外观/序号把被删ID绑定到amount-new');
  await page.screenshot({path:path.join(evidence,'revision-reviews.png')});
});

test('仅原型内容版本或脚本变化也按稳定来源标记复核，不猜测重绑',async t=>{
  const {page}=await openWorkbench(t);const original=await record(fixture);
  async function revise(html,name){
    await page.getByLabel('更新原型 HTML').setInputFiles({name,mimeType:'text/html',buffer:Buffer.from(html)});
    await status(page,'原型已更新');
    return record(await save(page,name.replace(/\.html$/,'-project.html')));
  }
  await importRecord(page,original);await status(page,'已载入项目');
  const versionOnly=await revise(original.prototype.html.replace('"contentVersion":"1"','"contentVersion":"2"'),'content-version-2.html');
  assert.equal(versionOnly.formatVersion,1,'内容版本变化不改变文件格式版本');
  assert.equal(versionOnly.prototype.manifest.version,1,'内容版本变化不改变原型格式版本');
  assert.equal(versionOnly.prototype.manifest.contentVersion,'2');
  for(const key of ['drafts','groups','references'])assert.deepEqual(versionOnly[key],original[key],'保留人工决定 '+key);
  for(const draft of versionOnly.drafts)assert.ok(versionOnly.reviews.some(review=>review.kind==='source-changed'&&review.draftId===draft.id&&!review.resolved),'内容版本变化需复核 '+draft.id);
  for(const mapping of versionOnly.mappings)assert.ok(mapping.reviewId&&versionOnly.reviews.some(review=>review.id===mapping.reviewId&&review.kind==='mapping-stale'&&!review.resolved),'内容版本变化后映射不能冒充有效 '+mapping.id);
  assert.deepEqual(versionOnly.mappings.map(mapping=>mapping.source),original.mappings.map(mapping=>mapping.source),'映射来源不按外观或序号重绑');

  await importRecord(page,original);await status(page,'已载入项目');
  const scripted=original.prototype.html.replace('window.WorkbenchPrototype={navigate(){},setMode(){}};','window.WorkbenchPrototype={navigate(){},setMode(){},revision:"script-only"};');
  assert.notEqual(scripted,original.prototype.html,'脚本确实发生变化');
  const scriptOnly=await revise(scripted,'script-only.html');
  assert.equal(scriptOnly.prototype.manifest.contentVersion,'1');
  assert.deepEqual(scriptOnly.drafts,original.drafts,'脚本变化不重写组件稿');
  for(const draft of scriptOnly.drafts)assert.ok(scriptOnly.reviews.some(review=>review.kind==='source-changed'&&review.draftId===draft.id&&!review.resolved),'脚本变化需复核 '+draft.id);
  for(const mapping of scriptOnly.mappings)assert.ok(mapping.reviewId&&scriptOnly.reviews.some(review=>review.id===mapping.reviewId&&review.kind==='mapping-stale'&&!review.resolved),'脚本变化后映射不能冒充有效 '+mapping.id);
});

test('真实下载的完整原型可在全新离线 file 会话查看并重载后二次保存',async t=>{
  const {browser,page,prototype}=await openWorkbench(t);
  await page.getByRole('button',{name:'打开受控示例'}).click();await status(page,'已载入：');
  await page.getByRole('button',{name:'编辑',exact:true}).click();await status(page,'已冻结');
  await page.getByRole('button',{name:'统计 / 生产中',exact:true}).click();
  const first=await save(page,'prototype-project.html');const project=await record(first);
  assert.equal(project.formatVersion,1);assert.equal(project.prototype.manifest.contentVersion,'1');
  assert.match(project.prototype.html,/林间小屋/);assert.deepEqual(project.drafts,[]);
  assert.match(project.prototype.html,/data:image\//,'保存的原型携带内联图片而非外部资源');
  assert.equal(/blob:|file:\/\/|[A-Za-z]:\\/.test(project.prototype.html),false,'保存原型不依赖临时 blob、file URL 或开发机绝对路径');
  const context=await browser.newContext({offline:true,viewport:{width:1560,height:980}});t.after(()=>context.close());
  const reopened=await context.newPage();await reopened.goto(pathToFileURL(first).href);await status(reopened,'已载入项目');
  await reopened.frameLocator('iframe[title="原型画布"]').getByText('正在生产木材',{exact:true}).waitFor();
  assert.equal(await reopened.getByRole('button',{name:'编辑',exact:true}).getAttribute('aria-pressed'),'true');
  await reopened.screenshot({path:path.join(evidence,'offline-reopened.png')});
  const blank=await context.newPage();await blank.goto(pathToFileURL(path.join(root,'dist/workbench.html')).href);
  await blank.getByLabel('载入项目 HTML').setInputFiles(first);await status(blank,'已载入项目');
  await blank.getByRole('button',{name:'卡片 / 默认',exact:true}).click();
  await blank.getByRole('button',{name:'预览',exact:true}).click();await status(blank,'已恢复');
  await blank.frameLocator('iframe[title="原型画布"]').getByRole('button',{name:'收取木材'}).click();
  assert.equal(await blank.frameLocator('iframe[title="原型画布"]').getByLabel('木材数量').textContent(),'128');
  const secondProject=await record(await save(blank,'second-project.html'));
  assert.equal(secondProject.id,project.id);
  assert.equal(secondProject.formatVersion,1);
  assert.deepEqual(secondProject.prototype,project.prototype,'二次保存仍携带同一完整原型');
  for(const key of ['drafts','groups','references','mappings','reviews'])assert.deepEqual(secondProject[key],project[key],'二次保存保留 '+key);
});
