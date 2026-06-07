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
