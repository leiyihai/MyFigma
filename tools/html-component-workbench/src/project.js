(() => {
  function createProject() {
    return {format:'html-component-workbench',formatVersion:1,id:crypto.randomUUID(),name:'未命名项目',prototype:null,drafts:[],groups:[],references:[],mappings:[],reviews:[]};
  }
  window.WorkbenchProject = {create:createProject};
})();
