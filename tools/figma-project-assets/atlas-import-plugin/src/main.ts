import {createFigmaPlatform} from './platform';
import {Cancellation} from './api';
import type {PublicProject,Scan} from './api';
import type {CategoryName} from './category';
figma.showUI(__html__,{width:440,height:540,themeColors:true});
const platform=createFigmaPlatform(figma);
const pairingKey='atlas.pairing.v1';
type Pairing={schemaVersion:1;address:string;token:string};
function validPairing(value:unknown):value is Pairing {
  if(!value || typeof value!=='object')return false;
  const pairing=value as Partial<Pairing>;
  return pairing.schemaVersion===1 && typeof pairing.address==='string'
    && /^http:\/\/(?:localhost|127\.0\.0\.1):\d{1,5}$/.test(pairing.address)
    && typeof pairing.token==='string' && /^[a-f0-9]{64}$/.test(pairing.token);
}
let active: Cancellation | undefined;
figma.ui.onmessage=async(message:{type:string;requestId:number;project:PublicProject;scan:Scan;pairing?:Pairing;ids?:string[];category?:CategoryName|'auto'})=>{
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
    else reply(null,'未知插件任务');
  } catch(error) {reply(null,error instanceof Error?error.message:'Figma 任务失败');}
};
figma.on('currentpagechange',()=>figma.ui.postMessage({type:'page-changed'}));
figma.on('selectionchange',()=>figma.ui.postMessage({type:'selection-changed'}));
