-- Rollback Seasonal Import V3 conflict checks without changing repair semantics.
-- MIN preserves the previous lexicographically first conflicting record ID.
-- Index the incoming occurrence keys used by selective manual supersession.
begin;
set local lock_timeout = '15s';
set local statement_timeout = '300s';

do $migration$
declare
  v_definition text;
  v_old text;
  v_new text;
begin
  select pg_get_functiondef('public.commit_seasonal_import_v3(uuid,integer,text)'::regprocedure)
  into v_definition;
  if position('seasonal_import_commit_indexed_conflicts_v1' in v_definition) = 0 then
    return;
  end if;

  v_old := $old$  where incoming.batch_id = p_batch_id;

  -- seasonal_import_commit_indexed_conflicts_v1
  create unique index seasonal_import_commit_occurrence_key_v3
    on pg_temp.seasonal_import_commit_records_v3 (occurrence_key);

  if v_batch.apply_strategy = 'replace' then$old$;
  v_new := $new$  where incoming.batch_id = p_batch_id;

  if v_batch.apply_strategy = 'replace' then$new$;
  if (length(v_definition) - length(replace(v_definition, v_old, ''))) / length(v_old) <> 1 then
    raise exception 'Seasonal commit performance rollback anchor 1 changed';
  end if;
  v_definition := replace(v_definition, v_old, v_new);

  v_old := $old$    select pg_catalog.min(conflicts.record_id)
    into v_conflicting_record_id
    from pg_temp.seasonal_import_commit_records_v3 incoming
    join public.season_flight_records conflicts
      on conflicts.record_id = incoming.generated_record_id
    where incoming.is_insert;$old$;
  v_new := $new$    select conflicts.record_id
    into v_conflicting_record_id
    from pg_temp.seasonal_import_commit_records_v3 incoming
    join public.season_flight_records conflicts
      on conflicts.record_id = incoming.generated_record_id
    where incoming.is_insert
    order by conflicts.record_id
    limit 1;$new$;
  if (length(v_definition) - length(replace(v_definition, v_old, ''))) / length(v_old) <> 1 then
    raise exception 'Seasonal commit performance rollback anchor 2 changed';
  end if;
  v_definition := replace(v_definition, v_old, v_new);

  v_old := $old$    select pg_catalog.min(conflicts.record_id)
    into v_conflicting_record_id
    from pg_temp.seasonal_import_commit_records_v3 incoming
    join public.season_flight_records conflicts
      on conflicts.record_id = incoming.generated_record_id
    where incoming.is_insert
      and conflicts.season_id <> v_target_season_id;$old$;
  v_new := $new$    select conflicts.record_id
    into v_conflicting_record_id
    from pg_temp.seasonal_import_commit_records_v3 incoming
    join public.season_flight_records conflicts
      on conflicts.record_id = incoming.generated_record_id
    where incoming.is_insert
      and conflicts.season_id <> v_target_season_id
    order by conflicts.record_id
    limit 1;$new$;
  if (length(v_definition) - length(replace(v_definition, v_old, ''))) / length(v_old) <> 1 then
    raise exception 'Seasonal commit performance rollback anchor 3 changed';
  end if;
  v_definition := replace(v_definition, v_old, v_new);

  execute v_definition;
end;
$migration$;

notify pgrst, 'reload schema';
commit;
