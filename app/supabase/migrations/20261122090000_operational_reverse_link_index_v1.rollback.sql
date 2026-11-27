begin;
set local lock_timeout = '5s';
drop index public.operational_legs_reverse_link_v1;
commit;
