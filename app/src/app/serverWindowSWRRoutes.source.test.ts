import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const ROUTES = [
  'SeasonalSchedulePage.tsx',
  'detailed/page.tsx',
  'daily/page.tsx',
  'checkin/page.tsx',
  'gate/page.tsx',
  'dashboard/page.tsx',
] as const;

test('heavy schedule routes render any existing snapshot before background revalidation', () => {
  for (const route of ROUTES) {
    const source = readFileSync(new URL(route, import.meta.url), 'utf8');
    assert.match(source, /readWorkspaceWindowSnapshot/, `${route} must accept stale server snapshots`);
    assert.match(source, /readCachedWorkspaceWindow/, `${route} must still distinguish fresh snapshots`);
    assert.match(source, /loadSeasonWorkspaceWindow/, `${route} must revalidate through the shared transport boundary`);
  }
});

test('route code never imports a native or SQLite read fallback for server windows', () => {
  for (const route of ROUTES) {
    const source = readFileSync(new URL(route, import.meta.url), 'utf8');
    assert.doesNotMatch(source, /queryNative|importNative|loadNativeSeason|SQLite fallback/i, route);
  }
});
