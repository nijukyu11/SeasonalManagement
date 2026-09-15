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
  '../migrations/20260829180000_daily_authority_reset.sql',
  '../migrations/20260831010000_fix_daily_multiseason_event_identity.sql',
  '../migrations/20260831103000_daily_overlay_lineage_match.sql',
  '../migrations/20260831124500_daily_overlay_authority_scope_match.sql',
  '../migrations/20260902140000_daily_import_conflict_http_status.sql',
  '../migrations/20260829170000_seasonal_canonical_authority.sql',
  '../migrations/20260904183000_daily_import_stage_indexed_ops_date.sql',
  '../migrations/20260906010000_import_terminal_coverage_and_identity.sql',
  '../migrations/20260914090000_daily_loose_identity_live_row_precedence.sql',
];
const migration = await readFile(
  new URL('../migrations/20260915100000_canonical_overlay_deletion_authority.sql', import.meta.url),
  'utf8'
);
const sources = await Promise.all(files.map((file) => readFile(new URL(file, import.meta.url), 'utf8')));

const db = await createSupabasePGlite();
const userId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const seasonId = 'season-overlay-authority';

const applyOp = async (op) =>
  db.query(`select public.apply_workspace_op_json($1, $2::jsonb) as result`, [seasonId, JSON.stringify(op)]);
const legState = async (recordId) =>
  (
    await db.query(
      `select status, action, deletion_reason, lifecycle_changed_by, public.is_rebasable_terminal_flight_leg_v1(records) as rebasable
       from public.season_flight_records records where records.record_id = $1`,
      [recordId]
    )
  ).rows[0];
const insertRecord = (recordId, kind, status, action, flightNumber, schedule) =>
  db.query(
    `insert into public.season_flight_records(
      season_id,record_id,link_id,type,airline,flight_number,raw_flight_number,route,
      schedule,aircraft,category,date,scheduled_date,scheduled_time,operational_date,
      iata_season_code,day_of_week,source_kind,source_side,status,action
    ) values ($1,$2,'','D','JX',$3,$4,'TPE',$5,'321','J','2026-10-25','2026-10-25',$5,'2026-10-25',
      'W26',0,$6,'DEP',$7,$8)`,
    [seasonId, recordId, flightNumber, flightNumber.replace('JX', ''), schedule, kind, status, action]
  );

try {
  // Phase A: production pre-state, including the rows operator deletes left live
  // behind a deleted overlay (the shape that blocked Daily import identity).
  for (const source of sources) await db.exec(source);
  await db.query(`insert into auth.users(id,email) values ($1,'overlay@example.test')`, [userId]);
  await db.query(
    `insert into public.app_operators(user_id,email,username,display_name) values ($1,'overlay@example.test','overlay','Overlay')`,
    [userId]
  );
  await db.query(
    `insert into public.app_operator_permission_overrides(user_id,permission_key,effect) values ($1,'seasonal.write','allow'),($1,'seasonal.read','allow')`,
    [userId]
  );
  await db.query(
    `insert into public.seasons(id,season_code,name,file_name,uploaded_at,effective_start,effective_end,total_legs,total_source_rows,data_version)
     values ($1,'W26','W26','',0,'2026-10-25','2027-03-27',0,0,1)`,
    [seasonId]
  );
  await db.exec(`select set_config('request.jwt.claim.sub','${userId}',false)`);

  await insertRecord('SEASONAL-PHANTOM-1', 'seasonal', 'active', null, 'JX704', '09:00');
  await insertRecord('SEASONAL-PHANTOM-2', 'seasonal', 'active', null, 'JX705', '10:00');
  await insertRecord('SEASONAL-CONTROL-1', 'seasonal', 'active', null, 'JX706', '11:00');
  await insertRecord('MANUAL-PHANTOM-1', 'manual', 'active', null, 'JX999', '12:00');
  await db.query(
    `insert into public.season_modifications(season_id,leg_id,action) values
      ($1,'SEASONAL-PHANTOM-1','deleted'),($1,'SEASONAL-PHANTOM-2','deleted'),($1,'MANUAL-PHANTOM-1','deleted')`,
    [seasonId]
  );

  // Phase B: the migration repairs pre-existing overlay deletes and becomes the
  // authority for every later op.
  await db.exec(migration);

  assert.deepEqual(await legState('SEASONAL-PHANTOM-1'), {
    status: 'deleted',
    action: 'deleted',
    deletion_reason: 'overlay_deleted',
    lifecycle_changed_by: null,
    rebasable: true,
  });
  assert.deepEqual(await legState('SEASONAL-PHANTOM-2'), {
    status: 'deleted',
    action: 'deleted',
    deletion_reason: 'overlay_deleted',
    lifecycle_changed_by: null,
    rebasable: true,
  });
  assert.deepEqual(await legState('MANUAL-PHANTOM-1'), {
    status: 'deleted',
    action: 'deleted',
    deletion_reason: 'overlay_deleted',
    lifecycle_changed_by: null,
    rebasable: true,
  });
  assert.deepEqual(await legState('SEASONAL-CONTROL-1'), {
    status: 'active',
    action: null,
    deletion_reason: null,
    lifecycle_changed_by: null,
    rebasable: false,
  });

  // Phase C1: a live delete is now canonical and stays idempotent.
  await applyOp({ type: 'modification', mod: { legId: 'SEASONAL-CONTROL-1', action: 'deleted' } });
  assert.deepEqual(await legState('SEASONAL-CONTROL-1'), {
    status: 'deleted',
    action: 'deleted',
    deletion_reason: 'overlay_deleted',
    lifecycle_changed_by: userId,
    rebasable: true,
  });
  await applyOp({ type: 'modification', mod: { legId: 'SEASONAL-CONTROL-1', action: 'deleted' } });
  assert.deepEqual(await legState('SEASONAL-CONTROL-1'), {
    status: 'deleted',
    action: 'deleted',
    deletion_reason: 'overlay_deleted',
    lifecycle_changed_by: userId,
    rebasable: true,
  });

  // Phase C2: the operator Undo (no-op modified overlay) restores the row.
  await applyOp({ type: 'modification', mod: { legId: 'SEASONAL-CONTROL-1', action: 'modified', gate: 4 } });
  assert.deepEqual(await legState('SEASONAL-CONTROL-1'), {
    status: 'active',
    action: null,
    deletion_reason: null,
    lifecycle_changed_by: userId,
    rebasable: false,
  });
  const overlay = await db.query(`select action from public.season_modifications where leg_id = 'SEASONAL-CONTROL-1'`);
  assert.deepEqual(overlay.rows, [{ action: 'modified' }]);
  await applyOp({ type: 'modification', mod: { legId: 'SEASONAL-CONTROL-1', action: 'deleted' } });
  assert.equal((await legState('SEASONAL-CONTROL-1')).status, 'deleted', 'delete after undo is canonical again');

  // Phase C3: a manual flight keeps its added action through delete and undo.
  await db.query(`select public.save_canonical_season_modification_v1($1,$2::jsonb)`, [
    seasonId,
    JSON.stringify({
      legId: 'MANUAL-ADD-1',
      action: 'added',
      addedLeg: {
        id: 'MANUAL-ADD-1',
        type: 'D',
        airline: 'JX',
        flightNumber: 'JX999',
        rawFlightNumber: '999',
        route: 'TPE',
        schedule: '09:00',
        aircraft: '321',
        category: 'J',
        date: '2026-10-25',
        scheduledDate: '2026-10-25',
        scheduledTime: '09:00',
        operationalDate: '2026-10-25',
        iataSeasonCode: 'W26',
      },
    }),
  ]);
  await applyOp({ type: 'modification', mod: { legId: 'MANUAL-ADD-1', action: 'deleted' } });
  assert.equal((await legState('MANUAL-ADD-1')).status, 'deleted', 'manual delete is canonical');
  await applyOp({ type: 'modification', mod: { legId: 'MANUAL-ADD-1', action: 'modified', gate: 2 } });
  assert.deepEqual(await legState('MANUAL-ADD-1'), {
    status: 'active',
    action: 'added',
    deletion_reason: null,
    lifecycle_changed_by: userId,
    rebasable: false,
  });

  // Phase C4: a deletion owned by an import generation is not resurrected by a
  // stale edit, and a stale undo without overlay lineage is not restored.
  await insertRecord('IMPORT-DELETED-1', 'seasonal', 'deleted', 'deleted', 'JX707', '13:00');
  await db.query(
    `update public.season_flight_records set deletion_reason = 'daily_replacement' where record_id = 'IMPORT-DELETED-1'`
  );
  await db.query(
    `insert into public.season_modifications(season_id,leg_id,action) values ($1,'IMPORT-DELETED-1','deleted')`,
    [seasonId]
  );
  await applyOp({ type: 'modification', mod: { legId: 'IMPORT-DELETED-1', action: 'modified', gate: 9 } });
  assert.deepEqual(await legState('IMPORT-DELETED-1'), {
    status: 'deleted',
    action: 'deleted',
    deletion_reason: 'daily_replacement',
    lifecycle_changed_by: null,
    rebasable: false,
  });

  // Phase C5: dropping the overlay is the canonical Undo of both directions.
  await applyOp({ type: 'modificationDelete', legId: 'SEASONAL-PHANTOM-1' });
  assert.deepEqual(await legState('SEASONAL-PHANTOM-1'), {
    status: 'active',
    action: null,
    deletion_reason: null,
    lifecycle_changed_by: userId,
    rebasable: false,
  });
  assert.equal(
    (await db.query(`select count(*)::integer as count from public.season_modifications where leg_id = 'SEASONAL-PHANTOM-1'`))
      .rows[0].count,
    0
  );
  // The overlay left there was an edit, not the add, so removing it must not
  // delete the flight.
  await applyOp({ type: 'modificationDelete', legId: 'MANUAL-ADD-1' });
  assert.deepEqual(await legState('MANUAL-ADD-1'), {
    status: 'active',
    action: 'added',
    deletion_reason: null,
    lifecycle_changed_by: userId,
    rebasable: false,
  });

  await db.query(`select public.save_canonical_season_modification_v1($1,$2::jsonb)`, [
    seasonId,
    JSON.stringify({
      legId: 'MANUAL-ADD-2',
      action: 'added',
      addedLeg: {
        id: 'MANUAL-ADD-2',
        type: 'D',
        airline: 'JX',
        flightNumber: 'JX998',
        rawFlightNumber: '998',
        route: 'TPE',
        schedule: '14:00',
        aircraft: '321',
        category: 'J',
        date: '2026-10-25',
        scheduledDate: '2026-10-25',
        scheduledTime: '14:00',
        operationalDate: '2026-10-25',
        iataSeasonCode: 'W26',
      },
    }),
  ]);
  await applyOp({ type: 'modificationDelete', legId: 'MANUAL-ADD-2' });
  assert.deepEqual(await legState('MANUAL-ADD-2'), {
    status: 'deleted',
    action: 'deleted',
    deletion_reason: 'manual_undo',
    lifecycle_changed_by: userId,
    rebasable: false,
  });

  // Phase C6: a legacy overlay without a canonical row must keep dispatching
  // exactly as before.
  await applyOp({ type: 'modification', mod: { legId: 'LEGACY-NO-ROW', action: 'modified', gate: 3 } });
  assert.deepEqual(
    (await db.query(`select action from public.season_modifications where leg_id = 'LEGACY-NO-ROW'`)).rows,
    [{ action: 'modified' }]
  );
} finally {
  await db.close();
}
