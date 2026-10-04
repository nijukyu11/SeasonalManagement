-- Rollback canonical flight legs store
begin;
set local lock_timeout = '15s';
set local statement_timeout = '300s';

drop function if exists reporting.refresh_public_traffic_canonical_legs_v1();
drop table if exists reporting.canonical_flight_legs_quarantine;
drop table if exists reporting.canonical_flight_legs;

commit;
