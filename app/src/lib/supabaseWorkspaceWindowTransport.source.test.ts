import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

const source = readFileSync(join(process.cwd(), 'src/lib/supabaseStore.ts'), 'utf8');

function sliceBetween(startMarker: string, endMarker: string): string {
  const start = source.indexOf(startMarker);
  assert.notEqual(start, -1, `${startMarker} should exist`);
  const end = source.indexOf(endMarker, start + startMarker.length);
  assert.notEqual(end, -1, `${endMarker} should follow ${startMarker}`);
  return source.slice(start, end);
}

test('workspace V2 pages propagate cancellation and only use V1 for a missing signature', () => {
  const method = sliceBetween('async getSeasonWorkspaceWindow', 'async getSeasonWorkspaceSnapshot');
  assert.match(method, /options: RemoteRequestOptions = \{\}/);
  assert.match(method, /request = request\.abortSignal\(signal\)/);
  assert.match(method, /if \(options\.signal\?\.aborted\) throw error/);
  assert.match(method, /shouldUseLegacyWorkspaceWindowRpc\(error\)/);
  assert.match(method, /get_season_schedule_allocation_window_v2/);
  assert.match(method, /get_season_schedule_allocation_window_v1/);
  assert.doesNotMatch(method, /loadSeasonWorkspaceWindowPaged/);
  assert.doesNotMatch(method, /isStatementTimeoutError/);
});

test('workspace transport has no direct-table paged fallback helper', () => {
  assert.doesNotMatch(source, /loadSeasonWorkspaceWindowPaged/);
  assert.doesNotMatch(source, /load server workspace window['"]/);
});

test('selectAllRows stops at the requested limit and attaches an abort signal', () => {
  const helper = sliceBetween('async function selectAllRows', 'async function readRowsByInFilter');
  assert.match(helper, /remaining = requestedLimit - rows\.length/);
  assert.match(helper, /Math\.min\(SUPABASE_SELECT_PAGE_SIZE, remaining\)/);
  assert.match(helper, /query = query\.abortSignal\(options\.signal\)/);
  assert.match(helper, /rows\.length >= requestedLimit/);
});
