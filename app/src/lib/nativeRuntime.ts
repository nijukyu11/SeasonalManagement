function getTauriGlobal(): Record<string, unknown> {
  return globalThis as Record<string, unknown>;
}

export function isTauriRuntime(): boolean {
  const tauriGlobal = getTauriGlobal();
  return (
    Object.prototype.hasOwnProperty.call(tauriGlobal, '__TAURI_INTERNALS__') ||
    Object.prototype.hasOwnProperty.call(tauriGlobal, '__TAURI__')
  );
}
