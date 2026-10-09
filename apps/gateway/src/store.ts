import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { GatewayError } from './types.ts';
import type { GatewayConfig } from './config.ts';

interface ReservationRow {
  request_id: string;
  fingerprint: string;
  state: string;
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
  }

  reserve(input: { requestKey: string; requestId: string; installationHash: string; fingerprint: string; now: number }, config: GatewayConfig): { existing: boolean; requestId: string; state: string } {
    const parts = new Intl.DateTimeFormat('en-CA', { timeZone: config.timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(input.now);
    const part = (type: string) => parts.find(value => value.type === type)!.value;
    const month = `${part('year')}-${part('month')}`;
    const day = `${month}-${part('day')}`;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const existing = this.db.prepare('SELECT request_id, fingerprint, state FROM reservations WHERE request_key = ?').get(input.requestKey) as ReservationRow | undefined;
      if (existing) {
        if (existing.fingerprint !== input.fingerprint) throw new GatewayError('IDEMPOTENCY_CONFLICT', '同一请求标识的选区或来源版本发生变化，请生成新请求。', 409);
        this.db.exec('COMMIT');
        return { existing: true, requestId: existing.request_id, state: existing.state };
      }
      const count = (sql: string, ...params: string[]) => (this.db.prepare(sql).get(...params) as { count: number }).count;
      if (count('SELECT COUNT(*) AS count FROM reservations WHERE installation_hash = ? AND day = ?', input.installationHash, day) >= config.installationDailyLimit) {
        throw new GatewayError('INSTALLATION_QUOTA_EXCEEDED', '今日识别额度已用完，仍可继续书写和编辑。', 429);
      }
      if (count('SELECT COUNT(*) AS count FROM reservations WHERE day = ?', day) >= config.globalDailyLimit) {
        throw new GatewayError('GLOBAL_DAILY_QUOTA_EXCEEDED', '服务今日识别额度已用完，仍可继续书写和编辑。', 429);
      }
      if (count('SELECT COUNT(*) AS count FROM reservations WHERE month = ?', month) >= config.globalMonthlyLimit) {
        throw new GatewayError('GLOBAL_MONTHLY_QUOTA_EXCEEDED', '服务本月识别额度已用完，仍可继续书写和编辑。', 429);
      }
      this.db.prepare('INSERT INTO reservations (request_key, request_id, installation_hash, fingerprint, day, month, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(input.requestKey, input.requestId, input.installationHash, input.fingerprint, day, month, input.now);
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

  close() { this.db.close(); }
}
