-- Scope entity sync clocks by season and make V2 event sync retries idempotent.

update public.season_entity_versions sev
set season_id = coalesce(
  sev.season_id,
  (
    select sce.season_id
    from public.season_change_events sce
    where sce.target_type = sev.target_type
      and sce.target_id = sev.target_id
      and sce.season_id is not null
    order by sce.server_seq desc
    limit 1
  ),
  (
    select s.id
    from public.seasons s
    order by s.uploaded_at desc, s.id
    limit 1
  )
)
where sev.season_id is null;

delete from public.season_entity_versions
where season_id is null;

alter table public.season_entity_versions
  drop constraint if exists season_entity_versions_pkey;

alter table public.season_entity_versions
  alter column season_id set not null;

alter table public.season_entity_versions
  add constraint season_entity_versions_pkey primary key (season_id, target_type, target_id);

drop index if exists public.season_entity_versions_target_idx;
create index if not exists season_entity_versions_target_idx
  on public.season_entity_versions (season_id, target_type, target_id);

create or replace function public.sync_season_workspace_v2(
  p_season_id text,
  p_client_id text,
  p_base_server_seq bigint,
  p_pending_events jsonb
) returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
declare
  current_version integer;
  next_version integer;
  event_doc jsonb;
  event_payload jsonb;
  v_event_id text;
  v_op_id text;
  v_target_type text;
  v_target_id text;
  changed_fields text[];
  changed_field text;
  current_field_versions jsonb;
  next_field_versions jsonb;
  base_field_versions jsonb;
  current_field_version bigint;
  base_field_version bigint;
  has_conflict boolean;
  applied_seq bigint;
  applied_count integer := 0;
  next_server_seq bigint;
  applied_events jsonb := '[]'::jsonb;
  conflict_events jsonb := '[]'::jsonb;
begin
  select data_version into current_version from public.seasons where id = p_season_id for update;
  if current_version is null then
    raise exception 'Season % not found', p_season_id;
  end if;

  for event_doc in select * from jsonb_array_elements(coalesce(p_pending_events, '[]'::jsonb))
  loop
    event_payload := coalesce(event_doc->'opPayload', event_doc->'op_payload', '{}'::jsonb);
    v_event_id := coalesce(event_doc->>'eventId', event_doc->>'event_id', gen_random_uuid()::text);
    v_op_id := coalesce(event_doc->>'opId', event_doc->>'op_id', v_event_id);
    v_target_type := coalesce(event_doc->>'targetType', event_doc->>'target_type', 'flightRecord');
    v_target_id := coalesce(event_doc->>'targetId', event_doc->>'target_id', event_payload->>'legId', event_payload->'record'->>'id', event_payload->>'legId', v_event_id);
    changed_fields := coalesce(
      array(select jsonb_array_elements_text(coalesce(event_doc->'changedFields', event_doc->'changed_fields', '[]'::jsonb))),
      '{}'
    );
    base_field_versions := coalesce(event_payload->'baseFieldVersions', event_payload->'base_field_versions', '{}'::jsonb);

    select server_seq into applied_seq
    from public.season_change_events
    where client_id = p_client_id and op_id = v_op_id;

    if applied_seq is not null then
      applied_events := applied_events || jsonb_build_array(jsonb_build_object(
        'eventId', v_event_id,
        'seasonId', p_season_id,
        'clientId', p_client_id,
        'opId', v_op_id,
        'actorUserId', auth.uid(),
        'serverSeq', applied_seq,
        'targetType', v_target_type,
        'targetId', v_target_id,
        'changedFields', changed_fields,
        'opPayload', event_payload,
        'createdAt', now()
      ));
      continue;
    end if;

    insert into public.season_entity_versions (season_id, target_type, target_id)
    values (p_season_id, v_target_type, v_target_id)
    on conflict do nothing;

    select field_versions into current_field_versions
    from public.season_entity_versions
    where season_id = p_season_id and target_type = v_target_type and target_id = v_target_id
    for update;

    has_conflict := false;
    foreach changed_field in array changed_fields
    loop
      current_field_version := coalesce((current_field_versions->>changed_field)::bigint, 0);
      base_field_version := coalesce((base_field_versions->>changed_field)::bigint, 0);
      if current_field_version > base_field_version then
        has_conflict := true;
      end if;
    end loop;

    if has_conflict then
      conflict_events := conflict_events || jsonb_build_array(jsonb_build_object(
        'eventId', v_event_id,
        'seasonId', p_season_id,
        'clientId', p_client_id,
        'opId', v_op_id,
        'targetType', v_target_type,
        'targetId', v_target_id,
        'changedFields', changed_fields,
        'opPayload', event_payload
      ));
    else
      insert into public.season_change_events (
        event_id, season_id, client_id, op_id, actor_user_id, target_type, target_id, changed_fields, op_payload
      )
      values (
        v_event_id, p_season_id, p_client_id, v_op_id, auth.uid(), v_target_type, v_target_id, changed_fields, event_payload
      )
      on conflict (client_id, op_id) do nothing
      returning server_seq into applied_seq;

      if applied_seq is null then
        select server_seq into applied_seq
        from public.season_change_events
        where client_id = p_client_id and op_id = v_op_id;
        applied_events := applied_events || jsonb_build_array(jsonb_build_object(
          'eventId', v_event_id,
          'seasonId', p_season_id,
          'clientId', p_client_id,
          'opId', v_op_id,
          'actorUserId', auth.uid(),
          'serverSeq', applied_seq,
          'targetType', v_target_type,
          'targetId', v_target_id,
          'changedFields', changed_fields,
          'opPayload', event_payload,
          'createdAt', now()
        ));
        continue;
      end if;

      perform public.apply_workspace_op_json(p_season_id, event_payload);
      next_field_versions := current_field_versions;
      foreach changed_field in array changed_fields
      loop
        next_field_versions := jsonb_set(
          next_field_versions,
          array[changed_field],
          to_jsonb(applied_seq),
          true
        );
      end loop;
      update public.season_entity_versions
      set entity_version = entity_version + 1,
          field_versions = next_field_versions,
          updated_by = auth.uid(),
          updated_at = now()
      where season_id = p_season_id and target_type = v_target_type and target_id = v_target_id;

      applied_count := applied_count + 1;
      applied_events := applied_events || jsonb_build_array(jsonb_build_object(
        'eventId', v_event_id,
        'seasonId', p_season_id,
        'clientId', p_client_id,
        'opId', v_op_id,
        'actorUserId', auth.uid(),
        'serverSeq', applied_seq,
        'targetType', v_target_type,
        'targetId', v_target_id,
        'changedFields', changed_fields,
        'opPayload', event_payload,
        'createdAt', now()
      ));
    end if;
  end loop;

  next_version := current_version + greatest(applied_count, 0);
  update public.seasons
  set data_version = next_version,
      last_synced_at = (extract(epoch from now()) * 1000)::bigint
  where id = p_season_id;
  select coalesce(max(server_seq), p_base_server_seq) into next_server_seq
  from public.season_change_events
  where season_id = p_season_id;
  return jsonb_build_object(
    'applied_events', applied_events,
    'conflict_events', conflict_events,
    'next_server_seq', next_server_seq,
    'next_server_version', next_version
  );
end;
$$;

revoke execute on function public.sync_season_workspace_v2(text, text, bigint, jsonb) from public;
revoke execute on function public.sync_season_workspace_v2(text, text, bigint, jsonb) from anon;
grant execute on function public.sync_season_workspace_v2(text, text, bigint, jsonb) to authenticated;
