import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

const source = readFileSync(join(process.cwd(), 'src/app/(desktop)/components/OperatorAuthGate.tsx'), 'utf8');
const cleanupSource = readFileSync(join(process.cwd(), 'src/lib/appSessionCleanup.ts'), 'utf8');
const auditLogSource = readFileSync(join(process.cwd(), 'src/lib/auditLog.ts'), 'utf8');

test('same-user auth verification stays non-blocking while operator boundaries clear caches', () => {
  assert.match(source, /resolveOperatorAuthSessionAction\(/);
  assert.match(source, /handleAuthSession\('BOOTSTRAP', data\.session\)/);
  assert.match(source, /createOperatorVerificationSingleFlight/);
  assert.match(source, /if \(options\.blocking\) setStatus\('checking'\);/);
  assert.doesNotMatch(source, /supabase\.auth\.refreshSession\(/);
  assert.match(source, /clearOperatorScopedMemoryCaches\(\)/);
  assert.match(source, /refreshIdRef\.current \+= 1;[\s\S]*operatorVerification\.clear\(\);[\s\S]*listener\.subscription\.unsubscribe\(\)/);
});

test('operator cleanup advances the epoch before clearing all shared state', () => {
  const cleanup = cleanupSource.slice(cleanupSource.indexOf('export function clearOperatorScopedMemoryCaches'));
  assert.match(cleanup, /advanceOperatorSessionEpochAndClearRegisteredCaches\(\);[\s\S]*clearSeasonDataCache\(\);[\s\S]*resetSeasonWorkspaceStore\(\);[\s\S]*resetAuditSessionId\(\);/);
  assert.match(auditLogSource, /export function resetAuditSessionId\(\): void/);
  assert.match(auditLogSource, /sessionStorage\?\.removeItem\(AUDIT_SESSION_STORAGE_KEY\)/);
});
