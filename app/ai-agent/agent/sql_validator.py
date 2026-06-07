from __future__ import annotations

import re


ALLOWED_TABLE = "dashboard_ai_flight_operations"
FORBIDDEN_KEYWORDS = {
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
}


class SqlValidationError(ValueError):
    pass


def normalize_dashboard_ai_sql(sql: str, limit: int = 500) -> str:
    trimmed = sql.strip().rstrip(";").strip()
    if not re.search(r"\blimit\b", trimmed, flags=re.IGNORECASE):
        return f"{trimmed} LIMIT {int(limit)}"
    return trimmed


def validate_dashboard_ai_sql(sql: str) -> None:
    normalized = sql.strip()
    upper = normalized.upper()
    if not re.match(r"^(SELECT|WITH)\b", upper):
        raise SqlValidationError("Dashboard AI SQL phải bắt đầu bằng SELECT hoặc WITH.")
    if ";" in normalized:
        raise SqlValidationError("Dashboard AI SQL chỉ được là một statement, không chứa dấu chấm phẩy.")

    padded_upper = f" {upper} "
    for keyword in FORBIDDEN_KEYWORDS:
        if re.search(rf"(^|\s){re.escape(keyword)}(\s|$)", padded_upper):
            raise SqlValidationError(f"Dashboard AI SQL bị chặn vì keyword không an toàn: {keyword}.")

    cte_names = _cte_names(upper)
    for table in _referenced_tables(upper):
        cleaned = table.strip().strip('"`[]')
        if "." in cleaned:
            cleaned = cleaned.split(".")[-1]
        if cleaned != ALLOWED_TABLE.upper() and cleaned not in cte_names:
            raise SqlValidationError(f"Dashboard AI SQL chỉ được đọc {ALLOWED_TABLE}, đã chặn {cleaned}.")


def _referenced_tables(upper_sql: str) -> list[str]:
    return [match.group(2) for match in re.finditer(r"\b(FROM|JOIN)\s+([A-Z0-9_.'\"`\[\]]+)", upper_sql)]


def _cte_names(upper_sql: str) -> set[str]:
    if not upper_sql.strip().startswith("WITH "):
        return set()
    header = _cte_header(upper_sql)
    names: set[str] = set()
    for part in _split_cte_definitions(header):
        definition = part.strip()
        definition = re.sub(r"^WITH\s+", "", definition)
        definition = re.sub(r"^RECURSIVE\s+", "", definition)
        match = re.match(r"([A-Z_][A-Z0-9_]*)\s+AS\s*\(", definition)
        if match:
            names.add(match.group(1))
    return names


def _cte_header(upper_sql: str) -> str:
    trimmed = upper_sql.strip()
    depth = 0
    for index, ch in enumerate(trimmed):
        if ch == "(":
            depth += 1
        elif ch == ")":
            depth = max(0, depth - 1)
        elif depth == 0 and index > 0 and trimmed[index:].startswith(" SELECT "):
            return trimmed[:index]
    return trimmed


def _split_cte_definitions(header: str) -> list[str]:
    parts: list[str] = []
    depth = 0
    start = 0
    for index, ch in enumerate(header):
        if ch == "(":
            depth += 1
        elif ch == ")":
            depth = max(0, depth - 1)
        elif ch == "," and depth == 0:
            parts.append(header[start:index])
            start = index + 1
    parts.append(header[start:])
    return parts
