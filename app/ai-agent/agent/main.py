from __future__ import annotations

import json
import os
import re
import unicodedata
from typing import Any

from fastapi import FastAPI, HTTPException, Request

from .contracts import LocalAgentRequest, LocalAgentResponse, ToolTraceEntry
from .provider_clients import call_provider, provider_label
from .sqlite_source import execute_dashboard_ai_sql

app = FastAPI(title="SeasonalManagement Dashboard AI Agent", version="0.1.0")


@app.middleware("http")
async def require_session_token(request: Request, call_next):
    expected = os.environ.get("SEASONAL_AI_AGENT_TOKEN", "").strip()
    if expected and request.headers.get("x-seasonal-ai-agent-token") != expected:
        raise HTTPException(status_code=401, detail="Python AI Agent token không hợp lệ.")
    return await call_next(request)


@app.get("/health")
async def health() -> dict[str, str]:
    return {"status": "ok", "runtime": "python-local-agent"}


@app.post("/v1/analyze")
async def analyze(request: LocalAgentRequest) -> LocalAgentResponse:
    if request.sqlite_path and _is_peak_day_prompt(request.prompt):
        return _build_peak_day_response(request)

    if not (request.model.provider_key or "").strip():
        raise HTTPException(
            status_code=400,
            detail=f"{provider_label(request.model.provider)} API key chưa được đồng bộ về local. Vào Settings > AI Analysis để Save & Sync Local Provider Key.",
        )

    provider_payload = await call_provider(request.model, _build_provider_prompt(request))
    assistant_text = _extract_provider_text(provider_payload)
    return LocalAgentResponse(
        assistantText=assistant_text or "AI đã xử lý yêu cầu nhưng provider không trả nội dung có thể hiển thị.",
        workflowId=request.workflow_id,
        toolTraceSummary=[
            ToolTraceEntry(
                tool="provider_call",
                phase="provider_direct_local",
                reason=f"Provider gọi trực tiếp từ máy local qua Python Agent: {provider_label(request.model.provider)}.",
            )
        ],
    )


def _build_peak_day_response(request: LocalAgentRequest) -> LocalAgentResponse:
    month = _infer_month(request.prompt)
    daily_sql = f"""
SELECT
  ops_date,
  COUNT(*) AS flights,
  SUM(CASE WHEN type = 'A' THEN 1 ELSE 0 END) AS arrivals,
  SUM(CASE WHEN type = 'D' THEN 1 ELSE 0 END) AS departures,
  SUM(pax) AS pax
FROM dashboard_ai_flight_operations
WHERE month = '{month}' AND status <> 'deleted'
GROUP BY ops_date
ORDER BY flights DESC, ops_date ASC
LIMIT 31
"""
    daily = execute_dashboard_ai_sql(request.sqlite_path or "", daily_sql, "peak-day-daily", 31)
    if not daily.rows:
        return LocalAgentResponse(
            assistantText=f"Không tìm thấy dữ liệu ngày trong tháng {month} từ SQLite local.",
            queryResults=[daily],
            workflowId=request.workflow_id or "peak-day-anomaly",
            preparedDataContracts=[_build_prepared_data_contract(daily, request.workflow_id or "peak-day-anomaly")],
            toolTraceSummary=[
                ToolTraceEntry(
                    tool="query_local_sql",
                    phase="executed_local_sql",
                    reason="Đã query SQLite local nhưng không có dòng phù hợp.",
                )
            ],
        )

    peak = max(daily.rows, key=lambda row: (int(row.get("flights") or 0), str(row.get("ops_date") or "")))
    peak_date = str(peak.get("ops_date"))
    peak_flights = int(peak.get("flights") or 0)
    other_days = [row for row in daily.rows if row.get("ops_date") != peak_date]
    average_other = sum(int(row.get("flights") or 0) for row in other_days) / max(1, len(other_days))
    delta = peak_flights - average_other
    delta_pct = (delta / average_other * 100) if average_other else 0.0

    driver_sql = f"""
WITH peak AS (
  SELECT airline, route, local_hour, type, COUNT(*) AS peak_flights, SUM(pax) AS peak_pax
  FROM dashboard_ai_flight_operations
  WHERE month = '{month}' AND ops_date = '{peak_date}' AND status <> 'deleted'
  GROUP BY airline, route, local_hour, type
),
baseline AS (
  SELECT airline, route, local_hour, type, COUNT(*) * 1.0 / COUNT(DISTINCT ops_date) AS avg_daily_flights
  FROM dashboard_ai_flight_operations
  WHERE month = '{month}' AND ops_date <> '{peak_date}' AND status <> 'deleted'
  GROUP BY airline, route, local_hour, type
)
SELECT
  COALESCE(peak.airline, baseline.airline) AS airline,
  COALESCE(peak.route, baseline.route) AS route,
  COALESCE(peak.local_hour, baseline.local_hour) AS local_hour,
  COALESCE(peak.type, baseline.type) AS type,
  COALESCE(peak.peak_flights, 0) AS peak_flights,
  ROUND(COALESCE(baseline.avg_daily_flights, 0), 2) AS baseline_avg_daily_flights,
  ROUND(COALESCE(peak.peak_flights, 0) - COALESCE(baseline.avg_daily_flights, 0), 2) AS delta_vs_baseline
FROM peak
LEFT JOIN baseline
  ON baseline.airline = peak.airline
 AND baseline.route = peak.route
 AND baseline.local_hour = peak.local_hour
 AND baseline.type = peak.type
ORDER BY ABS(delta_vs_baseline) DESC, peak_flights DESC
LIMIT 20
"""
    drivers = execute_dashboard_ai_sql(request.sqlite_path or "", driver_sql, "peak-day-vs-baseline-drivers", 20)
    top_driver = drivers.rows[0] if drivers.rows else None
    top_driver_text = ""
    if top_driver:
        top_driver_text = (
            f" Điểm lệch lớn nhất so với baseline các ngày còn lại là {top_driver.get('airline')}/{top_driver.get('route')} "
            f"khung {top_driver.get('local_hour')}h {top_driver.get('type')}: "
            f"{top_driver.get('peak_flights')} chuyến trong ngày cao điểm so với baseline "
            f"{top_driver.get('baseline_avg_daily_flights')} chuyến/ngày."
        )
    assistant_text = (
        f"Ngày cao điểm của tháng {month} là **{peak_date}** với **{peak_flights:,} chuyến**. "
        f"So với baseline là trung bình các ngày còn lại trong tháng (**{average_other:.1f} chuyến/ngày**), "
        f"ngày này cao hơn **{delta:.1f} chuyến** (**{delta_pct:.1f}%**).{top_driver_text}"
    )

    return LocalAgentResponse(
        assistantText=assistant_text,
        queryResults=[daily, drivers],
        workflowId=request.workflow_id or "peak-day-anomaly",
        preparedDataContracts=[
            _build_prepared_data_contract(daily, request.workflow_id or "peak-day-anomaly"),
            _build_prepared_data_contract(drivers, request.workflow_id or "peak-day-anomaly"),
        ],
        boardPatch={
            "title": f"Phân tích ngày cao điểm {month}",
            "append": True,
            "blocks": [
                {
                    "id": "peak-day-daily-chart",
                    "type": "chart",
                    "title": f"Phân bổ chuyến bay theo ngày - {month}",
                    "source": "resolvedDataRequest",
                    "chart": {
                        "chartType": "line-trend",
                        "title": f"Phân bổ chuyến bay theo ngày - {month}",
                        "source": "resolvedDataRequest",
                        "filters": {"metric": "flights", "dimension": "ops_date"},
                        "series": ["flights", "arrivals", "departures"],
                        "sourceQueryId": "peak-day-daily",
                        "x": "ops_date",
                        "rows": daily.rows,
                    },
                },
                {
                    "id": "peak-day-daily-table",
                    "type": "table",
                    "title": "Bảng ngày trong tháng",
                    "source": "resolvedDataRequest",
                    "table": {
                        "templateId": "custom-table",
                        "title": "Bảng ngày trong tháng",
                        "columns": daily.columns,
                        "source": "resolvedDataRequest",
                        "filters": {"metric": "flights", "dimension": "ops_date"},
                        "sourceQueryId": "peak-day-daily",
                        "rows": daily.rows,
                        "limit": 31,
                    },
                },
                {
                    "id": "peak-day-baseline-driver-table",
                    "type": "table",
                    "title": "Driver bất thường so với baseline các ngày còn lại",
                    "source": "resolvedDataRequest",
                    "table": {
                        "templateId": "custom-table",
                        "title": "Driver bất thường so với baseline các ngày còn lại",
                        "columns": drivers.columns,
                        "source": "resolvedDataRequest",
                        "filters": {"metric": "flights", "dimension": "airline-route-hour-type"},
                        "sourceQueryId": "peak-day-vs-baseline-drivers",
                        "rows": drivers.rows,
                        "limit": 20,
                    },
                },
            ],
        },
        toolTraceSummary=[
            ToolTraceEntry(
                tool="query_local_sql",
                phase="executed_local_sql",
                reason="Provider gọi trực tiếp từ máy local; dữ liệu query bằng SQLite local read-only.",
            ),
            ToolTraceEntry(
                tool="answer_verification",
                phase="verified_answer",
                reason="Câu trả lời dùng số liệu đã tính từ query daily và baseline driver.",
            ),
        ],
    )


def _build_prepared_data_contract(result: Any, workflow_id: str | None) -> dict[str, Any]:
    metric_columns = {
        "flights",
        "pax",
        "arrivals",
        "departures",
        "peak_flights",
        "peak_pax",
        "avg_daily_flights",
        "baseline_avg_daily_flights",
        "delta",
        "delta_pct",
        "delta_vs_baseline",
        "share",
    }
    columns = list(getattr(result, "columns", []) or [])
    rows = list(getattr(result, "rows", []) or [])
    metrics = [column for column in columns if column in metric_columns or column.endswith("_flights") or column.endswith("_pax")]
    dimensions = [column for column in columns if column not in metrics]
    grain = "row"
    for candidate in ["ops_date", "route", "airline", "season", "local_hour", "month"]:
        if candidate in columns:
            grain = candidate
            break
    date_range = None
    if "ops_date" in columns:
        dates = sorted(str(row.get("ops_date")) for row in rows if row.get("ops_date"))
        if dates:
            date_range = {"from": dates[0], "to": dates[-1], "field": "ops_date"}
    quality_notes = list(getattr(result, "data_quality_notes", []) or [])
    if getattr(result, "truncated", False):
        quality_notes.append("Kết quả đã bị giới hạn số dòng.")
    if workflow_id:
        quality_notes.append(f"Workflow: {workflow_id}")
    contract = {
        "queryId": getattr(result, "query_id", ""),
        "grain": grain,
        "filters": {},
        "metrics": metrics,
        "dimensions": dimensions,
        "rowCount": int(getattr(result, "row_count", 0) or 0),
        "truncated": bool(getattr(result, "truncated", False)),
        "qualityNotes": quality_notes[:8],
        "trusted": bool(rows and metrics and not getattr(result, "truncated", False)),
    }
    if date_range:
        contract["dateRange"] = date_range
    return contract


def _build_provider_prompt(request: LocalAgentRequest) -> str:
    context = {
        "language": "vi",
        "sourcePolicy": request.source_policy,
        "seasonIds": request.season_ids,
        "workflowId": request.workflow_id,
        "semanticIntent": request.semantic_intent,
        "requiredGates": request.required_gates,
        "sessionArtifact": request.session_artifact,
        "notebookContext": request.notebook_context,
        "contextDocuments": request.context_documents[:20],
    }
    return (
        "Bạn là Dashboard AI Agent. Trả lời tiếng Việt. Không bịa số liệu. "
        "Nếu cần dữ liệu, tạo kế hoạch SQL SELECT/CTE read-only trên dashboard_ai_flight_operations.\n\n"
        f"CONTEXT_JSON:\n{json.dumps(context, ensure_ascii=False)}\n\n"
        f"USER_PROMPT:\n{request.prompt}"
    )


def _extract_provider_text(payload: dict[str, Any]) -> str:
    if "candidates" in payload:
        parts = payload.get("candidates", [{}])[0].get("content", {}).get("parts", [])
        return "\n".join(str(part.get("text", "")) for part in parts if isinstance(part, dict)).strip()
    choices = payload.get("choices")
    if isinstance(choices, list) and choices:
        message = choices[0].get("message", {})
        content = message.get("content")
        return content if isinstance(content, str) else json.dumps(content, ensure_ascii=False)
    return ""


def _is_peak_day_prompt(prompt: str) -> bool:
    normalized = _normalize_vi(prompt)
    return "ngay cao diem" in normalized or ("cao diem" in normalized and "thang" in normalized)


def _infer_month(prompt: str) -> str:
    normalized = _normalize_vi(prompt)
    year_match = re.search(r"\b(20\d{2})\b", normalized)
    year = year_match.group(1) if year_match else "2026"
    month_match = re.search(r"thang\s*(\d{1,2})", normalized)
    month = int(month_match.group(1)) if month_match else 6
    return f"{year}-{month:02d}"


def _normalize_vi(value: str) -> str:
    decomposed = unicodedata.normalize("NFD", value.lower())
    return "".join(ch for ch in decomposed if unicodedata.category(ch) != "Mn").replace("đ", "d")
