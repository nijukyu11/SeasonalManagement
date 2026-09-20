-- A seasonal import file may legitimately repeat one occurrence across source
-- rows: a wide base row plus narrow exception rows for the same flight number
-- and date. The stage used to drop every colliding occurrence and block the
-- batch, so an operator could not commit a file whose schedule is otherwise
-- complete. Duplicate occurrences are now resolved deterministically to the
-- row with the widest Effective through Discontinue coverage (then the most
-- generated occurrences, then the lowest source row index), rows whose selected
-- operating days never fall inside their own Effective through Discontinue
-- window are skipped instead of blocking, and both outcomes surface as
-- non-blocking warnings in the stage preview. A file whose rows generate no
-- flight occurrence at all still blocks through zero-generated-records, and
-- every structural diagnostic (relationship, pair date, manual and daily
-- occurrence collisions) keeps blocking the commit.
begin;
set local lock_timeout = '15s';
set local statement_timeout = '300s';

do $atomic_preview_duplicate_resolution$
declare
  v_definition text;
begin
  select pg_catalog.replace(
      pg_catalog.pg_get_functiondef(
        'public.seasonal_import_atomic_preview_v2(uuid)'::regprocedure
      ),
      chr(13) || chr(10),
      chr(10)
    )
    into v_definition;
  if position($atomic_preview_duplicate_resolution_sentinel$duplicate-occurrence-resolved$atomic_preview_duplicate_resolution_sentinel$ in v_definition) > 0 then
    return;
  end if;

  if position($atomic_preview_duplicate_resolution_aA1$  ), committable_duplicate_keys as (
    select
      reciprocal_links.generated_occurrence_key as occurrence_key,
      pg_catalog.count(*)::integer as occurrence_count
    from reciprocal_links
    where reciprocal_links.pair_is_valid
    group by reciprocal_links.generated_occurrence_key
    having pg_catalog.count(*) > 1
  ), committable_records as (
    select reciprocal_links.*
    from reciprocal_links
    left join committable_duplicate_keys own_duplicate
      on own_duplicate.occurrence_key = reciprocal_links.generated_occurrence_key
    left join committable_duplicate_keys counterpart_duplicate
      on counterpart_duplicate.occurrence_key = reciprocal_links.counterpart_occurrence_key
    where reciprocal_links.pair_is_valid
      and own_duplicate.occurrence_key is null
      and counterpart_duplicate.occurrence_key is null
  ), duplicate_occurrences as (
    select
      pg_catalog.min(deterministic_ids.staging_row_index) as staging_row_index,
      pg_catalog.min(deterministic_ids.source_row_index) as source_row_index,
      deterministic_ids.generated_occurrence_key as occurrence_key,
      pg_catalog.array_agg(
        distinct deterministic_ids.source_row_index
        order by deterministic_ids.source_row_index
      ) as source_row_indexes
    from deterministic_ids
    group by deterministic_ids.generated_occurrence_key
    having pg_catalog.count(*) > 1
$atomic_preview_duplicate_resolution_aA1$ in v_definition) = 0 then
    raise exception 'atomic preview duplicate resolution preimage changed (A1)';
  end if;

  v_definition := pg_catalog.replace(v_definition,
$atomic_preview_duplicate_resolution_aA1$  ), committable_duplicate_keys as (
    select
      reciprocal_links.generated_occurrence_key as occurrence_key,
      pg_catalog.count(*)::integer as occurrence_count
    from reciprocal_links
    where reciprocal_links.pair_is_valid
    group by reciprocal_links.generated_occurrence_key
    having pg_catalog.count(*) > 1
  ), committable_records as (
    select reciprocal_links.*
    from reciprocal_links
    left join committable_duplicate_keys own_duplicate
      on own_duplicate.occurrence_key = reciprocal_links.generated_occurrence_key
    left join committable_duplicate_keys counterpart_duplicate
      on counterpart_duplicate.occurrence_key = reciprocal_links.counterpart_occurrence_key
    where reciprocal_links.pair_is_valid
      and own_duplicate.occurrence_key is null
      and counterpart_duplicate.occurrence_key is null
  ), duplicate_occurrences as (
    select
      pg_catalog.min(deterministic_ids.staging_row_index) as staging_row_index,
      pg_catalog.min(deterministic_ids.source_row_index) as source_row_index,
      deterministic_ids.generated_occurrence_key as occurrence_key,
      pg_catalog.array_agg(
        distinct deterministic_ids.source_row_index
        order by deterministic_ids.source_row_index
      ) as source_row_indexes
    from deterministic_ids
    group by deterministic_ids.generated_occurrence_key
    having pg_catalog.count(*) > 1
$atomic_preview_duplicate_resolution_aA1$,
$atomic_preview_duplicate_resolution_rA1$  ), candidate_coverage as (
    select
      reciprocal_links.source_row_index,
      pg_catalog.max(
        reciprocal_links.discontinue_date - reciprocal_links.effective_date
      )::integer as coverage_days,
      pg_catalog.count(*)::integer as candidate_count
    from reciprocal_links
    where reciprocal_links.pair_is_valid
    group by reciprocal_links.source_row_index
  ), ranked_candidates as (
    select
      reciprocal_links.*,
      candidate_coverage.coverage_days,
      pg_catalog.row_number() over (
        partition by reciprocal_links.generated_occurrence_key
        order by
          candidate_coverage.coverage_days desc,
          candidate_coverage.candidate_count desc,
          reciprocal_links.source_row_index,
          reciprocal_links.type
      ) as occurrence_rank
    from reciprocal_links
    join candidate_coverage
      on candidate_coverage.source_row_index = reciprocal_links.source_row_index
    where reciprocal_links.pair_is_valid
  ), occurrence_winners as (
    select
      ranked_candidates.generated_occurrence_key as occurrence_key,
      ranked_candidates.source_row_index,
      ranked_candidates.type
    from ranked_candidates
    where ranked_candidates.occurrence_rank = 1
  ), committable_records as (
    select ranked_candidates.*
    from ranked_candidates
    left join occurrence_winners counterpart_winner
      on counterpart_winner.occurrence_key = ranked_candidates.counterpart_occurrence_key
    where ranked_candidates.occurrence_rank = 1
      and (
        not ranked_candidates.requires_pair
        or counterpart_winner.source_row_index
          = ranked_candidates.resolved_linked_source_row_index
      )
  ), duplicate_occurrences as (
    select
      pg_catalog.min(deterministic_ids.staging_row_index) as staging_row_index,
      pg_catalog.min(deterministic_ids.source_row_index) as source_row_index,
      deterministic_ids.generated_occurrence_key as occurrence_key,
      pg_catalog.array_agg(
        distinct deterministic_ids.source_row_index
        order by deterministic_ids.source_row_index
      ) as source_row_indexes,
      coalesce(
        (
          select pg_catalog.array_agg(
            distinct kept.source_row_index
            order by kept.source_row_index
          )
          from committable_records kept
          where kept.generated_occurrence_key
            = deterministic_ids.generated_occurrence_key
        ),
        '{}'::integer[]
      ) as kept_source_row_indexes
    from deterministic_ids
    group by deterministic_ids.generated_occurrence_key
    having pg_catalog.count(*) > 1
  ), generated_row_totals as (
    select
      pg_catalog.count(distinct committable_records.source_row_index)::integer
        as generated_row_count,
      (
        select pg_catalog.count(*)::integer
        from canonical_rows
      ) as source_row_count
    from committable_records
  ), generation_share_diagnostics as (
    select
      null::integer as staging_row_index,
      180 as issue_order,
      null::text as diagnostic_column_name,
      pg_catalog.jsonb_build_object(
        'rowIndex', null,
        'stagingRowIndex', null,
        'code', 'zero-generated-records',
        'column', null,
        'message', pg_catalog.format(
          'None of the %s source rows generate flight occurrences.',
          generated_row_totals.source_row_count
        )
      ) as issue
    from generated_row_totals
    where generated_row_totals.generated_row_count = 0
$atomic_preview_duplicate_resolution_rA1$);

  if position($atomic_preview_duplicate_resolution_aA2$        'code', 'zero-generated-records',
$atomic_preview_duplicate_resolution_aA2$ in v_definition) = 0 then
    raise exception 'atomic preview duplicate resolution preimage changed (A2)';
  end if;

  v_definition := pg_catalog.replace(v_definition,
$atomic_preview_duplicate_resolution_aA2$        'code', 'zero-generated-records',
$atomic_preview_duplicate_resolution_aA2$,
$atomic_preview_duplicate_resolution_rA2$        'severity', 'warning',
        'code', 'zero-generated-records',
$atomic_preview_duplicate_resolution_rA2$);

  if position($atomic_preview_duplicate_resolution_aA3$  ), duplicate_diagnostics as (
    select
      duplicate_occurrences.staging_row_index,
      250 as issue_order,
      null::text as diagnostic_column_name,
      pg_catalog.jsonb_build_object(
        'rowIndex', duplicate_occurrences.source_row_index,
        'stagingRowIndex', duplicate_occurrences.staging_row_index,
        'code', 'duplicate-occurrence-key',
        'column', null,
        'message', pg_catalog.format(
          'Rows %s generate duplicate occurrence %s.',
          pg_catalog.array_to_string(duplicate_occurrences.source_row_indexes, ', '),
          duplicate_occurrences.occurrence_key
        ),
        'occurrenceKey', duplicate_occurrences.occurrence_key,
        'sourceRowIndexes', pg_catalog.to_jsonb(duplicate_occurrences.source_row_indexes)
      ) as issue
    from duplicate_occurrences
  ), generation_diagnostics as (
    select * from zero_row_diagnostics
    union all
    select * from relationship_diagnostics
    union all
    select * from pair_date_diagnostics
    union all
    select * from duplicate_diagnostics
$atomic_preview_duplicate_resolution_aA3$ in v_definition) = 0 then
    raise exception 'atomic preview duplicate resolution preimage changed (A3)';
  end if;

  v_definition := pg_catalog.replace(v_definition,
$atomic_preview_duplicate_resolution_aA3$  ), duplicate_diagnostics as (
    select
      duplicate_occurrences.staging_row_index,
      250 as issue_order,
      null::text as diagnostic_column_name,
      pg_catalog.jsonb_build_object(
        'rowIndex', duplicate_occurrences.source_row_index,
        'stagingRowIndex', duplicate_occurrences.staging_row_index,
        'code', 'duplicate-occurrence-key',
        'column', null,
        'message', pg_catalog.format(
          'Rows %s generate duplicate occurrence %s.',
          pg_catalog.array_to_string(duplicate_occurrences.source_row_indexes, ', '),
          duplicate_occurrences.occurrence_key
        ),
        'occurrenceKey', duplicate_occurrences.occurrence_key,
        'sourceRowIndexes', pg_catalog.to_jsonb(duplicate_occurrences.source_row_indexes)
      ) as issue
    from duplicate_occurrences
  ), generation_diagnostics as (
    select * from zero_row_diagnostics
    union all
    select * from relationship_diagnostics
    union all
    select * from pair_date_diagnostics
    union all
    select * from duplicate_diagnostics
$atomic_preview_duplicate_resolution_aA3$,
$atomic_preview_duplicate_resolution_rA3$  ), duplicate_diagnostics as (
    select
      duplicate_occurrences.staging_row_index,
      250 as issue_order,
      null::text as diagnostic_column_name,
      pg_catalog.jsonb_build_object(
        'rowIndex', duplicate_occurrences.source_row_index,
        'stagingRowIndex', duplicate_occurrences.staging_row_index,
        'code', 'duplicate-occurrence-resolved',
        'column', null,
        'severity', 'warning',
        'message', pg_catalog.format(
          'Rows %s generate duplicate occurrence %s; kept %s.',
          pg_catalog.array_to_string(duplicate_occurrences.source_row_indexes, ', '),
          duplicate_occurrences.occurrence_key,
          coalesce(
            nullif(
              'row ' || pg_catalog.array_to_string(
                duplicate_occurrences.kept_source_row_indexes,
                ', '
              ),
              'row '
            ),
            'no row'
          )
        ),
        'occurrenceKey', duplicate_occurrences.occurrence_key,
        'sourceRowIndexes', pg_catalog.to_jsonb(duplicate_occurrences.source_row_indexes),
        'keptSourceRowIndexes', pg_catalog.to_jsonb(
          duplicate_occurrences.kept_source_row_indexes
        )
      ) as issue
    from duplicate_occurrences
  ), generation_diagnostics as (
    select * from zero_row_diagnostics
    union all
    select * from relationship_diagnostics
    union all
    select * from pair_date_diagnostics
    union all
    select * from duplicate_diagnostics
    union all
    select * from generation_share_diagnostics
$atomic_preview_duplicate_resolution_rA3$);

  if position($atomic_preview_duplicate_resolution_sentinel$duplicate-occurrence-resolved$atomic_preview_duplicate_resolution_sentinel$ in v_definition) = 0 then
    raise exception 'atomic preview duplicate resolution replacement was incomplete';
  end if;

  execute v_definition;
end
$atomic_preview_duplicate_resolution$;

do $upload_severity_partition$
declare
  v_definition text;
begin
  select pg_catalog.replace(
      pg_catalog.pg_get_functiondef(
        'public.stage_seasonal_import_v2(jsonb)'::regprocedure
      ),
      chr(13) || chr(10),
      chr(10)
    )
    into v_definition;
  if position($upload_severity_partition_sentinel$item_kind = 'diagnostic'
        and coalesce(nullif(atomic_preview.issue->>'severity', ''), 'error') <> 'warning'$upload_severity_partition_sentinel$ in v_definition) > 0 then
    return;
  end if;

  if position($upload_severity_partition_aB$  if v_batch.status = 'staged' then
    with atomic_preview AS MATERIALIZED (
      select *
      from public.seasonal_import_atomic_preview_v2(v_batch.batch_id)
    ), ranked_diagnostics as (
      select
        atomic_preview.staging_row_index,
        atomic_preview.issue_order,
        atomic_preview.diagnostic_column_name as column_name,
        atomic_preview.issue,
        pg_catalog.row_number() over (
          order by
            atomic_preview.staging_row_index,
            atomic_preview.issue_order,
            atomic_preview.diagnostic_column_name
        ) as diagnostic_rank
      from atomic_preview
      where atomic_preview.item_kind = 'diagnostic'
    )
    select
      (
        select pg_catalog.count(*)::integer
        from atomic_preview
        where atomic_preview.item_kind = 'record'
      ),
      (
        select pg_catalog.count(*)::integer
        from ranked_diagnostics
      ),
      coalesce(
        (
          select pg_catalog.jsonb_agg(
            ranked_diagnostics.issue
            order by
              ranked_diagnostics.staging_row_index,
              ranked_diagnostics.issue_order,
              ranked_diagnostics.column_name
          )
          from ranked_diagnostics
          where ranked_diagnostics.diagnostic_rank <= v_max_actionable_diagnostics
        ),
        '[]'::jsonb
      )
    into
      v_generated_record_count,
      v_generation_diagnostic_count,
      v_generation_diagnostics;

$upload_severity_partition_aB$ in v_definition) = 0 then
    raise exception 'upload severity partition preimage changed (B)';
  end if;

  v_definition := pg_catalog.replace(v_definition,
$upload_severity_partition_aB$  if v_batch.status = 'staged' then
    with atomic_preview AS MATERIALIZED (
      select *
      from public.seasonal_import_atomic_preview_v2(v_batch.batch_id)
    ), ranked_diagnostics as (
      select
        atomic_preview.staging_row_index,
        atomic_preview.issue_order,
        atomic_preview.diagnostic_column_name as column_name,
        atomic_preview.issue,
        pg_catalog.row_number() over (
          order by
            atomic_preview.staging_row_index,
            atomic_preview.issue_order,
            atomic_preview.diagnostic_column_name
        ) as diagnostic_rank
      from atomic_preview
      where atomic_preview.item_kind = 'diagnostic'
    )
    select
      (
        select pg_catalog.count(*)::integer
        from atomic_preview
        where atomic_preview.item_kind = 'record'
      ),
      (
        select pg_catalog.count(*)::integer
        from ranked_diagnostics
      ),
      coalesce(
        (
          select pg_catalog.jsonb_agg(
            ranked_diagnostics.issue
            order by
              ranked_diagnostics.staging_row_index,
              ranked_diagnostics.issue_order,
              ranked_diagnostics.column_name
          )
          from ranked_diagnostics
          where ranked_diagnostics.diagnostic_rank <= v_max_actionable_diagnostics
        ),
        '[]'::jsonb
      )
    into
      v_generated_record_count,
      v_generation_diagnostic_count,
      v_generation_diagnostics;

$upload_severity_partition_aB$,
$upload_severity_partition_rB$  if v_batch.status = 'staged' then
    with atomic_preview AS MATERIALIZED (
      select *
      from public.seasonal_import_atomic_preview_v2(v_batch.batch_id)
    ), ranked_diagnostics as (
      select
        atomic_preview.staging_row_index,
        atomic_preview.issue_order,
        atomic_preview.diagnostic_column_name as column_name,
        atomic_preview.issue,
        pg_catalog.row_number() over (
          order by
            atomic_preview.staging_row_index,
            atomic_preview.issue_order,
            atomic_preview.diagnostic_column_name
        ) as diagnostic_rank
      from atomic_preview
      where atomic_preview.item_kind = 'diagnostic'
        and coalesce(nullif(atomic_preview.issue->>'severity', ''), 'error') <> 'warning'
    )
    select
      (
        select pg_catalog.count(*)::integer
        from atomic_preview
        where atomic_preview.item_kind = 'record'
      ),
      (
        select pg_catalog.count(*)::integer
        from ranked_diagnostics
      ),
      coalesce(
        (
          select pg_catalog.jsonb_agg(
            ranked_diagnostics.issue
            order by
              ranked_diagnostics.staging_row_index,
              ranked_diagnostics.issue_order,
              ranked_diagnostics.column_name
          )
          from ranked_diagnostics
          where ranked_diagnostics.diagnostic_rank <= v_max_actionable_diagnostics
        ),
        '[]'::jsonb
      )
    into
      v_generated_record_count,
      v_generation_diagnostic_count,
      v_generation_diagnostics;

$upload_severity_partition_rB$);

  if position($upload_severity_partition_sentinel$item_kind = 'diagnostic'
        and coalesce(nullif(atomic_preview.issue->>'severity', ''), 'error') <> 'warning'$upload_severity_partition_sentinel$ in v_definition) = 0 then
    raise exception 'upload severity partition replacement was incomplete';
  end if;

  execute v_definition;
end
$upload_severity_partition$;

do $stage_v3_warning_channel$
declare
  v_definition text;
begin
  select pg_catalog.replace(
      pg_catalog.pg_get_functiondef(
        'public.stage_seasonal_import_v3(jsonb)'::regprocedure
      ),
      chr(13) || chr(10),
      chr(10)
    )
    into v_definition;
  if position($stage_v3_warning_channel_sentinel$seasonal_import_v3_warning_items$stage_v3_warning_channel_sentinel$ in v_definition) > 0 then
    return;
  end if;

  if position($stage_v3_warning_channel_aC1$  v_manual_collision_count integer := 0;
  v_valid boolean := false;
$stage_v3_warning_channel_aC1$ in v_definition) = 0 then
    raise exception 'stage v3 warning channel preimage changed (C1)';
  end if;

  v_definition := pg_catalog.replace(v_definition,
$stage_v3_warning_channel_aC1$  v_manual_collision_count integer := 0;
  v_valid boolean := false;
$stage_v3_warning_channel_aC1$,
$stage_v3_warning_channel_rC1$  v_manual_collision_count integer := 0;
  v_warning_count integer := 0;
  v_warnings_truncated boolean := false;
  v_warnings jsonb := '[]'::jsonb;
  v_valid boolean := false;
$stage_v3_warning_channel_rC1$);

  if position($stage_v3_warning_channel_aC2$  into v_diagnostic_count, v_diagnostics_truncated, v_diagnostics
  from ranked;
$stage_v3_warning_channel_aC2$ in v_definition) = 0 then
    raise exception 'stage v3 warning channel preimage changed (C2)';
  end if;

  v_definition := pg_catalog.replace(v_definition,
$stage_v3_warning_channel_aC2$  into v_diagnostic_count, v_diagnostics_truncated, v_diagnostics
  from ranked;
$stage_v3_warning_channel_aC2$,
$stage_v3_warning_channel_rC2$  into v_diagnostic_count, v_diagnostics_truncated, v_diagnostics
  from ranked;

  drop table if exists pg_temp.seasonal_import_v3_warning_items;
  create temporary table seasonal_import_v3_warning_items (
    code text not null,
    message text not null,
    source_row_indexes integer[] not null,
    occurrence_key text,
    affected_date text,
    airline text,
    flight_number text
  ) on commit drop;

  insert into pg_temp.seasonal_import_v3_warning_items (
    code,
    message,
    source_row_indexes,
    occurrence_key,
    affected_date,
    airline,
    flight_number
  )
  select
    coalesce(nullif(warnings.issue->>'code', ''), 'unknown-warning'),
    coalesce(nullif(warnings.issue->>'message', ''), 'Seasonal import warning.'),
    case
      when pg_catalog.jsonb_typeof(warnings.issue->'sourceRowIndexes') = 'array'
        then array(
          select values.value::integer
          from pg_catalog.jsonb_array_elements_text(
            warnings.issue->'sourceRowIndexes'
          ) values(value)
          order by values.value::integer
        )
      when pg_catalog.jsonb_typeof(warnings.issue->'rowIndex') = 'number'
        then array[(warnings.issue->>'rowIndex')::integer]
      else '{}'::integer[]
    end,
    nullif(warnings.issue->>'occurrenceKey', ''),
    coalesce(
      nullif(
        pg_catalog.split_part(warnings.issue->>'occurrenceKey', '|', 2),
        ''
      ),
      nullif(warnings.issue->>'pairAnchorDate', '')
    ),
    nullif(
      pg_catalog.split_part(warnings.issue->>'occurrenceKey', '|', 3),
      ''
    ),
    nullif(
      pg_catalog.split_part(warnings.issue->>'occurrenceKey', '|', 4),
      ''
    )
  from public.seasonal_import_generation_diagnostics_v2(v_batch.batch_id) warnings
  where coalesce(nullif(warnings.issue->>'severity', ''), 'error') = 'warning';

  with grouped as (
    select
      warnings.code,
      warnings.source_row_indexes,
      warnings.airline,
      warnings.flight_number,
      pg_catalog.min(warnings.message) as message,
      pg_catalog.count(distinct warnings.affected_date) filter (
        where warnings.affected_date is not null
      )::integer as affected_date_count,
      pg_catalog.count(distinct warnings.occurrence_key) filter (
        where warnings.occurrence_key is not null
      )::integer as occurrence_count,
      pg_catalog.min(warnings.occurrence_key) as occurrence_key
    from pg_temp.seasonal_import_v3_warning_items warnings
    group by
      warnings.code,
      warnings.source_row_indexes,
      warnings.airline,
      warnings.flight_number,
      case
        when warnings.occurrence_key is null then warnings.message
        else ''
      end
  ), ranked as (
    select
      grouped.*,
      pg_catalog.row_number() over (
        order by
          grouped.code,
          grouped.source_row_indexes::text,
          grouped.airline,
          grouped.flight_number
      ) as warning_rank
    from grouped
  )
  select
    pg_catalog.count(*)::integer,
    pg_catalog.count(*) > 200,
    coalesce(
      pg_catalog.jsonb_agg(
        pg_catalog.jsonb_build_object(
          'code', ranked.code,
          'message', ranked.message,
          'sourceRowIndexes', pg_catalog.to_jsonb(ranked.source_row_indexes),
          'occurrenceKey', case
            when ranked.occurrence_count = 1 then ranked.occurrence_key
            else null
          end,
          'affectedDateCount', ranked.affected_date_count,
          'sampleDates', coalesce(
            (
              select pg_catalog.jsonb_agg(
                samples.affected_date
                order by samples.affected_date
              )
              from (
                select distinct items.affected_date
                from pg_temp.seasonal_import_v3_warning_items items
                where items.code = ranked.code
                  and items.source_row_indexes = ranked.source_row_indexes
                  and items.airline is not distinct from ranked.airline
                  and items.flight_number is not distinct from ranked.flight_number
                  and items.affected_date is not null
                order by items.affected_date
                limit 5
              ) samples
            ),
            '[]'::jsonb
          )
        )
        order by ranked.warning_rank
      ) filter (where ranked.warning_rank <= 200),
      '[]'::jsonb
    )
  into v_warning_count, v_warnings_truncated, v_warnings
  from ranked;
$stage_v3_warning_channel_rC2$);

  if position($stage_v3_warning_channel_aC3$    'diagnostics', v_diagnostics
  );
$stage_v3_warning_channel_aC3$ in v_definition) = 0 then
    raise exception 'stage v3 warning channel preimage changed (C3)';
  end if;

  v_definition := pg_catalog.replace(v_definition,
$stage_v3_warning_channel_aC3$    'diagnostics', v_diagnostics
  );
$stage_v3_warning_channel_aC3$,
$stage_v3_warning_channel_rC3$    'diagnostics', v_diagnostics,
    'warningCount', v_warning_count,
    'warningsTruncated', v_warnings_truncated,
    'warnings', v_warnings
  );
$stage_v3_warning_channel_rC3$);

  if position($stage_v3_warning_channel_sentinel$seasonal_import_v3_warning_items$stage_v3_warning_channel_sentinel$ in v_definition) = 0 then
    raise exception 'stage v3 warning channel replacement was incomplete';
  end if;

  execute v_definition;
end
$stage_v3_warning_channel$;

do $v3_response_warnings$
declare
  v_definition text;
begin
  select pg_catalog.replace(
      pg_catalog.pg_get_functiondef(
        'public.seasonal_import_v3_response(uuid)'::regprocedure
      ),
      chr(13) || chr(10),
      chr(10)
    )
    into v_definition;
  if position($v3_response_warnings_sentinel$'warnings', coalesce(batches.preview->'warnings', '[]'::jsonb)$v3_response_warnings_sentinel$ in v_definition) > 0 then
    return;
  end if;

  if position($v3_response_warnings_aC4$    'diagnostics', coalesce(batches.preview->'diagnostics', '[]'::jsonb),
    'expiresAt', batches.expires_at
$v3_response_warnings_aC4$ in v_definition) = 0 then
    raise exception 'v3 response warnings preimage changed (C4)';
  end if;

  v_definition := pg_catalog.replace(v_definition,
$v3_response_warnings_aC4$    'diagnostics', coalesce(batches.preview->'diagnostics', '[]'::jsonb),
    'expiresAt', batches.expires_at
$v3_response_warnings_aC4$,
$v3_response_warnings_rC4$    'diagnostics', coalesce(batches.preview->'diagnostics', '[]'::jsonb),
    'warningCount', coalesce(
      (batches.preview->>'warningCount')::integer,
      0
    ),
    'warningsTruncated', coalesce(
      (batches.preview->>'warningsTruncated')::boolean,
      false
    ),
    'warnings', coalesce(batches.preview->'warnings', '[]'::jsonb),
    'expiresAt', batches.expires_at
$v3_response_warnings_rC4$);

  if position($v3_response_warnings_sentinel$'warnings', coalesce(batches.preview->'warnings', '[]'::jsonb)$v3_response_warnings_sentinel$ in v_definition) = 0 then
    raise exception 'v3 response warnings replacement was incomplete';
  end if;

  execute v_definition;
end
$v3_response_warnings$;

comment on function public.seasonal_import_atomic_preview_v2(uuid) is
  'Atomic seasonal import preview: duplicate occurrences resolve to the widest source row and are reported as warnings.';

comment on function public.stage_seasonal_import_v3(jsonb) is
  'Stages a seasonal plan import batch; structural diagnostics block the commit while duplicate-resolution and zero-row warnings do not.';

notify pgrst, 'reload schema';
commit;
