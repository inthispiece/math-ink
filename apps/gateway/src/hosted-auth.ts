import { randomBytes, randomUUID, scrypt, timingSafeEqual, createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { GatewayError } from './types.ts';

export interface AuthUser { id: string; username: string }
export interface AuthSession { status: 'ok'; sessionToken: string; expiresAt: string; user: AuthUser }
interface UserRow { id: string; username: string; password_hash: string; disabled: number }
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const denied = () => new GatewayError('AUTH_REQUIRED', '账号或会话无效，请重新登录。', 401);
function usernameOf(value: string) {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9._@-]{3,80}$/.test(value)) throw new GatewayError('AUTH_INVALID_INPUT', '账号需为 3–80 位字母、数字或 . _ @ -。');
  return value.toLowerCase();
}
function passwordOf(value: string) {
  if (typeof value !== 'string' || value.length < 12 || value.length > 256 || Buffer.byteLength(value) > 1024) throw new GatewayError('AUTH_INVALID_INPUT', '密码需为 12–256 个字符。');
  return value;
}
async function derive(password: string, salt: string) {
  return new Promise<Buffer>((resolve, reject) => scrypt(password, salt, 64, { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }, (error, key) => error ? reject(error) : resolve(key)));
}
async function passwordHash(password: string) {
  const salt = randomBytes(24).toString('hex');
  return salt + ':' + (await derive(password, salt)).toString('hex');
}
async function passwordMatches(password: string, stored?: string) {
  const [salt, digest] = (stored || 'missing-account-salt:').split(':');
  const calculated = await derive(password, salt);
  const expected = /^[0-9a-f]{128}$/.test(digest || '') ? Buffer.from(digest, 'hex') : Buffer.alloc(64);
  return timingSafeEqual(calculated, expected) && Boolean(stored);
}

/** Persistent identity metadata only. Never stores bearer tokens or invitation secrets. */
export class HostedAuthStore {
  private readonly db: DatabaseSync;
  private readonly ttl: number;
  private readonly failureLimit: number;
  private readonly windowMs: number;
  constructor(path: string, options: { sessionTtlMs?: number; maxFailures?: number; loginWindowMs?: number } = {}) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.ttl = options.sessionTtlMs ?? 7 * 24 * 60 * 60 * 1000;
    this.failureLimit = options.maxFailures ?? 6;
    this.windowMs = options.loginWindowMs ?? 15 * 60 * 1000;
    if (![this.ttl, this.failureLimit, this.windowMs].every(n => Number.isSafeInteger(n) && n > 0)) throw new Error('Invalid auth policy');
    this.db.exec('PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON;');
    this.db.exec([
      'CREATE TABLE IF NOT EXISTS auth_users(id TEXT PRIMARY KEY, username TEXT UNIQUE NOT NULL, password_hash TEXT NOT NULL, disabled INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL);',
      'CREATE TABLE IF NOT EXISTS auth_sessions(token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES auth_users(id), expires_at INTEGER NOT NULL, revoked_at INTEGER);',
      'CREATE TABLE IF NOT EXISTS auth_invites(id TEXT PRIMARY KEY, token_hash TEXT UNIQUE NOT NULL, expires_at INTEGER NOT NULL, max_uses INTEGER NOT NULL, uses INTEGER NOT NULL DEFAULT 0);',
      'CREATE TABLE IF NOT EXISTS auth_attempts(subject_hash TEXT PRIMARY KEY, window_start INTEGER NOT NULL, failures INTEGER NOT NULL);',
      'CREATE TABLE IF NOT EXISTS auth_recovery_events(id INTEGER PRIMARY KEY, locked_at INTEGER NOT NULL, users_disabled INTEGER NOT NULL, sessions_revoked INTEGER NOT NULL, invites_expired INTEGER NOT NULL);',
      'CREATE INDEX IF NOT EXISTS auth_sessions_user ON auth_sessions(user_id);',
    ].join('\n'));
  }
  private checkAttempts(key: string, now: number) {
    const row = this.db.prepare('SELECT window_start,failures FROM auth_attempts WHERE subject_hash=?').get(hash(key)) as { window_start: number; failures: number } | undefined;
    if (row && row.window_start + this.windowMs > now && row.failures >= this.failureLimit) throw new GatewayError('AUTH_RATE_LIMITED', '登录尝试过多，请稍后重试。', 429);
  }
  private failed(key: string, now: number) {
    this.db.prepare('INSERT INTO auth_attempts VALUES(?,?,1) ON CONFLICT(subject_hash) DO UPDATE SET failures=CASE WHEN window_start+?<=? THEN 1 ELSE failures+1 END, window_start=CASE WHEN window_start+?<=? THEN ? ELSE window_start END').run(hash(key), now, this.windowMs, now, this.windowMs, now, now);
  }
  private session(user: AuthUser, now: number): AuthSession {
    const sessionToken = randomBytes(48).toString('base64url');
    const expires = now + this.ttl;
    this.db.prepare('INSERT INTO auth_sessions VALUES(?,?,?,NULL)').run(hash(sessionToken), user.id, expires);
    return { status: 'ok', sessionToken, expiresAt: new Date(expires).toISOString(), user };
  }
  async createUser(username: string, password: string, now = Date.now()): Promise<AuthUser> {
    username = usernameOf(username); passwordOf(password);
    const stored = await passwordHash(password);
    const user = { id: randomUUID(), username };
    try { this.db.prepare('INSERT INTO auth_users VALUES(?,?,?,0,?)').run(user.id, username, stored, now); }
    catch (error) {
      if (this.db.prepare('SELECT id FROM auth_users WHERE username=?').get(username)) throw new GatewayError('AUTH_ACCOUNT_EXISTS', '该账号不可用，请选择其他账号。', 409);
      throw error;
    }
    return user;
  }
  createInvite(options: { expiresAt: number; maxUses?: number }, now = Date.now()) {
    const maxUses = options.maxUses ?? 1;
    if (!Number.isSafeInteger(options.expiresAt) || options.expiresAt <= now || options.expiresAt > now + 30 * 86400000 || !Number.isSafeInteger(maxUses) || maxUses < 1 || maxUses > 100) throw new GatewayError('AUTH_INVALID_INPUT', '邀请需在未来 30 天内过期，使用次数为 1–100。');
    const invite = randomBytes(32).toString('base64url'), id = randomUUID();
    this.db.prepare('INSERT INTO auth_invites VALUES(?,?,?,?,0)').run(id, hash(invite), options.expiresAt, maxUses);
    return { id, invite, expiresAt: new Date(options.expiresAt).toISOString() };
  }
  async register(username: string, password: string, invite: string, now = Date.now()): Promise<AuthSession> {
    username = usernameOf(username); passwordOf(password);
    const key = 'register:' + username; this.checkAttempts(key, now);
    if (typeof invite !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(invite)) { this.failed(key, now); throw new GatewayError('AUTH_INVITE_INVALID', '邀请码无效、已使用或过期。', 403); }
    const stored = await passwordHash(password);
    const user = { id: randomUUID(), username };
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const row = this.db.prepare('SELECT id FROM auth_invites WHERE token_hash=? AND expires_at>? AND uses<max_uses').get(hash(invite), now) as { id: string } | undefined;
      if (!row) throw new GatewayError('AUTH_INVITE_INVALID', '邀请码无效、已使用或过期。', 403);
      if (this.db.prepare('SELECT id FROM auth_users WHERE username=?').get(username)) throw new GatewayError('AUTH_ACCOUNT_EXISTS', '该账号不可用，请选择其他账号。', 409);
      this.db.prepare('INSERT INTO auth_users VALUES(?,?,?,0,?)').run(user.id, username, stored, now);
      this.db.prepare('UPDATE auth_invites SET uses=uses+1 WHERE id=?').run(row.id);
      const session = this.session(user, now);
      this.db.exec('COMMIT');
      this.db.prepare('DELETE FROM auth_attempts WHERE subject_hash=?').run(hash(key));
      return session;
    } catch (error) { this.db.exec('ROLLBACK'); this.failed(key, now); throw error; }
  }
  async login(username: string, password: string, now = Date.now()): Promise<AuthSession> {
    username = usernameOf(username); passwordOf(password);
    const key = 'login:' + username; this.checkAttempts(key, now);
    const user = this.db.prepare('SELECT * FROM auth_users WHERE username=?').get(username) as unknown as UserRow | undefined;
    if (!await passwordMatches(password, user?.password_hash) || !user || user.disabled) { this.failed(key, now); throw denied(); }
    this.db.prepare('DELETE FROM auth_attempts WHERE subject_hash=?').run(hash(key));
    return this.session({ id: user.id, username: user.username }, now);
  }
  private token(header: string) {
    const found = typeof header === 'string' ? /^Bearer ([A-Za-z0-9_-]{64})$/.exec(header) : null;
    if (!found) throw denied();
    return found[1];
  }
  authenticate(authorizationHeader: string, now = Date.now()): AuthUser {
    const token = this.token(authorizationHeader);
    const user = this.db.prepare('SELECT u.id,u.username FROM auth_sessions s JOIN auth_users u ON u.id=s.user_id WHERE s.token_hash=? AND s.revoked_at IS NULL AND s.expires_at>? AND u.disabled=0').get(hash(token), now) as unknown as AuthUser | undefined;
    if (!user) throw denied();
    return { id: user.id, username: user.username };
  }
  revoke(authorizationHeader: string, now = Date.now()) {
    const token = this.token(authorizationHeader);
    this.db.prepare('UPDATE auth_sessions SET revoked_at=? WHERE token_hash=? AND revoked_at IS NULL').run(now, hash(token));
  }
  listUsers() { return this.db.prepare('SELECT id,username,disabled,created_at FROM auth_users ORDER BY created_at').all(); }
  revokeAll(now = Date.now()) {
    return Number(this.db.prepare('UPDATE auth_sessions SET revoked_at=? WHERE revoked_at IS NULL').run(now).changes);
  }
  restoreLockdown(now = Date.now()) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const users = Number(this.db.prepare('UPDATE auth_users SET disabled=1 WHERE disabled=0').run().changes);
      const sessions = this.revokeAll(now);
      const invites = Number(this.db.prepare('UPDATE auth_invites SET expires_at=? WHERE expires_at>?').run(now, now).changes);
      this.db.prepare('INSERT INTO auth_recovery_events(locked_at,users_disabled,sessions_revoked,invites_expired) VALUES(?,?,?,?)').run(now,users,sessions,invites);
      this.db.exec('COMMIT'); return { usersDisabled: users, sessionsRevoked: sessions, invitesExpired: invites };
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  enableUser(id: string) {
    return Number(this.db.prepare('UPDATE auth_users SET disabled=0 WHERE id=?').run(id).changes) > 0;
  }
  disableUser(id: string, now = Date.now()) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = this.db.prepare('UPDATE auth_users SET disabled=1 WHERE id=?').run(id);
      this.db.prepare('UPDATE auth_sessions SET revoked_at=? WHERE user_id=? AND revoked_at IS NULL').run(now, id);
      this.db.exec('COMMIT'); return Number(result.changes) > 0;
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  close() { this.db.close(); }
}
