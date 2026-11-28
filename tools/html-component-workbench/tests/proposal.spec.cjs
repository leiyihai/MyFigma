const {test}=require('node:test');
const assert=require('node:assert/strict');
const path=require('node:path');
const fs=require('node:fs/promises');
const {root,openWorkbench}=require('./support.cjs');
const evidence=path.join(root,'test-results/proposal');
const fixtures=path.join(root,'tests/fixtures/proposal');
const projectFixture=path.join(root,'tests/fixtures/files/manual-project.html');
async function save(page,name){await fs.mkdir(evidence,{recursive:true});const pending=page.waitForEvent('download');await page.getByRole('button',{name:'保存项目 HTML',exact:true}).click();const download=await pending;const file=path.join(evidence,name);await download.saveAs(file);return file;}
async function record(file){const html=await fs.readFile(file,'utf8');const match=html.match(/<script\b[^>]*id="workbench-project"[^>]*>([\s\S]*?)<\/script>/i);assert.ok(match,'下载具有可发现的 machine-readable 项目区块');return JSON.parse(match[1]);}
async function status(page,text){await page.getByRole('status').filter({hasText:text}).waitFor();}
const panel=page=>page.locator('section[data-feature="proposal"]');
async function importProposal(page,name,buffer){
  if(buffer)await page.getByLabel('载入建议 HTML').setInputFiles({name,mimeType:'text/html',buffer});
  else await page.getByLabel('载入建议 HTML').setInputFiles(path.join(fixtures,name));
}
async function loadManualProject(page,prototype){await page.getByLabel('载入项目 HTML').setInputFiles(projectFixture);await status(page,'已载入项目');await prototype.getByRole('button',{name:'原型业务按钮'}).click();}

test('合法建议载入只解析 proposal 区块：候选列表呈现、惰性转义还原、项目与画布不变',async t=>{
  const {page,prototype}=await openWorkbench(t);
  await loadManualProject(page,prototype);
  const before=await record(await save(page,'proposal-before.html'));
  await importProposal(page,'valid-mixed.html');await status(page,/已载入建议/);
  await panel(page).getByRole('heading',{name:'AI 拆分建议'}).waitFor();
  await panel(page).getByText(/共 4 条/).waitFor();
  await panel(page).getByText(/有效 4/).waitFor();
  assert.equal(await panel(page).locator('li[data-status="valid"]').count(),4,'合法条目进入候选列表');
  assert.equal(await panel(page).locator('li[data-status="unavailable"]').count(),0);
  assert.equal(await panel(page).locator('li[data-status="invalid"]').count(),0);
  for(const text of ['组件稿：新卡片','归组：变体、卡片','嵌套引用：卡片 → 共享数值','来源复用：卡片'])await panel(page).getByText(text,{exact:false}).waitFor();
  // 惰性 JSON 转义：\u003c/script\u003e 还原为文本，不产生任何脚本执行。
  await panel(page).getByText(/含 <\/script> 的转义说明/).waitFor();
  assert.equal(await page.locator('body').getAttribute('data-escaped'),null,'还原的 </script> 文本不执行脚本');
  // 文件里的损坏 workbench-project 区块被忽略：只解析 workbench-proposal。
  assert.equal(await page.locator('body').getAttribute('data-project-load'),null);
  // 载入全程不改变现有项目：结构逐字段一致，不产生 confirmed 变化、不生成新组件稿 ID。
  const after=await record(await save(page,'proposal-after.html'));
  assert.deepEqual(after,before,'建议载入不写入 v1 项目结构');
  // 画布与当前页面/状态不受影响，原型业务仍可交互。
  assert.equal(await page.getByRole('button',{name:'主页 / 默认',exact:true}).getAttribute('aria-current'),'true');
  await prototype.getByRole('button',{name:'业务已运行'}).waitFor();
  await page.screenshot({path:path.join(evidence,'valid-import.png')});
  await page.getByRole('button',{name:'清除建议'}).click();
  assert.equal(await panel(page).locator('li').count(),0,'清除建议后候选列表消失');
});

test('逐条校验：非法条目单独标出原因，不整批连坐',async t=>{
  const {page,prototype}=await openWorkbench(t);
  await loadManualProject(page,prototype);
  await importProposal(page,'invalid-mixed.html');await status(page,/已载入建议/);
  await panel(page).getByText(/共 14 条/).waitFor();
  await panel(page).getByText(/有效 1/).waitFor();
  await panel(page).getByText(/非法 13/).waitFor();
  assert.equal(await panel(page).locator('li[data-status="valid"]').count(),1,'合法条目不受非法条目牵连');
  assert.equal(await panel(page).locator('li[data-status="invalid"]').count(),13);
  for(const reason of ['未知建议类型：section','组件稿名称无效','理由（reason）缺失或无效','引用信息（reference）无效','引用不能指向自身','归组信息（group）无效','归组成员无效','归组主体不在成员列表中','复用来源（source）无效','建议包含不安全的资料键','建议条目必须是对象'])
    await panel(page).getByText(reason,{exact:false}).waitFor();
  assert.equal(await panel(page).getByText(/来源稳定节点无效/).count(),2,'空节点与重复节点分别单独标出');
  const saved=await record(await save(page,'invalid-import-project.html'));
  assert.deepEqual(saved.drafts.map(d=>d.id),['draft-card','draft-shared','draft-variant'],'非法导入不生成任何新组件稿 ID');
});

test('source 与当前原型/项目失配的条目单独标不可用，绝不静默套用',async t=>{
  const {page,prototype}=await openWorkbench(t);
  await loadManualProject(page,prototype);
  const before=await record(await save(page,'mismatch-before.html'));
  await importProposal(page,'mismatch.html');await status(page,/已载入建议/);
  await panel(page).getByText(/共 10 条/).waitFor();
  await panel(page).getByText(/有效 1/).waitFor();
  await panel(page).getByText(/不可用 9/).waitFor();
  assert.equal(await panel(page).locator('li[data-status="valid"]').count(),1);
  assert.equal(await panel(page).locator('li[data-status="unavailable"]').count(),9);
  assert.equal(await panel(page).locator('li[data-status="invalid"]').count(),0,'失配是可用性问题而非非法条目');
  for(const reason of ['来源原型 ID 不匹配：当前原型为 manual-kit','来源页面或状态不存在：missing-page / default','来源页面或状态不存在：home / missing-state','来源稳定节点缺失：ghost-node','复用组件稿不存在：draft-ghost','引用使用方组件稿不存在：draft-ghost','引用位置不存在：组件稿「卡片」中没有稳定节点 ghost-slot','归组成员组件稿不存在：draft-ghost'])
    await panel(page).getByText(reason,{exact:false}).first().waitFor();
  assert.equal(await panel(page).getByText(/来源页面或状态不存在/).count(),3,'页面/状态失配的复用来源同样标不可用');
  await page.screenshot({path:path.join(evidence,'mismatch-import.png')});
  const after=await record(await save(page,'mismatch-after.html'));
  assert.deepEqual(after,before,'失配导入不修改项目');
  await prototype.getByRole('button',{name:'业务已运行'}).waitFor();
});

test('坏文件、未知格式与超限文件明确拒绝，已载入成果与画布保留',async t=>{
  const {page,prototype}=await openWorkbench(t);
  await loadManualProject(page,prototype);
  await importProposal(page,'valid-mixed.html');await status(page,/已载入建议/);
  await panel(page).getByText(/共 4 条/).waitFor();
  const before=await record(await save(page,'badfile-before.html'));
  const block=json=>'<script id="workbench-proposal" type="application/json">'+json+'</script>';
  const bads=[
    ['no-block.html','<html><body><p>没有任何建议区块</p></body></html>',/建议文件必须包含唯一 workbench-proposal 资料区块/],
    ['two-blocks.html',block('{"proposals":[]}')+block('{"proposals":[]}'),/建议文件必须包含唯一 workbench-proposal 资料区块/],
    ['broken.html',block('{bad json'),/建议 JSON 已损坏/],
    ['unknown-format.html',block('{"format":"workbench-proposal","items":[]}'),/建议文件格式未知：缺少 proposals 列表/],
    ['empty.html',block('{"proposals":[]}'),/建议文件缺少建议条目/],
    ['oversized.html','<!--'+'x'.repeat(4*1024*1024)+'-->',/建议文件过大/]
  ];
  for(const [name,html,message] of bads){
    await importProposal(page,name,Buffer.from(html));await status(page,message);
    await panel(page).getByText(/共 4 条/).waitFor();
    assert.equal(await panel(page).locator('li[data-status="valid"]').count(),4,'坏文件拒绝后旧候选列表保留：'+name);
    await prototype.getByRole('button',{name:'业务已运行'}).waitFor();
  }
  const after=await record(await save(page,'badfile-after.html'));
  assert.deepEqual(after,before,'坏文件拒绝不修改项目');
});

test('尚未载入原型的空白会话中导入建议：来源类条目全部标不可用，工作台保持空白',async t=>{
  const {page}=await openWorkbench(t);
  await importProposal(page,'valid-mixed.html');await status(page,/已载入建议/);
  await panel(page).getByText(/共 4 条/).waitFor();
  await panel(page).getByText(/有效 0/).waitFor();
  assert.equal(await panel(page).locator('li[data-status="unavailable"]').count(),4);
  await panel(page).getByText(/尚未载入原型，无法核对建议来源/).waitFor();
  await panel(page).getByText(/归组成员组件稿不存在/).waitFor();
  await page.getByText('从一个完整原型开始').waitFor();
  assert.equal(await page.getByRole('button',{name:'打开受控示例'}).isVisible(),true);
});
