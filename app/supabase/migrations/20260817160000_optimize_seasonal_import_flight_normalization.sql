create or replace function public.normalize_seasonal_flight_number_v2(
  p_airline text,
  p_raw text
)
returns table (
  flight_number text,
  raw_flight_number text
)
language plpgsql
immutable
rows 1
set search_path = pg_catalog, pg_temp
as $$
declare
  v_airline text;
  v_flight_part text;
begin
  if p_raw is null then
    return;
  end if;

  v_airline := pg_catalog.upper(pg_catalog.btrim(p_airline));
  v_flight_part := pg_catalog.upper(pg_catalog.btrim(p_raw));
  if v_flight_part = '' then
    return;
  end if;

  if v_airline <> ''
    and pg_catalog.char_length(v_flight_part) > pg_catalog.char_length(v_airline)
    and pg_catalog.left(v_flight_part, pg_catalog.char_length(v_airline)) = v_airline
  then
    v_flight_part := pg_catalog.substr(
      v_flight_part,
      pg_catalog.char_length(v_airline) + 1
    );
  end if;

  if v_flight_part ~ '^[0-9]+$'
    and pg_catalog.char_length(v_flight_part) < 3
  then
    v_flight_part := pg_catalog.repeat(
      '0',
      3 - pg_catalog.char_length(v_flight_part)
    ) || v_flight_part;
  end if;

  flight_number := v_airline || v_flight_part;
  raw_flight_number := v_flight_part;
  return next;
end;
$$;
