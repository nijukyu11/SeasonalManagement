import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createSupabasePGlite } from './pglite_test_support.mjs';

const migrationSql = await readFile(
  new URL('../migrations/20260830193000_public_traffic_aircraft_type_snapshot.sql', import.meta.url),
  'utf8',
);
const db = await createSupabasePGlite();

try {
  await db.exec(`
    create role service_role nologin;
    create schema reporting;

    create table public.seasons (data_version integer);
    create table public.season_change_events (server_seq bigint primary key);
    create table public.operational_route_countries (route text primary key, country text);
    create table public.operational_aircraft_groups (id text primary key, name text not null);
    create table public.operational_aircraft_group_types (
      group_id text not null references public.operational_aircraft_groups(id),
      aircraft_type text not null,
      primary key (group_id, aircraft_type)
    );
    create table reporting.public_traffic_duplicate_quarantine (candidate_count integer not null);
    create table reporting.public_traffic_ranked_candidates (
      business_leg_key text primary key,
      ops_date date not null,
      type text not null,
      airline text,
      effective_route text,
      effective_aircraft text,
      local_minutes integer,
      scheduled_local_at timestamp without time zone,
      effective_pax integer,
      authoritative_server_seq bigint,
      candidate_rank integer not null,
      candidate_count integer not null,
      missing_recency_count integer not null,
      max_recency_count integer not null,
      effective_action text
    );
    create table reporting.public_traffic_projection_state (
      projection_name text primary key,
      status text not null,
      source_data_version integer,
      source_watermark bigint,
      refreshed_at timestamptz,
      snapshot_rows bigint,
      error text
    );

    insert into public.seasons values (7);
    insert into public.season_change_events values (10);
    insert into public.operational_route_countries values ('HAN', 'Việt Nam');
    insert into public.operational_aircraft_groups values ('narrowbody', 'Narrowbody');
    insert into public.operational_aircraft_group_types values ('narrowbody', 'A321');
    insert into reporting.public_traffic_duplicate_quarantine values (2);
    insert into reporting.public_traffic_projection_state (
      projection_name, status, error
    ) values (
      'public_traffic_effective', 'fresh', null
    );
    insert into reporting.public_traffic_ranked_candidates values (
      'leg-a', date '2026-08-30', 'A', 'vn', 'han', 'a321', 360,
      timestamp '2026-08-30 06:00:00', 0, 10, 1, 1, 0, 1, null
    );

    create materialized view reporting.public_traffic_effective as
    select
      ranked.business_leg_key,
      ranked.ops_date,
      ranked.type,
      upper(btrim(ranked.airline)) as airline,
      upper(btrim(ranked.effective_route)) as route,
      coalesce(nullif(btrim(countries.country), ''), 'Unknown') as country,
      coalesce(nullif(btrim(groups.ac_group), ''), 'Unknown') as aircraft_group,
      ranked.local_minutes,
      (ranked.local_minutes + 1020) % 1440 as utc_minutes,
      ranked.scheduled_local_at,
      ranked.effective_pax as pax,
      case when ranked.effective_pax is not null then 'reported' else 'unknown' end as pax_status,
      ranked.authoritative_server_seq,
      statement_timestamp() as snapshot_refreshed_at,
      (select max(events.server_seq)::bigint from public.season_change_events events)
        as snapshot_source_watermark,
      (select coalesce(sum(quarantine.candidate_count), 0)::integer
        from reporting.public_traffic_duplicate_quarantine quarantine)
        as snapshot_quarantined_candidate_count
    from reporting.public_traffic_ranked_candidates ranked
    left join public.operational_route_countries countries
      on upper(countries.route) = upper(ranked.effective_route)
    left join lateral (
      select aircraft_groups.name as ac_group
      from public.operational_aircraft_group_types aircraft_types
      join public.operational_aircraft_groups aircraft_groups
        on aircraft_groups.id = aircraft_types.group_id
      where upper(aircraft_types.aircraft_type) = upper(ranked.effective_aircraft)
      order by aircraft_groups.name
      limit 1
    ) groups on true
    where ranked.candidate_rank = 1
      and not (
        ranked.candidate_count > 1
        and (ranked.missing_recency_count > 0 or ranked.max_recency_count > 1)
      )
      and ranked.effective_action is distinct from 'deleted';

    create unique index public_traffic_effective_business_leg_idx
      on reporting.public_traffic_effective (business_leg_key);
    create index public_traffic_effective_ops_date_idx
      on reporting.public_traffic_effective (ops_date);
    create index public_traffic_effective_airline_ops_idx
      on reporting.public_traffic_effective (airline, ops_date);
    create index public_traffic_effective_route_ops_idx
      on reporting.public_traffic_effective (route, ops_date);
    create index public_traffic_effective_country_ops_idx
      on reporting.public_traffic_effective (country, ops_date);
    create index public_traffic_effective_aircraft_group_ops_idx
      on reporting.public_traffic_effective (aircraft_group, ops_date);

    create function reporting.test_effective_count()
    returns bigint
    language sql
    stable
    as $$ select count(*) from reporting.public_traffic_effective $$;

    insert into reporting.public_traffic_ranked_candidates values (
      'leg-d', date '2026-08-30', 'D', 'vn', 'sgn', ' ', 420,
      timestamp '2026-08-30 07:00:00', null, 10, 1, 1, 0, 1, null
    );
  `);

  assert.equal(
    (await db.query('select reporting.test_effective_count()::integer as count')).rows[0].count,
    1,
    'the old snapshot fixture must remain stale before the migration',
  );
  const originalOid = (await db.query(`select 'reporting.public_traffic_effective'::regclass::oid as oid`)).rows[0].oid;

  await db.exec(`
    prepare public_traffic_effective_count as
      select count(*)::integer as count from reporting.public_traffic_effective;
    create view reporting.blocking_public_traffic_dependency as
      select business_leg_key from reporting.public_traffic_effective;
  `);
  await assert.rejects(
    db.exec(migrationSql),
    /depend on materialized view|cannot drop materialized view/i,
    'an unexpected relation dependency must abort the complete cutover rather than cascade-drop it',
  );
  const blockedCutover = (await db.query(`
    select to_regclass('reporting.public_traffic_effective_aircraft_stage') is null as no_stage,
      to_regclass('reporting.public_traffic_effective_pre_aircraft_type') is null as no_rollback,
      exists (
        select 1 from pg_catalog.pg_attribute
        where attrelid = 'reporting.public_traffic_effective'::regclass
          and attname = 'aircraft_type' and attnum > 0 and not attisdropped
      ) as migrated
  `)).rows[0];
  assert.equal(blockedCutover.migrated, false, 'the dependency guard must leave the original canonical MV intact');
  assert.equal(blockedCutover.no_stage, true, 'the failed cutover transaction must roll back the populated stage');
  assert.equal(blockedCutover.no_rollback, true, 'the failed cutover transaction must roll back the rollback MV');
  await db.exec('drop view reporting.blocking_public_traffic_dependency');

  await db.exec(migrationSql);
  await db.exec(migrationSql);

  const migratedOid = (await db.query(`select 'reporting.public_traffic_effective'::regclass::oid as oid`)).rows[0].oid;
  assert.notEqual(migratedOid, originalOid, 'DROP plus rename must replace the canonical OID');

  const currentColumns = await db.query(`
    select attname
    from pg_catalog.pg_attribute
    where attrelid = 'reporting.public_traffic_effective'::regclass
      and attnum > 0 and not attisdropped
    order by attnum
  `);
  assert.equal(currentColumns.rows.some((row) => row.attname === 'aircraft_type'), true);
  assert.deepEqual(
    (await db.query(`
      select business_leg_key, aircraft_type
      from reporting.public_traffic_effective
      order by business_leg_key
    `)).rows,
    [
      { business_leg_key: 'leg-a', aircraft_type: 'A321' },
      { business_leg_key: 'leg-d', aircraft_type: 'Unknown' },
    ],
    'aircraft type must be normalized and captured in the physical snapshot',
  );
  assert.equal(
    (await db.query('select reporting.test_effective_count()::integer as count')).rows[0].count,
    2,
    'existing SQL functions must resolve the canonical name after the atomic swap',
  );
  assert.equal(
    (await db.query('execute public_traffic_effective_count')).rows[0].count,
    2,
    'a prepared statement must be invalidated and replanned against the new canonical OID',
  );
  assert.equal(
    (await db.query('select count(*)::integer as count from reporting.public_traffic_effective_pre_aircraft_type')).rows[0].count,
    2,
    'the independently populated old definition must remain available for explicit rollback',
  );
  assert.equal(
    (await db.query(`
      select exists (
        select 1 from pg_catalog.pg_attribute
        where attrelid = 'reporting.public_traffic_effective_pre_aircraft_type'::regclass
          and attname = 'aircraft_type' and attnum > 0 and not attisdropped
      ) as present
    `)).rows[0].present,
    false,
  );
  assert.match(
    (await db.query(`select pg_get_viewdef('reporting.public_traffic_effective_pre_aircraft_type'::regclass) as definition`)).rows[0].definition,
    /public_traffic_ranked_candidates/,
    'the rollback MV must have its own source definition rather than depend on the dropped canonical OID',
  );
  assert.deepEqual(
    (await db.query(`
      select status, source_data_version, source_watermark, snapshot_rows, error
      from reporting.public_traffic_projection_state
      where projection_name = 'public_traffic_effective'
    `)).rows,
    [{
      status: 'fresh',
      source_data_version: 7,
      source_watermark: 10,
      snapshot_rows: 2,
      error: null,
    }],
  );
  assert.equal(
    (await db.query(`
      select indisunique
      from pg_catalog.pg_index
      where indexrelid = 'reporting.public_traffic_effective_business_leg_idx'::regclass
    `)).rows[0].indisunique,
    true,
  );

  for (const role of ['anon', 'authenticated', 'service_role']) {
    assert.equal(
      (await db.query(
        `select has_table_privilege($1, 'reporting.public_traffic_effective', 'select') as allowed`,
        [role],
      )).rows[0].allowed,
      false,
      `${role} must not gain direct snapshot SELECT`,
    );
  }

  const idempotency = (await db.query(`
    select to_regclass('reporting.public_traffic_effective_aircraft_stage') is null as stage_absent,
      count(*) filter (where relname = 'public_traffic_effective_pre_aircraft_type')::integer as rollback_count
    from pg_catalog.pg_class
    where relnamespace = 'reporting'::regnamespace
  `)).rows[0];
  assert.equal(idempotency.stage_absent, true, 'an idempotent re-apply must not leave a stage object');
  assert.equal(idempotency.rollback_count, 1, 'an idempotent re-apply must retain exactly one rollback MV');

  await db.exec(`
    update reporting.public_traffic_ranked_candidates
    set effective_aircraft = 'B738'
    where business_leg_key = 'leg-a';
  `);
  assert.equal(
    (await db.query(`select aircraft_type from reporting.public_traffic_effective where business_leg_key = 'leg-a'`)).rows[0].aircraft_type,
    'A321',
    'live source edits must not leak ahead of the published snapshot',
  );

  await db.exec('refresh materialized view concurrently reporting.public_traffic_effective');
  assert.equal(
    (await db.query(`select aircraft_type from reporting.public_traffic_effective where business_leg_key = 'leg-a'`)).rows[0].aircraft_type,
    'B738',
    'a controlled refresh must publish the new aircraft type',
  );

  await db.exec(`
    begin;
    set local lock_timeout = '5s';
    drop materialized view reporting.public_traffic_effective;
    alter materialized view reporting.public_traffic_effective_pre_aircraft_type
      rename to public_traffic_effective;
    alter index reporting.public_traffic_effective_pre_ac_business_leg_idx
      rename to public_traffic_effective_business_leg_idx;
    alter index reporting.public_traffic_effective_pre_ac_ops_date_idx
      rename to public_traffic_effective_ops_date_idx;
    alter index reporting.public_traffic_effective_pre_ac_airline_ops_idx
      rename to public_traffic_effective_airline_ops_idx;
    alter index reporting.public_traffic_effective_pre_ac_route_ops_idx
      rename to public_traffic_effective_route_ops_idx;
    alter index reporting.public_traffic_effective_pre_ac_country_ops_idx
      rename to public_traffic_effective_country_ops_idx;
    alter index reporting.public_traffic_effective_pre_ac_aircraft_group_ops_idx
      rename to public_traffic_effective_aircraft_group_ops_idx;
    commit;
  `);
  assert.equal(
    (await db.query(`
      select exists (
        select 1 from pg_catalog.pg_attribute
        where attrelid = 'reporting.public_traffic_effective'::regclass
          and attname = 'aircraft_type' and attnum > 0 and not attisdropped
      ) as present
    `)).rows[0].present,
    false,
    'the rehearsed rollback must restore the prior 16-column snapshot contract',
  );
  assert.equal(
    (await db.query('select reporting.test_effective_count()::integer as count')).rows[0].count,
    2,
    'existing functions must re-resolve the canonical MV after rollback',
  );
  await db.exec('refresh materialized view concurrently reporting.public_traffic_effective');

  console.log(JSON.stringify({
    suite: 'public-traffic-aircraft-type-snapshot-pglite',
    status: 'passed',
  }));
} finally {
  await db.close();
}
