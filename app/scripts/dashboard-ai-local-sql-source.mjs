import os from 'node:os';
import path from 'node:path';

export const DEFAULT_DASHBOARD_AI_LOCAL_DB_PATH = path.join(
  os.homedir(),
  'AppData',
  'Roaming',
  'com.seasonalmanagement.desktop',
  'seasonal-management-local.db'
);

const FORBIDDEN_SQL_KEYWORDS = [
  'INSERT',
  'UPDATE',
  'DELETE',
  'DROP',
  'ALTER',
  'CREATE',
  'ATTACH',
  'DETACH',
  'PRAGMA',
  'VACUUM',
  'REINDEX',
  'REPLACE',
  'TRUNCATE',
  'BEGIN',
  'COMMIT',
  'ROLLBACK',
  'LOAD_EXTENSION',
];

export function hasForbiddenDashboardAiSql(sql) {
  const upper = ` ${String(sql || '').toUpperCase()} `;
  return FORBIDDEN_SQL_KEYWORDS.some((keyword) =>
    upper.includes(` ${keyword} `) || upper.includes(`\n${keyword} `)
  );
}

export function normalizeDashboardAiSql(sql, limit = 500) {
  const normalizedLimit = Math.max(1, Math.min(500, Number.isFinite(Number(limit)) ? Math.floor(Number(limit)) : 500));
  const trimmed = String(sql || '').trim().replace(/;+$/g, '').trim();
  if (/\blimit\s+\d+\b/i.test(trimmed)) return trimmed;
  return `${trimmed} LIMIT ${normalizedLimit}`;
}

function dashboardAiCteNames(upperSql) {
  if (!upperSql.trimStart().startsWith('WITH ')) return new Set();
  const beforeSelect = upperSql.split('SELECT')[0] || '';
  const names = new Set();
  for (const part of beforeSelect.split(',')) {
    const name = part
      .replace(/\bWITH\b/g, ' ')
      .trim()
      .split(/\s+/)[0]
      ?.replace(/^["`]|["`]$/g, '');
    if (name && name !== 'RECURSIVE') names.add(name);
  }
  return names;
}

export function validateDashboardAiSql(sql) {
  const normalized = String(sql || '').trim();
  const upper = normalized.toUpperCase();
  if (!(upper.startsWith('SELECT ') || upper.startsWith('WITH '))) {
    throw new Error('Dashboard AI SQL must start with SELECT or WITH');
  }
  if (normalized.includes(';')) {
    throw new Error('Dashboard AI SQL must contain exactly one statement without semicolons');
  }
  if (hasForbiddenDashboardAiSql(normalized)) {
    throw new Error('Dashboard AI SQL rejected unsafe keyword');
  }
  const cteNames = dashboardAiCteNames(upper);
  const words = upper
    .replace(/[(),]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .split(' ')
    .filter(Boolean);
  for (let index = 0; index < words.length - 1; index += 1) {
    if (words[index] !== 'FROM' && words[index] !== 'JOIN') continue;
    const table = words[index + 1].replace(/^["`]|["`]$/g, '');
    if (table !== 'DASHBOARD_AI_FLIGHT_OPERATIONS' && !cteNames.has(table)) {
      throw new Error(`Dashboard AI SQL can only read dashboard_ai_flight_operations, rejected ${table}`);
    }
  }
}

function ensureDashboardAiFlightOperationsView(db) {
  db.exec(`
    DROP VIEW IF EXISTS temp.dashboard_ai_flight_operations;
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
  `);
}

export async function queryDashboardAiLocalSql(input) {
  const Database = (await import('better-sqlite3')).default;
  const dbPath = input.dbPath || DEFAULT_DASHBOARD_AI_LOCAL_DB_PATH;
  const limit = Math.max(1, Math.min(500, Number.isFinite(Number(input.limit)) ? Math.floor(Number(input.limit)) : 500));
  const executedSql = normalizeDashboardAiSql(input.sql, limit);
  validateDashboardAiSql(executedSql);
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    ensureDashboardAiFlightOperationsView(db);
    db.pragma('query_only = ON');
    const statement = db.prepare(executedSql);
    const rows = statement.all(...(Array.isArray(input.params) ? input.params : []));
    const cappedRows = rows.slice(0, limit);
    return {
      queryId: input.queryId || 'skawld-harness-local-sql',
      columns: Object.keys(cappedRows[0] || rows[0] || {}),
      rows: cappedRows,
      rowCount: cappedRows.length,
      truncated: rows.length > cappedRows.length || cappedRows.length >= limit,
      executedSqlPreview: executedSql.slice(0, 1000),
      dataQualityNotes: [
        'Nguồn: SQLite local thật qua better-sqlite3 dev harness.',
        'Validator JS mirror logic của Rust/Tauri query_native_dashboard_ai_sql.',
      ],
    };
  } finally {
    db.close();
  }
}
