import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '../..');
const migration = readFileSync(resolve(root, 'supabase/migrations/20260828090000_daily_schedule_import_v1.sql'), 'utf8');
const seasonalMigration = readFileSync(resolve(root, 'supabase/migrations/20260828100000_preserve_daily_overlays_during_seasonal_replace.sql'), 'utf8');
const canonicalCommitMigration = readFileSync(resolve(root, 'supabase/migrations/20260829153000_daily_schedule_canonical_commit.sql'), 'utf8');
const page = readFileSync(resolve(root, 'src/app/daily/page.tsx'), 'utf8');

test('Daily commit atomically supersedes canonical legs without mutating the legacy active pointer', () => {
  const commit = canonicalCommitMigration.slice(canonicalCommitMigration.indexOf('create or replace function public.commit_daily_schedule_import_v1'));
  assert.match(commit, /for v_target in select \* from public\.daily_schedule_import_seasons\s+where batch_id=p_batch_id order by season_id/);
  assert.match(commit, /pg_advisory_xact_lock/);
  assert.match(commit, /for update/);
  assert.match(commit, /using errcode='40001'/);
  assert.match(commit, /set status='deleted', action='deleted', deletion_reason='daily_replacement'/);
  assert.match(commit, /insert into public\.season_flight_records/);
  assert.match(commit, /'daily',legs\.side,'active'/);
  assert.match(commit, /insert into public\.schedule_replacement_scopes/);
  assert.match(commit, /app\.test_daily_canonical_failpoint/);
  assert.match(commit, /insert into public\.season_change_events/);
  assert.match(commit, /status='committed',result=v_result,committed_at=now\(\)/);
  assert.doesNotMatch(commit, /insert into public\.daily_schedule_active_days/);
  assert.doesNotMatch(commit, /delete from public\.season_flight_records/);
  assert.doesNotMatch(commit, /delete from public\.season_modifications/);
  assert.match(migration, /DAILY_COVERAGE_GAP/);
  assert.match(canonicalCommitMigration, /canonical_active_flight_records_v1/);
  assert.match(canonicalCommitMigration, /daily_schedule_effective_records_v1/);
  assert.match(migration, /reporting\.effective_flight_operations/);
  assert.match(seasonalMigration, /preserve_daily_overlay/);
});

test('Daily upload stages preview and cannot call the legacy local mutation path', () => {
  const handler = page.slice(page.indexOf('const handleDailyImportFile'), page.indexOf('const handleAddFlights'));
  assert.match(handler, /analyzeDailyScheduleWorkbook/);
  assert.match(handler, /stageDailyScheduleImportV1/);
  assert.match(handler, /setDailyImportPreview/);
  assert.doesNotMatch(handler, /runNativeScheduleMutation/);
  assert.doesNotMatch(handler, /buildDailyScheduleImportUpdate/);
  assert.match(page, /NEXT_PUBLIC_DAILY_IMPORT_V1_COMMIT_ENABLED/);
  assert.match(page, /NEXT_PUBLIC_DAILY_IMPORT_V1_STAGE_ENABLED/);
  assert.match(page, /revalidateSeasonWorkspaceWindow/);
  assert.match(page, /getDailyScheduleImportV1Status/);
  assert.match(page, /draft\/pending changes/);
});
