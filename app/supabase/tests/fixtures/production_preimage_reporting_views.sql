-- Production preimage for reporting.effective_flight_operations.
-- Dumped byte-exactly from opsdata-supabase-db: pg_get_viewdef md5
-- 7906c3cc65a25914fa1343c7c5ff7ad9 (length 9670). schema.sql carries a
-- different overlay shape for this view, so the PGlite chain must load the
-- production definition before 20260829163000 to stay production-faithful.
begin;
set local search_path = public, pg_catalog, pg_temp;
create or replace view reporting.effective_flight_operations as
 WITH imported_rows AS (
         SELECT r.season_id,
            r.record_id,
            r.link_id,
            r.type,
            r.airline,
            r.flight_number,
            r.raw_flight_number,
            r.request_status_code,
                CASE
                    WHEN 'route'::text = ANY (COALESCE(m.changed_fields, '{}'::text[])) THEN m.route
                    ELSE r.route
                END AS route,
                CASE
                    WHEN 'schedule'::text = ANY (COALESCE(m.changed_fields, '{}'::text[])) THEN m.schedule
                    ELSE r.schedule
                END AS schedule,
                CASE
                    WHEN 'aircraft'::text = ANY (COALESCE(m.changed_fields, '{}'::text[])) THEN m.aircraft
                    ELSE r.aircraft
                END AS aircraft,
            r.category,
                CASE
                    WHEN ('codeShares'::text = ANY (COALESCE(m.changed_fields, '{}'::text[]))) OR ('code_shares'::text = ANY (COALESCE(m.changed_fields, '{}'::text[]))) THEN m.code_shares
                    ELSE r.code_shares
                END AS code_shares,
            r.int_dom_ind,
                CASE
                    WHEN 'pax'::text = ANY (COALESCE(m.changed_fields, '{}'::text[])) THEN m.pax
                    ELSE r.pax
                END AS pax,
                CASE
                    WHEN 'gate'::text = ANY (COALESCE(m.changed_fields, '{}'::text[])) THEN m.gate
                    ELSE r.gate
                END AS gate,
                CASE
                    WHEN 'stand'::text = ANY (COALESCE(m.changed_fields, '{}'::text[])) THEN m.stand
                    ELSE r.stand
                END AS stand,
                CASE
                    WHEN 'carousel'::text = ANY (COALESCE(m.changed_fields, '{}'::text[])) THEN m.carousel
                    ELSE r.carousel
                END AS carousel,
                CASE
                    WHEN 'mct'::text = ANY (COALESCE(m.changed_fields, '{}'::text[])) THEN m.mct
                    ELSE r.mct
                END AS mct,
                CASE
                    WHEN 'fb'::text = ANY (COALESCE(m.changed_fields, '{}'::text[])) THEN m.fb
                    ELSE r.fb
                END AS fb,
                CASE
                    WHEN 'lb'::text = ANY (COALESCE(m.changed_fields, '{}'::text[])) THEN m.lb
                    ELSE r.lb
                END AS lb,
                CASE
                    WHEN 'bhs'::text = ANY (COALESCE(m.changed_fields, '{}'::text[])) THEN m.bhs
                    ELSE r.bhs
                END AS bhs,
                CASE
                    WHEN 'ghs'::text = ANY (COALESCE(m.changed_fields, '{}'::text[])) THEN m.ghs
                    ELSE r.ghs
                END AS ghs,
            r.date,
            r.scheduled_date,
            r.scheduled_time,
            r.operational_date,
            r.iata_season_code,
            r.flight_series_id,
            r.day_of_week,
            COALESCE(m.action, r.action) AS action,
            r.source_row_index,
            r.linked_source_row_index,
            r.link_type,
            r.pair_anchor_date,
            r.linked_record_id,
            COALESCE(r.source_kind, 'imported'::text) AS source_kind,
            r.source_side,
            COALESCE(r.status, 'active'::text) AS status,
            r.turnaround_id
           FROM daily_schedule_effective_records_v1 r
             LEFT JOIN season_modifications m ON m.season_id = r.season_id AND m.leg_id = r.record_id
          WHERE COALESCE(r.status, 'active'::text) <> 'deleted'::text AND COALESCE(m.action, 'modified'::text) <> 'deleted'::text
        ), added_rows AS (
         SELECT al.season_id,
            al.record_id,
            al.link_id,
            al.type,
            al.airline,
            al.flight_number,
            al.raw_flight_number,
            al.request_status_code,
                CASE
                    WHEN 'route'::text = ANY (COALESCE(m.changed_fields, '{}'::text[])) THEN m.route
                    ELSE al.route
                END AS route,
                CASE
                    WHEN 'schedule'::text = ANY (COALESCE(m.changed_fields, '{}'::text[])) THEN m.schedule
                    ELSE al.schedule
                END AS schedule,
                CASE
                    WHEN 'aircraft'::text = ANY (COALESCE(m.changed_fields, '{}'::text[])) THEN m.aircraft
                    ELSE al.aircraft
                END AS aircraft,
            al.category,
                CASE
                    WHEN ('codeShares'::text = ANY (COALESCE(m.changed_fields, '{}'::text[]))) OR ('code_shares'::text = ANY (COALESCE(m.changed_fields, '{}'::text[]))) THEN m.code_shares
                    ELSE al.code_shares
                END AS code_shares,
            al.int_dom_ind,
                CASE
                    WHEN 'pax'::text = ANY (COALESCE(m.changed_fields, '{}'::text[])) THEN m.pax
                    ELSE al.pax
                END AS pax,
                CASE
                    WHEN 'gate'::text = ANY (COALESCE(m.changed_fields, '{}'::text[])) THEN m.gate
                    ELSE al.gate
                END AS gate,
                CASE
                    WHEN 'stand'::text = ANY (COALESCE(m.changed_fields, '{}'::text[])) THEN m.stand
                    ELSE al.stand
                END AS stand,
                CASE
                    WHEN 'carousel'::text = ANY (COALESCE(m.changed_fields, '{}'::text[])) THEN m.carousel
                    ELSE al.carousel
                END AS carousel,
                CASE
                    WHEN 'mct'::text = ANY (COALESCE(m.changed_fields, '{}'::text[])) THEN m.mct
                    ELSE al.mct
                END AS mct,
                CASE
                    WHEN 'fb'::text = ANY (COALESCE(m.changed_fields, '{}'::text[])) THEN m.fb
                    ELSE al.fb
                END AS fb,
                CASE
                    WHEN 'lb'::text = ANY (COALESCE(m.changed_fields, '{}'::text[])) THEN m.lb
                    ELSE al.lb
                END AS lb,
                CASE
                    WHEN 'bhs'::text = ANY (COALESCE(m.changed_fields, '{}'::text[])) THEN m.bhs
                    ELSE al.bhs
                END AS bhs,
                CASE
                    WHEN 'ghs'::text = ANY (COALESCE(m.changed_fields, '{}'::text[])) THEN m.ghs
                    ELSE al.ghs
                END AS ghs,
            al.date,
            al.scheduled_date,
            al.scheduled_time,
            al.operational_date,
            al.iata_season_code,
            al.flight_series_id,
            al.day_of_week,
            COALESCE(m.action, al.action) AS action,
            al.source_row_index,
            al.linked_source_row_index,
            al.link_type,
            al.pair_anchor_date,
            al.linked_record_id,
            COALESCE(al.source_kind, 'added'::text) AS source_kind,
            al.source_side,
            COALESCE(al.status, 'active'::text) AS status,
            al.turnaround_id
           FROM season_modification_added_legs al
             LEFT JOIN season_modifications m ON m.season_id = al.season_id AND m.leg_id = al.leg_id
          WHERE COALESCE(al.status, 'active'::text) <> 'deleted'::text AND COALESCE(m.action, 'modified'::text) <> 'deleted'::text
        )
 SELECT imported_rows.season_id,
    imported_rows.record_id,
    imported_rows.link_id,
    imported_rows.type,
    imported_rows.airline,
    imported_rows.flight_number,
    imported_rows.raw_flight_number,
    imported_rows.request_status_code,
    imported_rows.route,
    imported_rows.schedule,
    imported_rows.aircraft,
    imported_rows.category,
    imported_rows.code_shares,
    imported_rows.int_dom_ind,
    imported_rows.pax,
    imported_rows.gate,
    imported_rows.stand,
    imported_rows.carousel,
    imported_rows.mct,
    imported_rows.fb,
    imported_rows.lb,
    imported_rows.bhs,
    imported_rows.ghs,
    imported_rows.date,
    imported_rows.scheduled_date,
    imported_rows.scheduled_time,
    imported_rows.operational_date,
    imported_rows.iata_season_code,
    imported_rows.flight_series_id,
    imported_rows.day_of_week,
    imported_rows.action,
    imported_rows.source_row_index,
    imported_rows.linked_source_row_index,
    imported_rows.link_type,
    imported_rows.pair_anchor_date,
    imported_rows.linked_record_id,
    imported_rows.source_kind,
    imported_rows.source_side,
    imported_rows.status,
    imported_rows.turnaround_id
   FROM imported_rows
UNION ALL
 SELECT added_rows.season_id,
    added_rows.record_id,
    added_rows.link_id,
    added_rows.type,
    added_rows.airline,
    added_rows.flight_number,
    added_rows.raw_flight_number,
    added_rows.request_status_code,
    added_rows.route,
    added_rows.schedule,
    added_rows.aircraft,
    added_rows.category,
    added_rows.code_shares,
    added_rows.int_dom_ind,
    added_rows.pax,
    added_rows.gate,
    added_rows.stand,
    added_rows.carousel,
    added_rows.mct,
    added_rows.fb,
    added_rows.lb,
    added_rows.bhs,
    added_rows.ghs,
    added_rows.date,
    added_rows.scheduled_date,
    added_rows.scheduled_time,
    added_rows.operational_date,
    added_rows.iata_season_code,
    added_rows.flight_series_id,
    added_rows.day_of_week,
    added_rows.action,
    added_rows.source_row_index,
    added_rows.linked_source_row_index,
    added_rows.link_type,
    added_rows.pair_anchor_date,
    added_rows.linked_record_id,
    added_rows.source_kind,
    added_rows.source_side,
    added_rows.status,
    added_rows.turnaround_id
   FROM added_rows
;
alter view reporting.effective_flight_operations set (security_invoker = true);
commit;
