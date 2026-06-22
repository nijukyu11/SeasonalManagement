use rusqlite::{params, Connection};
use seasonal_management_lib::native_catchup::{
    apply_event_page, apply_local_modification_batch_delta_to_connection,
    apply_schedule_mutation_to_connection, build_native_pending_change_events,
    build_native_pending_sync_chunks, check_season_integrity_on_connection,
    checkpoint_mode_for_committed_pages, configure_sqlite_connection,
    ensure_local_season_on_connection, ensure_native_schema, import_season_snapshot_on_connection,
    merge_season_snapshot_on_connection, query_allocation_window_on_connection,
    query_dashboard_ai_sql_on_connection, query_schedule_window_on_connection,
    query_season_freshness_on_connection, query_sync_summary_on_connection,
    reconcile_flight_record_manifest_on_connection, resolve_season_conflict_on_connection,
    should_request_page_fetch_retry, should_request_token_refresh, sync_pending_changes_on_connection,
    upload_native_pending_chunks_with_retry, validate_pending_sync_result_coverage,
    ApplyLocalModificationBatchDeltaInput, ApplyLocalModificationHistoryInput,
    ApplyScheduleMutationInput, CheckSeasonIntegrityInput, EnsureLocalSeasonInput,
    ImportSeasonSnapshotInput, MergeSeasonSnapshotInput, NativeCatchupEvent,
    NativeCatchupEventPage, NativeHttpError, NativeSyncPendingRpcResult,
    NativeSeasonOnlyInput,
    QueryAllocationWindowInput, QueryDashboardSummaryInput, QueryNativeDashboardAiSqlInput,
    QueryScheduleWindowInput, QuerySeasonFreshnessInput, ResolveSeasonConflictInput,
    WalCheckpointMode, MAX_NATIVE_PENDING_SYNC_CHUNK_BYTES, MAX_NATIVE_PENDING_SYNC_CHUNK_EVENTS,
};
use serde_json::json;
use std::collections::HashSet;
use std::sync::{Arc, Mutex};
use tempfile::tempdir;

fn open_test_db() -> Connection {
    let dir = tempdir().expect("temp dir");
    let db_path = dir.path().join("seasonal-management-local.db");
    let conn = Connection::open(db_path).expect("open sqlite db");
    std::mem::forget(dir);
    conn
}

fn daily_import_record(index: usize) -> serde_json::Value {
    json!({
        "id": format!("DAILY_IMPORT_A_2025_12_{:02}_ZZ{:04}_SGN_10_00_320", (index % 28) + 1, index),
        "date": format!("2025-12-{:02}", (index % 28) + 1),
        "operationalDate": format!("2025-12-{:02}", (index % 28) + 1),
        "iataSeasonCode": "W25",
        "type": "arrival",
        "sourceSide": "ARR",
        "status": "scheduled",
        "sourceKind": "added",
        "flightNumber": format!("ZZ{:04}", index),
        "rawFlightNumber": format!("{:04}", index),
        "airline": "ZZ",
        "route": "SGN",
        "schedule": "10:00",
        "aircraft": "320",
        "codeShares": "X".repeat(600),
        "sourceRowIndex": index as i64,
        "gate": (index % 20) as i64,
        "stand": (index % 30) as i64,
        "counter": format!("{},{}", index % 50, (index % 50) + 1)
    })
}

fn pending_rpc_event(op_id: &str, server_seq: i64) -> NativeCatchupEvent {
    NativeCatchupEvent {
        event_id: format!("event-{op_id}"),
        season_id: "season-1".to_string(),
        client_id: "client-1".to_string(),
        op_id: op_id.to_string(),
        server_seq,
        target_type: "flightRecord".to_string(),
        target_id: op_id.to_string(),
        changed_fields: vec!["record".to_string()],
        op_payload: json!({ "type": "flightRecord" }),
        created_at: "1234".to_string(),
    }
}

#[test]
fn pending_sync_coverage_rejects_rpc_response_missing_pending_op_ids() {
    let pending_events = vec![
        json!({
            "eventId": "event-1",
            "seasonId": "season-1",
            "clientId": "client-1",
            "opId": "client-1:flightRecord:leg-1:gate",
            "targetType": "flightRecord",
            "targetId": "leg-1",
            "changedFields": ["gate"],
            "opPayload": { "type": "flightRecord", "record": { "id": "leg-1", "gate": 1 } }
        }),
        json!({
            "eventId": "event-2",
            "seasonId": "season-1",
            "clientId": "client-1",
            "opId": "client-1:modification:leg-2:action",
            "targetType": "modification",
            "targetId": "leg-2",
            "changedFields": ["action"],
            "opPayload": { "type": "modification", "mod": { "legId": "leg-2", "action": "deleted" } }
        }),
    ];
    let applied_events = vec![NativeCatchupEvent {
        event_id: "event-1".to_string(),
        season_id: "season-1".to_string(),
        client_id: "client-1".to_string(),
        op_id: "client-1:flightRecord:leg-1:gate".to_string(),
        server_seq: 12,
        target_type: "flightRecord".to_string(),
        target_id: "leg-1".to_string(),
        changed_fields: vec!["gate".to_string()],
        op_payload: json!({ "type": "flightRecord", "record": { "id": "leg-1", "gate": 1 } }),
        created_at: String::new(),
    }];

    let error = validate_pending_sync_result_coverage(&pending_events, &applied_events, &[])
        .expect_err("missing applied/conflict event must fail closed");

    assert!(error.contains("client-1:modification:leg-2:action"));
}

#[test]
fn pending_sync_coverage_accepts_applied_or_conflicted_pending_op_ids() {
    let pending_events = vec![
        json!({
            "eventId": "event-1",
            "opId": "client-1:flightRecord:leg-1:gate",
            "targetType": "flightRecord",
            "targetId": "leg-1",
            "opPayload": { "type": "flightRecord", "record": { "id": "leg-1" } }
        }),
        json!({
            "eventId": "event-2",
            "opId": "client-1:modification:leg-2:action",
            "targetType": "modification",
            "targetId": "leg-2",
            "opPayload": { "type": "modification", "mod": { "legId": "leg-2" } }
        }),
    ];
    let applied_events = vec![NativeCatchupEvent {
        event_id: "event-1".to_string(),
        season_id: "season-1".to_string(),
        client_id: "client-1".to_string(),
        op_id: "client-1:flightRecord:leg-1:gate".to_string(),
        server_seq: 12,
        target_type: "flightRecord".to_string(),
        target_id: "leg-1".to_string(),
        changed_fields: vec!["gate".to_string()],
        op_payload: json!({}),
        created_at: String::new(),
    }];
    let conflict_events = vec![NativeCatchupEvent {
        event_id: "event-2".to_string(),
        season_id: "season-1".to_string(),
        client_id: "client-1".to_string(),
        op_id: "client-1:modification:leg-2:action".to_string(),
        server_seq: 13,
        target_type: "modification".to_string(),
        target_id: "leg-2".to_string(),
        changed_fields: vec!["action".to_string()],
        op_payload: json!({}),
        created_at: String::new(),
    }];

    validate_pending_sync_result_coverage(&pending_events, &applied_events, &conflict_events)
        .expect("applied plus conflict events cover every pending op");
}

#[test]
fn native_schema_initializer_creates_fresh_local_tables() {
    let conn = open_test_db();
    configure_sqlite_connection(&conn).expect("configure sqlite");

    let missing_before = conn
        .prepare("SELECT COUNT(*) FROM local_sync_meta")
        .expect_err("fresh db has no local tables yet")
        .to_string();
    assert!(missing_before.contains("no such table"));

    ensure_native_schema(&conn).expect("native schema");

    let table_count: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name IN ('local_seasons', 'local_sync_meta', 'local_flight_records')",
            [],
            |row| row.get(0),
        )
        .expect("count native tables");
    assert_eq!(table_count, 3);
}

#[test]
fn import_season_snapshot_ignores_source_rows_for_fresh_install() {
    let conn = open_test_db();
    configure_sqlite_connection(&conn).expect("configure sqlite");
    ensure_native_schema(&conn).expect("native schema");

    let input = ImportSeasonSnapshotInput {
        season: json!({
            "id": "season-s26",
            "seasonCode": "S26",
            "effectiveStart": "2026-03-28",
            "effectiveEnd": "2026-10-25",
            "dataVersion": 12
        }),
        source_rows: vec![json!({
            "rowIndex": 1,
            "effective": "2026-06-01",
            "discontinue": "2026-06-30",
            "airline": "8M"
        })],
        records: vec![json!({
            "id": "s26-8m455-20260601",
            "date": "2026-06-01",
            "operationalDate": "2026-06-01",
            "type": "D",
            "sourceSide": "dep",
            "status": "active",
            "flightNumber": "8M455",
            "airline": "8M",
            "route": "SGN-RGN",
            "schedule": "20:00"
        })],
        modifications: vec![json!({
            "legId": "s26-8m455-20260601",
            "action": "deleted"
        })],
        mod_history: vec![json!({
            "id": "history-1",
            "timestamp": 1_779_999_000_000_i64,
            "description": "Cancelled 1 Flight"
        })],
        server_event_high_water: 42,
        entity_versions: json!({
            "flightRecord:s26-8m455-20260601": {
                "status": 42
            }
        }),
    };

    let imported = import_season_snapshot_on_connection(&conn, &input).expect("import snapshot");
    assert_eq!(imported.records, 1);
    assert_eq!(imported.source_rows, 0);
    assert_eq!(imported.modifications, 1);
    assert_eq!(imported.last_server_seq, 42);

    let current_records: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM local_flight_records WHERE season_id = 'season-s26' AND is_base = 0",
            [],
            |row| row.get(0),
        )
        .expect("current record count");
    let base_records: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM local_flight_records WHERE season_id = 'season-s26' AND is_base = 1",
            [],
            |row| row.get(0),
        )
        .expect("base record count");
    assert_eq!(current_records, 1);
    assert_eq!(base_records, 1);
    let source_rows: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM local_source_rows WHERE season_id = 'season-s26'",
            [],
            |row| row.get(0),
        )
        .expect("source row count");
    assert_eq!(source_rows, 0);

    let integrity = check_season_integrity_on_connection(
        &conn,
        &CheckSeasonIntegrityInput {
            season_id: "season-s26".to_string(),
        },
    )
    .expect("imported integrity");
    assert_eq!(integrity.source_rows, 0);
    assert_eq!(integrity.base_source_rows, 0);
    assert_eq!(integrity.pending_count, 0);
    assert_eq!(integrity.last_server_seq, Some(42));

    let window = query_schedule_window_on_connection(
        &conn,
        &QueryScheduleWindowInput {
            season_id: "season-s26".to_string(),
            date_from: Some("2026-06-01".to_string()),
            date_to: Some("2026-06-01".to_string()),
            flight_number_filter: Some("8M455".to_string()),
            route_filter: None,
            type_filter: None,
            status_filter: None,
            limit: Some(100),
            offset: Some(0),
        },
    )
    .expect("query imported window");
    assert_eq!(window.raw_total, 1);
    assert_eq!(window.effective_total, 0);
    assert_eq!(window.deleted_modification_total, 1);
}

#[test]
fn import_season_snapshot_drops_orphan_modifications_but_keeps_valid_added_legs() {
    let conn = open_test_db();
    configure_sqlite_connection(&conn).expect("configure sqlite");
    ensure_native_schema(&conn).expect("native schema");

    let input = ImportSeasonSnapshotInput {
        season: json!({
            "id": "season-s26",
            "seasonCode": "S26",
            "effectiveStart": "2026-03-28",
            "effectiveEnd": "2026-10-25",
            "dataVersion": 12
        }),
        source_rows: vec![],
        records: vec![json!({
            "id": "LEG_D_2026-08-08_904_AK_AK649_KUL_12_20_320",
            "date": "2026-08-08",
            "operationalDate": "2026-08-08",
            "type": "D",
            "sourceSide": "DEP",
            "status": "active",
            "flightNumber": "AK649",
            "airline": "AK",
            "route": "KUL",
            "schedule": "12:20"
        })],
        modifications: vec![
            json!({
                "legId": "LEG_D_2026-08-08_904_AK_AK649_KUL_12_20_320",
                "action": "modified",
                "bhs": "CT02"
            }),
            json!({
                "legId": "LEG_D_2026-08-08_910_AK_AK649_KUL_12_20_320",
                "action": "modified",
                "bhs": "CT02"
            }),
            json!({
                "legId": "added-ak650-2026-08-08",
                "action": "added",
                "addedLeg": {
                    "id": "added-ak650-2026-08-08",
                    "date": "2026-08-08",
                    "operationalDate": "2026-08-08",
                    "type": "D",
                    "sourceSide": "DEP",
                    "status": "active",
                    "flightNumber": "AK650",
                    "airline": "AK",
                    "route": "KUL",
                    "schedule": "13:20"
                }
            }),
        ],
        mod_history: vec![],
        server_event_high_water: 42,
        entity_versions: json!({}),
    };

    let imported = import_season_snapshot_on_connection(&conn, &input).expect("import snapshot");
    assert_eq!(imported.modifications, 2);

    let orphan_count: i64 = conn
        .query_row(
            "SELECT COUNT(1) FROM local_modifications WHERE season_id = ? AND leg_id = ?",
            params!["season-s26", "LEG_D_2026-08-08_910_AK_AK649_KUL_12_20_320"],
            |row| row.get(0),
        )
        .expect("orphan modification count");
    assert_eq!(orphan_count, 0);

    let kept_count: i64 = conn
        .query_row(
            "SELECT COUNT(1) FROM local_modifications WHERE season_id = ?",
            params!["season-s26"],
            |row| row.get(0),
        )
        .expect("kept modification count");
    assert_eq!(kept_count, 4);

    let window = query_schedule_window_on_connection(
        &conn,
        &QueryScheduleWindowInput {
            season_id: "season-s26".to_string(),
            date_from: Some("2026-08-08".to_string()),
            date_to: Some("2026-08-08".to_string()),
            flight_number_filter: Some("AK".to_string()),
            route_filter: None,
            type_filter: None,
            status_filter: None,
            limit: Some(100),
            offset: Some(0),
        },
    )
    .expect("query imported window");
    assert_eq!(window.raw_total, 1);
    assert_eq!(window.effective_total, 2);
    assert_eq!(window.modifications.len(), 2);
}

fn stale_merge_snapshot_input(
    data_version: i64,
    seq: i64,
    gate: i64,
    stand: i64,
) -> MergeSeasonSnapshotInput {
    MergeSeasonSnapshotInput {
        season: json!({
            "id": "season-1",
            "seasonCode": "S26",
            "effectiveStart": "2026-03-28",
            "effectiveEnd": "2026-10-25",
            "dataVersion": data_version
        }),
        source_rows: vec![],
        records: vec![json!({
            "id": "leg-1",
            "date": "2026-05-26",
            "operationalDate": "2026-05-26",
            "type": "departure",
            "sourceSide": "dep",
            "status": "scheduled",
            "gate": gate,
            "stand": stand,
            "schedule": "10:00"
        })],
        modifications: vec![],
        mod_history: vec![],
        server_event_high_water: seq,
        entity_versions: json!({
            "flightRecord:leg-1": {
                "gate": gate,
                "stand": stand
            }
        }),
        client_id: Some("client-1".to_string()),
    }
}

fn stale_merge_modification_snapshot_input(
    field: &str,
    value: serde_json::Value,
    version: i64,
) -> MergeSeasonSnapshotInput {
    MergeSeasonSnapshotInput {
        season: json!({
            "id": "season-1",
            "seasonCode": "S26",
            "effectiveStart": "2026-03-28",
            "effectiveEnd": "2026-10-25",
            "dataVersion": 5
        }),
        source_rows: vec![],
        records: vec![json!({
            "id": "leg-1",
            "date": "2026-05-26",
            "operationalDate": "2026-05-26",
            "type": "departure",
            "sourceSide": "dep",
            "status": "scheduled",
            "gate": 1,
            "stand": 10,
            "schedule": "10:00"
        })],
        modifications: vec![json!({
            "legId": "leg-1",
            "action": "modified",
            field: value
        })],
        mod_history: vec![],
        server_event_high_water: version,
        entity_versions: json!({
            "flightRecord:leg-1": {
                "gate": 1,
                "stand": 1,
                "schedule": 1
            },
            "modification:leg-1": {
                field: version
            }
        }),
        client_id: Some("client-1".to_string()),
    }
}

fn seed_imported_snapshot(conn: &Connection) {
    import_season_snapshot_on_connection(
        conn,
        &ImportSeasonSnapshotInput {
            season: json!({
                "id": "season-1",
                "seasonCode": "S26",
                "effectiveStart": "2026-03-28",
                "effectiveEnd": "2026-10-25",
                "dataVersion": 1
            }),
            source_rows: vec![],
            records: vec![json!({
                "id": "leg-1",
                "date": "2026-05-26",
                "operationalDate": "2026-05-26",
                "type": "departure",
                "sourceSide": "dep",
                "status": "scheduled",
                "gate": 1,
                "stand": 10,
                "schedule": "10:00"
            })],
            modifications: vec![],
            mod_history: vec![],
            server_event_high_water: 1,
            entity_versions: json!({
                "flightRecord:leg-1": {
                    "gate": 1,
                    "stand": 1,
                    "schedule": 1
                }
            }),
        },
    )
    .expect("seed imported snapshot");
}

fn seed_imported_snapshot_with_modification(
    conn: &Connection,
    field: &str,
    value: serde_json::Value,
) {
    import_season_snapshot_on_connection(
        conn,
        &ImportSeasonSnapshotInput {
            season: json!({
                "id": "season-1",
                "seasonCode": "S26",
                "effectiveStart": "2026-03-28",
                "effectiveEnd": "2026-10-25",
                "dataVersion": 1
            }),
            source_rows: vec![],
            records: vec![json!({
                "id": "leg-1",
                "date": "2026-05-26",
                "operationalDate": "2026-05-26",
                "type": "departure",
                "sourceSide": "dep",
                "status": "scheduled",
                "gate": 1,
                "stand": 10,
                "schedule": "10:00"
            })],
            modifications: vec![json!({
                "legId": "leg-1",
                "action": "modified",
                field: value
            })],
            mod_history: vec![],
            server_event_high_water: 1,
            entity_versions: json!({
                "flightRecord:leg-1": {
                    "gate": 1,
                    "stand": 1,
                    "schedule": 1
                },
                "modification:leg-1": {
                    field: 1
                }
            }),
        },
    )
    .expect("seed imported snapshot with modification");
}

fn make_local_gate_edit(conn: &Connection, gate: i64) {
    apply_schedule_mutation_to_connection(
        conn,
        &ApplyScheduleMutationInput {
            season_id: "season-1".to_string(),
            records: vec![json!({
                "id": "leg-1",
                "date": "2026-05-26",
                "operationalDate": "2026-05-26",
                "type": "departure",
                "sourceSide": "dep",
                "status": "scheduled",
                "gate": gate,
                "stand": 10,
                "schedule": "10:00"
            })],
            source_rows: vec![],
            mods: vec![],
            deleted_ids: vec![],
            history: None,
        },
    )
    .expect("local gate edit");
}

fn make_local_modification_edit(conn: &Connection, field: &str, value: serde_json::Value) {
    apply_local_modification_batch_delta_to_connection(
        conn,
        &ApplyLocalModificationBatchDeltaInput {
            season_id: "season-1".to_string(),
            mods: vec![json!({
                "legId": "leg-1",
                "action": "modified",
                field: value
            })],
            history: None,
        },
    )
    .expect("local modification edit");
}

fn current_record_payload(conn: &Connection) -> serde_json::Value {
    let payload: String = conn
        .query_row(
            "SELECT payload_json FROM local_flight_records WHERE season_id = ? AND record_id = ? AND is_base = 0",
            params!["season-1", "leg-1"],
            |row| row.get(0),
        )
        .expect("current record payload");
    serde_json::from_str(&payload).expect("json payload")
}

fn current_modification_payload(conn: &Connection) -> serde_json::Value {
    let payload: String = conn
        .query_row(
            "SELECT payload_json FROM local_modifications WHERE season_id = ? AND leg_id = ? AND is_base = 0",
            params!["season-1", "leg-1"],
            |row| row.get(0),
        )
        .expect("current modification payload");
    serde_json::from_str(&payload).expect("json payload")
}

#[test]
fn season_freshness_reads_stale_local_version_before_ensure_can_mask_it() {
    let conn = open_test_db();
    configure_sqlite_connection(&conn).expect("configure sqlite");
    ensure_native_schema(&conn).expect("native schema");
    seed_imported_snapshot(&conn);

    let before = query_season_freshness_on_connection(
        &conn,
        &QuerySeasonFreshnessInput {
            season_id: "season-1".to_string(),
        },
    )
    .expect("freshness before ensure");
    assert!(before.exists);
    assert_eq!(before.local_data_version, Some(1));
    assert_eq!(before.base_server_version, Some(1));
    assert_eq!(before.last_server_seq, Some(1));
    assert_eq!(before.pending_count, 0);
    assert_eq!(before.conflict_count, 0);
    assert_eq!(before.record_count, 1);
    assert_eq!(before.base_record_count, 1);

    ensure_local_season_on_connection(
        &conn,
        &EnsureLocalSeasonInput {
            season: json!({
                "id": "season-1",
                "seasonCode": "S26",
                "effectiveStart": "2026-03-28",
                "effectiveEnd": "2026-10-25",
                "dataVersion": 5
            }),
        },
    )
    .expect("ensure masks local season version");
    let after = query_season_freshness_on_connection(
        &conn,
        &QuerySeasonFreshnessInput {
            season_id: "season-1".to_string(),
        },
    )
    .expect("freshness after ensure");
    assert_eq!(after.local_data_version, Some(5));
    assert_eq!(after.base_server_version, Some(1));
}

#[test]
fn clean_stale_snapshot_merge_replaces_local_baseline() {
    let conn = open_test_db();
    configure_sqlite_connection(&conn).expect("configure sqlite");
    ensure_native_schema(&conn).expect("native schema");
    seed_imported_snapshot(&conn);

    let result =
        merge_season_snapshot_on_connection(&conn, &stale_merge_snapshot_input(5, 9, 7, 20))
            .expect("merge clean stale snapshot");
    let current = current_record_payload(&conn);

    assert_eq!(result.sync_meta["baseServerVersion"], 5);
    assert_eq!(result.sync_meta["lastServerSeq"], 9);
    assert_eq!(result.sync_meta["pendingCount"], 0);
    assert_eq!(current["gate"], 7);
    assert_eq!(current["stand"], 20);
}

#[test]
fn dirty_stale_snapshot_merge_replays_non_overlapping_local_edits_on_latest_base() {
    let conn = open_test_db();
    configure_sqlite_connection(&conn).expect("configure sqlite");
    ensure_native_schema(&conn).expect("native schema");
    seed_imported_snapshot(&conn);
    make_local_gate_edit(&conn, 4);

    let result =
        merge_season_snapshot_on_connection(&conn, &stale_merge_snapshot_input(5, 9, 1, 20))
            .expect("merge dirty stale snapshot");
    let current = current_record_payload(&conn);

    assert_eq!(result.sync_meta["pendingCount"], 1);
    assert_eq!(result.conflict_count, 0);
    assert_eq!(current["gate"], 4);
    assert_eq!(current["stand"], 20);
}

#[test]
fn dirty_stale_snapshot_merge_records_overlap_conflict_without_discarding_local_edit() {
    let conn = open_test_db();
    configure_sqlite_connection(&conn).expect("configure sqlite");
    ensure_native_schema(&conn).expect("native schema");
    seed_imported_snapshot(&conn);
    make_local_gate_edit(&conn, 4);

    let result =
        merge_season_snapshot_on_connection(&conn, &stale_merge_snapshot_input(5, 9, 8, 20))
            .expect("merge dirty stale conflict");
    let current = current_record_payload(&conn);

    assert_eq!(result.sync_meta["pendingCount"], 1);
    assert_eq!(result.conflict_count, 1);
    assert_eq!(current["gate"], 4);
    assert_eq!(current["stand"], 20);
    assert_eq!(result.conflicts[0]["targetType"], "flightRecord");
    assert_eq!(result.conflicts[0]["targetId"], "leg-1");
    assert_eq!(result.conflicts[0]["localFields"]["gate"], 4);
    assert_eq!(result.conflicts[0]["remoteFields"]["gate"], 8);
}

#[test]
fn dirty_stale_snapshot_merge_auto_accepts_remote_latest_allocation_modification_conflict() {
    let conn = open_test_db();
    configure_sqlite_connection(&conn).expect("configure sqlite");
    ensure_native_schema(&conn).expect("native schema");
    seed_imported_snapshot_with_modification(&conn, "gate", json!(2));
    make_local_modification_edit(&conn, "gate", json!(4));

    let result = merge_season_snapshot_on_connection(
        &conn,
        &stale_merge_modification_snapshot_input("gate", json!(8), 9),
    )
    .expect("merge dirty stale allocation modification conflict");
    let current = current_modification_payload(&conn);
    let pending_count: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM local_pending_ops WHERE season_id = ?",
            params!["season-1"],
            |row| row.get(0),
        )
        .expect("pending count");

    assert_eq!(result.conflict_count, 0);
    assert_eq!(result.auto_resolved_conflict_count, 1);
    assert_eq!(result.auto_resolved_conflict_ids.len(), 1);
    assert_eq!(pending_count, 0);
    assert_eq!(result.sync_meta["pendingCount"], 0);
    assert_eq!(result.sync_meta["syncStatus"], "synced");
    assert_eq!(current["gate"], 8);
}

#[test]
fn dirty_stale_snapshot_merge_keeps_structural_modification_conflict_for_review() {
    let conn = open_test_db();
    configure_sqlite_connection(&conn).expect("configure sqlite");
    ensure_native_schema(&conn).expect("native schema");
    seed_imported_snapshot_with_modification(&conn, "schedule", json!("10:00"));
    make_local_modification_edit(&conn, "schedule", json!("10:20"));

    let result = merge_season_snapshot_on_connection(
        &conn,
        &stale_merge_modification_snapshot_input("schedule", json!("10:30"), 9),
    )
    .expect("merge dirty stale structural modification conflict");
    let current = current_modification_payload(&conn);

    assert_eq!(result.auto_resolved_conflict_count, 0);
    assert_eq!(result.conflict_count, 1);
    assert_eq!(result.conflicts[0]["targetType"], "modification");
    assert_eq!(result.conflicts[0]["targetId"], "leg-1");
    assert_eq!(result.conflicts[0]["overlappingFields"][0], "schedule");
    assert_eq!(current["schedule"], "10:20");
}

#[test]
fn native_conflict_resolution_keep_mine_preserves_pending_local_change() {
    let conn = open_test_db();
    configure_sqlite_connection(&conn).expect("configure sqlite");
    ensure_native_schema(&conn).expect("native schema");
    seed_imported_snapshot(&conn);
    make_local_gate_edit(&conn, 4);
    let merged =
        merge_season_snapshot_on_connection(&conn, &stale_merge_snapshot_input(5, 9, 8, 20))
            .expect("merge dirty stale conflict");
    let conflict_id = merged.conflicts[0]["id"].as_str().expect("conflict id");

    let resolved = resolve_season_conflict_on_connection(
        &conn,
        &ResolveSeasonConflictInput {
            season_id: "season-1".to_string(),
            conflict_id: conflict_id.to_string(),
            resolution: "keepMine".to_string(),
        },
    )
    .expect("keep mine");
    let current = current_record_payload(&conn);

    assert_eq!(resolved.conflict_count, 0);
    assert_eq!(resolved.sync_meta["pendingCount"], 1);
    assert_eq!(current["gate"], 4);
}

#[test]
fn native_conflict_resolution_accept_remote_applies_remote_and_clears_target_pending_op() {
    let conn = open_test_db();
    configure_sqlite_connection(&conn).expect("configure sqlite");
    ensure_native_schema(&conn).expect("native schema");
    seed_imported_snapshot(&conn);
    make_local_gate_edit(&conn, 4);
    let merged =
        merge_season_snapshot_on_connection(&conn, &stale_merge_snapshot_input(5, 9, 8, 20))
            .expect("merge dirty stale conflict");
    let conflict_id = merged.conflicts[0]["id"].as_str().expect("conflict id");

    let resolved = resolve_season_conflict_on_connection(
        &conn,
        &ResolveSeasonConflictInput {
            season_id: "season-1".to_string(),
            conflict_id: conflict_id.to_string(),
            resolution: "acceptRemote".to_string(),
        },
    )
    .expect("accept remote");
    let current = current_record_payload(&conn);
    let pending_count: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM local_pending_ops WHERE season_id = ?",
            params!["season-1"],
            |row| row.get(0),
        )
        .expect("pending count");

    assert_eq!(resolved.conflict_count, 0);
    assert_eq!(pending_count, 0);
    assert_eq!(resolved.sync_meta["pendingCount"], 0);
    assert_eq!(current["gate"], 8);
    assert_eq!(current["stand"], 20);
}

fn seed_flight_record_conflict_for_record_history(
    conn: &Connection,
    history_id: &str,
    record_changes: serde_json::Value,
) -> String {
    let conflict_id = "conflict-record-1".to_string();
    let conflict_event = json!({
        "eventId": "remote-record-1",
        "seasonId": "season-1",
        "clientId": "server",
        "opId": "remote-record-op-1",
        "serverSeq": 9,
        "targetType": "flightRecord",
        "targetId": "leg-1",
        "changedFields": ["gate"],
        "opPayload": {
            "type": "flightRecord",
            "record": {
                "id": "leg-1",
                "date": "2026-05-26",
                "operationalDate": "2026-05-26",
                "type": "departure",
                "sourceSide": "DEP",
                "status": "active",
                "gate": 8,
                "stand": 10,
                "schedule": "10:00"
            }
        },
        "createdAt": "2026-06-16T00:00:00Z"
    });
    let sync_meta = json!({
        "seasonId": "season-1",
        "baseServerVersion": 1,
        "lastServerSeq": 8,
        "localRevision": 1,
        "pendingCount": 2,
        "lastLocalChangeAt": 1_772_000_000_000_i64,
        "syncStatus": "needs_review",
        "conflicts": [{
            "id": conflict_id,
            "event": conflict_event,
            "targetType": "flightRecord",
            "targetId": "leg-1",
            "overlappingFields": ["gate"]
        }]
    });
    conn.execute(
        "UPDATE local_sync_meta SET pending_count = ?, sync_status = ?, last_server_seq = ?, last_local_change_at = ?, payload_json = ? WHERE season_id = ?",
        params![
            2,
            "needs_review",
            8_i64,
            1_772_000_000_000_i64,
            sync_meta.to_string(),
            "season-1"
        ],
    )
    .expect("seed conflict sync meta");
    conn.execute(
        "INSERT INTO local_pending_ops (season_id, op_key, op_type, sort_order, payload_json) VALUES (?, ?, ?, ?, ?)",
        params![
            "season-1",
            "flightRecord:leg-1",
            "flightRecord",
            0_i64,
            json!({
                "type": "flightRecord",
                "record": {
                    "id": "leg-1",
                    "date": "2026-05-26",
                    "operationalDate": "2026-05-26",
                    "type": "departure",
                    "sourceSide": "DEP",
                    "status": "active",
                    "gate": 4,
                    "stand": 10,
                    "schedule": "10:00"
                }
            }).to_string()
        ],
    )
    .expect("seed flight record pending op");
    conn.execute(
        "INSERT INTO local_pending_ops (season_id, op_key, op_type, sort_order, payload_json) VALUES (?, ?, ?, ?, ?)",
        params![
            "season-1",
            format!("modHistory:{history_id}"),
            "modHistory",
            1_i64,
            json!({
                "type": "modHistory",
                "entry": {
                    "id": history_id,
                    "timestamp": 1_772_000_000_001_i64,
                    "description": "Record history",
                    "changes": [],
                    "recordChanges": record_changes
                }
            }).to_string()
        ],
    )
    .expect("seed mod history pending op");
    conflict_id
}

#[test]
fn accept_remote_record_conflict_drops_record_history_only_when_all_record_targets_match() {
    let conn = open_test_db();
    configure_sqlite_connection(&conn).expect("configure sqlite");
    create_minimal_local_schema(&conn);
    seed_flight(&conn);
    let conflict_id = seed_flight_record_conflict_for_record_history(
        &conn,
        "history-record-only",
        json!([{
            "recordId": "leg-1",
            "previousRecord": null,
            "newRecord": { "id": "leg-1", "gate": 4 }
        }]),
    );

    resolve_season_conflict_on_connection(
        &conn,
        &ResolveSeasonConflictInput {
            season_id: "season-1".to_string(),
            conflict_id,
            resolution: "acceptRemote".to_string(),
        },
    )
    .expect("accept remote record conflict");
    let history_count: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM local_pending_ops WHERE season_id = ? AND op_type = 'modHistory'",
            params!["season-1"],
            |row| row.get(0),
        )
        .expect("history count");

    assert_eq!(history_count, 0);
}

#[test]
fn accept_remote_record_conflict_preserves_mixed_record_history_for_sibling_targets() {
    let conn = open_test_db();
    configure_sqlite_connection(&conn).expect("configure sqlite");
    create_minimal_local_schema(&conn);
    seed_flight(&conn);
    let conflict_id = seed_flight_record_conflict_for_record_history(
        &conn,
        "history-mixed-records",
        json!([
            {
                "recordId": "leg-1",
                "previousRecord": null,
                "newRecord": { "id": "leg-1", "gate": 4 }
            },
            {
                "recordId": "leg-10",
                "previousRecord": null,
                "newRecord": { "id": "leg-10", "gate": 10 }
            }
        ]),
    );

    resolve_season_conflict_on_connection(
        &conn,
        &ResolveSeasonConflictInput {
            season_id: "season-1".to_string(),
            conflict_id,
            resolution: "acceptRemote".to_string(),
        },
    )
    .expect("accept remote record conflict");
    let surviving_history: String = conn
        .query_row(
            "SELECT op_key FROM local_pending_ops WHERE season_id = ? AND op_type = 'modHistory'",
            params!["season-1"],
            |row| row.get(0),
        )
        .expect("mixed history should survive");

    assert_eq!(surviving_history, "modHistory:history-mixed-records");
}

#[test]
fn integrity_allows_record_only_daily_imported_season() {
    let conn = open_test_db();
    configure_sqlite_connection(&conn).expect("configure sqlite");
    ensure_native_schema(&conn).expect("native schema");

    let input = ImportSeasonSnapshotInput {
        season: json!({
            "id": "season-w26",
            "seasonCode": "W26",
            "effectiveStart": "2026-10-25",
            "effectiveEnd": "2027-03-27",
            "dataVersion": 3
        }),
        source_rows: vec![],
        records: vec![json!({
            "id": "w26-daily-1",
            "date": "2026-11-01",
            "operationalDate": "2026-11-01",
            "type": "A",
            "sourceSide": "daily",
            "status": "active",
            "flightNumber": "VN101",
            "schedule": "08:00"
        })],
        modifications: vec![],
        mod_history: vec![],
        server_event_high_water: 7,
        entity_versions: json!({}),
    };
    import_season_snapshot_on_connection(&conn, &input).expect("import record-only snapshot");

    let integrity = check_season_integrity_on_connection(
        &conn,
        &CheckSeasonIntegrityInput {
            season_id: "season-w26".to_string(),
        },
    )
    .expect("record-only season is healthy");
    assert_eq!(integrity.source_rows, 0);
    assert_eq!(integrity.records, 1);
    assert_eq!(integrity.base_records, 1);
}

fn create_minimal_local_schema(conn: &Connection) {
    conn.execute_batch(
        r#"
        CREATE TABLE local_seasons (
          season_id TEXT PRIMARY KEY,
          season_code TEXT NOT NULL,
          effective_start TEXT,
          effective_end TEXT,
          data_version INTEGER NOT NULL DEFAULT 0,
          payload_json TEXT NOT NULL
        );
        CREATE TABLE local_source_rows (
          season_id TEXT NOT NULL,
          row_index INTEGER NOT NULL,
          is_base INTEGER NOT NULL DEFAULT 0,
          sort_order INTEGER NOT NULL,
          effective TEXT,
          discontinue TEXT,
          airline TEXT,
          payload_json TEXT NOT NULL,
          PRIMARY KEY (season_id, row_index, is_base)
        );
        CREATE TABLE local_flight_records (
          season_id TEXT NOT NULL,
          record_id TEXT NOT NULL,
          is_base INTEGER NOT NULL DEFAULT 0,
          sort_order INTEGER NOT NULL,
          flight_date TEXT,
          operational_date TEXT,
          type TEXT,
          source_side TEXT,
          status TEXT,
          turnaround_id TEXT,
          gate INTEGER,
          stand INTEGER,
          counter_json TEXT,
          check_in_start TEXT,
          check_in_end TEXT,
          schedule TEXT,
          payload_json TEXT NOT NULL,
          PRIMARY KEY (season_id, record_id, is_base)
        );
        CREATE TABLE local_pending_ops (
          season_id TEXT NOT NULL,
          op_key TEXT NOT NULL,
          op_type TEXT NOT NULL,
          sort_order INTEGER NOT NULL,
          payload_json TEXT NOT NULL,
          PRIMARY KEY (season_id, op_key)
        );
        CREATE TABLE local_sync_meta (
          season_id TEXT PRIMARY KEY,
          pending_count INTEGER NOT NULL,
          sync_status TEXT NOT NULL,
          last_server_seq INTEGER,
          last_local_change_at INTEGER,
          payload_json TEXT NOT NULL
        );
        CREATE TABLE local_entity_versions (
          season_id TEXT NOT NULL,
          target_type TEXT NOT NULL,
          target_id TEXT NOT NULL,
          server_version INTEGER NOT NULL,
          PRIMARY KEY (season_id, target_type, target_id)
        );
        CREATE TABLE local_modifications (
          season_id TEXT NOT NULL,
          leg_id TEXT NOT NULL,
          is_base INTEGER NOT NULL DEFAULT 0,
          sort_order INTEGER NOT NULL,
          action TEXT NOT NULL,
          gate INTEGER,
          stand INTEGER,
          counter_json TEXT,
          check_in_start TEXT,
          check_in_end TEXT,
          schedule TEXT,
          payload_json TEXT NOT NULL,
          PRIMARY KEY (season_id, leg_id, is_base)
        );
        CREATE TABLE local_mod_history_entries (
          season_id TEXT NOT NULL,
          history_id TEXT NOT NULL,
          is_base INTEGER NOT NULL DEFAULT 0,
          sort_order INTEGER NOT NULL,
          timestamp INTEGER NOT NULL,
          payload_json TEXT NOT NULL,
          PRIMARY KEY (season_id, history_id, is_base)
        );
        CREATE TABLE local_derived_seasonal (
          season_id TEXT PRIMARY KEY,
          payload_json TEXT NOT NULL
        );
        CREATE TABLE local_kv (
          key TEXT PRIMARY KEY,
          value_json TEXT NOT NULL,
          updated_at INTEGER NOT NULL
        );
        CREATE TABLE local_schema_version (
          id INTEGER PRIMARY KEY CHECK (id = 1),
          version INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );
        "#,
    )
    .expect("schema");
}

fn insert_dashboard_ai_sql_fixture(conn: &Connection) {
    create_minimal_local_schema(conn);
    conn.execute(
        "INSERT INTO local_seasons (season_id, season_code, effective_start, effective_end, payload_json) VALUES (?1, ?2, ?3, ?4, ?5)",
        params![
            "season-s26",
            "S26",
            "2026-03-28",
            "2026-10-25",
            json!({ "seasonCode": "S26" }).to_string()
        ],
    )
    .expect("insert local season");
    for (index, (record_id, ops_date, schedule, flight, airline, route, pax, type_code)) in [
        (
            "r1",
            "2026-06-01",
            "07:10",
            "VN101",
            "VN",
            "HAN-DAD",
            100,
            "A",
        ),
        (
            "r2",
            "2026-06-01",
            "08:20",
            "VN102",
            "VN",
            "DAD-SGN",
            120,
            "D",
        ),
        (
            "r3",
            "2026-06-02",
            "09:30",
            "VJ201",
            "VJ",
            "SGN-DAD",
            90,
            "A",
        ),
    ]
    .iter()
    .enumerate()
    {
        conn.execute(
            r#"INSERT INTO local_flight_records (
                season_id, record_id, is_base, sort_order, flight_date, operational_date,
                type, source_side, status, gate, stand, schedule, payload_json
              ) VALUES (?1, ?2, 0, ?3, ?4, ?4, ?5, 'schedule', 'active', ?6, ?7, ?8, ?9)"#,
            params![
                "season-s26",
                record_id,
                index as i64,
                ops_date,
                type_code,
                1_i64,
                2_i64,
                schedule,
                json!({
                    "flightNumber": flight,
                    "airline": airline,
                    "route": route,
                    "iataSeasonCode": "S26",
                    "pax": pax,
                    "type": type_code,
                    "status": "active"
                })
                .to_string()
            ],
        )
        .expect("insert local flight record");
    }
}

#[test]
fn dashboard_ai_sql_accepts_select_and_cte_only_on_projection_view() {
    let conn = open_test_db();
    insert_dashboard_ai_sql_fixture(&conn);

    let daily = query_dashboard_ai_sql_on_connection(
        &conn,
        &QueryNativeDashboardAiSqlInput {
            sql: "SELECT ops_date, COUNT(*) AS flights, SUM(pax) AS pax FROM dashboard_ai_flight_operations WHERE month = ? GROUP BY ops_date ORDER BY flights DESC".to_string(),
            params: vec![json!("2026-06")],
            limit: Some(10),
        },
    )
    .expect("daily query succeeds");
    assert_eq!(daily.columns, vec!["ops_date", "flights", "pax"]);
    assert_eq!(daily.rows[0]["ops_date"], json!("2026-06-01"));
    assert_eq!(daily.rows[0]["flights"], json!(2));
    assert!(daily.executed_sql_preview.ends_with("LIMIT 10"));

    let cte = query_dashboard_ai_sql_on_connection(
        &conn,
        &QueryNativeDashboardAiSqlInput {
            sql: "WITH daily AS (SELECT ops_date, COUNT(*) AS flights FROM dashboard_ai_flight_operations GROUP BY ops_date) SELECT ops_date, flights FROM daily ORDER BY flights DESC LIMIT 5".to_string(),
            params: Vec::new(),
            limit: Some(5),
        },
    )
    .expect("cte query succeeds");
    assert_eq!(cte.rows[0]["flights"], json!(2));
}

#[test]
fn dashboard_ai_sql_rejects_mutation_multiple_statements_and_unknown_tables() {
    let conn = open_test_db();
    insert_dashboard_ai_sql_fixture(&conn);

    for sql in [
        "UPDATE dashboard_ai_flight_operations SET pax = 0",
        "PRAGMA table_info(local_flight_records)",
        "SELECT * FROM local_flight_records LIMIT 5",
        "SELECT * FROM dashboard_ai_flight_operations LIMIT 1; SELECT 1",
    ] {
        let error = query_dashboard_ai_sql_on_connection(
            &conn,
            &QueryNativeDashboardAiSqlInput {
                sql: sql.to_string(),
                params: Vec::new(),
                limit: Some(5),
            },
        )
        .expect_err("unsafe SQL is rejected")
        .to_string();
        assert!(
            error.contains("Dashboard AI SQL"),
            "unexpected rejection error for {sql}: {error}"
        );
    }
}

#[test]
fn integrity_check_fails_closed_when_sync_meta_is_missing() {
    let conn = open_test_db();
    configure_sqlite_connection(&conn).expect("configure sqlite");
    create_minimal_local_schema(&conn);
    seed_flight(&conn);
    conn.execute(
        "DELETE FROM local_sync_meta WHERE season_id = ?",
        params!["season-1"],
    )
    .expect("delete sync meta");

    let input = CheckSeasonIntegrityInput {
        season_id: "season-1".to_string(),
    };
    let error = check_season_integrity_on_connection(&conn, &input)
        .expect_err("missing sync meta must fail");

    assert!(
        error.contains("local_sync_meta"),
        "error should identify missing sync meta, got {error}"
    );
}

#[test]
fn ensure_local_season_is_idempotent_and_creates_sync_meta() {
    let conn = open_test_db();
    configure_sqlite_connection(&conn).expect("configure sqlite");
    create_minimal_local_schema(&conn);

    let input = EnsureLocalSeasonInput {
        season: json!({
            "id": "season-w26",
            "seasonCode": "W26",
            "name": "W26",
            "fileName": "daily-import.xlsx",
            "uploadedAt": 1770000000000_i64,
            "effectiveStart": "2026-10-25",
            "effectiveEnd": "2027-03-27",
            "totalLegs": 0,
            "totalSourceRows": 0,
            "dataVersion": 0
        }),
    };

    let first = ensure_local_season_on_connection(&conn, &input).expect("ensure local season");
    let second =
        ensure_local_season_on_connection(&conn, &input).expect("ensure local season again");

    let season_count: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM local_seasons WHERE season_id = ?",
            params!["season-w26"],
            |row| row.get(0),
        )
        .expect("season count");
    let sync_meta_count: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM local_sync_meta WHERE season_id = ?",
            params!["season-w26"],
            |row| row.get(0),
        )
        .expect("sync meta count");

    assert_eq!(season_count, 1);
    assert_eq!(sync_meta_count, 1);
    assert_eq!(first.sync_meta["seasonId"], "season-w26");
    assert_eq!(second.sync_meta["pendingCount"], 0);
}

#[test]
fn schedule_window_query_reads_only_requested_operational_date_range() {
    let conn = open_test_db();
    configure_sqlite_connection(&conn).expect("configure sqlite");
    create_minimal_local_schema(&conn);
    seed_flight(&conn);
    seed_extra_flight(&conn, "leg-2", "2026-05-27", "departure", 2);

    let input = QueryScheduleWindowInput {
        season_id: "season-1".to_string(),
        date_from: Some("2026-05-27".to_string()),
        date_to: Some("2026-05-27".to_string()),
        flight_number_filter: None,
        route_filter: None,
        type_filter: Some("departure".to_string()),
        status_filter: None,
        limit: Some(50),
        offset: Some(0),
    };
    let result = query_schedule_window_on_connection(&conn, &input).expect("query window");

    assert_eq!(result.records.len(), 1);
    assert_eq!(result.records[0]["id"], "leg-2");
    assert_eq!(result.sync_meta["lastServerSeq"], 1);
}

#[test]
fn schedule_window_flight_filter_ignores_empty_comma_terms() {
    let conn = open_test_db();
    configure_sqlite_connection(&conn).expect("configure sqlite");
    create_minimal_local_schema(&conn);
    seed_flight(&conn);
    seed_flight_with_number(&conn, "leg-8m", "2026-05-27", "departure", "8M101", "8M", 2);
    seed_flight_with_number(&conn, "leg-yp", "2026-05-27", "departure", "YP200", "YP", 3);

    let input = QueryScheduleWindowInput {
        season_id: "season-1".to_string(),
        date_from: None,
        date_to: None,
        flight_number_filter: Some("8M, ".to_string()),
        route_filter: None,
        type_filter: None,
        status_filter: None,
        limit: Some(50),
        offset: Some(0),
    };
    let result = query_schedule_window_on_connection(&conn, &input).expect("query window");

    assert_eq!(result.records.len(), 1);
    assert_eq!(result.records[0]["id"], "leg-8m");
}

#[test]
fn schedule_window_flight_filter_matches_comma_separated_terms_as_or() {
    let conn = open_test_db();
    configure_sqlite_connection(&conn).expect("configure sqlite");
    create_minimal_local_schema(&conn);
    seed_flight(&conn);
    seed_flight_with_number(&conn, "leg-8m", "2026-05-27", "departure", "8M101", "8M", 2);
    seed_flight_with_number(&conn, "leg-yp", "2026-05-28", "departure", "YP200", "YP", 3);
    seed_flight_with_number(&conn, "leg-vn", "2026-05-29", "departure", "VN300", "VN", 4);

    let input = QueryScheduleWindowInput {
        season_id: "season-1".to_string(),
        date_from: None,
        date_to: None,
        flight_number_filter: Some("8M, YP".to_string()),
        route_filter: None,
        type_filter: None,
        status_filter: None,
        limit: Some(50),
        offset: Some(0),
    };
    let result = query_schedule_window_on_connection(&conn, &input).expect("query window");
    let ids = result
        .records
        .iter()
        .map(|record| record["id"].as_str().unwrap_or_default())
        .collect::<Vec<_>>();

    assert_eq!(ids, vec!["leg-8m", "leg-yp"]);
}

#[test]
fn schedule_window_flight_filter_does_not_split_whitespace() {
    let conn = open_test_db();
    configure_sqlite_connection(&conn).expect("configure sqlite");
    create_minimal_local_schema(&conn);
    seed_flight(&conn);
    seed_flight_with_number(&conn, "leg-8m", "2026-05-27", "departure", "8M101", "8M", 2);
    seed_flight_with_number(&conn, "leg-yp", "2026-05-28", "departure", "YP200", "YP", 3);

    let input = QueryScheduleWindowInput {
        season_id: "season-1".to_string(),
        date_from: None,
        date_to: None,
        flight_number_filter: Some("8M YP".to_string()),
        route_filter: None,
        type_filter: None,
        status_filter: None,
        limit: Some(50),
        offset: Some(0),
    };
    let result = query_schedule_window_on_connection(&conn, &input).expect("query window");

    assert_eq!(result.records.len(), 0);
}

#[test]
fn schedule_window_flight_filter_applies_to_added_modifications() {
    let conn = open_test_db();
    configure_sqlite_connection(&conn).expect("configure sqlite");
    create_minimal_local_schema(&conn);
    seed_flight(&conn);
    conn.execute(
        "INSERT INTO local_modifications (
          season_id, leg_id, is_base, sort_order, action, payload_json
        ) VALUES (?, ?, 0, 1, 'added', ?)",
        params![
            "season-1",
            "added-8m",
            json!({
                "action": "added",
                "addedLeg": {
                    "id": "added-8m",
                    "date": "2026-05-27",
                    "operationalDate": "2026-05-27",
                    "type": "A",
                    "status": "active",
                    "flightNumber": "8M999",
                    "airline": "8M",
                    "route": "RGN",
                    "schedule": "12:00"
                }
            })
            .to_string()
        ],
    )
    .expect("seed added modification");

    let input = QueryScheduleWindowInput {
        season_id: "season-1".to_string(),
        date_from: None,
        date_to: None,
        flight_number_filter: Some("8M, ".to_string()),
        route_filter: None,
        type_filter: None,
        status_filter: None,
        limit: Some(50),
        offset: Some(0),
    };
    let result = query_schedule_window_on_connection(&conn, &input).expect("query window");

    assert_eq!(result.records.len(), 0);
    assert_eq!(result.modifications.len(), 1);
    assert_eq!(result.modifications[0]["legId"], "added-8m");
}

#[test]
fn schedule_window_normalizes_sparse_deleted_modification_and_reports_effective_totals() {
    let conn = open_test_db();
    configure_sqlite_connection(&conn).expect("configure sqlite");
    create_minimal_local_schema(&conn);
    seed_flight(&conn);
    seed_extra_flight(&conn, "leg-2", "2026-05-27", "arrival", 2);
    seed_extra_flight(&conn, "leg-3", "2026-05-28", "departure", 3);
    conn.execute(
        "INSERT INTO local_modifications (
          season_id, leg_id, is_base, sort_order, action, payload_json
        ) VALUES (?, ?, 0, 0, 'deleted', ?)",
        params![
            "season-1",
            "leg-1",
            json!({ "action": "deleted" }).to_string()
        ],
    )
    .expect("seed sparse deleted modification");
    conn.execute(
        "INSERT INTO local_modifications (
          season_id, leg_id, is_base, sort_order, action, payload_json
        ) VALUES (?, ?, 0, 1, 'deleted', ?)",
        params![
            "season-1",
            "leg-3",
            json!({ "action": "deleted" }).to_string()
        ],
    )
    .expect("seed second sparse deleted modification");

    let input = QueryScheduleWindowInput {
        season_id: "season-1".to_string(),
        date_from: None,
        date_to: None,
        flight_number_filter: None,
        route_filter: None,
        type_filter: None,
        status_filter: None,
        limit: Some(50),
        offset: Some(0),
    };
    let result = query_schedule_window_on_connection(&conn, &input).expect("query window");
    let mods_by_id = result
        .modifications
        .iter()
        .map(|modification| {
            (
                modification["legId"]
                    .as_str()
                    .unwrap_or_default()
                    .to_string(),
                modification["action"]
                    .as_str()
                    .unwrap_or_default()
                    .to_string(),
            )
        })
        .collect::<std::collections::HashMap<_, _>>();

    assert_eq!(result.raw_total, 3);
    assert_eq!(result.effective_total, 1);
    assert_eq!(result.total, 1);
    assert_eq!(result.arrival_total, 1);
    assert_eq!(result.departure_total, 0);
    assert_eq!(result.deleted_modification_total, 2);
    assert_eq!(mods_by_id.get("leg-1").map(String::as_str), Some("deleted"));
    assert_eq!(mods_by_id.get("leg-3").map(String::as_str), Some("deleted"));
}

#[test]
fn schedule_window_counts_added_modifications_in_effective_totals() {
    let conn = open_test_db();
    configure_sqlite_connection(&conn).expect("configure sqlite");
    create_minimal_local_schema(&conn);
    seed_flight(&conn);
    conn.execute(
        "INSERT INTO local_modifications (
          season_id, leg_id, is_base, sort_order, action, payload_json
        ) VALUES (?, ?, 0, 0, 'deleted', ?)",
        params![
            "season-1",
            "leg-1",
            json!({ "action": "deleted" }).to_string()
        ],
    )
    .expect("seed sparse deleted modification");
    conn.execute(
        "INSERT INTO local_modifications (
          season_id, leg_id, is_base, sort_order, action, payload_json
        ) VALUES (?, ?, 0, 1, 'added', ?)",
        params![
            "season-1",
            "added-1",
            json!({
                "action": "added",
                "addedLeg": {
                    "id": "added-1",
                    "date": "2026-05-27",
                    "operationalDate": "2026-05-27",
                    "type": "A",
                    "status": "active",
                    "flightNumber": "VN200",
                    "route": "HAN",
                    "schedule": "12:00"
                }
            })
            .to_string()
        ],
    )
    .expect("seed added modification");

    let input = QueryScheduleWindowInput {
        season_id: "season-1".to_string(),
        date_from: None,
        date_to: None,
        flight_number_filter: None,
        route_filter: None,
        type_filter: None,
        status_filter: None,
        limit: Some(50),
        offset: Some(0),
    };
    let result = query_schedule_window_on_connection(&conn, &input).expect("query window");
    let added = result
        .modifications
        .iter()
        .find(|modification| modification["legId"] == "added-1")
        .expect("added modification should be returned");

    assert_eq!(result.raw_total, 1);
    assert_eq!(result.effective_total, 1);
    assert_eq!(result.total, 1);
    assert_eq!(result.arrival_total, 1);
    assert_eq!(result.departure_total, 0);
    assert_eq!(added["action"], "added");
    assert_eq!(added["addedLeg"]["id"], "added-1");
}

#[test]
fn dashboard_summary_uses_effective_modification_totals() {
    let conn = open_test_db();
    configure_sqlite_connection(&conn).expect("configure sqlite");
    create_minimal_local_schema(&conn);
    seed_flight(&conn);
    seed_extra_flight(&conn, "leg-2", "2026-05-27", "A", 2);
    conn.execute(
        "INSERT INTO local_modifications (
          season_id, leg_id, is_base, sort_order, action, payload_json
        ) VALUES (?, ?, 0, 0, 'deleted', ?)",
        params![
            "season-1",
            "leg-1",
            json!({ "action": "deleted" }).to_string()
        ],
    )
    .expect("seed sparse deleted modification");

    let result = seasonal_management_lib::native_catchup::query_dashboard_summary_on_connection(
        &conn,
        &QueryDashboardSummaryInput {
            season_id: "season-1".to_string(),
            date_from: None,
            date_to: None,
        },
    )
    .expect("dashboard summary");

    assert_eq!(result.total_records, 1);
    assert_eq!(result.arrival_records, 1);
    assert_eq!(result.departure_records, 0);
    assert_eq!(result.deleted_records, 1);
}

#[test]
fn schedule_window_query_excludes_other_season_with_same_iata_code() {
    let conn = open_test_db();
    configure_sqlite_connection(&conn).expect("configure sqlite");
    create_minimal_local_schema(&conn);
    seed_flight(&conn);
    conn.execute(
        "INSERT INTO local_seasons (season_id, season_code, data_version, payload_json) VALUES (?, ?, ?, ?)",
        params![
            "season-2",
            "S26",
            1_i64,
            json!({ "id": "season-2", "seasonCode": "S26", "dataVersion": 1 }).to_string()
        ],
    )
    .expect("seed second same-code season");
    let other_record = json!({
        "id": "other-season-leg",
        "date": "2026-05-26",
        "operationalDate": "2026-05-26",
        "iataSeasonCode": "S26",
        "type": "departure",
        "sourceSide": "dep",
        "status": "scheduled",
        "gate": 9,
        "stand": 11,
        "schedule": "11:00"
    });
    for is_base in [0_i64, 1_i64] {
        conn.execute(
            "INSERT INTO local_flight_records (
              season_id, record_id, is_base, sort_order, flight_date, operational_date,
              type, source_side, status, gate, stand, schedule, payload_json
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            params![
                "season-2",
                "other-season-leg",
                is_base,
                0_i64,
                "2026-05-26",
                "2026-05-26",
                "departure",
                "dep",
                "scheduled",
                9_i64,
                11_i64,
                "11:00",
                other_record.to_string()
            ],
        )
        .expect("seed other season flight");
    }

    let input = QueryScheduleWindowInput {
        season_id: "season-1".to_string(),
        date_from: Some("2026-05-26".to_string()),
        date_to: Some("2026-05-26".to_string()),
        flight_number_filter: None,
        route_filter: None,
        type_filter: Some("departure".to_string()),
        status_filter: None,
        limit: Some(50),
        offset: Some(0),
    };
    let result = query_schedule_window_on_connection(&conn, &input).expect("query window");

    assert_eq!(result.records.len(), 1);
    assert_eq!(result.records[0]["id"], "leg-1");
}

#[test]
fn schedule_window_query_repairs_missing_sync_meta_from_existing_season() {
    let conn = open_test_db();
    configure_sqlite_connection(&conn).expect("configure sqlite");
    create_minimal_local_schema(&conn);
    seed_flight(&conn);
    conn.execute(
        "DELETE FROM local_sync_meta WHERE season_id = ?",
        params!["season-1"],
    )
    .expect("delete sync meta");

    let input = QueryScheduleWindowInput {
        season_id: "season-1".to_string(),
        date_from: Some("2026-05-26".to_string()),
        date_to: Some("2026-05-26".to_string()),
        flight_number_filter: None,
        route_filter: None,
        type_filter: None,
        status_filter: None,
        limit: Some(50),
        offset: Some(0),
    };
    let result = query_schedule_window_on_connection(&conn, &input).expect("query window");

    assert_eq!(result.records.len(), 1);
    assert_eq!(result.sync_meta["pendingCount"], 0);
    let stored_count: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM local_sync_meta WHERE season_id = ?",
            params!["season-1"],
            |row| row.get(0),
        )
        .expect("count repaired sync meta");
    assert_eq!(stored_count, 1);
}

#[test]
fn native_schedule_mutation_updates_only_selected_records_and_pending_ops() {
    let conn = open_test_db();
    configure_sqlite_connection(&conn).expect("configure sqlite");
    create_minimal_local_schema(&conn);
    seed_flight(&conn);
    seed_extra_flight(&conn, "leg-2", "2026-05-27", "departure", 2);

    let input = ApplyScheduleMutationInput {
        season_id: "season-1".to_string(),
        records: vec![json!({
            "id": "leg-2",
            "date": "2026-05-27",
            "operationalDate": "2026-05-27",
            "type": "departure",
            "sourceSide": "dep",
            "status": "scheduled",
            "gate": 8,
            "stand": 10,
            "schedule": "12:00"
        })],
        source_rows: vec![],
        mods: vec![],
        deleted_ids: vec![],
        history: Some(ApplyLocalModificationHistoryInput {
            id: "history-record-1".to_string(),
            timestamp: 1_772_000_000_002,
            description: "Edited one detailed flight".to_string(),
            schedule_notification: None,
        }),
    };

    let sync_meta =
        apply_schedule_mutation_to_connection(&conn, &input).expect("apply schedule mutation");
    let changed_payload: String = conn
        .query_row(
            "SELECT payload_json FROM local_flight_records WHERE season_id = ? AND record_id = ? AND is_base = 0",
            params!["season-1", "leg-2"],
            |row| row.get(0),
        )
        .expect("changed record");
    let unchanged_payload: String = conn
        .query_row(
            "SELECT payload_json FROM local_flight_records WHERE season_id = ? AND record_id = ? AND is_base = 0",
            params!["season-1", "leg-1"],
            |row| row.get(0),
        )
        .expect("unchanged record");
    let pending_count: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM local_pending_ops WHERE season_id = ?",
            params!["season-1"],
            |row| row.get(0),
        )
        .expect("pending count");

    assert_eq!(
        serde_json::from_str::<serde_json::Value>(&changed_payload).unwrap()["gate"],
        8
    );
    assert_eq!(
        serde_json::from_str::<serde_json::Value>(&unchanged_payload).unwrap()["gate"],
        1
    );
    assert_eq!(pending_count, 2);
    assert_eq!(sync_meta["pendingCount"], 2);
    assert_eq!(sync_meta["syncStatus"], "dirty");
}

#[test]
fn native_schedule_mutation_ignores_source_rows_and_writes_records_atomically() {
    let conn = open_test_db();
    configure_sqlite_connection(&conn).expect("configure sqlite");
    create_minimal_local_schema(&conn);
    seed_flight(&conn);

    let input = ApplyScheduleMutationInput {
        season_id: "season-1".to_string(),
        source_rows: vec![json!({
            "rowIndex": 2,
            "effective": "27-May-26",
            "discontinue": "27-May-26",
            "airline": "QZ"
        })],
        records: vec![json!({
            "id": "leg-added-1",
            "date": "2026-05-27",
            "operationalDate": "2026-05-27",
            "type": "departure",
            "sourceSide": "dep",
            "sourceRowIndex": 2,
            "sourceKind": "added",
            "status": "scheduled",
            "gate": 3,
            "stand": 7,
            "schedule": "14:00"
        })],
        mods: vec![],
        deleted_ids: vec![],
        history: Some(ApplyLocalModificationHistoryInput {
            id: "history-source-row-1".to_string(),
            timestamp: 1_772_000_000_003,
            description: "Added one seasonal flight".to_string(),
            schedule_notification: None,
        }),
    };

    let sync_meta =
        apply_schedule_mutation_to_connection(&conn, &input).expect("apply source-row mutation");
    let source_row_count: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM local_source_rows WHERE season_id = ? AND row_index = ? AND is_base = 0",
            params!["season-1", 2],
            |row| row.get(0),
        )
        .expect("source row count");
    let added_record_count: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM local_flight_records WHERE season_id = ? AND record_id = ? AND is_base = 0",
            params!["season-1", "leg-added-1"],
            |row| row.get(0),
        )
        .expect("added record count");
    let pending_types: Vec<String> = {
        let mut stmt = conn
            .prepare(
                "SELECT op_type FROM local_pending_ops WHERE season_id = ? ORDER BY sort_order ASC",
            )
            .expect("pending query");
        stmt.query_map(params!["season-1"], |row| row.get::<_, String>(0))
            .expect("pending rows")
            .map(|row| row.expect("pending row"))
            .collect()
    };

    assert_eq!(source_row_count, 0);
    assert_eq!(added_record_count, 1);
    assert_eq!(pending_types, vec!["flightRecord", "modHistory"]);
    assert_eq!(sync_meta["pendingCount"], 2);
    assert_eq!(sync_meta["syncStatus"], "dirty");
}

#[test]
fn native_schedule_mutation_keeps_added_flights_as_canonical_records_for_allocation() {
    let conn = open_test_db();
    configure_sqlite_connection(&conn).expect("configure sqlite");
    create_minimal_local_schema(&conn);
    seed_flight(&conn);

    let input = ApplyScheduleMutationInput {
        season_id: "season-1".to_string(),
        source_rows: vec![],
        records: vec![json!({
            "id": "leg-added-checkin-1",
            "linkId": "L_leg-added-checkin-1",
            "date": "2026-05-27",
            "operationalDate": "2026-05-27",
            "type": "D",
            "airline": "VJ",
            "flightNumber": "VJ827",
            "rawFlightNumber": "827",
            "requestStatusCode": null,
            "route": "DAD-SGN",
            "schedule": "08:00",
            "aircraft": "321",
            "category": "J",
            "flightType": "PAX",
            "codeShares": null,
            "intDomInd": null,
            "pax": null,
            "gate": null,
            "stand": null,
            "counter": null,
            "carousel": null,
            "mct": null,
            "fb": null,
            "lb": null,
            "bhs": null,
            "ghs": null,
            "dayOfWeek": 3,
            "action": null,
            "sourceRowIndex": -1,
            "sourceKind": "added",
            "sourceSide": "DEP",
            "status": "active"
        })],
        mods: vec![],
        deleted_ids: vec![],
        history: Some(ApplyLocalModificationHistoryInput {
            id: "history-canonical-added-1".to_string(),
            timestamp: 1_772_000_000_004,
            description: "Added one detailed flight".to_string(),
            schedule_notification: None,
        }),
    };

    let sync_meta =
        apply_schedule_mutation_to_connection(&conn, &input).expect("apply canonical mutation");
    let added_modification_count: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM local_modifications WHERE season_id = ? AND leg_id = ? AND is_base = 0 AND action = 'added'",
            params!["season-1", "leg-added-checkin-1"],
            |row| row.get(0),
        )
        .expect("added modification count");
    let allocation = query_allocation_window_on_connection(
        &conn,
        &QueryAllocationWindowInput {
            season_id: "season-1".to_string(),
            date_from: Some("2026-05-27".to_string()),
            date_to: Some("2026-05-27".to_string()),
            flight_number_filter: Some("VJ827".to_string()),
            route_filter: None,
            type_filter: None,
            status_filter: None,
            resource_type: Some("checkin".to_string()),
            resource_ids: None,
            limit: Some(100),
            offset: Some(0),
        },
    )
    .expect("query allocation window");

    assert_eq!(added_modification_count, 0);
    assert_eq!(allocation.records.len(), 1);
    assert_eq!(allocation.records[0]["id"], "leg-added-checkin-1");
    assert_eq!(allocation.records[0]["sourceKind"], "added");
    assert_eq!(allocation.records[0]["status"], "active");
    assert!(allocation.modifications.is_empty());
    assert_eq!(sync_meta["pendingCount"], 2);
}

#[test]
fn native_schedule_mutation_preserves_schedule_notification_for_added_pairs() {
    let conn = open_test_db();
    configure_sqlite_connection(&conn).expect("configure sqlite");
    create_minimal_local_schema(&conn);
    seed_flight(&conn);

    let input = ApplyScheduleMutationInput {
        season_id: "season-1".to_string(),
        source_rows: vec![json!({
            "rowIndex": 2,
            "effective": "13-May-26",
            "discontinue": "22-May-26",
            "airline": "BX"
        })],
        records: vec![
            json!({
                "id": "arr-bx-1",
                "date": "2026-05-13",
                "operationalDate": "2026-05-13",
                "type": "A",
                "sourceSide": "ARR",
                "sourceRowIndex": 2,
                "sourceKind": "added",
                "status": "active",
                "turnaroundId": "turn-bx-1",
                "linkedRecordId": "dep-bx-1",
                "schedule": "01:10"
            }),
            json!({
                "id": "dep-bx-1",
                "date": "2026-05-13",
                "operationalDate": "2026-05-13",
                "type": "D",
                "sourceSide": "DEP",
                "sourceRowIndex": 2,
                "sourceKind": "added",
                "status": "active",
                "turnaroundId": "turn-bx-1",
                "linkedRecordId": "arr-bx-1",
                "schedule": "02:05"
            }),
        ],
        mods: vec![],
        deleted_ids: vec![],
        history: Some(ApplyLocalModificationHistoryInput {
            id: "history-added-pair".to_string(),
            timestamp: 1_772_000_000_004,
            description: "Added 2 flight occurrence(s)".to_string(),
            schedule_notification: Some(json!({
                "version": 1,
                "historyEntryId": "history-added-pair",
                "seasonId": "season-1",
                "module": "seasonal",
                "operation": "Added 2 flight occurrence(s)",
                "flights": [
                    { "id": "arr-bx-1", "label": "BX7315", "type": "A", "pairKey": "turnaround:turn-bx-1" },
                    { "id": "dep-bx-1", "label": "BX7316", "type": "D", "pairKey": "turnaround:turn-bx-1" }
                ]
            })),
        }),
    };

    apply_schedule_mutation_to_connection(&conn, &input).expect("apply schedule mutation");
    let history_payload: String = conn
        .query_row(
            "SELECT payload_json FROM local_pending_ops WHERE season_id = ? AND op_key = ?",
            params!["season-1", "modHistory:history-added-pair"],
            |row| row.get(0),
        )
        .expect("history pending op");
    let history_json: serde_json::Value =
        serde_json::from_str(&history_payload).expect("history json");

    assert_eq!(
        history_json["entry"]["scheduleNotification"]["historyEntryId"],
        "history-added-pair"
    );
    assert_eq!(
        history_json["entry"]["scheduleNotification"]["module"],
        "seasonal"
    );
    assert_eq!(
        history_json["entry"]["scheduleNotification"]["flights"]
            .as_array()
            .expect("flights")
            .len(),
        2
    );
}

#[test]
fn native_local_modification_delta_writes_pending_rows_and_preserves_cursor() {
    let conn = open_test_db();
    configure_sqlite_connection(&conn).expect("configure sqlite");
    create_minimal_local_schema(&conn);
    seed_flight(&conn);

    conn.execute(
        "UPDATE local_sync_meta SET last_server_seq = ?, payload_json = ? WHERE season_id = ?",
        params![
            7,
            json!({
                "seasonId": "season-1",
                "baseServerVersion": 1,
                "lastServerSeq": 7,
                "localRevision": 0,
                "pendingCount": 0,
                "lastLocalChangeAt": null,
                "syncStatus": "synced",
                "conflicts": []
            })
            .to_string(),
            "season-1"
        ],
    )
    .expect("update cursor");

    let input = ApplyLocalModificationBatchDeltaInput {
        season_id: "season-1".to_string(),
        mods: vec![json!({
            "legId": "leg-1",
            "action": "modified",
            "gate": 4
        })],
        history: Some(ApplyLocalModificationHistoryInput {
            id: "history-1".to_string(),
            timestamp: 1_772_000_000_000,
            description: "Moved check-in allocation".to_string(),
            schedule_notification: None,
        }),
    };

    let sync_meta =
        apply_local_modification_batch_delta_to_connection(&conn, &input).expect("apply delta");

    let pending_count: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM local_pending_ops WHERE season_id = ?",
            params!["season-1"],
            |row| row.get(0),
        )
        .expect("pending count");
    let modification_payload: String = conn
        .query_row(
            "SELECT payload_json FROM local_pending_ops WHERE season_id = ? AND op_key = ?",
            params!["season-1", "modification:leg-1"],
            |row| row.get(0),
        )
        .expect("modification pending op");
    let history_payload: String = conn
        .query_row(
            "SELECT payload_json FROM local_pending_ops WHERE season_id = ? AND op_key = ?",
            params!["season-1", "modHistory:history-1"],
            |row| row.get(0),
        )
        .expect("history pending op");
    let stored_last_server_seq: i64 = conn
        .query_row(
            "SELECT last_server_seq FROM local_sync_meta WHERE season_id = ?",
            params!["season-1"],
            |row| row.get(0),
        )
        .expect("stored cursor");
    let snapshot_mod_count: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM local_modifications WHERE season_id = ?",
            params!["season-1"],
            |row| row.get(0),
        )
        .expect("snapshot mod count");

    let modification = serde_json::from_str::<serde_json::Value>(&modification_payload).unwrap();
    let history = serde_json::from_str::<serde_json::Value>(&history_payload).unwrap();
    assert_eq!(pending_count, 2);
    assert_eq!(modification.pointer("/mod/gate"), Some(&json!(4)));
    assert_eq!(
        history.pointer("/entry/changes/0/newMod/gate"),
        Some(&json!(4))
    );
    assert_eq!(sync_meta["pendingCount"], 2);
    assert_eq!(sync_meta["syncStatus"], "dirty");
    assert_eq!(sync_meta["lastServerSeq"], 7);
    assert_eq!(stored_last_server_seq, 7);
    assert_eq!(snapshot_mod_count, 1);
}

#[test]
fn native_sync_summary_reports_local_record_and_entity_version_counts() {
    let conn = open_test_db();
    configure_sqlite_connection(&conn).expect("configure sqlite");
    create_minimal_local_schema(&conn);
    seed_flight(&conn);
    conn.execute(
        "INSERT INTO local_entity_versions (season_id, target_type, target_id, server_version) VALUES (?, ?, ?, ?)",
        params!["season-1", "flightRecord", "leg-1", 7_i64],
    )
    .expect("seed entity version");

    let summary = query_sync_summary_on_connection(&conn, "season-1").expect("sync summary");

    assert_eq!(summary.local_record_count, 1);
    assert_eq!(summary.entity_version_count, 1);
}

#[test]
fn native_pending_sync_builds_v2_events_from_sql_pending_ops() {
    let conn = open_test_db();
    configure_sqlite_connection(&conn).expect("configure sqlite");
    create_minimal_local_schema(&conn);
    seed_flight(&conn);
    conn.execute(
        "INSERT INTO local_entity_versions (season_id, target_type, target_id, server_version) VALUES (?, ?, ?, ?)",
        params!["season-1", "modification:leg-1", "gate", 7],
    )
    .expect("seed field version");

    apply_local_modification_batch_delta_to_connection(
        &conn,
        &ApplyLocalModificationBatchDeltaInput {
            season_id: "season-1".to_string(),
            mods: vec![json!({
                "legId": "leg-1",
                "action": "modified",
                "gate": 4
            })],
            history: Some(ApplyLocalModificationHistoryInput {
                id: "history-1".to_string(),
                timestamp: 1_000,
                description: "Changed gate".to_string(),
                schedule_notification: Some(json!({
                    "version": 1,
                    "historyEntryId": "history-1",
                    "seasonId": "season-1",
                    "module": "detailed",
                    "operation": "Changed gate"
                })),
            }),
        },
    )
    .expect("apply local delta");

    let events =
        build_native_pending_change_events(&conn, "season-1", "client-1", 1_234).expect("events");
    let modification_event = events
        .iter()
        .find(|event| {
            event.get("targetType").and_then(|value| value.as_str()) == Some("modification")
        })
        .expect("modification event");
    assert_eq!(modification_event["seasonId"], "season-1");
    assert_eq!(modification_event["clientId"], "client-1");
    assert_eq!(modification_event["targetId"], "leg-1");
    assert_eq!(modification_event["opPayload"]["type"], "modification");
    assert_eq!(modification_event["opPayload"]["mod"]["gate"], 4);
    assert!(modification_event["opId"]
        .as_str()
        .expect("op id")
        .starts_with("client-1:modification:leg-1:"));
    let changed_fields = modification_event["changedFields"]
        .as_array()
        .expect("changed fields")
        .iter()
        .filter_map(|value| value.as_str())
        .collect::<Vec<_>>();
    assert!(changed_fields.contains(&"gate"));
    assert_eq!(
        modification_event["opPayload"]["baseFieldVersions"]["gate"],
        7
    );
    let history_event = events
        .iter()
        .find(|event| {
            event.get("targetType").and_then(|value| value.as_str()) == Some("modHistory")
        })
        .expect("history event");
    assert_eq!(
        history_event["opPayload"]["entry"]["scheduleNotification"]["historyEntryId"],
        "history-1"
    );
    assert_eq!(
        history_event["opPayload"]["entry"]["scheduleNotification"]["module"],
        "detailed"
    );
}

#[test]
fn native_pending_sync_chunks_and_splits_oversized_daily_import_history() {
    let conn = open_test_db();
    configure_sqlite_connection(&conn).expect("configure sqlite");
    create_minimal_local_schema(&conn);
    seed_flight(&conn);
    let records = (0..900).map(daily_import_record).collect::<Vec<_>>();

    apply_schedule_mutation_to_connection(
        &conn,
        &ApplyScheduleMutationInput {
            season_id: "season-1".to_string(),
            records,
            source_rows: vec![],
            mods: vec![],
            deleted_ids: vec![],
            history: Some(ApplyLocalModificationHistoryInput {
                id: "LOCAL_DAILY_IMPORT_W25_BIG".to_string(),
                timestamp: 1_781_619_961_521,
                description: "Daily import: updated 0, inserted 900, deleted 0".to_string(),
                schedule_notification: None,
            }),
        },
    )
    .expect("apply large daily import mutation");

    let chunks = build_native_pending_sync_chunks(&conn, "season-1", "client-1", 1_234)
        .expect("pending chunks");
    assert!(
        chunks.len() > 1,
        "large native pending upload should be chunked"
    );
    assert!(chunks
        .iter()
        .all(|chunk| chunk.len() <= MAX_NATIVE_PENDING_SYNC_CHUNK_EVENTS));
    assert!(chunks.iter().all(
        |chunk| serde_json::to_vec(chunk).unwrap().len() <= MAX_NATIVE_PENDING_SYNC_CHUNK_BYTES
    ));

    let events = chunks.into_iter().flatten().collect::<Vec<_>>();
    let history_events = events
        .iter()
        .filter(|event| {
            event.get("targetType").and_then(|value| value.as_str()) == Some("modHistory")
        })
        .collect::<Vec<_>>();
    assert!(
        history_events.len() > 1,
        "oversized daily import modHistory should split before RPC upload"
    );
    assert!(
        history_events.iter().all(|event| event["targetId"]
            .as_str()
            .is_some_and(|id| id.contains("_PART_"))),
        "split history events should use stable part ids"
    );
    let total_record_changes = history_events
        .iter()
        .map(|event| {
            event["opPayload"]["entry"]["recordChanges"]
                .as_array()
                .map(Vec::len)
                .unwrap_or(0)
        })
        .sum::<usize>();
    assert_eq!(total_record_changes, 900);
    assert!(events
        .iter()
        .any(|event| { event["opPayload"]["record"]["iataSeasonCode"] == "W25" }));
}

#[test]
fn native_pending_sync_splits_existing_oversized_mod_history_pending_op() {
    let conn = open_test_db();
    configure_sqlite_connection(&conn).expect("configure sqlite");
    create_minimal_local_schema(&conn);
    seed_flight(&conn);
    let record_changes = (0..850)
        .map(|index| {
            json!({
                "recordId": format!("DAILY_IMPORT_EXISTING_{index}"),
                "previousRecord": null,
                "newRecord": daily_import_record(index)
            })
        })
        .collect::<Vec<_>>();
    let history_op = json!({
        "type": "modHistory",
        "entry": {
            "id": "LOCAL_DAILY_IMPORT_W25_EXISTING",
            "timestamp": 1_781_619_961_521_i64,
                "description": "Daily import: updated 0, inserted 850, deleted 0",
            "changes": [],
            "recordChanges": record_changes
        }
    });
    conn.execute(
        "INSERT INTO local_pending_ops (season_id, op_key, op_type, sort_order, payload_json) VALUES (?, ?, ?, ?, ?)",
        params![
            "season-1",
            "modHistory:LOCAL_DAILY_IMPORT_W25_EXISTING",
            "modHistory",
            0_i64,
            history_op.to_string()
        ],
    )
    .expect("seed existing oversized history pending op");
    conn.execute(
        "UPDATE local_sync_meta SET pending_count = ?, sync_status = ?, payload_json = ? WHERE season_id = ?",
        params![
            1_i64,
            "dirty",
            json!({
                "seasonId": "season-1",
                "baseServerVersion": 1,
                "lastServerSeq": 10,
                "pendingCount": 1,
                "syncStatus": "dirty",
                "conflicts": []
            })
            .to_string(),
            "season-1"
        ],
    )
    .expect("mark dirty");

    let chunks = build_native_pending_sync_chunks(&conn, "season-1", "client-1", 1_234)
        .expect("pending chunks");
    let history_events = chunks
        .iter()
        .flatten()
        .filter(|event| {
            event.get("targetType").and_then(|value| value.as_str()) == Some("modHistory")
        })
        .collect::<Vec<_>>();

    assert!(
        history_events.len() > 1,
        "existing oversized pending modHistory op must be split during upload"
    );
    assert_eq!(
        history_events
            .iter()
            .map(|event| event["opPayload"]["entry"]["recordChanges"]
                .as_array()
                .map(Vec::len)
                .unwrap_or(0))
            .sum::<usize>(),
        850
    );
}

#[test]
fn native_pending_chunk_upload_retries_unauthorized_once_with_refreshed_token() {
    let chunks = vec![vec![json!({ "opId": "client-1:flightRecord:leg-1:gate" })]];
    let attempts = Arc::new(Mutex::new(Vec::<(String, i64, usize)>::new()));
    let refresh_count = Arc::new(Mutex::new(0_usize));

    let upload_attempts = Arc::clone(&attempts);
    let refresh_attempts = Arc::clone(&refresh_count);
    let result = tauri::async_runtime::block_on(upload_native_pending_chunks_with_retry(
        &chunks,
        10,
        20,
        "expired-token".to_string(),
        move |access_token, chunk, base_server_seq| {
            let upload_attempts = Arc::clone(&upload_attempts);
            async move {
                let attempt_number = {
                    let mut guard = upload_attempts.lock().expect("attempt lock");
                    guard.push((access_token.clone(), base_server_seq, chunk.len()));
                    guard.len()
                };
                if attempt_number == 1 {
                    return Err(NativeHttpError {
                        status_code: Some(401),
                        message: "expired token".to_string(),
                    });
                }
                Ok(NativeSyncPendingRpcResult {
                    applied_events: vec![pending_rpc_event("client-1:flightRecord:leg-1:gate", 11)],
                    conflict_events: Vec::new(),
                    next_server_seq: 11,
                    server_high_water: 11,
                    next_server_version: 21,
                })
            }
        },
        move || {
            let refresh_attempts = Arc::clone(&refresh_attempts);
            async move {
                let mut guard = refresh_attempts.lock().expect("refresh lock");
                *guard += 1;
                Ok("fresh-token".to_string())
            }
        },
    ))
    .expect("401 should retry once with refreshed token");

    assert_eq!(result.applied_events.len(), 1);
    assert_eq!(result.next_server_seq, 11);
    assert_eq!(
        *refresh_count.lock().expect("refresh count"),
        1,
        "401 should request one refreshed token"
    );
    assert_eq!(
        attempts.lock().expect("attempts").as_slice(),
        &[
            ("expired-token".to_string(), 10, 1),
            ("fresh-token".to_string(), 10, 1)
        ]
    );
}

#[test]
fn native_pending_chunk_upload_aggregates_chunk_acks_for_coverage() {
    let chunks = vec![
        vec![json!({ "opId": "client-1:flightRecord:leg-1:gate" })],
        vec![json!({ "opId": "client-1:modification:leg-2:stand" })],
    ];
    let base_seq_attempts = Arc::new(Mutex::new(Vec::<i64>::new()));
    let upload_attempts = Arc::clone(&base_seq_attempts);

    let result = tauri::async_runtime::block_on(upload_native_pending_chunks_with_retry(
        &chunks,
        10,
        20,
        "token".to_string(),
        move |_access_token, chunk, base_server_seq| {
            let upload_attempts = Arc::clone(&upload_attempts);
            async move {
                upload_attempts
                    .lock()
                    .expect("base seq attempts")
                    .push(base_server_seq);
                let op_id = chunk[0]["opId"].as_str().expect("op id").to_string();
                Ok(NativeSyncPendingRpcResult {
                    applied_events: vec![pending_rpc_event(&op_id, base_server_seq + 1)],
                    conflict_events: Vec::new(),
                    next_server_seq: base_server_seq + 1,
                    server_high_water: base_server_seq + 1,
                    next_server_version: 21,
                })
            }
        },
        || async {
            Err(NativeHttpError {
                status_code: Some(401),
                message: "unexpected refresh".to_string(),
            })
        },
    ))
    .expect("chunked upload should aggregate ACKs");

    let pending_events = chunks.into_iter().flatten().collect::<Vec<_>>();
    validate_pending_sync_result_coverage(
        &pending_events,
        &result.applied_events,
        &result.conflict_events,
    )
    .expect("aggregated chunk ACKs should cover all pending opIds");
    assert_eq!(result.applied_events.len(), 2);
    assert_eq!(
        base_seq_attempts
            .lock()
            .expect("base seq attempts")
            .as_slice(),
        &[10, 11],
        "each chunk should use the previous chunk ACK as the next base sequence"
    );
}

#[test]
fn native_pending_chunk_upload_failure_keeps_sqlite_pending_ops() {
    let conn = open_test_db();
    configure_sqlite_connection(&conn).expect("configure sqlite");
    create_minimal_local_schema(&conn);
    seed_flight(&conn);
    let records = (0..75).map(daily_import_record).collect::<Vec<_>>();

    apply_schedule_mutation_to_connection(
        &conn,
        &ApplyScheduleMutationInput {
            season_id: "season-1".to_string(),
            records,
            source_rows: vec![],
            mods: vec![],
            deleted_ids: vec![],
            history: Some(ApplyLocalModificationHistoryInput {
                id: "LOCAL_DAILY_IMPORT_W25_FAIL_MID_CHUNK".to_string(),
                timestamp: 1_781_619_961_521,
                description: "Daily import: updated 0, inserted 75, deleted 0".to_string(),
                schedule_notification: None,
            }),
        },
    )
    .expect("apply daily import mutation");

    let chunks = build_native_pending_sync_chunks(&conn, "season-1", "client-1", 1_234)
        .expect("pending chunks");
    assert!(
        chunks.len() > 1,
        "test requires more than one pending upload chunk"
    );
    let pending_before: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM local_pending_ops WHERE season_id = ?",
            params!["season-1"],
            |row| row.get(0),
        )
        .expect("pending count before");
    let attempt_count = Arc::new(Mutex::new(0_usize));
    let upload_attempts = Arc::clone(&attempt_count);

    let error = tauri::async_runtime::block_on(upload_native_pending_chunks_with_retry(
        &chunks,
        10,
        20,
        "token".to_string(),
        move |_access_token, chunk, base_server_seq| {
            let upload_attempts = Arc::clone(&upload_attempts);
            async move {
                let attempt_number = {
                    let mut guard = upload_attempts.lock().expect("attempt count");
                    *guard += 1;
                    *guard
                };
                if attempt_number == 2 {
                    return Err(NativeHttpError {
                        status_code: Some(500),
                        message: "server failed mid-upload".to_string(),
                    });
                }
                let applied_events = chunk
                    .iter()
                    .enumerate()
                    .map(|(index, event)| {
                        pending_rpc_event(
                            event["opId"].as_str().expect("op id"),
                            base_server_seq + i64::try_from(index).unwrap_or(0) + 1,
                        )
                    })
                    .collect::<Vec<_>>();
                Ok(NativeSyncPendingRpcResult {
                    applied_events,
                    conflict_events: Vec::new(),
                    next_server_seq: base_server_seq + i64::try_from(chunk.len()).unwrap_or(0),
                    server_high_water: base_server_seq + i64::try_from(chunk.len()).unwrap_or(0),
                    next_server_version: 21,
                })
            }
        },
        || async {
            Err(NativeHttpError {
                status_code: Some(401),
                message: "unexpected refresh".to_string(),
            })
        },
    ))
    .expect_err("second chunk failure should stop the upload");
    let pending_after: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM local_pending_ops WHERE season_id = ?",
            params!["season-1"],
            |row| row.get(0),
        )
        .expect("pending count after");

    assert_eq!(error.status_code, Some(500));
    assert_eq!(
        pending_after, pending_before,
        "failed chunk upload must not clear local pending ops before finalize"
    );
}

#[test]
fn native_local_modification_delta_preserves_review_status_without_pending_work() {
    let conn = open_test_db();
    configure_sqlite_connection(&conn).expect("configure sqlite");
    create_minimal_local_schema(&conn);
    seed_flight(&conn);

    conn.execute(
        "UPDATE local_sync_meta SET pending_count = ?, sync_status = ?, payload_json = ? WHERE season_id = ?",
        params![
            0,
            "needs_review",
            json!({
                "seasonId": "season-1",
                "baseServerVersion": 1,
                "lastServerSeq": 3,
                "localRevision": 4,
                "pendingCount": 0,
                "lastLocalChangeAt": null,
                "syncStatus": "needs_review",
                "conflicts": [{ "id": "conflict-1" }]
            })
            .to_string(),
            "season-1"
        ],
    )
    .expect("seed conflict status");

    let input = ApplyLocalModificationBatchDeltaInput {
        season_id: "season-1".to_string(),
        mods: vec![json!({
            "legId": "leg-1",
            "action": "modified",
            "gate": 1
        })],
        history: Some(ApplyLocalModificationHistoryInput {
            id: "history-noop".to_string(),
            timestamp: 1_772_000_000_001,
            description: "No-op allocation".to_string(),
            schedule_notification: None,
        }),
    };

    let sync_meta =
        apply_local_modification_batch_delta_to_connection(&conn, &input).expect("apply delta");
    let pending_count: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM local_pending_ops WHERE season_id = ?",
            params!["season-1"],
            |row| row.get(0),
        )
        .expect("pending count");

    assert_eq!(pending_count, 0);
    assert_eq!(sync_meta["pendingCount"], 0);
    assert_eq!(sync_meta["syncStatus"], "needs_review");
    assert_eq!(sync_meta["conflicts"][0]["id"], "conflict-1");
}

#[test]
fn native_pending_sync_reports_conflict_when_only_review_items_remain() {
    let conn = open_test_db();
    configure_sqlite_connection(&conn).expect("configure sqlite");
    create_minimal_local_schema(&conn);
    seed_flight(&conn);

    conn.execute(
        "UPDATE local_sync_meta SET pending_count = ?, sync_status = ?, payload_json = ? WHERE season_id = ?",
        params![
            0_i64,
            "needs_review",
            json!({
                "seasonId": "season-1",
                "baseServerVersion": 1,
                "lastServerSeq": 4,
                "localRevision": 2,
                "pendingCount": 0,
                "lastLocalChangeAt": null,
                "syncStatus": "needs_review",
                "conflicts": [{
                    "id": "conflict-1",
                    "targetType": "flightRecord",
                    "targetId": "leg-1"
                }]
            })
            .to_string(),
            "season-1"
        ],
    )
    .expect("seed review-only sync meta");

    let result = sync_pending_changes_on_connection(
        &conn,
        &NativeSeasonOnlyInput {
            season_id: "season-1".to_string(),
        },
    )
    .expect("sync pending changes");

    assert_eq!(result.status, "conflict");
    assert_eq!(result.pending_count, 0);
    assert_eq!(result.conflict_count, 1);
    assert!(
        result.message.contains("need review"),
        "message should keep the user on conflict review, got: {}",
        result.message
    );
}

fn seed_flight(conn: &Connection) {
    let season = json!({
        "id": "season-1",
        "seasonCode": "S26",
        "dataVersion": 1
    });
    conn.execute(
        "INSERT INTO local_seasons (season_id, season_code, data_version, payload_json) VALUES (?, ?, ?, ?)",
        params!["season-1", "S26", 1, season.to_string()],
    )
    .expect("seed season");
    let source_row = json!({
        "rowIndex": 1,
        "effective": "26-May-26",
        "discontinue": "26-May-26",
        "airline": "VN"
    });
    for is_base in [0_i64, 1_i64] {
        conn.execute(
            "INSERT INTO local_source_rows (
              season_id, row_index, is_base, sort_order, effective, discontinue, airline, payload_json
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            params![
                "season-1",
                1,
                is_base,
                0,
                "26-May-26",
                "26-May-26",
                "VN",
                source_row.to_string()
            ],
        )
        .expect("seed source row");
    }

    let current = json!({
        "id": "leg-1",
        "date": "2026-05-26",
        "operationalDate": "2026-05-26",
        "type": "departure",
        "sourceSide": "dep",
        "status": "scheduled",
        "gate": 1,
        "stand": 10,
        "schedule": "10:00"
    });
    for is_base in [0_i64, 1_i64] {
        conn.execute(
            "INSERT INTO local_flight_records (
              season_id, record_id, is_base, sort_order, flight_date, operational_date,
              type, source_side, status, gate, stand, schedule, payload_json
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            params![
                "season-1",
                "leg-1",
                is_base,
                0,
                "2026-05-26",
                "2026-05-26",
                "departure",
                "dep",
                "scheduled",
                1,
                10,
                "10:00",
                current.to_string()
            ],
        )
        .expect("seed flight");
    }

    let sync_meta = json!({
        "seasonId": "season-1",
        "baseServerVersion": 1,
        "lastServerSeq": 1,
        "localRevision": 0,
        "pendingCount": 0,
        "lastLocalChangeAt": null,
        "syncStatus": "synced",
        "conflicts": []
    });
    conn.execute(
        "INSERT INTO local_sync_meta (season_id, pending_count, sync_status, last_server_seq, last_local_change_at, payload_json)
         VALUES (?, ?, ?, ?, ?, ?)",
        params!["season-1", 0, "synced", 1, Option::<i64>::None, sync_meta.to_string()],
    )
    .expect("seed sync meta");
}

fn seed_extra_flight(conn: &Connection, record_id: &str, date: &str, flight_type: &str, gate: i64) {
    let record = json!({
        "id": record_id,
        "date": date,
        "operationalDate": date,
        "type": flight_type,
        "sourceSide": "dep",
        "status": "scheduled",
        "gate": gate,
        "stand": 10,
        "schedule": "12:00"
    });
    for is_base in [0_i64, 1_i64] {
        conn.execute(
            "INSERT INTO local_flight_records (
              season_id, record_id, is_base, sort_order, flight_date, operational_date,
              type, source_side, status, gate, stand, schedule, payload_json
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            params![
                "season-1",
                record_id,
                is_base,
                1,
                date,
                date,
                flight_type,
                "dep",
                "scheduled",
                gate,
                10,
                "12:00",
                record.to_string()
            ],
        )
        .expect("seed extra flight");
    }
}

fn seed_flight_with_number(
    conn: &Connection,
    record_id: &str,
    date: &str,
    flight_type: &str,
    flight_number: &str,
    airline: &str,
    sort_order: i64,
) {
    let record = json!({
        "id": record_id,
        "date": date,
        "operationalDate": date,
        "type": flight_type,
        "sourceSide": "dep",
        "status": "scheduled",
        "gate": sort_order,
        "stand": 10,
        "schedule": "12:00",
        "flightNumber": flight_number,
        "airline": airline
    });
    for is_base in [0_i64, 1_i64] {
        conn.execute(
            "INSERT INTO local_flight_records (
              season_id, record_id, is_base, sort_order, flight_date, operational_date,
              type, source_side, status, gate, stand, schedule, payload_json
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            params![
                "season-1",
                record_id,
                is_base,
                sort_order,
                date,
                date,
                flight_type,
                "dep",
                "scheduled",
                sort_order,
                10,
                "12:00",
                record.to_string()
            ],
        )
        .expect("seed numbered flight");
    }
}

#[test]
fn manifest_reconcile_prunes_local_only_records_without_pending_ops() {
    let conn = open_test_db();
    configure_sqlite_connection(&conn).expect("configure sqlite");
    create_minimal_local_schema(&conn);
    seed_flight(&conn);
    seed_extra_flight(&conn, "stale-local-only", "2026-05-27", "arrival", 2);
    seed_extra_flight(&conn, "pending-local-only", "2026-05-28", "arrival", 3);
    conn.execute(
        "INSERT INTO local_modifications (
          season_id, leg_id, is_base, sort_order, action, payload_json
        ) VALUES (?, ?, 0, 0, 'deleted', ?)",
        params![
            "season-1",
            "stale-local-only",
            json!({ "legId": "stale-local-only", "action": "deleted" }).to_string()
        ],
    )
    .expect("seed stale modification");
    conn.execute(
        "INSERT INTO local_entity_versions (season_id, target_type, target_id, server_version)
         VALUES (?, ?, ?, ?)",
        params!["season-1", "flightRecord", "stale-local-only", 7_i64],
    )
    .expect("seed stale entity version");
    conn.execute(
        "INSERT INTO local_pending_ops (season_id, op_key, op_type, sort_order, payload_json)
         VALUES (?, ?, ?, ?, ?)",
        params![
            "season-1",
            "flightRecord:pending-local-only",
            "flightRecord",
            0_i64,
            json!({
                "type": "flightRecord",
                "record": { "id": "pending-local-only" }
            })
            .to_string()
        ],
    )
    .expect("seed pending op");

    let remote_ids = HashSet::from(["leg-1".to_string()]);
    let result = reconcile_flight_record_manifest_on_connection(&conn, "season-1", &remote_ids)
        .expect("reconcile manifest");

    assert_eq!(result.removed_flight_rows, 2);
    assert_eq!(result.removed_modification_rows, 1);
    assert_eq!(result.removed_entity_versions, 1);
    let stale_count: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM local_flight_records WHERE season_id = ? AND record_id = ?",
            params!["season-1", "stale-local-only"],
            |row| row.get(0),
        )
        .expect("stale count");
    let pending_count: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM local_flight_records WHERE season_id = ? AND record_id = ?",
            params!["season-1", "pending-local-only"],
            |row| row.get(0),
        )
        .expect("pending count");
    let local_revision: i64 = conn
        .query_row(
            "SELECT json_extract(payload_json, '$.localRevision') FROM local_sync_meta WHERE season_id = ?",
            params!["season-1"],
            |row| row.get(0),
        )
        .expect("local revision");

    assert_eq!(stale_count, 0);
    assert_eq!(pending_count, 2);
    assert_eq!(local_revision, 1);
}

#[test]
fn manifest_reconcile_does_not_protect_prefix_matched_pending_targets() {
    let conn = open_test_db();
    configure_sqlite_connection(&conn).expect("configure sqlite");
    create_minimal_local_schema(&conn);
    seed_flight(&conn);
    seed_extra_flight(&conn, "leg-10", "2026-05-27", "arrival", 10);
    conn.execute(
        "INSERT INTO local_pending_ops (season_id, op_key, op_type, sort_order, payload_json)
         VALUES (?, ?, ?, ?, ?)",
        params![
            "season-1",
            "modification:leg-10",
            "modification",
            0_i64,
            json!({
                "type": "modification",
                "mod": { "legId": "leg-10", "gate": 10 }
            })
            .to_string()
        ],
    )
    .expect("seed leg-10 pending op");

    let remote_ids = HashSet::new();
    let result = reconcile_flight_record_manifest_on_connection(&conn, "season-1", &remote_ids)
        .expect("reconcile manifest");

    assert_eq!(
        result.removed_record_ids,
        vec!["leg-1".to_string()],
        "pending leg-10 must not protect the stale leg-1 prefix target"
    );
    let leg_1_count: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM local_flight_records WHERE season_id = ? AND record_id = ?",
            params!["season-1", "leg-1"],
            |row| row.get(0),
        )
        .expect("leg-1 count");
    let leg_10_count: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM local_flight_records WHERE season_id = ? AND record_id = ?",
            params!["season-1", "leg-10"],
            |row| row.get(0),
        )
        .expect("leg-10 count");

    assert_eq!(leg_1_count, 0);
    assert_eq!(leg_10_count, 2);
}

#[test]
fn configures_sqlite_for_wal_and_busy_timeout() {
    let conn = open_test_db();

    configure_sqlite_connection(&conn).expect("configure sqlite");

    let journal_mode: String = conn
        .query_row("PRAGMA journal_mode", [], |row| row.get(0))
        .expect("journal mode");
    let busy_timeout: i64 = conn
        .query_row("PRAGMA busy_timeout", [], |row| row.get(0))
        .expect("busy timeout");

    assert_eq!(journal_mode.to_ascii_lowercase(), "wal");
    assert!(busy_timeout >= 5_000);
}

#[test]
fn applies_event_page_as_row_level_delta_and_advances_cursor_after_commit() {
    let conn = open_test_db();
    configure_sqlite_connection(&conn).expect("configure sqlite");
    create_minimal_local_schema(&conn);
    seed_flight(&conn);

    let event = NativeCatchupEvent {
        event_id: "event-2".to_string(),
        season_id: "season-1".to_string(),
        client_id: "remote-client".to_string(),
        op_id: "remote-client:flightRecord:leg-1:gate".to_string(),
        server_seq: 2,
        target_type: "flightRecord".to_string(),
        target_id: "leg-1".to_string(),
        changed_fields: vec!["gate".to_string()],
        op_payload: json!({
            "type": "flightRecord",
            "record": {
                "id": "leg-1",
                "date": "2026-05-26",
                "operationalDate": "2026-05-26",
                "type": "departure",
                "sourceSide": "dep",
                "status": "scheduled",
                "gate": 4,
                "stand": 10,
                "schedule": "10:00"
            }
        }),
        created_at: "2026-05-26T03:00:00Z".to_string(),
    };
    let page = NativeCatchupEventPage {
        season_id: "season-1".to_string(),
        events: vec![event],
        next_cursor: 2,
        has_more: false,
        server_high_water: 2,
    };

    let result = apply_event_page(&conn, &page, "local-client").expect("apply page");

    let current_payload: String = conn
        .query_row(
            "SELECT payload_json FROM local_flight_records WHERE season_id = ? AND record_id = ? AND is_base = 0",
            params!["season-1", "leg-1"],
            |row| row.get(0),
        )
        .expect("current record");
    let base_payload: String = conn
        .query_row(
            "SELECT payload_json FROM local_flight_records WHERE season_id = ? AND record_id = ? AND is_base = 1",
            params!["season-1", "leg-1"],
            |row| row.get(0),
        )
        .expect("base record");
    let last_server_seq: i64 = conn
        .query_row(
            "SELECT last_server_seq FROM local_sync_meta WHERE season_id = ?",
            params!["season-1"],
            |row| row.get(0),
        )
        .expect("last server seq");

    assert_eq!(
        serde_json::from_str::<serde_json::Value>(&current_payload).unwrap()["gate"],
        4
    );
    assert_eq!(
        serde_json::from_str::<serde_json::Value>(&base_payload).unwrap()["gate"],
        4
    );
    assert_eq!(last_server_seq, 2);
    assert_eq!(result.changed_targets, vec!["flightRecord:leg-1"]);
}

#[test]
fn applies_new_flight_record_event_with_identity_even_when_id_is_not_changed() {
    let conn = open_test_db();
    configure_sqlite_connection(&conn).expect("configure sqlite");
    create_minimal_local_schema(&conn);
    seed_flight(&conn);

    let event = NativeCatchupEvent {
        event_id: "event-new-record".to_string(),
        season_id: "season-1".to_string(),
        client_id: "remote-client".to_string(),
        op_id: "remote-client:flightRecord:remote-new-leg:insert".to_string(),
        server_seq: 2,
        target_type: "flightRecord".to_string(),
        target_id: "remote-new-leg".to_string(),
        changed_fields: vec![
            "date".to_string(),
            "operationalDate".to_string(),
            "type".to_string(),
            "sourceSide".to_string(),
            "status".to_string(),
            "schedule".to_string(),
        ],
        op_payload: json!({
            "type": "flightRecord",
            "record": {
                "id": "remote-new-leg",
                "date": "2026-06-01",
                "operationalDate": "2026-06-01",
                "type": "A",
                "sourceSide": "ARR",
                "status": "active",
                "schedule": "10:00",
                "flightNumber": "DV5342",
                "airline": "DV",
                "route": "NQZ"
            }
        }),
        created_at: "2026-05-26T03:00:00Z".to_string(),
    };
    let page = NativeCatchupEventPage {
        season_id: "season-1".to_string(),
        events: vec![event],
        next_cursor: 2,
        has_more: false,
        server_high_water: 2,
    };

    apply_event_page(&conn, &page, "local-client").expect("apply page");

    let current_payload: String = conn
        .query_row(
            "SELECT payload_json FROM local_flight_records WHERE season_id = ? AND record_id = ? AND is_base = 0",
            params!["season-1", "remote-new-leg"],
            |row| row.get(0),
        )
        .expect("current payload");
    let current: serde_json::Value = serde_json::from_str(&current_payload).expect("current json");

    assert_eq!(current["id"], "remote-new-leg");
}

#[test]
fn schedule_window_uses_row_identity_when_payload_id_is_missing() {
    let conn = open_test_db();
    configure_sqlite_connection(&conn).expect("configure sqlite");
    create_minimal_local_schema(&conn);
    seed_flight(&conn);

    let payload_without_id = json!({
        "date": "2026-06-01",
        "operationalDate": "2026-06-01",
        "type": "A",
        "sourceSide": "ARR",
        "status": "active",
        "schedule": "10:00",
        "flightNumber": "DV5342",
        "airline": "DV",
        "route": "NQZ"
    });
    for is_base in [0_i64, 1_i64] {
        conn.execute(
            "INSERT INTO local_flight_records (
              season_id, record_id, is_base, sort_order, flight_date, operational_date,
              type, source_side, status, schedule, payload_json
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            params![
                "season-1",
                "missing-id-leg",
                is_base,
                2_i64,
                "2026-06-01",
                "2026-06-01",
                "A",
                "ARR",
                "active",
                "10:00",
                payload_without_id.to_string()
            ],
        )
        .expect("seed missing id record");
    }
    conn.execute(
        "INSERT INTO local_modifications (
          season_id, leg_id, is_base, sort_order, action, payload_json
        ) VALUES (?, ?, 0, 0, 'deleted', ?)",
        params![
            "season-1",
            "missing-id-leg",
            json!({ "legId": "missing-id-leg", "action": "deleted" }).to_string()
        ],
    )
    .expect("seed deleted modification");

    let result = query_schedule_window_on_connection(
        &conn,
        &QueryScheduleWindowInput {
            season_id: "season-1".to_string(),
            date_from: None,
            date_to: None,
            flight_number_filter: None,
            route_filter: None,
            type_filter: None,
            status_filter: None,
            limit: Some(100),
            offset: Some(0),
        },
    )
    .expect("query schedule window");
    let missing_record = result
        .records
        .iter()
        .find(|record| record.get("id") == Some(&json!("missing-id-leg")))
        .expect("record id fallback");

    assert_eq!(missing_record["id"], "missing-id-leg");
    assert_eq!(result.effective_total, 1);
    assert_eq!(result.deleted_modification_total, 1);
}

#[test]
fn applies_same_client_event_when_local_row_was_not_actually_updated() {
    let conn = open_test_db();
    configure_sqlite_connection(&conn).expect("configure sqlite");
    create_minimal_local_schema(&conn);
    seed_flight(&conn);
    conn.execute(
        "INSERT INTO local_entity_versions (season_id, target_type, target_id, server_version) VALUES (?, ?, ?, ?)",
        params!["season-1", "flightRecord:leg-1", "gate", 2],
    )
    .expect("seed falsely advanced entity version");

    let event = NativeCatchupEvent {
        event_id: "event-2".to_string(),
        season_id: "season-1".to_string(),
        client_id: "local-client".to_string(),
        op_id: "local-client:flightRecord:leg-1:gate".to_string(),
        server_seq: 2,
        target_type: "flightRecord".to_string(),
        target_id: "leg-1".to_string(),
        changed_fields: vec!["gate".to_string()],
        op_payload: json!({
            "type": "flightRecord",
            "record": {
                "id": "leg-1",
                "date": "2026-05-26",
                "operationalDate": "2026-05-26",
                "type": "departure",
                "sourceSide": "dep",
                "status": "scheduled",
                "gate": 4,
                "stand": 10,
                "schedule": "10:00"
            }
        }),
        created_at: "2026-05-26T03:00:00Z".to_string(),
    };
    let page = NativeCatchupEventPage {
        season_id: "season-1".to_string(),
        events: vec![event],
        next_cursor: 2,
        has_more: false,
        server_high_water: 2,
    };

    let result = apply_event_page(&conn, &page, "local-client").expect("apply page");

    let current_payload: String = conn
        .query_row(
            "SELECT payload_json FROM local_flight_records WHERE season_id = ? AND record_id = ? AND is_base = 0",
            params!["season-1", "leg-1"],
            |row| row.get(0),
        )
        .expect("current record");
    assert_eq!(
        serde_json::from_str::<serde_json::Value>(&current_payload).unwrap()["gate"],
        4
    );
    assert_eq!(result.changed_targets, vec!["flightRecord:leg-1"]);
}

#[test]
fn event_replay_ignores_non_added_modification_for_missing_record() {
    let conn = open_test_db();
    configure_sqlite_connection(&conn).expect("configure sqlite");
    create_minimal_local_schema(&conn);
    seed_flight(&conn);

    let event = NativeCatchupEvent {
        event_id: "event-orphan-mod".to_string(),
        season_id: "season-1".to_string(),
        client_id: "remote-client".to_string(),
        op_id: "remote-client:modification:missing-leg:bhs".to_string(),
        server_seq: 7,
        target_type: "modification".to_string(),
        target_id: "missing-leg".to_string(),
        changed_fields: vec!["bhs".to_string()],
        op_payload: json!({
            "type": "modification",
            "mod": {
                "legId": "missing-leg",
                "action": "modified",
                "bhs": "CT02"
            }
        }),
        created_at: "2026-05-26T03:00:00Z".to_string(),
    };
    let page = NativeCatchupEventPage {
        season_id: "season-1".to_string(),
        events: vec![event],
        next_cursor: 7,
        has_more: false,
        server_high_water: 7,
    };

    let result = apply_event_page(&conn, &page, "local-client").expect("apply page");

    let modification_count: i64 = conn
        .query_row(
            "SELECT COUNT(1) FROM local_modifications WHERE season_id = ? AND leg_id = ?",
            params!["season-1", "missing-leg"],
            |row| row.get(0),
        )
        .expect("orphan modification count");
    let entity_version_count: i64 = conn
        .query_row(
            "SELECT COUNT(1) FROM local_entity_versions WHERE season_id = ? AND target_type = ? AND target_id = ?",
            params!["season-1", "modification", "missing-leg"],
            |row| row.get(0),
        )
        .expect("orphan entity version count");
    let last_server_seq: i64 = conn
        .query_row(
            "SELECT last_server_seq FROM local_sync_meta WHERE season_id = ?",
            params!["season-1"],
            |row| row.get(0),
        )
        .expect("last server seq");

    assert_eq!(modification_count, 0);
    assert_eq!(entity_version_count, 0);
    assert_eq!(last_server_seq, 7);
    assert!(result.changed_targets.is_empty());
}

#[test]
fn event_replay_accepts_added_modification_for_missing_record_with_added_leg() {
    let conn = open_test_db();
    configure_sqlite_connection(&conn).expect("configure sqlite");
    create_minimal_local_schema(&conn);
    seed_flight(&conn);

    let event = NativeCatchupEvent {
        event_id: "event-added-mod".to_string(),
        season_id: "season-1".to_string(),
        client_id: "remote-client".to_string(),
        op_id: "remote-client:modification:added-leg-1:added".to_string(),
        server_seq: 7,
        target_type: "modification".to_string(),
        target_id: "added-leg-1".to_string(),
        changed_fields: vec!["addedLeg".to_string(), "action".to_string()],
        op_payload: json!({
            "type": "modification",
            "mod": {
                "legId": "added-leg-1",
                "action": "added",
                "addedLeg": {
                    "id": "added-leg-1",
                    "date": "2026-05-26",
                    "operationalDate": "2026-05-26",
                    "type": "D",
                    "sourceSide": "DEP",
                    "status": "active",
                    "flightNumber": "VN999",
                    "airline": "VN",
                    "route": "DAD-SGN",
                    "schedule": "23:00"
                }
            }
        }),
        created_at: "2026-05-26T03:00:00Z".to_string(),
    };
    let page = NativeCatchupEventPage {
        season_id: "season-1".to_string(),
        events: vec![event],
        next_cursor: 7,
        has_more: false,
        server_high_water: 7,
    };

    let result = apply_event_page(&conn, &page, "local-client").expect("apply page");

    let modification_count: i64 = conn
        .query_row(
            "SELECT COUNT(1) FROM local_modifications WHERE season_id = ? AND leg_id = ?",
            params!["season-1", "added-leg-1"],
            |row| row.get(0),
        )
        .expect("added modification count");
    let window = query_schedule_window_on_connection(
        &conn,
        &QueryScheduleWindowInput {
            season_id: "season-1".to_string(),
            date_from: Some("2026-05-26".to_string()),
            date_to: Some("2026-05-26".to_string()),
            flight_number_filter: Some("VN999".to_string()),
            route_filter: None,
            type_filter: None,
            status_filter: None,
            limit: Some(100),
            offset: Some(0),
        },
    )
    .expect("query added window");

    assert_eq!(modification_count, 2);
    assert_eq!(window.effective_total, 1);
    assert_eq!(window.modifications.len(), 1);
    assert_eq!(result.changed_targets, vec!["modification:added-leg-1"]);
}

#[test]
fn requests_token_refresh_for_unauthorized_rpc_errors_only() {
    assert!(should_request_token_refresh(401));
    assert!(!should_request_token_refresh(403));
    assert!(!should_request_token_refresh(500));
}

#[test]
fn retries_transient_server_rpc_errors_only() {
    assert!(should_request_page_fetch_retry(500));
    assert!(should_request_page_fetch_retry(503));
    assert!(!should_request_page_fetch_retry(401));
    assert!(!should_request_page_fetch_retry(404));
}

#[test]
fn schedules_passive_checkpoint_after_large_committed_batch_windows() {
    assert_eq!(
        checkpoint_mode_for_committed_pages(5, false),
        Some(WalCheckpointMode::Passive)
    );
    assert_eq!(checkpoint_mode_for_committed_pages(5, true), None);
    assert_eq!(checkpoint_mode_for_committed_pages(1, false), None);
}
