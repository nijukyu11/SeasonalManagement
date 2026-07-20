function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error ?? '');
}

export function isMissingRpcSignatureError(error: unknown): boolean {
  return /could not find the function|schema cache|PGRST202|function .* does not exist/i.test(errorMessage(error));
}

export function isStatementTimeoutError(error: unknown): boolean {
  return /statement timeout|canceling statement due to statement timeout/i.test(errorMessage(error));
}

export function shouldUseLegacyWorkspaceWindowRpc(error: unknown): boolean {
  return isMissingRpcSignatureError(error);
}
