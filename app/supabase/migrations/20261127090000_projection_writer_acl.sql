begin;
set local lock_timeout = '5s';
set local statement_timeout = '30s';

create table if not exists reporting.projection_acl_delta_20261127 (
  target regclass not null,
  privilege_name text not null check (privilege_name in ('SELECT','INSERT','DELETE','UPDATE')),
  primary key (target, privilege_name)
);
revoke all on reporting.projection_acl_delta_20261127 from public, anon, authenticated, service_role;

do $$
declare
  rel regclass;
  priv text;
begin
  if not exists (select 1 from pg_proc where oid = 'reporting.refresh_operational_canonical_legs_internal_v1(boolean)'::regprocedure
                 and prosecdef and proowner = 'postgres'::regrole) then
    raise exception 'Unexpected projection function owner or security mode';
  end if;
  for rel, priv in
    select t, unnest(p) from (values
      ('reporting.operational_canonical_flight_legs'::regclass, array['SELECT','INSERT','DELETE']),
      ('reporting.operational_canonical_flight_legs_quarantine'::regclass, array['SELECT','INSERT','DELETE']),
      ('reporting.operational_canonical_flight_legs_state'::regclass, array['SELECT','INSERT','UPDATE'])
    ) as targets(t,p)
  loop
    if not has_table_privilege('postgres', rel, priv) then
      execute format('grant %s on table %s to postgres', priv, rel);
      if not has_table_privilege('postgres', rel, priv) then
        raise exception 'Grant failed: % on %', priv, rel;
      end if;
      insert into reporting.projection_acl_delta_20261127 values (rel,priv) on conflict do nothing;
    end if;
  end loop;
end;
$$;
commit;
