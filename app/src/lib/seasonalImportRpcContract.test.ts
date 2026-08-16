import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildSeasonalImportChecksum,
  buildSeasonalImportRequestId,
  parseSeasonalImportV2Result,
} from './seasonalImportRpcContract.ts';

test('import V2 rejects a response without real server counts', () => {
  assert.throws(() => parseSeasonalImportV2Result({ status: 'committed' }), /batchId/);
});

test('import V2 accepts the exact committed server result', () => {
  const result = parseSeasonalImportV2Result({
    batchId: '00000000-0000-0000-0000-000000000001', seasonId: 'season-w26', seasonCode: 'W26',
    status: 'committed', sourceRowCount: 450, flightRecordCount: 26631, preservedOperationalCount: 0,
    removedImportedCount: 0, dataVersion: 2, serverHighWater: 10, checksum: 'abc',
  });
  assert.equal(result.flightRecordCount, 26631);
});

test('checksum and request id are stable but version-fenced', async () => {
  const rows = [{ rowIndex: 1, airline: 'VN' }] as never[];
  const checksum = await buildSeasonalImportChecksum('W26', rows);
  assert.equal(checksum, await buildSeasonalImportChecksum('W26', rows));
  const first = await buildSeasonalImportRequestId({ seasonId: 'S1', expectedDataVersion: 1, checksum });
  assert.equal(first, await buildSeasonalImportRequestId({ seasonId: 'S1', expectedDataVersion: 1, checksum }));
  assert.notEqual(first, await buildSeasonalImportRequestId({ seasonId: 'S1', expectedDataVersion: 2, checksum }));
  assert.match(first, /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
});
