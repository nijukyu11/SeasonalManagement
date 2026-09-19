import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createSupabasePGlite } from './pglite_test_support.mjs';

const files = [
  '../schema.sql',
  '../migrations/20260828083000_allow_alphanumeric_stand_values.sql',
  '../migrations/20260828090000_daily_schedule_import_v1.sql',
  '../migrations/20260828100000_preserve_daily_overlays_during_seasonal_replace.sql',
  '../migrations/20260829150000_canonical_flight_leg_store.sql',
  '../migrations/20260829153000_daily_schedule_canonical_commit.sql',
  '../migrations/20260829160000_canonical_manual_modifications.sql',
  '../migrations/20260829170000_seasonal_canonical_authority.sql',
  '../migrations/20260829180000_daily_authority_reset.sql',
  '../migrations/20260831010000_fix_daily_multiseason_event_identity.sql',
  '../migrations/20260831103000_daily_overlay_lineage_match.sql',
  '../migrations/20260831124500_daily_overlay_authority_scope_match.sql',
  '../migrations/20260902140000_daily_import_conflict_http_status.sql',
  '../migrations/20260904183000_daily_import_stage_indexed_ops_date.sql',
  '../migrations/20260906010000_import_terminal_coverage_and_identity.sql',
  '../migrations/20260914090000_daily_loose_identity_live_row_precedence.sql',
  '../migrations/20260915100000_canonical_overlay_deletion_authority.sql',
];
const migration = await readFile(
  new URL('../migrations/20260919120000_duplicate_flight_day_repair.sql', import.meta.url),
  'utf8'
);
const sources = await Promise.all(files.map((file) => readFile(new URL(file, import.meta.url), 'utf8')));

const db = await createSupabasePGlite();
const seasonId = 'season-19cbca13-e11d-4b75-bcaa-00a6c5ca68c6';
const nxTarget = 'DAILY_V2_683bc249f07b683d1f458170207ab0cc';
const zeTarget = 'DAILY_V2_0543601ccc0153abedbcbfdebd01f4dc';

const duplicateGroups = async () =>
  (
    await db.query(
      `select count(*)::int as groups from (
         select 1
         from public.season_flight_records records
         where records.season_id = $1
           and public.is_canonical_flight_leg_active_v1(records.status, records.action)
           and not exists (
             select 1 from public.season_modifications mods
             where mods.season_id = records.season_id and mods.leg_id = records.record_id and mods.action = 'deleted'
           )
         group by records.date, upper(btrim(records.airline)),
           (select normalized.flight_number
            from public.normalize_seasonal_flight_number_v2(
              records.airline, coalesce(nullif(records.flight_number, ''), records.raw_flight_number)) normalized)
         having count(*) > 1
       ) duplicates`,
      [seasonId]
    )
  ).rows[0].groups;

const rowState = async (recordId) =>
  (
    await db.query(
      `select status, action, deletion_reason, lifecycle_changed_by
       from public.season_flight_records where season_id = $1 and record_id = $2`,
      [seasonId, recordId]
    )
  ).rows[0];

const dataVersion = async () =>
  (await db.query(`select data_version from public.seasons where id = $1`, [seasonId])).rows[0].data_version;

const insertRecord = (recordId, airline, flightNumber, rawFlightNumber, type, side, schedule, date, operationalDate) =>
  db.query(
    `insert into public.season_flight_records(
      season_id, record_id, link_id, type, airline, flight_number, raw_flight_number, route,
      schedule, aircraft, category, date, scheduled_date, scheduled_time, operational_date,
      iata_season_code, day_of_week, source_kind, source_side, status, action
    ) values ($1,$2,'',$3,$4,$5,$6,'MFM',$7,'738','J',$8,$8,$7,$9,'S26',0,'daily',$10,'active',null)`,
    [seasonId, recordId, type, airline, flightNumber, rawFlightNumber, schedule, date, operationalDate, side]
  );

try {
  // Phase A: a chain without the S26 season stays a no-op instead of failing.
  for (const source of sources) await db.exec(source);
  await db.exec(migration);
  assert.equal((await db.query(`select count(*)::int as n from public.seasons where id = $1`, [seasonId])).rows[0].n, 0);

  // Phase B: production pre-state, one duplicate pair per affected calendar date.
  await db.query(
    `insert into public.seasons(id,season_code,name,file_name,uploaded_at,effective_start,effective_end,total_legs,total_source_rows,data_version)
     values ($1,'S26','S26','',0,'2026-03-29','2026-10-24',0,0,16595)`,
    [seasonId]
  );
  await insertRecord(nxTarget, 'NX', 'NX985', '985', 'A', 'ARR', '03:00', '2026-07-16', '2026-07-15');
  await insertRecord('SIBLING-NX985-DEP', 'NX', 'NX985', '985', 'D', 'DEP', '23:35', '2026-07-16', '2026-07-16');
  await insertRecord(zeTarget, 'ZE', 'ZE593A', '593A', 'A', 'ARR', '00:40', '2026-07-27', '2026-07-26');
  await insertRecord('SIBLING-ZE593A-ARR', 'ZE', 'ZE593A', '593A', 'A', 'ARR', '23:25', '2026-07-27', '2026-07-27');
  await insertRecord('CONTROL-ROW', 'JX', 'JX704', '704', 'D', 'DEP', '09:00', '2026-07-27', '2026-07-27');
  assert.equal(await duplicateGroups(), 2);
  assert.equal(await dataVersion(), 16595);

  await db.exec(migration);
  assert.equal(await duplicateGroups(), 0);
  for (const target of [nxTarget, zeTarget]) {
    assert.deepEqual(await rowState(target), {
      status: 'deleted',
      action: 'deleted',
      deletion_reason: 'duplicate_flight_day_repair',
      lifecycle_changed_by: null,
    });
  }
  for (const untouched of ['SIBLING-NX985-DEP', 'SIBLING-ZE593A-ARR', 'CONTROL-ROW']) {
    assert.equal((await rowState(untouched)).status, 'active', `${untouched} must stay active`);
  }
  assert.equal(await dataVersion(), 16596);

  // Phase C: rerunning the repair is a no-op and the version does not drift.
  await db.exec(migration);
  assert.equal(await duplicateGroups(), 0);
  assert.equal(await dataVersion(), 16596);
} finally {
  await db.close();
}
