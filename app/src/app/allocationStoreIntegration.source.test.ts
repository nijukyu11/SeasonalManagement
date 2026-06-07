import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

const checkInSource = readFileSync(join(process.cwd(), 'src/app/checkin/page.tsx'), 'utf8');
const gateSource = readFileSync(join(process.cwd(), 'src/app/gate/page.tsx'), 'utf8');

test('Check-in and Gate commits patch the workspace store without successful full-window re-query', () => {
  for (const source of [checkInSource, gateSource]) {
    assert.match(source, /useSeasonWorkspaceStore/);
    assert.match(source, /replaceSeasonWindow\(\{/);
    assert.match(source, /patchSeasonWorkspace\(\{/);
    assert.match(source, /affectedIds:\s*result\.affectedIds/);
    assert.match(source, /syncMeta:\s*result\.syncMeta/);
    assert.match(source, /publishWorkspaceChange\([\s\S]*result\.affectedIds[\s\S]*result\.syncMeta/);
  }
});

