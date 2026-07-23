begin;

create temp table affected_compact_schedule_seasons on commit drop as
select distinct modifications.season_id
from public.season_modifications modifications
where modifications.schedule ~ '^([01][0-9]|2[0-3])[0-5][0-9]$';

update public.season_modifications modifications
set schedule =
  substring(modifications.schedule from 1 for 2)
  || ':'
  || substring(modifications.schedule from 3 for 2)
where modifications.schedule ~ '^([01][0-9]|2[0-3])[0-5][0-9]$';

update public.seasons seasons
set data_version = seasons.data_version + 1,
    last_synced_at = floor(extract(epoch from clock_timestamp()) * 1000)::bigint
where seasons.id in (
  select affected.season_id
  from affected_compact_schedule_seasons affected
);

create or replace function public.normalize_season_modification_schedule_v1()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.schedule is null then
    return new;
  end if;

  new.schedule := btrim(new.schedule);

  if new.schedule ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' then
    return new;
  end if;

  if new.schedule ~ '^([01][0-9]|2[0-3])[0-5][0-9]$' then
    new.schedule :=
      substring(new.schedule from 1 for 2)
      || ':'
      || substring(new.schedule from 3 for 2);
    return new;
  end if;

  if new.schedule ~ '^[0-9][0-5][0-9]$' then
    new.schedule :=
      '0'
      || substring(new.schedule from 1 for 1)
      || ':'
      || substring(new.schedule from 2 for 2);
    return new;
  end if;

  raise exception 'season_modifications.schedule must use HH:mm format'
    using errcode = '22007';
end;
$$;

revoke all on function public.normalize_season_modification_schedule_v1() from public;

drop trigger if exists normalize_season_modification_schedule_v1
  on public.season_modifications;

create trigger normalize_season_modification_schedule_v1
before insert or update of schedule
on public.season_modifications
for each row
execute function public.normalize_season_modification_schedule_v1();

do $constraint$
begin
  if not exists (
    select 1
    from pg_catalog.pg_constraint constraints
    where constraints.conrelid = 'public.season_modifications'::pg_catalog.regclass
      and constraints.conname = 'season_modifications_schedule_format_check'
  ) then
    alter table public.season_modifications
      add constraint season_modifications_schedule_format_check
      check (
        schedule is null
        or schedule ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
      )
      not valid;
  end if;
end
$constraint$;

alter table public.season_modifications
  validate constraint season_modifications_schedule_format_check;

commit;
