import {createFigmaPlatform} from './platform';
import type {PublicProject,Scan} from './api';
figma.showUI(__html__,{width:520,height:720,themeColors:true});
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
figma.ui.onmessage=async(message:{type:string;requestId:number;project:PublicProject;scan:Scan;pairing?:Pairing})=>{
  if(!message || !Number.isInteger(message.requestId))return;
  const reply=(result:unknown,error?:string)=>figma.ui.postMessage({type:'result',requestId:message.requestId,result,error});
  try {
    if(message.type==='validate')reply(await platform.validate(message.project));
    else if(message.type==='preview')reply(await platform.preview(message.scan));
    else if(message.type==='import') {const plan=await platform.importResources(message.scan,progress=>figma.ui.postMessage({type:'progress',progress}));reply(plan);}
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
