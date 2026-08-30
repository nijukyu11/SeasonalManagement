-- READ-ONLY reconciliation. Bind :season_id, :date_from, :date_to and, when
-- applicable, :batch_id. Run all result sets against the same data version.

select id as season_id, season_code, data_version, total_legs, last_synced_at
from public.seasons where id = :season_id;

select
  public.canonical_flight_leg_ops_date_v1(
    records.operational_date, records.scheduled_date, records.date,
    records.scheduled_time, records.schedule
  ) as ops_date,
  records.source_kind,
  count(*) as active_leg_count,
  count(records.pax) as pax_known_count,
  coalesce(sum(records.pax), 0) as pax_total
from public.canonical_active_flight_records_v1 records
where records.season_id = :season_id
  and public.canonical_flight_leg_ops_date_v1(
    records.operational_date, records.scheduled_date, records.date,
    records.scheduled_time, records.schedule
  ) between :date_from and :date_to
group by 1, 2 order by 1, 2;

select ops_date, source_kind, count(*) as effective_leg_count,
  count(pax) as pax_known_count, coalesce(sum(pax), 0) as pax_total
from reporting.canonical_effective_flight_legs
where season_id = :season_id and ops_date between :date_from and :date_to
group by 1, 2 order by 1, 2;

select season_id, ops_date, authority_source, source_batch_id,
  expected_leg_count, canonical_checksum, data_version,
  committed_at, reset_at, reset_reason
from public.schedule_replacement_scopes
where season_id = :season_id and ops_date between :date_from and :date_to
order by ops_date;

select batches.batch_id, batches.status, batches.raw_checksum,
  batches.canonical_checksum, batches.preview_hash, batches.committed_at,
  count(legs.*) as staged_leg_count,
  count(nullif(legs.leg_data #>> '{resources,pax}', '')::integer) as staged_pax_known_count,
  coalesce(sum(nullif(legs.leg_data #>> '{resources,pax}', '')::integer), 0) as staged_pax_total
from public.daily_schedule_import_batches batches
left join public.daily_schedule_import_batch_legs legs on legs.batch_id = batches.batch_id
where batches.batch_id = :batch_id
group by batches.batch_id;

select source_import_batch_id as batch_id, count(*) as canonical_daily_count,
  count(pax) as canonical_pax_known_count, coalesce(sum(pax), 0) as canonical_pax_total
from public.season_flight_records
where season_id = :season_id and source_kind = 'daily'
  and source_import_batch_id = :batch_id
group by source_import_batch_id;

select event_id, server_seq, created_at, target_type, changed_fields, op_payload
from public.season_change_events
where season_id = :season_id
  and target_type in ('dailyImport', 'dailyAuthority')
order by server_seq desc limit 20;
