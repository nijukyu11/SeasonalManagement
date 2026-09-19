-- F07: one active leg per calendar date + airline + normalized flight number.
-- Two Daily rows staged by batch 951b7261 (2026-08-31) predate the
-- DAILY_DUPLICATE_FLIGHT_NUMBER stage guard and violate the rule in S26:
--   DAILY_V2_683bc249... NX985 ARR 03:00 on 2026-07-16 (Ops 2026-07-15)
--   DAILY_V2_0543601c... ZE593A ARR 00:40 on 2026-07-27 (Ops 2026-07-26)
-- Both are Daily-only extras: no seasonal plan row carries them, and the
-- season keeps the sibling occurrence of the same calendar date. They block the
-- client duplicate gate for every add and export, so they are soft-deleted with
-- the terminal row contract (status/action/deletion_reason) used by the
-- canonical store. Reversible: rollback.sql restores both rows byte-exactly.
begin;
set local lock_timeout='15s';
set local statement_timeout='300s';

do $duplicate_flight_day_repair$
declare
  v_season_id text := 'season-19cbca13-e11d-4b75-bcaa-00a6c5ca68c6';
  v_record_ids text[] := array[
    'DAILY_V2_683bc249f07b683d1f458170207ab0cc',
    'DAILY_V2_0543601ccc0153abedbcbfdebd01f4dc'
  ];
  v_active integer;
  v_updated integer;
  v_groups integer;
begin
  if not exists (select 1 from public.seasons seasons where seasons.id=v_season_id) then
    return;
  end if;

  select count(*) into v_active
  from public.season_flight_records records
  where records.season_id=v_season_id and records.record_id=any(v_record_ids)
    and public.is_canonical_flight_leg_active_v1(records.status,records.action);
  if v_active=0 then
    return; -- fresh database, or the repair already ran
  end if;
  if v_active<>2 then
    raise exception 'Duplicate flight day repair preimage changed: % of 2 targets active',v_active using errcode='P0001';
  end if;

  update public.season_flight_records records
  set status='deleted',
      action='deleted',
      deletion_reason='duplicate_flight_day_repair',
      lifecycle_changed_at=clock_timestamp(),
      lifecycle_changed_by=null
  where records.season_id=v_season_id and records.record_id=any(v_record_ids)
    and public.is_canonical_flight_leg_active_v1(records.status,records.action);
  get diagnostics v_updated=row_count;
  if v_updated<>2 then
    raise exception 'Duplicate flight day repair updated % of 2 rows',v_updated using errcode='P0001';
  end if;

  select count(*) into v_groups
  from (
    select 1
    from public.season_flight_records records
    where records.season_id=v_season_id
      and public.is_canonical_flight_leg_active_v1(records.status,records.action)
      and not exists (
        select 1 from public.season_modifications mods
        where mods.season_id=records.season_id and mods.leg_id=records.record_id and mods.action='deleted'
      )
    group by records.date,upper(btrim(records.airline)),
      (select normalized.flight_number
       from public.normalize_seasonal_flight_number_v2(
         records.airline,coalesce(nullif(records.flight_number,''),records.raw_flight_number)) normalized)
    having count(*)>1
  ) duplicate_groups;
  if v_groups<>0 then
    raise exception 'Duplicate flight day repair left % duplicate group(s)',v_groups using errcode='P0001';
  end if;

  update public.seasons seasons
  set data_version=seasons.data_version+1,
      last_synced_at=floor(extract(epoch from clock_timestamp())*1000)::bigint
  where seasons.id=v_season_id;
end
$duplicate_flight_day_repair$;

commit;
