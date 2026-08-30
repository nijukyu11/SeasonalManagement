-- Canonical effective read boundary. The underlying compatibility report view
-- already reads canonical_active_flight_records_v1 after the Daily cutover and
-- applies season_modifications. This view adds provenance/version explicitly so
-- downstream projections can prove which live source they materialized.

create or replace view reporting.canonical_effective_flight_legs
with (security_invoker=true)
as
select effective.*,
  records.source_import_batch_id as source_batch_id,
  records.source_file_hash,
  records.supersedes_record_id,
  records.lifecycle_changed_at,
  seasons.data_version as source_data_version
from reporting.effective_flight_operations effective
join public.canonical_active_flight_records_v1 records
  on records.season_id=effective.season_id and records.record_id=effective.record_id
join public.seasons seasons on seasons.id=effective.season_id;

revoke all on reporting.canonical_effective_flight_legs from public,anon;
grant select on reporting.canonical_effective_flight_legs to authenticated;

do $$
begin
  if exists(select 1 from pg_roles where rolname='seasonal_bi_reader') then
    grant select on reporting.canonical_effective_flight_legs to seasonal_bi_reader;
  end if;
end;
$$;
