import {createFigmaPlatform} from './platform';
import type {PublicProject,Scan} from './api';
figma.showUI(__html__,{width:440,height:680,themeColors:true});
const platform=createFigmaPlatform(figma);
figma.ui.onmessage=async(message:{type:string;requestId:number;project:PublicProject;scan:Scan})=>{
  if(!message || !Number.isInteger(message.requestId))return;
  const reply=(result:unknown,error?:string)=>figma.ui.postMessage({type:'result',requestId:message.requestId,result,error});
  try {
    if(message.type==='validate')reply(await platform.validate(message.project));
    else if(message.type==='import') {await platform.importResources(message.scan,progress=>figma.ui.postMessage({type:'progress',progress}));reply(null);}
    else reply(null,'未知插件任务');
  } catch(error) {reply(null,error instanceof Error?error.message:'Figma 任务失败');}
};
figma.on('currentpagechange',()=>figma.ui.postMessage({type:'page-changed'}));
