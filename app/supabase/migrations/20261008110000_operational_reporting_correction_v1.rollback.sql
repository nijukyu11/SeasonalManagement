-- 20261008110000_operational_reporting_correction_v1.rollback.sql
-- Rollback for native Pax correction and candidate selector cutover integration.

begin;

drop trigger if exists capture_operational_pax_correction on public.operational_change_events;
drop trigger if exists operational_capture_zzz_pax_correction on public.operational_change_events;
drop function if exists reporting.capture_operational_pax_correction_v1();

do $$
declare
  v_fn text;
begin
  if exists (select 1 from pg_proc where proname = 'legacy_select_public_dashboard_correction_candidate_v1') then
    select pg_get_functiondef(p.oid) into v_fn
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'reporting' and p.proname = 'legacy_select_public_dashboard_correction_candidate_v1'
    limit 1;
    if v_fn is not null then
      v_fn := regexp_replace(
        v_fn,
        'FUNCTION\s+([a-zA-Z_0-9]+\.)?legacy_select_public_dashboard_correction_candidate_v1\(',
        'FUNCTION reporting.select_public_dashboard_correction_candidate_v1(',
        'i'
      );
      execute v_fn;
      drop function reporting.legacy_select_public_dashboard_correction_candidate_v1(timestamptz);
    end if;
  end if;
end;
$$;

commit;
