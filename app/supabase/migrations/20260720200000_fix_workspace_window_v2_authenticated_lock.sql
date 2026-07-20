do $$
declare
  function_oid regprocedure := 'public.get_season_schedule_allocation_window_v2(text,text,text,text,integer,text,text,smallint,integer,bigint)'::regprocedure;
  function_definition text;
  patched_definition text;
begin
  select pg_get_functiondef(function_oid)
  into function_definition;

  if function_definition ~* '\mfor[[:space:]]+share\M' then
    patched_definition := regexp_replace(
      function_definition,
      E'\n[[:space:]]*for[[:space:]]+share;',
      ';',
      'i'
    );

    if patched_definition = function_definition
       or patched_definition ~* '\mfor[[:space:]]+share\M' then
      raise exception 'Could not safely remove FOR SHARE from workspace window V2';
    end if;

    execute patched_definition;
  end if;
end
$$;

notify pgrst, 'reload schema';
