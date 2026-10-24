import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join, sep } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { HostedAuthStore } from '../src/hosted-auth.ts';

const password = 'test-only-long-password!';
const header = (token: string) => 'Bearer ' + token;
function fixture(t: test.TestContext, options = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'mathink-auth-'));
  const path = join(dir, 'auth.sqlite');
  let store = new HostedAuthStore(path, options);
  t.after(() => {
    store.close();
    assert.ok(resolve(dir).startsWith(resolve(tmpdir()) + sep) && dir.includes('mathink-auth-'));
    rmSync(dir, { recursive: true, force: true });
  });
  return { get store() { return store; }, path, restart() { store.close(); store = new HostedAuthStore(path, options); } };
}

test('hosted identities survive restart; revocation and expiry invalidate only their own sessions', async t => {
  const f = fixture(t, { sessionTtlMs: 10000 });
  const a = await f.store.createUser('Alice', password, 1000);
  const b = await f.store.createUser('Bob', password, 1000);
  const s1 = await f.store.login('alice', password, 1100);
  const s2 = await f.store.login('bob', password, 1100);
  f.restart();
  assert.deepEqual(f.store.authenticate(header(s1.sessionToken), 1200), a);
  f.store.revoke(header(s1.sessionToken), 1300);
  assert.throws(() => f.store.authenticate(header(s1.sessionToken), 1400), /会话无效/);
  assert.deepEqual(f.store.authenticate(header(s2.sessionToken), 1400), b);
  assert.throws(() => f.store.authenticate(header(s2.sessionToken), 11100), /会话无效/);
  assert.throws(() => f.store.authenticate('shared-pairing-token', 1200), /会话无效/);
});

test('one invitation is consumed atomically across simultaneous registration requests', async t => {
  const f = fixture(t);
  const invite = f.store.createInvite({ expiresAt: 100000 }, 1000);
  const results = await Promise.allSettled([
    f.store.register('student-one', password, invite.invite, 2000),
    f.store.register('student-two', password, invite.invite, 2000),
  ]);
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  assert.equal(f.store.listUsers().length, 1);
  await assert.rejects(f.store.register('student-three', password, invite.invite, 3000), /邀请码无效/);
});

test('expired invitations and failed duplicate registrations never consume another invitation', async t => {
  const f = fixture(t);
  await f.store.createUser('existing', password, 1000);
  const expired = f.store.createInvite({ expiresAt: 2000 }, 1000);
  await assert.rejects(f.store.register('late-user', password, expired.invite, 2001), /过期/);
  const invite = f.store.createInvite({ expiresAt: 10000 }, 1000);
  await assert.rejects(f.store.register('existing', password, invite.invite, 2000), /账号不可用/);
  const result = await f.store.register('new-student', password, invite.invite, 2000);
  assert.equal(result.user.username, 'new-student');
});

test('passwords, session secrets and invitation secrets are hashed in durable metadata', async t => {
  const f = fixture(t);
  await f.store.createUser('researcher', password);
  const session = await f.store.login('researcher', password);
  const invite = f.store.createInvite({ expiresAt: Date.now() + 60000 });
  const db = new DatabaseSync(f.path);
  try {
    const users = JSON.stringify(db.prepare('SELECT * FROM auth_users').all());
    const sessions = JSON.stringify(db.prepare('SELECT * FROM auth_sessions').all());
    const invites = JSON.stringify(db.prepare('SELECT * FROM auth_invites').all());
    assert.equal(users.includes(password), false);
    assert.equal(sessions.includes(session.sessionToken), false);
    assert.equal(invites.includes(invite.invite), false);
    assert.match(users, /[a-f0-9]{48}:[a-f0-9]{128}/);
  } finally { db.close(); }
});

test('failed login throttling persists through restart and expires after its window', async t => {
  const f = fixture(t, { maxFailures: 2, loginWindowMs: 10000 });
  await f.store.createUser('student', password, 0);
  await assert.rejects(f.store.login('student', password + 'wrong', 1000), /账号或会话无效/);
  f.restart();
  await assert.rejects(f.store.login('student', password + 'wrong', 1100), /账号或会话无效/);
  await assert.rejects(f.store.login('student', password, 1200), /尝试过多/);
  const result = await f.store.login('student', password, 11001);
  assert.equal(result.user.username, 'student');
});

test('disabling an account revokes every session and prevents further login', async t => {
  const f = fixture(t);
  const user = await f.store.createUser('removed-user', password);
  const session = await f.store.login('removed-user', password);
  assert.equal(f.store.disableUser(user.id), true);
  assert.throws(() => f.store.authenticate(header(session.sessionToken)), /会话无效/);
  await assert.rejects(f.store.login('removed-user', password), /会话无效/);
  assert.equal(f.store.disableUser('missing'), false);
});

test('restoration lockdown invalidates old invitations and accounts until individually reviewed', async t => {
  const f=fixture(t);
  const approved=await f.store.createUser('approved',password);
  await f.store.createUser('previously-banned',password);
  const session=await f.store.login('approved',password);
  const oldInvite=f.store.createInvite({expiresAt:Date.now()+60000});
  const result=f.store.restoreLockdown();
  assert.equal(result.usersDisabled,2);
  assert.equal(result.sessionsRevoked,1);
  assert.equal(result.invitesExpired,1);
  assert.throws(()=>f.store.authenticate(header(session.sessionToken)),/会话无效/);
  await assert.rejects(f.store.register('new-visitor',password,oldInvite.invite),/邀请码无效/);
  await assert.rejects(f.store.login('previously-banned',password),/会话无效/);
  assert.equal(f.store.enableUser(approved.id),true);
  assert.equal((await f.store.login('approved',password)).user.id,approved.id);
  assert.throws(()=>f.store.authenticate(header(session.sessionToken)),/会话无效/);
  await assert.rejects(f.store.login('previously-banned',password),/会话无效/);
});
