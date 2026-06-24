export const SERVER_AUTHORITATIVE_MODE = true;
export const ALLOW_DURABLE_OFFLINE_WRITES = false;

export const SERVER_AUTHORITATIVE_POLICY_LABEL =
  'Online-first: server latest write wins, local storage is read cache only.';

export function shouldAllowDurableOfflineWrites(): boolean {
  return !SERVER_AUTHORITATIVE_MODE && ALLOW_DURABLE_OFFLINE_WRITES;
}

export function requireOnlineForServerWrite(isOnline: boolean): void {
  if (!isOnline) {
    throw new Error('Online connection is required. Server is the source of truth.');
  }
}
