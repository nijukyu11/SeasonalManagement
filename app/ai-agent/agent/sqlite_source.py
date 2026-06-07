from __future__ import annotations

import sqlite3
from pathlib import Path
from typing import Any

from .contracts import QueryResult
from .sql_validator import normalize_dashboard_ai_sql, validate_dashboard_ai_sql


DASHBOARD_AI_VIEW_SQL = """
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
"""


def execute_dashboard_ai_sql(sqlite_path: str | Path, sql: str, query_id: str = "local-sql", limit: int = 500) -> QueryResult:
    path = Path(sqlite_path)
    if not path.exists():
        raise FileNotFoundError(f"Không tìm thấy SQLite local: {path}")
    normalized = normalize_dashboard_ai_sql(sql, limit)
    validate_dashboard_ai_sql(normalized)
    uri = f"file:{path.as_posix()}?mode=ro"
    conn = sqlite3.connect(uri, uri=True, timeout=5.0)
    conn.row_factory = sqlite3.Row
    try:
        conn.executescript(DASHBOARD_AI_VIEW_SQL)
        rows = conn.execute(normalized).fetchall()
    finally:
        conn.close()
    columns = list(rows[0].keys()) if rows else []
    mapped_rows: list[dict[str, Any]] = [dict(row) for row in rows[:limit]]
    return QueryResult(
        queryId=query_id,
        columns=columns,
        rows=mapped_rows,
        rowCount=len(mapped_rows),
        truncated=len(rows) >= limit,
        executedSqlPreview=normalized[:1000],
        dataQualityNotes=[
            "Nguồn: SQLite local qua Python sidecar read-only.",
            "Chỉ SELECT/CTE read-only trên dashboard_ai_flight_operations được phép.",
        ],
    )
