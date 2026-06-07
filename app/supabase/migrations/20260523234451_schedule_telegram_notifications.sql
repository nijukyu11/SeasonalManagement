create table if not exists public.schedule_notification_deliveries (
  id text primary key,
  season_id text not null references public.seasons(id) on delete cascade,
  history_entry_id text not null references public.season_mod_history_entries(entry_id) on delete cascade deferrable initially deferred,
  actor_user_id uuid references auth.users(id) on delete set null,
  module text not null check (module in ('seasonal', 'detailed')),
  payload jsonb not null,
  status text not null default 'pending' check (status in ('pending', 'sending', 'sent', 'failed')),
  attempts integer not null default 0,
  telegram_message_ids jsonb not null default '[]'::jsonb,
  error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  sent_at timestamptz,
  unique (season_id, history_entry_id)
);

create index if not exists schedule_notification_deliveries_status_idx
  on public.schedule_notification_deliveries (status, created_at);

create index if not exists schedule_notification_deliveries_season_idx
  on public.schedule_notification_deliveries (season_id, created_at);

alter table public.schedule_notification_deliveries enable row level security;
drop policy if exists "app operators can read" on public.schedule_notification_deliveries;
drop policy if exists "app operators can write" on public.schedule_notification_deliveries;
create policy "app operators can read"
  on public.schedule_notification_deliveries
  for select
  to authenticated
  using (public.is_app_operator());
create policy "app operators can write"
  on public.schedule_notification_deliveries
  for all
  to authenticated
  using (public.is_app_operator())
  with check (public.is_app_operator());

create or replace function public.enqueue_schedule_notification_delivery()
returns trigger
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_entry jsonb;
  v_payload jsonb;
  v_history_entry_id text;
  v_module text;
begin
  if new.target_type <> 'modHistory' then
    return new;
  end if;

  v_entry := coalesce(new.op_payload->'entry', '{}'::jsonb);
  v_payload := v_entry->'scheduleNotification';
  if v_payload is null or jsonb_typeof(v_payload) <> 'object' then
    return new;
  end if;

  v_history_entry_id := coalesce(v_entry->>'id', new.target_id);
  v_module := coalesce(v_payload->>'module', '');
  if new.season_id is null or v_history_entry_id is null or v_module not in ('seasonal', 'detailed') then
    return new;
  end if;

  insert into public.schedule_notification_deliveries (
    id,
    season_id,
    history_entry_id,
    actor_user_id,
    module,
    payload
  )
  values (
    'schedule-telegram:' || new.season_id || ':' || v_history_entry_id,
    new.season_id,
    v_history_entry_id,
    new.actor_user_id,
    v_module,
    v_payload
  )
  on conflict (season_id, history_entry_id) do nothing;

  return new;
end;
$$;

drop trigger if exists season_change_events_schedule_notification_delivery on public.season_change_events;
create trigger season_change_events_schedule_notification_delivery
after insert on public.season_change_events
for each row
execute function public.enqueue_schedule_notification_delivery();
