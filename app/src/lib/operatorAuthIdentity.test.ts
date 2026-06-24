import assert from 'node:assert/strict';
import test from 'node:test';

import {
  OPERATOR_TECHNICAL_EMAIL_DOMAIN,
  formatOperatorLabel,
  normalizeOperatorUsername,
  resolveOperatorLoginIdentity,
} from './operatorAuthIdentity.ts';

test('normalizes a visible username into the technical Supabase email identity', () => {
  assert.equal(normalizeOperatorUsername(' Ops_01 '), 'ops_01');
  assert.deepEqual(resolveOperatorLoginIdentity(' Ops_01 '), {
    kind: 'username',
    username: 'ops_01',
    email: `ops_01@${OPERATOR_TECHNICAL_EMAIL_DOMAIN}`,
  });
});

test('rejects invalid operator usernames before calling Supabase Auth', () => {
  assert.throws(() => resolveOperatorLoginIdentity('ab'), /Username không hợp lệ/);
  assert.throws(() => resolveOperatorLoginIdentity('-ops'), /Username không hợp lệ/);
  assert.throws(() => resolveOperatorLoginIdentity('ops-'), /Username không hợp lệ/);
  assert.throws(() => resolveOperatorLoginIdentity('ops vn'), /Username không hợp lệ/);
  assert.throws(() => resolveOperatorLoginIdentity('ops@'), /Username không hợp lệ/);
});

test('keeps email fallback available during migration', () => {
  assert.deepEqual(resolveOperatorLoginIdentity(' Ops@Example.COM '), {
    kind: 'email',
    username: null,
    email: 'ops@example.com',
  });
});

test('formats operator labels without exposing technical email when profile data exists', () => {
  assert.equal(formatOperatorLabel({ displayName: 'Nguyen Van A', username: 'ops01', email: 'ops01@operators.local.ahtops' }), 'Nguyen Van A');
  assert.equal(formatOperatorLabel({ displayName: null, username: 'ops01', email: 'ops01@operators.local.ahtops' }), 'ops01');
  assert.equal(formatOperatorLabel({ displayName: null, username: null, email: 'ops01@operators.local.ahtops' }), 'ops01@operators.local.ahtops');
  assert.equal(formatOperatorLabel({ displayName: null, username: null, email: null }), 'Operator');
});
