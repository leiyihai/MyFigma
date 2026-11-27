const {test} = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs/promises');
const {openWorkbench, root} = require('./support.cjs');
const fixture = path.join(root, 'tests/fixtures/relations/cards.html');
const evidence = path.join(root, 'test-results/relations');
async function shot(page, name) {
  await fs.mkdir(evidence, {recursive: true});
  const file = path.join(evidence, name);
  await page.screenshot({path: file});
  return file;
}
async function load(t) {
  const result = await openWorkbench(t);
  await result.page.getByLabel('载入原型 HTML').setInputFiles(fixture);
  await result.page.getByRole('status').filter({hasText: '已载入：营地关系样例'}).waitFor();
  await result.page.getByRole('button', {name: '编辑', exact: true}).click();
  await result.page.getByRole('status').filter({hasText: '业务输入与自动变化已冻结'}).waitFor();
  return result;
}
async function extract(page, prototype, nodeId, name, position = {x: 5, y: 5}) {
  await prototype.locator('[data-wb-node="' + nodeId + '"]').click({position});
  await page.getByText(nodeId, {exact: true}).waitFor();
  await page.getByLabel('组件稿名称', {exact: true}).fill(name);
  await page.getByRole('button', {name: '提取独立组件稿', exact: true}).click();
  await page.locator('iframe[title="组件稿：' + name + '"]').waitFor();
}
async function locate(page) {
  await page.getByRole('button', {name: '定位来源', exact: true}).click();
  await page.getByRole('status').filter({hasText: '已定位来源'}).waitFor();
}
async function components(page) {
  await page.getByRole('tab', {name: '组件', exact: true}).click();
  await page.getByRole('heading', {name: '组件关系概览'}).waitFor();
}
async function createReference(page, ownerName, targetName, slotId, overrides = {}) {
  await page.getByRole('button', {name: '组件：' + ownerName + '（独立）', exact: true}).click();
  await page.getByLabel('被引用组件', {exact: true}).selectOption({label: targetName});
  await page.getByLabel('引用位置', {exact: true}).selectOption(slotId);
  for (const [nodeId, value] of Object.entries(overrides)) await page.getByLabel('覆盖文字：' + nodeId, {exact: true}).fill(value);
  await page.getByRole('button', {name: '建立嵌套引用', exact: true}).click();
  await page.getByRole('status').filter({hasText: '已建立嵌套引用：' + ownerName + ' → ' + targetName}).waitFor();
}
async function selectChip(page, name) {
  await page.getByRole('button', {name: new RegExp('^组件：' + name + '（')}).click();
}
async function openPreview(page, name) {
  await selectChip(page, name);
  await page.getByRole('button', {name: '独立预览：' + name, exact: true}).click();
  await page.getByRole('heading', {name: '独立预览', exact: true}).waitFor();
  return page.frameLocator('iframe[title="组件稿：' + name + '"]');
}
async function backOverview(page) {
  await page.getByRole('button', {name: '返回关系概览', exact: true}).click();
  await page.getByRole('heading', {name: '组件关系概览'}).waitFor();
}
async function saveProject(page, name) {
  await fs.mkdir(evidence, {recursive: true});
  const pending = page.waitForEvent('download');
  await page.getByRole('button', {name: '保存项目 HTML', exact: true}).click();
  const download = await pending;
  const file = path.join(evidence, name);
  await download.saveAs(file);
  const html = await fs.readFile(file, 'utf8');
  const match = html.match(/<script\b[^>]*id="workbench-project"[^>]*>([\s\S]*?)<\/script>/i);
  assert.ok(match, '保存文件包含可发现的 machine-readable 项目区块');
  return {file, project: JSON.parse(match[1])};
}

test('真实勾选顺序定义并修正组件组，主体变体标注与并排预览可用', async t => {
  const {page, prototype} = await load(t);
  await extract(page, prototype, 'card-b', '卡片乙');
  await locate(page);
  await extract(page, prototype, 'card-a', '卡片甲');
  await locate(page);
  await extract(page, prototype, 'stats', '统计条');
  await locate(page);
  await extract(page, prototype, 'stats', '统计条副本');
  await components(page);
  await page.getByText('尚无嵌套引用。重叠选区不会自动建立引用。', {exact: true}).waitFor();
  // 同来源、同外观仍是两个独立组件，不自动去重也不自动归组。
  await page.getByRole('button', {name: '组件：统计条（独立）', exact: true}).waitFor();
  await page.getByRole('button', {name: '组件：统计条副本（独立）', exact: true}).waitFor();
  assert.equal(await page.getByRole('group', {name: /^组件组：/}).count(), 0);
  // 真实勾选顺序与组件列表顺序相反：先甲后乙，第一项为主体。
  await page.getByLabel('选择组件稿：统计条副本', {exact: true}).uncheck();
  await page.getByLabel('选择组件稿：卡片甲', {exact: true}).check();
  await page.getByLabel('选择组件稿：卡片乙', {exact: true}).check();
  await page.getByText('选择顺序：卡片甲 → 卡片乙', {exact: true}).waitFor();
  await page.getByLabel('组件组名称', {exact: true}).fill('营地卡片组');
  await page.getByRole('button', {name: '定义组件组', exact: true}).click();
  const box = page.getByRole('group', {name: '组件组：营地卡片组', exact: true});
  await box.waitFor();
  const members = box.getByRole('button', {name: /^组件：/});
  assert.equal(await members.nth(0).getAttribute('aria-label'), '组件：卡片甲（主体）');
  assert.equal(await members.nth(1).getAttribute('aria-label'), '组件：卡片乙（变体）');
  assert.match(await box.innerText(), /主体/);
  assert.match(await box.innerText(), /变体/);
  await page.getByText('调整组件组不会解除嵌套引用；引用是独立的人工决定。', {exact: true}).waitFor();
  t.diagnostic('组件组截图 ' + await shot(page, 'groups.png'));
  // 同组并排预览并可返回概览。
  await box.getByRole('button', {name: '并排预览组件组：营地卡片组', exact: true}).click();
  await page.getByRole('heading', {name: '同组并排预览', exact: true}).waitFor();
  assert.equal(await page.locator('iframe[title="组件稿：卡片甲"]').isVisible(), true);
  assert.equal(await page.locator('iframe[title="组件稿：卡片乙"]').isVisible(), true);
  await page.getByText('主体 · 卡片甲', {exact: true}).waitFor();
  await page.getByText('变体 · 卡片乙', {exact: true}).waitFor();
  await page.getByRole('button', {name: '返回关系概览', exact: true}).click();
  await page.getByRole('heading', {name: '组件关系概览'}).waitFor();
  // 以新的真实顺序修正组：统计条副本成为主体，甲成为变体，乙不再在组内。
  await page.getByLabel('选择组件稿：卡片乙', {exact: true}).uncheck();
  await page.getByLabel('选择组件稿：卡片甲', {exact: true}).uncheck();
  await page.getByLabel('选择组件稿：统计条副本', {exact: true}).check();
  await page.getByLabel('选择组件稿：卡片甲', {exact: true}).check();
  await page.getByText('选择顺序：统计条副本 → 卡片甲', {exact: true}).waitFor();
  await page.getByRole('button', {name: '定义组件组', exact: true}).click();
  const corrected = page.getByRole('group', {name: '组件组：营地卡片组', exact: true});
  await corrected.waitFor();
  assert.equal(await corrected.getByRole('button', {name: /^组件：/}).nth(0).getAttribute('aria-label'), '组件：统计条副本（主体）');
  assert.equal(await corrected.getByRole('button', {name: /^组件：/}).nth(1).getAttribute('aria-label'), '组件：卡片甲（变体）');
  await page.getByRole('button', {name: '组件：卡片乙（独立）', exact: true}).waitFor();
  // 解散组并保留其他组件。
  await page.getByRole('button', {name: '解散组件组', exact: true}).click();
  await page.getByRole('status').filter({hasText: '组件组已解散'}).waitFor();
  assert.equal(await page.getByRole('group', {name: /^组件组：/}).count(), 0);
  await page.getByRole('button', {name: '组件：统计条副本（独立）', exact: true}).waitFor();
  // 独立预览并可返回概览。
  await page.getByRole('button', {name: '组件：统计条（独立）', exact: true}).click();
  await page.getByRole('button', {name: '独立预览：统计条', exact: true}).click();
  await page.getByRole('heading', {name: '独立预览', exact: true}).waitFor();
  await page.locator('iframe[title="组件稿：统计条"]').waitFor();
  await page.getByRole('button', {name: '返回关系概览', exact: true}).click();
  await page.getByRole('heading', {name: '组件关系概览'}).waitFor();
});

test('引用位置与既有引用互为祖先或后代时明确拒绝，不留下悬空引用', async t => {
  const {page, prototype} = await load(t);
  await extract(page, prototype, 'card-b', '卡片乙');
  await locate(page);
  await extract(page, prototype, 'card-a', '卡片甲');
  await locate(page);
  await extract(page, prototype, 'stats', '统计条');
  await components(page);
  await createReference(page, '卡片甲', '统计条', 'slot-a', {'wood-value': '128'});
  // card-a 是 slot-a 的祖先：替换 card-a 子层会删除既有引用位置。
  await page.getByRole('button', {name: '组件：卡片甲（独立）', exact: true}).click();
  await page.getByLabel('被引用组件', {exact: true}).selectOption({label: '统计条'});
  await page.getByLabel('引用位置', {exact: true}).selectOption('card-a');
  await page.getByRole('button', {name: '建立嵌套引用', exact: true}).click();
  await page.getByRole('status').filter({hasText: /引用位置.*重叠/}).waitFor();
  assert.equal(await page.getByRole('img', {name: /^引用：/}).count(), 1, '拒绝后不得新增引用');
  await page.getByRole('button', {name: '组件：卡片甲（独立）', exact: true}).click();
  await page.getByText(/共享结构修订 1/).waitFor();
  const saved = await saveProject(page, 'overlap-rejected.html');
  assert.equal(saved.project.references.length, 1);
  assert.match(saved.project.drafts.find(draft => draft.name === '卡片甲').content.html, /data-wb-ref-root="ref-/);
});

test('显式引用按项目数据标注方向，选中后高亮使用方，自引用与循环被拒绝', async t => {
  const {page, prototype} = await load(t);
  await extract(page, prototype, 'card-b', '卡片乙');
  await locate(page);
  await extract(page, prototype, 'card-a', '卡片甲');
  await locate(page);
  await extract(page, prototype, 'stats', '统计条');
  await locate(page);
  await extract(page, prototype, 'stats', '统计条副本');
  await components(page);
  await page.getByText('尚无嵌套引用。重叠选区不会自动建立引用。', {exact: true}).waitFor();
  assert.equal(await page.getByRole('img', {name: /^引用：/}).count(), 0);
  await createReference(page, '卡片甲', '统计条', 'slot-a', {'wood-value': '128'});
  await createReference(page, '卡片乙', '统计条', 'slot-b', {'wood-value': '96'});
  // 使用方的共享结构已真实嵌入，各自覆盖值不同。
  await page.getByRole('button', {name: '组件：卡片甲（独立）', exact: true}).click();
  await page.getByRole('button', {name: '独立预览：卡片甲', exact: true}).click();
  await page.locator('iframe[title="组件稿：卡片甲"]').waitFor();
  await page.frameLocator('iframe[title="组件稿：卡片甲"]').getByText('128', {exact: true}).waitFor();
  await page.frameLocator('iframe[title="组件稿：卡片甲"]').getByText('木材', {exact: true}).waitFor();
  assert.equal(await page.frameLocator('iframe[title="组件稿：卡片甲"]').getByText('120', {exact: true}).count(), 0);
  await page.getByRole('button', {name: '返回关系概览', exact: true}).click();
  await createReference(page, '卡片甲', '统计条副本', 'slot-a-extra', {'people-value': '6 / 8'});
  // 关系语义与方向来自项目资料，箭头标注使用方 → 被引用组件。
  await page.getByRole('img', {name: '引用：卡片甲 → 统计条', exact: true}).waitFor();
  await page.getByRole('img', {name: '引用：卡片乙 → 统计条', exact: true}).waitFor();
  await page.getByRole('img', {name: '引用：卡片甲 → 统计条副本', exact: true}).waitFor();
  // 选中被引用组件时高亮引用它的使用方与相关连线，弱化无关连线。
  await page.getByRole('button', {name: /^组件：统计条（独立/}).click();
  await page.getByRole('button', {name: '组件：卡片甲（独立，使用方）', exact: true}).waitFor();
  await page.getByRole('button', {name: '组件：卡片乙（独立，使用方）', exact: true}).waitFor();
  const relatedOne = page.getByRole('img', {name: '引用：卡片甲 → 统计条', exact: true});
  const relatedTwo = page.getByRole('img', {name: '引用：卡片乙 → 统计条', exact: true});
  const unrelated = page.getByRole('img', {name: '引用：卡片甲 → 统计条副本', exact: true});
  assert.equal(await relatedOne.getAttribute('data-related'), 'true');
  assert.equal(await relatedTwo.getAttribute('data-related'), 'true');
  assert.equal(await unrelated.getAttribute('data-related'), 'false');
  assert.ok(Number(await unrelated.evaluate(node => getComputedStyle(node).opacity)) < 0.5);
  await page.getByRole('button', {name: '组件：统计条副本（独立）', exact: true}).waitFor();
  t.diagnostic('引用概览截图 ' + await shot(page, 'references-highlight.png'));
  // 自引用被拒绝。
  await page.getByLabel('被引用组件', {exact: true}).selectOption({label: '统计条'});
  await page.getByLabel('引用位置', {exact: true}).selectOption('stats');
  await page.getByRole('button', {name: '建立嵌套引用', exact: true}).click();
  await page.getByRole('status').filter({hasText: '不能引用自身'}).waitFor();
  // 会形成循环的引用被拒绝。
  await page.getByLabel('被引用组件', {exact: true}).selectOption({label: '卡片甲'});
  await page.getByLabel('引用位置', {exact: true}).selectOption('stats');
  await page.getByRole('button', {name: '建立嵌套引用', exact: true}).click();
  await page.getByRole('status').filter({hasText: '循环'}).waitFor();
  assert.equal(await page.getByRole('img', {name: /^引用：/}).count(), 3);
  // 修正引用关系：删除其中一条时同步移除对应共享结构。
  await selectChip(page, '卡片甲');
  await page.getByRole('button', {name: '删除引用：卡片甲 → 统计条副本', exact: true}).click();
  await page.getByRole('status').filter({hasText: '已删除嵌套引用'}).waitFor();
  assert.equal(await page.getByRole('img', {name: /^引用：/}).count(), 2);
  let frame = await openPreview(page, '卡片甲');
  await frame.getByText('128', {exact: true}).waitFor();
  assert.equal(await frame.getByText('6 / 8', {exact: true}).count(), 0);
  await backOverview(page);
  // 更新使用方自身范围导致引用位置消失时拒绝并提示，不静默解除引用。
  await page.getByRole('button', {name: '定位来源', exact: true}).click();
  await page.getByRole('status').filter({hasText: '已定位来源'}).waitFor();
  await prototype.locator('[data-wb-node="title-a"]').click();
  await page.getByText('title-a', {exact: true}).waitFor();
  await page.getByRole('button', {name: '更新提取范围', exact: true}).click();
  await page.getByRole('status').filter({hasText: '引用位置'}).waitFor();
  await components(page);
  assert.equal(await page.getByRole('img', {name: /^引用：/}).count(), 2);
  frame = await openPreview(page, '卡片甲');
  await frame.getByText('128', {exact: true}).waitFor();
  assert.equal(await frame.getByText('营地统计', {exact: true}).count(), 0);
  await backOverview(page);
});

test('共享统计条更新先展示影响，取消与不安全覆盖不提交，确认后同步结构并保留覆盖', async t => {
  const {page, prototype} = await load(t);
  await extract(page, prototype, 'card-b', '卡片乙');
  await locate(page);
  await extract(page, prototype, 'card-a', '卡片甲');
  await locate(page);
  await extract(page, prototype, 'stats', '统计条');
  await components(page);
  await createReference(page, '卡片甲', '统计条', 'slot-a', {'wood-value': '128'});
  await createReference(page, '卡片乙', '统计条', 'slot-b', {'wood-value': '96'});
  let frame = await openPreview(page, '卡片甲');
  await frame.getByText('128', {exact: true}).waitFor();
  assert.equal(await frame.getByText('营地统计', {exact: true}).count(), 0);
  await backOverview(page);
  frame = await openPreview(page, '卡片乙');
  await frame.getByText('96', {exact: true}).waitFor();
  assert.equal(await frame.getByText('96', {exact: true}).count(), 1);
  await backOverview(page);
  // 定位共享来源，扩大提取范围以改变共享结构。
  await selectChip(page, '统计条');
  await page.getByRole('button', {name: '定位来源', exact: true}).click();
  await page.getByRole('status').filter({hasText: '已定位来源'}).waitFor();
  await prototype.locator('[data-wb-node="stats-panel"]').click({position: {x: 4, y: 4}});
  await page.getByText('stats-panel', {exact: true}).waitFor();
  await page.getByRole('button', {name: '更新提取范围', exact: true}).click();
  await page.getByRole('heading', {name: '引用更新影响'}).waitFor();
  await page.getByText(/2 个使用方/).waitFor();
  await page.getByText('卡片甲 · 位置 slot-a · 覆盖：wood-value=128', {exact: true}).waitFor();
  await page.getByText('卡片乙 · 位置 slot-b · 覆盖：wood-value=96', {exact: true}).waitFor();
  t.diagnostic('引用更新影响截图 ' + await shot(page, 'impact-preview.png'));
  // 取消整笔更新，使用方结构保持原状。
  await page.getByRole('button', {name: '取消更新', exact: true}).click();
  await page.getByRole('status').filter({hasText: '已取消更新，组件稿保持不变'}).waitFor();
  await components(page);
  frame = await openPreview(page, '卡片甲');
  await frame.getByText('128', {exact: true}).waitFor();
  assert.equal(await frame.getByText('营地统计', {exact: true}).count(), 0);
  await backOverview(page);
  // 再次更新并确认：共享结构同步，各自覆盖保留。
  await selectChip(page, '统计条');
  await page.getByRole('tab', {name: '界面', exact: true}).click();
  await page.getByRole('button', {name: '更新提取范围', exact: true}).click();
  await page.getByRole('heading', {name: '引用更新影响'}).waitFor();
  await page.getByRole('button', {name: '确认更新并同步', exact: true}).click();
  await page.getByRole('status').filter({hasText: '组件稿提取范围已更新'}).waitFor();
  await components(page);
  frame = await openPreview(page, '卡片甲');
  await frame.getByText('营地统计', {exact: true}).waitFor();
  await frame.getByText('128', {exact: true}).waitFor();
  assert.equal(await frame.getByText('96', {exact: true}).count(), 0);
  await backOverview(page);
  frame = await openPreview(page, '卡片乙');
  await frame.getByText('营地统计', {exact: true}).waitFor();
  await frame.getByText('96', {exact: true}).waitFor();
  assert.equal(await frame.getByText('128', {exact: true}).count(), 0);
  await backOverview(page);
  frame = await openPreview(page, '统计条');
  await frame.getByText('营地统计', {exact: true}).waitFor();
  await frame.getByText('120', {exact: true}).waitFor();
  await backOverview(page);
  await selectChip(page, '卡片甲');
  await page.getByText(/共享结构修订 2/).waitFor();
  t.diagnostic('更新后概览截图 ' + await shot(page, 'propagated.png'));
  // 原型本身不变，业务仍可交互。
  await page.getByRole('tab', {name: '界面', exact: true}).click();
  await page.getByRole('button', {name: '预览', exact: true}).click();
  await page.getByRole('status').filter({hasText: '原型交互已恢复'}).waitFor();
  assert.equal(await prototype.getByText('统计待接入', {exact: true}).count(), 2);
  await prototype.getByRole('button', {name: '收取木材'}).click();
  assert.equal(await prototype.getByLabel('已收取').textContent(), '1');
  assert.equal(await prototype.getByText('120', {exact: true}).count(), 1);
  // 覆盖无法安全保留时不提交：只提取标题会移除被覆盖的数值节点。
  await page.getByRole('tab', {name: '组件', exact: true}).click();
  await selectChip(page, '统计条');
  await page.getByRole('button', {name: '定位来源', exact: true}).click();
  await page.getByRole('status').filter({hasText: '已定位来源'}).waitFor();
  await prototype.locator('[data-wb-node="stats-title"]').click();
  await page.getByText('stats-title', {exact: true}).waitFor();
  await page.getByRole('button', {name: '更新提取范围', exact: true}).click();
  await page.getByRole('status').filter({hasText: 'wood-value'}).waitFor();
  assert.equal(await page.getByRole('heading', {name: '引用更新影响'}).count(), 0);
  await page.getByRole('tab', {name: '组件', exact: true}).click();
  await selectChip(page, '卡片甲');
  await page.getByText(/共享结构修订 2/).waitFor();
  frame = await openPreview(page, '卡片甲');
  await frame.getByText('营地统计', {exact: true}).waitFor();
  await frame.getByText('128', {exact: true}).waitFor();
  await backOverview(page);
  // 导出资料与关系图同源：引用修订、覆盖值和共享结构都可读取。
  const saved = await saveProject(page, 'relations-project.html');
  const data = saved.project;
  assert.equal(data.references.length, 2);
  assert.ok(data.references.every(ref => ref.targetRevision === 2));
  assert.deepEqual(data.references.map(ref => ref.overrides[0].value).sort(), ['128', '96']);
  const owner = data.drafts.find(draft => draft.name === '卡片甲');
  assert.match(owner.content.html, /data-wb-node="slot-a"/);
  assert.match(owner.content.html, /data-wb-ref-node="wood-value"/);
  assert.match(owner.content.html, /营地统计/);
});

test('引用更新确认期间项目变化时冲突且整笔不提交', async t => {
  const {page, prototype} = await load(t);
  await extract(page, prototype, 'card-b', '卡片乙');
  await locate(page);
  await extract(page, prototype, 'card-a', '卡片甲');
  await locate(page);
  await extract(page, prototype, 'stats', '统计条');
  await components(page);
  await createReference(page, '卡片甲', '统计条', 'slot-a', {'wood-value': '128'});
  await createReference(page, '卡片乙', '统计条', 'slot-b', {'wood-value': '96'});
  await selectChip(page, '统计条');
  await page.getByRole('button', {name: '定位来源', exact: true}).click();
  await page.getByRole('status').filter({hasText: '已定位来源'}).waitFor();
  await prototype.locator('[data-wb-node="stats-panel"]').click({position: {x: 4, y: 4}});
  await page.getByText('stats-panel', {exact: true}).waitFor();
  await page.getByRole('button', {name: '更新提取范围', exact: true}).click();
  await page.getByRole('heading', {name: '引用更新影响'}).waitFor();
  // 在确认前通过公开文件入口更新原型，使项目 revision 变化。
  await page.getByLabel('更新原型 HTML').setInputFiles({name: 'cards.html', mimeType: 'text/html', buffer: await fs.readFile(fixture)});
  await page.getByRole('status').filter({hasText: '原型已更新'}).waitFor();
  await page.getByRole('heading', {name: '引用更新影响'}).waitFor();
  await page.getByRole('button', {name: '确认更新并同步', exact: true}).click();
  await page.getByRole('status').filter({hasText: '项目已变化'}).waitFor();
  assert.equal(await page.getByRole('heading', {name: '引用更新影响'}).count(), 0);
  // 使用方与共享结构都保持原状。
  await page.getByRole('tab', {name: '组件', exact: true}).click();
  await selectChip(page, '卡片甲');
  await page.getByText(/共享结构修订 1/).waitFor();
  const frame = await openPreview(page, '卡片甲');
  await frame.getByText('128', {exact: true}).waitFor();
  assert.equal(await frame.getByText('营地统计', {exact: true}).count(), 0);
  await backOverview(page);
  t.diagnostic('冲突后截图 ' + await shot(page, 'conflict.png'));
});

test('来源映射候选可批量确认与排除，候选不是约束且导出状态可辨识', async t => {
  const {page, prototype} = await load(t);
  await extract(page, prototype, 'card-a', '卡片甲');
  await locate(page);
  await extract(page, prototype, 'card-b', '卡片乙');
  await locate(page);
  // 编辑模式选区作为候选来源的人工入口。
  await page.getByLabel('候选复用组件', {exact: true}).selectOption({label: '卡片乙'});
  await page.getByRole('button', {name: '标记候选映射', exact: true}).click();
  await page.getByRole('status').filter({hasText: '已标记候选复用：卡片乙 · card-b'}).waitFor();
  await prototype.locator('[data-wb-node="card-a"]').click({position: {x: 5, y: 5}});
  await page.getByText('card-a', {exact: true}).waitFor();
  await page.getByLabel('候选复用组件', {exact: true}).selectOption({label: '卡片甲'});
  await page.getByRole('button', {name: '标记候选映射', exact: true}).click();
  await page.getByRole('status').filter({hasText: '已标记候选复用：卡片甲 · card-a'}).waitFor();
  await prototype.locator('[data-wb-node="heading"]').click();
  await page.getByText('heading', {exact: true}).waitFor();
  await page.getByRole('button', {name: '标记候选映射', exact: true}).click();
  await page.getByRole('status').filter({hasText: '已标记候选复用：卡片甲 · heading'}).waitFor();
  await components(page);
  await page.getByText('候选映射不是强制复用约束。', {exact: true}).waitFor();
  await page.getByText('当前有效复用约束：0 条（仅已确认且无未解决复核）', {exact: true}).waitFor();
  assert.equal(await page.getByText('候选', {exact: true}).count(), 3);
  // 批量确认。
  await page.getByLabel(/^选择映射：卡片乙 · card-b$/).check();
  await page.getByLabel(/^选择映射：卡片甲 · card-a$/).check();
  await page.getByRole('button', {name: '批量确认所选', exact: true}).click();
  await page.getByText('当前有效复用约束：2 条（仅已确认且无未解决复核）', {exact: true}).waitFor();
  assert.equal(await page.getByText('已确认（有效）', {exact: true}).count(), 2);
  // 批量排除。
  await page.getByLabel(/^选择映射：卡片乙 · card-b$/).check();
  await page.getByRole('button', {name: '批量排除所选', exact: true}).click();
  await page.getByText('当前有效复用约束：1 条（仅已确认且无未解决复核）', {exact: true}).waitFor();
  assert.equal(await page.getByText('已排除', {exact: true}).count(), 1);
  const saved = await saveProject(page, 'mappings-project.html');
  t.diagnostic('映射导出 ' + saved.file);
  const mappings = saved.project.mappings;
  assert.equal(mappings.length, 3);
  assert.equal(mappings.filter(mapping => mapping.status === 'confirmed').length, 1);
  assert.equal(mappings.filter(mapping => mapping.status === 'excluded').length, 1);
  assert.equal(mappings.filter(mapping => mapping.status === 'candidate').length, 1);
  for (const mapping of mappings.filter(item => item.status === 'confirmed')) assert.equal(mapping.reviewId, null);
  assert.ok(mappings.some(mapping => mapping.source.nodeIds.includes('heading') && mapping.status === 'candidate'), '候选来源保持候选状态');
});

test('关系概览的独立预览同样支持缩放检查，返回概览仍可读关系', async t => {
  const {page} = await openWorkbench(t);
  await page.getByLabel('载入项目 HTML').setInputFiles(path.join(root, 'tests/fixtures/relations/reviewed-project.html'));
  await page.getByRole('status').filter({hasText: '已载入项目'}).waitFor();
  await components(page);
  const frame = await openPreview(page, '卡片');
  const nativeWidth = Number(await page.locator('iframe[title="组件稿：卡片"]').getAttribute('width'));
  await page.getByRole('button', {name: '放大组件稿', exact: true}).click();
  await page.getByRole('button', {name: '放大组件稿', exact: true}).click();
  await page.getByText('预览比例 150%', {exact: true}).waitFor();
  const box = await page.locator('iframe[title="组件稿：卡片"]').boundingBox();
  assert.ok(Math.abs(box.width - nativeWidth * 1.5) < 1.5, '关系预览缩放必须只改变显示尺寸');
  await frame.getByText('位置覆盖 42', {exact: true}).waitFor();
  await backOverview(page);
  await page.getByText('当前有效复用约束：0 条（仅已确认且无未解决复核）', {exact: true}).waitFor();
});

test('引用目标 CSS 按引用根作用域隔离，无法隔离的动画规则明确拒绝', async t => {
  const {page} = await openWorkbench(t);
  await page.getByLabel('载入项目 HTML').setInputFiles(path.join(root, 'tests/fixtures/relations/scoped-project.html'));
  await page.getByRole('status').filter({hasText: '已载入项目'}).waitFor();
  await components(page);
  await page.getByRole('button', {name: '组件：使用方（独立）', exact: true}).click();
  await page.getByLabel('被引用组件', {exact: true}).selectOption({label: '共享文字'});
  await page.getByLabel('引用位置', {exact: true}).selectOption('slot');
  await page.getByRole('button', {name: '建立嵌套引用', exact: true}).click();
  await page.getByRole('status').filter({hasText: '已建立嵌套引用：使用方 → 共享文字'}).waitFor();
  await page.getByRole('button', {name: '独立预览：使用方', exact: true}).click();
  const frame = page.frameLocator('iframe[title="组件稿：使用方"]');
  await frame.getByText('目标文字', {exact: true}).waitFor();
  const own = await frame.locator('[data-wb-node="own"]').evaluate(node => getComputedStyle(node).color);
  const shared = await frame.locator('[data-wb-ref-node="value"]').evaluate(node => getComputedStyle(node).color);
  assert.equal(own, 'rgb(0, 0, 255)', '被引用组件的宽泛样式不能污染使用方自有内容');
  assert.equal(shared, 'rgb(200, 0, 0)', '作用域规则仍须命中引用位置内部的目标内容');
  await page.getByRole('button', {name: '返回关系概览', exact: true}).click();
  await page.getByRole('heading', {name: '组件关系概览'}).waitFor();
  // 无法可靠隔离的 @keyframes 规则必须明确拒绝，不能静默丢样式或污染使用方。
  await page.getByRole('button', {name: /^组件：使用方（/}).click();
  await page.getByLabel('被引用组件', {exact: true}).selectOption({label: '动画目标'});
  await page.getByLabel('引用位置', {exact: true}).selectOption('slot2');
  await page.getByRole('button', {name: '建立嵌套引用', exact: true}).click();
  await page.getByRole('status').filter({hasText: /@keyframes|隔离/}).waitFor();
  assert.equal(await page.getByRole('img', {name: /^引用：/}).count(), 1, '无法隔离样式时不得新增引用');
  const saved = await saveProject(page, 'scoped-project.html');
  const owner = saved.project.drafts.find(draft => draft.name === '使用方');
  assert.match(owner.content.css, /\[data-wb-ref-root="ref-[^"]+"\]\s*span\s*\{[^}]*color:\s*rgb\(200,\s*0,\s*0\)/, '目标样式必须限定在引用根之下');
  assert.equal(saved.project.drafts.find(draft => draft.name === '共享文字').content.css, 'span{color:rgb(200, 0, 0)}', '组件稿自身样式保持可独立预览');
});

test('待复核映射可显式解除复核，解除后重新成为有效约束', async t => {
  const {page} = await openWorkbench(t);
  await page.getByLabel('载入项目 HTML').setInputFiles(path.join(root, 'tests/fixtures/relations/reviewed-project.html'));
  await page.getByRole('status').filter({hasText: '已载入项目'}).waitFor();
  await components(page);
  await page.getByText('当前有效复用约束：0 条（仅已确认且无未解决复核）', {exact: true}).waitFor();
  await page.getByRole('button', {name: '解除复核', exact: true}).click();
  await page.getByRole('status').filter({hasText: '已解除复核'}).waitFor();
  await page.getByText('已确认（有效）', {exact: true}).waitFor();
  await page.getByText('当前有效复用约束：1 条（仅已确认且无未解决复核）', {exact: true}).waitFor();
  const saved = await saveProject(page, 'review-resolved-project.html');
  const review = saved.project.reviews.find(item => item.id === 'review-mapping-stale');
  assert.equal(review.resolved, true, '解除复核必须记录为已解决');
  assert.equal(saved.project.mappings.find(item => item.id === 'mapping-confirmed').status, 'confirmed', '解除复核不改变人工确认状态');
  assert.equal(saved.project.mappings.find(item => item.id === 'mapping-confirmed').reviewId, review.id, '保留复核审计关联');
});

test('待复核映射可在编辑选区后重新绑定来源，明确改变原绑定', async t => {
  const {page, prototype} = await openWorkbench(t);
  await page.getByLabel('载入项目 HTML').setInputFiles(path.join(root, 'tests/fixtures/relations/reviewed-project.html'));
  await page.getByRole('status').filter({hasText: '已载入项目'}).waitFor();
  await page.getByRole('tab', {name: '界面', exact: true}).click();
  await page.getByRole('button', {name: '编辑', exact: true}).click();
  await page.getByRole('status').filter({hasText: '业务输入与自动变化已冻结'}).waitFor();
  await prototype.locator('[data-wb-node="title"]').click();
  await page.getByText('title', {exact: true}).waitFor();
  await components(page);
  await page.getByRole('button', {name: '重新绑定到当前选区', exact: true}).click();
  await page.getByRole('status').filter({hasText: '已重新绑定'}).waitFor();
  await page.getByText('已确认（有效）', {exact: true}).waitFor();
  const saved = await saveProject(page, 'review-rebound-project.html');
  const mapping = saved.project.mappings.find(item => item.id === 'mapping-confirmed');
  assert.deepEqual(mapping.source.nodeIds, ['title'], '重新绑定必须使用明确选区而不是外观猜测');
  assert.equal(saved.project.reviews.find(item => item.id === 'review-mapping-stale').resolved, true);
});

test('未解决复核的已确认映射不冒充当前有效约束', async t => {
  const {page} = await openWorkbench(t);
  await page.getByLabel('载入项目 HTML').setInputFiles(path.join(root, 'tests/fixtures/relations/reviewed-project.html'));
  await page.getByRole('status').filter({hasText: '已载入项目'}).waitFor();
  await components(page);
  await page.getByText('已确认（待复核，非当前有效约束）', {exact: true}).waitFor();
  await page.getByText('当前有效复用约束：0 条（仅已确认且无未解决复核）', {exact: true}).waitFor();
  await page.getByText('候选', {exact: true}).waitFor();
});

test('建立引用会同步既有使用方时先展示影响，取消不改动、确认后才提交', async t => {
  const {page, prototype} = await load(t);
  for (const [nodeId, name] of [['card-b', '内层'], ['card-a', '外壳'], ['stats', '统计条'], ['stats', '统计条副本']]) {
    await extract(page, prototype, nodeId, name);
    await locate(page);
  }
  await components(page);
  await createReference(page, '内层', '统计条', 'slot-b', {'wood-value': '96'});
  await createReference(page, '外壳', '内层', 'slot-a', {'title-b': '内层标题覆盖'});
  const before = await saveProject(page, 'reference-impact-before.html');
  const shellBefore = before.project.drafts.find(draft => draft.name === '外壳');
  assert.equal(shellBefore.revision, 2);
  // 再次引用另一组件会更新“内层”，而“外壳”正在引用“内层”，必须先确认影响。
  await selectChip(page, '内层');
  await page.getByLabel('被引用组件', {exact: true}).selectOption({label: '统计条副本'});
  await page.getByLabel('引用位置', {exact: true}).selectOption('slot-b-extra');
  await page.getByRole('button', {name: '建立嵌套引用', exact: true}).click();
  await page.getByRole('heading', {name: '建立引用影响'}).waitFor();
  await page.getByText(/1 个使用方的共享结构将同步/).waitFor();
  await page.getByText('外壳 · 位置 slot-a · 覆盖：title-b=内层标题覆盖', {exact: true}).waitFor();
  await page.getByRole('button', {name: '取消建立', exact: true}).click();
  await page.getByRole('status').filter({hasText: '已取消建立引用'}).waitFor();
  assert.equal(await page.getByRole('img', {name: /^引用：/}).count(), 2, '取消不得新增引用');
  const cancelled = await saveProject(page, 'reference-impact-cancelled.html');
  assert.equal(cancelled.project.references.length, 2);
  assert.deepEqual(cancelled.project.drafts.find(draft => draft.name === '外壳'), shellBefore, '取消不得静默重写既有使用方');
  // 再次建立并确认：上游使用方同步，引用与修订都提交。
  await page.getByRole('button', {name: '建立嵌套引用', exact: true}).click();
  await page.getByRole('heading', {name: '建立引用影响'}).waitFor();
  await page.getByRole('button', {name: '确认建立并同步', exact: true}).click();
  await page.getByRole('status').filter({hasText: '已建立嵌套引用：内层 → 统计条副本'}).waitFor();
  assert.equal(await page.getByRole('img', {name: /^引用：/}).count(), 3);
  const committed = await saveProject(page, 'reference-impact-committed.html');
  assert.equal(committed.project.references.length, 3);
  const names = Object.fromEntries(committed.project.drafts.map(draft => [draft.id, draft.name]));
  const shellRef = committed.project.references.find(ref => names[ref.ownerDraftId] === '外壳');
  const inner = committed.project.drafts.find(draft => draft.name === '内层');
  assert.equal(shellRef.targetRevision, inner.revision, '既有使用方同步后引用修订必须更新');
  const shell = committed.project.drafts.find(draft => draft.name === '外壳');
  assert.equal((shell.content.html.match(/data-wb-ref-root/g) || []).length, 3, '使用方共享结构应包含间接引用的新结构');
});

test('更新组件组主体不会自动继承到变体，主体与变体保持独立内容', async t => {
  const {page, prototype} = await load(t);
  await extract(page, prototype, 'card-a', '主体卡');
  await locate(page);
  await extract(page, prototype, 'card-b', '变体卡');
  await locate(page);
  await components(page);
  await page.getByLabel('选择组件稿：变体卡', {exact: true}).uncheck();
  await page.getByLabel('选择组件稿：主体卡', {exact: true}).check();
  await page.getByLabel('选择组件稿：变体卡', {exact: true}).check();
  await page.getByText('选择顺序：主体卡 → 变体卡', {exact: true}).waitFor();
  await page.getByLabel('组件组名称', {exact: true}).fill('主体不变体组');
  await page.getByRole('button', {name: '定义组件组', exact: true}).click();
  await page.getByRole('group', {name: '组件组：主体不变体组', exact: true}).waitFor();
  const before = await saveProject(page, 'primary-no-inheritance-before.html');
  const variantBefore = before.project.drafts.find(draft => draft.name === '变体卡');
  // 主体更新为只包含标题的来源范围。
  await selectChip(page, '主体卡');
  await page.getByRole('button', {name: '定位来源', exact: true}).click();
  await page.getByRole('status').filter({hasText: '已定位来源'}).waitFor();
  await prototype.locator('[data-wb-node="title-a"]').click();
  await page.getByText('title-a', {exact: true}).waitFor();
  await page.getByRole('button', {name: '更新提取范围', exact: true}).click();
  await page.getByRole('status').filter({hasText: '组件稿提取范围已更新'}).waitFor();
  await components(page);
  await selectChip(page, '变体卡');
  const frame = await openPreview(page, '变体卡');
  await frame.getByRole('heading', {name: '木工作坊'}).waitFor();
  await backOverview(page);
  const after = await saveProject(page, 'primary-no-inheritance-after.html');
  assert.equal(after.project.drafts.find(draft => draft.name === '主体卡').revision, 2);
  assert.deepEqual(after.project.drafts.find(draft => draft.name === '变体卡'), variantBefore, '主体更新不得改写变体内容、来源或修订');
  assert.deepEqual(after.project.groups, before.project.groups, '主体更新不改变组件组成员');
  assert.deepEqual(after.project.references, [], '同组关系不是继承，也不自动建立引用');
});

test('共享组件更新按依赖顺序传递到间接使用方，各自覆盖保留', async t => {
  const {page, prototype} = await load(t);
  await extract(page, prototype, 'card-a', '外壳');
  await locate(page);
  await extract(page, prototype, 'card-b', '内层');
  await locate(page);
  await extract(page, prototype, 'stats', '统计条');
  await components(page);
  await createReference(page, '内层', '统计条', 'slot-b', {'wood-value': '96'});
  await createReference(page, '外壳', '内层', 'slot-a', {'title-b': '内层标题覆盖'});
  await selectChip(page, '统计条');
  await page.getByRole('button', {name: '定位来源', exact: true}).click();
  await page.getByRole('status').filter({hasText: '已定位来源'}).waitFor();
  await prototype.locator('[data-wb-node="stats-panel"]').click({position: {x: 4, y: 4}});
  await page.getByText('stats-panel', {exact: true}).waitFor();
  await page.getByRole('button', {name: '更新提取范围', exact: true}).click();
  await page.getByRole('heading', {name: '引用更新影响'}).waitFor();
  await page.getByText(/2 个使用方/).waitFor();
  await page.getByText('内层 · 位置 slot-b · 覆盖：wood-value=96', {exact: true}).waitFor();
  await page.getByText('外壳 · 位置 slot-a · 覆盖：title-b=内层标题覆盖', {exact: true}).waitFor();
  await page.getByRole('button', {name: '确认更新并同步', exact: true}).click();
  await page.getByRole('status').filter({hasText: '组件稿提取范围已更新'}).waitFor();
  await components(page);
  let frame = await openPreview(page, '内层');
  await frame.getByText('营地统计', {exact: true}).waitFor();
  await frame.getByText('96', {exact: true}).waitFor();
  await backOverview(page);
  frame = await openPreview(page, '外壳');
  await frame.getByText('营地统计', {exact: true}).waitFor();
  await frame.getByText('96', {exact: true}).waitFor();
  await frame.getByText('内层标题覆盖', {exact: true}).waitFor();
  await backOverview(page);
});
