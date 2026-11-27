begin;
set local lock_timeout = '5s';
set local statement_timeout = '30s';

do $$
declare
  change record;
begin
  if to_regclass('reporting.projection_acl_delta_20261127') is null then return; end if;
  for change in select target, privilege_name from reporting.projection_acl_delta_20261127 loop
    execute format('revoke %s on table %s from postgres', change.privilege_name, change.target);
  end loop;
end;
$$;
drop table if exists reporting.projection_acl_delta_20261127;
commit;
