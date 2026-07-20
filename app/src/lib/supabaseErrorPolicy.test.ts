import assert from 'node:assert/strict';
import test from 'node:test';
import {
  isMissingRpcSignatureError,
  isStatementTimeoutError,
  shouldUseLegacyWorkspaceWindowRpc,
} from './supabaseErrorPolicy.ts';

test('workspace window may use the legacy RPC only when V2 is missing', () => {
  const error = new Error('PGRST202: could not find the function in the schema cache');
  assert.equal(isMissingRpcSignatureError(error), true);
  assert.equal(shouldUseLegacyWorkspaceWindowRpc(error), true);
});

test('workspace window does not fall back when an RPC reaches statement timeout', () => {
  const error = new Error('canceling statement due to statement timeout');
  assert.equal(isStatementTimeoutError(error), true);
  assert.equal(shouldUseLegacyWorkspaceWindowRpc(error), false);
});

test('generic network failures do not select a second workspace transport', () => {
  assert.equal(shouldUseLegacyWorkspaceWindowRpc(new TypeError('Failed to fetch')), false);
});
