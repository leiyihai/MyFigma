export interface Project { id: string; name: string; path: string; maintained: boolean }
export interface PublicProject { id: string; name: string }
export interface Source {
  schemaVersion: 1; projectId: string; kind: 'atlas' | 'standalone'; relativePath: string; frameName: string;
  identity: string; engineReference: string; sourceSize: {w: number; h: number};
  crop: {x: number; y: number; w: number; h: number}; offset: {x: number; y: number};
}
export interface Margins { left: number; top: number; right: number; bottom: number }
export interface LayoutUsage {
  references: number;
  nineSlice?: { margins: Margins; usage: number };
}
export interface Resource { width: number; height: number; png: string; source: Source; layout?: LayoutUsage }
export interface ScanSummary {
  scanRoot: string; atlases: number; atlasFrames: number; sprites: number; standalone: number;
  resources: number; errors: number; skippedLinks: number; entries: number;
  layoutFiles?: number; layoutReferences?: number; layoutNineSlice?: number;
  layoutIgnored?: number; layoutInvalid?: number;
}
export interface Scan {
  schemaVersion: 3; project: PublicProject; resources: Resource[]; errors: string[]; warnings?: string[];
  summary: ScanSummary; truncated: boolean; complete: boolean;
}
export interface PageStatus { valid: boolean; message: string }
export interface Progress { done: number; total: number }
export interface ImportPlan {
  schemaVersion: 1; added: number; updated: number; removed: number; unchanged: number; blocked: number;
  removalSuppressed: boolean; messages: string[];
}
export interface CompareResult {
  schemaVersion: 1; pageName: string; created: boolean; groups: number;
  added: number; removed: number; kept: number; messages: string[];
}
export interface ItemFailure { name: string; reason: string }
// Import is not one atomic transaction: every item commits or is isolated and
// reported, so a later incremental run can fill only what is still missing.
export interface ImportReport extends ImportPlan {
  applied: { added: number; updated: number; removed: number };
  failures: ItemFailure[];
  cancelled: boolean;
}
export class CancelledTask extends Error {
  constructor() { super('任务已取消'); this.name = 'CancelledTask'; }
}
// Cancellable task boundary shared by the UI task entry and the Figma platform.
export class Cancellation {
  private listeners = new Set<() => void>();
  cancelled = false;
  cancel(): void {
    if(this.cancelled) return;
    this.cancelled = true;
    const listeners = [...this.listeners]; this.listeners.clear();
    for(const listener of listeners) listener();
  }
  onCancel(listener: () => void): () => void {
    if(this.cancelled) { listener(); return () => {}; }
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }
  throwIfCancelled(): void { if(this.cancelled) throw new CancelledTask(); }
}
export interface Platform {
  validate(project: PublicProject): Promise<PageStatus>;
  preview(scan: Scan): Promise<ImportPlan>;
  importResources(scan: Scan, progress: (value: Progress) => void, cancellation?: Cancellation): Promise<ImportReport>;
  compare(project: PublicProject): Promise<CompareResult>;
}

class HelperConnectionError extends Error {}
export class HelperAuthError extends HelperConnectionError {}
export class HelperClient {
  constructor(private base: string, private token: string) {
    if (!/^http:\/\/(?:localhost|127\.0\.0\.1):\d{1,5}$/.test(base)) throw new Error('仅允许本机 localhost 或 127.0.0.1 HTTP 助手');
    if (!/^[a-f0-9]{64}$/.test(token)) throw new Error('请输入本机 token 文件中的 64 位配对令牌');
  }
  private async request<T>(path: string, method = 'GET', body?: unknown, version = 1, signal?: AbortSignal): Promise<T> {
    let response: Response;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30000);
    const abort = () => controller.abort();
    if(signal) { if(signal.aborted) controller.abort(); else signal.addEventListener('abort', abort, {once:true}); }
    try {
      response = await fetch(this.base + path, {method, headers: {
        Authorization: 'Bearer ' + this.token, ...(body === undefined ? {} : {'Content-Type':'application/json'})
      }, body: body === undefined ? undefined : JSON.stringify(body), cache:'no-store', credentials:'omit', redirect:'error',
      signal: controller.signal});
    } catch {
      if(signal?.aborted) throw new CancelledTask();
      throw new HelperConnectionError('助手未连接：请启动 figma-assets-helper，并确认任务栏托盘图标显示「资源助手运行中」；已启动时请检查浏览器的本地网络权限后点击「连接助手」重新连接');
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
    }
    if (response.status === 401) throw new HelperAuthError('配对失败：请从本机 token 文件重新复制令牌');
    if (!response.ok) {
      const error = await response.json().catch(() => ({}));
      throw new Error(typeof error.error === 'string' ? error.error : '助手请求失败');
    }
    const value = await response.json();
    if (value.schemaVersion !== version) throw new Error('助手协议版本不兼容');
    return value as T;
  }
  async health(): Promise<void> { await this.request('/v1/health'); }
  async projects(): Promise<Project[]> { return (await this.request<{projects:Project[]}>('/v1/projects')).projects; }
  async saveProject(project: Project): Promise<Project[]> { return (await this.request<{projects:Project[]}>('/v1/projects','PUT',project)).projects; }
  async deleteProject(id: string): Promise<Project[]> { return (await this.request<{projects:Project[]}>('/v1/projects/'+encodeURIComponent(id),'DELETE')).projects; }
  scan(projectId: string, signal?: AbortSignal): Promise<Scan> { return this.request('/v1/scan','POST',{projectId},3,signal); }
}
export interface State {
  connected: boolean; busy: boolean; phase: string; error: string;
  selected?: PublicProject; page?: PageStatus; scan?: Scan; plan?: ImportPlan; result?: ImportReport; compare?: CompareResult; progress: Progress;
}
export class Workflow {
  readonly state: State = {connected:false,busy:false,phase:'未连接',error:'',progress:{done:0,total:0}};
  private projects: Project[] = [];
  private cancellation: Cancellation | undefined;
  constructor(private helper: HelperClient, private platform: Platform, private changed: () => void = () => {}) {}
  searchProjects(query: string): Project[] {
    const q = query.trim().toLocaleLowerCase();
    return this.projects.filter(p => q ? (p.name.toLocaleLowerCase().includes(q) || p.id.toLocaleLowerCase().includes(q)) : p.maintained);
  }
  allProjects(): readonly Project[] { return this.projects; }
  // Cooperative cancellation for the running scan or import only.
  cancel(): void {
    const cancellation = this.cancellation;
    if(!cancellation || cancellation.cancelled) return;
    cancellation.cancel();
    if(this.state.busy) { this.state.phase = '取消中'; this.changed(); }
  }
  private async task(phase: string, work: (cancellation: Cancellation) => Promise<string | void>): Promise<void> {
    if (this.state.busy) throw new Error('任务执行中，请等待完成');
    const cancellation = new Cancellation();
    this.cancellation = cancellation;
    this.state.busy = true; this.state.phase = phase; this.state.error = ''; this.changed();
    try { this.state.phase = await work(cancellation) || '就绪'; }
    catch (error) {
      if(error instanceof CancelledTask || cancellation.cancelled) { this.state.phase = '已取消'; this.state.error = ''; }
      else {
        if(error instanceof HelperConnectionError) {this.state.connected=false;this.state.scan=undefined;}
        this.state.error = error instanceof Error ? error.message : '任务失败'; this.state.phase = '失败'; throw error;
      }
    }
    finally { this.cancellation = undefined; this.state.busy = false; this.changed(); }
  }
  async connect(): Promise<void> {
    await this.task('连接中',async () => {
      this.state.connected = false; this.state.scan = undefined; this.state.plan = undefined; this.state.result = undefined; this.state.compare = undefined;
      await this.helper.health(); this.projects = await this.helper.projects(); this.state.connected = true;
    });
  }
  async saveProject(project: Project): Promise<void> {
    await this.task('保存登记',async () => {
      this.projects = await this.helper.saveProject(project); this.state.scan = undefined; this.state.plan = undefined; this.state.result = undefined; this.state.compare = undefined;
      if(this.state.selected?.id === project.id) {
        this.state.selected = {id:project.id,name:project.name};
        this.state.page = await this.platform.validate(this.state.selected);
      }
    });
  }
  async deleteProject(id: string): Promise<void> {
    await this.task('删除登记',async () => {
      this.projects = await this.helper.deleteProject(id);
      if (this.state.selected?.id === id) {this.state.selected = undefined; this.state.scan = undefined; this.state.plan = undefined; this.state.result = undefined; this.state.page = undefined; this.state.compare = undefined;}
    });
  }
  async selectProject(id: string): Promise<void> {
    await this.task('页面校验',async () => {
      this.state.compare = undefined;
      if(!id) {this.state.selected=undefined;this.state.scan=undefined;this.state.plan=undefined;this.state.result=undefined;this.state.page=undefined;this.state.progress={done:0,total:0};return;}
      const project = this.projects.find(p=>p.id===id);
      if (!project) throw new Error('请选择已登记的游戏');
      this.state.selected = {id:project.id,name:project.name}; this.state.scan = undefined; this.state.plan = undefined; this.state.result = undefined; this.state.compare = undefined; this.state.progress = {done:0,total:0};
      this.state.page = await this.platform.validate(this.state.selected);
    });
  }
  invalidateScan(): void {this.state.scan=undefined;this.state.plan=undefined;this.state.result=undefined;this.state.compare=undefined;this.state.progress={done:0,total:0};}
  async validatePage(): Promise<void> {
    await this.task('页面校验',async () => {if (this.state.selected) this.state.page = await this.platform.validate(this.state.selected);});
  }
  async scan(): Promise<void> {
    await this.task('扫描中',async cancellation => {
      if(!this.state.selected || !this.state.connected) throw new Error('请连接助手并选择游戏');
      this.state.scan = undefined; this.state.plan = undefined; this.state.result = undefined; this.state.progress = {done:0,total:0};
      this.state.page = await this.platform.validate(this.state.selected);
      if(!this.state.page.valid) throw new Error(this.state.page.message);
      const controller = new AbortController();
      const stop = cancellation.onCancel(() => controller.abort());
      let scan: Scan;
      try { scan = await this.helper.scan(this.state.selected.id, controller.signal); }
      finally { stop(); }
      cancellation.throwIfCancelled();
      const plan = await this.platform.preview(scan);
      cancellation.throwIfCancelled();
      this.state.scan = scan; this.state.plan = plan;
      this.state.progress = {done:0,total:scan.resources.length};
    });
  }
  async import(): Promise<void> {
    await this.task('导入中',async cancellation => {
      const scan = this.state.scan;
      if(!scan || scan.project.id !== this.state.selected?.id) throw new Error('请先扫描当前游戏');
      this.state.page = await this.platform.validate(scan.project);
      if(!this.state.page.valid) throw new Error(this.state.page.message);
      let report: ImportReport;
      try { report = await this.platform.importResources(scan,progress=>{this.state.progress=progress;this.changed();},cancellation); }
      catch(error) {
        const plan=this.state.plan;
        this.state.progress={done:0,total:plan ? plan.added+plan.updated+plan.removed : scan.resources.length};
        throw error;
      }
      this.state.result = report;
      this.state.plan = report;
      // The document is the source of truth; refresh the page status after a partial run too.
      this.state.page = await this.platform.validate(scan.project);
      if(report.cancelled) { this.state.error = ''; return '已取消'; }
      if(report.failures.length) {
        this.state.error = `${report.failures.length} 项未完成，可再次导入补齐：${report.failures.map(item=>item.name).join('、')}`;
        return '部分失败';
      }
      this.state.scan = undefined;
      return '就绪';
    });
  }
  // Optional and explicit: nothing in scan/import touch the comparison page.
  async comparePage(): Promise<void> {
    await this.task('生成对照页',async () => {
      const project = this.state.selected;
      if(!project) throw new Error('请选择游戏');
      this.state.compare = await this.platform.compare(project);
    });
  }
}
export { createFigmaPlatform } from './platform';
