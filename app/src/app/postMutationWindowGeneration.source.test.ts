import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const seasonal = readFileSync(new URL('(desktop)/SeasonalSchedulePage.tsx', import.meta.url), 'utf8');
const settings = readFileSync(new URL('(desktop)/settings/page.tsx', import.meta.url), 'utf8');

test('both Seasonal import entry points reconcile only through the post-mutation coordinator', () => {
  for (const [name, source] of [['Seasonal', seasonal], ['Settings repair', settings]] as const) {
    assert.match(source, /revalidateSeasonWorkspaceAfterMutation\(/, name);
    assert.match(source, /generationAlreadyAdvanced:\s*false/, name);
    assert.doesNotMatch(source, /clearSeasonBaseline|batchWriteFlightRecords|apply_seasonal_import_remote/, name);
  }
});
