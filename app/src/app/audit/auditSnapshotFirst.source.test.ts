import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const source = readFileSync(new URL('page.tsx', import.meta.url), 'utf8');

test('Audit renders session and entry snapshots before server revalidation', () => {
  assert.match(source, /readAuditSessionsState\(\)/);
  assert.match(source, /readAuditEntriesState\(/);
  assert.match(source, /revalidateAuditSessions\(\)/);
  assert.match(source, /revalidateAuditEntries\(/);
});

test('Audit async commits are fenced by operator epoch', () => {
  assert.match(source, /getOperatorSessionEpoch\(\)/);
  assert.match(source, /isOperatorSessionEpochCurrent\(operatorSessionEpoch\)/);
});
