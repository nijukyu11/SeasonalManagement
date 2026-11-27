/**
 * Planning Dashboard Source Loader & KPI Engine
 *
 * Responsibilities:
 * - Load complete seasonal planning source (Draft or Published) with consistent epoch/revision or versionId/checksum fence.
 * - Handle snapshot_changed retries on Draft paging without mixing partial batches.
 * - Extract pure planning KPIs (total legs, ARR, DEP, unique airlines, unique routes, peak day).
 * - Avoid importing or mixing operational live runtime legs, actual Pax, or runtime alerts.
 */
import type {
  PlanningSourceIdentity,
  PlanningSourceKind,
  SeasonalDraftRecord,
  SeasonalDraftWindowResult,
  SeasonalPublishedSnapshotPageResult,
} from './seasonalPlanningContract.ts';
import { buildEffectiveDashboardRecords } from './dashboardAnalysis.ts';
import type { FlightRecord, FlightModification } from './types.ts';

export type { PlanningSourceIdentity, PlanningSourceKind };


export interface PlanningSourceLoadResult {
  identity: PlanningSourceIdentity;
  seasonId: string;
  flights: SeasonalDraftRecord[];
  status: 'idle' | 'loading' | 'success' | 'error' | 'stale';
  error: string | null;
  isStale: boolean;
  isEmpty: boolean;
  totalCount: number;
}

export interface PlanningKpiSummary {
  totalLegs: number;
  arrLegs: number;
  depLegs: number;
  uniqueAirlines: number;
  uniqueRoutes: number;
  peakDay: { date: string; count: number } | null;
}

// ---------------------------------------------------------------------------
// Planning Source Loaders
// ---------------------------------------------------------------------------

export type PlanningSourceDraftTransport = (input: {
  seasonId: string;
  pageSize?: number;
  afterDraftId?: string | null;
  expectedEpoch?: string | null;
  expectedRevision?: string | number | null;
}) => Promise<SeasonalDraftWindowResult>;

export type PlanningSourcePublishedTransport = (input: {
  versionId: string;
  afterDraftId?: string | null;
  pageSize?: number;
}) => Promise<SeasonalPublishedSnapshotPageResult>;

export type LegacyDashboardTransport = (seasonId: string) => Promise<{
  records: FlightRecord[];
  modifications: Map<string, FlightModification>;
}>;

export function buildLegacyDashboardFlights(
  seasonId: string,
  records: FlightRecord[],
  modifications: Map<string, FlightModification>,
): SeasonalDraftRecord[] {
  return buildEffectiveDashboardRecords(records, modifications).map((record) => ({
    draft_id: record.draftId ?? record.id,
    season_id: seasonId,
    link_id: record.linkId,
    type: record.type,
    airline: record.airline,
    flight_number: record.flightNumber,
    raw_flight_number: record.rawFlightNumber,
    request_status_code: record.requestStatusCode,
    route: record.route,
    schedule: record.schedule,
    aircraft: record.aircraft,
    category: record.category,
    code_shares: record.codeShares,
    int_dom_ind: record.intDomInd,
    pax: record.pax,
    gate: record.gate,
    stand: record.stand,
    carousel: record.carousel,
    mct: record.mct,
    fb: record.fb,
    lb: record.lb,
    bhs: record.bhs,
    ghs: record.ghs,
    date: record.date,
    scheduled_date: record.scheduledDate ?? record.date,
    scheduled_time: record.scheduledTime ?? record.schedule,
    operational_date: record.operationalDate ?? null,
    day_of_week: record.dayOfWeek,
    action: record.action === 'deleted' ? null : record.action,
    source_row_index: record.sourceRowIndex,
    linked_draft_id: record.linkedRecordId ?? null,
    link_type: record.linkType ?? null,
    pair_anchor_date: record.pairAnchorDate ?? null,
    turnaround_id: record.turnaroundId ?? null,
    source_kind: record.sourceKind === 'manual' || record.sourceKind === 'added' ? 'manual' : 'imported',
    source_side: record.sourceSide,
    status: 'active',
    check_in_start: record.checkInStart ?? null,
    check_in_end: record.checkInEnd ?? null,
    check_in_allocation_mode: record.checkInAllocationMode ?? null,
  }));
}

export async function loadDashboardOverviewSource(params: {
  seasonId: string;
  planningV1Enabled: boolean;
  sourceKind: PlanningSourceKind;
  versionId?: string;
  draftTransportFn?: PlanningSourceDraftTransport;
  publishedTransportFn?: PlanningSourcePublishedTransport;
  legacyTransportFn?: LegacyDashboardTransport;
}): Promise<PlanningSourceLoadResult> {
  if (params.planningV1Enabled) {
    const result = await loadSeasonalPlanningSource(params);
    if (result.status === 'error') {
      throw new Error(result.error || 'Không thể tải dữ liệu kế hoạch V1');
    }
    return result;
  }
  if (params.sourceKind !== 'draft') {
    throw new Error('Published planning sources are unavailable in legacy workspace mode.');
  }
  const fetchLegacy = params.legacyTransportFn || (await import('./remoteStore.ts')).getDashboardSeasonData;
  const legacy = await fetchLegacy(params.seasonId);
  const flights = buildLegacyDashboardFlights(params.seasonId, legacy.records, legacy.modifications);
  return {
    identity: { seasonId: params.seasonId, sourceKind: 'draft' },
    seasonId: params.seasonId,
    flights,
    status: 'success',
    error: null,
    isStale: false,
    isEmpty: flights.length === 0,
    totalCount: flights.length,
  };
}

/**
 * Loads all draft flight records for a season with epoch/revision fencing.
 * Retries up to 3 times from scratch if `snapshot_changed` is encountered mid-paging.
 */
export async function loadFullSeasonalDraftSource(params: {
  seasonId: string;
  expectedEpoch?: string | null;
  expectedRevision?: string | number | null;
  signal?: AbortSignal;
  transportFn?: PlanningSourceDraftTransport;
}): Promise<{
  flights: SeasonalDraftRecord[];
  epoch: string;
  revision: string;
}> {
  // Lazy import avoids loading remoteStore runtime during isolated unit tests using transportFn
  const fetchFn = params.transportFn || (await import('./remoteStore.ts')).getSeasonalDraftWindowV1;
  const MAX_RETRIES = 3;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    if (params.signal?.aborted) {
      throw new Error('Đã hủy tải dữ liệu kế hoạch');
    }

    const records: SeasonalDraftRecord[] = [];
    const seenDraftIds = new Set<string>();
    const seenCursors = new Set<string>();
    let afterDraftId: string | null = null;
    let hasMore = true;
    let pinnedEpoch: string | null = null;
    let pinnedRevision: string | null = null;
    let snapshotChanged = false;

    while (hasMore) {
      if (params.signal?.aborted) {
        throw new Error('Đã hủy tải dữ liệu kế hoạch');
      }

      const res: SeasonalDraftWindowResult = await fetchFn({
        seasonId: params.seasonId,
        pageSize: 1000,
        afterDraftId,
        expectedEpoch: pinnedEpoch ?? params.expectedEpoch ?? null,
        expectedRevision: pinnedRevision ?? params.expectedRevision ?? null,
      });

      if (res.status === 'snapshot_changed') {
        snapshotChanged = true;
        break;
      }

      // First page pinning & expected fence check
      if (pinnedEpoch === null) {
        if (params.expectedEpoch && res.epoch !== params.expectedEpoch) {
          throw new Error(`Draft epoch không khớp yêu cầu: mong đợi ${params.expectedEpoch}, nhận được ${res.epoch}`);
        }
        if (
          params.expectedRevision !== undefined &&
          params.expectedRevision !== null &&
          String(res.revision) !== String(params.expectedRevision)
        ) {
          throw new Error(
            `Draft revision không khớp yêu cầu: mong đợi ${params.expectedRevision}, nhận được ${res.revision}`
          );
        }
        pinnedEpoch = res.epoch;
        pinnedRevision = String(res.revision);
      } else {
        // Subsequent pages: check for mid-paging drift
        if (res.epoch !== pinnedEpoch || String(res.revision) !== pinnedRevision) {
          throw new Error(
            `Dữ liệu Draft thay đổi revision/epoch trong khi đang phân trang (trang đầu ${pinnedEpoch}/${pinnedRevision}, trang hiện tại ${res.epoch}/${res.revision})`
          );
        }
      }

      for (const draft of res.drafts) {
        if (!draft || !draft.draft_id) continue;
        if (draft.status === 'deleted' || draft.action === 'deleted') continue;
        if (seenDraftIds.has(draft.draft_id)) continue;
        seenDraftIds.add(draft.draft_id);
        records.push(draft);
      }

      hasMore = Boolean(res.hasMore);
      if (hasMore) {
        if (!res.nextDraftId || res.nextDraftId.trim() === '') {
          throw new Error('Phân trang Draft không hợp lệ: hasMore=true nhưng thiếu nextDraftId');
        }
        if (seenCursors.has(res.nextDraftId)) {
          throw new Error(`Phân trang Draft không hợp lệ: phát hiện lặp cursor (${res.nextDraftId})`);
        }
        seenCursors.add(res.nextDraftId);
        afterDraftId = res.nextDraftId;
      } else {
        afterDraftId = null;
      }
    }

    if (!snapshotChanged) {
      return {
        flights: records,
        epoch: pinnedEpoch || '',
        revision: pinnedRevision || '0',
      };
    }

    // If caller passed an expected revision/epoch, do not retry forever against stale expected
    if (params.expectedEpoch || (params.expectedRevision !== undefined && params.expectedRevision !== null)) {
      throw new Error(
        `Dữ liệu Draft đã thay đổi phiên bản (snapshot_changed) so với mong đợi (${params.expectedEpoch || ''} rev ${params.expectedRevision ?? ''})`
      );
    }

    if (attempt === MAX_RETRIES) {
      throw new Error('Dữ liệu Draft thay đổi liên tục trong khi tải (snapshot_changed). Vui lòng thử lại.');
    }
  }

  throw new Error('Không thể hoàn tất tải dữ liệu Draft');
}

/**
 * Loads all published snapshot flight records for a specific published version.
 * Published snapshots are immutable.
 */
export async function loadFullSeasonalPublishedSource(params: {
  versionId: string;
  signal?: AbortSignal;
  transportFn?: PlanningSourcePublishedTransport;
}): Promise<{
  flights: SeasonalDraftRecord[];
  versionId: string;
  seasonId: string;
  seasonCode: string;
  checksum: string;
  totalCount: number;
}> {
  // Lazy import avoids loading remoteStore runtime during isolated unit tests using transportFn
  const fetchFn = params.transportFn || (await import('./remoteStore.ts')).getSeasonalPublishedSnapshotPageV1;
  const records: SeasonalDraftRecord[] = [];
  const seenDraftIds = new Set<string>();
  const seenCursors = new Set<string>();
  let afterDraftId: string | null = null;
  let hasMore = true;
  let pinnedVersionId: string | null = null;
  let pinnedChecksum: string | null = null;
  let pinnedSeasonId: string | null = null;
  let seasonCode = '';
  let totalCount = 0;

  while (hasMore) {
    if (params.signal?.aborted) {
      throw new Error('Đã hủy tải dữ liệu phiên bản công bố');
    }

    const res: SeasonalPublishedSnapshotPageResult = await fetchFn({
      versionId: params.versionId,
      pageSize: 1000,
      afterDraftId,
    });

    if (pinnedVersionId === null) {
      if (res.versionId !== params.versionId) {
        throw new Error(`Dữ liệu snapshot versionId không khớp: yêu cầu ${params.versionId}, nhận được ${res.versionId}`);
      }
      pinnedVersionId = res.versionId;
      pinnedChecksum = res.checksum;
      pinnedSeasonId = res.seasonId;
      seasonCode = res.seasonCode || '';
      totalCount = res.totalCount || 0;
    } else {
      if (res.versionId !== pinnedVersionId) {
        throw new Error(
          `Dữ liệu snapshot versionId bị trôi giữa các trang: mong đợi ${pinnedVersionId}, nhận được ${res.versionId}`
        );
      }
      if (res.checksum !== pinnedChecksum) {
        throw new Error(
          `Dữ liệu snapshot checksum bị trôi giữa các trang: mong đợi ${pinnedChecksum}, nhận được ${res.checksum}`
        );
      }
      if (res.seasonId !== pinnedSeasonId) {
        throw new Error(
          `Dữ liệu snapshot seasonId bị trôi giữa các trang: mong đợi ${pinnedSeasonId}, nhận được ${res.seasonId}`
        );
      }
    }

    for (const flight of res.flights) {
      if (!flight || !flight.draft_id) continue;
      if (flight.status === 'deleted' || flight.action === 'deleted') continue;
      if (seenDraftIds.has(flight.draft_id)) continue;
      seenDraftIds.add(flight.draft_id);
      records.push(flight);
    }

    hasMore = Boolean(res.hasMore);
    if (hasMore) {
      if (!res.nextDraftId || res.nextDraftId.trim() === '') {
        throw new Error('Phân trang Snapshot không hợp lệ: hasMore=true nhưng thiếu nextDraftId');
      }
      if (seenCursors.has(res.nextDraftId)) {
        throw new Error(`Phân trang Snapshot không hợp lệ: phát hiện lặp cursor (${res.nextDraftId})`);
      }
      seenCursors.add(res.nextDraftId);
      afterDraftId = res.nextDraftId;
    } else {
      afterDraftId = null;
    }
  }

  return {
    flights: records,
    versionId: pinnedVersionId || params.versionId,
    seasonId: pinnedSeasonId || '',
    seasonCode,
    checksum: pinnedChecksum || '',
    totalCount,
  };
}

/**
 * Unified loader for seasonal planning sources (Draft or Published).
 */
export async function loadSeasonalPlanningSource(params: {
  seasonId: string;
  sourceKind: PlanningSourceKind;
  versionId?: string | null;
  expectedEpoch?: string | null;
  expectedRevision?: string | number | null;
  signal?: AbortSignal;
  draftTransportFn?: PlanningSourceDraftTransport;
  publishedTransportFn?: PlanningSourcePublishedTransport;
}): Promise<PlanningSourceLoadResult> {
  try {
    if (params.sourceKind === 'published') {
      if (!params.versionId) {
        throw new Error('versionId is required for published planning source');
      }
      const pub = await loadFullSeasonalPublishedSource({
        versionId: params.versionId,
        signal: params.signal,
        transportFn: params.publishedTransportFn,
      });

      return {
        identity: {
          seasonId: pub.seasonId || params.seasonId,
          sourceKind: 'published',
          versionId: pub.versionId,
          snapshotChecksum: pub.checksum,
        },
        seasonId: pub.seasonId || params.seasonId,
        flights: pub.flights,
        status: 'success',
        error: null,
        isStale: false,
        isEmpty: pub.flights.length === 0,
        totalCount: pub.flights.length,
      };
    }

    // Default: draft source
    const draft = await loadFullSeasonalDraftSource({
      seasonId: params.seasonId,
      expectedEpoch: params.expectedEpoch,
      expectedRevision: params.expectedRevision,
      signal: params.signal,
      transportFn: params.draftTransportFn,
    });

    return {
      identity: {
        seasonId: params.seasonId,
        sourceKind: 'draft',
        draftEpoch: draft.epoch,
        draftRevision: draft.revision,
      },
      seasonId: params.seasonId,
      flights: draft.flights,
      status: 'success',
      error: null,
      isStale: false,
      isEmpty: draft.flights.length === 0,
      totalCount: draft.flights.length,
    };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      identity: {
        seasonId: params.seasonId,
        sourceKind: params.sourceKind,
        draftEpoch: params.expectedEpoch,
        draftRevision: params.expectedRevision,
        versionId: params.versionId,
      },
      seasonId: params.seasonId,
      flights: [],
      status: 'error',
      error: message,
      isStale: false,
      isEmpty: true,
      totalCount: 0,
    };
  }
}

// ---------------------------------------------------------------------------
// Pure Planning KPI Aggregation
// ---------------------------------------------------------------------------

/**
 * Computes planning KPI totals from a planning source flight list.
 * Optional date range [dateFrom, dateTo] filters flights by scheduled date.
 * Excludes Pax actual, coverage, or runtime alerts.
 */
export function computePlanningKpi(
  flights: readonly SeasonalDraftRecord[],
  dateFrom?: string | null,
  dateTo?: string | null
): PlanningKpiSummary {
  let totalLegs = 0;
  let arrLegs = 0;
  let depLegs = 0;
  const airlines = new Set<string>();
  const routes = new Set<string>();
  const countByDate = new Map<string, number>();

  for (const f of flights) {
    if (!f || f.status === 'deleted' || f.action === 'deleted') continue;

    const flightDate = f.scheduled_date || f.date;
    if (!flightDate) continue;

    if (dateFrom && flightDate < dateFrom) continue;
    if (dateTo && flightDate > dateTo) continue;

    totalLegs++;

    const side = f.type === 'A' || ('side' in f && f.side === 'ARR') ? 'ARR' : 'DEP';
    if (side === 'ARR') {
      arrLegs++;
    } else {
      depLegs++;
    }

    if (f.airline && f.airline.trim()) {
      airlines.add(f.airline.trim().toUpperCase());
    }

    if (f.route && f.route.trim()) {
      routes.add(f.route.trim().toUpperCase());
    }

    const currentCount = (countByDate.get(flightDate) || 0) + 1;
    countByDate.set(flightDate, currentCount);
  }

  let peakDay: { date: string; count: number } | null = null;
  for (const [date, count] of countByDate.entries()) {
    if (!peakDay || count > peakDay.count) {
      peakDay = { date, count };
    }
  }

  return {
    totalLegs,
    arrLegs,
    depLegs,
    uniqueAirlines: airlines.size,
    uniqueRoutes: routes.size,
    peakDay,
  };
}
