const {test} = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const {pathToFileURL} = require('node:url');
const fs = require('node:fs/promises');
const {openWorkbench, root} = require('./support.cjs');
const evidence = path.join(root, 'test-results/acceptance');

async function shot(page, name) {
  await fs.mkdir(evidence, {recursive: true});
  const file = path.join(evidence, name);
  await page.screenshot({path: file});
  return file;
}
async function status(page, text) {
  await page.getByRole('status').filter({hasText: text}).waitFor();
}
async function extract(page, prototype, nodeId, name) {
  await prototype.locator('[data-wb-node="' + nodeId + '"]').click({position: {x: 5, y: 5}});
  await page.getByText(nodeId, {exact: true}).waitFor();
  await page.getByLabel('组件稿名称', {exact: true}).fill(name);
  await page.getByRole('button', {name: '提取独立组件稿', exact: true}).click();
  await page.locator('iframe[title="组件稿：' + name + '"]').waitFor();
}
async function locate(page) {
  await page.getByRole('button', {name: '定位来源', exact: true}).click();
  await status(page, '已定位来源');
}
async function components(page) {
  await page.getByRole('tab', {name: '组件', exact: true}).click();
  await page.getByRole('heading', {name: '组件关系概览'}).waitFor();
}
async function chip(page, name) {
  await page.getByRole('button', {name: new RegExp('^组件：' + name + '（')}).click();
}
async function createReference(page, ownerName, targetName, slotId, overrides = {}) {
  await chip(page, ownerName);
  await page.getByLabel('被引用组件', {exact: true}).selectOption({label: targetName});
  await page.getByLabel('引用位置', {exact: true}).selectOption(slotId);
  for (const [nodeId, value] of Object.entries(overrides)) await page.getByLabel('覆盖文字：' + nodeId, {exact: true}).fill(value);
  await page.getByRole('button', {name: '建立嵌套引用', exact: true}).click();
  // 使用方本身已被引用时，建立引用会先展示上游影响；测试按公开 UI 确认后继续。
  await page.waitForFunction(({heading, status}) => [...document.querySelectorAll('h2')].some(node => node.textContent === heading)
    || document.querySelector('[role="status"]')?.textContent.includes(status), {heading: '建立引用影响', status: '已建立嵌套引用：' + ownerName});
  if (await page.getByRole('heading', {name: '建立引用影响'}).count()) await page.getByRole('button', {name: '确认建立并同步', exact: true}).click();
  await status(page, '已建立嵌套引用：' + ownerName + ' → ' + targetName);
}
async function loadRelations(t, viewport) {
  const result = await openWorkbench(t, {viewport});
  await result.page.getByLabel('载入原型 HTML').setInputFiles(path.join(root, 'tests/fixtures/relations/cards.html'));
  await status(result.page, '已载入：营地关系样例');
  await result.page.getByRole('button', {name: '编辑', exact: true}).click();
  await status(result.page, '业务输入与自动变化已冻结');
  return result;
}

test('关系概览在常用视口下五条引用的标签互不重叠且都在连线区域内', async t => {
  const {page, prototype} = await loadRelations(t, {width: 1440, height: 960});
  for (const [nodeId, name] of [['card-a', '卡片甲'], ['card-b', '卡片乙'], ['stats', '统计条'], ['stats-panel', '统计面板']]) {
    await extract(page, prototype, nodeId, name);
    await locate(page);
  }
  await components(page);
  await createReference(page, '卡片甲', '统计条', 'slot-a', {'wood-value': '128'});
  await createReference(page, '卡片乙', '统计条', 'slot-b', {'wood-value': '96'});
  await createReference(page, '卡片甲', '统计面板', 'slot-a-extra');
  await createReference(page, '卡片乙', '统计面板', 'slot-b-extra');
  await createReference(page, '统计条', '统计面板', 'stats');

  const links = page.getByRole('img', {name: /^引用：/});
  assert.equal(await links.count(), 5, '五条引用都必须显示为可读连线');
  const rendered = await links.evaluateAll(groups => groups.map(group => {
    const svg = group.ownerSVGElement;
    const svgBox = svg.getBoundingClientRect();
    const label = group.querySelector('text');
    const box = label.getBoundingClientRect();
    return {
      name: group.getAttribute('aria-label'),
      text: label.textContent,
      box: {left: box.left, top: box.top, right: box.right, bottom: box.bottom, width: box.width, height: box.height},
      area: {left: svgBox.left, top: svgBox.top, right: svgBox.right, bottom: svgBox.bottom},
      opacity: Number(getComputedStyle(group).opacity)
    };
  }));
  for (const link of rendered) assert.equal(link.text, '引用', '每条引用线标明“引用”：' + link.name);
  for (const link of rendered) {
    assert.ok(link.box.width > 0 && link.box.height > 0, '标签必须实际绘制：' + link.name);
    assert.ok(link.box.left >= link.area.left - 0.5 && link.box.right <= link.area.right + 0.5 && link.box.top >= link.area.top - 0.5 && link.box.bottom <= link.area.bottom + 0.5,
      '标签不得溢出连线区域：' + link.name + ' ' + JSON.stringify(link.box) + ' / ' + JSON.stringify(link.area));
  }
  const overlap = (one, two) => Math.min(one.right, two.right) - Math.max(one.left, two.left) > 0.5
    && Math.min(one.bottom, two.bottom) - Math.max(one.top, two.top) > 0.5;
  for (let i = 0; i < rendered.length; i++) for (let j = i + 1; j < rendered.length; j++) {
    assert.equal(overlap(rendered[i].box, rendered[j].box), false,
      '引用标签不能互相重叠，否则无法辨认：' + rendered[i].name + ' / ' + rendered[j].name);
  }
  t.diagnostic('多引用标签截图 ' + await shot(page, 'relation-labels-1440.png'));

  // 选中被引用组件时，相关线高亮、无关线弱化，仍可逐条辨认。
  await chip(page, '统计条');
  const related = await page.getByRole('img', {name: /^引用：/}).evaluateAll(groups => groups.map(group => ({
    name: group.getAttribute('aria-label'),
    related: group.dataset.related,
    opacity: Number(getComputedStyle(group).opacity)
  })));
  const byName = Object.fromEntries(related.map(item => [item.name, item]));
  for (const name of ['引用：卡片甲 → 统计条', '引用：卡片乙 → 统计条', '引用：统计条 → 统计面板']) {
    assert.equal(byName[name].related, 'true', '相关引用线高亮：' + name);
  }
  for (const name of ['引用：卡片甲 → 统计面板', '引用：卡片乙 → 统计面板']) {
    assert.equal(byName[name].related, 'false', '无关引用线弱化：' + name);
    assert.ok(byName[name].opacity < 0.5, '无关引用线必须明显弱化：' + name);
  }
  t.diagnostic('引用高亮截图 ' + await shot(page, 'relation-highlight-1440.png'));
});

async function canvasLayout(page) {
  return page.locator('iframe[title="原型画布"]').evaluate(frame => {
    let scroller = frame.parentElement;
    while (scroller) {
      const style = getComputedStyle(scroller);
      if (/(auto|scroll)/.test(style.overflowX + style.overflowY)) break;
      scroller = scroller.parentElement;
    }
    const rect = element => {
      const box = element.getBoundingClientRect();
      return {left: box.left, top: box.top, right: box.right, bottom: box.bottom, width: box.width, height: box.height};
    };
    return {
      frame: rect(frame),
      scroller: scroller ? {...rect(scroller), scrollWidth: scroller.scrollWidth, scrollHeight: scroller.scrollHeight,
        clientWidth: scroller.clientWidth, clientHeight: scroller.clientHeight, scrollLeft: scroller.scrollLeft, scrollTop: scroller.scrollTop} : null,
      pageScrollWidth: document.documentElement.scrollWidth,
      pageWidth: innerWidth
    };
  });
}
async function scrollCanvasToEnd(page) {
  return page.locator('iframe[title="原型画布"]').evaluate(frame => {
    let scroller = frame.parentElement;
    while (scroller) {
      const style = getComputedStyle(scroller);
      if (/(auto|scroll)/.test(style.overflowX + style.overflowY)) break;
      scroller = scroller.parentElement;
    }
    scroller.scrollLeft = scroller.scrollWidth;
    scroller.scrollTop = scroller.scrollHeight;
    const frameBox = frame.getBoundingClientRect(), box = scroller.getBoundingClientRect();
    return {
      scrollLeft: scroller.scrollLeft, scrollTop: scroller.scrollTop,
      maxLeft: scroller.scrollWidth - scroller.clientWidth, maxTop: scroller.scrollHeight - scroller.clientHeight,
      rightInside: frameBox.right <= box.right + 0.5, bottomInside: frameBox.bottom <= box.bottom + 0.5,
      leftInside: frameBox.left >= box.left - 0.5, topInside: frameBox.top >= box.top - 0.5
    };
  });
}

async function clickInsideScaledCanvas(page, locator) {
  // CSS transform 缩放 iframe 后，Playwright 的 frameLocator 点击仍按未缩放坐标命中；
  // 用户真实鼠标点击落在缩放后的像素上，因此这里按可见位置发送真实鼠标事件。
  const frame = page.locator('iframe[title="原型画布"]');
  const frameBox = await frame.boundingBox();
  const nativeWidth = Number(await frame.getAttribute('width'));
  const scale = frameBox.width / nativeWidth;
  const rect = await locator.evaluate(element => {
    const box = element.getBoundingClientRect();
    return {x: box.x, y: box.y, width: box.width, height: box.height};
  });
  await page.mouse.click(frameBox.x + (rect.x + rect.width / 2) * scale, frameBox.y + (rect.y + rect.height / 2) * scale);
}

async function pixelDifference(page, first, second) {
  return page.evaluate(async ([one, two]) => {
    async function pixels(src) {
      const image = new Image();
      image.src = 'data:image/png;base64,' + src;
      await image.decode();
      const canvas = document.createElement('canvas');
      canvas.width = image.width;
      canvas.height = image.height;
      const context = canvas.getContext('2d');
      context.drawImage(image, 0, 0);
      return {width: image.width, height: image.height, data: context.getImageData(0, 0, image.width, image.height).data};
    }
    const a = await pixels(one), b = await pixels(two);
    if (a.width !== b.width || a.height !== b.height) return {sizeMismatch: [a.width, a.height, b.width, b.height]};
    let changed = 0, nonEdgeChanged = 0, max = 0;
    for (let index = 0; index < a.data.length; index += 4) {
      let delta = 0;
      for (let channel = 0; channel < 4; channel++) delta = Math.max(delta, Math.abs(a.data[index + channel] - b.data[index + channel]));
      if (delta > 0) {
        changed++;
        const x = (index / 4) % a.width, y = Math.floor(index / 4 / a.width);
        let edge = false;
        for (let channel = 0; channel < 3; channel++) {
          let low = 255, high = 0;
          for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
            const nx = x + dx, ny = y + dy;
            if (nx < 0 || ny < 0 || nx >= a.width || ny >= a.height) continue;
            const value = a.data[(ny * a.width + nx) * 4 + channel];
            low = Math.min(low, value); high = Math.max(high, value);
          }
          if (high - low > 8) edge = true;
        }
        if (!edge) nonEdgeChanged++;
      }
      max = Math.max(max, delta);
    }
    return {width: a.width, height: a.height, changed, nonEdgeChanged, max, total: a.width * a.height};
  }, [first.toString('base64'), second.toString('base64')]);
}
async function assertSamePixels(t, page, first, second, label) {
  const difference = await pixelDifference(page, first, second);
  t.diagnostic(label + ' 像素对照 ' + JSON.stringify(difference));
  assert.equal(difference.sizeMismatch, undefined, label + '：尺寸必须一致');
  // 与提取像素验收同标准：非边缘像素必须完全一致；只允许抗锯齿边缘的微小差异。
  assert.equal(difference.nonEdgeChanged, 0, label + '：非边缘像素必须完全一致，不能靠容差掩盖错层或裁切');
  assert.ok(difference.changed <= 64, label + '：仅允许抗锯齿边缘差异（≤64 像素），实际 ' + difference.changed);
  assert.ok(difference.max <= 16, label + '：边缘抗锯齿单通道差异不得超过 16，实际 ' + difference.max);
}
async function saveProject(page, name) {
  await fs.mkdir(evidence, {recursive: true});
  const pending = page.waitForEvent('download');
  await page.getByRole('button', {name: '保存项目 HTML', exact: true}).click();
  const download = await pending;
  const file = path.join(evidence, name);
  await download.saveAs(file);
  const html = await fs.readFile(file, 'utf8');
  const blocks = [...html.matchAll(/<script\b[^>]*id="workbench-project"[^>]*>([\s\S]*?)<\/script>/gi)];
  assert.equal(blocks.length, 1, '单 HTML 项目文件必须只有一个机器可读项目区块');
  return {file, html, project: JSON.parse(blocks[0][1])};
}
async function checkDraft(page, name, checked) {
  const box = page.getByLabel('选择组件稿：' + name, {exact: true});
  if (checked) await box.check(); else await box.uncheck();
}

const acceptanceFixture = path.join(root, 'tests/fixtures/acceptance/camp.html');

test('验收闭环：组件稿、组件组、嵌套引用与映射确认保存为新会话离线重开并二次保存', async t => {
  const {browser, page, prototype} = await openWorkbench(t, {viewport: {width: 1440, height: 960}, timeout: 8000});
  await page.getByLabel('载入原型 HTML').setInputFiles(acceptanceFixture);
  await status(page, '已载入：验收营地样例');
  const prototypeBefore = await page.locator('iframe[title="原型画布"]').screenshot();
  await page.getByRole('button', {name: '编辑', exact: true}).click();
  await status(page, '业务输入与自动变化已冻结');
  for (const [nodeId, name] of [['card-a', '卡片甲'], ['card-b', '卡片乙'], ['stats', '统计条'], ['view-a', '查看小屋按钮'], ['collect-b', '收取木材按钮']]) {
    await extract(page, prototype, nodeId, name);
    await locate(page);
  }
  await components(page);
  // 真实勾选顺序：卡片甲为主体、卡片乙为变体；按钮用相反于列表的顺序分别成组。
  for (const name of ['查看小屋按钮', '卡片甲', '卡片乙', '统计条']) await checkDraft(page, name, false).catch(() => {});
  await checkDraft(page, '收取木材按钮', false);
  await checkDraft(page, '卡片甲', true);
  await checkDraft(page, '卡片乙', true);
  await page.getByText('选择顺序：卡片甲 → 卡片乙', {exact: true}).waitFor();
  await page.getByLabel('组件组名称', {exact: true}).fill('营地卡片组');
  await page.getByRole('button', {name: '定义组件组', exact: true}).click();
  await page.getByRole('group', {name: '组件组：营地卡片组', exact: true}).waitFor();
  await checkDraft(page, '卡片甲', false);
  await checkDraft(page, '卡片乙', false);
  await checkDraft(page, '查看小屋按钮', true);
  await checkDraft(page, '收取木材按钮', true);
  await page.getByText('选择顺序：查看小屋按钮 → 收取木材按钮', {exact: true}).waitFor();
  await page.getByLabel('组件组名称', {exact: true}).fill('卡片操作按钮组');
  await page.getByRole('button', {name: '定义组件组', exact: true}).click();
  const buttonGroup = page.getByRole('group', {name: '组件组：卡片操作按钮组', exact: true});
  await buttonGroup.waitFor();
  assert.equal(await buttonGroup.getByRole('button', {name: /^组件：/}).nth(0).getAttribute('aria-label'), '组件：查看小屋按钮（主体）');
  // 嵌套引用：两张卡片共享同一统计条，各自覆盖不同数值。
  await createReference(page, '卡片甲', '统计条', 'slot-a', {'wood-value': '128'});
  await createReference(page, '卡片乙', '统计条', 'slot-b', {'wood-value': '96'});
  // 来源映射：候选 → 批量确认。
  await page.getByRole('tab', {name: '界面', exact: true}).click();
  await prototype.locator('[data-wb-node="card-a"]').click({position: {x: 5, y: 5}});
  await page.getByText('card-a', {exact: true}).waitFor();
  await page.getByLabel('候选复用组件', {exact: true}).selectOption({label: '卡片甲'});
  await page.getByRole('button', {name: '标记候选映射', exact: true}).click();
  await status(page, '已标记候选复用：卡片甲');
  await prototype.locator('[data-wb-node="card-b"]').click({position: {x: 5, y: 5}});
  await page.getByText('card-b', {exact: true}).waitFor();
  await page.getByLabel('候选复用组件', {exact: true}).selectOption({label: '卡片乙'});
  await page.getByRole('button', {name: '标记候选映射', exact: true}).click();
  await status(page, '已标记候选复用：卡片乙');
  await components(page);
  await page.getByLabel('选择映射：卡片甲 · card-a', {exact: true}).check();
  await page.getByLabel('选择映射：卡片乙 · card-b', {exact: true}).check();
  await page.getByRole('button', {name: '批量确认所选', exact: true}).click();
  await page.getByText('当前有效复用约束：2 条（仅已确认且无未解决复核）', {exact: true}).waitFor();
  // 组建模后的共享结构与覆盖值在独立预览中可见，且仍保留可读文字与图片。
  await chip(page, '卡片甲');
  await page.getByRole('button', {name: '独立预览：卡片甲', exact: true}).click();
  await page.getByRole('heading', {name: '独立预览', exact: true}).waitFor();
  const cardPreviewFrame = page.locator('iframe[title="组件稿：卡片甲"]');
  const cardDraft = page.frameLocator('iframe[title="组件稿：卡片甲"]');
  await cardDraft.getByRole('heading', {name: '林间小屋'}).waitFor();
  await cardDraft.getByText('营地统计', {exact: true}).waitFor();
  await cardDraft.getByText('128', {exact: true}).waitFor();
  assert.equal(await cardDraft.getByText('120', {exact: true}).count(), 0);
  assert.equal(await cardDraft.getByRole('img', {name: '林间小屋插画'}).count(), 1);
  const cardPreview = await cardPreviewFrame.screenshot();
  await page.getByRole('button', {name: '返回关系概览', exact: true}).click();
  await page.getByRole('heading', {name: '组件关系概览'}).waitFor();
  await page.getByRole('img', {name: '引用：卡片甲 → 统计条', exact: true}).waitFor();
  await page.getByRole('img', {name: '引用：卡片乙 → 统计条', exact: true}).waitFor();
  // 保存前确认全部拆分、引用与映射未改动原型视觉和业务交互。
  await page.getByRole('tab', {name: '界面', exact: true}).click();
  await page.getByRole('button', {name: '预览', exact: true}).click();
  await status(page, '原型交互已恢复');
  const prototypeAfter = await page.locator('iframe[title="原型画布"]').screenshot();
  await assertSamePixels(t, page, prototypeBefore, prototypeAfter, '整理前/整理后原型');
  await prototype.locator('header').getByRole('button', {name: '收取木材'}).click();
  assert.equal(await prototype.getByLabel('已收取').textContent(), '1', '返回预览后业务交互仍可用');
  const savedA = await saveProject(page, 'acceptance-a.html');
  assert.equal(savedA.project.format, 'html-component-workbench');
  assert.equal(savedA.project.formatVersion, 1);
  assert.equal(savedA.project.prototype.manifest.id, 'acceptance-camp');
  assert.equal(savedA.project.prototype.manifest.contentVersion, '1');
  assert.match(savedA.project.prototype.html, /林间营地/);
  assert.match(savedA.project.prototype.html, /木工作坊/);
  assert.match(savedA.project.prototype.html, /data:image\/svg\+xml/);
  assert.equal(/blob:|file:\/\/\/|[A-Za-z]:\\\\/.test(savedA.project.prototype.html), false, '原型不得依赖临时地址或开发机路径');
  const names = Object.fromEntries(savedA.project.drafts.map(draft => [draft.id, draft.name]));
  assert.deepEqual(savedA.project.drafts.map(draft => draft.name).sort(), ['卡片乙', '卡片甲', '查看小屋按钮', '收取木材按钮', '统计条'].sort());
  const groupView = savedA.project.groups.map(group => ({name: group.name, primary: names[group.primaryId], members: group.memberIds.map(id => names[id])}));
  assert.deepEqual(groupView, [
    {name: '营地卡片组', primary: '卡片甲', members: ['卡片甲', '卡片乙']},
    {name: '卡片操作按钮组', primary: '查看小屋按钮', members: ['查看小屋按钮', '收取木材按钮']}
  ]);
  assert.equal(savedA.project.references.length, 2);
  const refs = savedA.project.references.map(ref => ({owner: names[ref.ownerDraftId], target: names[ref.targetDraftId], slot: ref.slotNodeId, overrides: ref.overrides}));
  assert.deepEqual(refs, [
    {owner: '卡片甲', target: '统计条', slot: 'slot-a', overrides: [{nodeId: 'wood-value', kind: 'text', value: '128'}]},
    {owner: '卡片乙', target: '统计条', slot: 'slot-b', overrides: [{nodeId: 'wood-value', kind: 'text', value: '96'}]}
  ]);
  for (const draft of savedA.project.drafts) {
    assert.ok(draft.content.html.length > 100 && draft.content.width > 0 && draft.content.height > 0, '组件稿必须含真实内容与尺寸：' + draft.name);
    assert.equal(/blob:|file:\/\/\//.test(draft.content.html + draft.content.css), false, '组件稿不得依赖临时地址：' + draft.name);
    assert.equal(draft.source.prototypeId, 'acceptance-camp');
    assert.equal(draft.source.contentVersion, '1');
    assert.equal(draft.source.pageId, 'camp');
    assert.equal(draft.source.stateId, 'default');
    assert.ok(draft.source.nodeIds.length >= 1, '组件稿需保留稳定来源节点：' + draft.name);
    for (const key of ['x', 'y', 'width', 'height']) assert.ok(Number.isFinite(draft.source.bounds[key]), '组件稿来源范围需完整：' + draft.name);
  }
  const ownerCard = savedA.project.drafts.find(draft => draft.name === '卡片甲');
  assert.match(ownerCard.content.html, /data-wb-ref-root/);
  assert.match(ownerCard.content.html, /营地统计/);
  assert.match(ownerCard.content.html, /128/);
  assert.match(ownerCard.content.html, /data-wb-node="art-a"/);
  assert.equal(savedA.project.mappings.length, 2);
  assert.ok(savedA.project.mappings.every(mapping => mapping.status === 'confirmed' && mapping.reviewId === null));
  for (const mapping of savedA.project.mappings) {
    assert.equal(mapping.source.prototypeId, 'acceptance-camp');
    assert.equal(mapping.source.pageId, 'camp');
    assert.equal(mapping.source.stateId, 'default');
    assert.ok(mapping.source.nodeIds.length >= 1);
  }
  const statsDraft = savedA.project.drafts.find(draft => draft.name === '统计条');
  assert.match(statsDraft.content.html, /木材/);
  assert.match(statsDraft.content.html, /伙伴/);
  assert.deepEqual(savedA.project.reviews, []);

  // 全新离线 BrowserContext 直接用 file:// 打开下载文件：原型与整理成果都在。
  const offline = await browser.newContext({offline: true, viewport: {width: 1440, height: 960}, reducedMotion: 'reduce'});
  t.after(() => offline.close());
  const viewer = await offline.newPage();
  viewer.setDefaultTimeout(8000);
  await viewer.goto(pathToFileURL(savedA.file).href);
  await status(viewer, '已载入项目');
  await viewer.getByRole('tab', {name: '组件', exact: true}).click();
  await viewer.getByRole('heading', {name: '组件关系概览'}).waitFor();
  const reopenedGroup = viewer.getByRole('group', {name: '组件组：营地卡片组', exact: true});
  await reopenedGroup.waitFor();
  assert.equal(await reopenedGroup.getByRole('button', {name: /^组件：/}).nth(0).getAttribute('aria-label'), '组件：卡片甲（主体）');
  assert.equal(await reopenedGroup.getByRole('button', {name: /^组件：/}).nth(1).getAttribute('aria-label'), '组件：卡片乙（变体）');
  const reopenedButtons = viewer.getByRole('group', {name: '组件组：卡片操作按钮组', exact: true});
  await reopenedButtons.waitFor();
  assert.equal(await reopenedButtons.getByRole('button', {name: /^组件：/}).nth(0).getAttribute('aria-label'), '组件：查看小屋按钮（主体）');
  await viewer.getByRole('img', {name: '引用：卡片甲 → 统计条', exact: true}).waitFor();
  await viewer.getByRole('img', {name: '引用：卡片乙 → 统计条', exact: true}).waitFor();
  const initialLinks = await viewer.getByRole('img', {name: /^引用：/}).evaluateAll(groups => groups.map(group => ({
    name: group.getAttribute('aria-label'),
    opacity: Number(getComputedStyle(group).opacity),
    label: group.querySelector('text')?.textContent
  })));
  for (const link of initialLinks) {
    assert.equal(link.label, '引用');
    assert.ok(link.opacity >= 0.9, '未选中任何组件时，关系概览必须直接可读而不是全部弱化：' + link.name + ' opacity=' + link.opacity);
  }
  await viewer.getByText('当前有效复用约束：2 条（仅已确认且无未解决复核）', {exact: true}).waitFor();
  assert.equal(await viewer.getByText('已确认（有效）', {exact: true}).count(), 2);
  await chip(viewer, '统计条');
  await viewer.getByText('卡片甲 · 位置 slot-a · 覆盖 wood-value=128', {exact: true}).waitFor();
  await viewer.getByText('卡片乙 · 位置 slot-b · 覆盖 wood-value=96', {exact: true}).waitFor();
  await chip(viewer, '卡片甲');
  await viewer.getByRole('button', {name: '独立预览：卡片甲', exact: true}).click();
  await viewer.getByRole('heading', {name: '独立预览', exact: true}).waitFor();
  const reopenedDraft = viewer.frameLocator('iframe[title="组件稿：卡片甲"]');
  await reopenedDraft.getByRole('heading', {name: '林间小屋'}).waitFor();
  await reopenedDraft.getByText('营地统计', {exact: true}).waitFor();
  await reopenedDraft.getByText('128', {exact: true}).waitFor();
  await assertSamePixels(t, viewer, cardPreview, await viewer.locator('iframe[title="组件稿：卡片甲"]').screenshot(), '离线重开组件稿');
  await viewer.getByRole('button', {name: '返回关系概览', exact: true}).click();
  await viewer.getByRole('heading', {name: '组件关系概览'}).waitFor();
  await viewer.getByRole('tab', {name: '界面', exact: true}).click();
  const reopenedPrototype = viewer.frameLocator('iframe[title="原型画布"]');
  await reopenedPrototype.getByRole('heading', {name: '林间营地'}).waitFor();
  const reopenedPrototypeShot = await viewer.locator('iframe[title="原型画布"]').screenshot();
  await assertSamePixels(t, viewer, prototypeBefore, reopenedPrototypeShot, '离线重开完整原型');
  await reopenedPrototype.locator('header').getByRole('button', {name: '收取木材'}).click();
  assert.equal(await reopenedPrototype.getByLabel('已收取').textContent(), '1', '离线文件中的原型业务交互可用');
  t.diagnostic('离线重开截图 ' + await shot(viewer, 'offline-reopened-acceptance.png'));

  // 继续整理：交换按钮组主体、排除一条映射，再保存。新会话中的修改仍保留全部引用与覆盖值。
  await viewer.getByRole('tab', {name: '组件', exact: true}).click();
  await checkDraft(viewer, '查看小屋按钮', false);
  await checkDraft(viewer, '收取木材按钮', false);
  await checkDraft(viewer, '收取木材按钮', true);
  await checkDraft(viewer, '查看小屋按钮', true);
  await viewer.getByText('选择顺序：收取木材按钮 → 查看小屋按钮', {exact: true}).waitFor();
  await viewer.getByLabel('组件组名称', {exact: true}).fill('卡片操作按钮组');
  await viewer.getByRole('button', {name: '定义组件组', exact: true}).click();
  const swappedButtons = viewer.getByRole('group', {name: '组件组：卡片操作按钮组', exact: true});
  await swappedButtons.waitFor();
  assert.equal(await swappedButtons.getByRole('button', {name: /^组件：/}).nth(0).getAttribute('aria-label'), '组件：收取木材按钮（主体）');
  await viewer.getByLabel('选择映射：卡片乙 · card-b', {exact: true}).check();
  await viewer.getByRole('button', {name: '批量排除所选', exact: true}).click();
  await viewer.getByText('当前有效复用约束：1 条（仅已确认且无未解决复核）', {exact: true}).waitFor();
  const savedB = await saveProject(viewer, 'acceptance-b.html');
  const bNames = Object.fromEntries(savedB.project.drafts.map(draft => [draft.id, draft.name]));
  assert.equal(bNames[savedB.project.groups.find(group => group.name === '卡片操作按钮组').primaryId], '收取木材按钮');
  assert.deepEqual(savedB.project.drafts, savedA.project.drafts, '二次保存不重写组件稿');
  assert.deepEqual(savedB.project.references, savedA.project.references, '二次保存保留引用与覆盖值');
  assert.deepEqual(savedB.project.groups[0], savedA.project.groups[0], '卡片组不变');
  assert.deepEqual(savedB.project.mappings.map(mapping => mapping.status), ['confirmed', 'excluded']);
  assert.deepEqual(savedB.project.reviews, []);

  // 空白工作台重新导入二次保存的文件，仍可查看、继续整理并再次成功保存。
  const blankContext = await browser.newContext({offline: true, viewport: {width: 1440, height: 960}, reducedMotion: 'reduce'});
  t.after(() => blankContext.close());
  const blank = await blankContext.newPage();
  blank.setDefaultTimeout(8000);
  await blank.goto(pathToFileURL(path.join(root, 'dist/workbench.html')).href);
  await blank.getByLabel('载入项目 HTML').setInputFiles(savedB.file);
  await status(blank, '已载入项目');
  await blank.getByRole('tab', {name: '组件', exact: true}).click();
  await blank.getByRole('heading', {name: '组件关系概览'}).waitFor();
  const blankButtons = blank.getByRole('group', {name: '组件组：卡片操作按钮组', exact: true});
  await blankButtons.waitFor();
  assert.equal(await blankButtons.getByRole('button', {name: /^组件：/}).nth(0).getAttribute('aria-label'), '组件：收取木材按钮（主体）');
  await blank.getByText('当前有效复用约束：1 条（仅已确认且无未解决复核）', {exact: true}).waitFor();
  assert.equal(await blank.getByText('已排除', {exact: true}).count(), 1);
  await chip(blank, '卡片甲');
  await blank.getByRole('button', {name: '独立预览：卡片甲', exact: true}).click();
  await blank.getByRole('heading', {name: '独立预览', exact: true}).waitFor();
  await blank.frameLocator('iframe[title="组件稿：卡片甲"]').getByText('128', {exact: true}).waitFor();
  await blank.getByRole('tab', {name: '界面', exact: true}).click();
  await blank.getByRole('button', {name: '预览', exact: true}).click();
  await status(blank, '原型交互已恢复');
  await blank.frameLocator('iframe[title="原型画布"]').locator('header').getByRole('button', {name: '收取木材'}).click();
  assert.equal(await blank.frameLocator('iframe[title="原型画布"]').getByLabel('已收取').textContent(), '1');
  const savedC = await saveProject(blank, 'acceptance-c.html');
  assert.equal(savedC.project.id, savedA.project.id);
  for (const key of ['prototype', 'drafts', 'groups', 'references', 'mappings', 'reviews']) {
    assert.deepEqual(savedC.project[key], savedB.project[key], '空白工作台二次保存保留 ' + key);
  }
  t.diagnostic('空白重导入截图 ' + await shot(blank, 'blank-reimport-acceptance.png'));
});

test('验收失败保护：不支持提取、循环/悬空引用、损坏与未来版本文件都不覆盖已有成果', async t => {
  const {page, prototype} = await openWorkbench(t, {viewport: {width: 1440, height: 960}, timeout: 8000});
  await page.getByLabel('载入原型 HTML').setInputFiles(acceptanceFixture);
  await status(page, '已载入：验收营地样例');
  await page.getByRole('button', {name: '编辑', exact: true}).click();
  await status(page, '业务输入与自动变化已冻结');
  for (const [nodeId, name] of [['card-a', '卡片甲'], ['card-b', '卡片乙'], ['stats', '统计条']]) {
    await extract(page, prototype, nodeId, name);
    await locate(page);
  }
  await components(page);
  for (const name of ['卡片甲', '卡片乙', '统计条']) await checkDraft(page, name, false);
  await checkDraft(page, '卡片甲', true);
  await checkDraft(page, '卡片乙', true);
  await page.getByLabel('组件组名称', {exact: true}).fill('保留组');
  await page.getByRole('button', {name: '定义组件组', exact: true}).click();
  await page.getByRole('group', {name: '组件组：保留组', exact: true}).waitFor();
  await createReference(page, '卡片甲', '统计条', 'slot-a', {'wood-value': '88'});
  const baseline = await saveProject(page, 'protection-baseline.html');
  const keep = baseline.project;

  // 不支持保真提取的内容明确报错，不产生组件稿修订。
  await page.getByRole('tab', {name: '界面', exact: true}).click();
  await prototype.locator('[data-wb-node="unsupported-fx"]').click();
  await page.getByText('unsupported-fx', {exact: true}).waitFor();
  await page.getByRole('button', {name: '更新提取范围', exact: true}).click();
  await status(page, /不支持 3D、滤镜或混合模式/);

  // 自引用和循环引用被拒绝，已有引用保持唯一。
  await components(page);
  await chip(page, '卡片甲');
  await page.getByLabel('被引用组件', {exact: true}).selectOption({label: '卡片甲'});
  await page.getByLabel('引用位置', {exact: true}).selectOption('title-a');
  await page.getByRole('button', {name: '建立嵌套引用', exact: true}).click();
  await status(page, '不能引用自身');
  await chip(page, '统计条');
  await page.getByLabel('被引用组件', {exact: true}).selectOption({label: '卡片甲'});
  await page.getByLabel('引用位置', {exact: true}).selectOption('stats');
  await page.getByRole('button', {name: '建立嵌套引用', exact: true}).click();
  await status(page, /循环/);
  assert.equal(await page.getByRole('img', {name: /^引用：/}).count(), 1);

  function withProject(mutate) {
    const next = structuredClone(keep);
    mutate(next);
    return '<html><head></head><body><script id="workbench-project" type="application/json">'
      + JSON.stringify(next).replace(/</g, '\\u003c') + '</script></body></html>';
  }
  async function rejected(html, name, message) {
    await page.getByLabel('载入项目 HTML').setInputFiles({name, mimeType: 'text/html', buffer: Buffer.from(html)});
    await status(page, message);
  }
  // 损坏 JSON、未来版本、悬空引用与无效引用位置。
  await rejected('<html><head></head><body><script id="workbench-project" type="application/json">{bad</script></body></html>', 'broken.html', '项目 JSON 已损坏');
  await rejected(withProject(project => { project.formatVersion = 99; }), 'future.html', '不支持的项目格式或版本');
  await rejected(withProject(project => { project.references[0].targetDraftId = 'draft-missing'; }), 'dangling.html', /引用.*不存在/);
  await rejected(withProject(project => { project.references[0].slotNodeId = 'slot-missing'; }), 'slot.html', /引用位置不存在/);
  await rejected(withProject(project => {
    project.references.push({...project.references[0], id: 'ref-overlapping-slot', slotNodeId: 'card-a', overrides: []});
  }), 'overlap.html', /重叠/);
  await rejected(withProject(project => { project.references[0].ownerDraftId = project.references[0].targetDraftId; }), 'self.html', /引用不能指向自身/);
  // 丢资源：组件稿图片字节损坏、原型引用外部地址、未来原型格式都明确拒绝。
  await rejected(withProject(project => {
    const card = project.drafts.find(draft => draft.name === '卡片甲');
    card.content.html = card.content.html.replace(/src="data:image\/svg\+xml,[^"]*"/, 'src="data:image/png;base64,bm90LWFuLWltYWdl"');
  }), 'broken-asset.html', /图片资源解码失败/);
  await rejected(withProject(project => {
    project.prototype.html = project.prototype.html.replace('</body>', '<img src="https://invalid.local/lost.png"></body>');
  }), 'external-asset.html', /资源不可携带/);
  await rejected(withProject(project => {
    project.prototype.html = project.prototype.html.replace('"version":1', '"version":99');
    project.prototype.manifest.version = 99;
  }), 'future-prototype.html', /不支持的原型格式或版本/);

  // 每次拒绝后原项目、关系与画布都保持；再次保存与基线一致，没有半提交。
  await page.getByRole('tab', {name: '组件', exact: true}).click();
  await page.getByRole('group', {name: '组件组：保留组', exact: true}).waitFor();
  await page.getByRole('img', {name: '引用：卡片甲 → 统计条', exact: true}).waitFor();
  await chip(page, '卡片甲');
  await page.getByRole('button', {name: '独立预览：卡片甲', exact: true}).click();
  await page.frameLocator('iframe[title="组件稿：卡片甲"]').getByText('88', {exact: true}).waitFor();
  await page.getByRole('button', {name: '返回关系概览', exact: true}).click();
  await page.getByRole('heading', {name: '组件关系概览'}).waitFor();
  await page.getByRole('tab', {name: '界面', exact: true}).click();
  await page.getByRole('button', {name: '预览', exact: true}).click();
  await status(page, '原型交互已恢复');
  await prototype.locator('header').getByRole('button', {name: '收取木材'}).click();
  assert.equal(await prototype.getByLabel('已收取').textContent(), '1');
  const after = await saveProject(page, 'protection-after.html');
  for (const key of ['prototype', 'drafts', 'groups', 'references', 'mappings', 'reviews']) {
    assert.deepEqual(after.project[key], keep[key], '失败导入不得覆盖或部分提交 ' + key);
  }
  assert.deepEqual(after.project.reviews, []);
  t.diagnostic('失败保护截图 ' + await shot(page, 'protection-rejections.png'));
});

test('验收来源不变性：拆分、建引用与共享结构传播后原型几何、视觉与业务交互不变', async t => {
  const {page, prototype} = await openWorkbench(t, {viewport: {width: 1440, height: 960}, timeout: 8000});
  await page.getByLabel('载入原型 HTML').setInputFiles(acceptanceFixture);
  await status(page, '已载入：验收营地样例');
  const snapshot = () => prototype.locator('body').evaluate(() => {
    const rect = id => {
      const node = document.querySelector('[data-wb-node="' + id + '"]');
      const box = node.getBoundingClientRect();
      return [id, Math.round(box.x), Math.round(box.y), Math.round(box.width), Math.round(box.height)].join(':');
    };
    return ['header', 'card-a', 'card-b', 'stats', 'collect', 'collected'].map(rect).join('|');
  });
  const beforeGeometry = await snapshot();
  const before = await page.locator('iframe[title="原型画布"]').screenshot();
  await page.getByRole('button', {name: '编辑', exact: true}).click();
  await status(page, '业务输入与自动变化已冻结');
  await extract(page, prototype, 'card-a', '卡片甲');
  await locate(page);
  await extract(page, prototype, 'stats', '统计条');
  await locate(page);
  await components(page);
  await createReference(page, '卡片甲', '统计条', 'slot-a', {'wood-value': '128'});
  // 传播：把共享统计条从“标题+数值行”收窄为数值行，影响范围先展示，确认后两处文字覆盖保留。
  await chip(page, '统计条');
  await page.getByRole('button', {name: '定位来源', exact: true}).click();
  await status(page, '已定位来源');
  await prototype.locator('[data-wb-node="stats-row"]').click({position: {x: 4, y: 4}});
  await page.getByText('stats-row', {exact: true}).waitFor();
  await page.getByRole('button', {name: '更新提取范围', exact: true}).click();
  await page.getByRole('heading', {name: '引用更新影响'}).waitFor();
  await page.getByText(/1 个使用方/).waitFor();
  await page.getByText('卡片甲 · 位置 slot-a · 覆盖：wood-value=128', {exact: true}).waitFor();
  t.diagnostic('传播影响截图 ' + await shot(page, 'propagation-impact.png'));
  await page.getByRole('button', {name: '确认更新并同步', exact: true}).click();
  await status(page, '组件稿提取范围已更新');
  await components(page);
  await chip(page, '卡片甲');
  await page.getByRole('button', {name: '独立预览：卡片甲', exact: true}).click();
  await page.getByRole('heading', {name: '独立预览', exact: true}).waitFor();
  const owner = page.frameLocator('iframe[title="组件稿：卡片甲"]');
  await owner.getByText('木材', {exact: true}).waitFor();
  await owner.getByText('128', {exact: true}).waitFor();
  assert.equal(await owner.getByText('营地统计', {exact: true}).count(), 0, '共享结构更新后标题节点应随新范围移除');
  await page.getByRole('button', {name: '返回关系概览', exact: true}).click();
  await page.getByRole('heading', {name: '组件关系概览'}).waitFor();
  await chip(page, '卡片甲');
  await page.getByText(/共享结构修订 2/).waitFor();
  // 返回预览：几何、像素与业务交互都保持。
  await page.getByRole('tab', {name: '界面', exact: true}).click();
  await page.getByRole('button', {name: '预览', exact: true}).click();
  await status(page, '原型交互已恢复');
  assert.equal(await snapshot(), beforeGeometry, '传播更新前后原型关键节点几何必须一致');
  const after = await page.locator('iframe[title="原型画布"]').screenshot();
  await assertSamePixels(t, page, before, after, '传播更新前后的完整原型');
  await prototype.locator('header').getByRole('button', {name: '收取木材'}).click();
  assert.equal(await prototype.getByLabel('已收取').textContent(), '1');
  await prototype.getByRole('button', {name: '查看小屋'}).click();
  await prototype.getByRole('dialog', {name: '小屋详情'}).waitFor();
  await prototype.getByRole('button', {name: '关闭详情'}).click();
  await prototype.getByRole('dialog', {name: '小屋详情'}).waitFor({state: 'hidden'});
  assert.equal(await page.getByRole('button', {name: '营地 / 默认', exact: true}).getAttribute('aria-current'), 'true');
  const saved = await saveProject(page, 'invariance-project.html');
  assert.equal(saved.project.references[0].targetRevision, 2);
  assert.equal(saved.project.drafts.find(draft => draft.name === '统计条').revision, 2);
  t.diagnostic('来源不变性截图 ' + await shot(page, 'invariance-after-propagation.png'));
});

test('验收组件视觉：宽组件稿独立预览保持原尺寸，不因窄面板重排内容', async t => {
  const {page, prototype} = await openWorkbench(t, {viewport: {width: 1440, height: 960}, timeout: 8000});
  await page.getByLabel('载入原型 HTML').setInputFiles(acceptanceFixture);
  await status(page, '已载入：验收营地样例');
  await page.getByRole('button', {name: '编辑', exact: true}).click();
  await status(page, '业务输入与自动变化已冻结');
  await prototype.locator('[data-wb-node="camp-page"]').click({position: {x: 5, y: 5}});
  await page.getByText('camp-page', {exact: true}).waitFor();
  await page.getByLabel('组件稿名称', {exact: true}).fill('营地整页');
  await page.getByRole('button', {name: '提取独立组件稿', exact: true}).click();
  await status(page, '已提取独立组件稿：营地整页');
  await page.getByRole('tab', {name: '组件', exact: true}).click();
  await page.getByRole('heading', {name: '组件关系概览'}).waitFor();
  await chip(page, '营地整页');
  await page.getByRole('button', {name: '独立预览：营地整页', exact: true}).click();
  await page.getByRole('heading', {name: '独立预览', exact: true}).waitFor();
  const frame = page.locator('iframe[title="组件稿：营地整页"]');
  await page.frameLocator('iframe[title="组件稿：营地整页"]').getByRole('heading', {name: '林间小屋'}).waitFor();
  const frameBox = await frame.boundingBox();
  assert.equal(await frame.getAttribute('width'), '900');
  assert.ok(Math.abs(frameBox.width - 900) < 1, '宽组件稿必须按 900px 原尺寸预览，不能在 760px 处重排：' + frameBox.width);
  const inner = await page.frameLocator('iframe[title="组件稿：营地整页"]').locator('body').evaluate(() => {
    const box = document.querySelector('[data-wb-node="card-a"]').getBoundingClientRect();
    return {viewport: document.documentElement.clientWidth, cardLeft: Math.round(box.left), cardTop: Math.round(box.top)};
  });
  assert.equal(inner.viewport, 900, '组件稿内部视口必须与提取宽度一致，不能因预览面板重排');
  assert.equal(inner.cardLeft, 32, '整页草稿中的卡片左边界必须与原型一致');
  t.diagnostic('宽组件稿预览截图 ' + await shot(page, 'wide-draft-preview.png'));
});

test('验收改版复核：UI 建立的关系在原型改版后保留并标记，文件往返不冒充有效约束', async t => {
  const {browser, page, prototype} = await openWorkbench(t, {viewport: {width: 1440, height: 960}, timeout: 8000});
  await page.getByLabel('载入原型 HTML').setInputFiles(acceptanceFixture);
  await status(page, '已载入：验收营地样例');
  await page.getByRole('button', {name: '编辑', exact: true}).click();
  await status(page, '业务输入与自动变化已冻结');
  await extract(page, prototype, 'card-a', '卡片甲');
  await locate(page);
  await extract(page, prototype, 'stats', '统计条');
  await locate(page);
  await components(page);
  await createReference(page, '卡片甲', '统计条', 'slot-a', {'wood-value': '128'});
  await page.getByRole('tab', {name: '界面', exact: true}).click();
  await prototype.locator('[data-wb-node="card-a"]').click({position: {x: 5, y: 5}});
  await page.getByText('card-a', {exact: true}).waitFor();
  await page.getByLabel('候选复用组件', {exact: true}).selectOption({label: '卡片甲'});
  await page.getByRole('button', {name: '标记候选映射', exact: true}).click();
  await status(page, '已标记候选复用：卡片甲');
  await components(page);
  await page.getByLabel('选择映射：卡片甲 · card-a', {exact: true}).check();
  await page.getByRole('button', {name: '批量确认所选', exact: true}).click();
  await page.getByText('当前有效复用约束：1 条（仅已确认且无未解决复核）', {exact: true}).waitFor();
  const beforeRevision = await saveProject(page, 'review-before.html');
  assert.deepEqual(beforeRevision.project.reviews, []);

  // 原型内容版本升级：组件稿与人工关系保留，按稳定来源标记待复核。
  const revised = (await fs.readFile(acceptanceFixture, 'utf8')).replace('"contentVersion":"1"', '"contentVersion":"2"');
  await page.getByLabel('更新原型 HTML').setInputFiles({name: 'camp-v2.html', mimeType: 'text/html', buffer: Buffer.from(revised)});
  await status(page, '原型已更新');
  await page.getByRole('heading', {name: '改版待复核'}).waitFor();
  await page.getByText(/卡片甲 · 来源已变化/).waitFor();
  await page.getByText(/统计条 · 来源已变化/).waitFor();
  await page.getByText(/卡片甲 · 映射来源失效/).waitFor();
  await components(page);
  await page.getByText('已确认（待复核，非当前有效约束）', {exact: true}).waitFor();
  await page.getByText('当前有效复用约束：0 条（仅已确认且无未解决复核）', {exact: true}).waitFor();
  await page.getByRole('img', {name: '引用：卡片甲 → 统计条', exact: true}).waitFor();
  await chip(page, '卡片甲');
  await page.getByRole('button', {name: '独立预览：卡片甲', exact: true}).click();
  await page.frameLocator('iframe[title="组件稿：卡片甲"]').getByText('128', {exact: true}).waitFor();
  await page.getByRole('button', {name: '返回关系概览', exact: true}).click();
  await page.getByRole('heading', {name: '组件关系概览'}).waitFor();
  const afterRevision = await saveProject(page, 'review-after.html');
  const data = afterRevision.project;
  assert.equal(data.formatVersion, 1, '文件格式版本不随原型内容版本升级');
  assert.equal(data.prototype.manifest.version, 1);
  assert.equal(data.prototype.manifest.contentVersion, '2');
  for (const key of ['drafts', 'groups', 'references']) assert.deepEqual(data[key], beforeRevision.project[key], '改版保留 ' + key);
  assert.equal(data.reviews.length, 3, '两个组件稿与一条映射各标记复核');
  assert.equal(data.reviews.filter(review => review.kind === 'source-changed' && !review.resolved).length, 2);
  assert.equal(data.reviews.filter(review => review.kind === 'mapping-stale' && !review.resolved).length, 1);
  assert.equal(data.mappings[0].status, 'confirmed', '人工确认不改写');
  assert.ok(data.mappings[0].reviewId && data.reviews.some(review => review.id === data.mappings[0].reviewId && review.kind === 'mapping-stale' && !review.resolved),
    '改版后的确认映射必须带未解决复核，不能冒充有效约束');

  // 离线重开改版后的文件：复核信息与待复核状态仍在，引用覆盖值不变。
  const context = await browser.newContext({offline: true, viewport: {width: 1440, height: 960}, reducedMotion: 'reduce'});
  t.after(() => context.close());
  const viewer = await context.newPage();
  viewer.setDefaultTimeout(8000);
  await viewer.goto(pathToFileURL(afterRevision.file).href);
  await status(viewer, '已载入项目');
  await viewer.getByRole('tab', {name: '组件', exact: true}).click();
  await viewer.getByRole('heading', {name: '组件关系概览'}).waitFor();
  await viewer.getByRole('heading', {name: '改版待复核'}).waitFor();
  await viewer.getByText(/卡片甲 · 来源已变化/).waitFor();
  await viewer.getByText(/统计条 · 来源已变化/).waitFor();
  await viewer.getByText(/卡片甲 · 映射来源失效/).waitFor();
  await viewer.getByText('已确认（待复核，非当前有效约束）', {exact: true}).waitFor();
  await viewer.getByText('当前有效复用约束：0 条（仅已确认且无未解决复核）', {exact: true}).waitFor();
  await viewer.getByRole('img', {name: '引用：卡片甲 → 统计条', exact: true}).waitFor();
  await chip(viewer, '统计条');
  await viewer.getByText('卡片甲 · 位置 slot-a · 覆盖 wood-value=128', {exact: true}).waitFor();
  t.diagnostic('改版复核重开截图 ' + await shot(viewer, 'revision-review-reopened.png'));
});

async function assertCommonViewport(t, viewport) {
  const {page} = await openWorkbench(t, {viewport});
  await page.getByRole('button', {name: '打开受控示例'}).click();
  await status(page, '已载入：受控组件样例');
  assert.equal(await page.locator('iframe[title="原型画布"]').getAttribute('width'), '960');
  const layout = await canvasLayout(page);
  assert.ok(layout.scroller, '原型画布必须有可滚动或可缩放的承载区');
  assert.ok(layout.scroller.scrollWidth > layout.scroller.clientWidth || layout.scroller.scrollHeight > layout.scroller.clientHeight,
    '960 宽原型在此视口必然超出初始可视区，需有滚动手段');
  assert.equal(layout.pageScrollWidth, layout.pageWidth, '页面本身不得横向溢出，侧栏不能被挤出视口');
  // 右侧操作区完整位于视口内，不被中央画布遮住。
  for (const name of ['保存项目 HTML', '编辑']) {
    const box = await page.getByRole('button', {name, exact: true}).boundingBox();
    assert.ok(box && box.x >= 0 && box.y >= 0 && box.x + box.width <= viewport.width + 0.5 && box.y + box.height <= viewport.height + 0.5,
      name + ' 必须在可视区内');
  }
  const end = await scrollCanvasToEnd(page);
  assert.ok(end.maxLeft > 0 || end.maxTop > 0, '必须能滚动到被裁切的画布区域');
  assert.ok(end.rightInside && end.bottomInside,
    '滚动后必须能到达完整画布右边缘和下边缘（不能被侧栏永久遮挡）' + JSON.stringify(end));
  const back = await page.locator('iframe[title="原型画布"]').evaluate(frame => {
    let scroller = frame.parentElement;
    while (scroller) {
      const style = getComputedStyle(scroller);
      if (/(auto|scroll)/.test(style.overflowX + style.overflowY)) break;
      scroller = scroller.parentElement;
    }
    scroller.scrollLeft = 0;
    scroller.scrollTop = 0;
    const frameBox = frame.getBoundingClientRect(), box = scroller.getBoundingClientRect();
    return {leftInside: frameBox.left >= box.left - 0.5, topInside: frameBox.top >= box.top - 0.5};
  });
  assert.ok(back.leftInside && back.topInside, '滚回起点后必须能看到画布左上边缘');
  // 编辑时右侧操作区可滚动到最底部控件，不能有不可达死角。
  await page.getByRole('button', {name: '编辑', exact: true}).click();
  await status(page, '业务输入与自动变化已冻结');
  await page.frameLocator('iframe[title="原型画布"]').getByRole('heading', {name: '林间营地'}).click();
  await page.getByText('title', {exact: true}).waitFor();
  const extractButton = page.getByRole('button', {name: '提取独立组件稿', exact: true});
  await extractButton.scrollIntoViewIfNeeded();
  const right = await page.evaluate(() => {
    const button = [...document.querySelectorAll('button')].find(item => item.textContent === '提取独立组件稿');
    const pane = button.closest('aside');
    const b = button.getBoundingClientRect(), p = pane.getBoundingClientRect();
    return {button: {top: b.top, bottom: b.bottom}, pane: {top: p.top, bottom: p.bottom, scrollHeight: pane.scrollHeight, clientHeight: pane.clientHeight}};
  });
  assert.ok(right.button.top >= right.pane.top - 0.5 && right.button.bottom <= right.pane.bottom + 0.5,
    '右侧操作区底部控件必须可通过滚动到达' + JSON.stringify(right));
  t.diagnostic(viewport.width + 'x' + viewport.height + ' 滚动前布局 ' + JSON.stringify(layout));

  // 适屏缩放：不依赖用户猜测滚动条，且缩放后仍可选择原型内容。
  const fit = page.getByRole('button', {name: '适应窗口', exact: true});
  await fit.click();
  assert.equal(await fit.getAttribute('aria-pressed'), 'true');
  await page.getByText(/已按 \d+% 缩放显示完整画布/).waitFor();
  const fitted = await canvasLayout(page);
  assert.ok(fitted.frame.width < 960, '适屏后画布应缩放而不是保持裁切');
  assert.ok(fitted.frame.left >= fitted.scroller.left - 0.5 && fitted.frame.right <= fitted.scroller.right + 0.5
    && fitted.frame.top >= fitted.scroller.top - 0.5 && fitted.frame.bottom <= fitted.scroller.bottom + 0.5,
    '适屏后完整画布应一次可见：' + JSON.stringify(fitted));
  await clickInsideScaledCanvas(page, page.frameLocator('iframe[title="原型画布"]').getByRole('button', {name: '收取木材'}));
  await page.getByText('button-b', {exact: true}).waitFor();
  assert.equal(await page.frameLocator('iframe[title="原型画布"]').getByLabel('木材数量').textContent(), '120', '编辑态点击按钮只选中，不执行业务');
  t.diagnostic(viewport.width + 'x' + viewport.height + ' 适屏截图 ' + await shot(page, 'fit-' + viewport.width + 'x' + viewport.height + '.png'));
  await fit.click();
  assert.equal(await fit.getAttribute('aria-pressed'), 'false');
  assert.equal(await page.locator('iframe[title="原型画布"]').getAttribute('width'), '960');
  await page.getByText(/画布超出可视区/).waitFor();
}

test('1440×960 常用视口可访问 960 宽完整画布、右侧操作区与适屏缩放', async t => {
  await assertCommonViewport(t, {width: 1440, height: 960});
});
test('1366×768 较小视口同样可访问完整画布、右侧操作区与适屏缩放', async t => {
  await assertCommonViewport(t, {width: 1366, height: 768});
});

