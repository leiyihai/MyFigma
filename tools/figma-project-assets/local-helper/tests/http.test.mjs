import { test } from 'node:test';
import { request } from 'node:http';
import assert from 'node:assert/strict';
import { writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { PNG } from 'pngjs';
import { fixture, startHelper } from './fixture.mjs';

test('only paired loopback clients and explicit Figma origins can access the API',async()=>{
  const f=await fixture();
  try {
    assert.equal((await f.request('/v1/health','GET',undefined,{Authorization:'Bearer '+'0'.repeat(64)})).status,401);
    const foreign=await f.request('/v1/projects','GET',undefined,{Origin:'https://untrusted.example'});
    assert.equal(foreign.status,403);
    assert.equal(foreign.headers.has('Access-Control-Allow-Origin'),false);
    const badHost=await new Promise((resolve,reject)=>{
      const req=request(f.base+'/v1/health',{headers:{Host:'untrusted.example',Authorization:'Bearer '+f.token}},res=>{res.resume();resolve(res.statusCode);});req.on('error',reject);req.end();
    });
    assert.equal(badHost,403);
    const preflight=await fetch(f.base+'/v1/scan',{method:'OPTIONS',headers:{Origin:'null','Access-Control-Request-Method':'POST','Access-Control-Request-Headers':'Authorization, Content-Type'}});
    assert.equal(preflight.status,204);
    assert.equal(preflight.headers.get('Access-Control-Allow-Origin'),'null');
    assert.equal(preflight.headers.has('Access-Control-Allow-Credentials'),false);
    const allowed=await f.request('/v1/health','GET',undefined,{Origin:'https://www.figma.com'});
    assert.equal(allowed.status,200);
    assert.equal(allowed.headers.get('Access-Control-Allow-Origin'),'https://www.figma.com');
    assert.equal((await f.request('/v1/projects','PUT',{bad:'data'},{'Content-Type':'text/plain'})).status,415);
    assert.equal((await f.request('/v1/projects','PUT',{bad:'x'.repeat(66000)})).status,413);
  }finally{await f.cleanup();}
});

test('documented localhost host is accepted while lookalikes and wrong ports stay blocked',async()=>{
  const f=await fixture();
  try {
    const port=new URL(f.base).port;
    const status=host=>new Promise((resolve,reject)=>{
      const req=request(f.base+'/v1/health',{headers:{Host:host,Authorization:'Bearer '+f.token}},res=>{res.resume();resolve(res.statusCode);});
      req.on('error',reject);req.end();
    });
    assert.equal(await status('localhost:'+port),200);
    assert.equal(await status('localhost.evil.example:'+port),403);
    assert.equal(await status('localhost:'+(port==='1'?'2':'1')),403);
    assert.equal((await fetch(f.base+'/v1/health',{headers:{Host:'localhost:'+port}})).status,401);
  }finally{await f.cleanup();}
});

test('project edits, long-term flags and removal are shared through the helper',async()=>{
  const f=await fixture();
  try {
    const original={id:'g2',name:'旧名称',path:f.project,maintained:true};
    await f.request('/v1/projects','PUT',original);
    const edited={...original,name:'新名称',maintained:false};
    await f.request('/v1/projects','PUT',edited);
    assert.deepEqual((await(await f.request('/v1/projects')).json()).projects,[edited]);
    assert.equal((await f.request('/v1/projects','PUT',{...original,id:'../bad'})).status,400);
    await f.request('/v1/projects/g2','DELETE');
    assert.deepEqual((await(await f.request('/v1/projects')).json()).projects,[]);
    assert.equal((await f.request('/v1/scan','POST',{projectId:'g2'})).status,400);
  }finally{await f.cleanup();}
});

test('scan reports rotated, out-of-bounds and project-external images without leaking local paths',async()=>{
  const f=await fixture();
  try {
    await f.request('/v1/projects','PUT',{id:'g2',name:'测试游戏',path:f.project,maintained:true});
    const path=join(f.project,'tiny.json');
    const doc=JSON.parse(await readFile(path,'utf8'));
    doc.frames.red.rotated=true;
    doc.frames.green.frame.w=20;
    await writeFile(path,JSON.stringify(doc));
    const invalid=await(await f.request('/v1/scan','POST',{projectId:'g2'})).json();
    assert.equal(invalid.resources.length,0);
    assert.equal(invalid.errors.length,2);
    assert.equal(invalid.complete,false);
    doc.meta.image='../outside.png';
    await writeFile(path,JSON.stringify(doc));
    const external=await(await f.request('/v1/scan','POST',{projectId:'g2'})).json();
    assert.equal(external.resources.length,0);
    assert.match(external.errors[0],/扫描范围/);
    assert.equal(JSON.stringify(external).includes(JSON.stringify(f.root).slice(1,-1)),false);
  }finally{await f.cleanup();}
});

test('trimmed frames with missing restoration metadata are reported instead of silently cropped',async()=>{
  const f=await fixture();
  try{
    await f.request('/v1/projects','PUT',{id:'g2',name:'测试游戏',path:f.project,maintained:true});
    const path=join(f.project,'tiny.json');
    const doc=JSON.parse(await readFile(path,'utf8'));
    doc.frames.green.trimmed=true;
    await writeFile(path,JSON.stringify(doc));
    const scan=await(await f.request('/v1/scan','POST',{projectId:'g2'})).json();
    assert.deepEqual(scan.resources.map(r=>r.source.frameName),['red']);
    assert.equal(scan.errors.length,1);
    assert.equal(scan.complete,false);
  }finally{await f.cleanup();}
});

test('scan restores individual PNG pixels and stable relative source identities', async () => {
  const f = await fixture();
  try {
    await f.request('/v1/projects','PUT',{id:'g2',name:'测试游戏',path:f.project,maintained:true});
    const response = await f.request('/v1/scan','POST',{projectId:'g2'});
    assert.equal(response.status,200);
    const scan = await response.json();
    assert.equal(scan.schemaVersion,3);
    assert.equal(scan.resources.length,2);
    assert.deepEqual(scan.errors,[]);
    const red = scan.resources.find(r=>r.source.frameName==='red');
    const green = scan.resources.find(r=>r.source.frameName==='green');
    assert.deepEqual([...PNG.sync.read(Buffer.from(red.png,'base64')).data],
      [0,0,0,0, 0,0,0,0, 0,0,0,0, 255,0,0,255]);
    assert.deepEqual([...PNG.sync.read(Buffer.from(green.png,'base64')).data],[0,255,0,255]);
    assert.equal(red.source.relativePath,'tiny.json');
    assert.equal(red.source.identity,'["g2","atlas","tiny.json","red"]');
    assert.equal(JSON.stringify(scan).includes(JSON.stringify(f.project).slice(1,-1)),false);
    assert.equal((await (await f.request('/v1/scan','POST',{projectId:'g2'})).json()).resources.find(r=>r.source.frameName==='red').source.identity,red.source.identity);
  } finally { await f.cleanup(); }
});

test('loopback service authenticates and persists project registration across restarts', async () => {
  const f = await fixture();
  let restarted;
  try {
    assert.equal((await fetch(f.base+'/v1/projects')).status,401);
    const project = {id:'g2',name:'测试游戏',path:f.project,maintained:true};
    assert.equal((await f.request('/v1/projects','PUT',project)).status,200);
    await f.stop();
    restarted = await startHelper(f.data);
    const list = await (await restarted.request('/v1/projects')).json();
    assert.deepEqual(list.projects,[project]);
  } finally { if(restarted) await restarted.stop(); await f.cleanup(); }
});

const samplesPath = (data, id) => join(data, 'samples', id + '.json');

test('training samples stay behind pairing, Host checks and strict identity+category fields',async()=>{
  const f=await fixture();
  try {
    await f.request('/v1/projects','PUT',{id:'g2',name:'测试游戏',path:f.project,maintained:true});
    const identity=JSON.stringify(['g2','atlas','tiny.json','red']);
    const post=(body,headers={})=>fetch(f.base+'/v1/samples',{method:'POST',
      headers:{'Content-Type':'application/json',Authorization:'Bearer '+f.token,...headers},body:JSON.stringify(body)});
    // 未配对、可疑来源都被拒绝，且响应不回本机路径。
    assert.equal((await post({projectId:'g2',samples:[{identity,category:'按钮'}]},{Authorization:'Bearer '+'0'.repeat(64)})).status,401);
    assert.equal((await post({projectId:'g2',samples:[{identity,category:'按钮'}]},{Origin:'https://untrusted.example'})).status,403);
    // 字段严格：只接受项目编号与「来源身份 + 类别」。
    for (const body of [
      {samples:[{identity,category:'按钮'}]},
      {projectId:'missing',samples:[{identity,category:'按钮'}]},
      {projectId:'g2',samples:[]},
      {projectId:'g2',samples:[{identity,category:'按钮',png:'AAAA'}]},
      {projectId:'g2',images:[],samples:[{identity,category:'按钮'}]},
      {projectId:'g2',samples:[{identity,category:''}]},
      {projectId:'g2',samples:[{identity,category:'   '}]},
      {projectId:'g2',samples:[{identity,category:'a/b'}]},
      {projectId:'g2',samples:[{identity,category:'换\n行'}]},
      {projectId:'g2',samples:[{identity:'不是 JSON',category:'按钮'}]},
      {projectId:'g2',samples:[{identity:JSON.stringify(['other','atlas','tiny.json','red']),category:'按钮'}]},
      {projectId:'g2',samples:[{identity:JSON.stringify(['g2','atlas','tiny.json']),category:'按钮'}]},
      {projectId:'g2',samples:[{identity:JSON.stringify(['g2','standalone']),category:'按钮'}]},
      {projectId:'g2',samples:[{identity,category:'按钮'},{identity,category:'图标'}]}
    ]) {
      const response=await post(body);
      assert.equal(response.status,400,JSON.stringify(body));
      const text=await response.text();
      assert.equal(text.includes(JSON.stringify(f.data).slice(1,-1)),false);
    }
    // 合法提交返回保存条数；文件可读回且不含本机绝对路径。
    const saved=await post({projectId:'g2',samples:[{identity,category:'按钮'}]});
    assert.equal(saved.status,200);
    assert.deepEqual(await saved.json(),{schemaVersion:1,count:1});
    const written=JSON.parse(await readFile(samplesPath(f.data,'g2'),'utf8'));
    assert.equal(written.schemaVersion,1);
    assert.equal(written.projectId,'g2');
    assert.deepEqual(written.samples,[{identity,category:'按钮'}]);
    assert.equal(JSON.stringify(written).includes(JSON.stringify(f.data).slice(1,-1)),false);

    // 重复提交按最新人工标签整体覆盖旧样本，不残留中间文件。
    const replaced=await post({projectId:'g2',samples:[
      {identity:JSON.stringify(['g2','atlas','tiny.json','green']),category:'图标'}
    ]});
    assert.equal(replaced.status,200);
    assert.deepEqual(await replaced.json(),{schemaVersion:1,count:1});
    assert.deepEqual(JSON.parse(await readFile(samplesPath(f.data,'g2'),'utf8')).samples,[
      {identity:JSON.stringify(['g2','atlas','tiny.json','green']),category:'图标'}
    ]);
    const {readdir}=await import('node:fs/promises');
    assert.deepEqual((await readdir(join(f.data,'samples'))).sort(),['g2.json']);
  }finally{await f.cleanup();}
});

test('training samples raise only the samples body cap while other routes keep 64 KiB',async()=>{
  const f=await fixture();
  try {
    await f.request('/v1/projects','PUT',{id:'g2',name:'测试游戏',path:f.project,maintained:true});
    const identity=i=>JSON.stringify(['g2','atlas','bulk.json','frame'+i]);
    // 20 000 条标签约 1.2 MB，超过旧 64 KiB 上限，仍应被接受并落盘。
    const samples=[...Array(20000)].map((_,i)=>({identity:identity(i),category:'按钮'}));
    const large=await f.request('/v1/samples','POST',{projectId:'g2',samples});
    assert.equal(large.status,200);
    assert.deepEqual(await large.json(),{schemaVersion:1,count:20000});
    assert.equal(JSON.parse(await readFile(samplesPath(f.data,'g2'),'utf8')).samples.length,20000);
    // 超过 4 MiB 的样本请求明确拒绝，而不是静默截断。
    const oversized=await f.request('/v1/samples','POST',{projectId:'g2',samples:[
      {identity:identity(0),category:'x'.repeat(4*1024*1024)}
    ]});
    assert.equal(oversized.status,413);
    // 其他写接口仍保持 64 KiB 上限。
    assert.equal((await f.request('/v1/projects','PUT',{bad:'x'.repeat(66000)})).status,413);
  }finally{await f.cleanup();}
});
