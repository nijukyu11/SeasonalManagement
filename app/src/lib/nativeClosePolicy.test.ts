import assert from 'node:assert/strict';
import test from 'node:test';

import { NATIVE_CLOSE_CONFIRM_COPY } from './nativeClosePolicy.ts';

test('native close describes in-memory cleanup without SQLite ownership', () => {
  assert.match(NATIVE_CLOSE_CONFIRM_COPY.message, /unsaved in-memory drafts/i);
  assert.match(NATIVE_CLOSE_CONFIRM_COPY.message, /Undo history/i);
  assert.match(NATIVE_CLOSE_CONFIRM_COPY.message, /Saved server data is unchanged/i);
  assert.doesNotMatch(NATIVE_CLOSE_CONFIRM_COPY.message, /SQLite|local database|downloaded season data/i);
});
