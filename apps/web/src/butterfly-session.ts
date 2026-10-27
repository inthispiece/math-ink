export interface ButterflyView { x: number; y: number; zoom: number }
export interface ButterflyPage { id: string; name: string; title: string; index: number; paper: 'blank' | 'lined' | 'grid'; deleted: boolean; revision: string; pageRevision: string }
export interface ButterflyDirectory { pages: ButterflyPage[]; currentPage: string }
export interface ButterflyDocument { data: number[]; revision: string; page: string; pageRevision?: string; nativeName?: string; pages?: ButterflyPage[]; view?: ButterflyView }
export interface ButterflyCapabilities { pages: boolean; paper: boolean; view: boolean; tools: boolean; history: boolean; placement: boolean; fingerWriting: boolean; stablePageIds: boolean; operationIdempotency: boolean; selection: boolean; selectionTransform: boolean }
export interface ButterflyPendingMutation { method: string; result: unknown; affectedPageIds: string[] }
export class ButterflyPersistenceError extends Error {
  readonly executed = true;
  readonly method: string;
  readonly result: unknown;
  readonly affectedPageIds: string[];
  constructor(pending: ButterflyPendingMutation, cause: unknown) {
    super('原生操作已执行，但尚未保存：' + (cause instanceof Error ? cause.message : String(cause)) + '。请重试保存，原操作不会重复执行。', { cause });
    this.name = 'ButterflyPersistenceError'; this.method = pending.method; this.result = pending.result; this.affectedPageIds = [...pending.affectedPageIds];
  }
}
function pageDirectory(value: unknown): ButterflyDirectory {
  const directory=value as ButterflyDirectory;
  if (!directory || !Array.isArray(directory.pages) || !directory.pages.length ||
      typeof directory.currentPage !== 'string' ||
      new Set(directory.pages.map(page=>page?.id)).size !== directory.pages.length ||
      !directory.pages.every(page=>page && typeof page.id === 'string' && page.id.length > 0 &&
        typeof page.name === 'string' && typeof page.title === 'string' &&
        Number.isInteger(page.index) && page.index >= 0 &&
        ['blank','lined','grid'].includes(page.paper) && typeof page.deleted === 'boolean' &&
        typeof page.revision === 'string' && typeof page.pageRevision === 'string') ||
      !directory.pages.some(page=>page.id === directory.currentPage && !page.deleted)) {
    throw new Error('Butterfly 页面目录无效，已有页面未修改');
  }
  return directory;
}
export type ButterflyPhase = 'booting' | 'restoring' | 'ready' | 'failed' | 'closed';
type Packet = { type: 'mathink'; message: { requestId: string; method: string; payload: unknown } };
interface SessionOptions {
  newId: () => string;
  send: (packet: Packet) => void;
  initialData?: number[];
  persist: (document: ButterflyDocument, changed: boolean) => Promise<void>;
  onState: (phase: ButterflyPhase) => void;
  onError: (error: Error) => void;
  timeoutMs?: number;
}

export class LifecycleEpoch {
  private value = 0;
  begin(): number { return ++this.value; }
  current(epoch: number): boolean { return epoch === this.value; }
}

/** One controller belongs to one iframe and one captured note for its entire lifetime. */
export class ButterflySession {
  phase: ButterflyPhase = 'booting';
  private readyCount = 0;
  private initialized = false;
  private initializing?: Promise<void>;
  private saveQueue = Promise.resolve();
  private mutationQueue = Promise.resolve<unknown>(undefined);
  private lastSavedDocument?: ButterflyDocument;
  private executedMutation?: ButterflyPendingMutation;
  private historyInFlight?: { method: string; promise: Promise<unknown> };
  private persistenceRetry?: Promise<unknown>;
  private readonly calls = new Map<string, { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  private readonly readyWaiters = new Set<{ after?: number; resolve: () => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  private readonly options: SessionOptions;
  constructor(options: SessionOptions) { this.options = options; }
  get ready(): boolean { return this.phase === 'ready'; }
  get pendingMutation(): Readonly<ButterflyPendingMutation> | undefined { return this.executedMutation; }
  private get closed(): boolean { return this.phase === 'closed'; }

  request(method: string, payload: unknown): Promise<unknown> {
    if (this.phase === 'closed') return Promise.reject(new Error('原稿画布已切换，此请求已取消'));
    return new Promise((resolve, reject) => {
      const requestId = this.options.newId();
      const timer = setTimeout(() => { this.calls.delete(requestId); reject(new Error('Butterfly 桥接响应超时，原稿保留在当前画布中')); }, this.options.timeoutMs || 10000);
      this.calls.set(requestId, { resolve, reject, timer });
      try { this.options.send({ type: 'mathink', message: { requestId, method, payload } }); }
      catch (error) { clearTimeout(timer); this.calls.delete(requestId); reject(error); }
    });
  }

  receive(packet: unknown): void {
    if (!packet || typeof packet !== 'object' || this.phase === 'closed') return;
    const data = packet as { type?: string; message?: { version?: number; requestId?: string; ok?: boolean; result?: unknown; error?: string | { message?: string } } };
    if (data.type === 'mathink') {
      const message = data.message;
      const call = message?.requestId ? this.calls.get(message.requestId) : undefined;
      if (!call) return;
      clearTimeout(call.timer); this.calls.delete(message!.requestId!);
      if (message!.ok === false) call.reject(new Error(typeof message!.error === 'string' ? message!.error : message!.error?.message || 'Butterfly 操作失败'));
      else call.resolve(message!.result);
      return;
    }
    if (data.type === 'mathinkReady' && data.message?.version === 1) {
      this.readyCount++;
      this.notifyWaiters();
      if (!this.initializing && !this.initialized) {
        this.initializing = this.initialize().catch(error => {
          if (this.phase !== 'closed') { this.changePhase('failed'); this.rejectWaiters(error); this.options.onError(error); }
        });
      }
      return;
    }
    if (['change', 'save'].includes(data.type || '') && this.ready) void this.save().catch(error => this.options.onError(error));
  }

  private changePhase(phase: ButterflyPhase): void { this.phase = phase; this.options.onState(phase); this.notifyWaiters(); }
  private notifyWaiters(): void {
    for (const waiter of this.readyWaiters) {
      if (waiter.after !== undefined ? this.readyCount > waiter.after : this.ready) { clearTimeout(waiter.timer); this.readyWaiters.delete(waiter); waiter.resolve(); }
    }
  }
  private rejectWaiters(error: Error): void { for (const waiter of this.readyWaiters) { clearTimeout(waiter.timer); waiter.reject(error); } this.readyWaiters.clear(); }
  private waitReady(after?: number): Promise<void> {
    if (after !== undefined ? this.readyCount > after : this.ready) return Promise.resolve();
    if (['failed', 'closed'].includes(this.phase)) return Promise.reject(new Error('Butterfly 原稿尚未安全恢复，请重新加载画布'));
    return new Promise((resolve, reject) => {
      const waiter = { after, resolve, reject, timer: setTimeout(() => { this.readyWaiters.delete(waiter); reject(new Error('Butterfly 原稿重建未完成，请重新加载画布')); }, this.options.timeoutMs || 10000) };
      this.readyWaiters.add(waiter);
    });
  }
  whenReady(): Promise<void> { return this.waitReady(); }

  async capabilities(): Promise<ButterflyCapabilities> {
    await this.whenReady();
    const value = await this.request('getCapabilities', {}) as Partial<ButterflyCapabilities>;
    const keys = ['pages','paper','view','tools','history','placement','fingerWriting','stablePageIds','operationIdempotency','selection','selectionTransform'] as const;
    return Object.fromEntries(keys.map(key=>[key,value?.[key] === true])) as unknown as ButterflyCapabilities;
  }

  async listPages(): Promise<ButterflyDirectory> {
    await this.whenReady();
    return pageDirectory(await this.request('listPages', {}));
  }

  /** Host page commands are serialized with a completed durable save on both sides. */
  mutate<T = unknown>(method: string, payload: unknown, changed = true): Promise<T> {
    const history = method === 'undo' || method === 'redo';
    if (history && this.historyInFlight) {
      if (this.historyInFlight.method === method) return this.historyInFlight.promise as Promise<T>;
      return Promise.reject(new Error('原生历史操作正在保存，请稍候再撤销或重做。'));
    }
    const task = this.mutationQueue.catch(()=>{}).then(async()=>{
      await this.whenReady();
      if (this.executedMutation) {
        if (this.executedMutation.method === method) return (await this.retryPersistence<T>())!;
        throw new ButterflyPersistenceError(this.executedMutation, new Error('请先保存已执行的操作'));
      }
      await this.request('finishInput',{});
      await this.flush();
      const previous=this.lastSavedDocument;
      const result = await this.request(method,payload) as T;
      try { await this.save(changed); }
      catch(error) {
        if(method==='switchPage'&&previous){
          try { await this.request('switchPage',{page:previous.page,...(previous.view?{view:previous.view}:{})}); }
          catch { this.changePhase('failed'); this.options.onError(new Error('切页后保存与返回原页均失败，请导出当前原稿后重试。')); }
        }
        if(method!=='switchPage'){
          const record=result && typeof result==='object' ? result as {affectedPageIds?:unknown;page?:unknown} : {};
          const affected=Array.isArray(record.affectedPageIds)&&record.affectedPageIds.every(id=>typeof id==='string')?record.affectedPageIds as string[]:typeof record.page==='string'?[record.page]:[];
          this.executedMutation={method,result,affectedPageIds:[...affected]};
          throw new ButterflyPersistenceError(this.executedMutation,error);
        }
        throw error;
      }
      return result;
    });
    this.mutationQueue = task;
    if(history){
      this.historyInFlight={method,promise:task};
      const done=()=>{if(this.historyInFlight?.promise===task)this.historyInFlight=undefined;};
      void task.then(done,done);
    }
    return task;
  }

  /** Persist the current native state; never replay an already executed command. */
  retryPersistence<T=unknown>(): Promise<T|undefined> {
    if(this.persistenceRetry)return this.persistenceRetry as Promise<T|undefined>;
    const pending=this.executedMutation;
    if(!pending)return Promise.resolve(undefined);
    const task=this.flush().then(()=>pending.result as T);
    this.persistenceRetry=task;
    const done=()=>{if(this.persistenceRetry===task)this.persistenceRetry=undefined;};
    void task.then(done,done);
    return task;
  }

  /** Never leave the old page when its storage write failed. */
  switchPage(page: string, view?: ButterflyView): Promise<unknown> {
    return this.mutate('switchPage',{page,...(view?{view}:{})},false);
  }

  private async readDocument(): Promise<ButterflyDocument> {
    const value = await this.request('getDocument', {}) as ButterflyDocument;
    if (!value || !Array.isArray(value.data) || !value.data.length || !value.data.every(byte => Number.isInteger(byte) && byte >= 0 && byte <= 255) || typeof value.revision !== 'string' || typeof value.page !== 'string') throw new Error('Butterfly 未返回有效原稿，已有备份保持完整');
    if (value.pageRevision !== undefined && (typeof value.pageRevision !== 'string' || !/^[a-f0-9]{64}$/.test(value.pageRevision))) throw new Error('Butterfly 返回的完整页修订无效，未覆盖现有原稿。');
    if(value.pages!==undefined)pageDirectory({pages:value.pages,currentPage:value.page});
    if(value.view!==undefined&&(!Number.isFinite(value.view.x)||!Number.isFinite(value.view.y)||!Number.isFinite(value.view.zoom)||value.view.zoom<.1||value.view.zoom>10))throw new Error('Butterfly 返回的页面位置无效，未覆盖现有原稿。');
    return value;
  }
  private async initialize(): Promise<void> {
    this.changePhase('restoring');
    if (this.options.initialData?.length) {
      const readyBeforeReplace = this.readyCount;
      const accepted = await this.request('setDocument', { data: this.options.initialData }) as { accepted?: boolean };
      if (!accepted?.accepted) throw new Error('Butterfly 没有确认原稿恢复，已有备份保持完整');
      await this.waitReady(readyBeforeReplace);
    }
    const document = await this.readDocument();
    if (this.closed) return;
    await this.options.persist(document, false);
    this.lastSavedDocument=document;
    if (this.closed) return;
    this.initialized = true; this.changePhase('ready');
  }
  save(changed = true): Promise<void> {
    if (!this.ready) return Promise.reject(new Error('原稿正在恢复，尚不能读取或覆盖本地备份'));
    const task = this.saveQueue.catch(() => {}).then(async () => {
      const document = await this.readDocument();
      await this.options.persist(document, changed);
      this.lastSavedDocument=document;
      this.executedMutation=undefined;
    });
    this.saveQueue = task;
    return task;
  }
  async flush(): Promise<void> {
    // Before ready, input is disabled; the previous local backup is still authoritative.
    if (!this.initialized) return;
    await this.save();
  }
  dispose(): void {
    this.changePhase('closed');
    const error = new Error('原稿画布已切换，此请求已取消');
    for (const call of this.calls.values()) { clearTimeout(call.timer); call.reject(error); }
    this.calls.clear(); this.rejectWaiters(error);
  }
}
