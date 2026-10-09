export interface ButterflyDocument { data: number[]; revision: string; page: string }
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
  private readonly calls = new Map<string, { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  private readonly readyWaiters = new Set<{ after?: number; resolve: () => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  private readonly options: SessionOptions;
  constructor(options: SessionOptions) { this.options = options; }
  get ready(): boolean { return this.phase === 'ready'; }
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

  private async readDocument(): Promise<ButterflyDocument> {
    const value = await this.request('getDocument', {}) as ButterflyDocument;
    if (!value || !Array.isArray(value.data) || !value.data.length || !value.data.every(byte => Number.isInteger(byte) && byte >= 0 && byte <= 255) || typeof value.revision !== 'string' || typeof value.page !== 'string') throw new Error('Butterfly 未返回有效原稿，已有备份保持完整');
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
    if (this.closed) return;
    this.initialized = true; this.changePhase('ready');
  }
  save(changed = true): Promise<void> {
    if (!this.ready) return Promise.reject(new Error('原稿正在恢复，尚不能读取或覆盖本地备份'));
    const task = this.saveQueue.catch(() => {}).then(async () => {
      const document = await this.readDocument();
      await this.options.persist(document, changed);
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
