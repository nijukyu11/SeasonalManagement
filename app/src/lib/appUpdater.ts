import { isTauriRuntime } from './nativeRuntime.ts';

type TauriUpdaterModule = {
  check: () => Promise<TauriUpdate | null>;
};

type TauriProcessModule = {
  relaunch: () => Promise<void>;
};

type TauriAppModule = {
  getVersion: () => Promise<string>;
};

export type TauriUpdateEvent =
  | { event: 'Started'; data?: { contentLength?: number | null } }
  | { event: 'Progress'; data?: { chunkLength?: number | null } }
  | { event: 'Finished'; data?: unknown }
  | { event: string; data?: unknown };

export type TauriUpdate = {
  version: string;
  currentVersion?: string;
  date?: string;
  body?: string;
  downloadAndInstall: (onEvent?: (event: TauriUpdateEvent) => void) => Promise<void>;
};

export type AppUpdateMetadata = {
  version: string;
  currentVersion: string | null;
  publishedAt: string | null;
  notes: string | null;
  nativeUpdate: TauriUpdate;
};

export type AppUpdaterCheckResult =
  | { status: 'unavailable'; message: string }
  | { status: 'upToDate'; message: string }
  | { status: 'available'; update: AppUpdateMetadata };

export type AppUpdateDownloadState = {
  downloadedBytes: number;
  contentLength: number | null;
  percent: number | null;
};

export type AppUpdateInstallResult = {
  status: 'installed';
  message: string;
};

export type AppUpdaterDeps = {
  isNativeRuntime?: () => boolean;
  check?: () => Promise<TauriUpdate | null>;
  relaunch?: () => Promise<void>;
  getVersion?: () => Promise<string>;
};

async function loadUpdaterCheck(): Promise<() => Promise<TauriUpdate | null>> {
  const updaterModule = (await import('@tauri-apps/plugin-updater')) as TauriUpdaterModule;
  return updaterModule.check;
}

async function loadRelaunch(): Promise<() => Promise<void>> {
  const processModule = (await import('@tauri-apps/plugin-process')) as TauriProcessModule;
  return processModule.relaunch;
}

async function loadGetVersion(): Promise<() => Promise<string>> {
  const appModule = (await import('@tauri-apps/api/app')) as TauriAppModule;
  return appModule.getVersion;
}

export async function getCurrentAppVersion(deps: AppUpdaterDeps = {}): Promise<string | null> {
  const nativeRuntime = deps.isNativeRuntime ?? isTauriRuntime;
  if (!nativeRuntime()) return null;
  const getVersion = deps.getVersion ?? await loadGetVersion();
  return getVersion();
}

export function toDownloadProgress(
  current: AppUpdateDownloadState,
  event: TauriUpdateEvent
): AppUpdateDownloadState {
  if (event.event === 'Started') {
    const data = isRecord(event.data) ? event.data : {};
    const contentLength = typeof data.contentLength === 'number' ? data.contentLength : null;
    return {
      downloadedBytes: 0,
      contentLength,
      percent: contentLength && contentLength > 0 ? 0 : null,
    };
  }

  if (event.event === 'Progress') {
    const data = isRecord(event.data) ? event.data : {};
    const chunkLength = typeof data.chunkLength === 'number' ? data.chunkLength : 0;
    const downloadedBytes = current.downloadedBytes + Math.max(0, chunkLength);
    const percent = current.contentLength && current.contentLength > 0
      ? Math.min(100, Math.round((downloadedBytes / current.contentLength) * 100))
      : null;
    return {
      downloadedBytes,
      contentLength: current.contentLength,
      percent,
    };
  }

  if (event.event === 'Finished') {
    return {
      downloadedBytes: current.contentLength ?? current.downloadedBytes,
      contentLength: current.contentLength,
      percent: 100,
    };
  }

  return current;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

export function formatUpdateDate(value: string | null | undefined): string | null {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat('en-GB', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    timeZone: 'Asia/Saigon',
  }).format(date).replace(',', ',');
}

function toUpdateMetadata(update: TauriUpdate): AppUpdateMetadata {
  return {
    version: update.version,
    currentVersion: update.currentVersion ?? null,
    publishedAt: update.date ?? null,
    notes: update.body?.trim() || null,
    nativeUpdate: update,
  };
}

export async function checkForAppUpdate(deps: AppUpdaterDeps = {}): Promise<AppUpdaterCheckResult> {
  const nativeRuntime = deps.isNativeRuntime ?? isTauriRuntime;
  if (!nativeRuntime()) {
    return {
      status: 'unavailable',
      message: 'App updates are available only in the Tauri desktop app.',
    };
  }

  const check = deps.check ?? await loadUpdaterCheck();
  const update = await check();
  if (!update) {
    return {
      status: 'upToDate',
      message: 'Seasonal Management is up to date.',
    };
  }

  return {
    status: 'available',
    update: toUpdateMetadata(update),
  };
}

export function createAppUpdaterClient(deps: AppUpdaterDeps = {}) {
  return {
    check: () => checkForAppUpdate(deps),
    async downloadAndInstall(
      update: AppUpdateMetadata,
      onProgress?: (state: AppUpdateDownloadState) => void
    ): Promise<AppUpdateInstallResult> {
      let state: AppUpdateDownloadState = {
        downloadedBytes: 0,
        contentLength: null,
        percent: null,
      };
      await update.nativeUpdate.downloadAndInstall((event) => {
        state = toDownloadProgress(state, event);
        onProgress?.(state);
      });
      return {
        status: 'installed',
        message: 'Update installed. Restart Seasonal Management to finish.',
      };
    },
    async relaunch(): Promise<void> {
      const relaunch = deps.relaunch ?? await loadRelaunch();
      await relaunch();
    },
  };
}
