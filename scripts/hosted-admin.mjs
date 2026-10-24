import { parseEnv } from 'node:util';
import { readFile, mkdir, stat } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { DatabaseSync, backup } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { HostedAuthStore } from '../apps/gateway/src/hosted-auth.ts';
import { QuotaStore } from '../apps/gateway/src/store.ts';

const env = { ...process.env };
try { for (const [key, value] of Object.entries(parseEnv(await readFile(resolve('.env'), 'utf8')))) env[key] ??= value; }
catch (error) { if (error.code !== 'ENOENT') throw error; }
const [command, ...args] = process.argv.slice(2);
if (!['invite', 'users', 'disable', 'enable', 'restore-lockdown', 'revoke-all', 'ledger', 'reconcile', 'backup'].includes(command)) {
  console.error('Usage: node scripts/hosted-admin.mjs invite [hours=24] [uses=1] | users | disable/enable <user-id> | restore-lockdown | revoke-all | ledger [limit] | reconcile --request ID --amount CNY | backup <new-private-file.sqlite>');
  process.exit(2);
}
const databasePath = env.GATEWAY_DATABASE_PATH || '.local/gateway.sqlite';
const store = new HostedAuthStore(databasePath);
try {
  if (command === 'invite') {
    const hours = Number(args[0] || 24), uses = Number(args[1] || 1);
    if (!Number.isFinite(hours) || hours <= 0 || hours > 720 || args.length > 2) throw new Error('hours must be 0–720; uses must be 1–100.');
    const result = store.createInvite({ expiresAt: Date.now() + Math.ceil(hours * 3600000), maxUses: uses });
    console.log('Invitation (private; displayed once): ' + result.invite);
    console.log('Expires: ' + result.expiresAt);
  } else if (command === 'users') {
    if (args.length) throw new Error('users takes no arguments.');
    console.log(JSON.stringify(store.listUsers(), null, 2));
  } else if (command === 'disable') {
    if (args.length !== 1) throw new Error('disable requires the exact user ID.');
    if (!store.disableUser(args[0])) throw new Error('User not found.');
    console.log('Account disabled; all sessions revoked.');
  } else if (command === 'revoke-all') {
    if (args.length) throw new Error('revoke-all takes no arguments.');
    console.log('Revoked sessions: ' + store.revokeAll());
  } else if (command === 'restore-lockdown') {
    if (args.length) throw new Error('restore-lockdown takes no arguments.');
    console.log(JSON.stringify(store.restoreLockdown(), null, 2));
    console.log('All restored accounts are disabled. Review independent revocation records, then enable only verified user IDs and issue new invitations.');
  } else if (command === 'enable') {
    if (args.length !== 1 || !store.enableUser(args[0])) throw new Error('enable requires one reviewed exact user ID.');
    console.log('Reviewed account enabled; prior sessions and expired invitations remain invalid.');
  } else if (command === 'backup') {
    if (args.length !== 1 || databasePath === ':memory:') throw new Error('backup requires a new private output path and a persistent source database.');
    const target = resolve(args[0]);
    if (target === resolve(databasePath)) throw new Error('Backup cannot overwrite the source database.');
    try { await stat(target); throw new Error('Backup destination already exists; choose a new path.'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    await mkdir(dirname(target), { recursive: true });
    const source = new DatabaseSync(databasePath);
    try { await backup(source, target); } finally { source.close(); }
    console.log('Consistent metadata backup created: ' + target);
    console.log('SHA256: ' + createHash('sha256').update(await readFile(target)).digest('hex'));
    console.log('After any restore, run restore-lockdown before reopening public access; old backups can revive sessions, invitations and accounts.');
  } else {
    const ledger = new QuotaStore(databasePath);
    try {
      if (command === 'ledger') {
        if (args.length > 1) throw new Error('ledger takes at most one limit.');
        console.log(JSON.stringify(ledger.ledgerEntries(Number(args[0] || 100)), null, 2));
      } else {
        if (args.length !== 4 || args[0] !== '--request' || args[2] !== '--amount' || args[3].trim() === '') throw new Error('reconcile --request ID --amount CNY; use only an amount checked against the supplier bill.');
        console.log(JSON.stringify(ledger.reconcile(args[1], Number(args[3])), null, 2));
      }
    } finally { ledger.close(); }
  }
} catch (error) { console.error(error.message || 'Admin command failed.'); process.exitCode = 1; }
finally { store.close(); }
