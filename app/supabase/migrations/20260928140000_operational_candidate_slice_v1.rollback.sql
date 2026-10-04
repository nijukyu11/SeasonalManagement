-- Rollback M3.1: drop the shadow candidate slice. No table, grant or pointer
-- depends on it, so dropping the function restores the pre-M3 state exactly.
drop function if exists reporting.get_operational_candidate_slice_v1(date, date);
