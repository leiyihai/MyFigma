import {createFigmaPlatform} from './platform';
import {Cancellation} from './api';
import type {PublicProject,Scan} from './api';
figma.showUI(__html__,{width:350,height:600,themeColors:true});
const platform=createFigmaPlatform(figma);
const pairingKey='atlas.pairing.v1';
const helperPathKey='resourceHelperPath.v1';
type Pairing={schemaVersion:1;address:string;token:string};
function helperFolder(value:unknown):string {
  if(typeof value!=='string')return '';
  const path=value.trim();
  return path.length>0 && path.length<=1024 && !/[\x00-\x1f]/.test(path) ? path : '';
}
function helperFileUrl(path:string):string {
  const normalized=path.replace(/\\/g,'/').replace(/\/+$/,'');
  return 'file:///' + encodeURI(normalized) + '/';
}
function validPairing(value:unknown):value is Pairing {
  if(!value || typeof value!=='object')return false;
  const pairing=value as Partial<Pairing>;
  return pairing.schemaVersion===1 && typeof pairing.address==='string'
    && /^http:\/\/(?:localhost|127\.0\.0\.1):\d{1,5}$/.test(pairing.address)
    && typeof pairing.token==='string' && /^[a-f0-9]{64}$/.test(pairing.token);
}
let active: Cancellation | undefined;
figma.ui.onmessage=async(message:{type:string;requestId:number;project:PublicProject;scan:Scan;pairing?:Pairing;ids?:string[];category?:string;path?:string})=>{
  if(!message)return;
  // Cancellation is a control message, not a task reply; it may arrive while import is running.
  if(message.type==='cancel') {active?.cancel(); if(Number.isInteger(message.requestId)) figma.ui.postMessage({type:'result',requestId:message.requestId,result:true}); return;}
  if(!Number.isInteger(message.requestId))return;
  const reply=(result:unknown,error?:string)=>figma.ui.postMessage({type:'result',requestId:message.requestId,result,error});
  try {
    if(message.type==='validate')reply(await platform.validate(message.project));
    else if(message.type==='preview')reply(await platform.preview(message.scan));
    else if(message.type==='import') {
      const cancellation=new Cancellation();
      active=cancellation;
      try {const report=await platform.importResources(message.scan,progress=>figma.ui.postMessage({type:'progress',progress}),cancellation);reply(report);}
      finally {if(active===cancellation)active=undefined;}
    }
    else if(message.type==='compare')reply(await platform.compare(message.project));
    else if(message.type==='tidy')reply(await platform.tidy(message.project));
    else if(message.type==='selection')reply(await platform.selection(message.project));
    else if(message.type==='categories')reply(await platform.categories());
    else if(message.type==='training-samples')reply(await platform.trainingSamples(message.project));
    else if(message.type==='set-category') {
      if(!Array.isArray(message.ids) || !message.category) throw new Error('分类参数无效');
      reply(await platform.setCategory(message.project,message.ids,message.category));
    }
    else if(message.type==='pairing-load') {
      const stored=await figma.clientStorage.getAsync(pairingKey);
      reply(validPairing(stored)?stored:null);
    }
    else if(message.type==='pairing-save') {
      if(!validPairing(message.pairing))throw new Error('配对信息无效');
      await figma.clientStorage.setAsync(pairingKey,message.pairing);
      reply(true);
    }
    else if(message.type==='pairing-clear') {
      await figma.clientStorage.deleteAsync(pairingKey);
      reply(true);
    }
    else if(message.type==='helper-path-load') {
      const stored=await figma.clientStorage.getAsync(helperPathKey);
      reply(typeof stored==='string'?stored:'');
    }
    else if(message.type==='helper-path-save') {
      const raw=typeof message.path==='string'?message.path.trim():'';
      const path=raw?helperFolder(raw):'';
      if(raw&&!path)throw new Error('资源助手文件夹路径无效');
      await figma.clientStorage.setAsync(helperPathKey,path);
      reply(path);
    }
    else if(message.type==='open-helper-folder') {
      const path=helperFolder(message.path);
      if(!path)throw new Error('资源助手文件夹路径无效');
      if(typeof figma.openExternal!=='function')throw new Error('当前环境不支持打开文件夹，请手动打开：'+path);
      figma.openExternal(helperFileUrl(path));
      reply(true);
    }
    else reply(null,'未知插件任务');
  } catch(error) {reply(null,error instanceof Error?error.message:'Figma 任务失败');}
};
figma.on('currentpagechange',()=>figma.ui.postMessage({type:'page-changed'}));
figma.on('selectionchange',()=>figma.ui.postMessage({type:'selection-changed'}));
