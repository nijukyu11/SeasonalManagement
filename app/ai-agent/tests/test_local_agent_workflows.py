from __future__ import annotations

import sqlite3
import tempfile
import unittest
from pathlib import Path

from agent.contracts import AiModelRequest, LocalAgentRequest
from agent.main import analyze


class DashboardAiLocalWorkflowTest(unittest.IsolatedAsyncioTestCase):
    async def test_peak_day_sqlite_workflow_does_not_require_provider_key(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            db_path = Path(temp_dir) / "seasonal-management-local.db"
            _seed_sqlite_fixture(db_path)
            response = await analyze(
                LocalAgentRequest(
                    model=AiModelRequest(provider="gemini", model="gemini-3-flash-preview", providerKey=None),
                    prompt="tìm ngày cao điểm của tháng 6 và điểm bất thường so với các ngày còn lại",
                    seasonIds=["S26"],
                    sqlitePath=str(db_path),
                    workflowId="peak-day-anomaly",
                )
            )

        self.assertEqual(response.workflow_id, "peak-day-anomaly")
        self.assertGreaterEqual(len(response.query_results), 2)
        self.assertEqual(response.query_results[0].query_id, "peak-day-daily")
        self.assertTrue(response.prepared_data_contracts)


def _seed_sqlite_fixture(db_path: Path) -> None:
    conn = sqlite3.connect(db_path)
    try:
        conn.executescript(
            """
            CREATE TABLE local_seasons (
              season_id TEXT PRIMARY KEY,
              payload_json TEXT
            );
            CREATE TABLE local_flight_records (
              season_id TEXT,
              record_id TEXT,
              payload_json TEXT,
              operational_date TEXT,
              flight_date TEXT,
              schedule TEXT,
              type TEXT,
              gate TEXT,
              stand TEXT,
              status TEXT,
              is_base INTEGER DEFAULT 0
            );
            INSERT INTO local_seasons (season_id, payload_json)
            VALUES ('S26', '{"seasonCode":"S26"}');
            """
        )
        rows = []
        for day, count in [(1, 2), (2, 4), (3, 3)]:
            for index in range(count):
                type_code = "A" if index % 2 == 0 else "D"
                rows.append(
                    (
                        "S26",
                        f"r-{day}-{index}",
                        '{"flightNumber":"VN123","airline":"VN","route":"HAN","pax":100,"status":"active"}',
                        f"2026-06-{day:02d}",
                        f"2026-06-{day:02d}",
                        f"{8 + index:02d}:00",
                        type_code,
                        "",
                        "",
                        "active",
                        0,
                    )
                )
        conn.executemany(
            """
            INSERT INTO local_flight_records (
              season_id, record_id, payload_json, operational_date, flight_date,
              schedule, type, gate, stand, status, is_base
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            rows,
        )
        conn.commit()
    finally:
        conn.close()


if __name__ == "__main__":
    unittest.main()
