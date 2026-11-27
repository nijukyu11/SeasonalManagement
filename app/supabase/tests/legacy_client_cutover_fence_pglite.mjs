// Legacy desktop-client fence after M10 cutover (PGlite behavioral suite).
// Proves:
// 1. Gate OFF: every wrapped legacy entry point returns exactly what the original body returns,
//    with identical argument contract (defaults) and EXECUTE grantees.
// 2. Gate ON: every season (including one created with no legacy data) rejects legacy readers/sync
//    with 55000 CLIENT_UPGRADE_REQUIRED instead of returning frozen legacy rows.
// 3. Reversal restores reads; rollback restores the original functions and reapply succeeds.

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { buildM0Fixture, M0_FIXTURE } from './seasonal_operational_separation_fixture.mjs';
import { stripPsqlMetaCommands } from './seasonal_operational_separation_test_support.mjs';

// Run: node supabase/tests/legacy_client_cutover_fence_pglite.mjs
const MIGRATION = new URL('../migrations/20261121090000_legacy_client_cutover_fence_v1.sql', import.meta.url);
const ROLLBACK = new URL('../migrations/20261121090000_legacy_client_cutover_fence_v1.rollback.sql', import.meta.url);
const EMPTY_SEASON = 'season-fence-empty';

const WRAPPED = [
  ['get_season_workspace_snapshot', 'text, integer'],
  ['get_season_change_event_page', 'text, bigint, bigint, integer'],
  ['get_season_schedule_allocation_window_v2', 'text, text, text, text, integer, text, text, smallint, integer, bigint'],
  ['sync_season_workspace', 'text, integer, jsonb'],
  ['sync_season_workspace_v2', 'text, text, bigint, jsonb'],
];

const ctx = await buildM0Fixture();
const { db } = ctx;
const asAdmin = () => db.exec('reset role');
const asWriter = async () => {
  await db.exec('set role authenticated');
  await db.query(`select pg_catalog.set_config('request.jwt.claim.sub',$1,false)`, [M0_FIXTURE.writerId]);
  await db.query(`select pg_catalog.set_config('request.jwt.claim.role','authenticated',false)`);
};
const one = async (sql, params = []) => (await db.query(sql, params)).rows[0];

// Read-only calls that an old client issues on load/refresh.
const readers = (seasonId) => [
  ['snapshot', `select public.%s($1, 5) as r`, 'get_season_workspace_snapshot', [seasonId]],
  ['event page', `select public.%s($1, 0, 1000000, 50) as r`, 'get_season_change_event_page', [seasonId]],
  ['window v2', `select public.%s($1, '2026-10-25', '2026-10-31', 'all', 500) as r`, 'get_season_schedule_allocation_window_v2', [seasonId]],
];
const call = (template, fn, params) => one(template.replace('%s', fn), params);

try {
  await asAdmin();
  await db.query(`insert into public.seasons(id,season_code,name,file_name,uploaded_at,effective_start,effective_end,total_legs,total_source_rows,data_version)
    values ($1,'S25','S25','',0,'2025-03-30','2025-10-25',0,0,0)`, [EMPTY_SEASON]);

  // --- 1. Contract parity with the gate OFF --------------------------------
  for (const [name, args] of WRAPPED) {
    const row = await one(`
      select pg_get_function_arguments(w.oid) as wrapper_args, pg_get_function_arguments(o.oid) as original_args,
             pg_get_function_result(w.oid) as wrapper_result,
             array(select acl.grantee::regrole::text || ':' || acl.privilege_type
                   from aclexplode(coalesce(w.proacl, acldefault('f', w.proowner))) acl order by 1) as wrapper_acl,
             array(select acl.grantee::regrole::text || ':' || acl.privilege_type
                   from aclexplode(coalesce(o.proacl, acldefault('f', o.proowner))) acl order by 1) as original_acl
      from pg_proc w, pg_proc o
      where w.oid = $1::regprocedure and o.oid = $2::regprocedure`,
      [`public.${name}(${args})`, `public.legacy_precutover_${name}(${args})`]);
    assert.equal(row.wrapper_args, row.original_args, `${name}: argument contract incl. defaults`);
    assert.equal(row.wrapper_result, 'jsonb', `${name}: result type`);
    assert.deepEqual(row.wrapper_acl, row.original_acl, `${name}: EXECUTE grantees`);
  }

  await asWriter();
  for (const [label, template, fn, params] of readers(M0_FIXTURE.seasonW26)) {
    const wrapped = (await call(template, fn, params)).r;
    const original = (await call(template, `legacy_precutover_${fn}`, params)).r;
    assert.deepEqual(wrapped, original, `gate OFF ${label}: wrapper must equal the original body`);
  }
  // Gate OFF sync must behave exactly like the original body (result or SQLSTATE).
  const outcome = async (fn) => {
    await db.exec('savepoint fence_sync');
    try {
      const r = await one(`select public.${fn}($1, 'fence-client', 0, '[]'::jsonb) as r`, [M0_FIXTURE.seasonW26]);
      await db.exec('release savepoint fence_sync');
      return { ok: r.r };
    } catch (err) {
      await db.exec('rollback to savepoint fence_sync');
      return { code: err.code, message: err.message };
    }
  };
  await db.exec('begin');
  const syncWrapped = await outcome('sync_season_workspace_v2');
  const syncOriginal = await outcome('legacy_precutover_sync_season_workspace_v2');
  await db.exec('rollback');
  console.log('gate OFF sync v2 outcome:', syncWrapped.code ?? 'ok', syncWrapped.message ?? '');
  assert.deepEqual(syncWrapped, syncOriginal, 'gate OFF sync v2: wrapper must behave like the original');

  // --- 2. Gate ON ------------------------------------------------------------
  await asAdmin();
  await db.query(`select public.run_seasonal_operational_backfill_v1('2026-10-01', $1::uuid)`, [M0_FIXTURE.writerId]);
  await db.query('select reporting.refresh_operational_canonical_legs_v1()');
  assert.equal((await one(`select reporting.cutover_operational_readers_v1('fence-suite') as r`)).r.status, 'cutover_success');
  const workspaces = await one(`select count(*)::int as c from public.seasonal_draft_workspace where season_id = any($1)`, [[M0_FIXTURE.seasonW26, EMPTY_SEASON]]);
  assert.equal(workspaces.c, 2, 'every season gets a Planning draft workspace, so a per-season fence could never exempt any season');

  await asWriter();
  const fenced = (err) => err.code === '55000' && /^CLIENT_UPGRADE_REQUIRED/.test(err.message);
  for (const seasonId of [M0_FIXTURE.seasonW26, EMPTY_SEASON]) {
    for (const [label, template, fn, params] of readers(seasonId)) {
      await assert.rejects(() => call(template, fn, params), fenced, `gate ON ${label} must fail closed for ${seasonId}`);
    }
  }
  await assert.rejects(() => db.query(`select public.sync_season_workspace_v2($1, 'fence-client', 0, '[]'::jsonb)`, [M0_FIXTURE.seasonW26]), fenced, 'sync v2 fenced');
  await assert.rejects(() => db.query(`select public.sync_season_workspace($1, 0, '[]'::jsonb)`, [M0_FIXTURE.seasonW26]), fenced, 'sync v1 fenced');

  // --- 3. Reversal and rollback ----------------------------------------------
  await asAdmin();
  assert.equal((await one(`select reporting.reverse_operational_readers_v1('fence suite reverse') as r`)).r.status, 'reversed');
  await asWriter();
  for (const [label, template, fn, params] of readers(M0_FIXTURE.seasonW26)) {
    assert.ok((await call(template, fn, params)).r, `after reversal ${label} reads again`);
  }

  await asAdmin();
  await db.exec(stripPsqlMetaCommands(await readFile(ROLLBACK, 'utf8')));
  for (const [name, args] of WRAPPED) {
    const row = await one(`select prosrc ~ 'assert_legacy_workspace_client_allowed_v1' as wrapped,
        to_regprocedure($2) is null as renamed_gone,
        array(select (aclexplode(coalesce(proacl, acldefault('f', proowner)))).grantee::regrole::text order by 1) as acl
      from pg_proc where oid = $1::regprocedure`, [`public.${name}(${args})`, `public.legacy_precutover_${name}(${args})`]);
    assert.equal(row.wrapped, false, `${name}: rollback restores the original body`);
    assert.equal(row.renamed_gone, true, `${name}: rollback removes the renamed copy`);
    assert.ok(row.acl.includes('authenticated'), `${name}: rollback keeps authenticated EXECUTE`);
  }
  assert.equal((await one(`select to_regprocedure('public.assert_legacy_workspace_client_allowed_v1()') is null as gone`)).gone, true);
  await db.exec(await readFile(MIGRATION, 'utf8'));
  assert.equal((await one(`select to_regprocedure('public.legacy_precutover_get_season_workspace_snapshot(text, integer)') is not null as ok`)).ok, true, 'reapply succeeds');

  console.log('Legacy client cutover fence suite PASS: gate OFF parity (body/args/ACL), gate ON fail-closed for every season, reversal and rollback/reapply.');
} finally {
  await db.close();
}
