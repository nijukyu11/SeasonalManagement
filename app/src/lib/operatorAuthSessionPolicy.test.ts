import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createOperatorVerificationSingleFlight,
  resolveOperatorAuthSessionAction,
} from './operatorAuthSessionPolicy.ts';

test('same-user auth events verify without blocking', () => {
  for (const event of ['TOKEN_REFRESHED', 'USER_UPDATED', 'SIGNED_IN', 'INITIAL_SESSION'] as const) {
    assert.deepEqual(resolveOperatorAuthSessionAction(event, 'user-1', 'user-1'), {
      kind: 'verify-operator', blocking: false,
    });
  }
});

test('bootstrap, changed user, and missing session block or sign out', () => {
  assert.deepEqual(resolveOperatorAuthSessionAction('BOOTSTRAP', 'user-1', null), { kind: 'verify-operator', blocking: true });
  assert.deepEqual(resolveOperatorAuthSessionAction('SIGNED_IN', 'user-2', 'user-1'), { kind: 'verify-operator', blocking: true });
  assert.deepEqual(resolveOperatorAuthSessionAction('SIGNED_OUT', null, 'user-1'), { kind: 'sign-out' });
});

test('operator verification is single-flight and settled failures can retry', async () => {
  let calls = 0;
  let rejectFirst: ((error: Error) => void) | null = null;
  const verifier = createOperatorVerificationSingleFlight(async () => {
    calls += 1;
    if (calls === 1) return new Promise<string>((_resolve, reject) => { rejectFirst = reject; });
    return 'ok';
  });
  const first = verifier.verify('user-1');
  assert.strictEqual(verifier.verify('user-1'), first);
  assert.equal(calls, 1);
  (rejectFirst as unknown as (error: Error) => void)(new Error('network'));
  await assert.rejects(first, /network/);
  assert.equal(await verifier.verify('user-1'), 'ok');
  assert.equal(calls, 2);
});
