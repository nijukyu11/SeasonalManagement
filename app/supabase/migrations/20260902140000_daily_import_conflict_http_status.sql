begin;

-- PostgREST 14.12 retries SQLSTATE 40001 indefinitely. Daily import uses
-- optimistic data-version fences, not a retryable serialization transaction,
-- so surface those stale-preview conflicts as an explicit HTTP 409 instead.
do $daily_import_conflict_http_status$
declare
  v_signature text;
  v_definition text;
begin
  foreach v_signature in array array[
    'public.stage_daily_schedule_import_v1(jsonb)',
    'public.commit_daily_schedule_import_v1(uuid,jsonb,text)'
  ]
  loop
    select pg_get_functiondef(v_signature::regprocedure) into v_definition;
    if v_definition is null then
      raise exception 'Daily import function is missing: %', v_signature;
    end if;

    if position('40001' in v_definition) > 0 then
      execute replace(v_definition, '40001', 'PT409');
    elsif position('PT409' in v_definition) = 0 then
      raise exception 'Daily import function has no recognized conflict SQLSTATE: %', v_signature;
    end if;
  end loop;
end
$daily_import_conflict_http_status$;

comment on function public.stage_daily_schedule_import_v1(jsonb) is
  'Stages an atomic Daily replacement preview; stale data-version fences return PT409 and are never transaction-retried.';
comment on function public.commit_daily_schedule_import_v1(uuid,jsonb,text) is
  'Commits an atomic Daily replacement; stale preview/version/preimage fences return PT409 and preserve the prior canonical state.';

commit;
