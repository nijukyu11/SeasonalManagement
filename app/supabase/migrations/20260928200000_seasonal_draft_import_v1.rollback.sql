begin;
set local lock_timeout='15s';
do $$ begin
 if exists(select 1 from public.season_import_batches where contract_version=4)
   or exists(select 1 from public.seasonal_draft_import_stages) then
   raise exception 'Draft import data exists; rollback requires an isolated empty shadow' using errcode='55000';
 end if;
end $$;
drop function public.get_seasonal_draft_import_preview_v1(uuid,text,integer);
drop function public.cancel_seasonal_draft_import_v1(uuid);
drop function public.get_seasonal_draft_import_status_v1(uuid);
drop function public.commit_seasonal_draft_import_v1(uuid,text);
drop function public.stage_seasonal_draft_import_v1(jsonb);
drop function public.seasonal_draft_import_response_v1(uuid);
drop trigger guard_seasonal_draft_import_commit_v1 on public.season_import_batches;
drop function public.guard_seasonal_draft_import_commit_v1();
drop table public.seasonal_draft_import_entries;
drop table public.seasonal_draft_import_stages;
alter table public.season_import_batches drop constraint season_import_batches_v3_contract_check;
alter table public.season_import_batches add constraint season_import_batches_v3_contract_check check (
 contract_version in (2,3) and (contract_version<>3 or (
   apply_strategy is not null and apply_strategy in ('merge','replace')
   and preview is not null and jsonb_typeof(preview)='object'
   and preview_hash is not null and btrim(preview_hash)<>'' and expires_at is not null)));
commit;
