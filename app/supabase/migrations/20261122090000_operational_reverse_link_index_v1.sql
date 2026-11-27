begin;
set local lock_timeout = '5s';
set local statement_timeout = '300s';

-- Reverse-link invalidation must include non-active counterparts. An index
-- restricted to status='active' cannot serve that lookup during replacement.
create index operational_legs_reverse_link_v1
  on public.operational_flight_legs (linked_leg_id)
  where linked_leg_id is not null;
commit;
