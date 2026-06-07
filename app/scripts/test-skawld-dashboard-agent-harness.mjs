#!/usr/bin/env node
import { runSkawldDashboardAgentHarness } from './skawld-dashboard-agent-harness.mjs';
import { DEFAULT_DASHBOARD_AI_LOCAL_DB_PATH, queryDashboardAiLocalSql } from './dashboard-ai-local-sql-source.mjs';

function parseArgs(argv) {
  const args = { source: 'mock', dbPath: DEFAULT_DASHBOARD_AI_LOCAL_DB_PATH };
  for (let index = 2; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--source') {
      args.source = argv[index + 1] || 'mock';
      index += 1;
    } else if (arg === '--db') {
      args.dbPath = argv[index + 1] || DEFAULT_DASHBOARD_AI_LOCAL_DB_PATH;
      index += 1;
    }
  }
  return args;
}

const BASE_TEST_TREE = [
  {
    id: 'basic-month-total',
    level: 1,
    prompt: 'tổng số chuyến bay tháng 6/2026',
    expectedText: ['tháng 6/2026', '3.387 chuyến'],
    expectedSql: ['month = \'2026-06\'', 'COUNT(*) AS flights'],
  },
  {
    id: 'month-comparison',
    level: 2,
    prompt: 'so sánh tháng 6/2026 với tháng 5/2026',
    expectedText: ['tháng 6/2026', 'tháng 5/2026', 'giảm 145 chuyến'],
    expectedSql: ['month IN (\'2026-05\', \'2026-06\')', 'GROUP BY month'],
  },
  {
    id: 'peak-day-anomaly',
    level: 3,
    prompt: 'tìm ngày cao điểm của tháng 6 và điểm bất thường so với các ngày còn lại trong tháng',
    expectedText: ['18/06/2026', '128 chuyến', 'cao hơn trung bình'],
    expectedSql: ['GROUP BY ops_date', 'ORDER BY flights DESC'],
  },
  {
    id: 'single-day-detail',
    level: 4,
    prompt: 'cho tôi thông tin ngày bay 18/06/2026',
    expectedText: ['18/06/2026', '128 chuyến', 'AK/KUL'],
    expectedSql: ['ops_date = \'2026-06-18\'', 'GROUP BY airline, route'],
  },
  {
    id: 'specific-flight',
    level: 5,
    prompt: 'tìm thông tin chuyến VJ123 ngày 18/06/2026',
    expectedText: ['VJ123', '18/06/2026', 'DAD-SIN'],
    expectedSql: ['flight = \'VJ123\'', 'ops_date = \'2026-06-18\''],
  },
];

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function extractToolSql(result) {
  const startEvent = result.events.find((event) => event?.type === 'tool_call_start');
  return String(startEvent?.input?.sql || '');
}

function formatDateForPrompt(opsDate) {
  const match = String(opsDate || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  return match ? `${match[3]}/${match[2]}/${match[1]}` : '18/06/2026';
}

async function buildTestTree(options) {
  if (options.source !== 'local-sqlite') return BASE_TEST_TREE;
  let sampleFlight = null;
  try {
    const sample = await queryDashboardAiLocalSql({
      dbPath: options.dbPath,
      sql: [
        'SELECT flight, ops_date',
        'FROM dashboard_ai_flight_operations',
        "WHERE month = '2026-06'",
        'AND flight IS NOT NULL',
        "AND flight <> ''",
        'ORDER BY ops_date ASC, flight ASC',
        'LIMIT 1',
      ].join(' '),
      limit: 1,
    });
    sampleFlight = sample.rows[0] || null;
  } catch {
    sampleFlight = null;
  }
  const flight = sampleFlight?.flight || 'VJ123';
  const date = formatDateForPrompt(sampleFlight?.ops_date);
  return BASE_TEST_TREE.map((entry) => {
    if (entry.id !== 'specific-flight') return entry;
    return {
      ...entry,
      prompt: `tìm thông tin chuyến ${flight} ngày ${date}`,
      expectedText: [flight],
      expectedSql: [`flight = '${flight}'`, `ops_date = '${sampleFlight?.ops_date || '2026-06-18'}'`],
    };
  });
}

async function runHarnessTestCase(testCase, options) {
  const result = await runSkawldDashboardAgentHarness({ prompt: testCase.prompt, source: options.source, dbPath: options.dbPath });
  const sql = extractToolSql(result);
  const eventTypes = result.events.map((event) => event.type);

  assert(result.status === 'completed', `${testCase.id}: expected completed status, got ${result.status}`);
  assert(eventTypes.includes('tool_call_start'), `${testCase.id}: expected tool_call_start event, got ${eventTypes.join(' -> ')}`);
  assert(eventTypes.includes('tool_call_end'), `${testCase.id}: expected tool_call_end event, got ${eventTypes.join(' -> ')}`);
  assert(eventTypes.includes('result'), `${testCase.id}: expected result event, got ${eventTypes.join(' -> ')}`);
  assert(result.toolResults.length >= 1, `${testCase.id}: expected at least one tool result`);

  if (options.source === 'mock') {
    for (const expected of testCase.expectedText) {
      assert(
        result.finalText.toLowerCase().includes(String(expected).toLowerCase()),
        `${testCase.id}: finalText must include ${JSON.stringify(expected)}, got ${JSON.stringify(result.finalText)}`
      );
    }
  } else {
    assert(result.finalText.length > 20, `${testCase.id}: expected non-empty local SQLite finalText`);
    assert(!result.toolResults.some((event) => event.is_error), `${testCase.id}: local SQLite tool execution must not error`);
  }
  for (const expected of testCase.expectedSql) {
    assert(
      sql.includes(expected),
      `${testCase.id}: SQL must include ${JSON.stringify(expected)}, got ${JSON.stringify(sql)}`
    );
  }

  return {
    id: testCase.id,
    level: testCase.level,
    prompt: testCase.prompt,
    status: result.status,
    sql,
    finalText: result.finalText,
    eventTypes,
  };
}

export async function runSkawldDashboardHarnessTestTree() {
  const options = parseArgs(process.argv);
  const testTree = await buildTestTree(options);
  const results = [];
  for (const testCase of testTree) {
    results.push(await runHarnessTestCase(testCase, options));
  }
  return results;
}

async function main() {
  const results = await runSkawldDashboardHarnessTestTree();
  process.stdout.write(`${JSON.stringify({ ok: true, count: results.length, results }, null, 2)}\n`);
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1].replace(/\\/g, '/')}`).href) {
  await main();
}
