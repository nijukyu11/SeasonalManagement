use base64::{engine::general_purpose, Engine as _};
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command as StdCommand;
use std::sync::Mutex;
use tauri::Manager;
use tauri_plugin_shell::{process::CommandChild, ShellExt};
use tokio::time::{sleep, Duration};

pub mod native_catchup;

#[derive(Debug)]
struct DashboardAiAgentState {
    token: Mutex<String>,
    child: Mutex<Option<CommandChild>>,
}

fn create_dashboard_ai_agent_state() -> DashboardAiAgentState {
    let seed = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or(0);
    DashboardAiAgentState {
        token: Mutex::new(format!("seasonal-ai-agent-{seed}-{}", std::process::id())),
        child: Mutex::new(None),
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DashboardAiAgentRequestInput {
    payload: serde_json::Value,
    port: Option<u16>,
    supabase_url: Option<String>,
    anon_key: Option<String>,
    access_token: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DashboardAiAgentHealthInput {
    port: Option<u16>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct DashboardAiAgentHealthResult {
    healthy: bool,
    status: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct FetchProviderKeyRpcResponse {
    ok: Option<bool>,
    #[serde(rename = "secretValue")]
    secret_value: Option<String>,
    reason: Option<String>,
}

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

fn dashboard_ai_agent_token(state: &DashboardAiAgentState) -> Result<String, String> {
    state
        .token
        .lock()
        .map_err(|_| "Dashboard AI agent token lock failed".to_string())
        .map(|token| token.clone())
}

async fn probe_dashboard_ai_agent_health(port: u16, token: &str) -> Result<bool, String> {
    let url = format!("http://127.0.0.1:{port}/health");
    let response = reqwest::Client::new()
        .get(url)
        .header("x-seasonal-ai-agent-token", token)
        .send()
        .await
        .map_err(|error| format!("Python AI Agent is not reachable: {error}"))?;
    Ok(response.status().is_success())
}

async fn wait_dashboard_ai_agent_health(port: u16, token: &str) -> Result<(), String> {
    let mut last_error = String::new();
    for _ in 0..30 {
        match probe_dashboard_ai_agent_health(port, token).await {
            Ok(true) => return Ok(()),
            Ok(false) => last_error = "Python AI Agent health endpoint returned a non-success status".to_string(),
            Err(error) => last_error = error,
        }
        sleep(Duration::from_millis(150)).await;
    }
    Err(format!("Python AI Agent did not become healthy. {last_error}"))
}

async fn ensure_dashboard_ai_agent_running(
    app: &tauri::AppHandle,
    state: &DashboardAiAgentState,
    port: u16,
) -> Result<String, String> {
    let token = dashboard_ai_agent_token(state)?;
    if probe_dashboard_ai_agent_health(port, &token).await.unwrap_or(false) {
        return Ok(token);
    }

    {
        let mut child_guard = state
            .child
            .lock()
            .map_err(|_| "Dashboard AI agent child lock failed".to_string())?;
        if child_guard.is_none() {
            let command = app
                .shell()
                .sidecar("dashboard-ai-agent")
                .map_err(|error| format!("Could not create Python AI Agent sidecar command: {error}"))?
                .env("SEASONAL_AI_AGENT_TOKEN", &token)
                .env("SEASONAL_AI_AGENT_PORT", port.to_string());
            let (mut rx, child) = command
                .spawn()
                .map_err(|error| format!("Could not start Python AI Agent sidecar: {error}"))?;
            tauri::async_runtime::spawn(async move {
                while rx.recv().await.is_some() {}
            });
            *child_guard = Some(child);
        }
    }

    wait_dashboard_ai_agent_health(port, &token).await?;
    Ok(token)
}

#[allow(dead_code)]
async fn fetch_dashboard_ai_provider_key(
    supabase_url: &str,
    anon_key: &str,
    access_token: &str,
    provider: &str,
) -> Result<String, String> {
    let url = format!("{}/rest/v1/rpc/fetch_ai_provider_key", supabase_url.trim_end_matches('/'));
    let payload = serde_json::json!({ "p_provider": provider });
    let response = reqwest::Client::new()
        .post(url)
        .header("apikey", anon_key)
        .header("Authorization", format!("Bearer {access_token}"))
        .header("Content-Type", "application/json")
        .json(&payload)
        .send()
        .await
        .map_err(|error| format!("Không tải được provider key từ Supabase: {error}"))?;
    let status = response.status();
    let raw = response
        .text()
        .await
        .map_err(|error| format!("Không đọc được phản hồi provider key từ Supabase: {error}"))?;
    if !status.is_success() {
        return Err(format!("Không tải được provider key từ Supabase ({status}): {raw}"));
    }
    let parsed = serde_json::from_str::<FetchProviderKeyRpcResponse>(&raw)
        .map_err(|error| format!("Provider key RPC trả JSON không hợp lệ: {error}; payload={raw}"))?;
    if parsed.ok == Some(true) {
        if let Some(secret) = parsed.secret_value.map(|value| value.trim().to_string()) {
            if !secret.is_empty() {
                return Ok(secret);
            }
        }
    }
    let reason = parsed.reason.unwrap_or_else(|| "provider_key_not_synced".to_string());
    Err(match reason.as_str() {
        "operator_missing_can_use_ai" => "Operator hiện tại chưa có quyền can_use_ai để tải provider key về máy local.".to_string(),
        "provider_key_not_synced" => format!("Chưa sync provider key cho {provider}. Vào Settings > AI Analysis để Save & Sync Local Provider Key."),
        "invalid_provider" => format!("Provider AI không hợp lệ: {provider}."),
        _ => format!("Không tải được provider key cho {provider}: {reason}"),
    })
}

async fn fetch_dashboard_ai_provider_key_native(
    supabase_url: &str,
    anon_key: &str,
    access_token: &str,
    provider: &str,
) -> Result<String, String> {
    let url = format!("{}/rest/v1/rpc/fetch_ai_provider_key", supabase_url.trim_end_matches('/'));
    let response = reqwest::Client::new()
        .post(url)
        .header("apikey", anon_key)
        .header("Authorization", format!("Bearer {access_token}"))
        .header("Content-Type", "application/json")
        .json(&serde_json::json!({ "p_provider": provider }))
        .send()
        .await
        .map_err(|error| format!("Khong tai duoc provider key tu Supabase: {error}"))?;
    let status = response.status();
    let raw = response
        .text()
        .await
        .map_err(|error| format!("Khong doc duoc phan hoi provider key tu Supabase: {error}"))?;
    if !status.is_success() {
        return Err(format!("Khong tai duoc provider key tu Supabase ({status}): {raw}"));
    }
    let parsed = serde_json::from_str::<FetchProviderKeyRpcResponse>(&raw)
        .map_err(|error| format!("Provider key RPC tra JSON khong hop le: {error}; payload={raw}"))?;
    if parsed.ok == Some(true) {
        if let Some(secret) = parsed.secret_value.map(|value| value.trim().to_string()) {
            if !secret.is_empty() {
                return Ok(secret);
            }
        }
    }
    let reason = parsed.reason.unwrap_or_else(|| "provider_key_not_synced".to_string());
    Err(match reason.as_str() {
        "operator_missing_can_use_ai" => "Operator hien tai chua co quyen can_use_ai de tai provider key ve may local.".to_string(),
        "provider_key_not_synced" => format!("Chua sync provider key cho {provider}. Vao Settings > AI Analysis de Save & Sync Local Provider Key."),
        "invalid_provider" => format!("Provider AI khong hop le: {provider}."),
        _ => format!("Khong tai duoc provider key cho {provider}: {reason}"),
    })
}

#[tauri::command]
async fn dashboard_ai_agent_health(
    app: tauri::AppHandle,
    state: tauri::State<'_, DashboardAiAgentState>,
    input: DashboardAiAgentHealthInput,
) -> Result<DashboardAiAgentHealthResult, String> {
    let port = input.port.unwrap_or(8765);
    let token = ensure_dashboard_ai_agent_running(&app, &state, port).await?;
    let healthy = probe_dashboard_ai_agent_health(port, &token).await?;
    Ok(DashboardAiAgentHealthResult { healthy, status: if healthy { "ok".to_string() } else { "unhealthy".to_string() } })
}

#[tauri::command]
async fn call_dashboard_ai_agent(
    app: tauri::AppHandle,
    state: tauri::State<'_, DashboardAiAgentState>,
    input: DashboardAiAgentRequestInput,
) -> Result<serde_json::Value, String> {
    let port = input.port.unwrap_or(8765);
    let token = ensure_dashboard_ai_agent_running(&app, &state, port).await?;
    let url = format!("http://127.0.0.1:{port}/v1/analyze");
    let mut payload = input.payload;
    if let Some(object) = payload.as_object_mut() {
        if !object.contains_key("sqlitePath") {
            let app_config_dir = app
                .path()
                .app_config_dir()
                .map_err(|error| format!("Could not resolve app config directory: {error}"))?;
            object.insert(
                "sqlitePath".to_string(),
                serde_json::Value::String(app_config_dir.join("seasonal-management-local.db").to_string_lossy().to_string()),
            );
        }
        let provider = object
            .get("model")
            .and_then(|model| model.as_object())
            .and_then(|model| model.get("provider"))
            .and_then(|provider| provider.as_str())
            .unwrap_or("");
        let existing_provider_key = object
            .get("model")
            .and_then(|model| model.as_object())
            .and_then(|model| model.get("providerKey"))
            .and_then(|value| value.as_str())
            .map(|value| !value.trim().is_empty())
            .unwrap_or(false);
        if !existing_provider_key {
            let supabase_url = input
                .supabase_url
                .as_deref()
                .ok_or_else(|| "Thiếu Supabase URL để tải provider key cho Python AI Agent.".to_string())?;
            let anon_key = input
                .anon_key
                .as_deref()
                .ok_or_else(|| "Thiếu Supabase anon key để tải provider key cho Python AI Agent.".to_string())?;
            let access_token = input
                .access_token
                .as_deref()
                .ok_or_else(|| "Thiếu phiên đăng nhập để tải provider key cho Python AI Agent.".to_string())?;
            if provider.trim().is_empty() {
                return Err("Thiếu provider model để tải provider key cho Python AI Agent.".to_string());
            }
            let provider_key = fetch_dashboard_ai_provider_key_native(supabase_url, anon_key, access_token, provider).await?;
            if let Some(model) = object.get_mut("model").and_then(|model| model.as_object_mut()) {
                model.insert("providerKey".to_string(), serde_json::Value::String(provider_key));
            }
        }
    }
    let response = reqwest::Client::new()
        .post(url)
        .header("x-seasonal-ai-agent-token", token)
        .json(&payload)
        .send()
        .await
        .map_err(|error| format!("Python AI Agent is not reachable: {error}"))?;
    let status = response.status();
    let payload = response
        .json::<serde_json::Value>()
        .await
        .map_err(|error| format!("Python AI Agent returned invalid JSON: {error}"))?;
    if !status.is_success() {
        let message = payload
            .get("detail")
            .and_then(|value| value.as_str())
            .or_else(|| payload.get("message").and_then(|value| value.as_str()))
            .unwrap_or("Python AI Agent request failed");
        return Err(format!("{message} ({status})"));
    }
    Ok(payload)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(native_catchup::create_native_catchup_state())
        .manage(create_dashboard_ai_agent_state())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_shell::init())
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
            dashboard_ai_agent_health,
            call_dashboard_ai_agent,
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
            query_native_dashboard_ai_sql,
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
async fn query_native_dashboard_ai_sql(
    app: tauri::AppHandle,
    input: native_catchup::QueryNativeDashboardAiSqlInput,
) -> Result<native_catchup::QueryNativeDashboardAiSqlResult, String> {
    native_catchup::query_native_dashboard_ai_sql(app, input).await
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
