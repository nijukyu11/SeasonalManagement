-- Rollback: 20261105100000_public_traffic_html_cutover_v1.sql
-- Dynamically restores captured actual preimages of reporting.traffic_html_period_data_v2
-- and public.get_public_traffic_html_export_v2, preserving any intermediate changes.

begin;

do $$
declare
  v_fn text;
begin
  if exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'reporting' and p.proname = 'legacy_traffic_html_period_data_v2'
  ) then
    select pg_get_functiondef(p.oid) into v_fn
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'reporting' and p.proname = 'legacy_traffic_html_period_data_v2';
    if v_fn is not null then
      v_fn := regexp_replace(v_fn, 'FUNCTION\s+([a-zA-Z_0-9]+\.)?legacy_traffic_html_period_data_v2\(', 'FUNCTION reporting.traffic_html_period_data_v2(', 'i');
      execute v_fn;
      execute 'alter function reporting.traffic_html_period_data_v2(jsonb,jsonb,timestamptz) owner to postgres';
      drop function reporting.legacy_traffic_html_period_data_v2(jsonb,jsonb,timestamptz);
    end if;
  end if;

  if exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'reporting' and p.proname = 'legacy_get_public_traffic_html_export_v2'
  ) then
    select pg_get_functiondef(p.oid) into v_fn
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'reporting' and p.proname = 'legacy_get_public_traffic_html_export_v2';
    if v_fn is not null then
      v_fn := regexp_replace(v_fn, 'FUNCTION\s+([a-zA-Z_0-9]+\.)?legacy_get_public_traffic_html_export_v2\(', 'FUNCTION public.get_public_traffic_html_export_v2(', 'i');
      execute v_fn;
      execute 'alter function public.get_public_traffic_html_export_v2(jsonb,bigint,timestamptz) owner to postgres';
      drop function reporting.legacy_get_public_traffic_html_export_v2(jsonb,bigint,timestamptz);
    end if;
  end if;
end;
$$;

alter function reporting.traffic_html_period_data_v2(jsonb,jsonb,timestamptz) owner to postgres;
alter function public.get_public_traffic_html_export_v2(jsonb,bigint,timestamptz) owner to postgres;
revoke all on function reporting.traffic_html_period_data_v2(jsonb,jsonb,timestamptz) from public,anon,authenticated,service_role;
revoke all on function public.get_public_traffic_html_export_v2(jsonb,bigint,timestamptz) from public,anon,authenticated;
grant execute on function public.get_public_traffic_html_export_v2(jsonb,bigint,timestamptz) to service_role;

commit;
