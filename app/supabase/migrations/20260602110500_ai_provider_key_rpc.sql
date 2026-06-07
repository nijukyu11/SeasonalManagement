alter table public.app_operators
  add column if not exists can_use_ai boolean not null default true;

alter table public.app_operators
  alter column can_use_ai set default true;

update public.app_operators
set can_use_ai = true
where can_use_ai is false;

create or replace function public.sync_ai_provider_key(
  p_provider text,
  p_secret_value text,
  p_key_fingerprint text,
  p_updated_at bigint
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  normalized_provider text := lower(trim(coalesce(p_provider, '')));
  normalized_secret text := trim(coalesce(p_secret_value, ''));
  normalized_fingerprint text := trim(coalesce(p_key_fingerprint, ''));
  effective_updated_at bigint := coalesce(p_updated_at, floor(extract(epoch from clock_timestamp()) * 1000)::bigint);
begin
  if not public.app_operator_can_manage_ai() then
    return jsonb_build_object(
      'ok', false,
      'reason', 'operator_missing_can_manage_ai'
    );
  end if;

  if normalized_provider not in ('gemini', 'openai-compatible', 'deepseek') then
    return jsonb_build_object(
      'ok', false,
      'reason', 'invalid_provider'
    );
  end if;

  if normalized_secret = '' then
    return jsonb_build_object(
      'ok', false,
      'reason', 'empty_secret'
    );
  end if;

  insert into public.operational_ai_provider_keys (
    provider,
    secret_value,
    key_fingerprint,
    updated_at,
    updated_by
  )
  values (
    normalized_provider,
    normalized_secret,
    coalesce(nullif(normalized_fingerprint, ''), 'unknown'),
    effective_updated_at,
    auth.uid()
  )
  on conflict (provider) do update
  set secret_value = excluded.secret_value,
      key_fingerprint = excluded.key_fingerprint,
      updated_at = excluded.updated_at,
      updated_by = excluded.updated_by;

  return jsonb_build_object(
    'ok', true,
    'provider', normalized_provider,
    'keyFingerprint', coalesce(nullif(normalized_fingerprint, ''), 'unknown'),
    'keyUpdatedAt', effective_updated_at,
    'updatedBy', auth.uid()
  );
end;
$$;

create or replace function public.fetch_ai_provider_key(p_provider text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  normalized_provider text := lower(trim(coalesce(p_provider, '')));
  key_row public.operational_ai_provider_keys%rowtype;
begin
  if not public.app_operator_can_use_ai() then
    return jsonb_build_object(
      'ok', false,
      'reason', 'operator_missing_can_use_ai',
      'provider', normalized_provider
    );
  end if;

  if normalized_provider not in ('gemini', 'openai-compatible', 'deepseek') then
    return jsonb_build_object(
      'ok', false,
      'reason', 'invalid_provider',
      'provider', normalized_provider
    );
  end if;

  select *
  into key_row
  from public.operational_ai_provider_keys
  where provider = normalized_provider;

  if not found then
    return jsonb_build_object(
      'ok', false,
      'reason', 'provider_key_not_synced',
      'provider', normalized_provider
    );
  end if;

  return jsonb_build_object(
    'ok', true,
    'provider', key_row.provider,
    'secretValue', key_row.secret_value,
    'keyFingerprint', key_row.key_fingerprint,
    'keyUpdatedAt', key_row.updated_at,
    'updatedBy', key_row.updated_by
  );
end;
$$;

create or replace function public.list_ai_provider_key_status()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.app_operator_can_use_ai() then
    return jsonb_build_object(
      'ok', false,
      'reason', 'operator_missing_can_use_ai',
      'items', '[]'::jsonb
    );
  end if;

  return jsonb_build_object(
    'ok', true,
    'items',
    coalesce((
      select jsonb_agg(jsonb_build_object(
        'provider', provider,
        'keyFingerprint', key_fingerprint,
        'keyUpdatedAt', updated_at,
        'updatedBy', updated_by
      ) order by provider)
      from public.operational_ai_provider_keys
    ), '[]'::jsonb)
  );
end;
$$;

revoke execute on function public.sync_ai_provider_key(text, text, text, bigint) from public;
revoke execute on function public.sync_ai_provider_key(text, text, text, bigint) from anon;
grant execute on function public.sync_ai_provider_key(text, text, text, bigint) to authenticated;

revoke execute on function public.fetch_ai_provider_key(text) from public;
revoke execute on function public.fetch_ai_provider_key(text) from anon;
grant execute on function public.fetch_ai_provider_key(text) to authenticated;

revoke execute on function public.list_ai_provider_key_status() from public;
revoke execute on function public.list_ai_provider_key_status() from anon;
grant execute on function public.list_ai_provider_key_status() to authenticated;
