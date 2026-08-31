import {
  TRAFFIC_REPORT_V2_API_BASE,
  decodeTrafficV2ApiEnvelope,
  type TrafficV2Bundle,
} from './trafficReportV2Contract.ts';
import {
  toTrafficReportSearchParams,
  type TrafficReportFilter,
} from './trafficReportContract.ts';

export interface TrafficReportFetchOptions {
  signal?: AbortSignal;
  expectedWatermark?: number;
  fetchImpl?: typeof fetch;
  /** A 409 means the caller must replace, not merge, its current bundle. */
  reloadOnVersionChange?: boolean;
}

export class TrafficReportVersionChangedError extends Error {
  readonly expectedWatermark: number | null;
  readonly actualWatermark: number | null;

  constructor(expectedWatermark: number | null, actualWatermark: number | null) {
    super('Dữ liệu báo cáo đã thay đổi. Cần tải lại toàn bộ báo cáo.');
    this.name = 'TrafficReportVersionChangedError';
    this.expectedWatermark = expectedWatermark;
    this.actualWatermark = actualWatermark;
  }
}

export class TrafficReportRequestError extends Error {
  readonly status: number;
  readonly retryable: boolean;

  constructor(message: string, status: number) {
    super(message);
    this.name = 'TrafficReportRequestError';
    this.status = status;
    this.retryable = status === 408 || status === 429 || status >= 500;
  }
}

interface TrafficErrorPayload {
  error?: unknown;
  error_code?: unknown;
  expected_watermark?: unknown;
  actual_watermark?: unknown;
}

function asSafeWatermark(value: unknown): number | null {
  return Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : null;
}

function errorPayload(value: unknown): TrafficErrorPayload {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as TrafficErrorPayload
    : {};
}

export function buildTrafficReportV2OverviewUrl(
  filter: TrafficReportFilter,
  expectedWatermark?: number,
): string {
  const query = toTrafficReportSearchParams(filter);
  if (expectedWatermark !== undefined) {
    if (!Number.isSafeInteger(expectedWatermark) || expectedWatermark < 0) {
      throw new Error('Watermark kỳ vọng không hợp lệ.');
    }
    query.set('expected_watermark', String(expectedWatermark));
  }
  const serialized = query.toString();
  return `${TRAFFIC_REPORT_V2_API_BASE}/overview${serialized ? `?${serialized}` : ''}`;
}

async function requestBundle(
  filter: TrafficReportFilter,
  fetchImpl: typeof fetch,
  signal: AbortSignal | undefined,
  expectedWatermark: number | undefined,
): Promise<TrafficV2Bundle> {
  const response = await fetchImpl(buildTrafficReportV2OverviewUrl(filter, expectedWatermark), {
    method: 'GET',
    credentials: 'omit',
    headers: { Accept: 'application/json' },
    signal,
  });
  const payload: unknown = await response.json().catch(() => null);
  if (response.status === 409) {
    const details = errorPayload(payload);
    throw new TrafficReportVersionChangedError(
      asSafeWatermark(details.expected_watermark) ?? expectedWatermark ?? null,
      asSafeWatermark(details.actual_watermark),
    );
  }
  if (!response.ok) {
    const details = errorPayload(payload);
    const message = typeof details.error === 'string'
      ? details.error
      : 'Báo cáo tạm thời chưa thể cập nhật.';
    throw new TrafficReportRequestError(message, response.status);
  }
  return decodeTrafficV2ApiEnvelope(payload);
}

/**
 * Shared read adapter for Report and Dashboard Report Mode.
 * It never derives KPI values from row-level data. If a pinned request races a
 * data change, the optional retry deliberately fetches an unpinned full bundle.
 */
export async function fetchTrafficReportV2Bundle(
  filter: TrafficReportFilter,
  options: TrafficReportFetchOptions = {},
): Promise<TrafficV2Bundle> {
  const fetchImpl = options.fetchImpl ?? fetch;
  try {
    return await requestBundle(filter, fetchImpl, options.signal, options.expectedWatermark);
  } catch (error) {
    if (error instanceof TrafficReportVersionChangedError
      && options.expectedWatermark !== undefined
      && options.reloadOnVersionChange !== false) {
      return requestBundle(filter, fetchImpl, options.signal, undefined);
    }
    throw error;
  }
}
