create or replace function public.normalize_seasonal_flight_number_v2(p_airline text, p_raw text)
returns table (flight_number text, raw_flight_number text)
language sql
immutable
set search_path = public
as $$
  with normalized as (
    select
      upper(regexp_replace(coalesce(p_airline, ''), '[^A-Za-z0-9]', '', 'g')) as airline,
      upper(regexp_replace(coalesce(p_raw, ''), '\s+', '', 'g')) as raw_value
  ), stripped as (
    select airline, raw_value,
      case when airline <> '' and raw_value like airline || '%' then substr(raw_value, length(airline) + 1) else raw_value end as suffix
    from normalized
  )
  select
    airline || case
      when suffix ~ '^\d+$' and length(suffix) < 3 then lpad(suffix, 3, '0')
      else suffix
    end,
    raw_value
  from stripped
$$;

notify pgrst, 'reload schema';
