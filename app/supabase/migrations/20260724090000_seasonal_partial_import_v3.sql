alter table public.season_import_batches
  add column if not exists contract_version smallint not null default 2,
  add column if not exists apply_strategy text,
  add column if not exists target_existed_at_stage boolean,
  add column if not exists preview jsonb,
  add column if not exists preview_hash text,
  add column if not exists expires_at timestamptz,
  add column if not exists cancelled_at timestamptz;

alter table public.season_import_batches
  drop constraint if exists season_import_batches_status_check;

alter table public.season_import_batches
  add constraint season_import_batches_status_check
  check (
    status in (
      'staged',
      'validated',
      'committed',
      'failed',
      'cancelled',
      'expired'
    )
  );

do $$
begin
  if not exists (
    select 1
    from pg_catalog.pg_constraint constraints
    where constraints.conrelid = 'public.season_import_batches'::pg_catalog.regclass
      and constraints.conname = 'season_import_batches_v3_contract_check'
  ) then
    alter table public.season_import_batches
      add constraint season_import_batches_v3_contract_check
      check (
        contract_version in (2, 3)
        and (
          contract_version <> 3
          or (
            apply_strategy is not null
            and apply_strategy in ('merge', 'replace')
            and preview is not null
            and pg_catalog.jsonb_typeof(preview) = 'object'
            and preview_hash is not null
            and pg_catalog.btrim(preview_hash) <> ''
            and expires_at is not null
          )
        )
      );
  end if;
end;
$$;

create table if not exists public.season_import_batch_records_v3 (
  batch_id uuid not null
    references public.season_import_batches(batch_id) on delete cascade,
  occurrence_key text not null,
  generated_record_id text not null,
  source_staging_row_index integer not null,
  source_row_index integer not null,
  linked_occurrence_key text,
  record_hash text not null,
  record_data jsonb not null,
  primary key (batch_id, occurrence_key),
  unique (batch_id, generated_record_id),
  check (pg_catalog.btrim(occurrence_key) <> ''),
  check (pg_catalog.btrim(generated_record_id) <> ''),
  check (source_staging_row_index >= 0),
  check (source_row_index >= 0),
  check (pg_catalog.btrim(record_hash) <> ''),
  check (pg_catalog.jsonb_typeof(record_data) = 'object')
);

create index if not exists season_import_batch_records_v3_source_idx
  on public.season_import_batch_records_v3 (batch_id, source_staging_row_index);

create table if not exists public.season_import_batch_preimages_v3 (
  batch_id uuid not null
    references public.season_import_batches(batch_id) on delete restrict,
  record_id text not null,
  existed_before boolean not null,
  record_data jsonb,
  modification_data jsonb,
  counter_rows jsonb not null default '[]'::jsonb,
  checkin_window_rows jsonb not null default '[]'::jsonb,
  added_leg_data jsonb,
  primary key (batch_id, record_id),
  check (pg_catalog.btrim(record_id) <> ''),
  check (record_data is null or pg_catalog.jsonb_typeof(record_data) = 'object'),
  check (
    modification_data is null
    or pg_catalog.jsonb_typeof(modification_data) = 'object'
  ),
  check (pg_catalog.jsonb_typeof(counter_rows) = 'array'),
  check (pg_catalog.jsonb_typeof(checkin_window_rows) = 'array'),
  check (added_leg_data is null or pg_catalog.jsonb_typeof(added_leg_data) = 'object')
);

alter table public.season_import_batch_records_v3 enable row level security;
alter table public.season_import_batch_preimages_v3 enable row level security;

revoke all on table public.season_import_batch_records_v3
  from public, anon, authenticated;
revoke all on table public.season_import_batch_preimages_v3
  from public, anon, authenticated;

alter table public.season_flight_records
  add column if not exists source_import_batch_id uuid,
  add column if not exists source_import_staging_row_index integer;

alter table public.seasons
  add column if not exists source_provenance_mode text not null default 'none',
  add column if not exists last_import_batch_id uuid;

do $$
begin
  if not exists (
    select 1
    from pg_catalog.pg_constraint constraints
    where constraints.conrelid = 'public.seasons'::pg_catalog.regclass
      and constraints.conname = 'seasons_source_provenance_mode_check'
  ) then
    alter table public.seasons
      add constraint seasons_source_provenance_mode_check
      check (source_provenance_mode in ('none', 'full', 'fragmented'));
  end if;
end;
$$;

update public.seasons seasons
set source_provenance_mode = 'full'
where seasons.source_provenance_mode = 'none'
  and exists (
    select 1
    from public.season_source_rows source_rows
    where source_rows.season_id = seasons.id
  );

create or replace function public.set_season_import_target_existence_v3()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
begin
  if new.target_existed_at_stage is not null then
    return new;
  end if;

  if new.season_id is not null and pg_catalog.btrim(new.season_id) <> '' then
    perform 1
    from public.seasons seasons
    where seasons.id = new.season_id
    for key share;
  else
    perform 1
    from public.seasons seasons
    where pg_catalog.upper(pg_catalog.btrim(seasons.season_code))
      = pg_catalog.upper(pg_catalog.btrim(new.season_code))
    order by seasons.id
    limit 1
    for key share;
  end if;

  new.target_existed_at_stage := found;
  return new;
end;
$$;

drop trigger if exists set_season_import_target_existence_v3
  on public.season_import_batches;

create trigger set_season_import_target_existence_v3
before insert on public.season_import_batches
for each row
execute function public.set_season_import_target_existence_v3();

update public.season_import_batches batches
set target_existed_at_stage = (
  exists (
    select 1
    from public.seasons seasons
    where batches.season_id is not null
      and seasons.id = batches.season_id
  )
  or exists (
    select 1
    from public.seasons seasons
    where batches.season_id is null
      and pg_catalog.upper(pg_catalog.btrim(seasons.season_code))
        = pg_catalog.upper(pg_catalog.btrim(batches.season_code))
  )
)
where batches.target_existed_at_stage is null;

alter table public.season_import_batches
  alter column target_existed_at_stage set not null;

create or replace function public.guard_legacy_existing_season_import_v3()
returns trigger
language plpgsql
set search_path = pg_catalog, pg_temp
as $$
begin
  if old.contract_version = 2
    and old.target_existed_at_stage
    and old.status is distinct from 'committed'
    and new.status = 'committed'
  then
    raise exception
      'Existing-season Import V2 is disabled; use Import V3 preview with merge or replace'
      using errcode = '0A000';
  end if;

  return new;
end;
$$;

drop trigger if exists guard_legacy_existing_season_import_v3
  on public.season_import_batches;

create trigger guard_legacy_existing_season_import_v3
before update of status on public.season_import_batches
for each row
execute function public.guard_legacy_existing_season_import_v3();

revoke execute on function public.set_season_import_target_existence_v3()
  from public, anon, authenticated;
revoke execute on function public.guard_legacy_existing_season_import_v3()
  from public, anon, authenticated;
