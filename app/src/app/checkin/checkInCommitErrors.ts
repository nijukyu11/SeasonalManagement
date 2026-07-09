const MAX_LEG_IDS_IN_COMMIT_FAILURE = 5;
const CHECK_IN_COMMIT_FAILURE_SOURCE = Symbol('checkInCommitFailureSource');

export type CheckInCommitSource = 'checkin' | 'checkin-worker' | 'checkin-native';

type CheckInCommitFailureError = Error & {
  [CHECK_IN_COMMIT_FAILURE_SOURCE]?: CheckInCommitSource;
};

export interface CheckInCommitFailureInput {
  description: string;
  legIds: readonly string[];
  source: CheckInCommitSource;
  error: unknown;
}

export function withCheckInCommitFailureSource(error: unknown, source: CheckInCommitSource): Error {
  const errorObject = error instanceof Error ? error : new Error(String(error));
  (errorObject as CheckInCommitFailureError)[CHECK_IN_COMMIT_FAILURE_SOURCE] = source;
  return errorObject;
}

export function getCheckInCommitFailureSource(error: unknown, fallback: CheckInCommitSource): CheckInCommitSource {
  if (!(error instanceof Error)) return fallback;
  return (error as CheckInCommitFailureError)[CHECK_IN_COMMIT_FAILURE_SOURCE] ?? fallback;
}

function formatCheckInCommitFailureLegIds(legIds: readonly string[]): string {
  if (legIds.length === 0) return 'unknown leg';
  if (legIds.length <= MAX_LEG_IDS_IN_COMMIT_FAILURE) return legIds.join(', ');
  const visibleLegIds = legIds.slice(0, MAX_LEG_IDS_IN_COMMIT_FAILURE).join(', ');
  return `${visibleLegIds} and ${legIds.length - MAX_LEG_IDS_IN_COMMIT_FAILURE} more`;
}

export function formatCheckInCommitFailure({
  description,
  legIds,
  source,
  error,
}: CheckInCommitFailureInput): string {
  const errorMessage = error instanceof Error ? error.message : String(error);
  return `${description} failed through ${source} for ${formatCheckInCommitFailureLegIds(legIds)}: ${errorMessage}`;
}
