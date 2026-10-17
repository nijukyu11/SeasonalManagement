use base64::{engine::general_purpose, Engine as _};
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command as StdCommand;
use tauri::Manager;

pub mod native_catchup;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SaveExportFileInput {
    file_name: String,
    mime_type: String,
    base64: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ExportSaveResult {
    file_name: String,
    mime_type: String,
    size_bytes: usize,
    native: bool,
    saved_at: String,
    file_path: String,
    directory: String,
}

fn sanitize_export_file_name(file_name: &str) -> String {
    let mut sanitized = String::with_capacity(file_name.len());
    for ch in file_name.trim().chars() {
        if matches!(ch, '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*') || ch.is_control() {
            sanitized.push('_');
        } else {
            sanitized.push(ch);
        }
    }
    let trimmed = sanitized.trim_matches(['.', ' ']).to_string();
    if trimmed.is_empty() {
        "export".to_string()
    } else {
        trimmed
    }
}

fn downloads_dir() -> Result<PathBuf, String> {
    dirs::download_dir().ok_or_else(|| "Could not resolve Windows Downloads folder".to_string())
}

fn ensure_downloads_path(path: &Path) -> Result<PathBuf, String> {
    let downloads = downloads_dir()?;
    fs::create_dir_all(&downloads)
        .map_err(|error| format!("Could not create Downloads folder: {error}"))?;
    let downloads_canonical = downloads
        .canonicalize()
        .map_err(|error| format!("Could not resolve Downloads folder: {error}"))?;
    let canonical = path
        .canonicalize()
        .map_err(|error| format!("Could not resolve export path: {error}"))?;
    if !canonical.starts_with(&downloads_canonical) {
        return Err("Export path is outside the Downloads folder".to_string());
    }
    Ok(canonical)
}

fn unique_download_path(downloads: &Path, file_name: &str) -> PathBuf {
    let requested = Path::new(file_name);
    let stem = requested
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or("export");
    let extension = requested
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or("");
    let mut candidate = downloads.join(file_name);
    let mut suffix = 1;
    while candidate.exists() {
        let next_name = if extension.is_empty() {
            format!("{stem}-{suffix}")
        } else {
            format!("{stem}-{suffix}.{extension}")
        };
        candidate = downloads.join(next_name);
        suffix += 1;
    }
    candidate
}

fn validate_export_extension(file_name: &str) -> Result<(), String> {
    let extension = Path::new(file_name)
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    match extension.as_str() {
        "xlsx" | "pdf" => Ok(()),
        _ => Err("Only .xlsx and .pdf exports are allowed".to_string()),
    }
}

#[tauri::command]
fn save_export_file(input: SaveExportFileInput) -> Result<ExportSaveResult, String> {
    let file_name = sanitize_export_file_name(&input.file_name);
    validate_export_extension(&file_name)?;
    let bytes = general_purpose::STANDARD
        .decode(input.base64)
        .map_err(|error| format!("Invalid export bytes: {error}"))?;
    let downloads = downloads_dir()?;
    fs::create_dir_all(&downloads)
        .map_err(|error| format!("Could not create Downloads folder: {error}"))?;
    let file_path = unique_download_path(&downloads, &file_name);
    if file_path.parent() != Some(downloads.as_path()) {
        return Err("Export filename resolved outside Downloads".to_string());
    }
    fs::write(&file_path, &bytes)
        .map_err(|error| format!("Could not write export file: {error}"))?;
    let canonical = ensure_downloads_path(&file_path)?;
    let saved_file_name = canonical
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or(&file_name)
        .to_string();
    Ok(ExportSaveResult {
        file_name: saved_file_name,
        mime_type: input.mime_type,
        size_bytes: bytes.len(),
        native: true,
        saved_at: chrono_like_timestamp(),
        file_path: canonical.to_string_lossy().to_string(),
        directory: downloads.to_string_lossy().to_string(),
    })
}

fn chrono_like_timestamp() -> String {
    format!("{:?}", std::time::SystemTime::now())
}

#[tauri::command]
fn open_export_file(file_path: String) -> Result<(), String> {
    let canonical = ensure_downloads_path(Path::new(&file_path))?;
    let path_string = canonical.to_string_lossy().to_string();
    StdCommand::new("cmd")
        .args(["/C", "start", "", &path_string])
        .spawn()
        .map_err(|error| format!("Could not open export file: {error}"))?;
    Ok(())
}

#[tauri::command]
fn reveal_export_file(file_path: String) -> Result<(), String> {
    let canonical = ensure_downloads_path(Path::new(&file_path))?;
    let path_string = canonical.to_string_lossy().to_string();
    StdCommand::new("explorer")
        .arg(format!("/select,{path_string}"))
        .spawn()
        .map_err(|error| format!("Could not reveal export file: {error}"))?;
    Ok(())
}


#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(native_catchup::create_native_catchup_state())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.unminimize();
                let _ = window.show();
                let _ = window.set_focus();
            }
        }))
        .plugin(tauri_plugin_sql::Builder::default().build())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .invoke_handler(tauri::generate_handler![
            save_export_file,
            open_export_file,
            reveal_export_file,
            run_season_catchup,
            apply_local_modification_batch_delta,
            apply_schedule_mutation,
            apply_allocation_mutation,
            ensure_local_season,
            import_season_snapshot,
            merge_season_snapshot,
            query_season_freshness,
            check_season_integrity,
            query_schedule_window,
            query_allocation_window,
            query_source_rows_window,
            query_dashboard_summary,
            query_sync_summary,
            query_conflict_summary,
            resolve_season_conflict,
            discard_session_edits,
            sync_pending_changes,
            refresh_season_catchup_token,
            cancel_season_catchup
        ])
        .run(tauri::generate_context!())
        .expect("error while running Seasonal Management");
}

#[tauri::command]
async fn run_season_catchup(
    app: tauri::AppHandle,
    state: tauri::State<'_, native_catchup::SharedNativeCatchupState>,
    input: native_catchup::RunSeasonCatchupInput,
) -> Result<native_catchup::NativeCatchupResult, String> {
    native_catchup::run_native_season_catchup(app, state, input).await
}

#[tauri::command]
async fn apply_local_modification_batch_delta(
    app: tauri::AppHandle,
    state: tauri::State<'_, native_catchup::SharedNativeCatchupState>,
    input: native_catchup::ApplyLocalModificationBatchDeltaInput,
) -> Result<native_catchup::ApplyLocalModificationBatchDeltaResult, String> {
    native_catchup::apply_native_local_modification_batch_delta(app, state, input).await
}

#[tauri::command]
async fn apply_schedule_mutation(
    app: tauri::AppHandle,
    state: tauri::State<'_, native_catchup::SharedNativeCatchupState>,
    input: native_catchup::ApplyScheduleMutationInput,
) -> Result<native_catchup::ApplyScheduleMutationResult, String> {
    native_catchup::apply_native_schedule_mutation(app, state, input).await
}

#[tauri::command]
async fn apply_allocation_mutation(
    app: tauri::AppHandle,
    state: tauri::State<'_, native_catchup::SharedNativeCatchupState>,
    input: native_catchup::ApplyLocalModificationBatchDeltaInput,
) -> Result<native_catchup::ApplyLocalModificationBatchDeltaResult, String> {
    native_catchup::apply_native_local_modification_batch_delta(app, state, input).await
}

#[tauri::command]
async fn ensure_local_season(
    app: tauri::AppHandle,
    state: tauri::State<'_, native_catchup::SharedNativeCatchupState>,
    input: native_catchup::EnsureLocalSeasonInput,
) -> Result<native_catchup::EnsureLocalSeasonResult, String> {
    native_catchup::ensure_native_local_season(app, state, input).await
}

#[tauri::command]
async fn import_season_snapshot(
    app: tauri::AppHandle,
    state: tauri::State<'_, native_catchup::SharedNativeCatchupState>,
    input: native_catchup::ImportSeasonSnapshotInput,
) -> Result<native_catchup::ImportSeasonSnapshotResult, String> {
    native_catchup::import_native_season_snapshot(app, state, input).await
}

#[tauri::command]
async fn merge_season_snapshot(
    app: tauri::AppHandle,
    state: tauri::State<'_, native_catchup::SharedNativeCatchupState>,
    input: native_catchup::MergeSeasonSnapshotInput,
) -> Result<native_catchup::MergeSeasonSnapshotResult, String> {
    native_catchup::merge_native_season_snapshot(app, state, input).await
}

#[tauri::command]
async fn query_season_freshness(
    app: tauri::AppHandle,
    input: native_catchup::QuerySeasonFreshnessInput,
) -> Result<native_catchup::QuerySeasonFreshnessResult, String> {
    native_catchup::query_native_season_freshness(app, input).await
}

#[tauri::command]
async fn check_season_integrity(
    app: tauri::AppHandle,
    input: native_catchup::CheckSeasonIntegrityInput,
) -> Result<native_catchup::CheckSeasonIntegrityResult, String> {
    native_catchup::check_native_season_integrity(app, input).await
}

#[tauri::command]
async fn query_schedule_window(
    app: tauri::AppHandle,
    input: native_catchup::QueryScheduleWindowInput,
) -> Result<native_catchup::QueryScheduleWindowResult, String> {
    native_catchup::query_native_schedule_window(app, input).await
}

#[tauri::command]
async fn query_allocation_window(
    app: tauri::AppHandle,
    input: native_catchup::QueryAllocationWindowInput,
) -> Result<native_catchup::QueryAllocationWindowResult, String> {
    native_catchup::query_native_allocation_window(app, input).await
}

#[tauri::command]
async fn query_source_rows_window(
    app: tauri::AppHandle,
    input: native_catchup::QuerySourceRowsWindowInput,
) -> Result<native_catchup::QuerySourceRowsWindowResult, String> {
    native_catchup::query_native_source_rows_window(app, input).await
}

#[tauri::command]
async fn query_dashboard_summary(
    app: tauri::AppHandle,
    input: native_catchup::QueryDashboardSummaryInput,
) -> Result<native_catchup::QueryDashboardSummaryResult, String> {
    native_catchup::query_native_dashboard_summary(app, input).await
}


#[tauri::command]
async fn query_sync_summary(
    app: tauri::AppHandle,
    input: native_catchup::CheckSeasonIntegrityInput,
) -> Result<native_catchup::QuerySyncSummaryResult, String> {
    native_catchup::query_native_sync_summary(app, input).await
}

#[tauri::command]
async fn query_conflict_summary(
    app: tauri::AppHandle,
    input: native_catchup::CheckSeasonIntegrityInput,
) -> Result<native_catchup::QueryConflictSummaryResult, String> {
    native_catchup::query_native_conflict_summary(app, input).await
}

#[tauri::command]
async fn resolve_season_conflict(
    app: tauri::AppHandle,
    state: tauri::State<'_, native_catchup::SharedNativeCatchupState>,
    input: native_catchup::ResolveSeasonConflictInput,
) -> Result<native_catchup::ResolveSeasonConflictResult, String> {
    native_catchup::resolve_native_season_conflict(app, state, input).await
}

#[tauri::command]
fn refresh_season_catchup_token(
    state: tauri::State<'_, native_catchup::SharedNativeCatchupState>,
    input: native_catchup::RefreshSeasonCatchupTokenInput,
) -> Result<(), String> {
    native_catchup::refresh_native_catchup_token(state, input)
}

#[tauri::command]
async fn discard_session_edits(
    app: tauri::AppHandle,
    state: tauri::State<'_, native_catchup::SharedNativeCatchupState>,
    input: native_catchup::NativeSeasonOnlyInput,
) -> Result<native_catchup::DiscardSessionEditsResult, String> {
    native_catchup::discard_native_session_edits(app, state, input).await
}

#[tauri::command]
async fn sync_pending_changes(
    app: tauri::AppHandle,
    state: tauri::State<'_, native_catchup::SharedNativeCatchupState>,
    input: native_catchup::NativeSyncPendingChangesInput,
) -> Result<native_catchup::NativeSyncPendingChangesResult, String> {
    native_catchup::sync_native_pending_changes(app, state, input).await
}

#[tauri::command]
fn cancel_season_catchup(
    state: tauri::State<'_, native_catchup::SharedNativeCatchupState>,
    input: native_catchup::CancelSeasonCatchupInput,
) -> Result<(), String> {
    native_catchup::cancel_native_catchup(state, input)
}
