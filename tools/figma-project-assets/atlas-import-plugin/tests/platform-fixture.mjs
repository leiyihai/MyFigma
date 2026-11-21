export function figmaFixture() {
  let root;
  let nodeSequence=0,pageSequence=0,instanceSequence=0;
  const images=[];
  const storage=new Map();
  const removeFromParent=node=>{
    if(node.parent&&Array.isArray(node.parent.children))node.parent.children=node.parent.children.filter(child=>child!==node);
  };
  const pluginData=node=>({
    getPluginData(k){return this.data[k]||'';},
    setPluginData(k,v){this.data[k]=v;}
  });
  const appendChild=node=>child=>{
    // Real appendChild moves a node between parents; keep the old parent consistent.
    removeFromParent(child);
    node.children=node.children.filter(c=>c!==child);
    Object.defineProperty(child,'parent',{value:node,writable:true,configurable:true,enumerable:false});
    node.children.push(child);
  };
  function pageNode() {
    const page={
      id:'page-'+(++pageSequence),name:'Page '+pageSequence,children:[],data:{},type:'PAGE',
      ...pluginData(),
      async loadAsync(){this.loadCount=(this.loadCount||0)+1;},
      appendChild(child){appendChild(this)(child);},
      findAll(predicate){
        const out=[];
        const walk=nodes=>{for(const node of nodes){out.push(node);if(Array.isArray(node.children))walk(node.children);}};
        walk(this.children);
        return out.filter(predicate);
      },
      remove(){if(root)root.children=root.children.filter(child=>child!==page);}
    };
    return page;
  }
  const makeInstance=component=>{
    const instance={
      type:'INSTANCE',id:'instance-'+(++instanceSequence),name:component.name,children:[],data:{},fills:[],
      ...pluginData(),
      resize(w,h){this.width=w;this.height=h;},
      appendChild(child){appendChild(instance)(child);},
      async getMainComponentAsync(){return component;},
      remove(){removeFromParent(instance);}
    };
    instance.width=component.width||0;
    instance.height=component.height||0;
    return instance;
  };
  const page=pageNode();
  root={type:'DOCUMENT',children:[page]};
  const api={
    currentPage:page,
    root,
    clientStorage:{async getAsync(k){return storage.get(k);},async setAsync(k,v){storage.set(k,v);},async deleteAsync(k){storage.delete(k);}},
    base64Decode:s=>Uint8Array.from(Buffer.from(s,'base64')),
    createImage(bytes){images.push(bytes);return {hash:'image-'+images.length};},
    createPage(){const created=pageNode();root.children.push(created);return created;},
    createFrame(){
      const n={type:'FRAME',name:'Frame',children:[],data:{},fills:[],
        ...pluginData(),
        resize(w,h){this.width=w;this.height=h;},
        appendChild(child){appendChild(n)(child);},
        remove(){removeFromParent(n);}
      };
      page.appendChild(n);return n;
    },
    createComponent(){
      const n={type:'COMPONENT',id:'component-'+(++nodeSequence),name:'Component',children:[],data:{},fills:[],layoutMode:'NONE',
        ...pluginData(),
        resize(w,h){this.width=w;this.height=h;},
        appendChild(child){appendChild(n)(child);},
        createInstance(){return makeInstance(n);},
        remove(){removeFromParent(n);}
      };
      return n;
    },
    createRectangle(){
      const n={type:'RECTANGLE',name:'Rectangle',children:[],data:{},fills:[],locked:false,constraints:{horizontal:'MIN',vertical:'MIN'},
        ...pluginData(),
        resize(w,h){this.width=w;this.height=h;},
        appendChild(child){appendChild(n)(child);},
        remove(){removeFromParent(n);}
      };
      return n;
    }
  };
  return {api,page,root,images,storage};
}
