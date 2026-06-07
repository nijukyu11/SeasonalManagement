import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

const source = readFileSync(join(process.cwd(), 'src/app/hooks/useSeasonWorkspaceRefresh.ts'), 'utf8');

test('season workspace refresh awaits native refresh before handling the next event', () => {
  assert.match(source, /onNativeRefresh\?:\s*\(event:\s*SeasonWorkspaceChangeEvent\)\s*=>\s*Promise<void>\s*\|\s*void/);
  assert.match(source, /async function refreshFromNativeEvent/);
  assert.match(source, /await onNativeRefreshRef\.current\?\.\(event\)/);
  assert.match(source, /void scheduleRefreshRef\.current\(pendingEvent\)/);
});

