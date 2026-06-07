create or replace function public.dashboard_ai_query_aggregated(
  p_filters jsonb default '{}'::jsonb,
  p_group_by text[] default array[]::text[],
  p_metrics text[] default array['flights']::text[],
  p_order_by text default 'flights',
  p_order_dir text default 'desc',
  p_limit integer default 24
) returns jsonb
language sql
security invoker
set search_path = public, reporting
as $$
  select reporting.query_aggregated(
    p_filters,
    p_group_by,
    p_metrics,
    p_order_by,
    p_order_dir,
    p_limit
  );
$$;

grant execute on function public.dashboard_ai_query_aggregated(jsonb, text[], text[], text, text, integer) to authenticated;
