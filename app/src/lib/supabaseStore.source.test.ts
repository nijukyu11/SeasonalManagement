import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

const source = readFileSync(join(process.cwd(), 'src/lib/supabaseStore.ts'), 'utf8');

test('season realtime subscriptions use a unique channel topic before registering postgres callbacks', () => {
  const functionStart = source.indexOf('async subscribeToSeasonEvents');
  assert.notEqual(functionStart, -1, 'subscribeToSeasonEvents should exist');
  const functionEnd = source.indexOf('async getCurrentRemoteActor', functionStart);
  assert.notEqual(functionEnd, -1, 'subscribeToSeasonEvents should end before getCurrentRemoteActor');
  const body = source.slice(functionStart, functionEnd);

  assert.match(body, /const channelTopic = `season-change-events:\$\{seasonId\}:\$\{randomId\('subscription'\)\}`;/);
  assert.match(body, /\.channel\(channelTopic\)[\s\S]*?\.on\(\s*'postgres_changes'/);
  assert.match(body, /filter: `season_id=eq\.\$\{seasonId\}`/);
  assert.doesNotMatch(body, /\.channel\(`season-change-events:\$\{seasonId\}`\)/);
});
