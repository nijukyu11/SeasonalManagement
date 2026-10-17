-- 20261008090000_seasonal_publish_safety_v1.sql
-- Native Publish safety:
-- 1. Collision safety against active manual/other-season/existing operational legs
--    excluding legitimately retired or rekeyed targets, with writer lock re-verification.
-- 2. Preserve Pax corrections (including 0 and NULL) across draft republishes via
--    operational_resource_overrides and event backfill.
-- 3. Shared effective target computation (seasonal_publish_effective_targets_v1)
--    used identically by both preview AND commit:
--    - Eliminates divergence between preview impact and commit application
--    - Fully normalized symmetric before_state and after_state comparison
--    - Exact field mapping: code_shares, int_dom_ind, raw_flight_number, counters, checkin_windows
--    - Overnight flight date preservation (draft date fallback, not operational_date)
--    - counter_token derived from effective counters exactly matching commit
--    - Stable deterministic target_id allocation for new legs
--    - Precise current un-superseded operational delta detection for ack
-- 4. Explicit operational-impact acknowledgement enforcement (bound to preview hash)
--    when overwriting active operational edits.
-- 5. Publish kind distinction: release vs reapply vs no-op.
--    True no-op does not create new version rows, write legs, or bump revision.
-- 6. RPC get_seasonal_publish_operational_impact_page_v1 with auth, pagination, and stale detection.
-- 7. commit_seasonal_publish_v1 signature updated to 5 parameters with p_acknowledge_operational default false,
--    and deterministic receipt replay checking both notes and acknowledgement.

begin;
set local lock_timeout = '15s';
set local statement_timeout = '60s';

-- 1. Add columns to seasonal_publish_versions
alter table public.seasonal_publish_versions
  add column if not exists publish_kind text not null default 'release'
    check (publish_kind in ('release', 'reapply', 'noop')),
  add column if not exists skipped_days jsonb not null default '[]'::jsonb;

-- 2. Create operational impact entries table (RPC-only access, no public/authenticated SELECT)
create table if not exists public.seasonal_publish_operational_impact_entries (
  preview_id uuid not null references public.seasonal_publish_previews(preview_id) on delete cascade,
  entry_index bigint not null,
  change_type text not null check (change_type in ('added', 'modified', 'removed')),
  leg_id uuid,
  draft_id text,
  operational_date date not null,
  before_state jsonb,
  after_state jsonb,
  changed_fields text[] not null default array[]::text[],
  overwrites_operational boolean not null default false,
  primary key (preview_id, entry_index)
);

create index if not exists seasonal_publish_operational_impact_page_v1
  on public.seasonal_publish_operational_impact_entries(preview_id, entry_index);

revoke all on public.seasonal_publish_operational_impact_entries from public, anon, authenticated;

-- 3. Capture Pax into operational_resource_overrides
create or replace function public.capture_operational_resource_overrides_v1() returns trigger
language plpgsql security definer set search_path=pg_catalog,public as $$
declare v_fields jsonb;
begin
  if new.target_type<>'operationalLeg' then return null; end if;
  select jsonb_object_agg(k,new.after_state->k) into v_fields from unnest(new.changed_fields) k
  where k=any(array['gate','stand','carousel','pax','counter_token','counters','checkin_windows',
    'check_in_start','check_in_end','check_in_allocation_mode','mct','fb','lb','bhs','ghs']);
  if v_fields is not null then
    insert into public.operational_resource_overrides values(new.target_id::uuid,v_fields)
    on conflict(leg_id) do update set fields=public.operational_resource_overrides.fields||excluded.fields;
  end if;
  return null;
end;
$$;
revoke all on function public.capture_operational_resource_overrides_v1() from public, anon, authenticated;

-- 4. Backfill only missing Pax corrections from operational change events
-- Does NOT wipe existing native resources or overwrite active masks.
insert into public.operational_resource_overrides(leg_id, fields)
select target_id::uuid, jsonb_build_object('pax', case when jsonb_typeof(value)='null' then null else (value)::integer end)
from (
  select distinct on(e.target_id) e.target_id, e.after_state->'pax' as value
  from public.operational_change_events e
  where e.target_type = 'operationalLeg'
    and 'pax' = any(e.changed_fields)
  order by e.target_id, e.server_seq desc
) latest
where exists (
  select 1 from public.operational_flight_legs l where l.leg_id = latest.target_id::uuid and l.status = 'active'
)
on conflict(leg_id) do update set fields =
  case when public.operational_resource_overrides.fields ? 'pax'
       then public.operational_resource_overrides.fields
       else public.operational_resource_overrides.fields || excluded.fields
  end;

-- 5. Enhanced seasonal_publish_operations_v1 with comprehensive collision detection
create or replace function public.seasonal_publish_operations_v1(p_season_id text)
returns table(operation text,draft_id text,leg_id uuid,seed_leg_id uuid,operational_date date,
  linked_draft_id text,preserved_link_id uuid,issue text)
language sql stable security definer set search_path=pg_catalog,public as $$
 with drafts as materialized (
   select d.draft_id,d.type,d.airline,d.flight_number,d.linked_draft_id,d.turnaround_id,d.link_type,d.pair_anchor_date,
     coalesce(nullif(d.operational_date,''),public.seasonal_operational_date_v2(
       coalesce(nullif(d.scheduled_date,''),d.date)::date,coalesce(nullif(d.schedule,''),d.scheduled_time)::time)::text)::date op_day
   from public.seasonal_flight_drafts d where d.season_id=p_season_id and d.status='active'
 ), eligible as materialized (
   select * from drafts d where d.op_day>(now() at time zone 'Asia/Ho_Chi_Minh')::date
     and not exists(select 1 from public.operational_day_authority a where a.operational_date=d.op_day and a.reset_at is null)
 ), owned as materialized (
   select * from public.operational_flight_legs where source_season_id=p_season_id and source_type='published_seasonal'
 ), seeds as (
   select distinct on(source_draft_id) * from owned
   order by source_draft_id,(status='active') desc,lineage_generation desc,created_at desc,leg_id
 ), families as (
   select source_draft_id,count(distinct lineage_id) lineage_count from owned group by source_draft_id
 ), active_operational as materialized (
   select l.leg_id,l.source_season_id,l.source_type,l.source_draft_id,l.operational_date,
     case l.side when 'ARR' then 'A' when 'DEP' then 'D' else l.side end type,
     upper(btrim(l.airline)) airline,upper(btrim(l.flight_number)) flight_number
   from public.operational_flight_legs l
   where l.status='active'
 ), retiring_legs as materialized (
   select o.leg_id from owned o
   where o.status='active' and o.operational_date>(now() at time zone 'Asia/Ho_Chi_Minh')::date
     and not exists(select 1 from public.operational_day_authority a where a.operational_date=o.operational_date and a.reset_at is null)
     and not exists(select 1 from eligible d where d.draft_id=o.source_draft_id)
 ), rekeying_legs as materialized (
   select s.leg_id from eligible d
   join seeds s on s.source_draft_id=d.draft_id and s.status='active'
   where (s.operational_date,case s.side when 'ARR' then 'A' when 'DEP' then 'D' else s.side end,upper(btrim(s.airline)),upper(btrim(s.flight_number)))
     is distinct from (d.op_day,d.type,upper(btrim(d.airline)),upper(btrim(d.flight_number)))
 ), duplicate_keys as materialized (
   select op_day,type,upper(btrim(airline)) airline,upper(btrim(flight_number)) flight_number from eligible
   group by op_day,type,upper(btrim(airline)),upper(btrim(flight_number)) having count(*)>1
 ), colliding_drafts as materialized (
   select d.draft_id
   from eligible d
   left join seeds s on s.source_draft_id=d.draft_id and s.status='active'
   where exists (
     select 1 from duplicate_keys k
     where k.op_day=d.op_day and k.type=d.type
       and k.airline=upper(btrim(d.airline)) and k.flight_number=upper(btrim(d.flight_number))
   )
   or exists (
     select 1 from active_operational ao
     where ao.operational_date=d.op_day
       and ao.type=d.type
       and ao.airline=upper(btrim(d.airline))
       and ao.flight_number=upper(btrim(d.flight_number))
       and ao.leg_id is distinct from s.leg_id
       and ao.leg_id not in (select leg_id from retiring_legs)
       and ao.leg_id not in (select leg_id from rekeying_legs)
   )
 ), proposed(operation,draft_id,leg_id,seed_leg_id,op_day,intended_link,linked_draft_id,turnaround_id,link_type,pair_anchor_date,
     old_link,seed_day,seed_status,partner_link,partner_turnaround,partner_type,partner_anchor,lineage_count,side,partner_side,key_collision) as materialized (
   select 'upsert',d.draft_id,case when s.status='active' then s.leg_id end,s.leg_id,d.op_day,d.linked_draft_id,p.draft_id,
     d.turnaround_id,d.link_type,d.pair_anchor_date::date,s.linked_leg_id,s.operational_date,s.status,
     p.linked_draft_id,p.turnaround_id,p.link_type,p.pair_anchor_date::date,f.lineage_count,d.type,p.type,
     (c.draft_id is not null)
   from eligible d left join seeds s on s.source_draft_id=d.draft_id left join families f on f.source_draft_id=d.draft_id
     left join eligible p on p.draft_id=d.linked_draft_id
     left join colliding_drafts c on c.draft_id=d.draft_id
   union all
   select 'retire',o.source_draft_id,o.leg_id,o.leg_id,o.operational_date,null,null,null,null,null,
     o.linked_leg_id,o.operational_date,o.status,null,null,null,null,null,null,null,false
   from owned o where o.status='active' and o.operational_date>(now() at time zone 'Asia/Ho_Chi_Minh')::date
     and not exists(select 1 from public.operational_day_authority a where a.operational_date=o.operational_date and a.reset_at is null)
     and not exists(select 1 from eligible d where d.draft_id=o.source_draft_id)
 ), writable as materialized (
   select distinct leg_id from proposed where leg_id is not null
 ), incoming_protected as materialized (
   select peer.linked_leg_id,
     count(*) incoming_count,
     max(peer.leg_id::text)::uuid incoming_peer_id
   from writable w
   join public.operational_flight_legs peer on peer.linked_leg_id=w.leg_id and peer.status='active'
   left join writable w2 on w2.leg_id=peer.leg_id
   where w2.leg_id is null
   group by peer.linked_leg_id
 ), preserved as (
   select p.*,case when p.operation='upsert' and p.leg_id is not null and peer.status='active'
     and w_peer.leg_id is null
     and peer.source_season_id=p_season_id and peer.source_draft_id=p.intended_link and peer.linked_leg_id=p.leg_id
     and peer.turnaround_id=p.turnaround_id and old.turnaround_id=p.turnaround_id
     and peer.link_type=p.link_type and old.link_type=p.link_type
     and peer.pair_anchor_date=p.pair_anchor_date and old.pair_anchor_date=p.pair_anchor_date then peer.leg_id end preserved_link_id,
     peer.status peer_status,
     (w_peer.leg_id is not null) peer_in_writable
   from proposed p left join public.operational_flight_legs old on old.leg_id=p.leg_id
     left join public.operational_flight_legs peer on peer.leg_id=p.old_link
     left join writable w_peer on w_peer.leg_id=p.old_link
 )
 select p.operation,p.draft_id,p.leg_id,p.seed_leg_id,p.op_day,p.linked_draft_id,p.preserved_link_id,
   case
     when p.operation='upsert' and p.seed_status='active' and (p.seed_day<=(now() at time zone 'Asia/Ho_Chi_Minh')::date
       or exists(select 1 from public.operational_day_authority a where a.operational_date=p.seed_day and a.reset_at is null))
       then 'PROTECTED_OCCURRENCE_MOVE'
     when p.operation='upsert' and p.seed_status<>'active' and p.lineage_count>1 then 'AMBIGUOUS_OPERATIONAL_LINEAGE'
     when p.key_collision then 'OPERATIONAL_KEY_COLLISION'
     when p.linked_draft_id is not null and (p.partner_link is distinct from p.draft_id or p.side=p.partner_side
       or p.turnaround_id is null or p.partner_turnaround is distinct from p.turnaround_id
       or p.link_type is null or p.partner_type is distinct from p.link_type
       or p.pair_anchor_date is null or p.partner_anchor is distinct from p.pair_anchor_date) then 'INVALID_PLANNING_PAIR'
     when p.leg_id is not null and (
       (p.peer_status='active' and p.preserved_link_id is null and not p.peer_in_writable)
       or (inc.linked_leg_id is not null and (inc.incoming_count > 1 or inc.incoming_peer_id is distinct from p.preserved_link_id)))
       then 'PROTECTED_COUNTERPART'
   end
 from preserved p
   left join incoming_protected inc on inc.linked_leg_id=p.leg_id
$$;
revoke all on function public.seasonal_publish_operations_v1(text) from public, anon, authenticated;

-- 6. Shared effective target computation called identically by preview AND commit
drop function if exists public.seasonal_publish_effective_targets_v1(text, boolean);
drop function if exists public.seasonal_publish_effective_targets_v1(text);
create or replace function public.seasonal_publish_effective_targets_v1(
  p_season_id text
)
returns table(
  operation text,
  draft_id text,
  leg_id uuid,
  seed_leg_id uuid,
  target_id uuid,
  lineage_id uuid,
  lineage_generation integer,
  operational_date date,
  leg_key text,
  effective_draft public.seasonal_flight_drafts,
  effective_counters jsonb,
  effective_windows jsonb,
  effective_counter_token text,
  effective_linked_leg_id uuid,
  effective_turnaround_id text,
  effective_link_type text,
  effective_pair_anchor_date date,
  overrides jsonb,
  before_state jsonb,
  after_state jsonb,
  changed_fields text[],
  candidate_change_type text,
  overwrites_operational boolean,
  has_operational_edit boolean,
  target_data jsonb
)
language sql volatile security definer set search_path=pg_catalog,public as $$
  with ops as materialized (
    select * from public.seasonal_publish_operations_v1(p_season_id)
  ),
  allocated as materialized (
    select o.*,
      coalesce(o.leg_id, gen_random_uuid()) as target_id
    from ops o
  ),
  effective_drafts as materialized (
    select a.*,
      case when a.operation = 'retire' then null::public.seasonal_flight_drafts
      else
        jsonb_populate_record(
          d,
          coalesce(ov.fields, '{}'::jsonb)
        )
      end as d,
      coalesce(ov.fields, '{}'::jsonb) as ov_fields,
      coalesce(seed.lineage_id, a.target_id) as res_lineage_id,
      case
        when a.leg_id is not null then seed.lineage_generation
        else coalesce((select max(lineage_generation) from public.operational_flight_legs where lineage_id = seed.lineage_id), -1) + 1
      end as res_generation
    from allocated a
    left join public.seasonal_flight_drafts d on d.draft_id = a.draft_id
    left join public.operational_flight_legs seed on seed.leg_id = a.seed_leg_id
    left join public.operational_resource_overrides ov on ov.leg_id = a.seed_leg_id
  ),
  resources as materialized (
    select e.*,
      case
        when e.operation = 'retire' then '[]'::jsonb
        when e.ov_fields ? 'counters' then e.ov_fields->'counters'
        when e.ov_fields ? 'counter_token' and not e.ov_fields ? 'counters' then
          coalesce((
            select jsonb_agg(jsonb_build_object('counter_group','__single__','item_index',ordinality-1,'counter_value',btrim(value)) order by ordinality)
            from unnest(string_to_array(e.ov_fields->>'counter_token',',')) with ordinality t(value,ordinality)
            where btrim(value) <> ''
          ), '[]'::jsonb)
        else coalesce((e.d).counters, '[]'::jsonb)
      end as res_counters,
      case
        when e.operation = 'retire' then '[]'::jsonb
        when e.ov_fields ? 'checkin_windows' then e.ov_fields->'checkin_windows'
        else coalesce((e.d).checkin_windows, '[]'::jsonb)
      end as res_windows
    from effective_drafts e
  ),
  paired as materialized (
    select r.*,
      (select string_agg(c->>'counter_value', ',' order by c->>'counter_group', (c->>'item_index')::integer)
       from jsonb_array_elements(r.res_counters) c) as res_counter_token,
      case when r.operation = 'upsert' then coalesce(partner.target_id, r.preserved_link_id) end as res_linked_leg_id,
      case when r.operation = 'upsert' and coalesce(partner.target_id, r.preserved_link_id) is not null then nullif(btrim((r.d).turnaround_id), '') end as res_turnaround_id,
      case when r.operation = 'upsert' and coalesce(partner.target_id, r.preserved_link_id) is not null then nullif(btrim((r.d).link_type), '') end as res_link_type,
      case when r.operation = 'upsert' and coalesce(partner.target_id, r.preserved_link_id) is not null then (r.d).pair_anchor_date::date end as res_pair_anchor_date,
      case when r.operation = 'upsert' then
        (r.d).type || chr(31) || r.operational_date::text || chr(31) || upper(btrim((r.d).airline)) || chr(31) || upper(btrim((r.d).flight_number))
      end as res_leg_key
    from resources r
    left join allocated partner on partner.draft_id = r.linked_draft_id
  ),
  with_states as materialized (
    select p.*,
      case when p.leg_id is not null then
        jsonb_build_object(
          'airline', upper(btrim(l.airline)),
          'flight_number', upper(btrim(l.flight_number)),
          'raw_flight_number', nullif(btrim(l.raw_flight_number), ''),
          'scheduled_date', l.scheduled_date::text,
          'scheduled_time', case when l.scheduled_time is not null then to_char(l.scheduled_time, 'HH24:MI:SS') end,
          'operational_date', l.operational_date::text,
          'side', l.side,
          'route', coalesce(nullif(btrim(l.route), ''), ''),
          'aircraft_type', coalesce(nullif(btrim(l.aircraft_type), ''), 'Unknown'),
          'flight_category', coalesce(nullif(btrim(l.flight_category), ''), 'C'),
          'pax', l.pax,
          'code_shares', nullif(btrim(l.code_shares), ''),
          'int_dom_ind', nullif(btrim(l.int_dom_ind), ''),
          'stand', nullif(btrim(l.stand), ''),
          'gate', l.gate,
          'carousel', l.carousel,
          'counter_token', nullif(btrim(l.counter_token), ''),
          'counters', coalesce((
            select jsonb_agg(jsonb_build_object('counter_group', c.counter_group, 'item_index', c.item_index, 'counter_value', c.counter_value)
              order by c.counter_group, c.item_index)
            from public.operational_leg_counters c where c.leg_id = l.leg_id
          ), '[]'::jsonb),
          'checkin_windows', coalesce((
            select jsonb_agg(jsonb_build_object('counter_key', w.counter_key, 'window_start', w.window_start, 'window_end', w.window_end)
              order by w.counter_key)
            from public.operational_leg_checkin_windows w where w.leg_id = l.leg_id
          ), '[]'::jsonb),
          'mct', nullif(btrim(l.mct), ''),
          'fb', nullif(btrim(l.fb), ''),
          'lb', nullif(btrim(l.lb), ''),
          'bhs', nullif(btrim(l.bhs), ''),
          'ghs', nullif(btrim(l.ghs), ''),
          'check_in_start', nullif(btrim(l.check_in_start), ''),
          'check_in_end', nullif(btrim(l.check_in_end), ''),
          'check_in_allocation_mode', nullif(btrim(l.check_in_allocation_mode), ''),
          'linked_leg_id', case when l.linked_leg_id is not null then l.linked_leg_id::text end,
          'turnaround_id', nullif(btrim(l.turnaround_id), ''),
          'link_type', nullif(btrim(l.link_type), ''),
          'pair_anchor_date', case when l.pair_anchor_date is not null then l.pair_anchor_date::text end,
          'status', l.status,
          'deletion_reason', l.deletion_reason
        )
      end as computed_before,
      case
        when p.operation = 'retire' then null::jsonb
        else
          jsonb_build_object(
            'airline', upper(btrim((p.d).airline)),
            'flight_number', upper(btrim((p.d).flight_number)),
            'raw_flight_number', nullif(btrim((p.d).raw_flight_number), ''),
            'scheduled_date', coalesce(nullif((p.d).scheduled_date, ''), (p.d).date),
            'scheduled_time', case when nullif((p.d).schedule, '') is not null then to_char(((p.d).schedule)::time, 'HH24:MI:SS') end,
            'operational_date', p.operational_date::text,
            'side', case (p.d).type when 'A' then 'ARR' else 'DEP' end,
            'route', coalesce(nullif(btrim((p.d).route), ''), ''),
            'aircraft_type', coalesce(nullif(btrim((p.d).aircraft), ''), 'Unknown'),
            'flight_category', coalesce(nullif(btrim((p.d).category), ''), 'C'),
            'pax', (p.d).pax,
            'code_shares', nullif(btrim((p.d).code_shares), ''),
            'int_dom_ind', nullif(btrim((p.d).int_dom_ind), ''),
            'stand', nullif(btrim((p.d).stand), ''),
            'gate', (p.d).gate,
            'carousel', (p.d).carousel,
            'counter_token', nullif(btrim(p.res_counter_token), ''),
            'counters', p.res_counters,
            'checkin_windows', p.res_windows,
            'mct', nullif(btrim((p.d).mct), ''),
            'fb', nullif(btrim((p.d).fb), ''),
            'lb', nullif(btrim((p.d).lb), ''),
            'bhs', nullif(btrim((p.d).bhs), ''),
            'ghs', nullif(btrim((p.d).ghs), ''),
            'check_in_start', nullif(btrim((p.d).check_in_start), ''),
            'check_in_end', nullif(btrim((p.d).check_in_end), ''),
            'check_in_allocation_mode', nullif(btrim((p.d).check_in_allocation_mode), ''),
            'linked_leg_id', case when p.res_linked_leg_id is not null then p.res_linked_leg_id::text end,
            'turnaround_id', nullif(btrim(p.res_turnaround_id), ''),
            'link_type', nullif(btrim(p.res_link_type), ''),
            'pair_anchor_date', case when p.res_pair_anchor_date is not null then p.res_pair_anchor_date::text end,
            'status', 'active',
            'deletion_reason', null
          )
      end as computed_after
    from paired p
    left join public.operational_flight_legs l on l.leg_id = p.leg_id
  ),
  evaluated as (
    select s.*,
      case
        when s.operation = 'upsert' and s.leg_id is null then 'added'
        when s.operation = 'retire' then 'removed'
        else 'modified'
      end as initial_change_type,
      case
        when s.operation = 'upsert' and s.leg_id is null then array['added']
        when s.operation = 'retire' then array['status', 'deletion_reason']
        else
          coalesce((
            select array_agg(f) from unnest(array[
              'airline', 'flight_number', 'raw_flight_number', 'scheduled_date', 'scheduled_time', 'side', 'route',
              'aircraft_type', 'flight_category', 'pax', 'code_shares', 'int_dom_ind', 'stand', 'gate', 'carousel',
              'counter_token', 'counters', 'checkin_windows', 'mct', 'fb', 'lb', 'bhs', 'ghs',
              'check_in_start', 'check_in_end', 'check_in_allocation_mode',
              'linked_leg_id', 'turnaround_id', 'link_type', 'pair_anchor_date'
            ]) f where (s.computed_before->f) is distinct from (s.computed_after->f)
          ), array[]::text[])
      end as diff_fields
    from with_states s
  )
  select
    e.operation,
    e.draft_id,
    e.leg_id,
    e.seed_leg_id,
    e.target_id,
    e.res_lineage_id as lineage_id,
    e.res_generation as lineage_generation,
    e.operational_date,
    e.res_leg_key as leg_key,
    e.d as effective_draft,
    e.res_counters as effective_counters,
    e.res_windows as effective_windows,
    e.res_counter_token as effective_counter_token,
    e.res_linked_leg_id as effective_linked_leg_id,
    e.res_turnaround_id as effective_turnaround_id,
    e.res_link_type as effective_link_type,
    e.res_pair_anchor_date as effective_pair_anchor_date,
    e.ov_fields as overrides,
    e.computed_before as before_state,
    e.computed_after as after_state,
    e.diff_fields as changed_fields,
    case
      when e.initial_change_type = 'added' then 'added'
      when e.initial_change_type = 'removed' then 'removed'
      when array_length(e.diff_fields, 1) is null or array_length(e.diff_fields, 1) = 0 then 'unchanged'
      else 'modified'
    end as candidate_change_type,
    -- overwrites_operational: only true if there are actual diff_fields AND those fields touch current un-superseded operational edits
    case
      when e.initial_change_type = 'added' then false
      when e.initial_change_type = 'removed' then
        (e.ov_fields is not null and e.ov_fields <> '{}'::jsonb) or exists (
          select 1 from public.operational_change_events ce
          where ce.target_id = e.leg_id::text
            and ce.target_type = 'operationalLeg'
            and not (ce.changed_fields <@ array['publish','daily','legacy-backfill']::text[])
        )
      when array_length(e.diff_fields, 1) is null or array_length(e.diff_fields, 1) = 0 then false
      else
        exists (
          select 1 from unnest(e.diff_fields) cf
          where exists (
            select 1 from public.operational_change_events ce
            where ce.target_id = e.leg_id::text
              and ce.target_type = 'operationalLeg'
              and cf = any(ce.changed_fields)
              and not (cf = any(array['publish','daily','legacy-backfill']::text[]))
          )
        )
    end as overwrites_operational,
    -- has_operational_edit:
    (
      (e.ov_fields is not null and e.ov_fields <> '{}'::jsonb)
      or exists (
        select 1 from public.operational_change_events ce
        where ce.target_id = e.leg_id::text
          and ce.target_type = 'operationalLeg'
          and not (ce.changed_fields <@ array['publish','daily','legacy-backfill']::text[])
      )
    ) as has_operational_edit,
    -- target_data for operational_flight_legs:
    case when e.operation = 'upsert' then
      to_jsonb(e.d) || jsonb_build_object(
        'leg_id', e.target_id,
        'lineage_id', e.res_lineage_id,
        'lineage_generation', e.res_generation,
        'leg_key', e.res_leg_key,
        'operational_date', e.operational_date,
        'scheduled_date', coalesce(nullif((e.d).scheduled_date, ''), (e.d).date),
        'scheduled_time', (e.d).schedule,
        'side', case (e.d).type when 'A' then 'ARR' else 'DEP' end,
        'aircraft_type', coalesce(nullif(btrim((e.d).aircraft), ''), 'Unknown'),
        'flight_category', coalesce(nullif(btrim((e.d).category), ''), 'C'),
        'counter_token', e.res_counter_token,
        'source_type', 'published_seasonal',
        'source_season_id', p_season_id,
        'source_draft_id', e.draft_id,
        'source_batch_id', null,
        'source_occurrence_key', e.draft_id,
        'source_row_number', (e.d).source_row_index,
        'linked_leg_id', e.res_linked_leg_id,
        'turnaround_id', e.res_turnaround_id,
        'link_type', e.res_link_type,
        'pair_anchor_date', e.res_pair_anchor_date,
        'status', 'active',
        'deletion_reason', null
      )
    end as target_data
  from evaluated e
$$;

revoke all on function public.seasonal_publish_effective_targets_v1(text) from public, anon, authenticated;

-- 7. Updated preview_seasonal_publish_v1
create or replace function public.preview_seasonal_publish_v1(p_season_id text,p_request_id uuid,p_published_on date default (now() at time zone 'Asia/Ho_Chi_Minh')::date) returns jsonb
language plpgsql security definer set search_path=pg_catalog,public set statement_timeout='30s' as $$
declare
 v_actor uuid:=auth.uid(); v_season public.seasons%rowtype; v_workspace public.seasonal_draft_workspace%rowtype;
 v_existing public.seasonal_publish_previews%rowtype; v_id uuid:=gen_random_uuid(); v_base uuid;
 v_before jsonb; v_snapshot jsonb; v_checksum text; v_scope text;
 v_today date:=(now() at time zone 'Asia/Ho_Chi_Minh')::date; v_tag text; v_sequence integer; v_start date; v_end date;
 v_publish_kind text; v_requires_ack boolean;
 v_planning_added integer:=0; v_planning_modified integer:=0; v_planning_removed integer:=0;
 v_op_added integer:=0; v_op_modified integer:=0; v_op_removed integer:=0; v_op_unchanged integer:=0; v_op_overwrites integer:=0;
begin
 if v_actor is null or public.app_operator_has_permission('seasonal.write') is not true then
   raise exception 'seasonal.write permission is required' using errcode='42501'; end if;
 if p_request_id is null or p_published_on is null or not isfinite(p_published_on) then raise exception 'Request ID and finite publish date required' using errcode='22023'; end if;
 perform 1 from public.operational_workspace_revision where singleton for share;
 select * into v_season from public.seasons where id=p_season_id for share;
 if not found then raise exception 'Season not found' using errcode='P0002'; end if;
 perform pg_advisory_xact_lock(hashtextextended('publish-preview:'||v_actor::text||':'||p_request_id::text,0));
 select * into v_existing from public.seasonal_publish_previews where actor_id=v_actor and request_id=p_request_id;
 if found then
   if v_existing.season_id<>p_season_id or v_existing.published_on<>p_published_on then raise exception 'Request ID reused' using errcode='22023'; end if;
   return jsonb_build_object('previewId',v_existing.preview_id,'previewHash',v_existing.preview_hash,'status',v_existing.status,
     'preview',v_existing.preview,'expiresAt',v_existing.expires_at);
 end if;
 select * into strict v_workspace from public.seasonal_draft_workspace where season_id=p_season_id for share;
 select version_id into v_base from public.seasonal_publish_versions where season_id=p_season_id order by publish_sequence desc limit 1;
 select snapshot_payload into v_before from public.seasonal_publish_snapshots where version_id=v_base;
 v_snapshot:=public.seasonal_planning_snapshot_v1(p_season_id);
 v_checksum:=encode(sha256(convert_to(v_snapshot::text,'UTF8')),'hex');
 v_scope:=public.seasonal_publish_scope_fingerprint_v1(p_season_id);
 select start_date,end_date into v_start,v_end from public.seasonal_publish_bounds_v1(p_season_id);
 if v_start is null or v_end is null or not isfinite(v_start) or not isfinite(v_end) or v_start>v_end then
   raise exception 'Finite planning range is required' using errcode='22023'; end if;
 select coalesce(max(sequence_in_day),0)+1 into v_sequence from public.seasonal_publish_versions
   where season_id=p_season_id and split_part(version_tag,'.',1)=public.seasonal_publish_version_tag(v_season.season_code,p_published_on,1);
 v_tag:=public.seasonal_publish_version_tag(v_season.season_code,p_published_on,v_sequence);

 drop table if exists pg_temp.preview_diff;
 create temporary table preview_diff on commit drop as
   select * from public.seasonal_planning_diff_v1(v_before,v_snapshot);

 select count(*) filter(where d.change_type='added'),
        count(*) filter(where d.change_type='modified'),
        count(*) filter(where d.change_type='removed')
   into v_planning_added, v_planning_modified, v_planning_removed
   from pg_temp.preview_diff d;

 drop table if exists pg_temp.preview_targets;
 create temporary table preview_targets on commit drop as
  select * from public.seasonal_publish_effective_targets_v1(p_season_id);

 select count(*) filter(where candidate_change_type='added'),
        count(*) filter(where candidate_change_type='modified'),
        count(*) filter(where candidate_change_type='removed'),
        count(*) filter(where candidate_change_type='unchanged'),
        count(*) filter(where overwrites_operational=true)
   into v_op_added, v_op_modified, v_op_removed, v_op_unchanged, v_op_overwrites
   from pg_temp.preview_targets;

 v_requires_ack := (v_op_overwrites > 0);

 -- Determine publishKind
 v_publish_kind := case
   when (v_planning_added=0 and v_planning_modified=0 and v_planning_removed=0)
    and (v_op_added=0 and v_op_modified=0 and v_op_removed=0) then 'noop'
   when (v_planning_added=0 and v_planning_modified=0 and v_planning_removed=0) then 'reapply'
   else 'release'
 end;

 with built as (
 select jsonb_build_object(
   'publishContractVersion',2,'baseVersionId',v_base,'draftRevision',v_workspace.revision::text,'draftEpoch',v_workspace.epoch,
   'draftChecksum',v_checksum,'scopeFingerprint',v_scope,'businessToday',v_today,'proposedTag',v_tag,
   'publishedOn',p_published_on,'sequenceInDay',v_sequence,'rangeStart',v_start,'rangeEnd',v_end,
   'planningCounts', jsonb_build_object(
     'added', v_planning_added, 'modified', v_planning_modified,
     'removed', v_planning_removed,
     'unchanged', (select count(*) filter(where d.change_type='unchanged') from pg_temp.preview_diff d),
     'ambiguous', (select count(*) filter(where d.change_type='ambiguous') from pg_temp.preview_diff d)
   ),
   'operationalCounts', jsonb_build_object(
     'write', (select count(*) from pg_temp.preview_targets where operation='upsert'),
     'retire', (select count(*) from pg_temp.preview_targets where operation='retire')
   ),
   'operationalImpactCounts', jsonb_build_object(
     'added', v_op_added, 'modified', v_op_modified, 'removed', v_op_removed,
     'unchanged', v_op_unchanged, 'overwrites', v_op_overwrites
   ),
   'requiresOperationalAcknowledgement', v_requires_ack,
   'publishKind', v_publish_kind,
   'diagnostics', coalesce((select jsonb_agg(jsonb_build_object('code','AMBIGUOUS_PLANNING_IDENTITY','flightKey',key)) from
     (select distinct d.flight_key key from pg_temp.preview_diff d where d.change_type='ambiguous') x),'[]'::jsonb)
     ||coalesce((select jsonb_agg(jsonb_build_object('code',o.issue,'draftId',o.draft_id,'legId',o.leg_id,'operationalDate',o.operational_date))
       from (select * from public.seasonal_publish_operations_v1(p_season_id) where issue is not null order by operational_date,draft_id limit 1999) o),'[]'::jsonb),
   'operationalDiagnosticCount',(select count(*) from public.seasonal_publish_operations_v1(p_season_id) where issue is not null),
   'skippedDays',coalesce((select jsonb_agg(a.operational_date order by a.operational_date) from public.operational_day_authority a
     where a.operational_date between v_start and v_end and a.reset_at is null),'[]'::jsonb),
   'publishableDays',coalesce((select jsonb_agg(day::date order by day) from generate_series(
     greatest(v_start,v_today+1)::timestamp,v_end::timestamp,interval '1 day') day
     where not exists(select 1 from public.operational_day_authority a where a.operational_date=day::date and a.reset_at is null)),'[]'::jsonb)
 ) body
 ), saved as (
   insert into public.seasonal_publish_previews(preview_id,actor_id,request_id,season_id,published_on,base_version_id,
     draft_epoch,draft_revision,draft_checksum,scope_fingerprint,planning_snapshot,preview,preview_hash,status)
   select v_id,v_actor,p_request_id,p_season_id,p_published_on,v_base,v_workspace.epoch,v_workspace.revision,v_checksum,v_scope,
     v_snapshot,b.body,encode(sha256(convert_to(b.body::text,'UTF8')),'hex'),
     case when exists(select 1 from pg_temp.preview_diff where change_type='ambiguous')
            or exists(select 1 from public.seasonal_publish_operations_v1(p_season_id) where issue is not null)
       then 'blocked' else 'ready' end from built b returning *
 ), details as (
   insert into public.seasonal_publish_preview_entries
   select s.preview_id,row_number() over(order by d.operational_date,d.flight_key,d.source_draft_id),d.change_type,d.flight_key,
     d.source_draft_id,d.operational_date,d.side,d.airline,d.flight_number,d.before_state,d.after_state,d.changed_fields
     from pg_temp.preview_diff d cross join saved s where d.change_type in('added','modified','removed') returning entry_index
 ), impact_details as (
   insert into public.seasonal_publish_operational_impact_entries(
     preview_id,entry_index,change_type,leg_id,draft_id,operational_date,
     before_state,after_state,changed_fields,overwrites_operational
   )
   select s.preview_id,
     row_number() over(order by t.operational_date, t.leg_id, t.draft_id),
     t.candidate_change_type, t.leg_id, t.draft_id, t.operational_date,
     t.before_state, t.after_state, t.changed_fields, t.overwrites_operational
   from pg_temp.preview_targets t cross join saved s
   where t.candidate_change_type in ('added', 'modified', 'removed')
   returning entry_index
 )
 select * into v_existing from saved;
 return jsonb_build_object('previewId',v_existing.preview_id,'previewHash',v_existing.preview_hash,
   'status',v_existing.status,'preview',v_existing.preview,'expiresAt',v_existing.expires_at);
end;
$$;

-- 8. RPC get_seasonal_publish_operational_impact_page_v1
create or replace function public.get_seasonal_publish_operational_impact_page_v1(
  p_preview_id uuid,
  p_preview_hash text,
  p_after_index bigint default 0,
  p_page_size integer default 100
) returns jsonb
language plpgsql stable security definer set search_path=pg_catalog,public as $$
declare
  v_preview public.seasonal_publish_previews%rowtype;
  v_result jsonb;
begin
  if auth.uid() is null or (
    public.app_operator_has_permission('seasonal.read') is not true and
    public.app_operator_has_permission('seasonal.write') is not true
  ) then
    raise exception 'seasonal permission required' using errcode='42501';
  end if;
  if p_after_index is null or p_after_index<0 or p_page_size is null or p_page_size not between 1 and 500 then
    raise exception 'Invalid impact page' using errcode='22023';
  end if;
  select * into v_preview from public.seasonal_publish_previews
    where preview_id=p_preview_id and actor_id=auth.uid();
  if not found then raise exception 'Preview not found' using errcode='P0002'; end if;
  if v_preview.preview_hash is distinct from p_preview_hash or v_preview.expires_at<=now() then
    raise exception 'Preview expired or hash changed' using errcode='PT409';
  end if;

  with candidates as materialized (
    select * from public.seasonal_publish_operational_impact_entries
    where preview_id=p_preview_id and entry_index>p_after_index
    order by entry_index limit p_page_size+1
  ), page as (
    select * from candidates order by entry_index limit p_page_size
  )
  select jsonb_build_object(
    'entries', coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'entry_index', entry_index::text,
          'leg_id', case when leg_id is not null then leg_id::text else null end,
          'draft_id', draft_id,
          'operational_date', operational_date::text,
          'change_type', change_type,
          'before_state', before_state,
          'after_state', after_state,
          'changed_fields', to_jsonb(changed_fields),
          'overwrites_operational', overwrites_operational
        ) order by entry_index
      ) from page
    ), '[]'::jsonb),
    'hasMore', (select count(*) from candidates) > p_page_size,
    'nextIndex', (select max(entry_index)::text from page),
    'stale', (v_preview.status <> 'committed') and (
      not exists(select 1 from public.seasonal_draft_workspace w where w.season_id=v_preview.season_id
          and w.epoch=v_preview.draft_epoch and w.revision=v_preview.draft_revision)
      or v_preview.draft_checksum is distinct from encode(sha256(convert_to(public.seasonal_planning_snapshot_v1(v_preview.season_id)::text,'UTF8')),'hex')
      or v_preview.scope_fingerprint is distinct from public.seasonal_publish_scope_fingerprint_v1(v_preview.season_id)
    )
  ) into v_result;

  return v_result;
end;
$$;

revoke all on function public.get_seasonal_publish_operational_impact_page_v1(uuid,text,bigint,integer) from public,anon;
grant execute on function public.get_seasonal_publish_operational_impact_page_v1(uuid,text,bigint,integer) to authenticated;

-- 9. Drop 4-parameter commit_seasonal_publish_v1 to avoid overload ambiguity
drop function if exists public.commit_seasonal_publish_v1(text,uuid,text,text);

-- 10. 5-parameter commit_seasonal_publish_v1 with shared effective targets and noop/reapply semantics
create or replace function public.commit_seasonal_publish_v1(
  p_season_id text,
  p_preview_id uuid,
  p_preview_hash text,
  p_notes text default '',
  p_acknowledge_operational boolean default false
) returns jsonb
language plpgsql security definer set search_path=pg_catalog,public set statement_timeout='45s' as $$
declare
 p public.seasonal_publish_previews%rowtype; w public.seasonal_draft_workspace%rowtype;
 v_actor uuid:=auth.uid(); v_base uuid; v_version uuid; v_day date; v_result jsonb; v_revision bigint;
 v_publish_kind text;
begin
 if v_actor is null or public.app_operator_has_permission('seasonal.write') is not true then
   raise exception 'seasonal.write permission required' using errcode='42501'; end if;
 select * into p from public.seasonal_publish_previews where preview_id=p_preview_id and actor_id=v_actor and season_id=p_season_id;
 if not found then raise exception 'Publish preview unavailable' using errcode='42501'; end if;
 perform 1 from public.operational_workspace_revision where singleton for update;
 perform 1 from public.seasons where id=p_season_id for update;
 select * into strict w from public.seasonal_draft_workspace where season_id=p_season_id for share;
 select * into strict p from public.seasonal_publish_previews where preview_id=p_preview_id for update;
 if p.preview_hash is distinct from p_preview_hash then raise exception 'Publish hash changed' using errcode='40001'; end if;
 if p.status='committed' then
   if (p.result->>'publishKind') is distinct from 'noop' then
     if (select publish_notes from public.seasonal_publish_versions where version_id=(p.result->>'versionId')::uuid)
         is distinct from coalesce(p_notes,'') then raise exception 'Publish notes differ from receipt' using errcode='22023'; end if;
   end if;
   if coalesce((p.result->>'operationalAcknowledged')::boolean, false) is distinct from coalesce(p_acknowledge_operational, false) then
     raise exception 'Publish operational acknowledgement differs from receipt' using errcode='22023';
   end if;
   return p.result;
 end if;

 select version_id into v_base from public.seasonal_publish_versions where season_id=p_season_id order by publish_sequence desc limit 1;
 if p.status<>'ready' or p.expires_at<=now() or p.preview->>'publishContractVersion' not in ('2','3')
   or v_base is distinct from p.base_version_id or w.epoch<>p.draft_epoch or w.revision<>p.draft_revision
   or encode(sha256(convert_to(public.seasonal_planning_snapshot_v1(p_season_id)::text,'UTF8')),'hex')<>p.draft_checksum
   or public.seasonal_publish_scope_fingerprint_v1(p_season_id)<>p.scope_fingerprint then
   raise exception 'Publish preview is stale or blocked; review again' using errcode='40001'; end if;

 if (p.preview->>'requiresOperationalAcknowledgement')::boolean is true and p_acknowledge_operational is not true then
   raise exception 'Operational impact acknowledgement required' using errcode='40001';
 end if;

 v_publish_kind := coalesce(p.preview->>'publishKind', 'release');

 -- Handle TRUE NO-OP: do not write legs, bump revision, or duplicate releases
 if v_publish_kind = 'noop' then
   select revision into v_revision from public.operational_workspace_revision where singleton;
   v_result:=jsonb_build_object(
     'status','committed',
     'previewId',p_preview_id,
     'versionId',v_base,
     'versionTag',coalesce((select version_tag from public.seasonal_publish_versions where version_id=v_base), p.preview->>'proposedTag'),
     'publishKind','noop',
     'planningCounts',p.preview->'planningCounts',
     'operationalCounts',p.preview->'operationalCounts',
     'operationalImpactCounts',p.preview->'operationalImpactCounts',
     'requiresOperationalAcknowledgement',false,
     'operationalAcknowledged',coalesce(p_acknowledge_operational, false),
     'skippedDays',p.preview->'skippedDays',
     'operationalRevision',v_revision::text
   );
   update public.seasonal_publish_previews set status='committed',result=v_result where preview_id=p_preview_id;
   return v_result;
 end if;

 if exists(select 1 from public.seasonal_publish_operations_v1(p_season_id) where issue is not null) then
   raise exception 'Publish operations changed' using errcode='40001'; end if;

 for v_day in
   select op_day from (
     select operational_date as op_day from public.seasonal_publish_operations_v1(p_season_id)
     union select l.operational_date from public.operational_flight_legs l
       join public.seasonal_publish_operations_v1(p_season_id) x on x.leg_id=l.leg_id
   ) dates order by op_day
 loop perform pg_advisory_xact_lock(hashtextextended('operational-day:'||v_day::text,0)); end loop;
 perform 1 from public.operational_flight_legs l
   join public.seasonal_publish_operations_v1(p_season_id) x on x.leg_id=l.leg_id order by l.leg_id for update of l;

 -- Compute shared effective targets under writer lock
 drop table if exists pg_temp.commit_targets;
 create temporary table commit_targets on commit drop as
  select * from public.seasonal_publish_effective_targets_v1(p_season_id);

 insert into public.seasonal_publish_versions(season_id,season_code,version_tag,sequence_in_day,published_by,publish_notes,
   range_start,range_end,total_flight_count,added_count,modified_count,removed_count,unchanged_count,skipped_day_count,diff_summary,snapshot_checksum,
   publish_kind,skipped_days)
 values(p_season_id,p.planning_snapshot->>'seasonCode',p.preview->>'proposedTag',(p.preview->>'sequenceInDay')::integer,v_actor,coalesce(p_notes,''),
   (p.preview->>'rangeStart')::date,(p.preview->>'rangeEnd')::date,(p.planning_snapshot#>>'{counts,active}')::integer,
   (p.preview#>>'{planningCounts,added}')::integer,(p.preview#>>'{planningCounts,modified}')::integer,
   (p.preview#>>'{planningCounts,removed}')::integer,(p.preview#>>'{planningCounts,unchanged}')::integer,
   jsonb_array_length(p.preview->'skippedDays'),p.preview,p.draft_checksum,
   v_publish_kind,p.preview->'skippedDays') returning version_id into v_version;

 insert into public.seasonal_publish_snapshots(version_id,season_id,snapshot_payload,flight_count,checksum)
 values(v_version,p_season_id,p.planning_snapshot,(p.planning_snapshot#>>'{counts,active}')::integer,p.draft_checksum);

 insert into public.seasonal_publish_diff_entries(version_id,base_version_id,season_id,change_type,flight_key,source_draft_id,
   operational_date,side,airline,flight_number,before_state,after_state,changed_fields)
 select v_version,p.base_version_id,p_season_id,change_type,flight_key,source_draft_id,operational_date,side,airline,flight_number,before_state,after_state,changed_fields
 from public.seasonal_publish_preview_entries where preview_id=p_preview_id order by entry_index;

 -- 1. Insert new legs
 insert into public.operational_flight_legs(leg_id,lineage_id,lineage_generation,leg_key,operational_date,scheduled_date,scheduled_time,
   side,airline,flight_number,raw_flight_number,route,aircraft_type,flight_category,pax,code_shares,int_dom_ind,stand,gate,carousel,
   counter_token,mct,fb,lb,bhs,ghs,check_in_start,check_in_end,check_in_allocation_mode,source_type,source_season_id,source_draft_id,
   source_occurrence_key,source_row_number,published_version_id,created_by,updated_by)
 select r.leg_id,r.lineage_id,r.lineage_generation,r.leg_key,r.operational_date,r.scheduled_date,r.scheduled_time,
   r.side,r.airline,r.flight_number,r.raw_flight_number,r.route,r.aircraft_type,r.flight_category,r.pax,r.code_shares,r.int_dom_ind,
   r.stand,r.gate,r.carousel,r.counter_token,r.mct,r.fb,r.lb,r.bhs,r.ghs,r.check_in_start,r.check_in_end,r.check_in_allocation_mode,
   r.source_type,r.source_season_id,r.source_draft_id,r.source_occurrence_key,r.source_row_number,v_version,v_actor,v_actor
 from pg_temp.commit_targets t
 cross join lateral jsonb_populate_record(null::public.operational_flight_legs, t.target_data) r
 where t.operation = 'upsert' and t.leg_id is null;

 -- 2. Update existing active legs
 update public.operational_flight_legs l set
   (leg_key,operational_date,scheduled_date,scheduled_time,side,airline,flight_number,raw_flight_number,route,aircraft_type,flight_category,
    pax,code_shares,int_dom_ind,stand,gate,carousel,counter_token,mct,fb,lb,bhs,ghs,check_in_start,check_in_end,check_in_allocation_mode,
    published_version_id,source_occurrence_key,source_row_number,updated_at,updated_by)=
   (r.leg_key,r.operational_date,r.scheduled_date,r.scheduled_time,r.side,r.airline,r.flight_number,r.raw_flight_number,r.route,r.aircraft_type,r.flight_category,
    r.pax,r.code_shares,r.int_dom_ind,r.stand,r.gate,r.carousel,r.counter_token,r.mct,r.fb,r.lb,r.bhs,r.ghs,r.check_in_start,r.check_in_end,r.check_in_allocation_mode,
    v_version,r.source_occurrence_key,r.source_row_number,now(),v_actor)
 from pg_temp.commit_targets t
 cross join lateral jsonb_populate_record(null::public.operational_flight_legs, t.target_data) r
 where l.leg_id=t.leg_id and l.source_season_id=p_season_id and l.source_type='published_seasonal' and l.status='active'
   and t.operation='upsert';

 -- 3. Retire removed legs
 update public.operational_flight_legs l set status='deleted',deletion_reason='seasonal_publish_removed',
   linked_leg_id=null,turnaround_id=null,link_type=null,pair_anchor_date=null,updated_at=now(),updated_by=v_actor
 from pg_temp.commit_targets t
 where t.operation='retire' and l.leg_id=t.leg_id and l.source_season_id=p_season_id and l.source_type='published_seasonal';

 -- 4. Update pairing linkages
 update public.operational_flight_legs l set
   linked_leg_id=t.effective_linked_leg_id,
   turnaround_id=t.effective_turnaround_id,
   link_type=t.effective_link_type,
   pair_anchor_date=t.effective_pair_anchor_date
 from pg_temp.commit_targets t
 where l.leg_id=t.target_id and t.operation='upsert';

 -- 5. Update counters
 delete from public.operational_leg_counters c using pg_temp.commit_targets t where c.leg_id=t.target_id and t.operation='upsert';
 insert into public.operational_leg_counters select t.target_id,c.counter_group,c.item_index,c.counter_value
 from pg_temp.commit_targets t
 cross join lateral jsonb_to_recordset(t.effective_counters) c(counter_group text,item_index integer,counter_value text)
 where t.operation='upsert';

 -- 6. Update checkin windows
 delete from public.operational_leg_checkin_windows c using pg_temp.commit_targets t where c.leg_id=t.target_id and t.operation='upsert';
 insert into public.operational_leg_checkin_windows select t.target_id,c.counter_key,c.window_start,c.window_end
 from pg_temp.commit_targets t
 cross join lateral jsonb_to_recordset(t.effective_windows) c(counter_key text,window_start text,window_end text)
 where t.operation='upsert';

 -- 7. Override adjustments (preserve existing overrides; attach to newly minted legs if seeded)
 insert into public.operational_resource_overrides(leg_id, fields)
   select t.target_id, t.overrides from pg_temp.commit_targets t
   where t.leg_id is null and t.overrides is not null and t.overrides <> '{}'::jsonb
 on conflict(leg_id) do update set fields = public.operational_resource_overrides.fields || excluded.fields;

 -- 8. Change events
 insert into public.operational_change_events(actor_id,request_id,target_type,target_id,operational_date,changed_fields,before_state,after_state)
 select v_actor,p.request_id,'operationalPublishLeg',l.leg_id::text,l.operational_date,array['publish'],
   coalesce(t.before_state,'null'::jsonb),to_jsonb(l)||jsonb_build_object(
     'counters',coalesce((select jsonb_agg(to_jsonb(c)-'leg_id' order by counter_group,item_index) from public.operational_leg_counters c where c.leg_id=l.leg_id),'[]'),
     'checkin_windows',coalesce((select jsonb_agg(to_jsonb(c)-'leg_id' order by counter_key) from public.operational_leg_checkin_windows c where c.leg_id=l.leg_id),'[]'))
 from public.operational_flight_legs l
 join pg_temp.commit_targets t on t.target_id=l.leg_id
 where t.candidate_change_type in ('added', 'modified', 'removed')
 order by l.leg_id;

 select revision into v_revision from public.operational_workspace_revision where singleton;
 v_result:=jsonb_build_object(
   'status','committed',
   'previewId',p_preview_id,
   'versionId',v_version,
   'versionTag',p.preview->>'proposedTag',
   'publishKind',v_publish_kind,
   'planningCounts',p.preview->'planningCounts',
   'operationalCounts',p.preview->'operationalCounts',
   'operationalImpactCounts',p.preview->'operationalImpactCounts',
   'requiresOperationalAcknowledgement',(p.preview->>'requiresOperationalAcknowledgement')::boolean,
   'operationalAcknowledged',coalesce(p_acknowledge_operational, false),
   'skippedDays',p.preview->'skippedDays',
   'operationalRevision',v_revision::text
 );

 insert into public.operational_change_events(actor_id,request_id,target_type,target_id,operational_date,changed_fields,before_state,after_state)
 values(v_actor,p.request_id,'seasonalPublish','publish:'||v_version::text,(now() at time zone 'Asia/Ho_Chi_Minh')::date,
   array['publish'],jsonb_build_object('baseVersionId',p.base_version_id),v_result);

 update public.seasonal_publish_previews set status='committed',result=v_result where preview_id=p_preview_id;
 perform pg_notify('operational_projection_wake',v_version::text);
 return v_result;
end;
$$;

revoke all on function public.commit_seasonal_publish_v1(text,uuid,text,text,boolean) from public,anon;
grant execute on function public.commit_seasonal_publish_v1(text,uuid,text,text,boolean) to authenticated;

-- 11. Expose publish_kind and skipped_days in get_seasonal_publish_versions_v1
create or replace function public.get_seasonal_publish_versions_v1(p_season_id text,p_after_sequence bigint default null,p_page_size integer default 50) returns jsonb
language plpgsql stable security definer set search_path=pg_catalog,public as $$
declare result jsonb;
begin
 if auth.uid() is null or public.app_operator_has_permission('seasonal.read') is not true then raise exception 'seasonal.read permission required' using errcode='42501'; end if;
 if p_page_size is null or p_page_size not between 1 and 200 or p_after_sequence<1 then raise exception 'Invalid version page' using errcode='22023'; end if;
 with candidates as materialized(select * from public.seasonal_publish_versions where season_id=p_season_id
   and (p_after_sequence is null or publish_sequence<p_after_sequence) order by publish_sequence desc limit p_page_size+1),
 page as(select * from candidates order by publish_sequence desc limit p_page_size)
 select jsonb_build_object('versions',coalesce(jsonb_agg((to_jsonb(page)-'diff_summary')||jsonb_build_object(
   'publish_sequence',publish_sequence::text,
   'publish_kind',publish_kind,
   'skipped_days',coalesce(skipped_days,'[]'::jsonb)
 ) order by publish_sequence desc),'[]'),
   'hasMore',(select count(*)>p_page_size from candidates),'nextSequence',min(publish_sequence)::text) into result from page;
 return result;
end;
$$;

commit;
