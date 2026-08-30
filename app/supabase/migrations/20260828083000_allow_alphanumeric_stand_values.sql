create temporary table daily_stand_reporting_view_defs (
  view_name text primary key,
  definition text not null,
  reloptions text,
  owner_name text not null,
  recreated boolean not null default false
) on commit drop;

create temporary table daily_stand_reporting_matview_defs (
  view_name text primary key,
  definition text not null,
  reloptions text,
  owner_name text not null,
  is_populated boolean not null,
  recreated boolean not null default false
) on commit drop;

create temporary table daily_stand_reporting_matview_indexes (
  index_name text primary key,
  definition text not null
) on commit drop;

create temporary table daily_stand_reporting_grants (
  object_kind text not null,
  object_name text not null,
  grantee_name text not null,
  privilege_type text not null,
  is_grantable boolean not null
) on commit drop;

insert into daily_stand_reporting_view_defs (view_name, definition, reloptions, owner_name)
select
  views.viewname,
  views.definition,
  array_to_string(classes.reloptions, ','),
  owners.rolname
from pg_catalog.pg_views views
join pg_catalog.pg_class classes
  on classes.relname = views.viewname
join pg_catalog.pg_namespace namespaces
  on namespaces.oid = classes.relnamespace
 and namespaces.nspname = views.schemaname
join pg_catalog.pg_roles owners on owners.oid = classes.relowner
where views.schemaname = 'reporting';

with recursive dependent_relations(oid) as (
  select to_regclass('reporting.effective_flight_operations')
  union
  select rewrites.ev_class
  from dependent_relations sources
  join pg_catalog.pg_depend dependencies on dependencies.refobjid = sources.oid
  join pg_catalog.pg_rewrite rewrites on rewrites.oid = dependencies.objid
  where sources.oid is not null
)
insert into daily_stand_reporting_matview_defs (view_name, definition, reloptions, owner_name, is_populated)
select
  matviews.matviewname,
  matviews.definition,
  array_to_string(classes.reloptions, ','),
  owners.rolname,
  matviews.ispopulated
from pg_catalog.pg_matviews matviews
join pg_catalog.pg_class classes on classes.relname = matviews.matviewname
join pg_catalog.pg_namespace namespaces
  on namespaces.oid = classes.relnamespace
 and namespaces.nspname = matviews.schemaname
join pg_catalog.pg_roles owners on owners.oid = classes.relowner
where matviews.schemaname = 'reporting'
  and classes.oid in (select oid from dependent_relations);

insert into daily_stand_reporting_matview_indexes (index_name, definition)
select indexes.indexname, indexes.indexdef
from pg_catalog.pg_indexes indexes
join daily_stand_reporting_matview_defs matviews on matviews.view_name = indexes.tablename
where indexes.schemaname = 'reporting';

insert into daily_stand_reporting_grants (object_kind, object_name, grantee_name, privilege_type, is_grantable)
select
  case classes.relkind when 'm' then 'materialized view' else 'view' end,
  classes.relname,
  case when grants.grantee = 0 then 'PUBLIC' else grantees.rolname end,
  grants.privilege_type,
  grants.is_grantable
from pg_catalog.pg_class classes
join pg_catalog.pg_namespace namespaces on namespaces.oid = classes.relnamespace
cross join lateral pg_catalog.aclexplode(
  coalesce(classes.relacl, pg_catalog.acldefault('r', classes.relowner))
) grants
left join pg_catalog.pg_roles grantees on grantees.oid = grants.grantee
where namespaces.nspname = 'reporting'
  and (
    classes.relname in (select view_name from daily_stand_reporting_view_defs)
    or classes.relname in (select view_name from daily_stand_reporting_matview_defs)
  );

do $$
declare
  v_row record;
begin
  for v_row in select view_name from daily_stand_reporting_matview_defs order by view_name
  loop
    execute format('drop materialized view if exists reporting.%I cascade', v_row.view_name);
  end loop;
end;
$$;

drop view if exists reporting.effective_flight_operations cascade;

alter table public.season_flight_records
  alter column stand type text using nullif(upper(btrim(stand::text)), '');
alter table public.season_modifications
  alter column stand type text using nullif(upper(btrim(stand::text)), '');
alter table public.season_modification_added_legs
  alter column stand type text using nullif(upper(btrim(stand::text)), '');
alter table public.operational_stand_gate_mappings
  alter column stand type text using upper(btrim(stand::text));

alter table public.season_flight_records drop constraint if exists season_flight_records_stand_format_check;
alter table public.season_flight_records add constraint season_flight_records_stand_format_check
  check (stand is null or stand ~ '^[1-9][0-9]*[A-Z]?$');
alter table public.season_modifications drop constraint if exists season_modifications_stand_format_check;
alter table public.season_modifications add constraint season_modifications_stand_format_check
  check (stand is null or stand ~ '^[1-9][0-9]*[A-Z]?$');
alter table public.season_modification_added_legs drop constraint if exists season_modification_added_legs_stand_format_check;
alter table public.season_modification_added_legs add constraint season_modification_added_legs_stand_format_check
  check (stand is null or stand ~ '^[1-9][0-9]*[A-Z]?$');
alter table public.operational_stand_gate_mappings drop constraint if exists operational_stand_gate_mappings_stand_format_check;
alter table public.operational_stand_gate_mappings add constraint operational_stand_gate_mappings_stand_format_check
  check (stand ~ '^[1-9][0-9]*[A-Z]?$');

update daily_stand_reporting_view_defs
set definition = replace(definition, 'NULL::integer AS mod_stand', 'NULL::text AS mod_stand')
where view_name = 'effective_flight_operations';

do $$
declare
  v_definition text;
  v_updated text;
begin
  select pg_catalog.pg_get_functiondef('public.upsert_season_flight_record_from_json(text,jsonb)'::regprocedure)
    into v_definition;
  v_updated := replace(
    v_definition,
    'nullif(record_payload->>''stand'', '''')::integer',
    'nullif(pg_catalog.upper(pg_catalog.btrim(record_payload->>''stand'')), '''')'
  );
  if v_updated = v_definition and position('btrim(record_payload->>''stand'')' in v_definition) = 0 then
    raise exception 'Could not update stand cast in upsert_season_flight_record_from_json';
  end if;
  if v_updated <> v_definition then execute v_updated; end if;

  select pg_catalog.pg_get_functiondef('public.upsert_season_modification_from_json(text,jsonb)'::regprocedure)
    into v_definition;
  v_updated := replace(
    v_definition,
    'nullif(mod_payload->>''stand'', '''')::integer',
    'nullif(pg_catalog.upper(pg_catalog.btrim(mod_payload->>''stand'')), '''')'
  );
  v_updated := replace(
    v_updated,
    'nullif(added_leg->>''stand'', '''')::integer',
    'nullif(pg_catalog.upper(pg_catalog.btrim(added_leg->>''stand'')), '''')'
  );
  if v_updated = v_definition and position('btrim(mod_payload->>''stand'')' in v_definition) = 0 then
    raise exception 'Could not update stand casts in upsert_season_modification_from_json';
  end if;
  if v_updated <> v_definition then execute v_updated; end if;
end;
$$;

do $$
declare
  v_row record;
  v_remaining integer;
  v_progress integer;
  v_sql text;
begin
  loop
    select count(*) into v_remaining from daily_stand_reporting_view_defs where not recreated;
    exit when v_remaining = 0;
    v_progress := 0;
    for v_row in select * from daily_stand_reporting_view_defs where not recreated order by view_name
    loop
      v_sql := format(
        'create or replace view reporting.%I%s as %s',
        v_row.view_name,
        case when coalesce(v_row.reloptions, '') = '' then '' else format(' with (%s)', v_row.reloptions) end,
        v_row.definition
      );
      begin
        execute v_sql;
        update daily_stand_reporting_view_defs set recreated = true where view_name = v_row.view_name;
        v_progress := v_progress + 1;
      exception
        when undefined_table or undefined_column or invalid_object_definition then
          null;
      end;
    end loop;
    if v_progress = 0 then
      raise exception 'Could not recreate % dependent reporting views after stand migration', v_remaining;
    end if;
  end loop;
end;
$$;

do $$
declare
  v_row record;
  v_remaining integer;
  v_progress integer;
  v_sql text;
begin
  loop
    select count(*) into v_remaining from daily_stand_reporting_matview_defs where not recreated;
    exit when v_remaining = 0;
    v_progress := 0;
    for v_row in select * from daily_stand_reporting_matview_defs where not recreated order by view_name
    loop
      v_sql := format(
        'create materialized view reporting.%I%s as %s %s',
        v_row.view_name,
        case when coalesce(v_row.reloptions, '') = '' then '' else format(' with (%s)', v_row.reloptions) end,
        regexp_replace(rtrim(v_row.definition), ';$', ''),
        case when v_row.is_populated then 'with data' else 'with no data' end
      );
      begin
        execute v_sql;
        update daily_stand_reporting_matview_defs set recreated = true where view_name = v_row.view_name;
        v_progress := v_progress + 1;
      exception
        when undefined_table or undefined_column or invalid_object_definition then
          null;
      end;
    end loop;
    if v_progress = 0 then
      raise exception 'Could not recreate % dependent reporting materialized views after stand migration', v_remaining;
    end if;
  end loop;
end;
$$;

do $$
declare
  v_row record;
  v_target text;
  v_grantee text;
begin
  for v_row in select * from daily_stand_reporting_matview_indexes order by index_name
  loop
    execute v_row.definition;
  end loop;

  for v_row in
    select 'view'::text as object_kind, view_name as object_name, owner_name
    from daily_stand_reporting_view_defs
    union all
    select 'materialized view', view_name, owner_name
    from daily_stand_reporting_matview_defs
  loop
    v_target := format('%s reporting.%I', v_row.object_kind, v_row.object_name);
    execute format('alter %s owner to %I', v_target, v_row.owner_name);
  end loop;

  for v_row in
    select
      case classes.relkind when 'm' then 'materialized view' else 'view' end as object_kind,
      classes.relname as object_name,
      case when grants.grantee = 0 then 'PUBLIC' else grantees.rolname end as grantee_name
    from pg_catalog.pg_class classes
    join pg_catalog.pg_namespace namespaces on namespaces.oid = classes.relnamespace
    cross join lateral pg_catalog.aclexplode(
      coalesce(classes.relacl, pg_catalog.acldefault('r', classes.relowner))
    ) grants
    left join pg_catalog.pg_roles grantees on grantees.oid = grants.grantee
    where namespaces.nspname = 'reporting'
      and grants.grantee <> classes.relowner
      and (
        classes.relname in (select view_name from daily_stand_reporting_view_defs)
        or classes.relname in (select object_name from daily_stand_reporting_grants)
      )
    group by classes.relkind, classes.relname, grants.grantee, grantees.rolname
  loop
    v_target := format('table reporting.%I', v_row.object_name);
    v_grantee := case when v_row.grantee_name = 'PUBLIC' then 'PUBLIC' else format('%I', v_row.grantee_name) end;
    execute format('revoke all privileges on %s from %s', v_target, v_grantee);
  end loop;

  for v_row in
    select grants.*
    from daily_stand_reporting_grants grants
    left join daily_stand_reporting_view_defs views on views.view_name = grants.object_name
    left join daily_stand_reporting_matview_defs matviews on matviews.view_name = grants.object_name
    where grants.grantee_name is distinct from coalesce(views.owner_name, matviews.owner_name)
    order by grants.object_kind, grants.object_name, grants.grantee_name, grants.privilege_type
  loop
    v_target := format('table reporting.%I', v_row.object_name);
    v_grantee := case when v_row.grantee_name = 'PUBLIC' then 'PUBLIC' else format('%I', v_row.grantee_name) end;
    execute format(
      'grant %s on %s to %s%s',
      v_row.privilege_type,
      v_target,
      v_grantee,
      case when v_row.is_grantable then ' with grant option' else '' end
    );
  end loop;
end;
$$;
