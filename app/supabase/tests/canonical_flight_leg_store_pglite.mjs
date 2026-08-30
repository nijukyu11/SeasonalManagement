import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createSupabasePGlite } from './pglite_test_support.mjs';

const schema = await readFile(new URL('../schema.sql', import.meta.url), 'utf8');
const standMigration = await readFile(new URL('../migrations/20260828083000_allow_alphanumeric_stand_values.sql', import.meta.url), 'utf8');
const dailyMigration = await readFile(new URL('../migrations/20260828090000_daily_schedule_import_v1.sql', import.meta.url), 'utf8');
const seasonalInteractionMigration = await readFile(new URL('../migrations/20260828100000_preserve_daily_overlays_during_seasonal_replace.sql', import.meta.url), 'utf8');
const canonicalMigration = await readFile(new URL('../migrations/20260829150000_canonical_flight_leg_store.sql', import.meta.url), 'utf8');
const canonicalDailyMigration = await readFile(new URL('../migrations/20260829153000_daily_schedule_canonical_commit.sql', import.meta.url), 'utf8');
const canonicalHelperGrantMigration = await readFile(new URL('../migrations/20260830053000_grant_canonical_helper_execute.sql', import.meta.url), 'utf8');

const db = await createSupabasePGlite();
const seasonId = 'season-canonical-store';

try {
  await db.exec(schema);
  await db.exec(standMigration);
  await db.exec(dailyMigration);
  await db.exec(seasonalInteractionMigration);
  await db.query(`insert into public.seasons(id,season_code,name,file_name,uploaded_at,effective_start,effective_end,total_legs,total_source_rows,data_version) values ($1,'S26','S26','',0,'2026-03-29','2026-10-24',0,0,1)`, [seasonId]);
  await db.query(`
    insert into public.season_flight_records(
      season_id,record_id,type,flight_number,raw_flight_number,airline,route,schedule,
      date,scheduled_date,scheduled_time,operational_date,source_kind,source_side,status
    ) values
      ($1,'SEASONAL-1','D','VN101','101','VN','SGN','06:00','2026-08-23','2026-08-23','06:00','2026-08-23','imported','DEP','active'),
      ($1,'MANUAL-BASE-1','A','VN102','102','VN','HAN','07:00','2026-08-23','2026-08-23','07:00','2026-08-23','added','ARR','active')
  `, [seasonId]);
  await db.exec('begin');
  await db.query(`insert into public.season_modifications(season_id,leg_id,action,changed_fields) values ($1,'MANUAL-LEGACY','added',array['addedLeg'])`, [seasonId]);
  await db.query(`
    insert into public.season_modification_added_legs(
      season_id,leg_id,record_id,type,flight_number,raw_flight_number,airline,route,schedule,
      date,scheduled_date,scheduled_time,operational_date,source_kind,source_side,status,action
    ) values ($1,'MANUAL-LEGACY','MANUAL-LEGACY','D','VN103','103','VN','DAD','08:00',
      '2026-08-23','2026-08-23','08:00','2026-08-23','added','DEP','active','added')
  `, [seasonId]);
  await db.exec('commit');

  await db.exec(canonicalMigration);
  await db.exec(canonicalDailyMigration);
  await db.exec(canonicalHelperGrantMigration);

  const helperPrivileges = await db.query(`
    select
      has_function_privilege('authenticated', 'public.is_canonical_flight_leg_active_v1(text,text)', 'execute') as active,
      has_function_privilege('authenticated', 'public.canonical_flight_leg_ops_date_v1(text,text,text,text,text)', 'execute') as ops_date,
      has_function_privilege('authenticated', 'public.canonical_flight_leg_occurrence_key_v1(text,text,text,text,text,text,text,text,text,text,text)', 'execute') as occurrence,
      has_function_privilege('anon', 'public.is_canonical_flight_leg_active_v1(text,text)', 'execute') as anon_active
  `);
  assert.deepEqual(helperPrivileges.rows, [{ active: true, ops_date: true, occurrence: true, anon_active: false }]);

  const sources = await db.query(`select source_kind,count(*)::integer as count from public.season_flight_records where season_id=$1 group by source_kind order by source_kind`, [seasonId]);
  assert.deepEqual(sources.rows, [
    { source_kind: 'manual', count: 2 },
    { source_kind: 'seasonal', count: 1 },
  ]);

  const migrated = await db.query(`select legacy_leg_id,canonical_record_id from public.season_manual_leg_migrations where season_id=$1`, [seasonId]);
  assert.deepEqual(migrated.rows, [{ legacy_leg_id: 'MANUAL-LEGACY', canonical_record_id: 'MANUAL-LEGACY' }]);

  const active = await db.query(`select record_id from public.canonical_active_flight_records_v1 where season_id=$1 order by record_id`, [seasonId]);
  assert.deepEqual(active.rows.map((row) => row.record_id), ['MANUAL-BASE-1', 'MANUAL-LEGACY', 'SEASONAL-1']);

  await assert.rejects(
    db.query(`
      insert into public.season_flight_records(
        season_id,record_id,type,flight_number,raw_flight_number,airline,route,schedule,
        date,scheduled_date,scheduled_time,operational_date,source_kind,source_side,status
      ) values ($1,'DAILY-DUP','D','VN101','101','VN','SGN','06:00',
        '2026-08-23','2026-08-23','06:00','2026-08-23','daily','DEP','active')
    `, [seasonId]),
    (error) => error?.code === '23505',
    'canonical occurrence uniqueness must protect Seasonal/Daily/Manual together',
  );

  await assert.rejects(
    db.query(`update public.season_flight_records set status='deleted',action=null where record_id='SEASONAL-1'`),
    (error) => error?.code === '23514',
    'deleted status/action must remain consistent',
  );

  await db.query(`update public.season_flight_records set status='deleted',action='deleted',deletion_reason='manual_delete' where record_id='SEASONAL-1'`);
  const afterDelete = await db.query(`select record_id from public.canonical_active_flight_records_v1 where season_id=$1 order by record_id`, [seasonId]);
  assert.deepEqual(afterDelete.rows.map((row) => row.record_id), ['MANUAL-BASE-1', 'MANUAL-LEGACY']);

  console.log(JSON.stringify({ suite: 'canonical-flight-leg-store', status: 'passed' }));
} finally {
  await db.close();
}
