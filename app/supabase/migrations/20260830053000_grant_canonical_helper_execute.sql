-- Canonical security-invoker views and RPCs evaluate these pure immutable
-- helpers as the caller. Keep them unavailable to anon/PUBLIC, but allow every
-- role that is explicitly permitted to read the canonical projections.

revoke execute on function public.is_canonical_flight_leg_active_v1(text,text)
  from public, anon;
revoke execute on function public.canonical_flight_leg_ops_date_v1(text,text,text,text,text)
  from public, anon;
revoke execute on function public.canonical_flight_leg_occurrence_key_v1(text,text,text,text,text,text,text,text,text,text,text)
  from public, anon;

grant execute on function public.is_canonical_flight_leg_active_v1(text,text)
  to authenticated;
grant execute on function public.canonical_flight_leg_ops_date_v1(text,text,text,text,text)
  to authenticated;
grant execute on function public.canonical_flight_leg_occurrence_key_v1(text,text,text,text,text,text,text,text,text,text,text)
  to authenticated;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    execute 'grant execute on function public.is_canonical_flight_leg_active_v1(text,text) to service_role';
    execute 'grant execute on function public.canonical_flight_leg_ops_date_v1(text,text,text,text,text) to service_role';
    execute 'grant execute on function public.canonical_flight_leg_occurrence_key_v1(text,text,text,text,text,text,text,text,text,text,text) to service_role';
  end if;
  if exists (select 1 from pg_roles where rolname = 'seasonal_bi_reader') then
    execute 'grant execute on function public.is_canonical_flight_leg_active_v1(text,text) to seasonal_bi_reader';
    execute 'grant execute on function public.canonical_flight_leg_ops_date_v1(text,text,text,text,text) to seasonal_bi_reader';
    execute 'grant execute on function public.canonical_flight_leg_occurrence_key_v1(text,text,text,text,text,text,text,text,text,text,text) to seasonal_bi_reader';
  end if;
end;
$$;
