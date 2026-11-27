export function shouldReportOperationalLoadFailure(input: {
  requestId: number;
  currentRequestId: number;
  cancelled: boolean;
  routeActive: boolean;
  requestRangeKey: string;
  currentRangeKey: string;
}): boolean {
  return !input.cancelled &&
    input.requestId === input.currentRequestId &&
    input.routeActive &&
    input.requestRangeKey === input.currentRangeKey;
}
