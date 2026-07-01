import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

const source = readFileSync(join(process.cwd(), 'src/lib/nativeSeasonBootstrap.ts'), 'utf8');

test('native season baseline repair uses auto snapshot transport before paged table fallback', () => {
  assert.match(source, /getSeasonWorkspaceSnapshot\(season\.id,\s*\{\s*modHistoryLimit:\s*50,\s*\}\)/);
  assert.doesNotMatch(source, /transport:\s*'paged'/);
});
