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
    assert.equal(scan.schemaVersion,2);
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
