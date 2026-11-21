import { test } from 'node:test';
import { createServer } from 'node:http';
import assert from 'node:assert/strict';
import { fixture } from '../../local-helper/tests/fixture.mjs';
import * as api from '../dist/api.mjs';
import {figmaFixture} from './platform-fixture.mjs';

async function ready(f,figma) {
  const workflow=new api.Workflow(new api.HelperClient(f.base,f.token),api.createFigmaPlatform(figma));
  await workflow.connect();
  await workflow.saveProject({id:'g2',name:'测试游戏',path:f.project,maintained:true});
  await workflow.selectProject('g2');
  return workflow;
}

test('connection refuses HTTP redirects outside the selected helper endpoint',async()=>{
  let redirectedRequests=0;
  const target=createServer((req,res)=>{redirectedRequests++;res.setHeader('Content-Type','application/json');res.end(JSON.stringify({schemaVersion:1,projects:[]}));});
  await new Promise(r=>target.listen(0,'127.0.0.1',r));
  const redirect=createServer((req,res)=>{res.writeHead(302,{Location:'http://127.0.0.1:'+target.address().port+'/elsewhere'});res.end();});
  await new Promise(r=>redirect.listen(0,'127.0.0.1',r));
  try{
    const {api:figma}=figmaFixture();
    const workflow=new api.Workflow(new api.HelperClient('http://127.0.0.1:'+redirect.address().port,'0'.repeat(64)),api.createFigmaPlatform(figma));
    await assert.rejects(workflow.connect(),/助手未连接/);
    assert.equal(redirectedRequests,0);
    assert.equal(workflow.state.connected,false);
  }finally{
    await new Promise(r=>redirect.close(r));
    await new Promise(r=>target.close(r));
  }
});

test('clearing the game selection invalidates the previous scan and import target',async()=>{
  const f=await fixture();
  try {
    const {api:figma}=figmaFixture();
    const workflow=await ready(f,figma);
    await workflow.scan();
    await workflow.selectProject('');
    assert.equal(workflow.state.selected,undefined);
    assert.equal(workflow.state.scan,undefined);
    assert.equal(workflow.state.page,undefined);
    await assert.rejects(workflow.import(),/先扫描/);
  }finally{await f.cleanup();}
});

test('failed Figma import rolls back only its own nodes and resets visible progress for retry',async()=>{
  const f=await fixture();
  try {
    const {api:figma,page}=figmaFixture();
    const workflow=await ready(f,figma);
    await workflow.scan();
    const original=figma.createImage;
    let count=0;
    figma.createImage=bytes=>{if(++count===2)throw new Error('Figma image rejected');return original(bytes);};
    await assert.rejects(workflow.import(),/Figma image rejected/);
    assert.equal(page.children.length,0);
    assert.equal(page.name,'Page 1');
    assert.equal(page.getPluginData('atlas.binding'),'');
    assert.equal(workflow.state.progress.done,0);
    figma.createImage=original;
    await workflow.import();
    assert.equal(page.children[0].children.length,2);
  }finally{await f.cleanup();}
});

test('failed import preserves page names, bindings and unrelated nodes edited during import',async()=>{
  const f=await fixture();
  try {
    const {api:figma,page}=figmaFixture();
    let workflow;
    const userBinding=JSON.stringify({schemaVersion:1,projectId:'user-project'});
    const userNode={name:'同期新增内容'};
    workflow=new api.Workflow(new api.HelperClient(f.base,f.token),api.createFigmaPlatform(figma),()=>{
      if(workflow.state.progress.done===1) {
        page.name='用户同期修改的名称';
        page.setPluginData('atlas.binding',userBinding);
        if(!page.children.includes(userNode))page.appendChild(userNode);
      }
    });
    await workflow.connect();
    await workflow.saveProject({id:'g2',name:'测试游戏',path:f.project,maintained:true});
    await workflow.selectProject('g2');
    await workflow.scan();
    const createImage=figma.createImage;
    let images=0;
    figma.createImage=bytes=>{if(++images===2)throw new Error('Figma image rejected');return createImage(bytes);};
    await assert.rejects(workflow.import(),/Figma image rejected/);
    assert.equal(page.name,'用户同期修改的名称');
    assert.equal(page.getPluginData('atlas.binding'),userBinding);
    assert.deepEqual(page.children,[userNode]);
  }finally{await f.cleanup();}
});

test('page guards protect unbound content, foreign binding, renamed pages and late page changes',async()=>{
  const f=await fixture();
  try {
    const {api:figma,page}=figmaFixture();
    const workflow=await ready(f,figma);
    page.children=[{name:'用户设计'}];
    await assert.rejects(workflow.scan(),/非空/);
    assert.equal(page.children[0].name,'用户设计');
    page.children=[];
    page.setPluginData('atlas.binding',JSON.stringify({schemaVersion:1,projectId:'g3'}));
    await assert.rejects(workflow.scan(),/其他项目/);
    page.setPluginData('atlas.binding',JSON.stringify({schemaVersion:1,projectId:'g2'}));
    page.name='错误名称';
    await assert.rejects(workflow.scan(),/名称与绑定不符/);
    page.setPluginData('atlas.binding','');
    page.name='Page 1';
    await workflow.scan();
    page.children=[{name:'扫描后新增设计'}];
    await assert.rejects(workflow.import(),/非空/);
    assert.deepEqual(page.children,[{name:'扫描后新增设计'}]);
    assert.equal(page.name,'Page 1');
  }finally{await f.cleanup();}
});

test('task entry rejects project changes and repeated imports while importing',async()=>{
  const f=await fixture();
  try {
    const {api:figma,page}=figmaFixture();
    const workflow=await ready(f,figma);
    await workflow.scan();
    const running=workflow.import();
    await assert.rejects(workflow.selectProject('g2'),/任务执行中/);
    await assert.rejects(workflow.import(),/任务执行中/);
    await assert.rejects(workflow.scan(),/任务执行中/);
    await running;
    assert.equal(page.children.length,1);
    assert.equal(page.children[0].children.length,2);
    await assert.rejects(workflow.scan(),/不支持增量/);
  }finally{await f.cleanup();}
});

test('lost helper connection clears stale import results and reports restart guidance',async()=>{
  const f=await fixture();
  try {
    const {api:figma}=figmaFixture();
    const workflow=new api.Workflow(new api.HelperClient(f.base,f.token),api.createFigmaPlatform(figma));
    await workflow.connect();
    await workflow.saveProject({id:'g2',name:'测试游戏',path:f.project,maintained:true});
    await workflow.selectProject('g2');
    await workflow.scan();
    await f.stop();
    await assert.rejects(workflow.scan(),/请启动/);
    assert.equal(workflow.state.connected,false);
    assert.equal(workflow.state.scan,undefined);
    assert.equal(workflow.state.busy,false);
  } finally {await f.cleanup();}
});

test('public task entry registers, searches all games, scans and imports cropped main components', async () => {
  const f = await fixture();
  try {
    const {api:figma,page,images} = figmaFixture();
    const workflow = new api.Workflow(new api.HelperClient(f.base,f.token),api.createFigmaPlatform(figma));
    await workflow.connect();
    await workflow.saveProject({id:'g2',name:'测试游戏',path:f.project,maintained:true});
    await workflow.saveProject({id:'g3',name:'临时游戏',path:f.project,maintained:false});
    assert.deepEqual(workflow.searchProjects('').map(p=>p.id),['g2']);
    assert.deepEqual(workflow.searchProjects('g3').map(p=>p.id),['g3']);
    assert.deepEqual(workflow.searchProjects('临时').map(p=>p.id),['g3']);
    await workflow.selectProject('g2');
    await workflow.scan();
    assert.equal(workflow.state.scan.summary.sprites,2);
    await workflow.import();
    assert.equal(page.name,'测试游戏（g2）- 分类资源');
    assert.equal(JSON.parse(page.data['atlas.binding']).projectId,'g2');
    assert.equal(page.children.length,1);
    assert.equal(page.children[0].name,'未分类');
    assert.equal(page.children[0].children.length,2);
    assert.deepEqual(page.children[0].children.map(c=>c.name).sort(),['未分类/green · tiny.json','未分类/red · tiny.json']);
    assert.equal(images.length,2);
    assert.equal(page.children[0].children.find(c=>c.width===2).height,2);
    assert.equal(JSON.stringify(page).includes(JSON.stringify(f.project).slice(1,-1)),false);
    assert.equal(workflow.state.progress.done,2);
    assert.equal(workflow.state.busy,false);
  } finally {await f.cleanup();}
});
