import { test } from 'node:test';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { fixture, startHelper } from '../../local-helper/tests/fixture.mjs';
import * as api from '../dist/api.mjs';
import {figmaFixture} from './platform-fixture.mjs';

async function ready(f,figma) {
  const workflow=new api.Workflow(new api.HelperClient(f.base,f.token),api.createFigmaPlatform(figma));
  await workflow.connect();
  await workflow.saveProject({id:'g2',name:'测试游戏',path:f.project,maintained:true});
  await workflow.selectProject('g2');
  return workflow;
}

test('development manifest permits the documented localhost endpoint used by the built UI',async()=>{
  const manifest=JSON.parse(await readFile(new URL('../manifest.json',import.meta.url),'utf8'));
  const html=await readFile(new URL('../dist/ui.html',import.meta.url),'utf8');
  const address=html.match(/id="address" value="([^"]+)"/)?.[1];
  assert.ok(address,'built UI must declare its default helper endpoint');
  // Figma documents localhost:port for development; native IP rejection was captured in manual acceptance.
  assert.equal(new URL(address).hostname,'localhost');
  assert.deepEqual(manifest.networkAccess.devAllowedDomains,[address]);
  assert.deepEqual(manifest.networkAccess.allowedDomains,['none']);
  const f=await fixture();
  try {
    const localBase=new URL(f.base);
    localBase.hostname='localhost';
    const client=new api.HelperClient(localBase.origin,f.token);
    await client.health();
    assert.deepEqual(await client.projects(),[]);
  }finally{await f.cleanup();}
});

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

test('a failed item keeps earlier successes, records the failure and retries only what is missing',async()=>{
  const f=await fixture();
  try {
    const {api:figma,page}=figmaFixture();
    const workflow=await ready(f,figma);
    await workflow.scan();
    const original=figma.createImage;
    let count=0;
    figma.createImage=bytes=>{if(++count===2)throw new Error('Figma image rejected');return original(bytes);};
    await workflow.import();
    const first=workflow.state.result;
    assert.equal(first.cancelled,false);
    assert.equal(first.failures.length,1);
    assert.match(first.failures[0].reason,/Figma image rejected/);
    assert.deepEqual(first.applied,{added:1,updated:0,removed:0});
    assert.equal(workflow.state.phase,'部分失败');
    assert.match(workflow.state.error,/1 项未完成/);
    assert.equal(workflow.state.progress.done,2);
    // 部分成果保留：已成功项仍在，未成功项没有组件也没有同步记录。
    assert.equal(page.children.length,1);
    assert.equal(page.children[0].children.length,1);
    assert.equal(JSON.parse(page.children[0].children[0].data['atlas.sync.v1']).status,'current');
    // 保留的扫描结果直接重试；不需要重新扫描，也不会重复创建。
    assert.ok(workflow.state.scan);
    figma.createImage=original;
    await workflow.import();
    assert.equal(workflow.state.result.failures.length,0);
    assert.deepEqual(workflow.state.result.applied,{added:1,updated:0,removed:0});
    assert.equal(page.children[0].children.length,2);
    assert.equal(workflow.state.phase,'就绪');
    assert.equal(workflow.state.scan,undefined);
    await workflow.scan();
    assert.deepEqual([workflow.state.plan.added,workflow.state.plan.updated,workflow.state.plan.removed,workflow.state.plan.unchanged],[0,0,0,2]);
  }finally{await f.cleanup();}
});

test('cancelling an import keeps completed items, records no success for the rest and retries idempotently',async()=>{
  const f=await fixture();
  try {
    const {api:figma,page}=figmaFixture();
    let workflow;
    let cancelled=false;
    workflow=new api.Workflow(new api.HelperClient(f.base,f.token),api.createFigmaPlatform(figma),()=>{
      if(!cancelled&&workflow.state.busy&&workflow.state.progress.done===1){cancelled=true;workflow.cancel();}
    });
    await workflow.connect();
    await workflow.saveProject({id:'g2',name:'测试游戏',path:f.project,maintained:true});
    await workflow.selectProject('g2');
    await workflow.scan();
    await workflow.import();
    const report=workflow.state.result;
    assert.equal(report.cancelled,true);
    assert.deepEqual(report.applied,{added:1,updated:0,removed:0});
    assert.equal(report.failures.length,0);
    assert.equal(workflow.state.phase,'已取消');
    assert.equal(workflow.state.busy,false);
    assert.equal(workflow.state.progress.done,1);
    assert.equal(page.children[0].children.length,1);
    // 未完成项不记成功：只有真正写入的组件带当前同步记录。
    for(const child of page.children[0].children) assert.equal(JSON.parse(child.data['atlas.sync.v1']).status,'current');
    // 保留扫描结果，重试只补齐剩余项且不重复创建。
    assert.ok(workflow.state.scan);
    await workflow.import();
    assert.equal(workflow.state.result.cancelled,false);
    assert.deepEqual(workflow.state.result.applied,{added:1,updated:0,removed:0});
    assert.equal(page.children[0].children.length,2);
    assert.equal(new Set(page.children[0].children.map(child=>JSON.parse(child.data['atlas.source']).identity)).size,2);
    assert.equal(workflow.state.phase,'就绪');
  }finally{await f.cleanup();}
});

test('cancelling a scan discards the result instead of treating missing items as source removals',async()=>{
  const f=await fixture();
  try {
    const {api:figma,page}=figmaFixture();
    let release;
    const gate=new Promise(resolve=>{release=resolve;});
    class GatedClient extends api.HelperClient {
      constructor(base,token){super(base,token);this.started=new Promise(resolve=>{this.markStarted=resolve;});}
      async scan(id,signal){this.markStarted();const scan=await super.scan(id,signal);await gate;return scan;}
    }
    const helper=new GatedClient(f.base,f.token);
    const workflow=new api.Workflow(helper,api.createFigmaPlatform(figma));
    await workflow.connect();
    await workflow.saveProject({id:'g2',name:'测试游戏',path:f.project,maintained:true});
    await workflow.selectProject('g2');
    const running=workflow.scan();
    await helper.started;
    workflow.cancel();
    assert.equal(workflow.state.phase,'取消中');
    release();
    await running;
    assert.equal(workflow.state.phase,'已取消');
    assert.equal(workflow.state.error,'');
    assert.equal(workflow.state.scan,undefined);
    assert.equal(workflow.state.plan,undefined);
    assert.equal(workflow.state.busy,false);
    assert.equal(page.children.length,0);
    // 取消后的重新扫描仍能完成正常导入，不遗留误判的源缺失。
    await workflow.scan();
    assert.equal(workflow.state.scan.summary.sprites,2);
    await workflow.import();
    assert.equal(page.children[0].children.length,2);
    assert.equal(workflow.state.result.failures.length,0);
  }finally{await f.cleanup();}
});

test('a failed item preserves concurrent page edits made by the user',async()=>{
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
    await workflow.import();
    assert.equal(workflow.state.result.failures.length,1);
    assert.equal(page.name,'用户同期修改的名称');
    assert.equal(page.getPluginData('atlas.binding'),userBinding);
    assert.deepEqual(page.children.filter(node=>node===userNode),[userNode]);
    assert.equal(page.children.flatMap(node=>node.children||[]).length,1);
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
    await workflow.scan();
    assert.deepEqual([workflow.state.plan.added,workflow.state.plan.updated,workflow.state.plan.removed,workflow.state.plan.unchanged],[0,0,0,2]);
    await workflow.import();
    assert.equal(page.children[0].children.length,2);
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

test('restarted helper reconnects after a disconnect and resumes scan and import through the task entry',async()=>{
  const f=await fixture();
  let restarted;
  try {
    const {api:figma,page}=figmaFixture();
    const workflow=new api.Workflow(new api.HelperClient(f.base,f.token),api.createFigmaPlatform(figma));
    await workflow.connect();
    await workflow.saveProject({id:'g2',name:'测试游戏',path:f.project,maintained:true});
    await workflow.selectProject('g2');
    await f.stop();
    // 退出助手后的提示必须指向托盘状态，而不是让用户找开发服务器。
    await assert.rejects(workflow.scan(),/托盘/);
    assert.equal(workflow.state.connected,false);
    restarted=await startHelper(f.data);
    const resumed=new api.Workflow(new api.HelperClient(restarted.base,restarted.token),api.createFigmaPlatform(figma));
    await resumed.connect();
    assert.deepEqual(resumed.allProjects().map(project=>project.id),['g2']);
    await resumed.selectProject('g2');
    await resumed.scan();
    assert.equal(resumed.state.scan.summary.sprites,2);
    await resumed.import();
    assert.equal(page.children.length,1);
    assert.deepEqual(page.children[0].children.map(child=>child.name).sort(),['未分类/green','未分类/red']);
  } finally {if(restarted) await restarted.stop(); await f.cleanup();}
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
    assert.deepEqual(page.children[0].children.map(c=>c.name).sort(),['未分类/green','未分类/red']);
    assert.equal(images.length,2);
    assert.equal(page.children[0].children.find(c=>c.width===2).height,2);
    assert.equal(JSON.stringify(page).includes(JSON.stringify(f.project).slice(1,-1)),false);
    assert.equal(workflow.state.progress.done,2);
    assert.equal(workflow.state.busy,false);
  } finally {await f.cleanup();}
});
