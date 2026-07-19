import type {
  RemoteSeasonalExportSnapshot,
  RemoteSeasonalImportInput,
  RemoteSeasonalImportResult,
  RemoteSeasonWorkspaceWindowResult,
} from './remoteStore.ts';
import type { Season } from './types.ts';

export interface SeasonalImportStatusUnknownNotice {
  title: 'Import status unknown';
  message: string;
}

export interface TargetedCommittedImportRefreshResult {
  seasons: Season[];
  season: Season;
  snapshot: RemoteSeasonalExportSnapshot;
  window: RemoteSeasonWorkspaceWindowResult;
}

export async function resumeSeasonalImportAttemptOnce(
  attempt: RemoteSeasonalImportInput,
  applyImport: (storedAttempt: RemoteSeasonalImportInput) => Promise<RemoteSeasonalImportResult>,
): Promise<RemoteSeasonalImportResult> {
  return applyImport(attempt);
}

export async function loadTargetedCommittedImportRefresh(input: {
  committedImport: RemoteSeasonalImportResult;
  loadSeasons: () => Promise<Season[]>;
  loadSnapshot: (snapshotInput: {
    seasonId: string;
    expectedDataVersion: number;
  }) => Promise<RemoteSeasonalExportSnapshot>;
  allowEmptyCommittedImport?: boolean;
}): Promise<TargetedCommittedImportRefreshResult> {
  const targetSeasonId = input.committedImport.seasonId;
  const seasonsPromise = input.loadSeasons();
  const snapshotPromise = input.loadSnapshot({
    seasonId: targetSeasonId,
    expectedDataVersion: input.committedImport.dataVersion,
  });
  const [seasons, snapshot] = await Promise.all([seasonsPromise, snapshotPromise]);
  const season = seasons.find((candidate) => candidate.id === targetSeasonId);
  if (!season) {
    throw new Error(`Committed season ${targetSeasonId} is missing from the authoritative season list.`);
  }
  if (snapshot.seasonId !== targetSeasonId) {
    throw new Error(`Committed refresh seasonId mismatch: expected ${targetSeasonId}, received ${snapshot.seasonId}.`);
  }
  if (snapshot.seasonCode !== input.committedImport.seasonCode) {
    throw new Error(`Committed refresh seasonCode mismatch: expected ${input.committedImport.seasonCode}, received ${snapshot.seasonCode}.`);
  }
  if (season.seasonCode !== input.committedImport.seasonCode) {
    throw new Error(`Committed refresh season metadata code mismatch: expected ${input.committedImport.seasonCode}, received ${season.seasonCode}.`);
  }
  if (season.dataVersion !== input.committedImport.dataVersion || snapshot.dataVersion !== input.committedImport.dataVersion) {
    throw new Error(`Committed refresh dataVersion mismatch for season ${targetSeasonId}.`);
  }
  if (!Number.isSafeInteger(snapshot.serverHighWater) || snapshot.serverHighWater < input.committedImport.serverHighWater) {
    throw new Error(`Committed refresh serverHighWater is stale for season ${targetSeasonId}.`);
  }
  if (snapshot.truncated !== false) {
    throw new Error(`Committed refresh snapshot for season ${targetSeasonId} is truncated.`);
  }
  if (!Array.isArray(snapshot.records)) {
    throw new Error(`Committed refresh records must be an array for season ${targetSeasonId}.`);
  }
  if (!(snapshot.modifications instanceof Map)) {
    throw new Error(`Committed refresh modifications must be a Map for season ${targetSeasonId}.`);
  }
  if (snapshot.sourceRowCount !== input.committedImport.sourceRowCount) {
    throw new Error(`Committed refresh source row count does not match the committed source row count for season ${targetSeasonId}.`);
  }
  if (season.totalSourceRows !== input.committedImport.sourceRowCount) {
    throw new Error(`Committed refresh season metadata source row count does not match the commit for season ${targetSeasonId}.`);
  }
  if (snapshot.records.length !== snapshot.totalCount) {
    throw new Error(`Committed refresh record count does not match totalCount for season ${targetSeasonId}.`);
  }
  const malformedSourceKind = snapshot.records.find((record) => (
    record.sourceKind !== 'imported' && record.sourceKind !== 'added'
  ));
  if (malformedSourceKind) {
    throw new Error(`Committed refresh record ${malformedSourceKind.id} has an invalid sourceKind.`);
  }
  const importedRecordCount = snapshot.records.reduce(
    (count, record) => count + (record.sourceKind === 'imported' ? 1 : 0),
    0,
  );
  if (importedRecordCount !== input.committedImport.flightRecordCount) {
    throw new Error(`Committed refresh imported flight record count does not match the commit for season ${targetSeasonId}.`);
  }
  if (importedRecordCount === 0 && !input.allowEmptyCommittedImport) {
    throw new Error(`Committed refresh returned an empty season ${targetSeasonId}; empty repair is not allowed.`);
  }

  const window: RemoteSeasonWorkspaceWindowResult = {
    sourceRows: [],
    records: snapshot.records,
    modifications: snapshot.modifications,
    syncMeta: {
      seasonId: targetSeasonId,
      baseServerVersion: snapshot.serverHighWater,
      lastServerSeq: snapshot.serverHighWater,
      localRevision: snapshot.serverHighWater,
      pendingCount: 0,
      lastLocalChangeAt: null,
      conflicts: [],
      syncStatus: 'synced',
    },
    cursor: { serverHighWater: snapshot.serverHighWater },
  };
  return { seasons, season, snapshot, window };
}

export function buildSeasonalImportStatusUnknownNotice(
  attempt: Pick<RemoteSeasonalImportInput, 'requestId'>,
  cause: unknown,
): SeasonalImportStatusUnknownNotice {
  const causeMessage = cause instanceof Error && cause.message
    ? cause.message
    : typeof cause === 'string' && cause.trim()
      ? cause
      : 'The server did not return a conclusive import result.';
  return {
    title: 'Import status unknown',
    message:
      `Import status unknown for request ID ${attempt.requestId}. ${causeMessage} ` +
      'Use Resume/Check to query the same request without creating a new import attempt.',
  };
}
