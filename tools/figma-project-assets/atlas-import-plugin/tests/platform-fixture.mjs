export function figmaFixture() {
  const page={
    id:'page-1',name:'Page 1',children:[],data:{},type:'PAGE',
    getPluginData(k){return this.data[k]||'';},setPluginData(k,v){this.data[k]=v;},
    async loadAsync(){this.loadCount=(this.loadCount||0)+1;},
    appendChild(n){this.children=this.children.filter(c=>c!==n);Object.defineProperty(n,'parent',{value:this,writable:true,configurable:true,enumerable:false});this.children.push(n);},
    findAll(predicate){
      const out=[];
      const walk=nodes=>{for(const node of nodes){out.push(node);if(Array.isArray(node.children))walk(node.children);}};
      walk(this.children);
      return out.filter(predicate);
    }
  };
  const images=[];
  const storage=new Map();
  let nodeSequence=0;
  const removeFromParent=node=>{
    if(node.parent&&Array.isArray(node.parent.children))node.parent.children=node.parent.children.filter(child=>child!==node);
  };
  const api={
    currentPage:page,
    clientStorage:{async getAsync(k){return storage.get(k);},async setAsync(k,v){storage.set(k,v);},async deleteAsync(k){storage.delete(k);}},
    base64Decode:s=>Uint8Array.from(Buffer.from(s,'base64')),
    createImage(bytes){images.push(bytes);return {hash:'image-'+images.length};},
    createFrame(){
      const n={type:'FRAME',name:'Frame',children:[],data:{},fills:[],
        getPluginData(k){return this.data[k]||'';},setPluginData(k,v){this.data[k]=v;},
        resize(w,h){this.width=w;this.height=h;},
        appendChild(c){this.children=this.children.filter(child=>child!==c);Object.defineProperty(c,'parent',{value:this,writable:true,configurable:true,enumerable:false});this.children.push(c);},
        remove(){removeFromParent(n);}
      };
      page.appendChild(n);return n;
    },
    createComponent(){
      const n={type:'COMPONENT',id:'component-'+(++nodeSequence),name:'Component',children:[],data:{},fills:[],layoutMode:'NONE',
        getPluginData(k){return this.data[k]||'';},setPluginData(k,v){this.data[k]=v;},
        resize(w,h){this.width=w;this.height=h;},
        appendChild(c){this.children=this.children.filter(child=>child!==c);Object.defineProperty(c,'parent',{value:this,writable:true,configurable:true,enumerable:false});this.children.push(c);},
        remove(){removeFromParent(n);}
      };
      return n;
    },
    createRectangle(){
      const n={type:'RECTANGLE',name:'Rectangle',children:[],data:{},fills:[],locked:false,constraints:{horizontal:'MIN',vertical:'MIN'},
        getPluginData(k){return this.data[k]||'';},setPluginData(k,v){this.data[k]=v;},
        resize(w,h){this.width=w;this.height=h;},
        appendChild(c){this.children=this.children.filter(child=>child!==c);Object.defineProperty(c,'parent',{value:this,writable:true,configurable:true,enumerable:false});this.children.push(c);},
        remove(){removeFromParent(n);}
      };
      return n;
    }
  };
  return {api,page,images,storage};
}
