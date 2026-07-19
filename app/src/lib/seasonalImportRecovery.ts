import type {
  RemoteSeasonalImportInput,
  RemoteSeasonalImportResult,
  RemoteSeasonWorkspaceWindowInput,
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
  windowInput: Omit<RemoteSeasonWorkspaceWindowInput, 'seasonId'>;
  loadSeasons: () => Promise<Season[]>;
  loadWindow: (windowInput: RemoteSeasonWorkspaceWindowInput) => Promise<RemoteSeasonWorkspaceWindowResult | null>;
}): Promise<TargetedCommittedImportRefreshResult> {
  const targetSeasonId = input.committedImport.seasonId;
  const seasonsPromise = input.loadSeasons();
  const windowPromise = input.loadWindow({
    ...input.windowInput,
    seasonId: targetSeasonId,
  });
  const [seasons, window] = await Promise.all([seasonsPromise, windowPromise]);
  const season = seasons.find((candidate) => candidate.id === targetSeasonId);
  if (!season) {
    throw new Error(`Committed season ${targetSeasonId} is missing from the authoritative season list.`);
  }
  if (!window) {
    throw new Error(`Committed season ${targetSeasonId} authoritative server window is unavailable.`);
  }
  return { seasons, season, window };
}

export function buildSeasonalImportStatusUnknownNotice(
  attempt: RemoteSeasonalImportInput,
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
