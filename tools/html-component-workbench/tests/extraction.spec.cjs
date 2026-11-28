const {test}=require('node:test');
const assert=require('node:assert/strict');
const path=require('node:path');
const {openWorkbench,root}=require('./support.cjs');
const {mkdir,writeFile,readFile}=require('node:fs/promises');
async function pixelDifference(page,a,b){return page.evaluate(async([first,second])=>{async function pixels(src){const image=new Image();image.src='data:image/png;base64,'+src;await image.decode();const canvas=document.createElement('canvas');canvas.width=image.width;canvas.height=image.height;const context=canvas.getContext('2d');context.drawImage(image,0,0);return {width:image.width,height:image.height,data:context.getImageData(0,0,image.width,image.height).data};}const one=await pixels(first),two=await pixels(second);if(one.width!==two.width||one.height!==two.height)return {sizeMismatch:[one.width,one.height,two.width,two.height]};let changed=0,max=0,nonEdgeChanged=0;for(let i=0;i<one.data.length;i+=4){let delta=0;for(let c=0;c<4;c++)delta=Math.max(delta,Math.abs(one.data[i+c]-two.data[i+c]));if(delta>0){changed++;const x=(i/4)%one.width,y=Math.floor(i/4/one.width);let edge=false;for(let c=0;c<3;c++){let low=255,high=0;for(let dy=-1;dy<=1;dy++)for(let dx=-1;dx<=1;dx++){const nx=x+dx,ny=y+dy;if(nx<0||ny<0||nx>=one.width||ny>=one.height)continue;const value=one.data[(ny*one.width+nx)*4+c];low=Math.min(low,value);high=Math.max(high,value);}if(high-low>8)edge=true;}if(!edge)nonEdgeChanged++;}max=Math.max(max,delta);}return {width:one.width,height:one.height,changed,nonEdgeChanged,total:one.width*one.height,max};},[a.toString('base64'),b.toString('base64')]);}
async function load(t){const result=await openWorkbench(t);await result.page.getByLabel('载入原型 HTML').setInputFiles(path.join(root,'tests/fixtures/extraction/visual.html'));await result.page.getByRole('status').filter({hasText:'已载入：跨层级视觉样例'}).waitFor();await result.page.getByRole('button',{name:'编辑',exact:true}).click();await result.page.getByRole('status').filter({hasText:'业务输入与自动变化已冻结'}).waitFor();return result;}
test('跨父级内容通过公开UI提取独立组件稿，保留真实文字图片和来源',async t=>{
 const {page,prototype}=await load(t);
 await prototype.locator('[data-wb-node="card"]').click({position:{x:8,y:150}});
 await prototype.getByText('可以收取',{exact:true}).click({modifiers:['Shift']});
 await page.getByText('card、badge',{exact:true}).waitFor();
 await page.getByLabel('组件稿名称',{exact:true}).fill('小屋与收取状态');
 await page.getByRole('button',{name:'提取独立组件稿',exact:true}).click();
 const draft=page.frameLocator('iframe[title="组件稿：小屋与收取状态"]');
 await draft.getByRole('heading',{name:'林间小屋'}).waitFor();
 assert.equal(await draft.getByRole('img',{name:'山间小屋'}).count(),1);
 assert.equal(await draft.locator('[data-wb-node="title"]').textContent(),'林间小屋');
 await page.getByRole('button',{name:'定位来源',exact:true}).click();
 await prototype.getByRole('heading',{name:'林间小屋'}).waitFor();
 await page.getByRole('button',{name:'预览',exact:true}).click();
 await prototype.getByRole('button',{name:'收取木材'}).click();
 await prototype.getByRole('button',{name:'已收取'}).waitFor();
});

test('跨父级视觉像素对照：继承变量、图片变换、裁切层叠和几何一致，仅允许抗锯齿边缘差异',async t=>{
 const {page,prototype}=await load(t);
 await page.getByRole('button',{name:'预览',exact:true}).click();
 const box=await page.locator('iframe[title="原型画布"]').boundingBox();
 const source=await page.screenshot({clip:{x:box.x+88,y:box.y+76,width:386,height:200}});
 const observations=await prototype.locator('[data-wb-node="badge"]').evaluate(node=>({rect:node.getBoundingClientRect().toJSON(),style:Array.from(getComputedStyle(node)).map(k=>[k,getComputedStyle(node).getPropertyValue(k)]),typed:node.computedStyleMap().get('transform').toString()}));
 await page.getByRole('button',{name:'编辑',exact:true}).click();
 await prototype.locator('[data-wb-node="card"]').click({position:{x:8,y:150}});
 await prototype.getByText('可以收取',{exact:true}).click({modifiers:['Shift']});
 await page.getByText('card、badge',{exact:true}).waitFor();
 await page.getByLabel('组件稿名称',{exact:true}).fill('像素对照');
 await page.getByRole('button',{name:'提取独立组件稿',exact:true}).click();
 t.diagnostic('提取结果 '+await page.getByRole('status').textContent());
 const frame=page.locator('iframe[title="组件稿：像素对照"]');
 await page.frameLocator('iframe[title="组件稿：像素对照"]').getByRole('img',{name:'山间小屋'}).evaluate(image=>image.decode());
 const actualObservations=await page.frameLocator('iframe[title="组件稿：像素对照"]').locator('[data-wb-node="badge"]').evaluate(node=>({rect:node.getBoundingClientRect().toJSON(),style:Array.from(getComputedStyle(node)).map(k=>[k,getComputedStyle(node).getPropertyValue(k)]),typed:node.computedStyleMap().get('transform').toString()}));
 t.diagnostic(JSON.stringify({frameBox:box,sourceRect:observations.rect,draftRect:actualObservations.rect,sourceTyped:observations.typed,draftTyped:actualObservations.typed,styleDiff:observations.style.filter(([key,value])=>actualObservations.style.find(([k])=>k===key)?.[1]!==value)}));
 const draft=await frame.screenshot();
 const difference=await pixelDifference(page,source,draft);
 const evidence=path.join(root,'dist/extraction-evidence');await mkdir(evidence,{recursive:true});await writeFile(path.join(evidence,'source.png'),source);await writeFile(path.join(evidence,'draft.png'),draft);await writeFile(path.join(evidence,'pixels.json'),JSON.stringify(difference,null,2));
 t.diagnostic('像素比较 '+JSON.stringify(difference)+'；证据 '+evidence);
 // 源截图与组件稿同为 1:1。此前 view-transition-name:root 被复制到包装层，触发合成层并改变
 // 旋转徽章的文字抗锯齿（1188 像素差异）；修复后仅剩旋转/圆角/图片边缘的亚像素 AA。
 const near=(actual,expected,tolerance=0.01)=>Math.abs(actual-expected)<=tolerance;
 assert.equal(actualObservations.typed,observations.typed,'Typed OM transform 必须与原型逐字一致');
 assert.ok(near(actualObservations.rect.width,observations.rect.width)&&near(actualObservations.rect.height,observations.rect.height),'组件稿几何尺寸必须与原型一致');
 assert.ok(near(actualObservations.rect.left+88,observations.rect.left)&&near(actualObservations.rect.top+76,observations.rect.top),'组件稿几何位置必须与裁切偏移一致');
 assert.equal(difference.sizeMismatch,undefined,'截图尺寸必须一致');
 assert.equal(difference.nonEdgeChanged,0,'非边缘像素必须完全一致；结构、裁切或错层差异会在此暴露');
 assert.ok(difference.changed<=64,`仅允许抗锯齿边缘差异（≤64 像素），实际改动 ${difference.changed} 像素`);
 assert.ok(difference.max<=16,`边缘抗锯齿单通道差异不得超过 16，实际 ${difference.max}`);
});

test('选区可逐级扩缩、跨父级加减选、隐藏恢复且排除子层不改变原型',async t=>{
 const {page,prototype}=await load(t);
 const card=prototype.locator('[data-wb-node="card"]');const before=await card.boundingBox();
 await prototype.getByRole('heading',{name:'林间小屋'}).click();await page.getByText('title',{exact:true}).waitFor();
 await page.getByRole('button',{name:'扩大选区',exact:true}).click();await page.getByText('card',{exact:true}).waitFor();
 await page.getByRole('button',{name:'缩小选区',exact:true}).click();await page.getByText('title',{exact:true}).waitFor();
 await page.getByRole('button',{name:'扩大选区',exact:true}).click();await page.getByText('card',{exact:true}).waitFor();
 await page.getByRole('button',{name:'临时隐藏选区',exact:true}).click();await page.getByText('临时隐藏 1 项；提取自动使用原始显隐。',{exact:true}).waitFor();
 assert.equal(await card.evaluate(node=>getComputedStyle(node).visibility),'hidden');assert.deepEqual(await card.boundingBox(),before);
 await page.getByRole('button',{name:'恢复全部隐藏',exact:true}).click();await card.waitFor({state:'visible'});assert.deepEqual(await card.boundingBox(),before);
 await page.getByRole('button',{name:'加选模式',exact:true}).click();await prototype.getByText('可以收取',{exact:true}).click();await page.getByText('card、badge',{exact:true}).waitFor();
 await page.getByRole('button',{name:'减选模式',exact:true}).click();await prototype.getByText('可以收取',{exact:true}).click();await page.getByText('card',{exact:true}).waitFor();
 await prototype.getByText('木材 +12',{exact:true}).click();await page.getByText('已排除：detail',{exact:true}).waitFor();
 await page.getByLabel('组件稿名称',{exact:true}).fill('排除统计');await page.getByRole('button',{name:'提取独立组件稿',exact:true}).click();
 const draft=page.frameLocator('iframe[title="组件稿：排除统计"]');await draft.getByRole('heading',{name:'林间小屋'}).waitFor();assert.equal(await draft.getByText('木材 +12',{exact:true}).count(),0);
 await page.getByRole('button',{name:'定位来源',exact:true}).click();await prototype.getByText('木材 +12',{exact:true}).waitFor();assert.deepEqual(await card.boundingBox(),before);
});

test('组件稿独立预览支持50%-200%缩放检查，缩放不改变保存内容',async t=>{
 const {page,prototype}=await load(t);
 await prototype.getByRole('heading',{name:'林间小屋'}).click();
 await page.getByText('title',{exact:true}).waitFor();
 await page.getByLabel('组件稿名称',{exact:true}).fill('缩放检查');
 await page.getByRole('button',{name:'提取独立组件稿',exact:true}).click();
 await page.locator('iframe[title="组件稿：缩放检查"]').waitFor();
 const draftFrame=()=>page.locator('iframe[title="组件稿：缩放检查"]');
 const nativeWidth=Number(await draftFrame().getAttribute('width'));
 async function saveRecord(name){
  const pending=page.waitForEvent('download');
  await page.getByRole('button',{name:'保存项目 HTML',exact:true}).click();
  const download=await pending;const file=path.join(root,'test-results/extraction/'+name);
  await mkdir(path.dirname(file),{recursive:true});await download.saveAs(file);
  const html=await readFile(file,'utf8');
  return JSON.parse(html.match(/<script\b[^>]*id="workbench-project"[^>]*>([\s\S]*?)<\/script>/i)[1]);
 }
 const before=await saveRecord('zoom-before-project.html');
 const initial=await draftFrame().boundingBox();
 assert.ok(Math.abs(initial.width-nativeWidth)<1,'1:1 预览应保持组件稿原尺寸');
 for(let step=0;step<2;step++)await page.getByRole('button',{name:'放大组件稿',exact:true}).click();
 await page.getByText('预览比例 150%',{exact:true}).waitFor();
 const enlarged=await draftFrame().boundingBox();
 assert.ok(Math.abs(enlarged.width-nativeWidth*1.5)<1.5,'150% 缩放后预览宽度必须随之放大：'+JSON.stringify({nativeWidth,width:enlarged.width}));
 await page.frameLocator('iframe[title="组件稿：缩放检查"]').getByRole('heading',{name:'林间小屋'}).waitFor();
 await page.getByRole('button',{name:'放大组件稿',exact:true}).click();
 await page.getByRole('button',{name:'放大组件稿',exact:true}).click();
 await page.getByText('预览比例 200%',{exact:true}).waitFor();
 assert.equal(await page.getByRole('button',{name:'放大组件稿',exact:true}).isDisabled(),true,'上限 200%');
 for(let step=0;step<6;step++)await page.getByRole('button',{name:'缩小组件稿',exact:true}).click();
 await page.getByText('预览比例 50%',{exact:true}).waitFor();
 assert.equal(await page.getByRole('button',{name:'缩小组件稿',exact:true}).isDisabled(),true,'下限 50%');
 const reduced=await draftFrame().boundingBox();
 assert.ok(Math.abs(reduced.width-nativeWidth*0.5)<1.5,'50% 缩放后预览宽度必须随之缩小');
 const after=await saveRecord('zoom-after-project.html');
 for(const key of ['prototype','drafts','groups','references','mappings','reviews'])assert.deepEqual(after[key],before[key],'缩放只影响查看，不得改写 '+key);
});

test('SVG use/image 引用不能保真携带时明确报错，不静默丢图且保留已有组件稿',async t=>{
 const {page,prototype}=await openWorkbench(t);
 await page.getByLabel('载入原型 HTML').setInputFiles(path.join(root,'tests/fixtures/extraction/svg-ref.html'));
 await page.getByRole('status').filter({hasText:'已载入：SVG 引用样例'}).waitFor();
 await page.getByRole('button',{name:'编辑',exact:true}).click();
 await page.getByRole('status').filter({hasText:'业务输入与自动变化已冻结'}).waitFor();
 await prototype.getByRole('heading',{name:'SVG 引用'}).click();
 await page.getByText('title',{exact:true}).waitFor();
 await page.getByLabel('组件稿名称',{exact:true}).fill('标题');
 await page.getByRole('button',{name:'提取独立组件稿',exact:true}).click();
 await page.getByRole('status').filter({hasText:'已提取独立组件稿：标题'}).waitFor();
 await page.getByRole('button',{name:'定位来源',exact:true}).click();
 await page.getByRole('status').filter({hasText:'已定位来源'}).waitFor();
 await prototype.locator('[data-wb-node="card"]').click({position:{x:8,y:8}});
 await page.getByText('card',{exact:true}).waitFor();
 await page.getByRole('button',{name:'提取独立组件稿',exact:true}).click();
 await page.getByRole('status').filter({hasText:/不支持 SVG use \/ image 引用/}).waitFor();
 const pending=page.waitForEvent('download');
 await page.getByRole('button',{name:'保存项目 HTML',exact:true}).click();
 const download=await pending;const file=path.join(root,'test-results/extraction/svg-ref-project.html');
 await mkdir(path.dirname(file),{recursive:true});await download.saveAs(file);
 const html=await readFile(file,'utf8');
 const record=JSON.parse(html.match(/<script\b[^>]*id="workbench-project"[^>]*>([\s\S]*?)<\/script>/i)[1]);
 assert.equal(record.drafts.length,1,'失败的提取不能留下不完整组件稿');
 assert.equal(record.drafts[0].name,'标题','已有组件稿必须保留');
});

test('临时隐藏不跨页面、状态或模式泄漏，切换后自动恢复显隐',async t=>{
 const {page,prototype}=await openWorkbench(t);
 await page.getByRole('button',{name:'打开受控示例'}).click();
 await page.getByRole('status').filter({hasText:'已载入：受控组件样例'}).waitFor();
 await page.getByRole('button',{name:'编辑',exact:true}).click();
 await page.getByRole('status').filter({hasText:'业务输入与自动变化已冻结'}).waitFor();
 const header=prototype.locator('[data-wb-node="header"]');
 const visibility=()=>header.evaluate(node=>getComputedStyle(node).visibility);
 async function hideHeader(){
  await header.click({position:{x:4,y:4}});
  await page.getByText('header',{exact:true}).waitFor();
  await page.getByRole('button',{name:'临时隐藏选区',exact:true}).click();
  await page.getByText('临时隐藏 1 项；提取自动使用原始显隐。',{exact:true}).waitFor();
  assert.equal(await visibility(),'hidden');
 }
 await hideHeader();
 // 同页面切换状态：隐藏样式必须恢复，工作台不能留下无恢复入口的隐藏记录。
 await page.getByRole('button',{name:'卡片 / 详情',exact:true}).click();
 await prototype.getByRole('dialog',{name:'小屋详情'}).waitFor();
 await prototype.locator('[data-wb-node="header"]').waitFor({state:'visible'});
 assert.equal(await visibility(),'visible','切换状态后隐藏样式必须恢复');
 assert.equal(await page.getByText('临时隐藏 1 项；提取自动使用原始显隐。',{exact:true}).count(),0);
 await page.getByRole('button',{name:'卡片 / 默认',exact:true}).click();
 await prototype.getByRole('dialog',{name:'小屋详情'}).waitFor({state:'hidden'});
 await hideHeader();
 // 切换页面：同一隐藏样式不能继续作用于新页面内容。
 await page.getByRole('button',{name:'统计 / 默认',exact:true}).click();
 await prototype.getByText('营地生产',{exact:true}).waitFor();
 assert.equal(await visibility(),'visible','切换页面后隐藏样式必须恢复');
 await hideHeader();
 // 切换模式：预览中不能残留编辑模式的隐藏样式。
 await page.getByRole('button',{name:'预览',exact:true}).click();
 await page.getByRole('status').filter({hasText:'原型交互已恢复'}).waitFor();
 assert.equal(await visibility(),'visible','切换模式后隐藏样式必须恢复');
});

test('独立身份不自动去重，真实多选顺序和并排预览可操作，更新范围与不支持失败保留旧成果',async t=>{
 const {page,prototype}=await load(t);
 async function create(name){await prototype.getByRole('heading',{name:'林间小屋'}).click();await page.getByText('title',{exact:true}).waitFor();await page.getByLabel('组件稿名称',{exact:true}).fill(name);await page.getByRole('button',{name:'提取独立组件稿',exact:true}).click();await page.frameLocator('iframe[title="组件稿：'+name+'"]').getByRole('heading',{name:'林间小屋'}).waitFor();}
 await create('甲');await page.getByRole('button',{name:'定位来源',exact:true}).click();await create('乙');
 await page.getByLabel('选择组件稿：乙',{exact:true}).uncheck();await page.getByLabel('选择组件稿：乙',{exact:true}).check();await page.getByLabel('选择组件稿：甲',{exact:true}).check();await page.getByText('选择顺序：乙 → 甲',{exact:true}).waitFor();
 await page.getByRole('button',{name:'并排预览所选',exact:true}).click();assert.equal(await page.locator('iframe[title^="组件稿："]').count(),2);
 await page.getByRole('button',{name:'定位来源',exact:true}).click();await page.getByRole('button',{name:'扩大选区',exact:true}).click();await page.getByText('card',{exact:true}).waitFor();await page.getByRole('button',{name:'更新提取范围',exact:true}).click();
 await page.frameLocator('iframe[title="组件稿：乙"]').getByRole('img',{name:'山间小屋'}).waitFor();await page.getByText(/修订 2/).waitFor();assert.equal(await page.getByLabel('选择组件稿：甲',{exact:true}).count(),1);
 await page.getByLabel('当前组件稿名称',{exact:true}).fill('乙改名');await page.getByRole('button',{name:'重命名组件稿',exact:true}).click();await page.getByLabel('选择组件稿：乙改名',{exact:true}).waitFor();
 await page.getByRole('button',{name:'定位来源',exact:true}).click();await prototype.locator('[data-wb-node="unsupported"]').click();await page.getByText('unsupported',{exact:true}).waitFor();await page.getByRole('button',{name:'更新提取范围',exact:true}).click();await page.getByRole('status').filter({hasText:'不支持 canvas'}).waitFor();
 await page.getByRole('tab',{name:'组件',exact:true}).click();await page.getByRole('button',{name:'乙改名',exact:true}).click();await page.frameLocator('iframe[title="组件稿：乙改名"]').getByRole('img',{name:'山间小屋'}).waitFor();await page.getByText(/修订 2/).waitFor();
});
