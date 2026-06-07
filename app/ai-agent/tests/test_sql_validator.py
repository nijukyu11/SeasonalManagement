import unittest

from agent.sql_validator import SqlValidationError, normalize_dashboard_ai_sql, validate_dashboard_ai_sql


class DashboardAiSqlValidatorTest(unittest.TestCase):
    def test_accepts_select_group_by_ops_date(self):
        sql = "SELECT ops_date, COUNT(*) AS flights FROM dashboard_ai_flight_operations GROUP BY ops_date LIMIT 31"
        validate_dashboard_ai_sql(sql)

    def test_accepts_cte_select(self):
        sql = (
            "WITH daily AS (SELECT ops_date, COUNT(*) flights FROM dashboard_ai_flight_operations "
            "GROUP BY ops_date) SELECT * FROM daily LIMIT 10"
        )
        validate_dashboard_ai_sql(sql)

    def test_rejects_mutation(self):
        with self.assertRaises(SqlValidationError):
            validate_dashboard_ai_sql("UPDATE dashboard_ai_flight_operations SET pax = 0")

    def test_rejects_multiple_statements(self):
        with self.assertRaises(SqlValidationError):
            validate_dashboard_ai_sql("SELECT * FROM dashboard_ai_flight_operations; SELECT 1")

    def test_rejects_unknown_table(self):
        with self.assertRaises(SqlValidationError):
            validate_dashboard_ai_sql("SELECT * FROM local_flight_records LIMIT 10")

    def test_normalize_adds_limit(self):
        self.assertTrue(normalize_dashboard_ai_sql("SELECT * FROM dashboard_ai_flight_operations", 25).endswith("LIMIT 25"))


if __name__ == "__main__":
    unittest.main()
