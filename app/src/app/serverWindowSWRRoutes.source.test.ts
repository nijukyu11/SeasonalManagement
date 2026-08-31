import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const ROUTES = [
  '(desktop)/SeasonalSchedulePage.tsx',
  '(desktop)/detailed/page.tsx',
  '(desktop)/daily/page.tsx',
  '(desktop)/checkin/page.tsx',
  '(desktop)/gate/page.tsx',
  '(desktop)/dashboard/page.tsx',
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

test('workspace refresh callbacks distinguish direct patches from server revalidation', () => {
  for (const route of ROUTES) {
    const source = readFileSync(new URL(route, import.meta.url), 'utf8');
    assert.match(source, /onRefresh:\s*async?\s*\(?event\)?\s*=>|onRefresh:\s*\(?event\)?\s*=>/, `${route} must inspect the workspace event`);
    assert.match(source, /event\.refreshMode === 'revalidate'/, `${route} must fetch only for reconciliation events`);
  }
});
