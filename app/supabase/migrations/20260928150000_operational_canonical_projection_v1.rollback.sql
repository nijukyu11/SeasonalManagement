-- Rollback M3.2: drop the shadow projection, its quarantine table, its
-- freshness state and the three functions. The public report never read from
-- here, so dropping them restores the pre-M3 reading path exactly.
begin;
set local lock_timeout = '15s';

drop function if exists reporting.operational_projection_status_v1();
drop function if exists reporting.refresh_operational_canonical_legs_v1();
drop function if exists reporting.get_operational_canonical_bounds_v1();

drop table if exists reporting.operational_canonical_flight_legs_quarantine;
drop table if exists reporting.operational_canonical_flight_legs_state;
drop table if exists reporting.operational_canonical_flight_legs;

commit;
