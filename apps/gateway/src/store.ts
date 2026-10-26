import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { GatewayError } from './types.ts';
import type { GatewayConfig } from './config.ts';
import type { RecognitionQuota, RecognitionTaskResponse, QuotaWindow, TaskCost, TokenUsage, TaskType, ProviderName, TaskResponse } from './types.ts';

export interface RecognitionTaskMetadata extends Omit<RecognitionTaskResponse, 'status' | 'result' | 'error'> {
  requestKey: string;
  state: 'pending' | 'ok' | 'error';
  errorCode?: string;
}

export interface BudgetReservation { principalHash: string; amountCny: number; provider: ProviderName; model?: string; operation: string; deadlineMs: number }

interface ReservationRow {
  request_id: string;
  fingerprint: string;
  state: string;
}

function periods(now: number, timeZone: string) {
  const formatter = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' });
  const keys = (time: number) => {
    const parts = formatter.formatToParts(time);
    const part = (type: string) => parts.find(value => value.type === type)!.value;
    const month = `${part('year')}-${part('month')}`;
    return { month, day: `${month}-${part('day')}` };
  };
  const current = keys(now);
  // Find the actual local calendar boundary, including DST and non-hour offsets.
  const reset = (period: 'day' | 'month') => {
    let low = Math.floor(now);
    let high = low + (period === 'day' ? 36 * 60 * 60 * 1000 : 35 * 24 * 60 * 60 * 1000);
    while (high - low > 1) {
      const middle = Math.floor((low + high) / 2);
      if (keys(middle)[period] === current[period]) low = middle;
      else high = middle;
    }
    return new Date(high).toISOString();
  };
  return { ...current, reset };
}

export class QuotaStore {
  private readonly db: DatabaseSync;

  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS reservations (
        request_key TEXT PRIMARY KEY,
        request_id TEXT NOT NULL,
        installation_hash TEXT NOT NULL,
        fingerprint TEXT NOT NULL,
        day TEXT NOT NULL,
        month TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        state TEXT NOT NULL DEFAULT 'pending'
      );
      CREATE INDEX IF NOT EXISTS reservations_day ON reservations(day);
      CREATE INDEX IF NOT EXISTS reservations_month ON reservations(month);
      CREATE INDEX IF NOT EXISTS reservations_installation_day ON reservations(installation_hash, day);
      CREATE TABLE IF NOT EXISTS ai_ledger (
        request_key TEXT PRIMARY KEY, principal_hash TEXT NOT NULL, provider TEXT NOT NULL, model TEXT,
        operation TEXT NOT NULL, day TEXT NOT NULL, month TEXT NOT NULL, created_at INTEGER NOT NULL,
        active_until INTEGER NOT NULL, reserved_micros INTEGER NOT NULL, settled_micros INTEGER,
        state TEXT NOT NULL DEFAULT 'pending', input_tokens INTEGER, output_tokens INTEGER,
        cache_hit_tokens INTEGER, cache_miss_tokens INTEGER, reasoning_tokens INTEGER, price_date TEXT
      );
      CREATE INDEX IF NOT EXISTS ai_ledger_principal ON ai_ledger(principal_hash, day, month);
      CREATE TABLE IF NOT EXISTS ai_reconciliations (
        id INTEGER PRIMARY KEY, request_key TEXT NOT NULL, previous_micros INTEGER,
        actual_micros INTEGER NOT NULL, reconciled_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS ai_tasks (
        task_id TEXT PRIMARY KEY, request_key TEXT UNIQUE NOT NULL, principal_hash TEXT NOT NULL,
        type TEXT NOT NULL, provider TEXT NOT NULL, model TEXT, source_revision INTEGER NOT NULL,
        content_revision INTEGER NOT NULL, state TEXT NOT NULL, created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL, error_code TEXT
      );
      CREATE TABLE IF NOT EXISTS recognition_tasks (
        task_id TEXT PRIMARY KEY, request_key TEXT UNIQUE NOT NULL, principal_hash TEXT NOT NULL,
        provider TEXT NOT NULL, model TEXT, simulated INTEGER NOT NULL, source_revision INTEGER NOT NULL,
        state TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, error_code TEXT
      );
    `);
    // Older requests cannot be classified from their hashed identifiers. Preserve
    // their accounting conservatively instead of clearing previous real usage.
    const columns = this.db.prepare('PRAGMA table_info(reservations)').all() as { name: string }[];
    if (!columns.some(column => column.name === 'quota_counted')) {
      this.db.exec('ALTER TABLE reservations ADD COLUMN quota_counted INTEGER NOT NULL DEFAULT 1');
    }
  }

  reserve(input: { requestKey: string; requestId: string; installationHash: string; fingerprint: string; now: number; countQuota?: boolean; budget?: BudgetReservation }, config: GatewayConfig): { existing: boolean; requestId: string; state: string } {
    const { month, day } = periods(input.now, config.timeZone);
    const countQuota = input.countQuota !== false;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const existing = this.db.prepare('SELECT request_id, fingerprint, state FROM reservations WHERE request_key = ?').get(input.requestKey) as ReservationRow | undefined;
      if (existing) {
        if (existing.fingerprint !== input.fingerprint) throw new GatewayError('IDEMPOTENCY_CONFLICT', '同一请求标识的选区或来源版本发生变化，请生成新请求。', 409);
        this.db.exec('COMMIT');
        return { existing: true, requestId: existing.request_id, state: existing.state };
      }
      if (countQuota) {
        const count = (sql: string, ...params: string[]) => (this.db.prepare(sql).get(...params) as { count: number }).count;
        if (count('SELECT COUNT(*) AS count FROM reservations WHERE quota_counted = 1 AND installation_hash = ? AND day = ?', input.installationHash, day) >= config.installationDailyLimit) {
          throw new GatewayError('INSTALLATION_QUOTA_EXCEEDED', `当前安装实例的本地服务每日运营额度（${config.installationDailyLimit} 次）已用完，并非云端供应商账户余额提示；仍可继续书写和编辑。`, 429);
        }
        if (count('SELECT COUNT(*) AS count FROM reservations WHERE quota_counted = 1 AND day = ?', day) >= config.globalDailyLimit) {
          throw new GatewayError('GLOBAL_DAILY_QUOTA_EXCEEDED', `本地服务所有用户共享的每日运营额度（${config.globalDailyLimit} 次）已用完，并非云端供应商账户余额提示；仍可继续书写和编辑。`, 429);
        }
        if (count('SELECT COUNT(*) AS count FROM reservations WHERE quota_counted = 1 AND month = ?', month) >= config.globalMonthlyLimit) {
          throw new GatewayError('GLOBAL_MONTHLY_QUOTA_EXCEEDED', `本地服务所有用户共享的每月运营额度（${config.globalMonthlyLimit} 次）已用完，并非云端供应商账户余额提示；仍可继续书写和编辑。`, 429);
        }
        if (config.authMode === 'hosted' && count('SELECT COUNT(*) AS count FROM reservations WHERE quota_counted = 1 AND installation_hash = ? AND month = ?', input.installationHash, month) >= config.userMonthlyLimit) throw new GatewayError('USER_MONTHLY_QUOTA_EXCEEDED', '账号本月调用次数已用完，仍可离线编辑和导出。', 429);
      }
      if (input.budget) {
        const budget = input.budget;
        const reserved = Math.ceil(budget.amountCny * 1_000_000);
        const query = (where: string, ...params: (string|number)[]) => this.db.prepare(`SELECT COUNT(*) AS count, COALESCE(SUM(COALESCE(settled_micros,reserved_micros)),0) AS money FROM ai_ledger WHERE ${where}`).get(...params) as { count:number; money:number };
        if (query("state='pending' AND active_until>? AND principal_hash=?", input.now,budget.principalHash).count >= config.userConcurrency || query("state='pending' AND active_until>?",input.now).count >= config.globalConcurrency) throw new GatewayError('CONCURRENCY_EXCEEDED','生成任务正在运行，请等待完成；本次未调用供应商。',429);
        if (query('created_at>? AND principal_hash=?',input.now-60000,budget.principalHash).count >= config.userRequestsPerMinute || query('created_at>?',input.now-60000).count >= config.globalRequestsPerMinute) throw new GatewayError('RATE_LIMITED','本分钟调用频率达到运营限制，请稍后手动提交。',429);
        for (const [where,params,limit] of [
          ['principal_hash=? AND day=?',[budget.principalHash,day],config.userDailyBudgetCny],
          ['principal_hash=? AND month=?',[budget.principalHash,month],config.userMonthlyBudgetCny],
          ['day=?',[day],config.globalDailyBudgetCny], ['month=?',[month],config.globalMonthlyBudgetCny],
        ] as [string,(string|number)[],number][]) if (query(where,...params).money + reserved > Math.floor(limit*1_000_000)) throw new GatewayError('BUDGET_EXCEEDED','账号或全服务的费用预算已达到上限；未知费用继续占用预留金额，仍可书写、保存和导出。',429);
        this.db.prepare('INSERT INTO ai_ledger (request_key,principal_hash,provider,model,operation,day,month,created_at,active_until,reserved_micros) VALUES (?,?,?,?,?,?,?,?,?,?)').run(input.requestKey,budget.principalHash,budget.provider,budget.model||null,budget.operation,day,month,input.now,input.now+budget.deadlineMs,reserved);
      }
      this.db.prepare('INSERT INTO reservations (request_key, request_id, installation_hash, fingerprint, day, month, created_at, quota_counted) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
        .run(input.requestKey, input.requestId, input.installationHash, input.fingerprint, day, month, input.now, countQuota ? 1 : 0);
      this.db.exec('COMMIT');
      return { existing: false, requestId: input.requestId, state: 'pending' };
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  complete(requestKey: string, state: 'ok' | 'error') {
    this.db.prepare('UPDATE reservations SET state = ? WHERE request_key = ?').run(state, requestKey);
  }

  settle(requestKey:string, usage:TokenUsage|undefined, cost:TaskCost) {
    this.db.prepare("UPDATE ai_ledger SET state=?,settled_micros=?,input_tokens=?,output_tokens=?,cache_hit_tokens=?,cache_miss_tokens=?,reasoning_tokens=?,price_date=? WHERE request_key=? AND state!='reconciled'").run(cost.status, cost.amount===null?null:Math.ceil(cost.amount*1_000_000),usage?.status==='unknown'?null:usage?.inputTokens??null,usage?.status==='unknown'?null:usage?.outputTokens??null,usage?.cacheHitTokens??null,usage?.cacheMissTokens??null,usage?.reasoningTokens??null,cost.priceDate,requestKey);
  }

  budgetUsage(principalHash:string, now:number, config:GatewayConfig) {
    const {day,month}=periods(now,config.timeZone);
    const totals=(where:string,...params:string[])=>{ const r=this.db.prepare(`SELECT COUNT(*) AS count, COALESCE(SUM(COALESCE(settled_micros,reserved_micros)),0) AS money, COALESCE(SUM(CASE WHEN settled_micros IS NULL THEN 1 ELSE 0 END),0) AS unknown FROM ai_ledger WHERE ${where}`).get(...params) as {count:number;money:number;unknown:number}; return {usedCny:r.money/1_000_000,unknownRequests:r.unknown,requests:r.count}; };
    return {currency:'CNY',priceConfigured:Boolean(config.priceConfig),priceDate:config.priceConfig?.date||null,userDaily:{limitCny:config.userDailyBudgetCny,...totals('principal_hash=? AND day=?',principalHash,day)},userMonthly:{limitCny:config.userMonthlyBudgetCny,...totals('principal_hash=? AND month=?',principalHash,month)},globalDaily:{limitCny:config.globalDailyBudgetCny,...totals('day=?',day)},globalMonthly:{limitCny:config.globalMonthlyBudgetCny,...totals('month=?',month)}};
  }

  ledgerEntries(limit=100) {
    if(!Number.isSafeInteger(limit)||limit<1||limit>1000)throw new GatewayError('INVALID_REQUEST','对账列表数量必须为 1–1000。');
    const rows=this.db.prepare('SELECT l.*,r.request_id,(SELECT COUNT(*) FROM ai_reconciliations a WHERE a.request_key=l.request_key) AS reconciliations FROM ai_ledger l JOIN reservations r ON l.request_key=r.request_key ORDER BY l.created_at DESC LIMIT ?').all(limit) as Record<string,any>[];
    return rows.map(r=>({requestId:r.request_id,principalHash:r.principal_hash,provider:r.provider,model:r.model,operation:r.operation,state:r.state,createdAt:new Date(r.created_at).toISOString(),reservedCny:r.reserved_micros/1_000_000,settledCny:r.settled_micros===null?null:r.settled_micros/1_000_000,priceDate:r.price_date,reconciliationCount:r.reconciliations,usage:r.input_tokens===null||r.output_tokens===null?{status:'unknown'}:{inputTokens:r.input_tokens,outputTokens:r.output_tokens,cacheHitTokens:r.cache_hit_tokens,cacheMissTokens:r.cache_miss_tokens,reasoningTokens:r.reasoning_tokens}}));
  }
  reconcile(requestId:string,actualCny:number,now=Date.now()) {
    if(typeof requestId!=='string'||!requestId||!Number.isFinite(actualCny)||actualCny<0||actualCny>1_000_000||!Number.isSafeInteger(now)||!Number.isFinite(new Date(now).getTime()))throw new GatewayError('INVALID_REQUEST','请提供请求 ID、供应商已核对实际金额和有效时间。');
    const micros=Math.round(actualCny*1_000_000);
    this.db.exec('BEGIN IMMEDIATE');
    try{
      const row=this.db.prepare('SELECT l.request_key,l.settled_micros,l.state,l.active_until FROM ai_ledger l JOIN reservations r ON l.request_key=r.request_key WHERE r.request_id=?').get(requestId) as {request_key:string;settled_micros:number|null;state:string;active_until:number}|undefined;
      if(!row)throw new GatewayError('BILLING_NOT_FOUND','未找到该请求的云端费用记录。',404);
      if(row.state==='pending'&&row.active_until>now)throw new GatewayError('BILLING_PENDING','请求仍可能正在执行，请等待截止时间后再对账。',409);
      if(row.state==='reconciled'&&row.settled_micros===micros){const previous=this.db.prepare('SELECT reconciled_at FROM ai_reconciliations WHERE request_key=? ORDER BY id DESC LIMIT 1').get(row.request_key) as {reconciled_at:number};this.db.exec('COMMIT');return {requestId,actualCny:micros/1_000_000,reconciledAt:new Date(previous.reconciled_at).toISOString()};}
      this.db.prepare('INSERT INTO ai_reconciliations (request_key,previous_micros,actual_micros,reconciled_at) VALUES (?,?,?,?)').run(row.request_key,row.settled_micros,micros,now);
      this.db.prepare("UPDATE ai_ledger SET settled_micros=?,state='reconciled',active_until=? WHERE request_key=?").run(micros,now,row.request_key);
      this.db.exec('COMMIT');return {requestId,actualCny:micros/1_000_000,reconciledAt:new Date(now).toISOString()};
    }catch(error){this.db.exec('ROLLBACK');throw error;}
  }

  createRecognitionTask(input: { taskId: string; requestKey: string; principalHash: string; provider: ProviderName; model?: string; simulated: boolean; sourceRevision: number; now: number }): void {
    // Original reservations remain authoritative; this also upgrades synchronous requests.
    this.db.prepare(`INSERT OR IGNORE INTO recognition_tasks
      (task_id,request_key,principal_hash,provider,model,simulated,source_revision,state,created_at,updated_at)
      SELECT request_id,request_key,installation_hash,?,?,?, ?,state,created_at,?
      FROM reservations WHERE request_key=? AND request_id=? AND installation_hash=?`)
      .run(input.provider,input.model||null,input.simulated?1:0,input.sourceRevision,input.now,input.requestKey,input.taskId,input.principalHash);
  }
  completeRecognitionTask(taskId: string, state: 'ok' | 'error', now: number, errorCode?: string): void {
    this.db.prepare('UPDATE recognition_tasks SET state=?,updated_at=?,error_code=? WHERE task_id=?').run(state,now,errorCode||null,taskId);
  }
  recognitionTask(id: string, principalHash: string, byRequestKey = false): RecognitionTaskMetadata | undefined {
    const row=this.db.prepare(`SELECT t.*,l.reserved_micros,l.settled_micros,l.price_date,l.input_tokens,l.output_tokens,l.cache_hit_tokens,l.cache_miss_tokens,l.reasoning_tokens
      FROM recognition_tasks t LEFT JOIN ai_ledger l ON l.request_key=t.request_key
      WHERE t.${byRequestKey?'request_key':'task_id'}=? AND t.principal_hash=?`).get(id,principalHash) as Record<string,any>|undefined;
    if(!row)return;
    const usage:TokenUsage|undefined=row.reserved_micros===null||row.reserved_micros===undefined?undefined:
      row.input_tokens===null||row.output_tokens===null?{inputTokens:0,outputTokens:0,status:'unknown'}:
        {inputTokens:row.input_tokens,outputTokens:row.output_tokens,...(row.cache_hit_tokens!==null?{cacheHitTokens:row.cache_hit_tokens}:{}),...(row.cache_miss_tokens!==null?{cacheMissTokens:row.cache_miss_tokens}:{}),...(row.reasoning_tokens!==null?{reasoningTokens:row.reasoning_tokens}:{})};
    const cost:TaskCost|undefined=row.reserved_micros===null||row.reserved_micros===undefined?undefined:
      {status:row.settled_micros===null?'unknown':'estimated',currency:'CNY',amount:row.settled_micros===null?null:row.settled_micros/1_000_000,priceDate:row.price_date||null,reserved:row.reserved_micros/1_000_000};
    return {taskId:row.task_id,requestKey:row.request_key,type:'formula-transcribe',provider:row.provider,model:row.model,simulated:!!row.simulated,state:row.state,sourceRevision:row.source_revision,createdAt:new Date(row.created_at).toISOString(),updatedAt:new Date(row.updated_at).toISOString(),...(row.error_code?{errorCode:row.error_code}:{}),...(usage?{usage}:{}),...(cost?{cost}:{})};
  }

  createTask(task:TaskResponse,requestKey:string,principalHash:string) {
    this.db.prepare('INSERT INTO ai_tasks (task_id,request_key,principal_hash,type,provider,model,source_revision,content_revision,state,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)').run(task.taskId,requestKey,principalHash,task.type,task.provider,task.model,task.sourceRevision,task.contentRevision,task.status,Date.parse(task.createdAt),Date.parse(task.updatedAt));
  }
  updateTask(taskId:string,state:TaskResponse['status'],now:number,errorCode?:string) { this.db.prepare('UPDATE ai_tasks SET state=?,updated_at=?,error_code=? WHERE task_id=?').run(state,now,errorCode||null,taskId); }
  taskIdByRequestKey(requestKey:string,principalHash:string):string|undefined {
    return (this.db.prepare('SELECT task_id FROM ai_tasks WHERE request_key=? AND principal_hash=?').get(requestKey,principalHash) as {task_id:string}|undefined)?.task_id;
  }
  taskMetadata(taskId:string,principalHash:string):TaskResponse|undefined {
    const row=this.db.prepare('SELECT t.*,l.reserved_micros,l.settled_micros,l.price_date,l.input_tokens,l.output_tokens,l.cache_hit_tokens,l.cache_miss_tokens,l.reasoning_tokens FROM ai_tasks t LEFT JOIN ai_ledger l ON l.request_key=t.request_key WHERE t.task_id=? AND t.principal_hash=?').get(taskId,principalHash) as Record<string,any>|undefined;
    if(!row)return;
    // Bodies stay in memory only. Neither server restart nor cache expiry is permission to pay again.
    const usage:TokenUsage=row.input_tokens===null||row.input_tokens===undefined||row.output_tokens===null?{inputTokens:0,outputTokens:0,status:'unknown'}:{inputTokens:row.input_tokens,outputTokens:row.output_tokens,...(row.cache_hit_tokens!==null?{cacheHitTokens:row.cache_hit_tokens}:{}),...(row.cache_miss_tokens!==null?{cacheMissTokens:row.cache_miss_tokens}:{}),...(row.reasoning_tokens!==null?{reasoningTokens:row.reasoning_tokens}:{})};
    return {taskId:row.task_id,type:row.type as TaskType,provider:row.provider as ProviderName,model:row.model,status:'result-unavailable',sourceRevision:row.source_revision,contentRevision:row.content_revision,createdAt:new Date(row.created_at).toISOString(),updatedAt:new Date(row.updated_at).toISOString(),steps:[{id:'generate',status:'error'}],usage,cost:{status:row.settled_micros===null||row.settled_micros===undefined?'unknown':'estimated',currency:'CNY',amount:row.settled_micros===null||row.settled_micros===undefined?null:row.settled_micros/1_000_000,priceDate:row.price_date||null,reserved:(row.reserved_micros||0)/1_000_000},error:{code:'TASK_RESULT_UNAVAILABLE',message:'该任务已提交，但当前服务没有结果正文（可能重启或缓存过期）。不会自动重复生成；请核对设备中已保存草稿后，明确新建任务，云端可能再次计费。',retryable:false}};
  }

  usage(installationHash: string, now: number, config: GatewayConfig, enforced = true): RecognitionQuota {
    if (!enforced) {
      const unlimited = (): QuotaWindow => ({ limit: null, used: 0, remaining: null, resetsAt: null });
      return { enforced: false, source: 'local-service', installationDaily: unlimited(), globalDaily: unlimited(), globalMonthly: unlimited() };
    }
    const { day, month, reset } = periods(now, config.timeZone);
    // One read gives a consistent snapshot while another gateway reserves quota.
    const counts = this.db.prepare(`SELECT
      COALESCE(SUM(CASE WHEN installation_hash = ? AND day = ? THEN 1 ELSE 0 END), 0) AS installationDaily,
      COALESCE(SUM(CASE WHEN day = ? THEN 1 ELSE 0 END), 0) AS globalDaily,
      COALESCE(SUM(CASE WHEN month = ? THEN 1 ELSE 0 END), 0) AS globalMonthly
      FROM reservations WHERE quota_counted = 1`).get(installationHash, day, day, month) as { installationDaily: number; globalDaily: number; globalMonthly: number };
    const dailyReset = reset('day');
    const window = (limit: number, used: number, resetsAt: string): QuotaWindow => ({ limit, used, remaining: Math.max(0, limit - used), resetsAt });
    return {
      enforced: true, source: 'local-service',
      installationDaily: window(config.installationDailyLimit, counts.installationDaily, dailyReset),
      globalDaily: window(config.globalDailyLimit, counts.globalDaily, dailyReset),
      globalMonthly: window(config.globalMonthlyLimit, counts.globalMonthly, reset('month')),
      ...(config.authMode==='hosted'?{subject:'account' as const,userMonthly:window(config.userMonthlyLimit,(this.db.prepare('SELECT COUNT(*) AS count FROM reservations WHERE quota_counted=1 AND installation_hash=? AND month=?').get(installationHash,month) as {count:number}).count,reset('month'))}:{}),
    };
  }

  close() { this.db.close(); }
}
