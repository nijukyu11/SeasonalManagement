import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

const source = readFileSync(join(process.cwd(), 'src/lib/nativeLocalSeasonStore.ts'), 'utf8');
const nativeSource = readFileSync(join(process.cwd(), 'src-tauri/src/native_catchup.rs'), 'utf8');

test('native local modification delta exposes affected ids with sync metadata', () => {
  assert.match(source, /affectedIds:\s*string\[\]/);
  assert.match(source, /runNativeLocalModificationBatchDeltaResult/);
  assert.match(source, /return result\.syncMeta/);
  assert.match(nativeSource, /pub affected_ids:\s*Vec<String>/);
  assert.match(nativeSource, /Ok\(ApplyLocalModificationBatchDeltaResult\s*\{[\s\S]*sync_meta,[\s\S]*affected_ids,[\s\S]*\}\)/);
});

test('server-authoritative modification writes run before native runtime gating', () => {
  const functionStart = source.indexOf('export async function runNativeLocalModificationBatchDeltaResult');
  assert.notEqual(functionStart, -1, 'runNativeLocalModificationBatchDeltaResult should exist');
  const functionEnd = source.indexOf('\nexport async function runNativeLocalModificationBatchDelta(', functionStart);
  assert.notEqual(functionEnd, -1, 'next exported function should exist');
  const body = source.slice(functionStart, functionEnd);

  const serverBranch = body.indexOf('if (SERVER_AUTHORITATIVE_MODE)');
  const nativeGate = body.indexOf('if (!isNativeLocalStoreRuntime()) return null');

  assert.notEqual(serverBranch, -1, 'server-authoritative branch should exist');
  assert.notEqual(nativeGate, -1, 'native runtime gate should exist for offline mode');
  assert.ok(serverBranch < nativeGate, 'server-authoritative branch must run before native runtime gating');
});

test('server-authoritative schedule writes run before native runtime gating', () => {
  const functionStart = source.indexOf('export async function runNativeScheduleMutation');
  assert.notEqual(functionStart, -1, 'runNativeScheduleMutation should exist');
  const body = source.slice(functionStart);

  const serverBranch = body.indexOf('if (SERVER_AUTHORITATIVE_MODE)');
  const nativeGate = body.indexOf('if (!isNativeLocalStoreRuntime()) return null');

  assert.notEqual(serverBranch, -1, 'server-authoritative branch should exist');
  assert.notEqual(nativeGate, -1, 'native runtime gate should exist for offline mode');
  assert.ok(serverBranch < nativeGate, 'server-authoritative branch must run before native runtime gating');
});

test('server-authoritative schedule writes use route module source instead of schedule fallback', () => {
  const functionStart = source.indexOf('export async function runNativeScheduleMutation');
  assert.notEqual(functionStart, -1, 'runNativeScheduleMutation should exist');
  const body = source.slice(functionStart);

  assert.match(source, /type NativeScheduleMutationSource = 'daily' \| 'detailed' \| 'seasonal'/);
  assert.match(body, /source:\s*NativeScheduleMutationSource = 'seasonal'/);
  assert.match(body, /applyServerAuthoritativeOperations\(seasonId,\s*source,\s*operations\)/);
  assert.doesNotMatch(body, /applyServerAuthoritativeOperations\(seasonId,\s*'schedule'/);
});
