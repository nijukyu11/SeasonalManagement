begin;
set local lock_timeout = '15s';
set local statement_timeout = '30s';

-- Restore binding invariant from 20260831210000_public_traffic_live_aggregate_v2.sql:651-656:
-- Revoke all permissions on get_public_traffic_report_v2 from public, anon, authenticated, service_role,
-- then grant execute strictly to service_role.

revoke all on function public.get_public_traffic_report_v2(
  date,
  date,
  text,
  text[],
  text[],
  text[],
  text,
  text,
  bigint,
  text,
  text,
  timestamptz
) from public, anon, authenticated, service_role;

grant execute on function public.get_public_traffic_report_v2(
  date,
  date,
  text,
  text[],
  text[],
  text[],
  text,
  text,
  bigint,
  text,
  text,
  timestamptz
) to service_role;

notify pgrst, 'reload schema';

commit;
