import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '../..');
const migration = readFileSync(resolve(root, 'supabase/migrations/20260828090000_daily_schedule_import_v1.sql'), 'utf8');
const seasonalMigration = readFileSync(resolve(root, 'supabase/migrations/20260828100000_preserve_daily_overlays_during_seasonal_replace.sql'), 'utf8');
const canonicalCommitMigration = readFileSync(resolve(root, 'supabase/migrations/20260829153000_daily_schedule_canonical_commit.sql'), 'utf8');
const canonicalHelperGrantMigration = readFileSync(resolve(root, 'supabase/migrations/20260830053000_grant_canonical_helper_execute.sql'), 'utf8');
const multiSeasonEventIdentityMigration = readFileSync(resolve(root, 'supabase/migrations/20260831010000_fix_daily_multiseason_event_identity.sql'), 'utf8');
const overlayLineageMigration = readFileSync(resolve(root, 'supabase/migrations/20260831103000_daily_overlay_lineage_match.sql'), 'utf8');
const conflictHttpMigration = readFileSync(resolve(root, 'supabase/migrations/20260902140000_daily_import_conflict_http_status.sql'), 'utf8');
const page = readFileSync(resolve(root, 'src/app/(desktop)/daily/page.tsx'), 'utf8');
const previewDialog = readFileSync(resolve(root, 'src/app/(desktop)/components/DailyImportPreviewDialog.tsx'), 'utf8');

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
  assert.match(commit, /'daily-canonical-v2',p_batch_id::text\|\|':'\|\|v_target\.season_id/);
  assert.match(multiSeasonEventIdentityMigration, /p_batch_id::text\|\|':'\|\|v_target\.season_id/);
  assert.match(canonicalCommitMigration, /count\(distinct public\.canonical_flight_leg_occurrence_key_v1/);
  assert.match(canonicalCommitMigration, /array_agg\(records\.record_id order by records\.lifecycle_changed_at desc nulls last/);
  assert.match(overlayLineageMigration, /Historical deleted rows for the same exact atomic/);
  assert.match(commit, /status='committed',result=v_result,committed_at=now\(\)/);
  assert.doesNotMatch(commit, /insert into public\.daily_schedule_active_days/);
  assert.doesNotMatch(commit, /delete from public\.season_flight_records/);
  assert.doesNotMatch(commit, /delete from public\.season_modifications/);
  assert.match(migration, /DAILY_COVERAGE_GAP/);
  assert.match(canonicalCommitMigration, /canonical_active_flight_records_v1/);
  assert.match(canonicalCommitMigration, /daily_schedule_effective_records_v1/);
  assert.match(migration, /reporting\.effective_flight_operations/);
  assert.match(seasonalMigration, /preserve_daily_overlay/);
  assert.match(conflictHttpMigration, /stage_daily_schedule_import_v1\(jsonb\)/);
  assert.match(conflictHttpMigration, /commit_daily_schedule_import_v1\(uuid,jsonb,text\)/);
  assert.match(conflictHttpMigration, /replace\(v_definition, '40001', 'PT409'\)/);
  assert.match(conflictHttpMigration, /pg_get_functiondef/);
});

test('Daily upload stages preview and cannot call the legacy local mutation path', () => {
  const handler = page.slice(page.indexOf('const handleDailyImportFile'), page.indexOf('const handleAddFlights'));
  assert.match(handler, /analyzeDailyScheduleWorkbook/);
  assert.match(handler, /stageDailyImportWithTerminalRetryV1\(payload, stageDailyScheduleImportV1, \{[\s\S]*getStatus: getDailyScheduleImportV1Status/);
  assert.match(handler, /setDailyImportPreview/);
  assert.doesNotMatch(handler, /runNativeScheduleMutation/);
  assert.doesNotMatch(handler, /buildDailyScheduleImportUpdate/);
  assert.doesNotMatch(page, /NEXT_PUBLIC_DAILY_IMPORT_V1_COMMIT_ENABLED/);
  assert.match(page, /NEXT_PUBLIC_DAILY_IMPORT_V1_STAGE_ENABLED/);
  assert.doesNotMatch(previewDialog, /daily-import-confirmation|confirmation !== requiredText|Nhập <code/);
  assert.match(previewDialog, /disabled=\{!valid \|\| !commitEnabled \|\| committing \|\| restaging\}/);
  assert.match(previewDialog, /onClick=\{onCommit\}/);
  assert.match(previewDialog, /Preview này đã bị hủy/);
  assert.match(page, /revalidateSeasonWorkspaceWindow/);
  assert.match(page, /getDailyScheduleImportV1Status/);
  assert.match(page, /draft\/pending changes/);
});

test('canonical security-invoker projections can execute their pure helpers', () => {
  for (const helper of [
    'is_canonical_flight_leg_active_v1\\(text,text\\)',
    'canonical_flight_leg_ops_date_v1\\(text,text,text,text,text\\)',
    'canonical_flight_leg_occurrence_key_v1\\(text,text,text,text,text,text,text,text,text,text,text\\)',
  ]) {
    assert.match(canonicalHelperGrantMigration, new RegExp(`revoke execute on function public\\.${helper}\\s+from public, anon`, 'i'));
    assert.match(canonicalHelperGrantMigration, new RegExp(`grant execute on function public\\.${helper}\\s+to authenticated`, 'i'));
  }
  assert.doesNotMatch(canonicalHelperGrantMigration, /from public, anon, authenticated/i);
  assert.match(canonicalHelperGrantMigration, /service_role/);
  assert.match(canonicalHelperGrantMigration, /seasonal_bi_reader/);
});
