import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { GatewayError } from './types.ts';
import type { GatewayConfig } from './config.ts';
import type { RecognitionQuota, QuotaWindow } from './types.ts';

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
    `);
    // Older requests cannot be classified from their hashed identifiers. Preserve
    // their accounting conservatively instead of clearing previous real usage.
    const columns = this.db.prepare('PRAGMA table_info(reservations)').all() as { name: string }[];
    if (!columns.some(column => column.name === 'quota_counted')) {
      this.db.exec('ALTER TABLE reservations ADD COLUMN quota_counted INTEGER NOT NULL DEFAULT 1');
    }
  }

  reserve(input: { requestKey: string; requestId: string; installationHash: string; fingerprint: string; now: number; countQuota?: boolean }, config: GatewayConfig): { existing: boolean; requestId: string; state: string } {
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
          throw new GatewayError('INSTALLATION_QUOTA_EXCEEDED', `当前安装实例的本地服务每日运营额度（${config.installationDailyLimit} 次）已用完，并非 Mathpix 账户余额不足；仍可继续书写和编辑。`, 429);
        }
        if (count('SELECT COUNT(*) AS count FROM reservations WHERE quota_counted = 1 AND day = ?', day) >= config.globalDailyLimit) {
          throw new GatewayError('GLOBAL_DAILY_QUOTA_EXCEEDED', `本地服务所有用户共享的每日运营额度（${config.globalDailyLimit} 次）已用完，并非 Mathpix 账户余额不足；仍可继续书写和编辑。`, 429);
        }
        if (count('SELECT COUNT(*) AS count FROM reservations WHERE quota_counted = 1 AND month = ?', month) >= config.globalMonthlyLimit) {
          throw new GatewayError('GLOBAL_MONTHLY_QUOTA_EXCEEDED', `本地服务所有用户共享的每月运营额度（${config.globalMonthlyLimit} 次）已用完，并非 Mathpix 账户余额不足；仍可继续书写和编辑。`, 429);
        }
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
    };
  }

  close() { this.db.close(); }
}
