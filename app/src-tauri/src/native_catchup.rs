use reqwest::StatusCode;
use rusqlite::{
    params, params_from_iter,
    types::{Value as SqlValue, ValueRef},
    Connection, ErrorCode, OptionalExtension, ToSql,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use std::collections::{HashMap, HashSet};
use std::fmt;
use std::future::Future;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager, State};

const DB_FILE_NAME: &str = "seasonal-management-local.db";
const BUSY_TIMEOUT_MS: i64 = 5_000;
const CHECKPOINT_PAGE_WINDOW: usize = 5;
const TOKEN_REFRESH_TIMEOUT_MS: u64 = 30_000;
const TOKEN_REFRESH_POLL_MS: u64 = 250;
const PAGE_FETCH_RETRY_DELAYS_MS: [u64; 3] = [500, 1_000, 2_000];
const SQLITE_SCHEMA_INIT_RETRY_DELAYS_MS: [u64; 4] = [100, 250, 500, 1_000];
const NOTIFICATION_FLUSH_LIMIT: i64 = 50;
pub const MAX_NATIVE_PENDING_SYNC_CHUNK_EVENTS: usize = 50;
pub const MAX_NATIVE_PENDING_SYNC_CHUNK_BYTES: usize = 900_000;
const MAX_NATIVE_MOD_HISTORY_SYNC_BYTES: usize = 800_000;
const DELETE_FIELD: &str = "__delete__";
const AUTO_REMOTE_WIN_MODIFICATION_FIELDS: [&str; 8] = [
    "counter",
    "checkInStart",
    "checkInEnd",
    "checkInAllocationMode",
    "checkInCounterWindows",
    "gate",
    "stand",
    "bhs",
];
const LOCAL_SEASON_SQL_SCHEMA_VERSION: i64 = 1;

static SQLITE_SCHEMA_INIT_LOCK: Mutex<()> = Mutex::new(());

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum WalCheckpointMode {
    Passive,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RunSeasonCatchupInput {
    pub season_id: String,
    pub supabase_url: String,
    pub anon_key: String,
    pub access_token: String,
    pub client_id: String,
    pub local_cursor: i64,
    pub server_high_water: i64,
    pub page_size: Option<i64>,
    pub cancellation_id: String,
    #[serde(default)]
    pub reconcile_manifest: bool,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RefreshSeasonCatchupTokenInput {
    pub cancellation_id: String,
    pub access_token: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CancelSeasonCatchupInput {
    pub cancellation_id: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApplyLocalModificationHistoryInput {
    pub id: String,
    pub timestamp: i64,
    pub description: String,
    #[serde(default)]
    pub schedule_notification: Option<Value>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApplyLocalModificationBatchDeltaInput {
    pub season_id: String,
    pub mods: Vec<Value>,
    pub history: Option<ApplyLocalModificationHistoryInput>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ApplyLocalModificationBatchDeltaResult {
    pub sync_meta: Value,
    pub affected_ids: Vec<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApplyScheduleMutationInput {
    pub season_id: String,
    #[serde(default)]
    pub records: Vec<Value>,
    #[serde(default)]
    pub source_rows: Vec<Value>,
    #[serde(default)]
    pub mods: Vec<Value>,
    #[serde(default)]
    pub deleted_ids: Vec<String>,
    pub history: Option<ApplyLocalModificationHistoryInput>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ApplyScheduleMutationResult {
    pub sync_meta: Value,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CheckSeasonIntegrityInput {
    pub season_id: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CheckSeasonIntegrityResult {
    pub season_id: String,
    pub ok: bool,
    pub source_rows: i64,
    pub base_source_rows: i64,
    pub records: i64,
    pub base_records: i64,
    pub pending_ops: i64,
    pub pending_count: i64,
    pub sync_status: String,
    pub last_server_seq: Option<i64>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EnsureLocalSeasonInput {
    pub season: Value,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EnsureLocalSeasonResult {
    pub season_id: String,
    pub sync_meta: Value,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportSeasonSnapshotInput {
    pub season: Value,
    #[serde(default)]
    pub source_rows: Vec<Value>,
    #[serde(default)]
    pub records: Vec<Value>,
    #[serde(default)]
    pub modifications: Vec<Value>,
    #[serde(default)]
    pub mod_history: Vec<Value>,
    #[serde(default)]
    pub server_event_high_water: i64,
    #[serde(default)]
    pub entity_versions: Value,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportSeasonSnapshotResult {
    pub season_id: String,
    pub source_rows: usize,
    pub records: usize,
    pub modifications: usize,
    pub mod_history: usize,
    pub last_server_seq: i64,
    pub sync_meta: Value,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QuerySeasonFreshnessInput {
    pub season_id: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QuerySeasonFreshnessResult {
    pub season_id: String,
    pub exists: bool,
    pub local_data_version: Option<i64>,
    pub base_server_version: Option<i64>,
    pub last_server_seq: Option<i64>,
    pub pending_count: i64,
    pub conflict_count: usize,
    pub record_count: i64,
    pub base_record_count: i64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MergeSeasonSnapshotInput {
    pub season: Value,
    #[serde(default)]
    pub source_rows: Vec<Value>,
    #[serde(default)]
    pub records: Vec<Value>,
    #[serde(default)]
    pub modifications: Vec<Value>,
    #[serde(default)]
    pub mod_history: Vec<Value>,
    #[serde(default)]
    pub server_event_high_water: i64,
    #[serde(default)]
    pub entity_versions: Value,
    #[serde(default)]
    pub client_id: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MergeSeasonSnapshotResult {
    pub season_id: String,
    pub source_rows: usize,
    pub records: usize,
    pub modifications: usize,
    pub mod_history: usize,
    pub last_server_seq: i64,
    pub sync_meta: Value,
    pub merged_pending_count: usize,
    pub conflict_count: usize,
    pub conflicts: Vec<Value>,
    pub auto_resolved_conflict_count: usize,
    pub auto_resolved_conflict_ids: Vec<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResolveSeasonConflictInput {
    pub season_id: String,
    pub conflict_id: String,
    pub resolution: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResolveSeasonConflictResult {
    pub season_id: String,
    pub conflict_count: usize,
    pub sync_meta: Value,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QueryScheduleWindowInput {
    pub season_id: String,
    pub date_from: Option<String>,
    pub date_to: Option<String>,
    pub flight_number_filter: Option<String>,
    pub route_filter: Option<String>,
    pub type_filter: Option<String>,
    pub status_filter: Option<String>,
    pub limit: Option<i64>,
    pub offset: Option<i64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QueryScheduleWindowResult {
    pub season_id: String,
    pub records: Vec<Value>,
    pub modifications: Vec<Value>,
    pub total: i64,
    pub raw_total: i64,
    pub effective_total: i64,
    pub arrival_total: i64,
    pub departure_total: i64,
    pub deleted_modification_total: i64,
    pub truncated: bool,
    pub sync_meta: Value,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QueryAllocationWindowInput {
    pub season_id: String,
    pub date_from: Option<String>,
    pub date_to: Option<String>,
    pub flight_number_filter: Option<String>,
    pub route_filter: Option<String>,
    pub type_filter: Option<String>,
    pub status_filter: Option<String>,
    pub resource_type: Option<String>,
    pub resource_ids: Option<Vec<String>>,
    pub limit: Option<i64>,
    pub offset: Option<i64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QueryAllocationWindowResult {
    pub season_id: String,
    pub records: Vec<Value>,
    pub modifications: Vec<Value>,
    pub sync_meta: Value,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QuerySyncSummaryResult {
    pub season_id: String,
    pub pending_count: i64,
    pub conflict_count: usize,
    pub sync_status: String,
    pub last_local_change_at: Option<i64>,
    pub last_server_seq: Option<i64>,
    pub local_revision: i64,
    pub local_record_count: i64,
    pub entity_version_count: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QueryConflictSummaryResult {
    pub season_id: String,
    pub conflict_count: usize,
    pub conflicts: Vec<Value>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QuerySourceRowsWindowInput {
    pub season_id: String,
    pub search: Option<String>,
    pub effective_from: Option<String>,
    pub discontinue_to: Option<String>,
    pub limit: Option<i64>,
    pub offset: Option<i64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QuerySourceRowsWindowResult {
    pub season_id: String,
    pub rows: Vec<Value>,
    pub total: i64,
    pub sync_meta: Value,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QueryDashboardSummaryInput {
    pub season_id: String,
    pub date_from: Option<String>,
    pub date_to: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QueryDashboardSummaryResult {
    pub season_id: String,
    pub total_records: i64,
    pub arrival_records: i64,
    pub departure_records: i64,
    pub deleted_records: i64,
    pub total_pax: i64,
    pub sync_meta: Value,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QueryNativeDashboardAiSqlInput {
    pub sql: String,
    #[serde(default)]
    pub params: Vec<Value>,
    pub limit: Option<i64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QueryNativeDashboardAiSqlResult {
    pub columns: Vec<String>,
    pub rows: Vec<Value>,
    pub row_count: i64,
    pub truncated: bool,
    pub executed_sql_preview: String,
    pub data_quality_notes: Vec<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeSeasonOnlyInput {
    pub season_id: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeSyncPendingChangesInput {
    pub season_id: String,
    pub supabase_url: String,
    pub anon_key: String,
    pub access_token: String,
    pub client_id: String,
    #[serde(default)]
    pub cancellation_id: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiscardSessionEditsResult {
    pub discarded_count: i64,
    pub sync_meta: Value,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeSyncPendingChangesResult {
    pub status: String,
    pub message: String,
    pub pending_count: i64,
    pub conflict_count: usize,
    pub notification_sent: i64,
    pub notification_failed: i64,
    pub notification_skipped: i64,
    pub notification_flush_error: Option<String>,
    pub auto_resolved_conflict_count: usize,
    pub auto_resolved_conflict_ids: Vec<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct NativeNotificationFlushResponse {
    #[serde(default)]
    sent: i64,
    #[serde(default)]
    failed: i64,
    #[serde(default)]
    skipped: i64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeSyncPendingRpcResult {
    #[serde(default, alias = "applied_events")]
    pub applied_events: Vec<NativeCatchupEvent>,
    #[serde(default, alias = "conflict_events")]
    pub conflict_events: Vec<NativeCatchupEvent>,
    #[serde(default, alias = "next_server_seq")]
    pub next_server_seq: i64,
    #[serde(default, alias = "server_high_water")]
    pub server_high_water: i64,
    #[serde(default, alias = "next_server_version")]
    pub next_server_version: i64,
}

#[derive(Debug, Clone)]
pub struct NativeHttpError {
    pub status_code: Option<u16>,
    pub message: String,
}

impl fmt::Display for NativeHttpError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.message)
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeCatchupResult {
    pub season_id: String,
    pub committed_pages: usize,
    pub applied_events: usize,
    pub conflict_count: usize,
    pub changed_targets: Vec<String>,
    pub last_server_seq: i64,
    pub checkpoint_count: usize,
    pub reconciled_flight_rows: usize,
    pub reconciled_modification_rows: usize,
    pub reconciled_entity_versions: usize,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FlightRecordManifestReconcileResult {
    pub removed_flight_rows: usize,
    pub removed_modification_rows: usize,
    pub removed_entity_versions: usize,
    pub removed_record_ids: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeCatchupPageResult {
    pub changed_targets: Vec<String>,
    pub conflict_count: usize,
    pub last_server_seq: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct CatchupProgressEvent {
    season_id: String,
    cancellation_id: String,
    committed_pages: usize,
    applied_events: usize,
    last_server_seq: i64,
    server_high_water: i64,
    changed_targets: Vec<String>,
    checkpoint: Option<WalCheckpointMode>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct TokenRequiredEvent {
    season_id: String,
    cancellation_id: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct CheckpointEvent {
    season_id: String,
    cancellation_id: String,
    mode: WalCheckpointMode,
    committed_pages: usize,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ScheduleMutatedEvent {
    season_id: String,
    revision: i64,
    affected_ids: Vec<String>,
    affected_windows: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct IntegrityFailedEvent {
    season_id: String,
    message: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ConflictUpdatedEvent {
    season_id: String,
    conflict_count: usize,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeCatchupEvent {
    #[serde(alias = "event_id")]
    pub event_id: String,
    #[serde(alias = "season_id")]
    pub season_id: String,
    #[serde(alias = "client_id")]
    pub client_id: String,
    #[serde(alias = "op_id")]
    pub op_id: String,
    #[serde(default, alias = "server_seq")]
    pub server_seq: i64,
    #[serde(alias = "target_type")]
    pub target_type: String,
    #[serde(alias = "target_id")]
    pub target_id: String,
    #[serde(alias = "changed_fields")]
    pub changed_fields: Vec<String>,
    #[serde(alias = "op_payload")]
    pub op_payload: Value,
    #[serde(default, alias = "created_at")]
    pub created_at: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeCatchupEventPage {
    #[serde(default, alias = "season_id")]
    pub season_id: String,
    pub events: Vec<NativeCatchupEvent>,
    #[serde(alias = "next_cursor")]
    pub next_cursor: i64,
    #[serde(alias = "has_more")]
    pub has_more: bool,
    #[serde(alias = "server_high_water")]
    pub server_high_water: i64,
}

#[derive(Debug, Default)]
pub struct NativeCatchupState {
    refreshed_tokens: Mutex<HashMap<String, String>>,
    cancelled: Mutex<HashSet<String>>,
    writer_lock: tokio::sync::Mutex<()>,
}

pub type SharedNativeCatchupState = Arc<NativeCatchupState>;

pub fn create_native_catchup_state() -> SharedNativeCatchupState {
    Arc::new(NativeCatchupState::default())
}

pub fn ensure_native_schema(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute_batch(
        r#"
        CREATE TABLE IF NOT EXISTS local_schema_version (
          id INTEGER PRIMARY KEY CHECK (id = 1),
          version INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS local_seasons (
          season_id TEXT PRIMARY KEY,
          season_code TEXT NOT NULL,
          effective_start TEXT,
          effective_end TEXT,
          data_version INTEGER NOT NULL DEFAULT 0,
          payload_json TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS local_source_rows (
          season_id TEXT NOT NULL,
          row_index INTEGER NOT NULL,
          is_base INTEGER NOT NULL DEFAULT 0,
          sort_order INTEGER NOT NULL,
          effective TEXT,
          discontinue TEXT,
          airline TEXT,
          payload_json TEXT NOT NULL,
          PRIMARY KEY (season_id, row_index, is_base),
          FOREIGN KEY (season_id) REFERENCES local_seasons(season_id) ON DELETE CASCADE
        );
        CREATE TABLE IF NOT EXISTS local_flight_records (
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
          PRIMARY KEY (season_id, record_id, is_base),
          FOREIGN KEY (season_id) REFERENCES local_seasons(season_id) ON DELETE CASCADE
        );
        CREATE TABLE IF NOT EXISTS local_modifications (
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
          PRIMARY KEY (season_id, leg_id, is_base),
          FOREIGN KEY (season_id) REFERENCES local_seasons(season_id) ON DELETE CASCADE
        );
        CREATE TABLE IF NOT EXISTS local_mod_history_entries (
          season_id TEXT NOT NULL,
          history_id TEXT NOT NULL,
          is_base INTEGER NOT NULL DEFAULT 0,
          sort_order INTEGER NOT NULL,
          timestamp INTEGER NOT NULL,
          payload_json TEXT NOT NULL,
          PRIMARY KEY (season_id, history_id, is_base),
          FOREIGN KEY (season_id) REFERENCES local_seasons(season_id) ON DELETE CASCADE
        );
        CREATE TABLE IF NOT EXISTS local_pending_ops (
          season_id TEXT NOT NULL,
          op_key TEXT NOT NULL,
          op_type TEXT NOT NULL,
          sort_order INTEGER NOT NULL,
          payload_json TEXT NOT NULL,
          PRIMARY KEY (season_id, op_key),
          FOREIGN KEY (season_id) REFERENCES local_seasons(season_id) ON DELETE CASCADE
        );
        CREATE TABLE IF NOT EXISTS local_derived_seasonal (
          season_id TEXT PRIMARY KEY,
          payload_json TEXT NOT NULL,
          FOREIGN KEY (season_id) REFERENCES local_seasons(season_id) ON DELETE CASCADE
        );
        CREATE TABLE IF NOT EXISTS local_sync_meta (
          season_id TEXT PRIMARY KEY,
          pending_count INTEGER NOT NULL,
          sync_status TEXT NOT NULL,
          last_server_seq INTEGER,
          last_local_change_at INTEGER,
          payload_json TEXT NOT NULL,
          FOREIGN KEY (season_id) REFERENCES local_seasons(season_id) ON DELETE CASCADE
        );
        CREATE TABLE IF NOT EXISTS local_entity_versions (
          season_id TEXT NOT NULL,
          target_type TEXT NOT NULL,
          target_id TEXT NOT NULL,
          server_version INTEGER NOT NULL,
          PRIMARY KEY (season_id, target_type, target_id),
          FOREIGN KEY (season_id) REFERENCES local_seasons(season_id) ON DELETE CASCADE
        );
        CREATE TABLE IF NOT EXISTS local_kv (
          key TEXT PRIMARY KEY,
          value_json TEXT NOT NULL,
          updated_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_local_flight_records_lookup
          ON local_flight_records (season_id, is_base, flight_date, type, gate, stand);
        CREATE INDEX IF NOT EXISTS idx_local_flight_records_operational_lookup
          ON local_flight_records (season_id, is_base, operational_date, type, status);
        CREATE INDEX IF NOT EXISTS idx_local_modifications_lookup
          ON local_modifications (season_id, is_base, leg_id, action, gate, stand);
        CREATE INDEX IF NOT EXISTS idx_local_pending_ops_type
          ON local_pending_ops (season_id, op_type, sort_order);
        CREATE INDEX IF NOT EXISTS idx_local_entity_versions_target
          ON local_entity_versions (season_id, target_type, target_id);
        "#,
    )?;
    conn.execute(
        r#"INSERT INTO local_schema_version (id, version, updated_at)
           VALUES (1, ?, ?)
           ON CONFLICT(id) DO UPDATE SET
             version = excluded.version,
             updated_at = excluded.updated_at
           WHERE local_schema_version.version <> excluded.version"#,
        params![LOCAL_SEASON_SQL_SCHEMA_VERSION, chrono_like_millis()],
    )?;
    Ok(())
}

pub fn configure_sqlite_connection(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute_batch(&format!(
        "PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = {BUSY_TIMEOUT_MS};"
    ))?;
    Ok(())
}

fn is_sqlite_lock_error(error: &rusqlite::Error) -> bool {
    matches!(
        error,
        rusqlite::Error::SqliteFailure(sqlite_error, _)
            if matches!(
                sqlite_error.code,
                ErrorCode::DatabaseBusy | ErrorCode::DatabaseLocked
            )
    )
}

fn initialize_native_db_connection(conn: &Connection) -> rusqlite::Result<()> {
    let _schema_guard = SQLITE_SCHEMA_INIT_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let mut attempt = 0usize;
    loop {
        match configure_sqlite_connection(conn).and_then(|_| ensure_native_schema(conn)) {
            Ok(()) => return Ok(()),
            Err(error)
                if is_sqlite_lock_error(&error)
                    && attempt < SQLITE_SCHEMA_INIT_RETRY_DELAYS_MS.len() =>
            {
                let delay_ms = SQLITE_SCHEMA_INIT_RETRY_DELAYS_MS[attempt];
                eprintln!(
                    "[native-sqlite] schema init retry after locked database ({delay_ms}ms): {error}"
                );
                std::thread::sleep(Duration::from_millis(delay_ms));
                attempt += 1;
            }
            Err(error) => return Err(error),
        }
    }
}

pub fn should_request_token_refresh(status_code: u16) -> bool {
    status_code == StatusCode::UNAUTHORIZED.as_u16()
}

pub fn should_request_page_fetch_retry(status_code: u16) -> bool {
    (500..=599).contains(&status_code)
}

pub fn checkpoint_mode_for_committed_pages(
    committed_pages: usize,
    active_readers: bool,
) -> Option<WalCheckpointMode> {
    if active_readers || committed_pages == 0 {
        return None;
    }
    if committed_pages % CHECKPOINT_PAGE_WINDOW == 0 {
        Some(WalCheckpointMode::Passive)
    } else {
        None
    }
}

fn run_passive_checkpoint(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute_batch("PRAGMA wal_checkpoint(PASSIVE)")?;
    Ok(())
}

fn pending_op_key(op: &Value) -> String {
    match op.get("type").and_then(Value::as_str).unwrap_or_default() {
        "flightRecord" => format!(
            "flightRecord:{}",
            value_to_string(op.pointer("/record/id")).unwrap_or_default()
        ),
        "sourceRow" => format!(
            "sourceRow:{}",
            value_to_string(op.pointer("/row/rowIndex")).unwrap_or_default()
        ),
        "modification" => format!(
            "modification:{}",
            value_to_string(op.pointer("/mod/legId")).unwrap_or_default()
        ),
        "modificationDelete" => format!(
            "modification:{}",
            value_to_string(op.get("legId")).unwrap_or_default()
        ),
        "modHistory" => format!(
            "modHistory:{}",
            value_to_string(op.pointer("/entry/id")).unwrap_or_default()
        ),
        other => other.to_string(),
    }
}

fn merge_pending_ops(ops: Vec<Value>) -> Vec<Value> {
    let mut order = Vec::new();
    let mut merged = HashMap::new();
    for op in ops {
        let key = pending_op_key(&op);
        if !merged.contains_key(&key) {
            order.push(key.clone());
        }
        merged.insert(key, op);
    }
    order
        .into_iter()
        .filter_map(|key| merged.remove(&key))
        .collect()
}

fn read_pending_ops(conn: &Connection, season_id: &str) -> rusqlite::Result<Vec<Value>> {
    let mut stmt = conn.prepare(
        "SELECT payload_json FROM local_pending_ops WHERE season_id = ? ORDER BY sort_order ASC",
    )?;
    let rows = stmt.query_map(params![season_id], |row| row.get::<_, String>(0))?;
    let mut ops = Vec::new();
    for row in rows {
        if let Ok(payload) = serde_json::from_str::<Value>(&row?) {
            if payload.get("type").and_then(Value::as_str) == Some("sourceRow") {
                continue;
            }
            ops.push(payload);
        }
    }
    Ok(ops)
}

fn sqlite_json_error(message: impl Into<String>) -> rusqlite::Error {
    rusqlite::Error::ToSqlConversionFailure(Box::new(std::io::Error::new(
        std::io::ErrorKind::InvalidData,
        message.into(),
    )))
}

fn json_byte_len(value: &Value) -> usize {
    serde_json::to_vec(value)
        .map(|bytes| bytes.len())
        .unwrap_or(usize::MAX)
}

fn mod_history_entry_with_parts(
    source_entry: &Value,
    id: String,
    description: String,
    changes: Vec<Value>,
    record_changes: Vec<Value>,
) -> Value {
    let mut entry = source_entry.as_object().cloned().unwrap_or_default();
    entry.insert("id".to_string(), Value::String(id));
    entry.insert("description".to_string(), Value::String(description));
    entry.insert("changes".to_string(), Value::Array(changes));
    if record_changes.is_empty() {
        entry.remove("recordChanges");
    } else {
        entry.insert("recordChanges".to_string(), Value::Array(record_changes));
    }
    Value::Object(entry)
}

fn split_mod_history_op_for_sync(op: &Value) -> rusqlite::Result<Vec<Value>> {
    if op.get("type").and_then(Value::as_str) != Some("modHistory") {
        return Ok(vec![op.clone()]);
    }
    if json_byte_len(op) <= MAX_NATIVE_MOD_HISTORY_SYNC_BYTES {
        return Ok(vec![op.clone()]);
    }

    let Some(entry) = op.get("entry") else {
        return Ok(vec![op.clone()]);
    };
    let base_id = value_to_string(entry.get("id")).unwrap_or_else(|| "mod-history".to_string());
    let base_description =
        value_to_string(entry.get("description")).unwrap_or_else(|| base_id.clone());
    let items = entry
        .get("changes")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .map(|value| ("change", value.clone()))
        .chain(
            entry
                .get("recordChanges")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .map(|value| ("recordChange", value.clone())),
        )
        .collect::<Vec<_>>();
    if items.is_empty() {
        return Ok(vec![op.clone()]);
    }

    let mut buckets: Vec<(Vec<Value>, Vec<Value>)> = Vec::new();
    let mut current_changes: Vec<Value> = Vec::new();
    let mut current_record_changes: Vec<Value> = Vec::new();

    for (kind, item) in items {
        let mut candidate_changes = current_changes.clone();
        let mut candidate_record_changes = current_record_changes.clone();
        if kind == "change" {
            candidate_changes.push(item.clone());
        } else {
            candidate_record_changes.push(item.clone());
        }
        let candidate_entry = mod_history_entry_with_parts(
            entry,
            base_id.clone(),
            base_description.clone(),
            candidate_changes.clone(),
            candidate_record_changes.clone(),
        );
        let candidate_op = json!({ "type": "modHistory", "entry": candidate_entry });
        if json_byte_len(&candidate_op) <= MAX_NATIVE_MOD_HISTORY_SYNC_BYTES {
            current_changes = candidate_changes;
            current_record_changes = candidate_record_changes;
            continue;
        }

        if !current_changes.is_empty() || !current_record_changes.is_empty() {
            buckets.push((current_changes, current_record_changes));
        }
        current_changes = if kind == "change" {
            vec![item.clone()]
        } else {
            Vec::new()
        };
        current_record_changes = if kind == "recordChange" {
            vec![item]
        } else {
            Vec::new()
        };
        let single_entry = mod_history_entry_with_parts(
            entry,
            base_id.clone(),
            base_description.clone(),
            current_changes.clone(),
            current_record_changes.clone(),
        );
        let single_op = json!({ "type": "modHistory", "entry": single_entry });
        if json_byte_len(&single_op) > MAX_NATIVE_MOD_HISTORY_SYNC_BYTES {
            return Err(sqlite_json_error(format!(
                "A single modHistory change in {base_id} exceeds the native sync chunk size."
            )));
        }
    }

    if !current_changes.is_empty() || !current_record_changes.is_empty() {
        buckets.push((current_changes, current_record_changes));
    }
    if buckets.len() <= 1 {
        return Ok(vec![op.clone()]);
    }

    let total = buckets.len();
    Ok(buckets
        .into_iter()
        .enumerate()
        .map(|(index, (changes, record_changes))| {
            let part = index + 1;
            let part_id = format!("{base_id}_PART_{part:03}");
            let part_description = format!("{base_description} ({part}/{total})");
            json!({
                "type": "modHistory",
                "entry": mod_history_entry_with_parts(
                    entry,
                    part_id,
                    part_description,
                    changes,
                    record_changes
                )
            })
        })
        .collect())
}

fn expand_pending_ops_for_native_sync(ops: Vec<Value>) -> rusqlite::Result<Vec<Value>> {
    let mut expanded = Vec::new();
    for op in ops {
        expanded.extend(split_mod_history_op_for_sync(&op)?);
    }
    Ok(expanded)
}

fn load_modification_map(
    conn: &Connection,
    season_id: &str,
    is_base: bool,
    leg_ids: &[String],
) -> rusqlite::Result<HashMap<String, Value>> {
    if leg_ids.is_empty() {
        return Ok(HashMap::new());
    }
    let marker = if is_base { 1_i64 } else { 0_i64 };
    let placeholders = vec!["?"; leg_ids.len()].join(", ");
    let sql = format!(
        "SELECT leg_id, action, payload_json FROM local_modifications WHERE season_id = ? AND is_base = ? AND leg_id IN ({placeholders}) ORDER BY sort_order ASC"
    );
    let mut bind_values: Vec<&dyn ToSql> = vec![&season_id, &marker];
    for leg_id in leg_ids {
        bind_values.push(leg_id);
    }
    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt.query_map(bind_values.as_slice(), |row| {
        Ok((
            row.get::<_, String>(0)?,
            row.get::<_, Option<String>>(1)?,
            row.get::<_, String>(2)?,
        ))
    })?;
    let mut map = HashMap::new();
    for row in rows {
        let (leg_id, action, payload) = row?;
        if let Ok(value) = serde_json::from_str::<Value>(&payload) {
            map.insert(
                leg_id.clone(),
                normalize_modification_payload(&leg_id, action.as_deref(), &value),
            );
        }
    }
    Ok(map)
}

fn normalize_modification_payload(leg_id: &str, action: Option<&str>, payload: &Value) -> Value {
    let mut next = if payload.is_object() {
        payload.clone()
    } else {
        json!({})
    };
    let object = next
        .as_object_mut()
        .expect("normalized modification payload is object");
    let missing_leg_id = object
        .get("legId")
        .and_then(Value::as_str)
        .is_none_or(str::is_empty);
    if missing_leg_id {
        object.insert("legId".to_string(), Value::String(leg_id.to_string()));
    }
    let missing_action = object
        .get("action")
        .and_then(Value::as_str)
        .is_none_or(str::is_empty);
    if missing_action {
        object.insert(
            "action".to_string(),
            Value::String(action.unwrap_or("modified").to_string()),
        );
    }
    next
}

fn is_inactive_record(record: &Value) -> bool {
    value_to_string(record.get("status")).is_some_and(|status| {
        matches!(
            status.to_ascii_lowercase().as_str(),
            "deleted" | "cancelled"
        )
    }) || value_to_string(record.get("action"))
        .is_some_and(|action| action.eq_ignore_ascii_case("deleted"))
}

fn modification_action(modification: &Value) -> String {
    value_to_string(modification.get("action"))
        .unwrap_or_default()
        .to_ascii_lowercase()
}

fn is_deleted_modification(modification: &Value) -> bool {
    modification_action(modification) == "deleted"
}

fn is_added_modification(modification: &Value) -> bool {
    modification_action(modification) == "added"
}

fn record_type_code(record: &Value) -> String {
    value_to_string(record.get("type"))
        .unwrap_or_default()
        .to_ascii_lowercase()
}

fn increment_type_count(record: &Value, arrival_total: &mut i64, departure_total: &mut i64) {
    match record_type_code(record).as_str() {
        "a" | "arr" | "arrival" => *arrival_total += 1,
        "d" | "dep" | "departure" => *departure_total += 1,
        _ => {}
    }
}

fn record_operational_date(record: &Value) -> Option<String> {
    value_to_string(
        record
            .get("operationalDate")
            .or_else(|| record.get("operational_date"))
            .or_else(|| record.get("date")),
    )
}

fn comma_filter_terms(value: Option<&str>) -> Vec<String> {
    value
        .unwrap_or_default()
        .split(',')
        .map(|term| term.trim().to_ascii_uppercase())
        .filter(|term| !term.is_empty())
        .collect()
}

fn text_matches_any_filter_term(text: &str, terms: &[String]) -> bool {
    terms.is_empty() || terms.iter().any(|term| text.contains(term))
}

fn record_flight_identity_text(record: &Value) -> String {
    [
        value_to_string(record.get("flightNumber")),
        value_to_string(record.get("rawFlightNumber")),
        value_to_string(record.get("airline")),
    ]
    .into_iter()
    .flatten()
    .collect::<Vec<_>>()
    .join(" ")
    .to_ascii_uppercase()
}

fn record_matches_schedule_window(record: &Value, input: &QueryScheduleWindowInput) -> bool {
    if let Some(date_from) = input.date_from.as_ref() {
        if record_operational_date(record).is_none_or(|date| date < *date_from) {
            return false;
        }
    }
    if let Some(date_to) = input.date_to.as_ref() {
        if record_operational_date(record).is_none_or(|date| date > *date_to) {
            return false;
        }
    }
    let flight_number_terms = comma_filter_terms(input.flight_number_filter.as_deref());
    if !text_matches_any_filter_term(&record_flight_identity_text(record), &flight_number_terms) {
        return false;
    }
    let payload_text = record.to_string().to_ascii_uppercase();
    if let Some(route) = input
        .route_filter
        .as_ref()
        .filter(|value| !value.trim().is_empty())
    {
        if !payload_text.contains(&route.trim().to_ascii_uppercase()) {
            return false;
        }
    }
    if let Some(type_filter) = input.type_filter.as_ref() {
        if value_to_string(record.get("type")).as_deref() != Some(type_filter.as_str()) {
            return false;
        }
    }
    if let Some(status_filter) = input.status_filter.as_ref() {
        if value_to_string(record.get("status")).as_deref() != Some(status_filter.as_str()) {
            return false;
        }
    }
    true
}

fn load_added_modifications_for_window(
    conn: &Connection,
    input: &QueryScheduleWindowInput,
    existing_record_ids: &HashSet<String>,
) -> rusqlite::Result<Vec<Value>> {
    let mut stmt = conn.prepare(
        r#"SELECT leg_id, action, payload_json
           FROM local_modifications
           WHERE season_id = ?
             AND is_base = 0
             AND action = 'added'
           ORDER BY sort_order ASC"#,
    )?;
    let rows = stmt.query_map(params![input.season_id], |row| {
        Ok((
            row.get::<_, String>(0)?,
            row.get::<_, Option<String>>(1)?,
            row.get::<_, String>(2)?,
        ))
    })?;
    let mut modifications = Vec::new();
    for row in rows {
        let (leg_id, action, payload) = row?;
        let Ok(value) = serde_json::from_str::<Value>(&payload) else {
            continue;
        };
        let normalized = normalize_modification_payload(&leg_id, action.as_deref(), &value);
        if !is_added_modification(&normalized) || existing_record_ids.contains(&leg_id) {
            continue;
        }
        let Some(added_leg) = normalized.get("addedLeg") else {
            continue;
        };
        if !is_inactive_record(added_leg) && record_matches_schedule_window(added_leg, input) {
            modifications.push(normalized);
        }
    }
    Ok(modifications)
}

fn load_base_record_map(
    conn: &Connection,
    season_id: &str,
    leg_ids: &[String],
) -> rusqlite::Result<HashMap<String, Value>> {
    load_record_map(conn, season_id, true, leg_ids)
}

fn load_record_map(
    conn: &Connection,
    season_id: &str,
    is_base: bool,
    leg_ids: &[String],
) -> rusqlite::Result<HashMap<String, Value>> {
    if leg_ids.is_empty() {
        return Ok(HashMap::new());
    }
    let marker = if is_base { 1_i64 } else { 0_i64 };
    let placeholders = vec!["?"; leg_ids.len()].join(", ");
    let sql = format!(
        "SELECT record_id, payload_json FROM local_flight_records WHERE season_id = ? AND is_base = ? AND record_id IN ({placeholders}) ORDER BY sort_order ASC"
    );
    let mut bind_values: Vec<&dyn ToSql> = vec![&season_id, &marker];
    for leg_id in leg_ids {
        bind_values.push(leg_id);
    }
    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt.query_map(bind_values.as_slice(), |row| {
        Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
    })?;
    let mut map = HashMap::new();
    for row in rows {
        let (record_id, payload) = row?;
        if let Ok(value) = serde_json::from_str::<Value>(&payload) {
            map.insert(record_id, value);
        }
    }
    Ok(map)
}

fn value_or_null(value: &Value, key: &str) -> Value {
    value.get(key).cloned().unwrap_or(Value::Null)
}

fn stable_value_string(value: &Value) -> String {
    match value {
        Value::Object(map) => {
            let mut entries = map
                .iter()
                .filter(|(_, entry)| !entry.is_null())
                .collect::<Vec<_>>();
            entries.sort_by(|(left, _), (right, _)| left.cmp(right));
            let body = entries
                .into_iter()
                .map(|(key, entry)| format!("{}:{}", json!(key), stable_value_string(entry)))
                .collect::<Vec<_>>()
                .join(",");
            format!("{{{body}}}")
        }
        Value::Array(items) => format!(
            "[{}]",
            items
                .iter()
                .map(stable_value_string)
                .collect::<Vec<_>>()
                .join(",")
        ),
        _ => value.to_string(),
    }
}

fn stable_hash(value: &Value) -> String {
    let input = stable_value_string(value);
    let mut hash: i32 = 0;
    for byte in input.bytes() {
        hash = hash
            .wrapping_shl(5)
            .wrapping_sub(hash)
            .wrapping_add(i32::from(byte));
    }
    i64::from(hash).abs().to_string()
}

fn values_differ(left: Option<&Value>, right: Option<&Value>) -> bool {
    stable_value_string(left.unwrap_or(&Value::Null))
        != stable_value_string(right.unwrap_or(&Value::Null))
}

fn changed_keys(current: &Value, base: Option<&Value>, ignored: &[&str]) -> Vec<String> {
    let ignored = ignored.iter().copied().collect::<HashSet<_>>();
    let mut keys = current
        .as_object()
        .map(|object| object.keys().cloned().collect::<HashSet<_>>())
        .unwrap_or_default();
    if let Some(base_object) = base.and_then(Value::as_object) {
        for key in base_object.keys() {
            keys.insert(key.clone());
        }
    }
    let mut result = keys
        .into_iter()
        .filter(|key| !ignored.contains(key.as_str()))
        .filter(|key| values_differ(current.get(key), base.and_then(|entry| entry.get(key))))
        .collect::<Vec<_>>();
    result.sort();
    result
}

fn is_no_op_modification_against_base_record(
    modification: &Value,
    base_record: Option<&Value>,
) -> bool {
    if value_to_string(modification.get("action")).as_deref() != Some("modified") {
        return false;
    }
    let Some(base_record) = base_record else {
        return false;
    };
    let field_pairs = [
        ("schedule", "schedule"),
        ("aircraft", "aircraft"),
        ("route", "route"),
        ("codeShares", "codeShares"),
        ("pax", "pax"),
        ("gate", "gate"),
        ("stand", "stand"),
        ("counter", "counter"),
        ("checkInStart", "checkInStart"),
        ("checkInEnd", "checkInEnd"),
        ("checkInAllocationMode", "checkInAllocationMode"),
        ("carousel", "carousel"),
        ("mct", "mct"),
        ("fb", "fb"),
        ("lb", "lb"),
        ("bhs", "bhs"),
        ("ghs", "ghs"),
    ];
    field_pairs.iter().all(|(mod_key, record_key)| {
        if modification.get(*mod_key).is_none() {
            return true;
        }
        value_or_null(modification, mod_key) == value_or_null(base_record, record_key)
    })
}

fn merge_modification(previous: Option<&Value>, incoming: &Value) -> Value {
    let mut next = previous.cloned().unwrap_or_else(|| json!({}));
    if !next.is_object() {
        next = json!({});
    }
    if let (Some(next_object), Some(incoming_object)) = (next.as_object_mut(), incoming.as_object())
    {
        for (key, value) in incoming_object {
            next_object.insert(key.clone(), value.clone());
        }
    }
    if let Some(leg_id) = value_to_string(incoming.get("legId")) {
        next["legId"] = Value::String(leg_id);
    }
    if let Some(action) = value_to_string(incoming.get("action")) {
        next["action"] = Value::String(action);
    }
    next
}

fn insert_pending_ops(
    conn: &Connection,
    season_id: &str,
    pending_ops: &[Value],
) -> rusqlite::Result<()> {
    for (index, op) in pending_ops
        .iter()
        .filter(|op| op.get("type").and_then(Value::as_str) != Some("sourceRow"))
        .enumerate()
    {
        conn.execute(
            r#"INSERT INTO local_pending_ops (
              season_id, op_key, op_type, sort_order, payload_json
            ) VALUES (?, ?, ?, ?, ?)"#,
            params![
                season_id,
                pending_op_key(op),
                value_to_string(op.get("type")).unwrap_or_default(),
                i64::try_from(index).unwrap_or(i64::MAX),
                op.to_string(),
            ],
        )?;
    }
    Ok(())
}

fn build_next_local_sync_meta(
    mut sync_meta: Value,
    season: &Value,
    pending_count: usize,
    changed_at: i64,
) -> Value {
    if !sync_meta.is_object() {
        sync_meta = json!({});
    }
    let conflict_count = sync_meta
        .get("conflicts")
        .and_then(Value::as_array)
        .map_or(0, Vec::len);
    sync_meta["seasonId"] = season
        .get("id")
        .cloned()
        .unwrap_or_else(|| Value::String(String::new()));
    sync_meta["baseServerVersion"] =
        sync_meta
            .get("baseServerVersion")
            .cloned()
            .unwrap_or_else(|| {
                season
                    .get("dataVersion")
                    .cloned()
                    .unwrap_or(Value::Number(0.into()))
            });
    sync_meta["localRevision"] = Value::Number(
        (sync_meta
            .get("localRevision")
            .and_then(Value::as_i64)
            .unwrap_or(0)
            + 1)
        .into(),
    );
    sync_meta["pendingCount"] =
        Value::Number(i64::try_from(pending_count).unwrap_or(i64::MAX).into());
    sync_meta["lastLocalChangeAt"] = if pending_count > 0 {
        Value::Number(changed_at.into())
    } else {
        Value::Null
    };
    sync_meta["syncStatus"] = Value::String(
        if conflict_count > 0 {
            if pending_count > 0 {
                "dirty"
            } else {
                "needs_review"
            }
        } else if pending_count > 0 {
            "dirty"
        } else {
            "synced"
        }
        .to_string(),
    );
    sync_meta
}

fn write_local_sync_meta(
    conn: &Connection,
    season_id: &str,
    sync_meta: &Value,
) -> rusqlite::Result<()> {
    conn.execute(
        r#"INSERT INTO local_sync_meta (
          season_id, pending_count, sync_status, last_server_seq, last_local_change_at, payload_json
        ) VALUES (?, ?, ?, ?, ?, ?)"#,
        params![
            season_id,
            sync_meta
                .get("pendingCount")
                .and_then(Value::as_i64)
                .unwrap_or(0),
            sync_meta
                .get("syncStatus")
                .and_then(Value::as_str)
                .unwrap_or("synced"),
            sync_meta.get("lastServerSeq").and_then(Value::as_i64),
            sync_meta.get("lastLocalChangeAt").and_then(Value::as_i64),
            sync_meta.to_string(),
        ],
    )?;
    Ok(())
}

fn count_rows(conn: &Connection, sql: &str, season_id: &str) -> Result<i64, String> {
    conn.query_row(sql, params![season_id], |row| row.get::<_, i64>(0))
        .map_err(|error| format!("SQLite count failed: {error}"))
}

pub fn check_season_integrity_on_connection(
    conn: &Connection,
    input: &CheckSeasonIntegrityInput,
) -> Result<CheckSeasonIntegrityResult, String> {
    let season_exists = conn
        .query_row(
            "SELECT 1 FROM local_seasons WHERE season_id = ?",
            params![input.season_id],
            |_| Ok(()),
        )
        .optional()
        .map_err(|error| format!("Could not validate local_seasons: {error}"))?
        .is_some();
    if !season_exists {
        return Err(format!(
            "Missing local_seasons row for season {}.",
            input.season_id
        ));
    }

    let sync_meta_payload: Option<String> = conn
        .query_row(
            "SELECT payload_json FROM local_sync_meta WHERE season_id = ?",
            params![input.season_id],
            |row| row.get(0),
        )
        .optional()
        .map_err(|error| format!("Could not validate local_sync_meta: {error}"))?;
    let Some(sync_meta_payload) = sync_meta_payload else {
        return Err(format!(
            "Missing local_sync_meta row for season {}.",
            input.season_id
        ));
    };
    let sync_meta = serde_json::from_str::<Value>(&sync_meta_payload)
        .map_err(|error| format!("Invalid local_sync_meta payload: {error}"))?;

    let source_rows = count_rows(
        conn,
        "SELECT COUNT(*) FROM local_source_rows WHERE season_id = ? AND is_base = 0",
        &input.season_id,
    )?;
    let base_source_rows = count_rows(
        conn,
        "SELECT COUNT(*) FROM local_source_rows WHERE season_id = ? AND is_base = 1",
        &input.season_id,
    )?;
    let records = count_rows(
        conn,
        "SELECT COUNT(*) FROM local_flight_records WHERE season_id = ? AND is_base = 0",
        &input.season_id,
    )?;
    let base_records = count_rows(
        conn,
        "SELECT COUNT(*) FROM local_flight_records WHERE season_id = ? AND is_base = 1",
        &input.season_id,
    )?;
    let pending_ops = count_rows(
        conn,
        "SELECT COUNT(*) FROM local_pending_ops WHERE season_id = ? AND op_type <> 'sourceRow'",
        &input.season_id,
    )?;
    let pending_count = sync_meta
        .get("pendingCount")
        .and_then(Value::as_i64)
        .unwrap_or(0);
    let sync_status = sync_meta
        .get("syncStatus")
        .and_then(Value::as_str)
        .unwrap_or("synced")
        .to_string();
    let last_server_seq = sync_meta.get("lastServerSeq").and_then(Value::as_i64);

    if records == 0 && base_records == 0 {
        return Err(format!(
            "Local season {} has no local flight baseline.",
            input.season_id
        ));
    }
    if pending_ops != pending_count {
        return Err(format!(
            "Local season {} pending count mismatch: local_pending_ops={pending_ops}, local_sync_meta.pendingCount={pending_count}.",
            input.season_id
        ));
    }
    if pending_ops == 0 && records != base_records {
        return Err(format!(
            "Local season {} has no pending changes but current/base record counts differ: current={records}, base={base_records}.",
            input.season_id
        ));
    }
    if last_server_seq.is_some_and(|seq| seq < 0) {
        return Err(format!(
            "Local season {} has an invalid negative lastServerSeq.",
            input.season_id
        ));
    }

    Ok(CheckSeasonIntegrityResult {
        season_id: input.season_id.clone(),
        ok: true,
        source_rows,
        base_source_rows,
        records,
        base_records,
        pending_ops,
        pending_count,
        sync_status,
        last_server_seq,
    })
}

fn required_season_string(season: &Map<String, Value>, key: &str) -> Result<String, String> {
    value_to_string(season.get(key))
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .ok_or_else(|| format!("Missing required season.{key} for local season bootstrap."))
}

pub fn ensure_local_season_on_connection(
    conn: &Connection,
    input: &EnsureLocalSeasonInput,
) -> Result<EnsureLocalSeasonResult, String> {
    let season = input
        .season
        .as_object()
        .ok_or_else(|| "Local season bootstrap requires a season object.".to_string())?;
    let season_id = required_season_string(season, "id")?;
    let season_code = required_season_string(season, "seasonCode")?;
    let effective_start = required_season_string(season, "effectiveStart")?;
    let effective_end = required_season_string(season, "effectiveEnd")?;
    let data_version = value_to_i64(season.get("dataVersion")).unwrap_or(0);

    conn.execute_batch("BEGIN IMMEDIATE")
        .map_err(|error| format!("Could not begin local season bootstrap transaction: {error}"))?;
    let result = (|| {
        conn.execute(
            r#"INSERT INTO local_seasons (
                season_id, season_code, effective_start, effective_end, data_version, payload_json
              ) VALUES (?, ?, ?, ?, ?, ?)
              ON CONFLICT(season_id) DO UPDATE SET
                season_code = excluded.season_code,
                effective_start = excluded.effective_start,
                effective_end = excluded.effective_end,
                data_version = excluded.data_version,
                payload_json = excluded.payload_json"#,
            params![
                &season_id,
                &season_code,
                &effective_start,
                &effective_end,
                data_version,
                input.season.to_string()
            ],
        )?;
        let sync_meta = read_sync_meta(conn, &season_id)?;
        Ok::<_, rusqlite::Error>(sync_meta)
    })();

    match result {
        Ok(sync_meta) => {
            conn.execute_batch("COMMIT")
                .map_err(|error| format!("Could not commit local season bootstrap: {error}"))?;
            Ok(EnsureLocalSeasonResult {
                season_id,
                sync_meta,
            })
        }
        Err(error) => {
            let _ = conn.execute_batch("ROLLBACK");
            Err(format!(
                "Could not ensure local season {season_id}: {error}"
            ))
        }
    }
}

fn upsert_local_season_payload(conn: &Connection, season: &Value) -> Result<(String, i64), String> {
    let season_map = season
        .as_object()
        .ok_or_else(|| "Season snapshot import requires a season object.".to_string())?;
    let season_id = required_season_string(season_map, "id")?;
    let season_code = required_season_string(season_map, "seasonCode")?;
    let effective_start = required_season_string(season_map, "effectiveStart")?;
    let effective_end = required_season_string(season_map, "effectiveEnd")?;
    let data_version = value_to_i64(season.get("dataVersion")).unwrap_or(0);
    conn.execute(
        r#"INSERT INTO local_seasons (
            season_id, season_code, effective_start, effective_end, data_version, payload_json
          ) VALUES (?, ?, ?, ?, ?, ?)
          ON CONFLICT(season_id) DO UPDATE SET
            season_code = excluded.season_code,
            effective_start = excluded.effective_start,
            effective_end = excluded.effective_end,
            data_version = excluded.data_version,
            payload_json = excluded.payload_json"#,
        params![
            &season_id,
            &season_code,
            &effective_start,
            &effective_end,
            data_version,
            season.to_string()
        ],
    )
    .map_err(|error| format!("Could not write local season metadata: {error}"))?;
    Ok((season_id, data_version))
}

fn insert_snapshot_flight_records(
    conn: &Connection,
    season_id: &str,
    records: &[Value],
    is_base: bool,
) -> rusqlite::Result<()> {
    let mut stmt = conn.prepare(
        r#"INSERT INTO local_flight_records (
          season_id, record_id, is_base, sort_order, flight_date, operational_date,
          type, source_side, status, turnaround_id, gate, stand, counter_json,
          check_in_start, check_in_end, schedule, payload_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"#,
    )?;
    for (index, record) in records.iter().enumerate() {
        let Some(record_id) = value_to_string(record.get("id")) else {
            continue;
        };
        stmt.execute(params![
            season_id,
            record_id,
            if is_base { 1_i64 } else { 0_i64 },
            i64::try_from(index).unwrap_or(i64::MAX),
            value_to_string(record.get("date")),
            value_to_string(
                record
                    .get("operationalDate")
                    .or_else(|| record.get("operational_date"))
                    .or_else(|| record.get("date"))
            ),
            value_to_string(record.get("type")),
            value_to_string(
                record
                    .get("sourceSide")
                    .or_else(|| record.get("source_side"))
            ),
            value_to_string(record.get("status")),
            value_to_string(
                record
                    .get("turnaroundId")
                    .or_else(|| record.get("turnaround_id"))
            ),
            value_to_i64(record.get("gate")),
            value_to_i64(record.get("stand")),
            value_to_json_string(record.get("counter")),
            value_to_string(
                record
                    .get("checkInStart")
                    .or_else(|| record.get("check_in_start"))
            ),
            value_to_string(
                record
                    .get("checkInEnd")
                    .or_else(|| record.get("check_in_end"))
            ),
            value_to_string(record.get("schedule")),
            record.to_string(),
        ])?;
    }
    Ok(())
}

fn insert_snapshot_modifications(
    conn: &Connection,
    season_id: &str,
    modifications: &[Value],
    is_base: bool,
) -> rusqlite::Result<()> {
    let mut stmt = conn.prepare(
        r#"INSERT INTO local_modifications (
          season_id, leg_id, is_base, sort_order, action, gate, stand, counter_json,
          check_in_start, check_in_end, schedule, payload_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"#,
    )?;
    for (index, modification) in modifications.iter().enumerate() {
        let Some(leg_id) = value_to_string(modification.get("legId")) else {
            continue;
        };
        let action =
            value_to_string(modification.get("action")).unwrap_or_else(|| "modified".to_string());
        let normalized = normalize_modification_payload(&leg_id, Some(&action), modification);
        stmt.execute(params![
            season_id,
            leg_id,
            if is_base { 1_i64 } else { 0_i64 },
            i64::try_from(index).unwrap_or(i64::MAX),
            action,
            value_to_i64(normalized.get("gate")),
            value_to_i64(normalized.get("stand")),
            value_to_json_string(normalized.get("counter")),
            value_to_string(
                normalized
                    .get("checkInStart")
                    .or_else(|| normalized.get("check_in_start"))
            ),
            value_to_string(
                normalized
                    .get("checkInEnd")
                    .or_else(|| normalized.get("check_in_end"))
            ),
            value_to_string(normalized.get("schedule")),
            normalized.to_string(),
        ])?;
    }
    Ok(())
}

fn snapshot_record_ids(records: &[Value]) -> HashSet<String> {
    records
        .iter()
        .filter_map(|record| value_to_string(record.get("id")))
        .collect()
}

fn is_valid_added_modification_payload(leg_id: &str, modification: &Value) -> bool {
    modification_action(modification) == "added"
        && modification
            .get("addedLeg")
            .and_then(|added_leg| value_to_string(added_leg.get("id")))
            .as_deref()
            == Some(leg_id)
}

fn is_valid_snapshot_modification(record_ids: &HashSet<String>, modification: &Value) -> bool {
    let Some(leg_id) = value_to_string(modification.get("legId")) else {
        return false;
    };
    record_ids.contains(&leg_id) || is_valid_added_modification_payload(&leg_id, modification)
}

fn filter_snapshot_modifications(records: &[Value], modifications: &[Value]) -> Vec<Value> {
    let record_ids = snapshot_record_ids(records);
    modifications
        .iter()
        .filter(|modification| is_valid_snapshot_modification(&record_ids, modification))
        .cloned()
        .collect()
}

fn insert_snapshot_mod_history(
    conn: &Connection,
    season_id: &str,
    entries: &[Value],
    is_base: bool,
) -> rusqlite::Result<()> {
    let mut stmt = conn.prepare(
        r#"INSERT INTO local_mod_history_entries (
          season_id, history_id, is_base, sort_order, timestamp, payload_json
        ) VALUES (?, ?, ?, ?, ?, ?)"#,
    )?;
    for (index, entry) in entries.iter().enumerate() {
        let Some(history_id) = value_to_string(entry.get("id")) else {
            continue;
        };
        stmt.execute(params![
            season_id,
            history_id,
            if is_base { 1_i64 } else { 0_i64 },
            i64::try_from(index).unwrap_or(i64::MAX),
            value_to_i64(entry.get("timestamp")).unwrap_or(0),
            entry.to_string(),
        ])?;
    }
    Ok(())
}

fn insert_snapshot_entity_versions(
    conn: &Connection,
    season_id: &str,
    entity_versions: &Value,
) -> rusqlite::Result<()> {
    let Some(targets) = entity_versions.as_object() else {
        return Ok(());
    };
    let mut stmt = conn.prepare(
        r#"INSERT INTO local_entity_versions (
          season_id, target_type, target_id, server_version
        ) VALUES (?, ?, ?, ?)"#,
    )?;
    for (target_type, versions) in targets {
        let Some(fields) = versions.as_object() else {
            continue;
        };
        for (target_id, version) in fields {
            let Some(server_version) = value_to_i64(Some(version)) else {
                continue;
            };
            stmt.execute(params![season_id, target_type, target_id, server_version])?;
        }
    }
    Ok(())
}

fn replace_snapshot_tables_in_transaction(
    conn: &Connection,
    input: &ImportSeasonSnapshotInput,
) -> Result<(String, i64, Vec<Value>), String> {
    let (season_id, data_version) = upsert_local_season_payload(conn, &input.season)?;
    for table in [
        "local_source_rows",
        "local_flight_records",
        "local_modifications",
        "local_mod_history_entries",
        "local_pending_ops",
        "local_derived_seasonal",
        "local_sync_meta",
        "local_entity_versions",
    ] {
        conn.execute(
            &format!("DELETE FROM {table} WHERE season_id = ?"),
            params![&season_id],
        )
        .map_err(|error| format!("Could not clear {table}: {error}"))?;
    }
    insert_snapshot_flight_records(conn, &season_id, &input.records, false)
        .map_err(|error| format!("Could not import current flight records: {error}"))?;
    insert_snapshot_flight_records(conn, &season_id, &input.records, true)
        .map_err(|error| format!("Could not import base flight records: {error}"))?;
    let filtered_modifications =
        filter_snapshot_modifications(&input.records, &input.modifications);
    insert_snapshot_modifications(conn, &season_id, &filtered_modifications, false)
        .map_err(|error| format!("Could not import current modifications: {error}"))?;
    insert_snapshot_modifications(conn, &season_id, &filtered_modifications, true)
        .map_err(|error| format!("Could not import base modifications: {error}"))?;
    insert_snapshot_mod_history(conn, &season_id, &input.mod_history, false)
        .map_err(|error| format!("Could not import current modification history: {error}"))?;
    insert_snapshot_mod_history(conn, &season_id, &input.mod_history, true)
        .map_err(|error| format!("Could not import base modification history: {error}"))?;
    insert_snapshot_entity_versions(conn, &season_id, &input.entity_versions)
        .map_err(|error| format!("Could not import entity versions: {error}"))?;
    conn.execute(
        "INSERT INTO local_derived_seasonal (season_id, payload_json) VALUES (?, ?)",
        params![&season_id, "null"],
    )
    .map_err(|error| format!("Could not reset derived seasonal cache: {error}"))?;
    Ok((season_id, data_version, filtered_modifications))
}

pub fn import_season_snapshot_on_connection(
    conn: &Connection,
    input: &ImportSeasonSnapshotInput,
) -> Result<ImportSeasonSnapshotResult, String> {
    conn.execute_batch("BEGIN IMMEDIATE")
        .map_err(|error| format!("Could not begin native season snapshot import: {error}"))?;
    let result = (|| {
        let (season_id, data_version, filtered_modifications) =
            replace_snapshot_tables_in_transaction(conn, input)?;
        let sync_meta = json!({
            "seasonId": season_id,
            "baseServerVersion": data_version,
            "lastServerSeq": input.server_event_high_water,
            "localRevision": 0,
            "pendingCount": 0,
            "lastLocalChangeAt": null,
            "syncStatus": "synced",
            "conflicts": []
        });
        write_local_sync_meta(conn, &season_id, &sync_meta)
            .map_err(|error| format!("Could not write imported sync metadata: {error}"))?;
        Ok::<_, String>(ImportSeasonSnapshotResult {
            season_id,
            source_rows: 0,
            records: input.records.len(),
            modifications: filtered_modifications.len(),
            mod_history: input.mod_history.len(),
            last_server_seq: input.server_event_high_water,
            sync_meta,
        })
    })();

    match result {
        Ok(imported) => {
            conn.execute_batch("COMMIT").map_err(|error| {
                format!("Could not commit native season snapshot import: {error}")
            })?;
            Ok(imported)
        }
        Err(error) => {
            let _ = conn.execute_batch("ROLLBACK");
            Err(error)
        }
    }
}

pub fn query_season_freshness_on_connection(
    conn: &Connection,
    input: &QuerySeasonFreshnessInput,
) -> Result<QuerySeasonFreshnessResult, String> {
    let season_row = conn
        .query_row(
            "SELECT data_version FROM local_seasons WHERE season_id = ?",
            params![&input.season_id],
            |row| row.get::<_, i64>(0),
        )
        .optional()
        .map_err(|error| format!("Could not read local season freshness: {error}"))?;
    let Some(local_data_version) = season_row else {
        return Ok(QuerySeasonFreshnessResult {
            season_id: input.season_id.clone(),
            exists: false,
            local_data_version: None,
            base_server_version: None,
            last_server_seq: None,
            pending_count: 0,
            conflict_count: 0,
            record_count: 0,
            base_record_count: 0,
        });
    };
    let sync_meta = conn
        .query_row(
            "SELECT payload_json FROM local_sync_meta WHERE season_id = ?",
            params![&input.season_id],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(|error| format!("Could not read local sync freshness: {error}"))?
        .and_then(|payload| serde_json::from_str::<Value>(&payload).ok());
    let pending_count = count_rows(
        conn,
        "SELECT COUNT(*) FROM local_pending_ops WHERE season_id = ? AND op_type <> 'sourceRow'",
        &input.season_id,
    )?;
    let conflict_count = sync_meta
        .as_ref()
        .and_then(|value| value.get("conflicts"))
        .and_then(Value::as_array)
        .map_or(0, Vec::len);
    let record_count = count_rows(
        conn,
        "SELECT COUNT(*) FROM local_flight_records WHERE season_id = ? AND is_base = 0",
        &input.season_id,
    )?;
    let base_record_count = count_rows(
        conn,
        "SELECT COUNT(*) FROM local_flight_records WHERE season_id = ? AND is_base = 1",
        &input.season_id,
    )?;
    Ok(QuerySeasonFreshnessResult {
        season_id: input.season_id.clone(),
        exists: true,
        local_data_version: Some(local_data_version),
        base_server_version: sync_meta
            .as_ref()
            .and_then(|value| value.get("baseServerVersion"))
            .and_then(Value::as_i64),
        last_server_seq: sync_meta
            .as_ref()
            .and_then(|value| value.get("lastServerSeq"))
            .and_then(Value::as_i64),
        pending_count,
        conflict_count,
        record_count,
        base_record_count,
    })
}

fn import_input_from_merge(input: &MergeSeasonSnapshotInput) -> ImportSeasonSnapshotInput {
    ImportSeasonSnapshotInput {
        season: input.season.clone(),
        source_rows: input.source_rows.clone(),
        records: input.records.clone(),
        modifications: input.modifications.clone(),
        mod_history: input.mod_history.clone(),
        server_event_high_water: input.server_event_high_water,
        entity_versions: input.entity_versions.clone(),
    }
}

fn field_server_version(
    conn: &Connection,
    season_id: &str,
    target_type: &str,
    target_id: &str,
    field: &str,
) -> rusqlite::Result<i64> {
    let target_key = format!("{target_type}:{target_id}");
    conn.query_row(
        "SELECT server_version FROM local_entity_versions WHERE season_id = ? AND target_type = ? AND target_id = ?",
        params![season_id, target_key, field],
        |row| row.get::<_, i64>(0),
    )
    .optional()
    .map(|value| value.unwrap_or(0))
}

fn event_base_field_version(event: &NativeCatchupEvent, field: &str) -> i64 {
    event
        .op_payload
        .get("baseFieldVersions")
        .and_then(|value| value.get(field))
        .and_then(Value::as_i64)
        .unwrap_or(0)
}

fn event_payload_for_target(target_type: &str, entity: Value) -> Value {
    match target_type {
        "flightRecord" => json!({ "type": "flightRecord", "record": entity }),
        "sourceRow" => json!({ "type": "sourceRow", "row": entity }),
        "modification" => json!({ "type": "modification", "mod": entity }),
        "modHistory" => json!({ "type": "modHistory", "entry": entity }),
        _ => json!({ "type": "unknown" }),
    }
}

fn snapshot_remote_event_for_pending_event(
    event: &NativeCatchupEvent,
    remote_entity: Option<&Value>,
    fields: &[String],
) -> NativeCatchupEvent {
    NativeCatchupEvent {
        event_id: format!("snapshot-merge:{}", event.op_id),
        season_id: event.season_id.clone(),
        client_id: "server".to_string(),
        op_id: format!("snapshot-merge:{}", event.op_id),
        server_seq: fields
            .iter()
            .filter_map(|field| {
                event
                    .op_payload
                    .get("snapshotFieldVersions")
                    .and_then(|versions| versions.get(field))
                    .and_then(Value::as_i64)
            })
            .max()
            .unwrap_or(0),
        target_type: event.target_type.clone(),
        target_id: event.target_id.clone(),
        changed_fields: fields.to_vec(),
        op_payload: event_payload_for_target(
            &event.target_type,
            remote_entity.cloned().unwrap_or(Value::Null),
        ),
        created_at: chrono_like_millis().to_string(),
    }
}

fn snapshot_conflict_id(event: &NativeCatchupEvent, fields: &[String]) -> String {
    format!(
        "snapshot-merge:{}:{}:{}:{}",
        event.op_id,
        event.target_type,
        event.target_id,
        fields.join(",")
    )
}

fn snapshot_conflict_for_pending_event(
    event: &NativeCatchupEvent,
    remote_entity: Option<&Value>,
    fields: &[String],
) -> Value {
    let remote_event = snapshot_remote_event_for_pending_event(event, remote_entity, fields);
    let local_entity = event_payload_entity(event);
    json!({
        "id": snapshot_conflict_id(event, fields),
        "event": remote_event,
        "targetType": remote_event.target_type,
        "targetId": remote_event.target_id,
        "overlappingFields": fields,
        "localFields": pick_fields(local_entity, fields),
        "remoteFields": pick_fields(remote_entity, fields),
        "createdAt": chrono_like_millis(),
        "message": format!(
            "Remote {} {} changed {} while local edits were pending.",
            event.target_type,
            event.target_id,
            fields.join(", ")
        )
    })
}

fn replay_pending_event_on_snapshot(
    conn: &Connection,
    season_id: &str,
    event: &NativeCatchupEvent,
) -> rusqlite::Result<()> {
    if event.op_payload.get("type").and_then(Value::as_str) == Some("modificationDelete")
        || event
            .changed_fields
            .iter()
            .any(|field| field == DELETE_FIELD)
    {
        if event.target_type == "modification" {
            conn.execute(
                "DELETE FROM local_modifications WHERE season_id = ? AND leg_id = ? AND is_base = 0",
                params![season_id, event.target_id],
            )?;
        }
        return Ok(());
    }

    match event.target_type.as_str() {
        "flightRecord" => {
            let Some(local) = event.op_payload.get("record") else {
                return Ok(());
            };
            let current = read_current_entity(conn, season_id, event)?;
            let merged = merge_changed_fields(current, local, &event.changed_fields);
            upsert_flight_record(conn, season_id, &event.target_id, false, &merged)?;
        }
        "sourceRow" => {
            let Some(local) = event.op_payload.get("row") else {
                return Ok(());
            };
            let row_index = event.target_id.parse::<i64>().unwrap_or_else(|_| {
                value_to_i64(local.get("rowIndex").or_else(|| local.get("row_index"))).unwrap_or(0)
            });
            let current = read_current_entity(conn, season_id, event)?;
            let merged = merge_changed_fields(current, local, &event.changed_fields);
            upsert_source_row(conn, season_id, row_index, false, &merged)?;
        }
        "modification" => {
            let Some(local) = event.op_payload.get("mod") else {
                return Ok(());
            };
            let current = read_current_entity(conn, season_id, event)?;
            let merged = merge_changed_fields(current, local, &event.changed_fields);
            upsert_modification(conn, season_id, &event.target_id, false, &merged)?;
        }
        "modHistory" => {
            if let Some(local) = event.op_payload.get("entry") {
                insert_mod_history(conn, season_id, &event.target_id, false, local)?;
            }
        }
        _ => {}
    }
    Ok(())
}

pub fn merge_season_snapshot_on_connection(
    conn: &Connection,
    input: &MergeSeasonSnapshotInput,
) -> Result<MergeSeasonSnapshotResult, String> {
    let import_input = import_input_from_merge(input);
    let season_map = input
        .season
        .as_object()
        .ok_or_else(|| "Season snapshot merge requires a season object.".to_string())?;
    let season_id = required_season_string(season_map, "id")?;

    conn.execute_batch("BEGIN IMMEDIATE")
        .map_err(|error| format!("Could not begin native season snapshot merge: {error}"))?;
    let result = (|| {
        let previous_sync_meta = read_sync_meta(conn, &season_id)
            .map_err(|error| format!("Could not read previous sync metadata: {error}"))?;
        let previous_revision = previous_sync_meta
            .get("localRevision")
            .and_then(Value::as_i64)
            .unwrap_or(0);
        let previous_last_local_change_at = previous_sync_meta
            .get("lastLocalChangeAt")
            .and_then(Value::as_i64);
        let previous_client_id = previous_sync_meta.get("clientId").cloned();
        let pending_ops = read_pending_ops(conn, &season_id)
            .map_err(|error| format!("Could not read pending operations: {error}"))?;
        let client_id = input
            .client_id
            .clone()
            .or_else(|| {
                previous_client_id
                    .as_ref()
                    .and_then(Value::as_str)
                    .map(str::to_string)
            })
            .unwrap_or_else(|| "native-snapshot-merge".to_string());
        let pending_events =
            build_native_pending_change_events(conn, &season_id, &client_id, chrono_like_millis())
                .map_err(|error| {
                    format!("Could not build pending events for snapshot merge: {error}")
                })?;

        let (written_season_id, data_version, filtered_modifications) =
            replace_snapshot_tables_in_transaction(conn, &import_input)?;
        insert_pending_ops(conn, &written_season_id, &pending_ops).map_err(|error| {
            format!("Could not restore pending operations after snapshot merge: {error}")
        })?;

        let mut next_sync_meta = previous_sync_meta.clone();
        if !next_sync_meta.is_object() {
            next_sync_meta = json!({});
        }
        if let Some(object) = next_sync_meta.as_object_mut() {
            object.insert("seasonId".to_string(), json!(written_season_id));
            object.insert("baseServerVersion".to_string(), json!(data_version));
            object.insert(
                "lastServerSeq".to_string(),
                json!(input.server_event_high_water),
            );
            object.insert("localRevision".to_string(), json!(previous_revision + 1));
            object.insert("pendingCount".to_string(), json!(pending_ops.len()));
            object.insert(
                "lastLocalChangeAt".to_string(),
                previous_last_local_change_at
                    .map(Value::from)
                    .unwrap_or(Value::Null),
            );
            object
                .entry("conflicts".to_string())
                .or_insert_with(|| Value::Array(Vec::new()));
            if let Some(client_id_value) = previous_client_id.or_else(|| Some(json!(client_id))) {
                object.insert("clientId".to_string(), client_id_value);
            }
        }

        let mut auto_resolved_conflict_ids = Vec::new();
        for event_value in &pending_events {
            let Some(mut event) = native_event_from_pending_value(event_value) else {
                continue;
            };
            let mut overlapping_fields = Vec::new();
            let mut snapshot_versions = Map::new();
            for field in &event.changed_fields {
                let remote_version = field_server_version(
                    conn,
                    &written_season_id,
                    &event.target_type,
                    &event.target_id,
                    field,
                )
                .map_err(|error| format!("Could not read snapshot field version: {error}"))?;
                snapshot_versions.insert(field.clone(), json!(remote_version));
                if remote_version > event_base_field_version(&event, field) {
                    overlapping_fields.push(field.clone());
                }
            }
            if let Some(object) = event.op_payload.as_object_mut() {
                object.insert(
                    "snapshotFieldVersions".to_string(),
                    Value::Object(snapshot_versions),
                );
            }
            if !overlapping_fields.is_empty() {
                let remote_entity = read_current_entity(conn, &written_season_id, &event)
                    .map_err(|error| format!("Could not read snapshot conflict entity: {error}"))?;
                let remote_event = snapshot_remote_event_for_pending_event(
                    &event,
                    remote_entity.as_ref(),
                    &overlapping_fields,
                );
                if is_auto_remote_latest_conflict_event(&remote_event) {
                    apply_event_data(conn, &written_season_id, &remote_event).map_err(|error| {
                        format!("Could not apply auto-resolved snapshot conflict: {error}")
                    })?;
                    update_entity_versions(conn, &written_season_id, &remote_event).map_err(
                        |error| {
                            format!("Could not update auto-resolved snapshot versions: {error}")
                        },
                    )?;
                    remove_pending_ops_for_conflict_target(
                        conn,
                        &written_season_id,
                        &event.target_type,
                        &event.target_id,
                    )
                    .map_err(|error| {
                        format!("Could not clear auto-resolved pending operation: {error}")
                    })?;
                    auto_resolved_conflict_ids
                        .push(snapshot_conflict_id(&event, &overlapping_fields));
                    continue;
                }
                let conflict = snapshot_conflict_for_pending_event(
                    &event,
                    remote_entity.as_ref(),
                    &overlapping_fields,
                );
                append_conflict(&mut next_sync_meta, conflict);
            }
            replay_pending_event_on_snapshot(conn, &written_season_id, &event).map_err(
                |error| format!("Could not replay pending operation on snapshot: {error}"),
            )?;
        }

        let pending_count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM local_pending_ops WHERE season_id = ? AND op_type <> 'sourceRow'",
                params![written_season_id],
                |row| row.get(0),
            )
            .map_err(|error| format!("Could not count pending operations after snapshot merge: {error}"))?;
        next_sync_meta["pendingCount"] = json!(pending_count);
        next_sync_meta["autoResolvedConflictCount"] = json!(auto_resolved_conflict_ids.len());
        next_sync_meta["autoResolvedConflictIds"] = json!(auto_resolved_conflict_ids.clone());
        let conflict_count = next_sync_meta
            .get("conflicts")
            .and_then(Value::as_array)
            .map_or(0, Vec::len);
        next_sync_meta["syncStatus"] = Value::String(
            if conflict_count > 0 {
                "needs_review"
            } else if pending_count == 0 {
                "synced"
            } else {
                "dirty"
            }
            .to_string(),
        );
        write_local_sync_meta(conn, &written_season_id, &next_sync_meta)
            .map_err(|error| format!("Could not write merged sync metadata: {error}"))?;
        let conflicts = next_sync_meta
            .get("conflicts")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        Ok::<_, String>(MergeSeasonSnapshotResult {
            season_id: written_season_id,
            source_rows: 0,
            records: input.records.len(),
            modifications: filtered_modifications.len(),
            mod_history: input.mod_history.len(),
            last_server_seq: input.server_event_high_water,
            sync_meta: next_sync_meta,
            merged_pending_count: pending_count as usize,
            conflict_count,
            conflicts,
            auto_resolved_conflict_count: auto_resolved_conflict_ids.len(),
            auto_resolved_conflict_ids,
        })
    })();

    match result {
        Ok(merged) => {
            conn.execute_batch("COMMIT").map_err(|error| {
                format!("Could not commit native season snapshot merge: {error}")
            })?;
            Ok(merged)
        }
        Err(error) => {
            let _ = conn.execute_batch("ROLLBACK");
            Err(error)
        }
    }
}

fn remove_pending_ops_for_conflict_target(
    conn: &Connection,
    season_id: &str,
    target_type: &str,
    target_id: &str,
) -> rusqlite::Result<()> {
    let op_key = match target_type {
        "flightRecord" => format!("flightRecord:{target_id}"),
        "sourceRow" => format!("sourceRow:{target_id}"),
        "modification" => format!("modification:{target_id}"),
        "modHistory" => format!("modHistory:{target_id}"),
        _ => String::new(),
    };
    if !op_key.is_empty() {
        conn.execute(
            "DELETE FROM local_pending_ops WHERE season_id = ? AND op_key = ?",
            params![season_id, op_key],
        )?;
    }
    remove_related_mod_history_pending_ops(conn, season_id, target_type, target_id)?;
    Ok(())
}

fn push_string_target(targets: &mut HashSet<String>, value: Option<&Value>) {
    if let Some(target) = value.and_then(Value::as_str) {
        if !target.is_empty() {
            targets.insert(target.to_string());
        }
    }
}

fn mod_history_pending_op_targets(
    payload_json: &str,
) -> rusqlite::Result<(Option<String>, HashSet<String>)> {
    let payload = match serde_json::from_str::<Value>(payload_json) {
        Ok(payload) => payload,
        Err(_) => return Ok((None, HashSet::new())),
    };
    let entry = payload.get("entry").unwrap_or(&Value::Null);
    let history_id = entry.get("id").and_then(Value::as_str).map(str::to_string);
    let mut targets = HashSet::new();
    if let Some(changes) = entry.get("changes").and_then(Value::as_array) {
        for change in changes {
            push_string_target(&mut targets, change.get("legId"));
            push_string_target(&mut targets, change.pointer("/previousMod/legId"));
            push_string_target(&mut targets, change.pointer("/newMod/legId"));
        }
    }
    if let Some(record_changes) = entry.get("recordChanges").and_then(Value::as_array) {
        for change in record_changes {
            push_string_target(&mut targets, change.get("recordId"));
            push_string_target(&mut targets, change.pointer("/previousRecord/id"));
            push_string_target(&mut targets, change.pointer("/newRecord/id"));
        }
    }
    Ok((history_id, targets))
}

fn remove_related_mod_history_pending_ops(
    conn: &Connection,
    season_id: &str,
    target_type: &str,
    target_id: &str,
) -> rusqlite::Result<()> {
    let mut stmt = conn.prepare(
        "SELECT rowid, payload_json FROM local_pending_ops WHERE season_id = ? AND op_type = 'modHistory'",
    )?;
    let rows = stmt.query_map(params![season_id], |row| {
        Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?))
    })?;
    let mut rowids_to_delete = Vec::new();
    for row in rows {
        let (rowid, payload_json) = row?;
        let (history_id, targets) = mod_history_pending_op_targets(&payload_json)?;
        let should_delete = if target_type == "modHistory" {
            history_id.as_deref() == Some(target_id)
        } else {
            !targets.is_empty() && targets.iter().all(|target| target == target_id)
        };
        if should_delete {
            rowids_to_delete.push(rowid);
        }
    }
    for rowid in rowids_to_delete {
        conn.execute(
            "DELETE FROM local_pending_ops WHERE rowid = ?",
            params![rowid],
        )?;
    }
    Ok(())
}

pub fn resolve_season_conflict_on_connection(
    conn: &Connection,
    input: &ResolveSeasonConflictInput,
) -> Result<ResolveSeasonConflictResult, String> {
    if input.resolution != "keepMine" && input.resolution != "acceptRemote" {
        return Err(format!(
            "Unsupported native conflict resolution '{}'.",
            input.resolution
        ));
    }
    conn.execute_batch("BEGIN IMMEDIATE")
        .map_err(|error| format!("Could not begin native conflict resolution: {error}"))?;
    let result = (|| {
        let mut sync_meta = read_sync_meta(conn, &input.season_id)
            .map_err(|error| format!("Could not read conflict sync metadata: {error}"))?;
        let conflicts = sync_meta
            .get("conflicts")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        let Some(conflict) = conflicts
            .iter()
            .find(|entry| {
                entry.get("id").and_then(Value::as_str) == Some(input.conflict_id.as_str())
            })
            .cloned()
        else {
            return Err(format!(
                "Native conflict {} was not found.",
                input.conflict_id
            ));
        };

        if input.resolution == "acceptRemote" {
            let event_value = conflict.get("event").cloned().ok_or_else(|| {
                format!("Native conflict {} has no remote event.", input.conflict_id)
            })?;
            let event = serde_json::from_value::<NativeCatchupEvent>(event_value)
                .map_err(|error| format!("Native conflict event is invalid: {error}"))?;
            apply_event_data(conn, &input.season_id, &event)
                .map_err(|error| format!("Could not apply remote conflict event: {error}"))?;
            update_entity_versions(conn, &input.season_id, &event)
                .map_err(|error| format!("Could not update remote conflict versions: {error}"))?;
            remove_pending_ops_for_conflict_target(
                conn,
                &input.season_id,
                &event.target_type,
                &event.target_id,
            )
            .map_err(|error| {
                format!("Could not rebuild pending state after conflict resolution: {error}")
            })?;
        }

        let remaining_conflicts = conflicts
            .into_iter()
            .filter(|entry| {
                entry.get("id").and_then(Value::as_str) != Some(input.conflict_id.as_str())
            })
            .collect::<Vec<_>>();
        sync_meta["conflicts"] = Value::Array(remaining_conflicts);
        let last_server_seq = sync_meta
            .get("lastServerSeq")
            .and_then(Value::as_i64)
            .unwrap_or(0);
        conn.execute(
            "DELETE FROM local_sync_meta WHERE season_id = ?",
            params![&input.season_id],
        )
        .map_err(|error| format!("Could not clear old sync metadata: {error}"))?;
        let conflict_count = write_sync_meta(conn, &input.season_id, sync_meta, last_server_seq)
            .map_err(|error| format!("Could not write resolved sync metadata: {error}"))?;
        let next_sync_meta = read_sync_meta(conn, &input.season_id)
            .map_err(|error| format!("Could not read resolved sync metadata: {error}"))?;
        conn.execute(
            "DELETE FROM local_derived_seasonal WHERE season_id = ?",
            params![&input.season_id],
        )
        .map_err(|error| {
            format!("Could not clear derived cache after conflict resolution: {error}")
        })?;
        conn.execute(
            "INSERT INTO local_derived_seasonal (season_id, payload_json) VALUES (?, ?)",
            params![&input.season_id, "null"],
        )
        .map_err(|error| {
            format!("Could not reset derived cache after conflict resolution: {error}")
        })?;
        Ok::<_, String>(ResolveSeasonConflictResult {
            season_id: input.season_id.clone(),
            conflict_count,
            sync_meta: next_sync_meta,
        })
    })();

    match result {
        Ok(resolved) => {
            conn.execute_batch("COMMIT")
                .map_err(|error| format!("Could not commit native conflict resolution: {error}"))?;
            Ok(resolved)
        }
        Err(error) => {
            let _ = conn.execute_batch("ROLLBACK");
            Err(error)
        }
    }
}

pub fn query_schedule_window_on_connection(
    conn: &Connection,
    input: &QueryScheduleWindowInput,
) -> rusqlite::Result<QueryScheduleWindowResult> {
    let limit = input.limit.unwrap_or(1_000).clamp(1, 100_000);
    let offset = input.offset.unwrap_or(0).max(0);
    let flight_number_terms = comma_filter_terms(input.flight_number_filter.as_deref());
    let mut sql = String::from(
        r#"SELECT record_id, payload_json
           FROM local_flight_records
           WHERE season_id = ?
             AND is_base = 0"#,
    );
    let mut sql_params = vec![SqlValue::Text(input.season_id.clone())];
    if let Some(date_from) = input
        .date_from
        .as_ref()
        .filter(|value| !value.trim().is_empty())
    {
        sql.push_str(" AND operational_date >= ?");
        sql_params.push(SqlValue::Text(date_from.clone()));
    }
    if let Some(date_to) = input
        .date_to
        .as_ref()
        .filter(|value| !value.trim().is_empty())
    {
        sql.push_str(" AND operational_date <= ?");
        sql_params.push(SqlValue::Text(date_to.clone()));
    }
    if !flight_number_terms.is_empty() {
        sql.push_str(" AND (");
        for (index, term) in flight_number_terms.iter().enumerate() {
            if index > 0 {
                sql.push_str(" OR ");
            }
            sql.push_str(
                "upper(
                  coalesce(json_extract(payload_json, '$.flightNumber'), '') || ' ' ||
                  coalesce(json_extract(payload_json, '$.rawFlightNumber'), '') || ' ' ||
                  coalesce(json_extract(payload_json, '$.airline'), '')
                ) LIKE ?",
            );
            sql_params.push(SqlValue::Text(format!("%{}%", term)));
        }
        sql.push(')');
    }
    if let Some(route) = input
        .route_filter
        .as_ref()
        .filter(|value| !value.trim().is_empty())
    {
        sql.push_str(" AND upper(payload_json) LIKE ?");
        sql_params.push(SqlValue::Text(format!(
            "%{}%",
            route.trim().to_ascii_uppercase()
        )));
    }
    if let Some(type_filter) = input.type_filter.as_ref() {
        sql.push_str(" AND type = ?");
        sql_params.push(SqlValue::Text(type_filter.clone()));
    }
    if let Some(status_filter) = input.status_filter.as_ref() {
        sql.push_str(" AND status = ?");
        sql_params.push(SqlValue::Text(status_filter.clone()));
    }
    sql.push_str(" ORDER BY operational_date ASC, schedule ASC, sort_order ASC");
    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt.query_map(params_from_iter(sql_params.iter()), |row| {
        Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
    })?;
    let mut all_records = Vec::new();
    let mut all_record_ids = Vec::new();
    for row in rows {
        let (record_id, payload_json) = row?;
        if let Ok(record) = serde_json::from_str::<Value>(&payload_json) {
            let normalized = normalize_flight_record_payload(&record_id, &record);
            all_record_ids.push(record_id);
            all_records.push(normalized);
        }
    }
    all_record_ids.sort();
    all_record_ids.dedup();
    let existing_record_ids = all_record_ids.iter().cloned().collect::<HashSet<_>>();
    let all_modifications = load_modification_map(conn, &input.season_id, false, &all_record_ids)?;
    let added_modifications =
        load_added_modifications_for_window(conn, input, &existing_record_ids)?;

    let raw_total = i64::try_from(all_records.len()).unwrap_or(i64::MAX);
    let mut effective_total = 0_i64;
    let mut arrival_total = 0_i64;
    let mut departure_total = 0_i64;
    let mut deleted_modification_total = 0_i64;
    for record in &all_records {
        if is_inactive_record(record) {
            continue;
        }
        let id = value_to_string(record.get("id")).unwrap_or_default();
        if all_modifications
            .get(&id)
            .is_some_and(is_deleted_modification)
        {
            deleted_modification_total += 1;
            continue;
        }
        effective_total += 1;
        increment_type_count(record, &mut arrival_total, &mut departure_total);
    }
    for modification in &added_modifications {
        let Some(added_leg) = modification.get("addedLeg") else {
            continue;
        };
        effective_total += 1;
        increment_type_count(added_leg, &mut arrival_total, &mut departure_total);
    }

    let records = all_records
        .iter()
        .skip(usize::try_from(offset).unwrap_or(0))
        .take(usize::try_from(limit).unwrap_or(usize::MAX))
        .cloned()
        .collect::<Vec<_>>();
    let mut page_record_ids = records
        .iter()
        .filter_map(|record| value_to_string(record.get("id")))
        .collect::<Vec<_>>();
    page_record_ids.sort();
    page_record_ids.dedup();
    let page_record_id_set = page_record_ids.iter().cloned().collect::<HashSet<_>>();
    let mut modifications = all_modifications
        .into_iter()
        .filter(|(leg_id, _)| page_record_id_set.contains(leg_id))
        .map(|(_, modification)| modification)
        .chain(added_modifications)
        .collect::<Vec<_>>();
    modifications.sort_by(|left, right| {
        value_to_string(left.get("legId"))
            .unwrap_or_default()
            .cmp(&value_to_string(right.get("legId")).unwrap_or_default())
    });
    let sync_meta = read_sync_meta(conn, &input.season_id)?;
    Ok(QueryScheduleWindowResult {
        season_id: input.season_id.clone(),
        records,
        modifications,
        total: effective_total,
        raw_total,
        effective_total,
        arrival_total,
        departure_total,
        deleted_modification_total,
        truncated: offset + limit < raw_total,
        sync_meta,
    })
}

fn allocation_record_matches(
    record: &Value,
    resource_type: &str,
    resource_ids: &HashSet<String>,
) -> bool {
    if resource_ids.is_empty() {
        return true;
    }
    match resource_type {
        "gate" => {
            value_to_string(record.get("gate")).is_some_and(|value| resource_ids.contains(&value))
        }
        "stand" => {
            value_to_string(record.get("stand")).is_some_and(|value| resource_ids.contains(&value))
        }
        "counter" | "checkin" | "check-in" => record
            .get("counter")
            .and_then(Value::as_array)
            .is_some_and(|values| {
                values.iter().any(|value| {
                    value_to_string(Some(value)).is_some_and(|next| resource_ids.contains(&next))
                })
            }),
        _ => true,
    }
}

pub fn query_allocation_window_on_connection(
    conn: &Connection,
    input: &QueryAllocationWindowInput,
) -> rusqlite::Result<QueryAllocationWindowResult> {
    let schedule = query_schedule_window_on_connection(
        conn,
        &QueryScheduleWindowInput {
            season_id: input.season_id.clone(),
            date_from: input.date_from.clone(),
            date_to: input.date_to.clone(),
            flight_number_filter: input.flight_number_filter.clone(),
            route_filter: input.route_filter.clone(),
            type_filter: input.type_filter.clone(),
            status_filter: input.status_filter.clone(),
            limit: input.limit,
            offset: input.offset,
        },
    )?;
    let resource_type = input
        .resource_type
        .as_deref()
        .unwrap_or_default()
        .to_ascii_lowercase();
    let resource_ids = input
        .resource_ids
        .clone()
        .unwrap_or_default()
        .into_iter()
        .collect::<HashSet<_>>();
    let (records, modifications) = if resource_type.is_empty() || resource_ids.is_empty() {
        (schedule.records, schedule.modifications)
    } else {
        let records = schedule
            .records
            .into_iter()
            .filter(|record| allocation_record_matches(record, &resource_type, &resource_ids))
            .collect::<Vec<_>>();
        let record_ids = records
            .iter()
            .filter_map(|record| value_to_string(record.get("id")))
            .collect::<HashSet<_>>();
        let modifications = schedule
            .modifications
            .into_iter()
            .filter(|modification| {
                value_to_string(modification.get("legId"))
                    .is_some_and(|leg_id| record_ids.contains(&leg_id))
            })
            .collect::<Vec<_>>();
        (records, modifications)
    };
    Ok(QueryAllocationWindowResult {
        season_id: input.season_id.clone(),
        records,
        modifications,
        sync_meta: schedule.sync_meta,
    })
}

pub fn query_sync_summary_on_connection(
    conn: &Connection,
    season_id: &str,
) -> rusqlite::Result<QuerySyncSummaryResult> {
    let sync_meta = read_sync_meta(conn, season_id)?;
    let conflicts = sync_meta
        .get("conflicts")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let pending_count = conn.query_row(
        "SELECT COUNT(*) FROM local_pending_ops WHERE season_id = ? AND op_type <> 'sourceRow'",
        params![season_id],
        |row| row.get::<_, i64>(0),
    )?;
    let local_record_count = conn.query_row(
        "SELECT COUNT(*) FROM local_flight_records WHERE season_id = ? AND is_base = 0",
        params![season_id],
        |row| row.get::<_, i64>(0),
    )?;
    let entity_version_count = conn.query_row(
        "SELECT COUNT(*) FROM local_entity_versions WHERE season_id = ?",
        params![season_id],
        |row| row.get::<_, i64>(0),
    )?;
    let sync_status = if !conflicts.is_empty() {
        "needs_review".to_string()
    } else if pending_count > 0 {
        "dirty".to_string()
    } else {
        "synced".to_string()
    };
    Ok(QuerySyncSummaryResult {
        season_id: season_id.to_string(),
        pending_count,
        conflict_count: conflicts.len(),
        sync_status,
        last_local_change_at: if pending_count > 0 {
            sync_meta.get("lastLocalChangeAt").and_then(Value::as_i64)
        } else {
            None
        },
        last_server_seq: sync_meta.get("lastServerSeq").and_then(Value::as_i64),
        local_revision: sync_meta
            .get("localRevision")
            .and_then(Value::as_i64)
            .unwrap_or(0),
        local_record_count,
        entity_version_count,
    })
}

pub fn query_conflict_summary_on_connection(
    conn: &Connection,
    season_id: &str,
) -> rusqlite::Result<QueryConflictSummaryResult> {
    let sync_meta = read_sync_meta(conn, season_id)?;
    let conflicts = sync_meta
        .get("conflicts")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    Ok(QueryConflictSummaryResult {
        season_id: season_id.to_string(),
        conflict_count: conflicts.len(),
        conflicts,
    })
}

pub fn query_source_rows_window_on_connection(
    conn: &Connection,
    input: &QuerySourceRowsWindowInput,
) -> rusqlite::Result<QuerySourceRowsWindowResult> {
    let sync_meta = read_sync_meta(conn, &input.season_id)?;
    Ok(QuerySourceRowsWindowResult {
        season_id: input.season_id.clone(),
        rows: Vec::new(),
        total: 0,
        sync_meta,
    })
}

pub fn query_dashboard_summary_on_connection(
    conn: &Connection,
    input: &QueryDashboardSummaryInput,
) -> rusqlite::Result<QueryDashboardSummaryResult> {
    let schedule = query_schedule_window_on_connection(
        conn,
        &QueryScheduleWindowInput {
            season_id: input.season_id.clone(),
            date_from: input.date_from.clone(),
            date_to: input.date_to.clone(),
            flight_number_filter: None,
            route_filter: None,
            type_filter: None,
            status_filter: None,
            limit: Some(100_000),
            offset: Some(0),
        },
    )?;
    let modifications = schedule
        .modifications
        .iter()
        .filter_map(|modification| {
            value_to_string(modification.get("legId")).map(|leg_id| (leg_id, modification))
        })
        .collect::<HashMap<_, _>>();
    let record_ids = schedule
        .records
        .iter()
        .filter_map(|record| value_to_string(record.get("id")))
        .collect::<HashSet<_>>();
    let mut total_pax = 0_i64;
    for record in &schedule.records {
        if is_inactive_record(record) {
            continue;
        }
        let id = value_to_string(record.get("id")).unwrap_or_default();
        if modifications
            .get(&id)
            .is_some_and(|modification| is_deleted_modification(modification))
        {
            continue;
        }
        let effective = modifications.get(&id).copied().unwrap_or(record);
        total_pax += value_to_i64(effective.get("pax"))
            .or_else(|| value_to_i64(effective.get("arrPax")))
            .or_else(|| value_to_i64(effective.get("depPax")))
            .unwrap_or(0);
    }
    for modification in &schedule.modifications {
        if !is_added_modification(modification) {
            continue;
        }
        let Some(added_leg) = modification.get("addedLeg") else {
            continue;
        };
        let added_id = value_to_string(added_leg.get("id")).unwrap_or_default();
        if record_ids.contains(&added_id) {
            continue;
        }
        total_pax += value_to_i64(added_leg.get("pax"))
            .or_else(|| value_to_i64(added_leg.get("arrPax")))
            .or_else(|| value_to_i64(added_leg.get("depPax")))
            .unwrap_or(0);
    }
    Ok(QueryDashboardSummaryResult {
        season_id: input.season_id.clone(),
        total_records: schedule.effective_total,
        arrival_records: schedule.arrival_total,
        departure_records: schedule.departure_total,
        deleted_records: schedule.deleted_modification_total,
        total_pax,
        sync_meta: schedule.sync_meta,
    })
}

pub fn query_dashboard_ai_sql_on_connection(
    conn: &Connection,
    input: &QueryNativeDashboardAiSqlInput,
) -> rusqlite::Result<QueryNativeDashboardAiSqlResult> {
    let limit = input.limit.unwrap_or(500).clamp(1, 500);
    let sql = normalize_dashboard_ai_sql(&input.sql, limit);
    validate_dashboard_ai_sql(&sql)?;
    ensure_dashboard_ai_flight_operations_view(conn)?;
    let sql_params = input
        .params
        .iter()
        .map(json_value_to_sql_value)
        .collect::<Vec<_>>();
    let mut stmt = conn.prepare(&sql)?;
    let columns = stmt
        .column_names()
        .iter()
        .map(|name| name.to_string())
        .collect::<Vec<_>>();
    let mut rows = stmt.query(params_from_iter(sql_params.iter()))?;
    let mut parsed_rows = Vec::new();
    while let Some(row) = rows.next()? {
        if parsed_rows.len() >= limit as usize {
            break;
        }
        let mut item = Map::new();
        for (index, column) in columns.iter().enumerate() {
            item.insert(column.clone(), sqlite_value_to_json(row.get_ref(index)?));
        }
        parsed_rows.push(Value::Object(item));
    }
    let truncated = parsed_rows.len() >= limit as usize;
    Ok(QueryNativeDashboardAiSqlResult {
        columns,
        row_count: parsed_rows.len() as i64,
        rows: parsed_rows,
        truncated,
        executed_sql_preview: sql.chars().take(1_000).collect(),
        data_quality_notes: vec![
            "Nguồn: SQLite local qua validated SELECT gateway.".to_string(),
            "Chỉ SELECT/CTE read-only trên dashboard_ai_flight_operations được phép.".to_string(),
        ],
    })
}

fn ensure_dashboard_ai_flight_operations_view(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute_batch(
        r#"
        DROP VIEW IF EXISTS dashboard_ai_flight_operations;
        CREATE TEMP VIEW dashboard_ai_flight_operations AS
        SELECT
          lfr.season_id AS season_id,
          COALESCE(
            json_extract(ls.payload_json, '$.seasonCode'),
            json_extract(ls.payload_json, '$.season_code'),
            json_extract(lfr.payload_json, '$.iataSeasonCode'),
            lfr.season_id
          ) AS season,
          COALESCE(json_extract(lfr.payload_json, '$.iataSeasonCode'), json_extract(ls.payload_json, '$.seasonCode')) AS iata_season_code,
          lfr.record_id AS record_id,
          COALESCE(lfr.operational_date, json_extract(lfr.payload_json, '$.operationalDate'), json_extract(lfr.payload_json, '$.scheduledDate'), json_extract(lfr.payload_json, '$.date'), lfr.flight_date) AS ops_date,
          substr(COALESCE(lfr.operational_date, json_extract(lfr.payload_json, '$.operationalDate'), json_extract(lfr.payload_json, '$.scheduledDate'), json_extract(lfr.payload_json, '$.date'), lfr.flight_date), 1, 7) AS month,
          strftime('%Y-W%W', COALESCE(lfr.operational_date, json_extract(lfr.payload_json, '$.operationalDate'), json_extract(lfr.payload_json, '$.scheduledDate'), json_extract(lfr.payload_json, '$.date'), lfr.flight_date)) AS iso_week,
          strftime('%w', COALESCE(lfr.operational_date, json_extract(lfr.payload_json, '$.operationalDate'), json_extract(lfr.payload_json, '$.scheduledDate'), json_extract(lfr.payload_json, '$.date'), lfr.flight_date)) AS weekday,
          CAST(substr(COALESCE(lfr.schedule, json_extract(lfr.payload_json, '$.scheduledTime'), json_extract(lfr.payload_json, '$.schedule'), '00:00'), 1, 2) AS INTEGER) AS local_hour,
          COALESCE(lfr.type, json_extract(lfr.payload_json, '$.type')) AS type,
          COALESCE(json_extract(lfr.payload_json, '$.flightNumber'), json_extract(lfr.payload_json, '$.rawFlightNumber')) AS flight,
          COALESCE(json_extract(lfr.payload_json, '$.airline'), substr(json_extract(lfr.payload_json, '$.flightNumber'), 1, 2)) AS airline,
          json_extract(lfr.payload_json, '$.route') AS route,
          COALESCE(json_extract(lfr.payload_json, '$.country'), '') AS country,
          COALESCE(json_extract(lfr.payload_json, '$.aircraft'), '') AS aircraft,
          CAST(COALESCE(json_extract(lfr.payload_json, '$.pax'), 0) AS INTEGER) AS pax,
          lfr.gate AS gate,
          lfr.stand AS stand,
          COALESCE(lfr.status, json_extract(lfr.payload_json, '$.status'), 'active') AS status
        FROM local_flight_records lfr
        LEFT JOIN local_seasons ls ON ls.season_id = lfr.season_id
        WHERE lfr.is_base = 0;
        "#,
    )?;
    Ok(())
}

fn normalize_dashboard_ai_sql(input: &str, limit: i64) -> String {
    let trimmed = input.trim().trim_end_matches(';').trim();
    let has_limit = trimmed
        .to_ascii_uppercase()
        .split_whitespace()
        .any(|token| token == "LIMIT");
    if has_limit {
        trimmed.to_string()
    } else {
        format!("{trimmed} LIMIT {limit}")
    }
}

fn validate_dashboard_ai_sql(sql: &str) -> rusqlite::Result<()> {
    let normalized = sql.trim();
    let upper = normalized.to_ascii_uppercase();
    if !(upper.starts_with("SELECT ") || upper.starts_with("WITH ")) {
        return Err(rusqlite::Error::InvalidParameterName(
            "Dashboard AI SQL must start with SELECT or WITH".to_string(),
        ));
    }
    let semicolon_count = normalized.matches(';').count();
    if semicolon_count > 0 {
        return Err(rusqlite::Error::InvalidParameterName(
            "Dashboard AI SQL must contain exactly one statement without semicolons".to_string(),
        ));
    }
    for keyword in [
        "INSERT",
        "UPDATE",
        "DELETE",
        "DROP",
        "ALTER",
        "CREATE",
        "ATTACH",
        "DETACH",
        "PRAGMA",
        "VACUUM",
        "REINDEX",
        "REPLACE",
        "TRUNCATE",
        "BEGIN",
        "COMMIT",
        "ROLLBACK",
        "LOAD_EXTENSION",
    ] {
        if upper.contains(&format!(" {keyword} ")) || upper.contains(&format!("\n{keyword} ")) {
            return Err(rusqlite::Error::InvalidParameterName(format!(
                "Dashboard AI SQL rejected unsafe keyword {keyword}"
            )));
        }
    }
    let cte_names = dashboard_ai_cte_names(&upper);
    let tokens = upper
        .replace(',', " ")
        .replace('(', " ")
        .replace(')', " ")
        .replace('\n', " ")
        .replace('\t', " ");
    let words = tokens.split_whitespace().collect::<Vec<_>>();
    for window in words.windows(2) {
        if matches!(window[0], "FROM" | "JOIN") {
            let table = window[1].trim_matches('"').trim_matches('`');
            if table != "DASHBOARD_AI_FLIGHT_OPERATIONS" && !cte_names.contains(table) {
                return Err(rusqlite::Error::InvalidParameterName(format!(
                    "Dashboard AI SQL can only read dashboard_ai_flight_operations, rejected {table}"
                )));
            }
        }
    }
    Ok(())
}

fn dashboard_ai_cte_names(upper_sql: &str) -> HashSet<String> {
    let mut names = HashSet::new();
    let Some(header) = dashboard_ai_cte_header(upper_sql) else {
        return names;
    };
    for part in split_dashboard_ai_cte_definitions(header) {
        let mut definition = part.trim();
        if let Some(rest) = definition.strip_prefix("WITH ") {
            definition = rest.trim();
        }
        if let Some(rest) = definition.strip_prefix("RECURSIVE ") {
            definition = rest.trim();
        }
        let name = definition
            .split_whitespace()
            .next()
            .unwrap_or_default()
            .trim_matches('"')
            .trim_matches('`')
            .to_string();
        if !name.is_empty() && name != "RECURSIVE" {
            names.insert(name);
        }
    }
    names
}

fn dashboard_ai_cte_header(upper_sql: &str) -> Option<&str> {
    let trimmed = upper_sql.trim_start();
    if !trimmed.starts_with("WITH ") {
        return None;
    }
    let offset = upper_sql.len() - trimmed.len();
    let mut depth = 0_i32;
    for (relative_index, ch) in trimmed.char_indices() {
        match ch {
            '(' => depth += 1,
            ')' => depth = (depth - 1).max(0),
            _ => {}
        }
        if depth == 0 && trimmed[relative_index..].starts_with("SELECT ") {
            return Some(&upper_sql[..offset + relative_index]);
        }
    }
    Some(upper_sql)
}

fn split_dashboard_ai_cte_definitions(header: &str) -> Vec<&str> {
    let trimmed = header.trim();
    let without_with = trimmed.strip_prefix("WITH ").unwrap_or(trimmed).trim();
    let definitions = without_with
        .strip_prefix("RECURSIVE ")
        .unwrap_or(without_with)
        .trim();
    let mut parts = Vec::new();
    let mut depth = 0_i32;
    let mut start = 0_usize;
    for (index, ch) in definitions.char_indices() {
        match ch {
            '(' => depth += 1,
            ')' => depth = (depth - 1).max(0),
            ',' if depth == 0 => {
                parts.push(definitions[start..index].trim());
                start = index + 1;
            }
            _ => {}
        }
    }
    let tail = definitions[start..].trim();
    if !tail.is_empty() {
        parts.push(tail);
    }
    parts
}

fn json_value_to_sql_value(value: &Value) -> SqlValue {
    match value {
        Value::Null => SqlValue::Null,
        Value::Bool(item) => SqlValue::Integer(if *item { 1 } else { 0 }),
        Value::Number(number) => number
            .as_i64()
            .map(SqlValue::Integer)
            .or_else(|| number.as_f64().map(SqlValue::Real))
            .unwrap_or(SqlValue::Null),
        Value::String(item) => SqlValue::Text(item.clone()),
        _ => SqlValue::Text(value.to_string()),
    }
}

fn sqlite_value_to_json(value: ValueRef<'_>) -> Value {
    match value {
        ValueRef::Null => Value::Null,
        ValueRef::Integer(item) => Value::Number(item.into()),
        ValueRef::Real(item) => serde_json::Number::from_f64(item)
            .map(Value::Number)
            .unwrap_or(Value::Null),
        ValueRef::Text(item) => Value::String(String::from_utf8_lossy(item).to_string()),
        ValueRef::Blob(item) => Value::String(format!("[blob:{} bytes]", item.len())),
    }
}

pub fn discard_session_edits_on_connection(
    conn: &Connection,
    input: &NativeSeasonOnlyInput,
) -> rusqlite::Result<DiscardSessionEditsResult> {
    let sync_meta = read_sync_meta(conn, &input.season_id)?;
    let pending_rows = conn.query_row(
        "SELECT COUNT(*) FROM local_pending_ops WHERE season_id = ?",
        params![input.season_id],
        |row| row.get::<_, i64>(0),
    )?;
    let discarded_count = pending_rows.max(
        sync_meta
            .get("pendingCount")
            .and_then(Value::as_i64)
            .unwrap_or(0),
    );
    let conflict_count = sync_meta
        .get("conflicts")
        .and_then(Value::as_array)
        .map(|items| items.len())
        .unwrap_or(0);
    let mut next_sync_meta = sync_meta.clone();
    next_sync_meta["localRevision"] = Value::Number(
        (sync_meta
            .get("localRevision")
            .and_then(Value::as_i64)
            .unwrap_or(0)
            + 1)
        .into(),
    );
    next_sync_meta["pendingCount"] = Value::Number(0.into());
    next_sync_meta["lastLocalChangeAt"] = Value::Null;
    next_sync_meta["syncStatus"] = Value::String(if conflict_count > 0 {
        "needs_review".to_string()
    } else {
        "synced".to_string()
    });

    conn.execute_batch("BEGIN IMMEDIATE")?;
    let result = (|| {
        conn.execute(
            "DELETE FROM local_source_rows WHERE season_id = ?",
            params![input.season_id],
        )?;
        conn.execute(
            "DELETE FROM local_flight_records WHERE season_id = ? AND is_base = 0",
            params![input.season_id],
        )?;
        conn.execute(
            r#"INSERT INTO local_flight_records (
                season_id, record_id, is_base, sort_order, flight_date, operational_date,
                type, source_side, status, turnaround_id, gate, stand, counter_json,
                check_in_start, check_in_end, schedule, payload_json
              )
              SELECT
                season_id, record_id, 0, sort_order, flight_date, operational_date,
                type, source_side, status, turnaround_id, gate, stand, counter_json,
                check_in_start, check_in_end, schedule, payload_json
              FROM local_flight_records
              WHERE season_id = ? AND is_base = 1"#,
            params![input.season_id],
        )?;
        conn.execute(
            "DELETE FROM local_modifications WHERE season_id = ? AND is_base = 0",
            params![input.season_id],
        )?;
        conn.execute(
            r#"INSERT INTO local_modifications (
                season_id, leg_id, is_base, sort_order, action, gate, stand, counter_json,
                check_in_start, check_in_end, schedule, payload_json
              )
              SELECT
                season_id, leg_id, 0, sort_order, action, gate, stand, counter_json,
                check_in_start, check_in_end, schedule, payload_json
              FROM local_modifications
              WHERE season_id = ? AND is_base = 1"#,
            params![input.season_id],
        )?;
        conn.execute(
            "DELETE FROM local_mod_history_entries WHERE season_id = ? AND is_base = 0",
            params![input.season_id],
        )?;
        conn.execute(
            r#"INSERT INTO local_mod_history_entries (
                season_id, history_id, is_base, sort_order, timestamp, payload_json
              )
              SELECT season_id, history_id, 0, sort_order, timestamp, payload_json
              FROM local_mod_history_entries
              WHERE season_id = ? AND is_base = 1"#,
            params![input.season_id],
        )?;
        conn.execute(
            "DELETE FROM local_pending_ops WHERE season_id = ?",
            params![input.season_id],
        )?;
        conn.execute(
            "DELETE FROM local_derived_seasonal WHERE season_id = ?",
            params![input.season_id],
        )?;
        conn.execute(
            "INSERT INTO local_derived_seasonal (season_id, payload_json) VALUES (?, ?)",
            params![input.season_id, "null"],
        )?;
        write_local_sync_meta(conn, &input.season_id, &next_sync_meta)?;
        Ok::<_, rusqlite::Error>(())
    })();
    match result {
        Ok(()) => {
            conn.execute_batch("COMMIT")?;
            Ok(DiscardSessionEditsResult {
                discarded_count,
                sync_meta: next_sync_meta,
            })
        }
        Err(error) => {
            let _ = conn.execute_batch("ROLLBACK");
            Err(error)
        }
    }
}

fn read_flight_record_payload(
    conn: &Connection,
    season_id: &str,
    record_id: &str,
    is_base: bool,
) -> rusqlite::Result<Option<Value>> {
    read_payload(
        conn,
        "SELECT payload_json FROM local_flight_records WHERE season_id = ? AND record_id = ? AND is_base = ?",
        &[&season_id, &record_id, &(if is_base { 1_i64 } else { 0_i64 })],
    )
}

fn read_source_row_payload(
    conn: &Connection,
    season_id: &str,
    row_index: i64,
    is_base: bool,
) -> rusqlite::Result<Option<Value>> {
    read_payload(
        conn,
        "SELECT payload_json FROM local_source_rows WHERE season_id = ? AND row_index = ? AND is_base = ?",
        &[&season_id, &row_index, &(if is_base { 1_i64 } else { 0_i64 })],
    )
}

fn read_mod_history_payload(
    conn: &Connection,
    season_id: &str,
    history_id: &str,
    is_base: bool,
) -> rusqlite::Result<Option<Value>> {
    read_payload(
        conn,
        "SELECT payload_json FROM local_mod_history_entries WHERE season_id = ? AND history_id = ? AND is_base = ?",
        &[&season_id, &history_id, &(if is_base { 1_i64 } else { 0_i64 })],
    )
}

fn read_entity_field_versions(
    conn: &Connection,
    season_id: &str,
    target_type: &str,
    target_id: &str,
    changed_fields: &[String],
) -> rusqlite::Result<Map<String, Value>> {
    let mut versions = Map::new();
    let target_key = format!("{target_type}:{target_id}");
    for field in changed_fields {
        let version = conn
            .query_row(
                "SELECT server_version FROM local_entity_versions WHERE season_id = ? AND target_type = ? AND target_id = ?",
                params![season_id, target_key, field],
                |row| row.get::<_, i64>(0),
            )
            .optional()?
            .unwrap_or(0);
        versions.insert(field.clone(), json!(version));
    }
    Ok(versions)
}

fn pending_op_target(op: &Value) -> Option<(String, String, Vec<String>)> {
    match op.get("type").and_then(Value::as_str)? {
        "flightRecord" => Some((
            "flightRecord".to_string(),
            value_to_string(op.pointer("/record/id"))?,
            Vec::new(),
        )),
        "sourceRow" => Some((
            "sourceRow".to_string(),
            value_to_string(
                op.pointer("/row/rowIndex")
                    .or_else(|| op.pointer("/row/row_index")),
            )?,
            Vec::new(),
        )),
        "modification" => Some((
            "modification".to_string(),
            value_to_string(op.pointer("/mod/legId"))?,
            Vec::new(),
        )),
        "modificationDelete" => Some((
            "modification".to_string(),
            value_to_string(op.get("legId"))?,
            vec![DELETE_FIELD.to_string()],
        )),
        "modHistory" => Some((
            "modHistory".to_string(),
            value_to_string(op.pointer("/entry/id"))?,
            vec!["entry".to_string()],
        )),
        _ => None,
    }
}

fn pending_op_entity_and_base(
    conn: &Connection,
    season_id: &str,
    op: &Value,
) -> rusqlite::Result<(Option<Value>, Option<Value>)> {
    match op.get("type").and_then(Value::as_str).unwrap_or_default() {
        "flightRecord" => {
            let current = op.get("record").cloned();
            let base = value_to_string(op.pointer("/record/id"))
                .map(|id| read_flight_record_payload(conn, season_id, &id, true))
                .transpose()?
                .flatten();
            Ok((current, base))
        }
        "sourceRow" => {
            let current = op.get("row").cloned();
            let base = op
                .pointer("/row/rowIndex")
                .or_else(|| op.pointer("/row/row_index"))
                .and_then(|value| value_to_i64(Some(value)))
                .map(|row_index| read_source_row_payload(conn, season_id, row_index, true))
                .transpose()?
                .flatten();
            Ok((current, base))
        }
        "modification" => {
            let current = op.get("mod").cloned();
            let base = value_to_string(op.pointer("/mod/legId"))
                .map(|id| {
                    load_modification_map(conn, season_id, true, &[id.clone()])
                        .map(|mut values| values.remove(&id))
                })
                .transpose()?
                .flatten();
            Ok((current, base))
        }
        "modHistory" => {
            let current = op.get("entry").cloned();
            let base = value_to_string(op.pointer("/entry/id"))
                .map(|id| read_mod_history_payload(conn, season_id, &id, true))
                .transpose()?
                .flatten();
            Ok((current, base))
        }
        _ => Ok((None, None)),
    }
}

pub fn build_native_pending_change_events(
    conn: &Connection,
    season_id: &str,
    client_id: &str,
    now_millis: i64,
) -> rusqlite::Result<Vec<Value>> {
    let pending_ops = expand_pending_ops_for_native_sync(read_pending_ops(conn, season_id)?)?;
    pending_ops
        .into_iter()
        .enumerate()
        .map(|(index, op)| {
            let Some((target_type, target_id, fallback_fields)) = pending_op_target(&op) else {
                return Ok(None);
            };
            let (current, base) = pending_op_entity_and_base(conn, season_id, &op)?;
            let mut changed_fields = match op.get("type").and_then(Value::as_str).unwrap_or_default() {
                "flightRecord" => current
                    .as_ref()
                    .map(|value| changed_keys(value, base.as_ref(), &["id"]))
                    .unwrap_or_default(),
                "sourceRow" => current
                    .as_ref()
                    .map(|value| changed_keys(value, base.as_ref(), &["rowIndex", "row_index"]))
                    .unwrap_or_default(),
                "modification" => current
                    .as_ref()
                    .map(|value| changed_keys(value, base.as_ref(), &["legId"]))
                    .unwrap_or_default(),
                _ => fallback_fields.clone(),
            };
            if changed_fields.is_empty() {
                changed_fields = if fallback_fields.is_empty() {
                    vec!["payload".to_string()]
                } else {
                    fallback_fields
                };
            }
            let base_field_versions =
                read_entity_field_versions(conn, season_id, &target_type, &target_id, &changed_fields)?;
            let mut op_payload = match op.get("type").and_then(Value::as_str).unwrap_or_default() {
                "flightRecord" => json!({ "type": "flightRecord", "record": op.get("record").cloned().unwrap_or(Value::Null) }),
                "sourceRow" => json!({ "type": "sourceRow", "row": op.get("row").cloned().unwrap_or(Value::Null) }),
                "modification" => json!({ "type": "modification", "mod": op.get("mod").cloned().unwrap_or(Value::Null) }),
                "modificationDelete" => json!({ "type": "modificationDelete", "legId": target_id }),
                "modHistory" => json!({ "type": "modHistory", "entry": op.get("entry").cloned().unwrap_or(Value::Null) }),
                _ => json!({ "type": "unknown" }),
            };
            if let Some(object) = op_payload.as_object_mut() {
                object.insert("baseFieldVersions".to_string(), Value::Object(base_field_versions));
            }
            let op_fingerprint = json!({
                "seasonId": season_id,
                "target": {
                    "targetType": target_type,
                    "targetId": target_id,
                    "changedFields": changed_fields,
                },
                "op": op,
            });
            let op_id = format!(
                "{}:{}:{}:{}",
                client_id,
                target_type,
                target_id,
                stable_hash(&op_fingerprint)
            );
            Ok(Some(json!({
                "eventId": format!("event-native-{now_millis}-{index}"),
                "seasonId": season_id,
                "clientId": client_id,
                "opId": op_id,
                "actorUserId": Value::Null,
                "serverSeq": Value::Null,
                "targetType": target_type,
                "targetId": target_id,
                "changedFields": changed_fields,
                "opPayload": op_payload,
                "createdAt": format!("{now_millis}"),
            })))
        })
        .filter_map(|result| match result {
            Ok(Some(value)) => Some(Ok(value)),
            Ok(None) => None,
            Err(error) => Some(Err(error)),
        })
        .collect()
}

fn chunk_native_pending_events(events: Vec<Value>) -> rusqlite::Result<Vec<Vec<Value>>> {
    let mut chunks: Vec<Vec<Value>> = Vec::new();
    let mut current: Vec<Value> = Vec::new();
    let mut current_bytes = 2usize;

    for event in events {
        let event_bytes = json_byte_len(&event);
        if event_bytes + 2 > MAX_NATIVE_PENDING_SYNC_CHUNK_BYTES {
            let target = event
                .get("targetId")
                .and_then(Value::as_str)
                .unwrap_or("<unknown>");
            return Err(sqlite_json_error(format!(
                "Native pending sync event {target} is too large for one upload chunk."
            )));
        }
        let candidate_bytes = if current.is_empty() {
            event_bytes + 2
        } else {
            current_bytes + event_bytes + 1
        };
        if !current.is_empty()
            && (current.len() >= MAX_NATIVE_PENDING_SYNC_CHUNK_EVENTS
                || candidate_bytes > MAX_NATIVE_PENDING_SYNC_CHUNK_BYTES)
        {
            chunks.push(current);
            current = Vec::new();
            current_bytes = 2;
        }
        current_bytes = if current.is_empty() {
            event_bytes + 2
        } else {
            current_bytes + event_bytes + 1
        };
        current.push(event);
    }

    if !current.is_empty() {
        chunks.push(current);
    }
    Ok(chunks)
}

pub fn build_native_pending_sync_chunks(
    conn: &Connection,
    season_id: &str,
    client_id: &str,
    now_millis: i64,
) -> rusqlite::Result<Vec<Vec<Value>>> {
    chunk_native_pending_events(build_native_pending_change_events(
        conn, season_id, client_id, now_millis,
    )?)
}

fn pending_event_op_id(event: &Value) -> Option<String> {
    value_to_string(event.get("opId")).or_else(|| value_to_string(event.get("op_id")))
}

fn native_event_from_pending_value(event: &Value) -> Option<NativeCatchupEvent> {
    Some(NativeCatchupEvent {
        event_id: value_to_string(event.get("eventId").or_else(|| event.get("event_id")))?,
        season_id: value_to_string(event.get("seasonId").or_else(|| event.get("season_id")))?,
        client_id: value_to_string(event.get("clientId").or_else(|| event.get("client_id")))
            .unwrap_or_default(),
        op_id: pending_event_op_id(event).unwrap_or_default(),
        server_seq: value_to_i64(event.get("serverSeq").or_else(|| event.get("server_seq")))
            .unwrap_or(0),
        target_type: value_to_string(event.get("targetType").or_else(|| event.get("target_type")))?,
        target_id: value_to_string(event.get("targetId").or_else(|| event.get("target_id")))?,
        changed_fields: event
            .get("changedFields")
            .or_else(|| event.get("changed_fields"))
            .and_then(Value::as_array)
            .map(|items| {
                items
                    .iter()
                    .filter_map(|item| value_to_string(Some(item)))
                    .collect()
            })
            .unwrap_or_default(),
        op_payload: event
            .get("opPayload")
            .or_else(|| event.get("op_payload"))
            .cloned()
            .unwrap_or_else(|| json!({})),
        created_at: value_to_string(event.get("createdAt").or_else(|| event.get("created_at")))
            .unwrap_or_default(),
    })
}

pub fn validate_pending_sync_result_coverage(
    pending_events: &[Value],
    applied_events: &[NativeCatchupEvent],
    conflict_events: &[NativeCatchupEvent],
) -> Result<(), String> {
    let expected_op_ids = pending_events
        .iter()
        .filter_map(pending_event_op_id)
        .collect::<HashSet<_>>();
    if expected_op_ids.is_empty() {
        return Ok(());
    }

    let covered_op_ids = applied_events
        .iter()
        .chain(conflict_events.iter())
        .map(|event| event.op_id.clone())
        .collect::<HashSet<_>>();

    let mut missing_op_ids = expected_op_ids
        .difference(&covered_op_ids)
        .cloned()
        .collect::<Vec<_>>();
    if missing_op_ids.is_empty() {
        return Ok(());
    }

    missing_op_ids.sort();
    Err(format!(
        "Native pending sync refused to finalize because the server response did not acknowledge {} pending operation{}: {}",
        missing_op_ids.len(),
        if missing_op_ids.len() == 1 { "" } else { "s" },
        missing_op_ids.join(", ")
    ))
}

pub fn sync_pending_changes_on_connection(
    conn: &Connection,
    input: &NativeSeasonOnlyInput,
) -> rusqlite::Result<NativeSyncPendingChangesResult> {
    let summary = query_sync_summary_on_connection(conn, &input.season_id)?;
    if summary.pending_count == 0 {
        return Ok(NativeSyncPendingChangesResult {
            status: "synced".to_string(),
            message: "No local changes to sync.".to_string(),
            pending_count: 0,
            conflict_count: summary.conflict_count,
            notification_sent: 0,
            notification_failed: 0,
            notification_skipped: 0,
            notification_flush_error: None,
            auto_resolved_conflict_count: 0,
            auto_resolved_conflict_ids: Vec::new(),
        });
    }
    Ok(NativeSyncPendingChangesResult {
        status: "failed".to_string(),
        message: "Native pending upload is not available yet; refusing JS full-workspace sync."
            .to_string(),
        pending_count: summary.pending_count,
        conflict_count: summary.conflict_count,
        notification_sent: 0,
        notification_failed: 0,
        notification_skipped: 0,
        notification_flush_error: None,
        auto_resolved_conflict_count: 0,
        auto_resolved_conflict_ids: Vec::new(),
    })
}

fn promote_pending_ops_to_base(conn: &Connection, season_id: &str) -> rusqlite::Result<()> {
    for op in read_pending_ops(conn, season_id)? {
        match op.get("type").and_then(Value::as_str).unwrap_or_default() {
            "flightRecord" => {
                if let Some(record_id) = value_to_string(op.pointer("/record/id")) {
                    if let Some(record) =
                        read_flight_record_payload(conn, season_id, &record_id, false)?
                    {
                        upsert_flight_record(conn, season_id, &record_id, true, &record)?;
                    }
                }
            }
            "sourceRow" => {
                if let Some(row_index) = op
                    .pointer("/row/rowIndex")
                    .or_else(|| op.pointer("/row/row_index"))
                    .and_then(|value| value_to_i64(Some(value)))
                {
                    if let Some(row) = read_source_row_payload(conn, season_id, row_index, false)? {
                        upsert_source_row(conn, season_id, row_index, true, &row)?;
                    }
                }
            }
            "modification" => {
                if let Some(leg_id) = value_to_string(op.pointer("/mod/legId")) {
                    let current = load_modification_map(conn, season_id, false, &[leg_id.clone()])?
                        .remove(&leg_id);
                    if let Some(modification) = current {
                        upsert_modification(conn, season_id, &leg_id, true, &modification)?;
                    } else {
                        conn.execute(
                            "DELETE FROM local_modifications WHERE season_id = ? AND leg_id = ? AND is_base = 1",
                            params![season_id, leg_id],
                        )?;
                    }
                }
            }
            "modificationDelete" => {
                if let Some(leg_id) = value_to_string(op.get("legId")) {
                    conn.execute(
                        "DELETE FROM local_modifications WHERE season_id = ? AND leg_id = ?",
                        params![season_id, leg_id],
                    )?;
                }
            }
            "modHistory" => {
                if let Some(history_id) = value_to_string(op.pointer("/entry/id")) {
                    if let Some(entry) =
                        read_mod_history_payload(conn, season_id, &history_id, false)?
                    {
                        insert_mod_history(conn, season_id, &history_id, true, &entry)?;
                    }
                }
            }
            _ => {}
        }
    }
    Ok(())
}

fn mod_history_entry_payload(
    history: &ApplyLocalModificationHistoryInput,
    changes: Vec<Value>,
    record_changes: Vec<Value>,
) -> Value {
    let mut entry = Map::new();
    entry.insert("id".to_string(), Value::String(history.id.clone()));
    entry.insert("timestamp".to_string(), Value::from(history.timestamp));
    entry.insert(
        "description".to_string(),
        Value::String(history.description.clone()),
    );
    entry.insert("changes".to_string(), Value::Array(changes));
    entry.insert("recordChanges".to_string(), Value::Array(record_changes));
    if let Some(schedule_notification) = &history.schedule_notification {
        entry.insert(
            "scheduleNotification".to_string(),
            schedule_notification.clone(),
        );
    }
    Value::Object(entry)
}

fn finalize_successful_pending_sync(
    conn: &Connection,
    season_id: &str,
    rpc_result: &NativeSyncPendingRpcResult,
) -> rusqlite::Result<Value> {
    conn.execute_batch("BEGIN IMMEDIATE")?;
    let result = (|| {
        promote_pending_ops_to_base(conn, season_id)?;
        for event in &rpc_result.applied_events {
            update_entity_versions(conn, season_id, event)?;
        }
        let mut season = read_payload(
            conn,
            "SELECT payload_json FROM local_seasons WHERE season_id = ?",
            &[&season_id],
        )?
        .ok_or(rusqlite::Error::QueryReturnedNoRows)?;
        if let Some(object) = season.as_object_mut() {
            object.insert(
                "dataVersion".to_string(),
                json!(rpc_result.next_server_version),
            );
            object.insert("lastSyncedAt".to_string(), json!(chrono_like_millis()));
        }
        conn.execute(
            "UPDATE local_seasons SET data_version = ?, payload_json = ? WHERE season_id = ?",
            params![
                rpc_result.next_server_version,
                season.to_string(),
                season_id
            ],
        )?;
        let previous_sync_meta = read_sync_meta(conn, season_id)?;
        let mut next_sync_meta = previous_sync_meta.clone();
        if !next_sync_meta.is_object() {
            next_sync_meta = json!({});
        }
        if let Some(object) = next_sync_meta.as_object_mut() {
            object.insert("seasonId".to_string(), json!(season_id));
            object.insert(
                "baseServerVersion".to_string(),
                json!(rpc_result.next_server_version),
            );
            object.insert(
                "lastServerSeq".to_string(),
                json!(rpc_result.next_server_seq.max(rpc_result.server_high_water)),
            );
            object.insert("pendingCount".to_string(), json!(0));
            object.insert("syncStatus".to_string(), json!("synced"));
            object.insert("lastLocalChangeAt".to_string(), Value::Null);
            object.insert(
                "localRevision".to_string(),
                json!(
                    previous_sync_meta
                        .get("localRevision")
                        .and_then(Value::as_i64)
                        .unwrap_or(0)
                        + 1
                ),
            );
            object.insert("conflicts".to_string(), json!([]));
        }
        conn.execute(
            "DELETE FROM local_pending_ops WHERE season_id = ?",
            params![season_id],
        )?;
        conn.execute(
            "DELETE FROM local_sync_meta WHERE season_id = ?",
            params![season_id],
        )?;
        write_local_sync_meta(conn, season_id, &next_sync_meta)?;
        conn.execute(
            "DELETE FROM local_derived_seasonal WHERE season_id = ?",
            params![season_id],
        )?;
        conn.execute(
            "INSERT INTO local_derived_seasonal (season_id, payload_json) VALUES (?, ?)",
            params![season_id, "null"],
        )?;
        Ok::<_, rusqlite::Error>(next_sync_meta)
    })();
    match result {
        Ok(sync_meta) => {
            conn.execute_batch("COMMIT")?;
            Ok(sync_meta)
        }
        Err(error) => {
            let _ = conn.execute_batch("ROLLBACK");
            Err(error)
        }
    }
}

fn mark_pending_sync_conflict(
    conn: &Connection,
    season_id: &str,
    conflict_events: &[NativeCatchupEvent],
) -> rusqlite::Result<Value> {
    let previous_sync_meta = read_sync_meta(conn, season_id)?;
    let mut next_sync_meta = previous_sync_meta.clone();
    if !next_sync_meta.is_object() {
        next_sync_meta = json!({});
    }
    if let Some(object) = next_sync_meta.as_object_mut() {
        let pending_count = conn.query_row(
            "SELECT COUNT(*) FROM local_pending_ops WHERE season_id = ? AND op_type <> 'sourceRow'",
            params![season_id],
            |row| row.get::<_, i64>(0),
        )?;
        object.insert("syncStatus".to_string(), json!("needs_review"));
        object.insert("pendingCount".to_string(), json!(pending_count));
        object.insert(
            "conflicts".to_string(),
            Value::Array(
                conflict_events
                    .iter()
                    .map(|event| json!({
                        "id": format!("{}:{}:{}", event.op_id, event.target_type, event.target_id),
                        "event": event,
                        "targetType": event.target_type,
                        "targetId": event.target_id,
                        "overlappingFields": event.changed_fields,
                        "localFields": {},
                        "remoteFields": {},
                        "createdAt": chrono_like_millis(),
                        "message": format!("Remote {} {} changed while local edits were pending.", event.target_type, event.target_id)
                    }))
                    .collect(),
            ),
        );
    }
    conn.execute(
        "DELETE FROM local_sync_meta WHERE season_id = ?",
        params![season_id],
    )?;
    write_local_sync_meta(conn, season_id, &next_sync_meta)?;
    Ok(next_sync_meta)
}

pub fn apply_local_modification_batch_delta_to_connection(
    conn: &Connection,
    input: &ApplyLocalModificationBatchDeltaInput,
) -> rusqlite::Result<Value> {
    if input.mods.is_empty() {
        read_payload(
            conn,
            "SELECT payload_json FROM local_seasons WHERE season_id = ?",
            &[&input.season_id],
        )?
        .ok_or(rusqlite::Error::QueryReturnedNoRows)?;
        return read_sync_meta(conn, &input.season_id);
    }

    conn.execute_batch("BEGIN IMMEDIATE")?;
    let result = (|| {
        let season = read_payload(
            conn,
            "SELECT payload_json FROM local_seasons WHERE season_id = ?",
            &[&input.season_id],
        )?
        .ok_or(rusqlite::Error::QueryReturnedNoRows)?;
        let sync_meta = read_sync_meta(conn, &input.season_id)?;
        let pending_ops = read_pending_ops(conn, &input.season_id)?;
        let leg_ids = input
            .mods
            .iter()
            .filter_map(|modification| value_to_string(modification.get("legId")))
            .collect::<HashSet<_>>()
            .into_iter()
            .collect::<Vec<_>>();
        let mut affected_modifications =
            load_modification_map(conn, &input.season_id, false, &leg_ids)?;
        let affected_base_modifications =
            load_modification_map(conn, &input.season_id, true, &leg_ids)?;
        let base_records = load_base_record_map(conn, &input.season_id, &leg_ids)?;
        let affected_leg_ids = leg_ids.iter().cloned().collect::<HashSet<_>>();

        for op in &pending_ops {
            match op.get("type").and_then(Value::as_str).unwrap_or_default() {
                "modification" => {
                    if let Some(leg_id) = value_to_string(op.pointer("/mod/legId")) {
                        if affected_leg_ids.contains(&leg_id) {
                            if let Some(modification) = op.get("mod") {
                                affected_modifications.insert(leg_id, modification.clone());
                            }
                        }
                    }
                }
                "modificationDelete" => {
                    if let Some(leg_id) = value_to_string(op.get("legId")) {
                        if affected_leg_ids.contains(&leg_id) {
                            affected_modifications.remove(&leg_id);
                        }
                    }
                }
                _ => {}
            }
        }

        let mut retained_business_ops = Vec::new();
        let mut retained_history_ops = Vec::new();
        for op in pending_ops {
            match op.get("type").and_then(Value::as_str).unwrap_or_default() {
                "modHistory" => retained_history_ops.push(op),
                "modification" => {
                    let leg_id = value_to_string(op.pointer("/mod/legId"));
                    if !leg_id
                        .as_ref()
                        .is_some_and(|value| affected_leg_ids.contains(value))
                    {
                        retained_business_ops.push(op);
                    }
                }
                "modificationDelete" => {
                    let leg_id = value_to_string(op.get("legId"));
                    if !leg_id
                        .as_ref()
                        .is_some_and(|value| affected_leg_ids.contains(value))
                    {
                        retained_business_ops.push(op);
                    }
                }
                _ => retained_business_ops.push(op),
            }
        }

        let mut next_modification_ops = Vec::new();
        let mut history_changes = Vec::new();
        for incoming in &input.mods {
            let Some(leg_id) = value_to_string(incoming.get("legId")) else {
                continue;
            };
            let previous = affected_modifications.get(&leg_id).cloned();
            let next_modification = merge_modification(previous.as_ref(), incoming);
            history_changes.push(json!({
                "legId": leg_id,
                "previousMod": previous,
                "newMod": next_modification
            }));

            let base_modification = affected_base_modifications.get(&leg_id);
            if base_modification.is_none()
                && is_no_op_modification_against_base_record(
                    &next_modification,
                    base_records.get(&leg_id),
                )
            {
                affected_modifications.remove(&leg_id);
                continue;
            }
            affected_modifications.insert(leg_id.clone(), next_modification.clone());
            if base_modification.is_none() || base_modification != Some(&next_modification) {
                next_modification_ops.push(json!({
                    "type": "modification",
                    "mod": next_modification
                }));
            }
        }
        write_current_modification_subset(
            conn,
            &input.season_id,
            &affected_leg_ids,
            &affected_modifications,
        )?;

        let next_history_ops = if let Some(history) = &input.history {
            let mut existing_record_changes = Vec::new();
            retained_history_ops.retain(|op| {
                if let Some(entry) = op.get("entry") {
                    if let Some(id) = entry.get("id").and_then(Value::as_str) {
                        if id == history.id {
                            if let Some(rc) = entry.get("recordChanges").and_then(Value::as_array) {
                                existing_record_changes = rc.clone();
                            }
                            return false;
                        }
                    }
                }
                true
            });

            let mut ops = vec![json!({
                "type": "modHistory",
                "entry": mod_history_entry_payload(history, history_changes, existing_record_changes)
            })];
            ops.extend(retained_history_ops);
            ops
        } else {
            retained_history_ops
        };
        let business_ops = merge_pending_ops(
            retained_business_ops
                .into_iter()
                .chain(next_modification_ops)
                .collect(),
        );
        let next_pending_ops = if business_ops
            .iter()
            .any(|op| op.get("type").and_then(Value::as_str) != Some("modHistory"))
        {
            merge_pending_ops(business_ops.into_iter().chain(next_history_ops).collect())
        } else {
            business_ops
        };
        let changed_at = chrono_like_millis();
        let next_sync_meta =
            build_next_local_sync_meta(sync_meta, &season, next_pending_ops.len(), changed_at);

        conn.execute(
            "DELETE FROM local_pending_ops WHERE season_id = ?",
            params![input.season_id],
        )?;
        conn.execute(
            "DELETE FROM local_derived_seasonal WHERE season_id = ?",
            params![input.season_id],
        )?;
        conn.execute(
            "DELETE FROM local_sync_meta WHERE season_id = ?",
            params![input.season_id],
        )?;
        insert_pending_ops(conn, &input.season_id, &next_pending_ops)?;
        conn.execute(
            "INSERT INTO local_derived_seasonal (season_id, payload_json) VALUES (?, ?)",
            params![input.season_id, "null"],
        )?;
        write_local_sync_meta(conn, &input.season_id, &next_sync_meta)?;
        Ok::<_, rusqlite::Error>(next_sync_meta)
    })();

    match result {
        Ok(sync_meta) => {
            conn.execute_batch("COMMIT")?;
            Ok(sync_meta)
        }
        Err(error) => {
            let _ = conn.execute_batch("ROLLBACK");
            Err(error)
        }
    }
}

fn deleted_record_payload(record_id: &str, current: Option<&Value>, base: Option<&Value>) -> Value {
    let mut next = current
        .cloned()
        .or_else(|| base.cloned())
        .unwrap_or_else(|| json!({ "id": record_id }));
    if !next.is_object() {
        next = json!({ "id": record_id });
    }
    if let Some(object) = next.as_object_mut() {
        object.insert("id".to_string(), Value::String(record_id.to_string()));
        object.insert("action".to_string(), Value::String("deleted".to_string()));
        object.insert("status".to_string(), Value::String("deleted".to_string()));
    }
    next
}

pub fn apply_schedule_mutation_to_connection(
    conn: &Connection,
    input: &ApplyScheduleMutationInput,
) -> rusqlite::Result<Value> {
    if input.records.is_empty() && input.mods.is_empty() && input.deleted_ids.is_empty() {
        read_payload(
            conn,
            "SELECT payload_json FROM local_seasons WHERE season_id = ?",
            &[&input.season_id],
        )?
        .ok_or(rusqlite::Error::QueryReturnedNoRows)?;
        return read_sync_meta(conn, &input.season_id);
    }

    conn.execute_batch("BEGIN IMMEDIATE")?;
    let result = (|| {
        let season = read_payload(
            conn,
            "SELECT payload_json FROM local_seasons WHERE season_id = ?",
            &[&input.season_id],
        )?
        .ok_or(rusqlite::Error::QueryReturnedNoRows)?;
        let sync_meta = read_sync_meta(conn, &input.season_id)?;
        let pending_ops = read_pending_ops(conn, &input.season_id)?;
        let mut record_ids = input
            .records
            .iter()
            .filter_map(|record| value_to_string(record.get("id")))
            .collect::<Vec<_>>();
        record_ids.extend(input.deleted_ids.iter().cloned());
        record_ids.sort();
        record_ids.dedup();
        let affected_record_ids = record_ids.iter().cloned().collect::<HashSet<_>>();
        let mod_leg_ids = input
            .mods
            .iter()
            .filter_map(|modification| value_to_string(modification.get("legId")))
            .collect::<HashSet<_>>()
            .into_iter()
            .collect::<Vec<_>>();
        let affected_mod_leg_ids = mod_leg_ids.iter().cloned().collect::<HashSet<_>>();
        let current_records = load_record_map(conn, &input.season_id, false, &record_ids)?;
        let base_records = load_record_map(conn, &input.season_id, true, &record_ids)?;
        let mut affected_modifications =
            load_modification_map(conn, &input.season_id, false, &mod_leg_ids)?;
        let affected_base_modifications =
            load_modification_map(conn, &input.season_id, true, &mod_leg_ids)?;
        let mod_base_records = load_base_record_map(conn, &input.season_id, &mod_leg_ids)?;

        let mut retained_business_ops = Vec::new();
        let mut retained_history_ops = Vec::new();
        for op in &pending_ops {
            match op.get("type").and_then(Value::as_str).unwrap_or_default() {
                "modification" => {
                    if let Some(leg_id) = value_to_string(op.pointer("/mod/legId")) {
                        if affected_mod_leg_ids.contains(&leg_id) {
                            if let Some(modification) = op.get("mod") {
                                affected_modifications.insert(leg_id, modification.clone());
                            }
                        }
                    }
                }
                "modificationDelete" => {
                    if let Some(leg_id) = value_to_string(op.get("legId")) {
                        if affected_mod_leg_ids.contains(&leg_id) {
                            affected_modifications.remove(&leg_id);
                        }
                    }
                }
                _ => {}
            }
        }
        for op in pending_ops {
            match op.get("type").and_then(Value::as_str).unwrap_or_default() {
                "modHistory" => retained_history_ops.push(op),
                "flightRecord" => {
                    let record_id = value_to_string(op.pointer("/record/id"));
                    if !record_id
                        .as_ref()
                        .is_some_and(|value| affected_record_ids.contains(value))
                    {
                        retained_business_ops.push(op);
                    }
                }
                "sourceRow" => {}
                "modification" => {
                    let leg_id = value_to_string(op.pointer("/mod/legId"));
                    if !leg_id
                        .as_ref()
                        .is_some_and(|value| affected_mod_leg_ids.contains(value))
                    {
                        retained_business_ops.push(op);
                    }
                }
                "modificationDelete" => {
                    let leg_id = value_to_string(op.get("legId"));
                    if !leg_id
                        .as_ref()
                        .is_some_and(|value| affected_mod_leg_ids.contains(value))
                    {
                        retained_business_ops.push(op);
                    }
                }
                _ => retained_business_ops.push(op),
            }
        }

        let mut next_record_ops = Vec::new();
        let mut history_record_changes = Vec::new();
        let mut next_modification_ops = Vec::new();
        let mut history_changes = Vec::new();
        for record in &input.records {
            let Some(record_id) = value_to_string(record.get("id")) else {
                continue;
            };
            let previous_record = current_records.get(&record_id).cloned();
            upsert_flight_record(conn, &input.season_id, &record_id, false, record)?;
            history_record_changes.push(json!({
                "recordId": record_id,
                "previousRecord": previous_record,
                "newRecord": record
            }));
            if base_records.get(&record_id) != Some(record) {
                next_record_ops.push(json!({
                    "type": "flightRecord",
                    "record": record
                }));
            }
        }

        for record_id in &input.deleted_ids {
            let next_record = deleted_record_payload(
                record_id,
                current_records.get(record_id),
                base_records.get(record_id),
            );
            upsert_flight_record(conn, &input.season_id, record_id, false, &next_record)?;
            history_record_changes.push(json!({
                "recordId": record_id,
                "previousRecord": current_records.get(record_id),
                "newRecord": next_record
            }));
            if base_records.get(record_id) != Some(&next_record) {
                next_record_ops.push(json!({
                    "type": "flightRecord",
                    "record": next_record
                }));
            }
        }
        for incoming in &input.mods {
            let Some(leg_id) = value_to_string(incoming.get("legId")) else {
                continue;
            };
            let previous = affected_modifications.get(&leg_id).cloned();
            let next_modification = merge_modification(previous.as_ref(), incoming);
            history_changes.push(json!({
                "legId": leg_id,
                "previousMod": previous,
                "newMod": next_modification
            }));

            let base_modification = affected_base_modifications.get(&leg_id);
            if base_modification.is_none()
                && is_no_op_modification_against_base_record(
                    &next_modification,
                    mod_base_records.get(&leg_id),
                )
            {
                affected_modifications.remove(&leg_id);
                continue;
            }
            affected_modifications.insert(leg_id.clone(), next_modification.clone());
            if base_modification.is_none() || base_modification != Some(&next_modification) {
                next_modification_ops.push(json!({
                    "type": "modification",
                    "mod": next_modification
                }));
            }
        }
        write_current_modification_subset(
            conn,
            &input.season_id,
            &affected_mod_leg_ids,
            &affected_modifications,
        )?;

        let next_history_ops = if let Some(history) = &input.history {
            let mut existing_changes = Vec::new();
            retained_history_ops.retain(|op| {
                if let Some(entry) = op.get("entry") {
                    if let Some(id) = entry.get("id").and_then(Value::as_str) {
                        if id == history.id {
                            if let Some(changes) = entry.get("changes").and_then(Value::as_array) {
                                existing_changes = changes.clone();
                            }
                            return false;
                        }
                    }
                }
                true
            });

            let mut ops = vec![json!({
                "type": "modHistory",
                "entry": mod_history_entry_payload(history, existing_changes, history_record_changes)
            })];
            ops.extend(retained_history_ops);
            ops
        } else {
            retained_history_ops
        };
        let business_ops = merge_pending_ops(
            retained_business_ops
                .into_iter()
                .chain(next_record_ops)
                .chain(next_modification_ops)
                .collect(),
        );
        let next_pending_ops = if business_ops
            .iter()
            .any(|op| op.get("type").and_then(Value::as_str) != Some("modHistory"))
        {
            merge_pending_ops(business_ops.into_iter().chain(next_history_ops).collect())
        } else {
            business_ops
        };
        let changed_at = chrono_like_millis();
        let next_sync_meta =
            build_next_local_sync_meta(sync_meta, &season, next_pending_ops.len(), changed_at);

        conn.execute(
            "DELETE FROM local_pending_ops WHERE season_id = ?",
            params![input.season_id],
        )?;
        conn.execute(
            "DELETE FROM local_derived_seasonal WHERE season_id = ?",
            params![input.season_id],
        )?;
        conn.execute(
            "DELETE FROM local_sync_meta WHERE season_id = ?",
            params![input.season_id],
        )?;
        insert_pending_ops(conn, &input.season_id, &next_pending_ops)?;
        conn.execute(
            "INSERT INTO local_derived_seasonal (season_id, payload_json) VALUES (?, ?)",
            params![input.season_id, "null"],
        )?;
        write_local_sync_meta(conn, &input.season_id, &next_sync_meta)?;
        Ok::<_, rusqlite::Error>(next_sync_meta)
    })();

    match result {
        Ok(sync_meta) => {
            conn.execute_batch("COMMIT")?;
            Ok(sync_meta)
        }
        Err(error) => {
            let _ = conn.execute_batch("ROLLBACK");
            Err(error)
        }
    }
}

fn value_to_i64(value: Option<&Value>) -> Option<i64> {
    value.and_then(|entry| {
        entry
            .as_i64()
            .or_else(|| entry.as_u64().and_then(|next| i64::try_from(next).ok()))
            .or_else(|| entry.as_str().and_then(|text| text.parse::<i64>().ok()))
    })
}

fn value_to_string(value: Option<&Value>) -> Option<String> {
    value.and_then(|entry| {
        entry.as_str().map(ToOwned::to_owned).or_else(|| {
            if entry.is_null() {
                None
            } else {
                Some(entry.to_string())
            }
        })
    })
}

fn value_to_json_string(value: Option<&Value>) -> Option<String> {
    value.map(Value::to_string)
}

fn read_payload(
    conn: &Connection,
    sql: &str,
    params: &[&dyn rusqlite::ToSql],
) -> rusqlite::Result<Option<Value>> {
    let text: Option<String> = conn.query_row(sql, params, |row| row.get(0)).optional()?;
    Ok(text
        .and_then(|payload| serde_json::from_str::<Value>(&payload).ok())
        .filter(Value::is_object))
}

fn merge_changed_fields(
    current: Option<Value>,
    remote: &Value,
    changed_fields: &[String],
) -> Value {
    if changed_fields.is_empty() || changed_fields.iter().any(|field| field == "payload") {
        return remote.clone();
    }
    let mut next = current.unwrap_or_else(|| remote.clone());
    if !next.is_object() {
        next = json!({});
    }
    if let Some(next_object) = next.as_object_mut() {
        for field in changed_fields {
            if let Some(value) = remote.get(field) {
                next_object.insert(field.clone(), value.clone());
            }
        }
    }
    next
}

fn normalize_flight_record_payload(record_id: &str, payload: &Value) -> Value {
    let mut next = payload.clone();
    if !next.is_object() {
        next = json!({});
    }
    if let Some(next_object) = next.as_object_mut() {
        let has_id = value_to_string(next_object.get("id")).is_some_and(|id| !id.trim().is_empty());
        if !has_id {
            next_object.insert("id".to_string(), Value::String(record_id.to_string()));
        }
    }
    next
}

fn next_sort_order(
    conn: &Connection,
    table: &str,
    season_id: &str,
    is_base: bool,
) -> rusqlite::Result<i64> {
    let sql = format!(
        "SELECT COALESCE(MAX(sort_order), -1) + 1 FROM {table} WHERE season_id = ? AND is_base = ?"
    );
    conn.query_row(
        &sql,
        params![season_id, if is_base { 1 } else { 0 }],
        |row| row.get(0),
    )
}

fn upsert_flight_record(
    conn: &Connection,
    season_id: &str,
    record_id: &str,
    is_base: bool,
    payload: &Value,
) -> rusqlite::Result<()> {
    let normalized_payload = normalize_flight_record_payload(record_id, payload);
    let sort_order = next_sort_order(conn, "local_flight_records", season_id, is_base)?;
    conn.execute(
        r#"INSERT INTO local_flight_records (
          season_id, record_id, is_base, sort_order, flight_date, operational_date,
          type, source_side, status, turnaround_id, gate, stand, counter_json,
          check_in_start, check_in_end, schedule, payload_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(season_id, record_id, is_base) DO UPDATE SET
          flight_date = excluded.flight_date,
          operational_date = excluded.operational_date,
          type = excluded.type,
          source_side = excluded.source_side,
          status = excluded.status,
          turnaround_id = excluded.turnaround_id,
          gate = excluded.gate,
          stand = excluded.stand,
          counter_json = excluded.counter_json,
          check_in_start = excluded.check_in_start,
          check_in_end = excluded.check_in_end,
          schedule = excluded.schedule,
          payload_json = excluded.payload_json"#,
        params![
            season_id,
            record_id,
            if is_base { 1 } else { 0 },
            sort_order,
            value_to_string(normalized_payload.get("date")),
            value_to_string(
                normalized_payload
                    .get("operationalDate")
                    .or_else(|| normalized_payload.get("operational_date"))
            ),
            value_to_string(normalized_payload.get("type")),
            value_to_string(
                normalized_payload
                    .get("sourceSide")
                    .or_else(|| normalized_payload.get("source_side"))
            ),
            value_to_string(normalized_payload.get("status")),
            value_to_string(
                normalized_payload
                    .get("turnaroundId")
                    .or_else(|| normalized_payload.get("turnaround_id"))
            ),
            value_to_i64(normalized_payload.get("gate")),
            value_to_i64(normalized_payload.get("stand")),
            value_to_json_string(normalized_payload.get("counter")),
            value_to_string(
                normalized_payload
                    .get("checkInStart")
                    .or_else(|| normalized_payload.get("check_in_start"))
            ),
            value_to_string(
                normalized_payload
                    .get("checkInEnd")
                    .or_else(|| normalized_payload.get("check_in_end"))
            ),
            value_to_string(normalized_payload.get("schedule")),
            normalized_payload.to_string(),
        ],
    )?;
    Ok(())
}

fn upsert_source_row(
    conn: &Connection,
    season_id: &str,
    row_index: i64,
    is_base: bool,
    payload: &Value,
) -> rusqlite::Result<()> {
    let sort_order = next_sort_order(conn, "local_source_rows", season_id, is_base)?;
    conn.execute(
        r#"INSERT INTO local_source_rows (
          season_id, row_index, is_base, sort_order, effective, discontinue, airline, payload_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(season_id, row_index, is_base) DO UPDATE SET
          effective = excluded.effective,
          discontinue = excluded.discontinue,
          airline = excluded.airline,
          payload_json = excluded.payload_json"#,
        params![
            season_id,
            row_index,
            if is_base { 1 } else { 0 },
            sort_order,
            value_to_string(payload.get("effective")),
            value_to_string(payload.get("discontinue")),
            value_to_string(payload.get("airline")),
            payload.to_string(),
        ],
    )?;
    Ok(())
}

fn upsert_modification(
    conn: &Connection,
    season_id: &str,
    leg_id: &str,
    is_base: bool,
    payload: &Value,
) -> rusqlite::Result<()> {
    let action = value_to_string(payload.get("action")).unwrap_or_else(|| "modified".to_string());
    let normalized_payload = normalize_modification_payload(leg_id, Some(&action), payload);
    let sort_order = next_sort_order(conn, "local_modifications", season_id, is_base)?;
    conn.execute(
        r#"INSERT INTO local_modifications (
          season_id, leg_id, is_base, sort_order, action, gate, stand, counter_json,
          check_in_start, check_in_end, schedule, payload_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(season_id, leg_id, is_base) DO UPDATE SET
          action = excluded.action,
          gate = excluded.gate,
          stand = excluded.stand,
          counter_json = excluded.counter_json,
          check_in_start = excluded.check_in_start,
          check_in_end = excluded.check_in_end,
          schedule = excluded.schedule,
          payload_json = excluded.payload_json"#,
        params![
            season_id,
            leg_id,
            if is_base { 1 } else { 0 },
            sort_order,
            action,
            value_to_i64(normalized_payload.get("gate")),
            value_to_i64(normalized_payload.get("stand")),
            value_to_json_string(normalized_payload.get("counter")),
            value_to_string(
                normalized_payload
                    .get("checkInStart")
                    .or_else(|| normalized_payload.get("check_in_start"))
            ),
            value_to_string(
                normalized_payload
                    .get("checkInEnd")
                    .or_else(|| normalized_payload.get("check_in_end"))
            ),
            value_to_string(normalized_payload.get("schedule")),
            normalized_payload.to_string(),
        ],
    )?;
    Ok(())
}

fn write_current_modification_subset(
    conn: &Connection,
    season_id: &str,
    affected_leg_ids: &HashSet<String>,
    modifications: &HashMap<String, Value>,
) -> rusqlite::Result<()> {
    for leg_id in affected_leg_ids {
        conn.execute(
            "DELETE FROM local_modifications WHERE season_id = ? AND leg_id = ? AND is_base = 0",
            params![season_id, leg_id],
        )?;
        if let Some(payload) = modifications.get(leg_id) {
            upsert_modification(conn, season_id, leg_id, false, payload)?;
        }
    }
    Ok(())
}

fn insert_mod_history(
    conn: &Connection,
    season_id: &str,
    history_id: &str,
    is_base: bool,
    payload: &Value,
) -> rusqlite::Result<()> {
    let sort_order = next_sort_order(conn, "local_mod_history_entries", season_id, is_base)?;
    conn.execute(
        r#"INSERT OR IGNORE INTO local_mod_history_entries (
          season_id, history_id, is_base, sort_order, timestamp, payload_json
        ) VALUES (?, ?, ?, ?, ?, ?)"#,
        params![
            season_id,
            history_id,
            if is_base { 1 } else { 0 },
            sort_order,
            value_to_i64(payload.get("timestamp")).unwrap_or(0),
            payload.to_string(),
        ],
    )?;
    Ok(())
}

fn local_pending_overlap(
    conn: &Connection,
    season_id: &str,
    event: &NativeCatchupEvent,
) -> rusqlite::Result<Vec<String>> {
    let mut stmt = conn.prepare(
        "SELECT payload_json FROM local_pending_ops WHERE season_id = ? ORDER BY sort_order ASC",
    )?;
    let rows = stmt.query_map(params![season_id], |row| row.get::<_, String>(0))?;
    let remote_fields: HashSet<&str> = event.changed_fields.iter().map(String::as_str).collect();
    let mut overlap = HashSet::new();

    for row in rows {
        let payload_text = row?;
        let Ok(payload) = serde_json::from_str::<Value>(&payload_text) else {
            continue;
        };
        let op_type = payload
            .get("type")
            .and_then(Value::as_str)
            .unwrap_or_default();
        let (target_type, target_id, local_entity) = match op_type {
            "flightRecord" => (
                "flightRecord",
                value_to_string(payload.pointer("/record/id")),
                payload.get("record"),
            ),
            "sourceRow" => (
                "sourceRow",
                value_to_string(payload.pointer("/row/rowIndex")),
                payload.get("row"),
            ),
            "modification" => (
                "modification",
                value_to_string(payload.pointer("/mod/legId")),
                payload.get("mod"),
            ),
            "modificationDelete" => ("modification", value_to_string(payload.get("legId")), None),
            _ => ("", None, None),
        };
        if target_type != event.target_type
            || target_id.as_deref() != Some(event.target_id.as_str())
        {
            continue;
        }
        if op_type == "modificationDelete"
            || event
                .changed_fields
                .iter()
                .any(|field| field == DELETE_FIELD)
        {
            for field in &event.changed_fields {
                overlap.insert(field.clone());
            }
            continue;
        }
        if let Some(Value::Object(entity)) = local_entity {
            for field in entity.keys() {
                if remote_fields.contains(field.as_str()) {
                    overlap.insert(field.clone());
                }
            }
        }
    }

    let mut fields = overlap.into_iter().collect::<Vec<_>>();
    fields.sort();
    Ok(fields)
}

fn local_entity_versions_cover_event(
    conn: &Connection,
    season_id: &str,
    event: &NativeCatchupEvent,
) -> rusqlite::Result<bool> {
    if event.changed_fields.is_empty() {
        return Ok(false);
    }
    let target_key = format!("{}:{}", event.target_type, event.target_id);
    for field in &event.changed_fields {
        let version = conn
            .query_row(
                "SELECT server_version FROM local_entity_versions WHERE season_id = ? AND target_type = ? AND target_id = ?",
                params![season_id, target_key, field],
                |row| row.get::<_, i64>(0),
            )
            .optional()?
            .unwrap_or(0);
        if version < event.server_seq {
            return Ok(false);
        }
    }
    Ok(true)
}

fn is_modification_delete_event(event: &NativeCatchupEvent) -> bool {
    event.op_payload.get("type").and_then(Value::as_str) == Some("modificationDelete")
        || event
            .changed_fields
            .iter()
            .any(|field| field == DELETE_FIELD)
}

fn is_auto_remote_latest_conflict_event(event: &NativeCatchupEvent) -> bool {
    event.target_type == "modification"
        && event.changed_fields.len() == 1
        && AUTO_REMOTE_WIN_MODIFICATION_FIELDS.contains(&event.changed_fields[0].as_str())
}

fn remote_latest_conflict_id(event: &NativeCatchupEvent) -> String {
    format!("{}:{}:{}", event.op_id, event.target_type, event.target_id)
}

fn auto_resolve_remote_latest_conflict_events(
    conn: &Connection,
    season_id: &str,
    conflict_events: &[NativeCatchupEvent],
) -> rusqlite::Result<(Vec<NativeCatchupEvent>, Vec<String>)> {
    let mut remaining = Vec::new();
    let mut auto_resolved_ids = Vec::new();
    for event in conflict_events {
        if is_auto_remote_latest_conflict_event(event) {
            apply_event_data(conn, season_id, event)?;
            update_entity_versions(conn, season_id, event)?;
            remove_pending_ops_for_conflict_target(
                conn,
                season_id,
                &event.target_type,
                &event.target_id,
            )?;
            auto_resolved_ids.push(remote_latest_conflict_id(event));
        } else {
            remaining.push(event.clone());
        }
    }
    Ok((remaining, auto_resolved_ids))
}

fn same_client_event_already_applied(
    conn: &Connection,
    season_id: &str,
    event: &NativeCatchupEvent,
) -> rusqlite::Result<bool> {
    if !local_entity_versions_cover_event(conn, season_id, event)? {
        return Ok(false);
    }
    if is_modification_delete_event(event) && event.target_type == "modification" {
        return Ok(read_current_entity(conn, season_id, event)?.is_none());
    }
    let Some(remote) = event_payload_entity(event) else {
        return Ok(true);
    };
    let Some(current) = read_current_entity(conn, season_id, event)? else {
        return Ok(false);
    };
    if event.target_type == "modHistory" {
        return Ok(current == *remote);
    }
    for field in &event.changed_fields {
        if field == DELETE_FIELD || value_or_null(&current, field) != value_or_null(remote, field) {
            return Ok(false);
        }
    }
    Ok(true)
}

fn event_payload_entity(event: &NativeCatchupEvent) -> Option<&Value> {
    match event.target_type.as_str() {
        "flightRecord" => event.op_payload.get("record"),
        "sourceRow" => event.op_payload.get("row"),
        "modification" => event.op_payload.get("mod"),
        "modHistory" => event.op_payload.get("entry"),
        _ => None,
    }
}

fn read_current_entity(
    conn: &Connection,
    season_id: &str,
    event: &NativeCatchupEvent,
) -> rusqlite::Result<Option<Value>> {
    match event.target_type.as_str() {
        "flightRecord" => read_payload(
            conn,
            "SELECT payload_json FROM local_flight_records WHERE season_id = ? AND record_id = ? AND is_base = 0",
            &[&season_id, &event.target_id],
        ),
        "sourceRow" => read_payload(
            conn,
            "SELECT payload_json FROM local_source_rows WHERE season_id = ? AND row_index = ? AND is_base = 0",
            &[&season_id, &event.target_id.parse::<i64>().unwrap_or_default()],
        ),
        "modification" => read_payload(
            conn,
            "SELECT payload_json FROM local_modifications WHERE season_id = ? AND leg_id = ? AND is_base = 0",
            &[&season_id, &event.target_id],
        ),
        "modHistory" => read_payload(
            conn,
            "SELECT payload_json FROM local_mod_history_entries WHERE season_id = ? AND history_id = ? AND is_base = 0",
            &[&season_id, &event.target_id],
        ),
        _ => Ok(None),
    }
}

fn pick_fields(entity: Option<&Value>, fields: &[String]) -> Value {
    let mut output = Map::new();
    for field in fields {
        output.insert(
            field.clone(),
            entity
                .and_then(|value| value.get(field))
                .cloned()
                .unwrap_or(Value::Null),
        );
    }
    Value::Object(output)
}

fn build_conflict(
    conn: &Connection,
    season_id: &str,
    event: &NativeCatchupEvent,
    fields: &[String],
) -> rusqlite::Result<Value> {
    let local_entity = read_current_entity(conn, season_id, event)?;
    let remote_entity = event_payload_entity(event);
    Ok(json!({
        "id": format!("{}:{}:{}:{}", event.event_id, event.target_type, event.target_id, fields.join(",")),
        "event": event,
        "targetType": event.target_type,
        "targetId": event.target_id,
        "overlappingFields": fields,
        "localFields": pick_fields(local_entity.as_ref(), fields),
        "remoteFields": pick_fields(remote_entity, fields),
        "createdAt": chrono_like_millis(),
        "message": format!(
            "Remote {} {} changed {} while local edits were pending.",
            event.target_type,
            event.target_id,
            fields.join(", ")
        )
    }))
}

fn chrono_like_millis() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| i64::try_from(duration.as_millis()).unwrap_or(i64::MAX))
        .unwrap_or(0)
}

fn update_entity_versions(
    conn: &Connection,
    season_id: &str,
    event: &NativeCatchupEvent,
) -> rusqlite::Result<()> {
    let target_key = format!("{}:{}", event.target_type, event.target_id);
    for field in &event.changed_fields {
        conn.execute(
            r#"INSERT INTO local_entity_versions (season_id, target_type, target_id, server_version)
               VALUES (?, ?, ?, ?)
               ON CONFLICT(season_id, target_type, target_id)
               DO UPDATE SET server_version = MAX(server_version, excluded.server_version)"#,
            params![season_id, target_key, field, event.server_seq],
        )?;
    }
    Ok(())
}

fn initialize_missing_sync_meta(conn: &Connection, season_id: &str) -> rusqlite::Result<Value> {
    let season_payload: String = conn
        .query_row(
            "SELECT payload_json FROM local_seasons WHERE season_id = ?",
            params![season_id],
            |row| row.get(0),
        )
        .optional()?
        .ok_or(rusqlite::Error::QueryReturnedNoRows)?;
    let season: Value = serde_json::from_str(&season_payload).unwrap_or_else(|_| json!({}));
    let base_server_version = season
        .get("dataVersion")
        .and_then(Value::as_i64)
        .unwrap_or(0);
    let pending_count = conn.query_row(
        "SELECT COUNT(*) FROM local_pending_ops WHERE season_id = ? AND op_type <> 'sourceRow'",
        params![season_id],
        |row| row.get::<_, i64>(0),
    )?;
    let sync_status = if pending_count > 0 { "dirty" } else { "synced" };
    let sync_meta = json!({
        "seasonId": season_id,
        "baseServerVersion": base_server_version,
        "lastServerSeq": 0,
        "localRevision": 0,
        "pendingCount": pending_count,
        "lastLocalChangeAt": null,
        "syncStatus": sync_status,
        "conflicts": []
    });
    conn.execute(
        r#"INSERT INTO local_sync_meta (
          season_id, pending_count, sync_status, last_server_seq, last_local_change_at, payload_json
        ) VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(season_id) DO NOTHING"#,
        params![
            season_id,
            pending_count,
            sync_status,
            0_i64,
            Option::<i64>::None,
            sync_meta.to_string()
        ],
    )?;
    Ok(sync_meta)
}

fn read_sync_meta(conn: &Connection, season_id: &str) -> rusqlite::Result<Value> {
    let payload: Option<String> = conn
        .query_row(
            "SELECT payload_json FROM local_sync_meta WHERE season_id = ?",
            params![season_id],
            |row| row.get(0),
        )
        .optional()?;
    match payload {
        Some(payload) => Ok(serde_json::from_str(&payload).unwrap_or_else(|_| json!({}))),
        None => initialize_missing_sync_meta(conn, season_id),
    }
}

fn write_sync_meta(
    conn: &Connection,
    season_id: &str,
    mut sync_meta: Value,
    last_server_seq: i64,
) -> rusqlite::Result<usize> {
    let pending_count = conn.query_row(
        "SELECT COUNT(*) FROM local_pending_ops WHERE season_id = ? AND op_type <> 'sourceRow'",
        params![season_id],
        |row| row.get::<_, i64>(0),
    )?;
    let conflict_count = sync_meta
        .get("conflicts")
        .and_then(Value::as_array)
        .map_or(0, Vec::len);
    sync_meta["seasonId"] = Value::String(season_id.to_string());
    sync_meta["lastServerSeq"] = Value::Number(last_server_seq.into());
    sync_meta["pendingCount"] = Value::Number(pending_count.into());
    sync_meta["syncStatus"] = Value::String(
        if conflict_count > 0 {
            "needs_review"
        } else if pending_count > 0 {
            "dirty"
        } else {
            "synced"
        }
        .to_string(),
    );
    let next_revision = sync_meta
        .get("localRevision")
        .and_then(Value::as_i64)
        .unwrap_or(0)
        + 1;
    sync_meta["localRevision"] = Value::Number(next_revision.into());
    conn.execute(
        r#"INSERT INTO local_sync_meta (
          season_id, pending_count, sync_status, last_server_seq, last_local_change_at, payload_json
        ) VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(season_id) DO UPDATE SET
          pending_count = excluded.pending_count,
          sync_status = excluded.sync_status,
          last_server_seq = excluded.last_server_seq,
          payload_json = excluded.payload_json"#,
        params![
            season_id,
            pending_count,
            sync_meta["syncStatus"].as_str().unwrap_or("synced"),
            last_server_seq,
            sync_meta.get("lastLocalChangeAt").and_then(Value::as_i64),
            sync_meta.to_string(),
        ],
    )?;
    Ok(conflict_count)
}

fn append_conflict(sync_meta: &mut Value, conflict: Value) {
    let conflicts = sync_meta
        .as_object_mut()
        .expect("sync meta object")
        .entry("conflicts")
        .or_insert_with(|| Value::Array(vec![]));
    if !conflicts.is_array() {
        *conflicts = Value::Array(vec![]);
    }
    let conflict_id = conflict
        .get("id")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let list = conflicts.as_array_mut().expect("conflicts array");
    if !list
        .iter()
        .any(|entry| entry.get("id").and_then(Value::as_str) == Some(conflict_id))
    {
        list.push(conflict);
    }
}

fn local_modification_target_exists(
    conn: &Connection,
    season_id: &str,
    target_id: &str,
) -> rusqlite::Result<bool> {
    let record_count: i64 = conn.query_row(
        "SELECT COUNT(1) FROM local_flight_records WHERE season_id = ? AND record_id = ? AND is_base = 0",
        params![season_id, target_id],
        |row| row.get(0),
    )?;
    if record_count > 0 {
        return Ok(true);
    }

    let added_modification_count: i64 = conn.query_row(
        "SELECT COUNT(1) FROM local_modifications WHERE season_id = ? AND leg_id = ? AND action = 'added'",
        params![season_id, target_id],
        |row| row.get(0),
    )?;
    Ok(added_modification_count > 0)
}

fn should_skip_orphan_modification_event(
    conn: &Connection,
    season_id: &str,
    event: &NativeCatchupEvent,
) -> rusqlite::Result<bool> {
    if event.target_type != "modification" {
        return Ok(false);
    }
    let Some(remote) = event.op_payload.get("mod") else {
        return Ok(false);
    };
    let action = modification_action(remote);
    let normalized =
        normalize_modification_payload(&event.target_id, Some(action.as_str()), remote);
    if is_valid_added_modification_payload(&event.target_id, &normalized) {
        return Ok(false);
    }
    local_modification_target_exists(conn, season_id, &event.target_id).map(|exists| !exists)
}

fn apply_event_data(
    conn: &Connection,
    season_id: &str,
    event: &NativeCatchupEvent,
) -> rusqlite::Result<Option<String>> {
    if event.op_payload.get("type").and_then(Value::as_str) == Some("modificationDelete")
        || event
            .changed_fields
            .iter()
            .any(|field| field == DELETE_FIELD)
    {
        if event.target_type == "modification" {
            conn.execute(
                "DELETE FROM local_modifications WHERE season_id = ? AND leg_id = ?",
                params![season_id, event.target_id],
            )?;
            return Ok(Some(format!("{}:{}", event.target_type, event.target_id)));
        }
    }

    match event.target_type.as_str() {
        "flightRecord" => {
            let Some(remote) = event.op_payload.get("record") else {
                return Ok(None);
            };
            let current = read_current_entity(conn, season_id, event)?;
            let merged = merge_changed_fields(current, remote, &event.changed_fields);
            upsert_flight_record(conn, season_id, &event.target_id, false, &merged)?;
            upsert_flight_record(conn, season_id, &event.target_id, true, remote)?;
            Ok(Some(format!("{}:{}", event.target_type, event.target_id)))
        }
        "sourceRow" => {
            let Some(remote) = event.op_payload.get("row") else {
                return Ok(None);
            };
            let row_index = event.target_id.parse::<i64>().unwrap_or_else(|_| {
                value_to_i64(remote.get("rowIndex").or_else(|| remote.get("row_index")))
                    .unwrap_or(0)
            });
            let current = read_current_entity(conn, season_id, event)?;
            let merged = merge_changed_fields(current, remote, &event.changed_fields);
            upsert_source_row(conn, season_id, row_index, false, &merged)?;
            upsert_source_row(conn, season_id, row_index, true, remote)?;
            Ok(Some(format!("{}:{}", event.target_type, event.target_id)))
        }
        "modification" => {
            let Some(remote) = event.op_payload.get("mod") else {
                return Ok(None);
            };
            let current = read_current_entity(conn, season_id, event)?;
            let merged = merge_changed_fields(current, remote, &event.changed_fields);
            upsert_modification(conn, season_id, &event.target_id, false, &merged)?;
            upsert_modification(conn, season_id, &event.target_id, true, remote)?;
            Ok(Some(format!("{}:{}", event.target_type, event.target_id)))
        }
        "modHistory" => {
            let Some(remote) = event.op_payload.get("entry") else {
                return Ok(None);
            };
            insert_mod_history(conn, season_id, &event.target_id, false, remote)?;
            insert_mod_history(conn, season_id, &event.target_id, true, remote)?;
            Ok(Some(format!("{}:{}", event.target_type, event.target_id)))
        }
        _ => Ok(None),
    }
}

pub fn reconcile_flight_record_manifest_on_connection(
    conn: &Connection,
    season_id: &str,
    remote_record_ids: &HashSet<String>,
) -> rusqlite::Result<FlightRecordManifestReconcileResult> {
    conn.execute_batch("BEGIN IMMEDIATE")?;
    let result = (|| {
        conn.execute_batch(
            r#"
            CREATE TEMP TABLE IF NOT EXISTS temp_remote_flight_record_manifest (
              record_id TEXT PRIMARY KEY
            );
            DELETE FROM temp_remote_flight_record_manifest;
            "#,
        )?;
        {
            let mut insert_remote = conn.prepare(
                "INSERT OR IGNORE INTO temp_remote_flight_record_manifest (record_id) VALUES (?)",
            )?;
            for record_id in remote_record_ids {
                insert_remote.execute(params![record_id])?;
            }
        }

        let pending_predicate = r#"
            NOT EXISTS (
              SELECT 1
              FROM local_pending_ops p
              WHERE p.season_id = l.season_id
                AND (
                  p.op_key = 'flightRecord:' || l.record_id
                  OR p.op_key LIKE '%' || l.record_id || '%'
                  OR p.payload_json LIKE '%"' || l.record_id || '"%'
                )
            )
        "#;
        let stale_record_sql = format!(
            r#"SELECT DISTINCT l.record_id
               FROM local_flight_records l
               WHERE l.season_id = ?
                 AND NOT EXISTS (
                   SELECT 1
                   FROM temp_remote_flight_record_manifest r
                   WHERE r.record_id = l.record_id
                 )
                 AND {pending_predicate}
               ORDER BY l.record_id"#
        );
        let mut removed_record_ids = Vec::new();
        {
            let mut stale_record_stmt = conn.prepare(&stale_record_sql)?;
            let rows =
                stale_record_stmt.query_map(params![season_id], |row| row.get::<_, String>(0))?;
            for row in rows {
                removed_record_ids.push(row?);
            }
        }

        let removed_flight_rows = conn.execute(
            &format!(
                r#"DELETE FROM local_flight_records AS l
                   WHERE l.season_id = ?
                     AND NOT EXISTS (
                       SELECT 1
                       FROM temp_remote_flight_record_manifest r
                       WHERE r.record_id = l.record_id
                     )
                     AND {pending_predicate}"#
            ),
            params![season_id],
        )?;

        let removed_modification_rows = conn.execute(
            r#"DELETE FROM local_modifications AS m
               WHERE m.season_id = ?
                 AND NOT EXISTS (
                   SELECT 1
                   FROM temp_remote_flight_record_manifest r
                   WHERE r.record_id = m.leg_id
                 )
                 AND NOT EXISTS (
                   SELECT 1
                   FROM local_pending_ops p
                   WHERE p.season_id = m.season_id
                     AND (
                       p.op_key LIKE '%' || m.leg_id || '%'
                       OR p.payload_json LIKE '%"' || m.leg_id || '"%'
                     )
                 )"#,
            params![season_id],
        )?;

        let removed_entity_versions = conn.execute(
            r#"DELETE FROM local_entity_versions AS ev
               WHERE ev.season_id = ?
                 AND ev.target_type IN ('flightRecord', 'modification')
                 AND NOT EXISTS (
                   SELECT 1
                   FROM temp_remote_flight_record_manifest r
                   WHERE r.record_id = ev.target_id
                 )
                 AND NOT EXISTS (
                   SELECT 1
                   FROM local_pending_ops p
                   WHERE p.season_id = ev.season_id
                     AND (
                       p.op_key LIKE '%' || ev.target_id || '%'
                       OR p.payload_json LIKE '%"' || ev.target_id || '"%'
                     )
                 )"#,
            params![season_id],
        )?;

        if removed_flight_rows > 0 || removed_modification_rows > 0 || removed_entity_versions > 0 {
            let sync_meta = read_sync_meta(conn, season_id)?;
            let last_server_seq = sync_meta
                .get("lastServerSeq")
                .and_then(Value::as_i64)
                .unwrap_or(0);
            write_sync_meta(conn, season_id, sync_meta, last_server_seq)?;
            conn.execute(
                "DELETE FROM local_derived_seasonal WHERE season_id = ?",
                params![season_id],
            )?;
        }

        Ok::<_, rusqlite::Error>(FlightRecordManifestReconcileResult {
            removed_flight_rows,
            removed_modification_rows,
            removed_entity_versions,
            removed_record_ids,
        })
    })();

    match result {
        Ok(reconcile_result) => {
            conn.execute_batch("COMMIT")?;
            Ok(reconcile_result)
        }
        Err(error) => {
            let _ = conn.execute_batch("ROLLBACK");
            Err(error)
        }
    }
}

pub fn apply_event_page(
    conn: &Connection,
    page: &NativeCatchupEventPage,
    local_client_id: &str,
) -> rusqlite::Result<NativeCatchupPageResult> {
    conn.execute_batch("BEGIN IMMEDIATE")?;
    let result = (|| {
        let mut sync_meta = read_sync_meta(conn, &page.season_id)?;
        let mut changed_targets = Vec::new();
        let mut last_server_seq = sync_meta
            .get("lastServerSeq")
            .and_then(Value::as_i64)
            .unwrap_or(0);

        for event in &page.events {
            last_server_seq = last_server_seq.max(event.server_seq);
            if event.client_id == local_client_id
                && same_client_event_already_applied(conn, &page.season_id, event)?
            {
                continue;
            }
            if should_skip_orphan_modification_event(conn, &page.season_id, event)? {
                eprintln!(
                    "[native-orphan-modification] skipped stale modification event {} for missing leg {}",
                    event.event_id, event.target_id
                );
                continue;
            }
            update_entity_versions(conn, &page.season_id, event)?;
            let overlap = local_pending_overlap(conn, &page.season_id, event)?;
            if !overlap.is_empty() {
                let conflict = build_conflict(conn, &page.season_id, event, &overlap)?;
                append_conflict(&mut sync_meta, conflict);
                continue;
            }
            if let Some(target) = apply_event_data(conn, &page.season_id, event)? {
                changed_targets.push(target);
            }
        }

        changed_targets.sort();
        changed_targets.dedup();
        let conflict_count = write_sync_meta(conn, &page.season_id, sync_meta, last_server_seq)?;
        Ok::<_, rusqlite::Error>(NativeCatchupPageResult {
            changed_targets,
            conflict_count,
            last_server_seq,
        })
    })();

    match result {
        Ok(page_result) => {
            conn.execute_batch("COMMIT")?;
            Ok(page_result)
        }
        Err(error) => {
            let _ = conn.execute_batch("ROLLBACK");
            Err(error)
        }
    }
}

fn db_path(app: &AppHandle) -> Result<PathBuf, String> {
    let app_config_dir = app
        .path()
        .app_config_dir()
        .map_err(|error| format!("Could not resolve app config directory: {error}"))?;
    std::fs::create_dir_all(&app_config_dir)
        .map_err(|error| format!("Could not create app config directory: {error}"))?;
    Ok(app_config_dir.join(DB_FILE_NAME))
}

fn open_native_db(app: &AppHandle) -> Result<Connection, String> {
    let path = db_path(app)?;
    let conn = Connection::open(path)
        .map_err(|error| format!("Could not open local SQLite database: {error}"))?;
    initialize_native_db_connection(&conn)
        .map_err(|error| format!("Could not initialize native SQLite schema: {error}"))?;
    Ok(conn)
}

fn is_cancelled(state: &NativeCatchupState, cancellation_id: &str) -> bool {
    state
        .cancelled
        .lock()
        .map(|cancelled| cancelled.contains(cancellation_id))
        .unwrap_or(false)
}

fn encode_query_component(value: &str) -> String {
    let mut encoded = String::new();
    for byte in value.bytes() {
        let is_unreserved =
            byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b'~');
        if is_unreserved {
            encoded.push(char::from(byte));
        } else {
            encoded.push_str(&format!("%{byte:02X}"));
        }
    }
    encoded
}

async fn wait_for_refreshed_token_for(
    app: &AppHandle,
    state: &NativeCatchupState,
    season_id: &str,
    cancellation_id: &str,
    cancel_message: &str,
) -> Result<String, String> {
    app.emit(
        "season-catchup-token-required",
        TokenRequiredEvent {
            season_id: season_id.to_string(),
            cancellation_id: cancellation_id.to_string(),
        },
    )
    .map_err(|error| format!("Could not request refreshed token: {error}"))?;

    let mut waited = 0;
    while waited <= TOKEN_REFRESH_TIMEOUT_MS {
        if is_cancelled(state, cancellation_id) {
            return Err(cancel_message.to_string());
        }
        if let Some(token) = state
            .refreshed_tokens
            .lock()
            .map_err(|_| "Native catch-up token state is unavailable.".to_string())?
            .remove(cancellation_id)
        {
            app.emit(
                "season-catchup-token-refreshed",
                TokenRequiredEvent {
                    season_id: season_id.to_string(),
                    cancellation_id: cancellation_id.to_string(),
                },
            )
            .ok();
            return Ok(token);
        }
        tokio::time::sleep(Duration::from_millis(TOKEN_REFRESH_POLL_MS)).await;
        waited += TOKEN_REFRESH_POLL_MS;
    }
    Err("Native catch-up could not refresh the Supabase session token.".to_string())
}

async fn wait_for_refreshed_token(
    app: &AppHandle,
    state: &NativeCatchupState,
    input: &RunSeasonCatchupInput,
) -> Result<String, String> {
    wait_for_refreshed_token_for(
        app,
        state,
        &input.season_id,
        &input.cancellation_id,
        "Native catch-up cancelled while waiting for a refreshed token.",
    )
    .await
}

async fn fetch_event_page(
    client: &reqwest::Client,
    input: &RunSeasonCatchupInput,
    token: &str,
    cursor: i64,
) -> Result<NativeCatchupEventPage, reqwest::Error> {
    let url = format!(
        "{}/rest/v1/rpc/get_season_change_event_page",
        input.supabase_url.trim_end_matches('/')
    );
    client
        .post(url)
        .header("apikey", &input.anon_key)
        .bearer_auth(token)
        .json(&json!({
            "p_season_id": input.season_id,
            "p_after_seq": cursor,
            "p_through_seq": input.server_high_water,
            "p_limit": input.page_size.unwrap_or(200).clamp(1, 500),
        }))
        .send()
        .await?
        .error_for_status()?
        .json::<NativeCatchupEventPage>()
        .await
}

#[derive(Debug, Deserialize)]
struct RemoteFlightRecordManifestRow {
    record_id: String,
}

async fn fetch_remote_flight_record_manifest(
    client: &reqwest::Client,
    input: &RunSeasonCatchupInput,
    token: &str,
) -> Result<HashSet<String>, reqwest::Error> {
    let mut record_ids = HashSet::new();
    let limit = 1_000_i64;
    let mut offset = 0_i64;
    loop {
        let url = format!(
            "{}/rest/v1/season_flight_records?season_id=eq.{}&select=record_id&order=record_id.asc&limit={limit}&offset={offset}",
            input.supabase_url.trim_end_matches('/'),
            encode_query_component(&input.season_id),
        );
        let rows = client
            .get(url)
            .header("apikey", &input.anon_key)
            .bearer_auth(token)
            .send()
            .await?
            .error_for_status()?
            .json::<Vec<RemoteFlightRecordManifestRow>>()
            .await?;
        let row_count = rows.len();
        record_ids.extend(rows.into_iter().map(|row| row.record_id));
        if row_count < usize::try_from(limit).unwrap_or(1_000) {
            break;
        }
        offset += limit;
    }
    Ok(record_ids)
}

async fn post_pending_sync_events(
    client: &reqwest::Client,
    input: &NativeSyncPendingChangesInput,
    access_token: &str,
    pending_events: &[Value],
    base_server_seq: i64,
) -> Result<NativeSyncPendingRpcResult, NativeHttpError> {
    let url = format!(
        "{}/rest/v1/rpc/sync_season_workspace_v2",
        input.supabase_url.trim_end_matches('/')
    );
    let response = client
        .post(url)
        .header("apikey", &input.anon_key)
        .bearer_auth(access_token)
        .json(&json!({
            "p_season_id": input.season_id,
            "p_client_id": input.client_id,
            "p_base_server_seq": base_server_seq,
            "p_pending_events": pending_events,
        }))
        .send()
        .await
        .map_err(|error| NativeHttpError {
            status_code: error.status().map(|status| status.as_u16()),
            message: error.to_string(),
        })?;
    let status = response.status();
    if !status.is_success() {
        let body = response
            .text()
            .await
            .unwrap_or_else(|error| format!("<could not read response body: {error}>"));
        return Err(NativeHttpError {
            status_code: Some(status.as_u16()),
            message: format!("HTTP status {}: {}", status.as_u16(), body),
        });
    }
    response
        .json::<NativeSyncPendingRpcResult>()
        .await
        .map_err(|error| NativeHttpError {
            status_code: error.status().map(|status| status.as_u16()),
            message: error.to_string(),
        })
}

pub async fn upload_native_pending_chunks_with_retry<Upload, UploadFuture, Refresh, RefreshFuture>(
    pending_chunks: &[Vec<Value>],
    initial_base_server_seq: i64,
    initial_next_server_version: i64,
    initial_access_token: String,
    mut upload: Upload,
    mut refresh_access_token: Refresh,
) -> Result<NativeSyncPendingRpcResult, NativeHttpError>
where
    Upload: FnMut(String, Vec<Value>, i64) -> UploadFuture,
    UploadFuture: Future<Output = Result<NativeSyncPendingRpcResult, NativeHttpError>>,
    Refresh: FnMut() -> RefreshFuture,
    RefreshFuture: Future<Output = Result<String, NativeHttpError>>,
{
    let mut base_server_seq = initial_base_server_seq;
    let mut access_token = initial_access_token;
    let mut rpc_result = NativeSyncPendingRpcResult {
        applied_events: Vec::new(),
        conflict_events: Vec::new(),
        next_server_seq: base_server_seq,
        server_high_water: base_server_seq,
        next_server_version: initial_next_server_version,
    };

    for chunk in pending_chunks {
        let mut retried_after_refresh = false;
        let chunk_result = loop {
            match upload(access_token.clone(), chunk.clone(), base_server_seq).await {
                Ok(result) => break result,
                Err(error)
                    if error.status_code.is_some_and(should_request_token_refresh)
                        && !retried_after_refresh =>
                {
                    access_token = refresh_access_token().await?;
                    retried_after_refresh = true;
                    continue;
                }
                Err(error) => return Err(error),
            }
        };
        base_server_seq = chunk_result.next_server_seq;
        rpc_result
            .applied_events
            .extend(chunk_result.applied_events.into_iter());
        rpc_result
            .conflict_events
            .extend(chunk_result.conflict_events.into_iter());
        rpc_result.next_server_seq = chunk_result.next_server_seq;
        rpc_result.server_high_water = rpc_result
            .server_high_water
            .max(chunk_result.server_high_water);
        rpc_result.next_server_version = chunk_result.next_server_version;
    }

    Ok(rpc_result)
}

async fn flush_schedule_notifications(
    client: &reqwest::Client,
    input: &NativeSyncPendingChangesInput,
) -> Result<NativeNotificationFlushResponse, reqwest::Error> {
    let url = format!(
        "{}/functions/v1/schedule-telegram-notify",
        input.supabase_url.trim_end_matches('/')
    );
    client
        .post(url)
        .header("apikey", &input.anon_key)
        .bearer_auth(&input.access_token)
        .json(&json!({
            "seasonId": input.season_id,
            "limit": NOTIFICATION_FLUSH_LIMIT,
        }))
        .send()
        .await?
        .error_for_status()?
        .json::<NativeNotificationFlushResponse>()
        .await
}

pub async fn run_native_season_catchup(
    app: AppHandle,
    state: State<'_, SharedNativeCatchupState>,
    input: RunSeasonCatchupInput,
) -> Result<NativeCatchupResult, String> {
    let state = state.inner().clone();
    let _writer_guard = state.writer_lock.lock().await;
    let conn = open_native_db(&app)?;
    let http = reqwest::Client::new();
    let mut token = input.access_token.clone();
    let mut cursor = input.local_cursor;
    let mut committed_pages = 0_usize;
    let mut applied_events = 0_usize;
    let mut checkpoint_count = 0_usize;
    let mut changed_targets = Vec::new();
    let mut conflict_count = 0_usize;
    let mut reconciled_flight_rows = 0_usize;
    let mut reconciled_modification_rows = 0_usize;
    let mut reconciled_entity_versions = 0_usize;

    while cursor < input.server_high_water {
        if is_cancelled(&state, &input.cancellation_id) {
            return Err("Native catch-up cancelled.".to_string());
        }
        let mut retried_after_refresh = false;
        let mut fetch_retry_index = 0_usize;
        let page = loop {
            match fetch_event_page(&http, &input, &token, cursor).await {
                Ok(mut page) => {
                    if page.season_id.is_empty() {
                        page.season_id = input.season_id.clone();
                    }
                    break page;
                }
                Err(error) => {
                    let status = error
                        .status()
                        .map(|status| status.as_u16())
                        .unwrap_or_default();
                    if should_request_token_refresh(status) && !retried_after_refresh {
                        token = wait_for_refreshed_token(&app, &state, &input).await?;
                        retried_after_refresh = true;
                        continue;
                    }
                    if should_request_page_fetch_retry(status)
                        && fetch_retry_index < PAGE_FETCH_RETRY_DELAYS_MS.len()
                    {
                        let delay = PAGE_FETCH_RETRY_DELAYS_MS[fetch_retry_index];
                        fetch_retry_index += 1;
                        tokio::time::sleep(Duration::from_millis(delay)).await;
                        continue;
                    }
                    return Err(format!("Native catch-up page fetch failed: {error}"));
                }
            }
        };
        if page.events.is_empty() || page.next_cursor <= cursor {
            break;
        }
        let page_result = apply_event_page(&conn, &page, &input.client_id)
            .map_err(|error| format!("Native catch-up SQLite apply failed: {error}"))?;
        cursor = page.next_cursor;
        committed_pages += 1;
        applied_events += page.events.len();
        conflict_count = page_result.conflict_count;
        changed_targets.extend(page_result.changed_targets);
        changed_targets.sort();
        changed_targets.dedup();

        let checkpoint = checkpoint_mode_for_committed_pages(committed_pages, false);
        if checkpoint == Some(WalCheckpointMode::Passive) {
            run_passive_checkpoint(&conn)
                .map_err(|error| format!("Native catch-up WAL checkpoint failed: {error}"))?;
            checkpoint_count += 1;
            app.emit(
                "season-catchup-checkpoint",
                CheckpointEvent {
                    season_id: input.season_id.clone(),
                    cancellation_id: input.cancellation_id.clone(),
                    mode: WalCheckpointMode::Passive,
                    committed_pages,
                },
            )
            .ok();
        }

        app.emit(
            "season-catchup-progress",
            CatchupProgressEvent {
                season_id: input.season_id.clone(),
                cancellation_id: input.cancellation_id.clone(),
                committed_pages,
                applied_events,
                last_server_seq: cursor,
                server_high_water: input.server_high_water,
                changed_targets: changed_targets.clone(),
                checkpoint,
            },
        )
        .ok();

        if !page.has_more {
            break;
        }
    }

    if input.reconcile_manifest {
        let remote_record_ids = match fetch_remote_flight_record_manifest(&http, &input, &token)
            .await
        {
            Ok(record_ids) => record_ids,
            Err(error) => {
                let status = error
                    .status()
                    .map(|status| status.as_u16())
                    .unwrap_or_default();
                if should_request_token_refresh(status) {
                    token = wait_for_refreshed_token(&app, &state, &input).await?;
                    fetch_remote_flight_record_manifest(&http, &input, &token)
                        .await
                        .map_err(|retry_error| {
                            format!(
                                "Native catch-up manifest fetch failed after token refresh: {retry_error}"
                            )
                        })?
                } else {
                    return Err(format!("Native catch-up manifest fetch failed: {error}"));
                }
            }
        };
        let local_current_rows = conn
            .query_row(
                "SELECT COUNT(*) FROM local_flight_records WHERE season_id = ? AND is_base = 0",
                params![&input.season_id],
                |row| row.get::<_, i64>(0),
            )
            .map_err(|error| format!("Native catch-up manifest local count failed: {error}"))?;
        if remote_record_ids.is_empty() && local_current_rows > 0 {
            return Err(
                "Native catch-up manifest was empty while local records exist; refusing to prune."
                    .to_string(),
            );
        }
        let reconcile_result = reconcile_flight_record_manifest_on_connection(
            &conn,
            &input.season_id,
            &remote_record_ids,
        )
        .map_err(|error| format!("Native catch-up manifest reconciliation failed: {error}"))?;
        reconciled_flight_rows = reconcile_result.removed_flight_rows;
        reconciled_modification_rows = reconcile_result.removed_modification_rows;
        reconciled_entity_versions = reconcile_result.removed_entity_versions;
        changed_targets.extend(
            reconcile_result
                .removed_record_ids
                .iter()
                .map(|record_id| format!("flightRecord:{record_id}")),
        );
        changed_targets.sort();
        changed_targets.dedup();
    }

    Ok(NativeCatchupResult {
        season_id: input.season_id,
        committed_pages,
        applied_events,
        conflict_count,
        changed_targets,
        last_server_seq: cursor,
        checkpoint_count,
        reconciled_flight_rows,
        reconciled_modification_rows,
        reconciled_entity_versions,
    })
}

pub async fn apply_native_local_modification_batch_delta(
    app: AppHandle,
    state: State<'_, SharedNativeCatchupState>,
    input: ApplyLocalModificationBatchDeltaInput,
) -> Result<ApplyLocalModificationBatchDeltaResult, String> {
    let state = state.inner().clone();
    let _writer_guard = state.writer_lock.lock().await;
    let conn = open_native_db(&app)?;
    let affected_ids = input
        .mods
        .iter()
        .filter_map(|modification| value_to_string(modification.get("legId")))
        .collect::<Vec<_>>();
    let sync_meta = apply_local_modification_batch_delta_to_connection(&conn, &input)
        .map_err(|error| format!("Native local SQLite modification commit failed: {error}"))?;
    app.emit(
        "schedule-mutated",
        ScheduleMutatedEvent {
            season_id: input.season_id.clone(),
            revision: sync_meta
                .get("localRevision")
                .and_then(Value::as_i64)
                .unwrap_or(0),
            affected_ids: affected_ids.clone(),
            affected_windows: Vec::new(),
        },
    )
    .ok();
    Ok(ApplyLocalModificationBatchDeltaResult {
        sync_meta,
        affected_ids,
    })
}

pub async fn apply_native_schedule_mutation(
    app: AppHandle,
    state: State<'_, SharedNativeCatchupState>,
    input: ApplyScheduleMutationInput,
) -> Result<ApplyScheduleMutationResult, String> {
    let state = state.inner().clone();
    let _writer_guard = state.writer_lock.lock().await;
    let conn = open_native_db(&app)?;
    let affected_ids = input
        .records
        .iter()
        .filter_map(|record| value_to_string(record.get("id")))
        .chain(input.source_rows.iter().filter_map(|row| {
            value_to_i64(row.get("rowIndex").or_else(|| row.get("row_index")))
                .map(|row_index| row_index.to_string())
        }))
        .chain(
            input
                .mods
                .iter()
                .filter_map(|modification| value_to_string(modification.get("legId"))),
        )
        .chain(input.deleted_ids.iter().cloned())
        .collect::<Vec<_>>();
    let sync_meta = apply_schedule_mutation_to_connection(&conn, &input)
        .map_err(|error| format!("Native schedule mutation failed: {error}"))?;
    app.emit(
        "schedule-mutated",
        ScheduleMutatedEvent {
            season_id: input.season_id.clone(),
            revision: sync_meta
                .get("localRevision")
                .and_then(Value::as_i64)
                .unwrap_or(0),
            affected_ids,
            affected_windows: Vec::new(),
        },
    )
    .ok();
    Ok(ApplyScheduleMutationResult { sync_meta })
}

pub async fn ensure_native_local_season(
    app: AppHandle,
    state: State<'_, SharedNativeCatchupState>,
    input: EnsureLocalSeasonInput,
) -> Result<EnsureLocalSeasonResult, String> {
    let state = state.inner().clone();
    let _writer_guard = state.writer_lock.lock().await;
    let conn = open_native_db(&app)?;
    ensure_local_season_on_connection(&conn, &input)
        .map_err(|error| format!("Native local season bootstrap failed: {error}"))
}

pub async fn import_native_season_snapshot(
    app: AppHandle,
    state: State<'_, SharedNativeCatchupState>,
    input: ImportSeasonSnapshotInput,
) -> Result<ImportSeasonSnapshotResult, String> {
    let state = state.inner().clone();
    let _writer_guard = state.writer_lock.lock().await;
    let conn = open_native_db(&app)?;
    let imported = import_season_snapshot_on_connection(&conn, &input)?;
    app.emit(
        "schedule-mutated",
        ScheduleMutatedEvent {
            season_id: imported.season_id.clone(),
            revision: imported
                .sync_meta
                .get("localRevision")
                .and_then(Value::as_i64)
                .unwrap_or(0),
            affected_ids: Vec::new(),
            affected_windows: Vec::new(),
        },
    )
    .ok();
    Ok(imported)
}

pub async fn merge_native_season_snapshot(
    app: AppHandle,
    state: State<'_, SharedNativeCatchupState>,
    input: MergeSeasonSnapshotInput,
) -> Result<MergeSeasonSnapshotResult, String> {
    let state = state.inner().clone();
    let _writer_guard = state.writer_lock.lock().await;
    let conn = open_native_db(&app)?;
    let merged = merge_season_snapshot_on_connection(&conn, &input)?;
    app.emit(
        "schedule-mutated",
        ScheduleMutatedEvent {
            season_id: merged.season_id.clone(),
            revision: merged
                .sync_meta
                .get("localRevision")
                .and_then(Value::as_i64)
                .unwrap_or(0),
            affected_ids: Vec::new(),
            affected_windows: Vec::new(),
        },
    )
    .ok();
    if merged.conflict_count > 0 {
        app.emit(
            "conflict-updated",
            ConflictUpdatedEvent {
                season_id: merged.season_id.clone(),
                conflict_count: merged.conflict_count,
            },
        )
        .ok();
    }
    Ok(merged)
}

pub async fn query_native_season_freshness(
    app: AppHandle,
    input: QuerySeasonFreshnessInput,
) -> Result<QuerySeasonFreshnessResult, String> {
    let conn = open_native_db(&app)?;
    query_season_freshness_on_connection(&conn, &input)
        .map_err(|error| format!("Native season freshness query failed: {error}"))
}

pub async fn check_native_season_integrity(
    app: AppHandle,
    input: CheckSeasonIntegrityInput,
) -> Result<CheckSeasonIntegrityResult, String> {
    let conn = open_native_db(&app)?;
    match check_season_integrity_on_connection(&conn, &input) {
        Ok(result) => Ok(result),
        Err(message) => {
            app.emit(
                "integrity-failed",
                IntegrityFailedEvent {
                    season_id: input.season_id,
                    message: message.clone(),
                },
            )
            .ok();
            Err(message)
        }
    }
}

pub async fn query_native_schedule_window(
    app: AppHandle,
    input: QueryScheduleWindowInput,
) -> Result<QueryScheduleWindowResult, String> {
    let conn = open_native_db(&app)?;
    query_schedule_window_on_connection(&conn, &input)
        .map_err(|error| format!("Native schedule window query failed: {error}"))
}

pub async fn query_native_allocation_window(
    app: AppHandle,
    input: QueryAllocationWindowInput,
) -> Result<QueryAllocationWindowResult, String> {
    let conn = open_native_db(&app)?;
    query_allocation_window_on_connection(&conn, &input)
        .map_err(|error| format!("Native allocation window query failed: {error}"))
}

pub async fn query_native_sync_summary(
    app: AppHandle,
    input: CheckSeasonIntegrityInput,
) -> Result<QuerySyncSummaryResult, String> {
    let conn = open_native_db(&app)?;
    query_sync_summary_on_connection(&conn, &input.season_id)
        .map_err(|error| format!("Native sync summary query failed: {error}"))
}

pub async fn query_native_conflict_summary(
    app: AppHandle,
    input: CheckSeasonIntegrityInput,
) -> Result<QueryConflictSummaryResult, String> {
    let conn = open_native_db(&app)?;
    let result = query_conflict_summary_on_connection(&conn, &input.season_id)
        .map_err(|error| format!("Native conflict summary query failed: {error}"))?;
    app.emit(
        "conflict-updated",
        ConflictUpdatedEvent {
            season_id: result.season_id.clone(),
            conflict_count: result.conflict_count,
        },
    )
    .ok();
    Ok(result)
}

pub async fn resolve_native_season_conflict(
    app: AppHandle,
    state: State<'_, SharedNativeCatchupState>,
    input: ResolveSeasonConflictInput,
) -> Result<ResolveSeasonConflictResult, String> {
    let state = state.inner().clone();
    let _writer_guard = state.writer_lock.lock().await;
    let conn = open_native_db(&app)?;
    let result = resolve_season_conflict_on_connection(&conn, &input)
        .map_err(|error| format!("Native conflict resolution failed: {error}"))?;
    app.emit(
        "schedule-mutated",
        ScheduleMutatedEvent {
            season_id: result.season_id.clone(),
            revision: result
                .sync_meta
                .get("localRevision")
                .and_then(Value::as_i64)
                .unwrap_or(0),
            affected_ids: Vec::new(),
            affected_windows: Vec::new(),
        },
    )
    .ok();
    app.emit(
        "conflict-updated",
        ConflictUpdatedEvent {
            season_id: result.season_id.clone(),
            conflict_count: result.conflict_count,
        },
    )
    .ok();
    Ok(result)
}

pub async fn query_native_source_rows_window(
    app: AppHandle,
    input: QuerySourceRowsWindowInput,
) -> Result<QuerySourceRowsWindowResult, String> {
    let conn = open_native_db(&app)?;
    query_source_rows_window_on_connection(&conn, &input)
        .map_err(|error| format!("Native source rows window query failed: {error}"))
}

pub async fn query_native_dashboard_summary(
    app: AppHandle,
    input: QueryDashboardSummaryInput,
) -> Result<QueryDashboardSummaryResult, String> {
    let conn = open_native_db(&app)?;
    query_dashboard_summary_on_connection(&conn, &input)
        .map_err(|error| format!("Native dashboard summary query failed: {error}"))
}

pub async fn query_native_dashboard_ai_sql(
    app: AppHandle,
    input: QueryNativeDashboardAiSqlInput,
) -> Result<QueryNativeDashboardAiSqlResult, String> {
    let conn = open_native_db(&app)?;
    query_dashboard_ai_sql_on_connection(&conn, &input)
        .map_err(|error| format!("Native dashboard AI SQL query failed: {error}"))
}

pub async fn discard_native_session_edits(
    app: AppHandle,
    state: State<'_, SharedNativeCatchupState>,
    input: NativeSeasonOnlyInput,
) -> Result<DiscardSessionEditsResult, String> {
    let state = state.inner().clone();
    let _writer_guard = state.writer_lock.lock().await;
    let conn = open_native_db(&app)?;
    let result = discard_session_edits_on_connection(&conn, &input)
        .map_err(|error| format!("Native session discard failed: {error}"))?;
    app.emit(
        "session-reset",
        ScheduleMutatedEvent {
            season_id: input.season_id,
            revision: result
                .sync_meta
                .get("localRevision")
                .and_then(Value::as_i64)
                .unwrap_or(0),
            affected_ids: Vec::new(),
            affected_windows: Vec::new(),
        },
    )
    .ok();
    Ok(result)
}

pub async fn sync_native_pending_changes(
    app: AppHandle,
    state: State<'_, SharedNativeCatchupState>,
    input: NativeSyncPendingChangesInput,
) -> Result<NativeSyncPendingChangesResult, String> {
    let state = state.inner().clone();
    let writer_guard = state.writer_lock.lock().await;
    let conn = open_native_db(&app)?;
    let summary = query_sync_summary_on_connection(&conn, &input.season_id)
        .map_err(|error| format!("Native pending sync summary failed: {error}"))?;
    if summary.pending_count == 0 {
        return Ok(NativeSyncPendingChangesResult {
            status: "synced".to_string(),
            message: if summary.conflict_count > 0 {
                format!(
                    "{} item{} need review. No unrelated local changes to sync.",
                    summary.conflict_count,
                    if summary.conflict_count == 1 { "" } else { "s" }
                )
            } else {
                "No local changes to sync.".to_string()
            },
            pending_count: 0,
            conflict_count: summary.conflict_count,
            notification_sent: 0,
            notification_failed: 0,
            notification_skipped: 0,
            notification_flush_error: None,
            auto_resolved_conflict_count: 0,
            auto_resolved_conflict_ids: Vec::new(),
        });
    }

    let pending_chunks = build_native_pending_sync_chunks(
        &conn,
        &input.season_id,
        &input.client_id,
        chrono_like_millis(),
    )
    .map_err(|error| format!("Native pending event build failed: {error}"))?;
    let pending_events = pending_chunks.iter().flatten().cloned().collect::<Vec<_>>();
    let sync_meta = read_sync_meta(&conn, &input.season_id)
        .map_err(|error| format!("Native sync metadata read failed: {error}"))?;
    let base_server_seq = sync_meta
        .get("lastServerSeq")
        .and_then(Value::as_i64)
        .or_else(|| sync_meta.get("baseServerVersion").and_then(Value::as_i64))
        .unwrap_or(0);
    let http = reqwest::Client::new();
    let initial_next_server_version = sync_meta
        .get("baseServerVersion")
        .and_then(Value::as_i64)
        .unwrap_or(0);
    let rpc_result = upload_native_pending_chunks_with_retry(
        &pending_chunks,
        base_server_seq,
        initial_next_server_version,
        input.access_token.clone(),
        |access_token, chunk, base_server_seq| {
            let http = &http;
            let input = &input;
            async move {
                post_pending_sync_events(http, input, &access_token, &chunk, base_server_seq).await
            }
        },
        || {
            let app = &app;
            let state = &state;
            let input = &input;
            async move {
                let Some(cancellation_id) = input.cancellation_id.as_deref() else {
                    return Err(NativeHttpError {
                        status_code: Some(401),
                        message: "Native pending upload failed with HTTP 401 and no token refresh channel."
                            .to_string(),
                    });
                };
                wait_for_refreshed_token_for(
                    app,
                    state,
                    &input.season_id,
                    cancellation_id,
                    "Native pending upload cancelled while waiting for a refreshed token.",
                )
                .await
                .map_err(|error| NativeHttpError {
                    status_code: Some(401),
                    message: error,
                })
            }
        },
    )
    .await
    .map_err(|error| format!("Native pending upload failed: {error}"))?;
    if let Err(error) = validate_pending_sync_result_coverage(
        &pending_events,
        &rpc_result.applied_events,
        &rpc_result.conflict_events,
    ) {
        let result = NativeSyncPendingChangesResult {
            status: "failed".to_string(),
            message: error,
            pending_count: summary.pending_count,
            conflict_count: summary.conflict_count,
            notification_sent: 0,
            notification_failed: 0,
            notification_skipped: 0,
            notification_flush_error: None,
            auto_resolved_conflict_count: 0,
            auto_resolved_conflict_ids: Vec::new(),
        };
        app.emit(
            "sync-failed",
            json!({
                "seasonId": input.season_id,
                "message": result.message,
                "pendingCount": result.pending_count,
                "conflictCount": result.conflict_count,
            }),
        )
        .ok();
        return Ok(result);
    }

    let (remaining_conflict_events, auto_resolved_conflict_ids) =
        if rpc_result.conflict_events.is_empty() {
            (Vec::new(), Vec::new())
        } else {
            auto_resolve_remote_latest_conflict_events(
                &conn,
                &input.season_id,
                &rpc_result.conflict_events,
            )
            .map_err(|error| format!("Native pending auto-resolve failed: {error}"))?
        };
    let auto_resolved_conflict_count = auto_resolved_conflict_ids.len();

    let mut result = if remaining_conflict_events.is_empty() {
        let next_sync_meta = finalize_successful_pending_sync(&conn, &input.season_id, &rpc_result)
            .map_err(|error| format!("Native pending sync finalize failed: {error}"))?;
        app.emit(
            "schedule-mutated",
            ScheduleMutatedEvent {
                season_id: input.season_id.clone(),
                revision: next_sync_meta
                    .get("localRevision")
                    .and_then(Value::as_i64)
                    .unwrap_or(0),
                affected_ids: rpc_result
                    .applied_events
                    .iter()
                    .map(|event| event.target_id.clone())
                    .collect(),
                affected_windows: Vec::new(),
            },
        )
        .ok();
        NativeSyncPendingChangesResult {
            status: "synced".to_string(),
            message: if auto_resolved_conflict_count > 0 {
                format!(
                    "Local changes synced. Auto-applied {} remote allocation change{}.",
                    auto_resolved_conflict_count,
                    if auto_resolved_conflict_count == 1 {
                        ""
                    } else {
                        "s"
                    }
                )
            } else {
                "Local changes synced.".to_string()
            },
            pending_count: 0,
            conflict_count: 0,
            notification_sent: 0,
            notification_failed: 0,
            notification_skipped: 0,
            notification_flush_error: None,
            auto_resolved_conflict_count,
            auto_resolved_conflict_ids,
        }
    } else {
        let next_sync_meta =
            mark_pending_sync_conflict(&conn, &input.season_id, &remaining_conflict_events)
                .map_err(|error| format!("Native pending conflict persist failed: {error}"))?;
        let conflict_count = next_sync_meta
            .get("conflicts")
            .and_then(Value::as_array)
            .map(Vec::len)
            .unwrap_or(remaining_conflict_events.len());
        app.emit(
            "conflict-updated",
            ConflictUpdatedEvent {
                season_id: input.season_id.clone(),
                conflict_count,
            },
        )
        .ok();
        NativeSyncPendingChangesResult {
            status: "conflict".to_string(),
            message: format!(
                "Synced non-conflicting changes. {} item{} need review.",
                conflict_count,
                if conflict_count == 1 { "" } else { "s" }
            ),
            pending_count: summary.pending_count,
            conflict_count,
            notification_sent: 0,
            notification_failed: 0,
            notification_skipped: 0,
            notification_flush_error: None,
            auto_resolved_conflict_count,
            auto_resolved_conflict_ids,
        }
    };

    drop(writer_guard);

    if summary.pending_count > 0 && (result.status == "synced" || result.status == "conflict") {
        match flush_schedule_notifications(&http, &input).await {
            Ok(flush) => {
                result.notification_sent = flush.sent;
                result.notification_failed = flush.failed;
                result.notification_skipped = flush.skipped;
            }
            Err(error) => {
                result.notification_flush_error = Some(format!(
                    "Schedule Telegram notification flush failed: {error}"
                ));
            }
        }
    }

    if result.status == "failed" {
        app.emit(
            "sync-failed",
            json!({
                "seasonId": input.season_id,
                "message": result.message,
                "pendingCount": result.pending_count,
                "conflictCount": result.conflict_count,
            }),
        )
        .ok();
    }
    Ok(result)
}

pub fn refresh_native_catchup_token(
    state: State<'_, SharedNativeCatchupState>,
    input: RefreshSeasonCatchupTokenInput,
) -> Result<(), String> {
    state
        .refreshed_tokens
        .lock()
        .map_err(|_| "Native catch-up token state is unavailable.".to_string())?
        .insert(input.cancellation_id, input.access_token);
    Ok(())
}

pub fn cancel_native_catchup(
    state: State<'_, SharedNativeCatchupState>,
    input: CancelSeasonCatchupInput,
) -> Result<(), String> {
    state
        .cancelled
        .lock()
        .map_err(|_| "Native catch-up cancellation state is unavailable.".to_string())?
        .insert(input.cancellation_id);
    Ok(())
}
