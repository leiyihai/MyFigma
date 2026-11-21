export interface Project { id: string; name: string; path: string; maintained: boolean }
export interface PublicProject { id: string; name: string }
export interface Source {
  schemaVersion: 1; projectId: string; kind: 'atlas'; relativePath: string; frameName: string;
  identity: string; engineReference: string; sourceSize: {w: number; h: number};
  crop: {x: number; y: number; w: number; h: number}; offset: {x: number; y: number};
}
export interface Resource { width: number; height: number; png: string; source: Source }
export interface Scan {
  schemaVersion: 1; project: PublicProject; resources: Resource[]; errors: string[];
  summary: {atlases: number; sprites: number; errors: number; skippedDirectories: number}; complete: boolean;
}
export interface PageStatus { valid: boolean; message: string }
export interface Progress { done: number; total: number }
export interface Platform {
  validate(project: PublicProject): Promise<PageStatus>;
  importResources(scan: Scan, progress: (value: Progress) => void): Promise<void>;
}

class HelperConnectionError extends Error {}
export class HelperClient {
  constructor(private base: string, private token: string) {
    if (!/^http:\/\/(?:localhost|127\.0\.0\.1):\d{1,5}$/.test(base)) throw new Error('仅允许本机 localhost 或 127.0.0.1 HTTP 助手');
    if (!/^[a-f0-9]{64}$/.test(token)) throw new Error('请输入本机 token 文件中的 64 位配对令牌');
  }
  private async request<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
    let response: Response;
    try {
      response = await fetch(this.base + path, {method, headers: {
        Authorization: 'Bearer ' + this.token, ...(body === undefined ? {} : {'Content-Type':'application/json'})
      }, body: body === undefined ? undefined : JSON.stringify(body), cache:'no-store', credentials:'omit', redirect:'error',
      signal: AbortSignal.timeout(30000)});
    } catch { throw new HelperConnectionError('助手未连接：请启动 figma-assets-helper，检查浏览器本地网络权限后重新连接'); }
    if (response.status === 401) throw new HelperConnectionError('配对失败：请从本机 token 文件重新复制令牌');
    if (!response.ok) {
      const error = await response.json().catch(() => ({}));
      throw new Error(typeof error.error === 'string' ? error.error : '助手请求失败');
    }
    const value = await response.json();
    if (value.schemaVersion !== 1) throw new Error('助手协议版本不兼容');
    return value as T;
  }
  async health(): Promise<void> { await this.request('/v1/health'); }
  async projects(): Promise<Project[]> { return (await this.request<{projects:Project[]}>('/v1/projects')).projects; }
  async saveProject(project: Project): Promise<Project[]> { return (await this.request<{projects:Project[]}>('/v1/projects','PUT',project)).projects; }
  async deleteProject(id: string): Promise<Project[]> { return (await this.request<{projects:Project[]}>('/v1/projects/'+encodeURIComponent(id),'DELETE')).projects; }
  scan(projectId: string): Promise<Scan> { return this.request('/v1/scan','POST',{projectId}); }
}
export interface State {
  connected: boolean; busy: boolean; phase: string; error: string;
  selected?: PublicProject; page?: PageStatus; scan?: Scan; progress: Progress;
}
export class Workflow {
  readonly state: State = {connected:false,busy:false,phase:'未连接',error:'',progress:{done:0,total:0}};
  private projects: Project[] = [];
  constructor(private helper: HelperClient, private platform: Platform, private changed: () => void = () => {}) {}
  searchProjects(query: string): Project[] {
    const q = query.trim().toLocaleLowerCase();
    return this.projects.filter(p => q ? (p.name.toLocaleLowerCase().includes(q) || p.id.toLocaleLowerCase().includes(q)) : p.maintained);
  }
  allProjects(): readonly Project[] { return this.projects; }
  private async task(phase: string, work: () => Promise<void>): Promise<void> {
    if (this.state.busy) throw new Error('任务执行中，请等待完成');
    this.state.busy = true; this.state.phase = phase; this.state.error = ''; this.changed();
    try { await work(); this.state.phase = '就绪'; }
    catch (error) { if(error instanceof HelperConnectionError) {this.state.connected=false;this.state.scan=undefined;} this.state.error = error instanceof Error ? error.message : '任务失败'; this.state.phase = '失败'; throw error; }
    finally { this.state.busy = false; this.changed(); }
  }
  async connect(): Promise<void> {
    await this.task('连接中',async () => {
      this.state.connected = false; this.state.scan = undefined;
      await this.helper.health(); this.projects = await this.helper.projects(); this.state.connected = true;
    });
  }
  async saveProject(project: Project): Promise<void> {
    await this.task('保存登记',async () => {
      this.projects = await this.helper.saveProject(project); this.state.scan = undefined;
      if(this.state.selected?.id === project.id) {
        this.state.selected = {id:project.id,name:project.name};
        this.state.page = await this.platform.validate(this.state.selected);
      }
    });
  }
  async deleteProject(id: string): Promise<void> {
    await this.task('删除登记',async () => {
      this.projects = await this.helper.deleteProject(id);
      if (this.state.selected?.id === id) {this.state.selected = undefined; this.state.scan = undefined; this.state.page = undefined;}
    });
  }
  async selectProject(id: string): Promise<void> {
    await this.task('页面校验',async () => {
      if(!id) {this.state.selected=undefined;this.state.scan=undefined;this.state.page=undefined;this.state.progress={done:0,total:0};return;}
      const project = this.projects.find(p=>p.id===id);
      if (!project) throw new Error('请选择已登记的游戏');
      this.state.selected = {id:project.id,name:project.name}; this.state.scan = undefined; this.state.progress = {done:0,total:0};
      this.state.page = await this.platform.validate(this.state.selected);
    });
  }
  async validatePage(): Promise<void> {
    await this.task('页面校验',async () => {if (this.state.selected) this.state.page = await this.platform.validate(this.state.selected);});
  }
  async scan(): Promise<void> {
    await this.task('扫描中',async () => {
      if(!this.state.selected || !this.state.connected) throw new Error('请连接助手并选择游戏');
      this.state.scan = undefined;
      this.state.page = await this.platform.validate(this.state.selected);
      if(!this.state.page.valid) throw new Error(this.state.page.message);
      this.state.scan = await this.helper.scan(this.state.selected.id);
      this.state.progress = {done:0,total:this.state.scan.resources.length};
    });
  }
  async import(): Promise<void> {
    await this.task('导入中',async () => {
      const scan = this.state.scan;
      if(!scan || !scan.resources.length || scan.project.id !== this.state.selected?.id) throw new Error('请先扫描当前游戏');
      this.state.page = await this.platform.validate(scan.project);
      if(!this.state.page.valid) throw new Error(this.state.page.message);
      try {await this.platform.importResources(scan,progress=>{this.state.progress=progress;this.changed();});}
      catch(error) {this.state.progress={done:0,total:scan.resources.length};throw error;}
      this.state.scan = undefined;
      this.state.page = await this.platform.validate(scan.project);
    });
  }
}
export { createFigmaPlatform } from './platform';
