do $$
begin
  if not exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'app_operators'
      and column_name = 'can_manage_ai'
  ) then
    alter table public.app_operators add column can_manage_ai boolean not null default false;
    update public.app_operators
    set can_manage_ai = true;
  end if;
end $$;
