#!/usr/bin/env node
import { DEFAULT_DASHBOARD_AI_LOCAL_DB_PATH, queryDashboardAiLocalSql } from './dashboard-ai-local-sql-source.mjs';

const PRODUCTION_WARNING = 'Không dùng harness này trong production; đây chỉ là spike dev-only để kiểm chứng Skawld runtime.';
const DEFAULT_PROMPT = 'tìm ngày cao điểm của tháng 6 và điểm bất thường';

function parseArgs(argv) {
  const args = { prompt: DEFAULT_PROMPT, jsonOnly: false, source: 'auto', dbPath: DEFAULT_DASHBOARD_AI_LOCAL_DB_PATH };
  for (let index = 2; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--json') {
      args.jsonOnly = true;
      continue;
    }
    if (arg === '--prompt') {
      args.prompt = argv[index + 1] || DEFAULT_PROMPT;
      index += 1;
      continue;
    }
    if (arg === '--source') {
      args.source = argv[index + 1] || 'auto';
      index += 1;
      continue;
    }
    if (arg === '--db') {
      args.dbPath = argv[index + 1] || DEFAULT_DASHBOARD_AI_LOCAL_DB_PATH;
      index += 1;
      continue;
    }
  }
  return args;
}

function hasForbiddenSql(sql) {
  return /\b(insert|update|delete|drop|alter|create|attach|detach|pragma|vacuum|replace|transaction|begin|commit|rollback|load_extension)\b/i.test(sql);
}

function ensureReadOnlySelectSql(sql) {
  const normalized = String(sql || '').trim();
  if (!normalized) throw new Error('SQL rỗng.');
  if (normalized.split(';').filter((part) => part.trim()).length > 1) {
    throw new Error('SQL phải là một statement duy nhất.');
  }
  if (!/^(select|with)\b/i.test(normalized)) {
    throw new Error('Chỉ cho phép SELECT hoặc WITH ... SELECT.');
  }
  if (hasForbiddenSql(normalized)) {
    throw new Error('SQL chứa từ khóa không read-only.');
  }
  if (!/\bdashboard_ai_flight_operations\b/i.test(normalized)) {
    throw new Error('Harness chỉ allowlist view dashboard_ai_flight_operations.');
  }
  return /\blimit\s+\d+\b/i.test(normalized) ? normalized : `${normalized.replace(/;+\s*$/, '')} LIMIT 100`;
}

function inferScenarioFromPrompt(prompt) {
  const text = String(prompt || '').toLowerCase();
  if (/\b(?=[a-z0-9]*[a-z])(?=[a-z0-9]*\d)[a-z0-9]{2,3}\s?\d{2,4}[a-z]?\b/i.test(text) || /1 chuyến|một chuyến|chuyến bay cụ thể/i.test(text)) return 'specific-flight';
  if (/thông tin ngày bay|ngày bay 18\/06\/2026|ngày 18\/06\/2026/i.test(text) && !/cao điểm|bất thường/i.test(text)) return 'single-day-detail';
  if (/so sánh.*tháng\s*6.*tháng\s*5|tháng\s*6.*với.*tháng\s*5/i.test(text)) return 'month-comparison';
  if (/tổng|thống kê|bao nhiêu/i.test(text) && /tháng\s*6|06\/2026|2026-06/i.test(text)) return 'basic-month-total';
  return 'peak-day-anomaly';
}

function sqlStringLiteral(value) {
  return `'${String(value || '').replace(/'/g, "''")}'`;
}

function extractPromptDate(prompt, fallback = '2026-06-18') {
  const text = String(prompt || '');
  const slash = text.match(/\b(\d{1,2})\/(\d{1,2})\/(\d{4})\b/);
  if (slash) return `${slash[3]}-${slash[2].padStart(2, '0')}-${slash[1].padStart(2, '0')}`;
  const iso = text.match(/\b(\d{4})-(\d{2})-(\d{2})\b/);
  return iso ? iso[0] : fallback;
}

function extractPromptFlight(prompt, fallback = 'VJ123') {
  const match = String(prompt || '').toUpperCase().match(/\b([A-Z0-9]{2,3}\s?\d{2,4}[A-Z]?)\b/);
  return match ? match[1].replace(/\s+/g, '') : fallback;
}

function buildSqlForScenario(scenario, prompt = DEFAULT_PROMPT) {
  if (scenario === 'specific-flight') {
    const flight = extractPromptFlight(prompt);
    const opsDate = extractPromptDate(prompt);
    return [
      'SELECT ops_date, flight, airline, route, aircraft, type, local_hour, gate, stand, pax',
      'FROM dashboard_ai_flight_operations',
      `WHERE flight = ${sqlStringLiteral(flight)}`,
      `AND ops_date = ${sqlStringLiteral(opsDate)}`,
      'ORDER BY local_hour ASC',
      'LIMIT 20',
    ].join(' ');
  }
  if (scenario === 'single-day-detail') {
    return [
      'SELECT airline, route, COUNT(*) AS flights,',
      'SUM(COUNT(*)) OVER () AS total_day_flights,',
      "SUM(CASE WHEN type = 'A' THEN 1 ELSE 0 END) AS arrivals,",
      "SUM(CASE WHEN type = 'D' THEN 1 ELSE 0 END) AS departures",
      'FROM dashboard_ai_flight_operations',
      "WHERE ops_date = '2026-06-18'",
      'GROUP BY airline, route',
      'ORDER BY flights DESC',
      'LIMIT 20',
    ].join(' ');
  }
  if (scenario === 'month-comparison') {
    return [
      'SELECT month, COUNT(*) AS flights,',
      "SUM(CASE WHEN type = 'A' THEN 1 ELSE 0 END) AS arrivals,",
      "SUM(CASE WHEN type = 'D' THEN 1 ELSE 0 END) AS departures",
      'FROM dashboard_ai_flight_operations',
      "WHERE month IN ('2026-05', '2026-06')",
      'GROUP BY month',
      'ORDER BY month ASC',
      'LIMIT 10',
    ].join(' ');
  }
  if (scenario === 'basic-month-total') {
    return [
      'SELECT month, COUNT(*) AS flights,',
      "SUM(CASE WHEN type = 'A' THEN 1 ELSE 0 END) AS arrivals,",
      "SUM(CASE WHEN type = 'D' THEN 1 ELSE 0 END) AS departures",
      'FROM dashboard_ai_flight_operations',
      "WHERE month = '2026-06'",
      'GROUP BY month',
      'LIMIT 10',
    ].join(' ');
  }
  return [
    'SELECT ops_date, COUNT(*) AS flights,',
    "SUM(CASE WHEN type = 'A' THEN 1 ELSE 0 END) AS arrivals,",
    "SUM(CASE WHEN type = 'D' THEN 1 ELSE 0 END) AS departures",
    'FROM dashboard_ai_flight_operations',
    "WHERE month = '2026-06'",
    'GROUP BY ops_date',
    'ORDER BY flights DESC',
    'LIMIT 30',
  ].join(' ');
}

function inferScenarioFromSql(sql) {
  if (/\bflight\s*=\s*'[^']+'/i.test(sql)) return 'specific-flight';
  if (/\bops_date\s*=\s*'2026-06-18'/i.test(sql) && /\bGROUP BY airline, route\b/i.test(sql)) return 'single-day-detail';
  if (/\bmonth\s+IN\s+\('2026-05',\s*'2026-06'\)/i.test(sql)) return 'month-comparison';
  if (/\bmonth\s*=\s*'2026-06'/i.test(sql) && /\bGROUP BY month\b/i.test(sql)) return 'basic-month-total';
  return 'peak-day-anomaly';
}

function buildMockQueryResult(sql) {
  const scenario = inferScenarioFromSql(sql);
  if (scenario === 'specific-flight') {
    const rows = [
      { ops_date: '2026-06-18', flight: 'VJ123', airline: 'VJ', route: 'DAD-SIN', aircraft: 'A321', type: 'D', local_hour: 8, gate: 'G05', stand: '12', pax: 180 },
    ];
    return { scenario, rows };
  }
  if (scenario === 'single-day-detail') {
    const rows = [
      { airline: 'AK', route: 'AK/KUL', flights: 6, total_day_flights: 128, arrivals: 3, departures: 3 },
      { airline: 'VJ', route: 'VJ/SIN', flights: 4, total_day_flights: 128, arrivals: 0, departures: 4 },
      { airline: 'VN', route: 'VN/HAN', flights: 3, total_day_flights: 128, arrivals: 2, departures: 1 },
    ];
    return { scenario, rows };
  }
  if (scenario === 'month-comparison') {
    const rows = [
      { month: '2026-05', flights: 3532, arrivals: 1768, departures: 1764 },
      { month: '2026-06', flights: 3387, arrivals: 1694, departures: 1693 },
    ];
    return { scenario, rows };
  }
  if (scenario === 'basic-month-total') {
    const rows = [
      { month: '2026-06', flights: 3387, arrivals: 1694, departures: 1693 },
    ];
    return { scenario, rows };
  }
  if (/\bops_date\b/i.test(sql) && /\bgroup\s+by\s+ops_date\b/i.test(sql)) {
    const rows = [
      { ops_date: '2026-06-18', flights: 128, arrivals: 62, departures: 66 },
      { ops_date: '2026-06-13', flights: 121, arrivals: 58, departures: 63 },
      { ops_date: '2026-06-28', flights: 120, arrivals: 62, departures: 58 },
      { ops_date: '2026-06-23', flights: 100, arrivals: 49, departures: 51 },
    ];
    return { scenario, rows };
  }
  const rows = [
    { airline: 'AK', route: 'KUL', local_hour: 11, type: 'A', flights: 6 },
    { airline: 'VJ', route: 'SIN', local_hour: 8, type: 'D', flights: 4 },
  ];
  return { scenario, rows };
}

function latestPromptFromRequest(req) {
  const messages = [...(req.messages || [])].reverse();
  for (const message of messages) {
    if (message.role !== 'user' || !Array.isArray(message.content)) continue;
    const textBlocks = message.content
      .filter((block) => block?.type === 'text' && typeof block.text === 'string' && !block.text.startsWith('<env>'))
      .map((block) => block.text);
    if (textBlocks.length > 0) return textBlocks.at(-1);
  }
  return DEFAULT_PROMPT;
}

function latestToolResultFromRequest(req) {
  const messages = [...(req.messages || [])].reverse();
  for (const message of messages) {
    if (message.role !== 'user' || !Array.isArray(message.content)) continue;
    for (const block of [...message.content].reverse()) {
      if (block?.type !== 'tool_result' || typeof block.content !== 'string') continue;
      try {
        return JSON.parse(block.content);
      } catch {
        return null;
      }
    }
  }
  return null;
}

function formatInteger(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number.toLocaleString('vi-VN') : String(value ?? '0');
}

function formatDateVi(value) {
  const text = String(value || '');
  const match = text.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  return match ? `${match[3]}/${match[2]}/${match[1]}` : text;
}

function finalTextForQueryResult(queryResult) {
  const scenario = queryResult?.scenario;
  const rows = Array.isArray(queryResult?.rows) ? queryResult.rows : [];
  if (scenario === 'specific-flight') {
    const row = rows[0] || {};
    if (!row.flight) return 'Không tìm thấy chuyến bay cụ thể trong SQLite local theo điều kiện đã hỏi.';
    return `Chuyến ${row.flight} ngày ${formatDateVi(row.ops_date)} là chuyến ${row.route || 'chưa rõ route'}, giờ local ${String(row.local_hour ?? '').padStart(2, '0')}:00, aircraft ${row.aircraft || 'chưa rõ'}, gate ${row.gate || 'chưa rõ'}, stand ${row.stand || 'chưa rõ'}, PAX ${formatInteger(row.pax)}.`;
  }
  if (scenario === 'single-day-detail') {
    const totalFlights = Number(rows[0]?.total_day_flights ?? rows.reduce((sum, row) => sum + Number(row.flights || 0), 0));
    const top = rows[0] || {};
    const second = rows[1] || {};
    return `Ngày 18/06/2026 có ${formatInteger(totalFlights)} chuyến. Driver nổi bật trong ngày là ${top.route || top.airline || 'nhóm dẫn đầu'} với ${formatInteger(top.flights)} chuyến${second.route ? `, kế đến ${second.route} với ${formatInteger(second.flights)} chuyến` : ''}; đây là drilldown theo airline/route của đúng ngày bay.`;
  }
  if (scenario === 'month-comparison') {
    const previous = rows.find((row) => row.month === '2026-05') || rows[0] || {};
    const current = rows.find((row) => row.month === '2026-06') || rows[1] || {};
    const delta = Number(current.flights || 0) - Number(previous.flights || 0);
    const deltaPct = Number(previous.flights) ? (delta / Number(previous.flights)) * 100 : 0;
    const verb = delta >= 0 ? 'tăng' : 'giảm';
    return `So sánh tháng 6/2026 với tháng 5/2026: tháng 6 có ${formatInteger(current.flights)} chuyến, tháng 5 có ${formatInteger(previous.flights)} chuyến, ${verb} ${formatInteger(Math.abs(delta))} chuyến (${deltaPct.toLocaleString('vi-VN', { maximumFractionDigits: 1 })}%). ARR ${verb} ${formatInteger(Math.abs(Number(current.arrivals || 0) - Number(previous.arrivals || 0)))} và DEP ${verb} ${formatInteger(Math.abs(Number(current.departures || 0) - Number(previous.departures || 0)))}.`;
  }
  if (scenario === 'basic-month-total') {
    const row = rows[0] || {};
    return `Tháng 6/2026 ghi nhận ${formatInteger(row.flights)} chuyến, gồm ${formatInteger(row.arrivals)} ARR và ${formatInteger(row.departures)} DEP. Đây là tổng tháng từ truy vấn SQLite local.`;
  }
  const top = rows[0] || {};
  const lowest = rows.reduce((min, row) => Number(row.flights || 0) < Number(min.flights || 0) ? row : min, rows[0] || {});
  return `Ngày cao điểm tháng 6 là ${formatDateVi(top.ops_date)} với ${formatInteger(top.flights)} chuyến, cao hơn trung bình các ngày còn lại trong tháng; ngày thấp nhất trong mẫu là ${formatDateVi(lowest.ops_date)} với ${formatInteger(lowest.flights)} chuyến.`;
}

class MockDashboardProvider {
  id = 'dashboard-skawld-mock-provider';

  contextWindow() {
    return 16000;
  }

  async *stream(req) {
    const hasToolResult = req.messages.some((message) =>
      message.content?.some((block) => block.type === 'tool_result')
    );

    yield { type: 'message_start', model: req.model };

    if (!hasToolResult) {
      const prompt = latestPromptFromRequest(req);
      const scenario = inferScenarioFromPrompt(prompt);
      const sql = buildSqlForScenario(scenario, prompt);
      yield { type: 'text_delta', text: 'Tôi sẽ truy vấn SQLite local read-only đúng theo phạm vi câu hỏi. ' };
      yield { type: 'tool_use_start', id: `tool-${scenario}`, name: 'query_local_sql' };
      yield { type: 'tool_use_input_delta', id: `tool-${scenario}`, json_delta: JSON.stringify({ sql }) };
      yield { type: 'tool_use_end', id: `tool-${scenario}` };
      yield {
        type: 'message_end',
        stop_reason: 'tool_use',
        usage: { input_tokens: 120, output_tokens: 80 },
      };
      return;
    }

    const queryResult = latestToolResultFromRequest(req);
    yield {
      type: 'text_delta',
      text: finalTextForQueryResult(queryResult),
    };
    yield {
      type: 'message_end',
      stop_reason: 'end_turn',
      usage: { input_tokens: 220, output_tokens: 60 },
    };
  }
}

function createQueryLocalSqlTool(options = {}) {
  return {
    name: 'query_local_sql',
    description: 'Query SQLite local read-only cho Dashboard AI bằng SELECT/WITH đã validate.',
    input_schema: {
      type: 'object',
      properties: {
        sql: { type: 'string', description: 'Read-only SELECT hoặc WITH ... SELECT trên dashboard_ai_flight_operations.' },
      },
      required: ['sql'],
    },
    scope: 'read',
    parallelSafe: true,
    validate(raw) {
      const sql = ensureReadOnlySelectSql(raw.sql);
      return { sql };
    },
    summarize(input) {
      return `Truy vấn SQLite local read-only: ${input.sql.slice(0, 120)}`;
    },
    async execute(input) {
      const scenario = inferScenarioFromSql(input.sql);
      let source = options.source || 'auto';
      let queryResult;
      if (source !== 'mock') {
        try {
          queryResult = await queryDashboardAiLocalSql({
            sql: input.sql,
            params: [],
            limit: 500,
            queryId: `skawld-harness-${scenario}`,
            dbPath: options.dbPath,
          });
          source = 'local-sqlite';
        } catch (error) {
          if (options.source === 'local-sqlite') throw error;
          queryResult = buildMockQueryResult(input.sql);
          source = 'mock';
        }
      } else {
        queryResult = buildMockQueryResult(input.sql);
      }
      queryResult.scenario = queryResult.scenario || scenario;
      queryResult.source = source;
      const rows = queryResult.rows;
      return {
        content: JSON.stringify({
          queryId: queryResult.queryId || `skawld-harness-${queryResult.scenario}`,
          scenario: queryResult.scenario,
          source,
          columns: queryResult.columns || Object.keys(rows[0] || {}),
          rows,
          rowCount: queryResult.rowCount ?? rows.length,
          truncated: queryResult.truncated ?? false,
          executedSqlPreview: queryResult.executedSqlPreview || input.sql,
          dataQualityNotes: queryResult.dataQualityNotes || [],
        }, null, 2),
        summary: `Đã chạy query_local_sql ${source}, trả ${rows.length} dòng.`,
      };
    },
  };
}

export async function runSkawldDashboardAgentHarness(input = {}) {
  const prompt = String(input.prompt || DEFAULT_PROMPT);
  const source = ['mock', 'local-sqlite', 'auto'].includes(input.source) ? input.source : 'auto';
  const [{ Agent }, providers, { ToolRegistry }, { InMemorySessionStore }] = await Promise.all([
    import('@skawld/agent-sdk'),
    import('@skawld/agent-sdk/providers'),
    import('@skawld/agent-sdk/tools'),
    import('@skawld/agent-sdk/sessions'),
  ]);
  if (typeof providers.BaseProvider !== 'function') {
    throw new Error('Skawld providers subpath không có BaseProvider.');
  }

  const tools = new ToolRegistry();
  tools.register(createQueryLocalSqlTool({ source, dbPath: input.dbPath || DEFAULT_DASHBOARD_AI_LOCAL_DB_PATH }));

  const agent = new Agent({
    provider: new MockDashboardProvider(),
    model: 'dashboard-skawld-mock',
    tools,
    sessionStore: new InMemorySessionStore(),
    cwd: process.cwd(),
    permissions: { mode: 'default', rules: [] },
    systemPrompt: [
      'Bạn là Dashboard AI dev harness.',
      'Luôn trả lời tiếng Việt.',
      'Chỉ dùng query_local_sql read-only.',
      PRODUCTION_WARNING,
    ].join('\n'),
    includePartialMessages: true,
    maxTurns: 4,
  });

  const session = await agent.session({ meta: { source: 'dashboard-ai-skawld-harness' } });
  const events = [];
  const toolResults = [];
  let finalText = '';
  const errors = [];

  try {
    for await (const event of session.run(prompt)) {
      events.push(event);
      if (event.type === 'tool_call_end') toolResults.push(event);
      if (event.type === 'result') finalText = event.final_text || finalText;
      if (event.type === 'error') errors.push(event.error?.message || 'Unknown Skawld error');
    }
  } finally {
    await agent.close();
  }

  /** @typedef {{ prompt: string, status: 'completed' | 'failed', events: unknown[], toolResults: unknown[], finalText: string, errors: string[], warning: string }} DashboardAiRuntimeSpikeResult */
  const result = {
    prompt,
    status: errors.length > 0 ? 'failed' : 'completed',
    events,
    toolResults,
    finalText,
    errors,
    warning: PRODUCTION_WARNING,
    source,
    dbPath: input.dbPath || DEFAULT_DASHBOARD_AI_LOCAL_DB_PATH,
  };
  return result;
}

async function main() {
  const args = parseArgs(process.argv);
  const result = await runSkawldDashboardAgentHarness({ prompt: args.prompt, source: args.source, dbPath: args.dbPath });

  if (!args.jsonOnly) {
    process.stdout.write(`${PRODUCTION_WARNING}\n`);
    process.stdout.write(`Prompt: ${result.prompt}\n`);
    process.stdout.write(`Status: ${result.status}\n`);
    process.stdout.write(`Events: ${result.events.map((event) => event.type).join(' -> ')}\n`);
    if (result.finalText) process.stdout.write(`Final: ${result.finalText}\n`);
  }
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (result.status !== 'completed') process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1].replace(/\\/g, '/')}`).href) {
  await main();
}
