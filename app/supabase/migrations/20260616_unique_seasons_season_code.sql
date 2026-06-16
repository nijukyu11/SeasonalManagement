do $$
begin
  if exists (
    select 1
    from public.seasons
    where season_code is not null and btrim(season_code) <> ''
    group by season_code
    having count(*) > 1
  ) then
    raise exception 'Cannot add unique seasons.season_code constraint: duplicate season_code rows exist.';
  end if;
end $$;

create unique index if not exists seasons_season_code_unique_idx on public.seasons (season_code);
