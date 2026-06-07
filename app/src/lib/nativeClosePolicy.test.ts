import assert from 'node:assert/strict';
import test from 'node:test';

import {
  NATIVE_CLOSE_CONFIRM_COPY,
  shouldPreserveDurableLocalDataOnNativeClose,
} from './nativeClosePolicy.ts';

test('native close preserves the database but discards local pending edits and undo history', () => {
  assert.equal(shouldPreserveDurableLocalDataOnNativeClose(), true);
  assert.match(NATIVE_CLOSE_CONFIRM_COPY.message, /downloaded season data/i);
  assert.match(NATIVE_CLOSE_CONFIRM_COPY.message, /discard unsynced local edits/i);
  assert.match(NATIVE_CLOSE_CONFIRM_COPY.message, /Undo history/i);
});
