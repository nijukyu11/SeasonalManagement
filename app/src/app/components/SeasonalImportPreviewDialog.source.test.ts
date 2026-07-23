import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

const source = readFileSync(
  join(process.cwd(), 'src', 'app', 'components', 'SeasonalImportPreviewDialog.tsx'),
  'utf8',
);

test('seasonal import preview exposes explicit strategy, diagnostics, and commit controls', () => {
  assert.match(source, />\s*Merge\s*</);
  assert.match(source, />\s*Replace\s*</);
  assert.match(source, /Insert/);
  assert.match(source, /Baseline update/);
  assert.match(source, /Unchanged/);
  assert.match(source, /Preserved outside file/);
  assert.match(source, /Removed/);
  assert.match(source, /Preserved overlays/);
  assert.match(source, /Cleared overlays/);
  assert.match(source, /diagnostics/i);
  assert.match(source, /confirmation/);
  assert.match(source, /disabled=\{!commitEnabled\}/);
  assert.match(source, /onCancel/);
  assert.match(source, /onCommit/);
});

test('preview dialog never commits automatically after stage', () => {
  assert.doesNotMatch(source, /useEffect[\s\S]*onCommit/);
  assert.match(source, /onClick=\{onCommit\}/);
  assert.match(source, /break-all|break-words|overflow-wrap/);
});
