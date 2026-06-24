import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

const source = readFileSync(join(process.cwd(), 'src/app/components/AppRouteCache.tsx'), 'utf8');

test('route cache boundary does not keep heavy page modules mounted', () => {
  assert.doesNotMatch(source, /import .*Page from '\.\.\//);
  assert.doesNotMatch(source, /function renderCachedRouteModule/);
  assert.doesNotMatch(source, /CachedRoutePanel/);
  assert.doesNotMatch(source, /visibleEntries/);
  assert.doesNotMatch(source, /cachedEntries/);
});

test('route cache boundary preserves current route search params for the active page', () => {
  assert.match(source, /const pathname = usePathname\(\) \?\? '\/';/);
  assert.match(source, /const searchParams = useSearchParams\(\);/);
  assert.match(source, /const search = searchParams\.toString\(\);/);
  assert.match(source, /const cacheKey = search \? `\$\{pathname\}\?\$\{search\}` : pathname;/);
  assert.match(source, /<RouteCacheProvider active cacheKey=\{cacheKey\} search=\{search\}>/);
});

test('route cache boundary does not maintain component-cache state', () => {
  assert.doesNotMatch(source, /useState/);
  assert.doesNotMatch(source, /setCachedEntries/);
  assert.doesNotMatch(source, /window\.setTimeout/);
  assert.doesNotMatch(source, /window\.queueMicrotask/);
});
