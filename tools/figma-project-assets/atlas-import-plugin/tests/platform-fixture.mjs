export function figmaFixture() {
  const page={id:'page-1',name:'Page 1',children:[],data:{},getPluginData(k){return this.data[k]||'';},setPluginData(k,v){this.data[k]=v;},appendChild(n){this.children=this.children.filter(c=>c!==n);this.children.push(n);}};
  const images=[];
  const storage=new Map();
  const api={
    currentPage:page,
    clientStorage:{async getAsync(k){return storage.get(k);},async setAsync(k,v){storage.set(k,v);},async deleteAsync(k){storage.delete(k);}},
    base64Decode:s=>Uint8Array.from(Buffer.from(s,'base64')),
    createImage(bytes){images.push(bytes);return {hash:'image-'+images.length};},
    createFrame(){const n={children:[],resize(w,h){this.width=w;this.height=h;},appendChild(c){this.children.push(c);},remove(){page.children=page.children.filter(c=>c!==n);}};page.children.push(n);return n;},
    createComponent(){return {data:{},resize(w,h){this.width=w;this.height=h;},setPluginData(k,v){this.data[k]=v;}};}
  };
  return {api,page,images,storage};
}
