-- 20260929110000_operational_schedule_mutations_v1.rollback.sql
begin;
drop function if exists public.create_operational_flight_legs_v1(uuid, bigint, jsonb);
drop function if exists public.apply_operational_flight_schedule_changes_v1(uuid, bigint, jsonb);
commit;
