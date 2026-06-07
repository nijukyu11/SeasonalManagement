import {
  createLocalWorkspace,
  loadLocalSeasonWorkspace,
  saveLocalSeasonWorkspace,
  type LocalEntityVersionMap,
  type LocalPendingOp,
  type LocalSeasonWorkspace,
  type SaveLocalSeasonWorkspaceOptions,
} from './localSeasonStore';
import {
  getCachedSeasonData,
  setCachedSeasonData,
  type CachedSeasonData,
} from './seasonDataCache';
import {
  getFlightRecords,
  getModHistory,
  getModifications,
  getSeasonEntityVersions,
  getSeasonEventHighWater,
} from './remoteStore';
import {
  isSeasonWorkspaceStale,
  type SeasonWorkspaceStaleState,
} from './seasonSync';
import type { FlightModification, FlightRecord, ModHistoryEntry, ParsedRow, Season } from './types';

export type LoadOrSeedSeasonWorkspaceSource = 'local' | 'cache' | 'server';

export interface ServerSeasonWorkspaceBaseline {
  rows: ParsedRow[];
  records: FlightRecord[];
  modifications: Map<string, FlightModification>;
  modHistory: ModHistoryEntry[];
  serverEventHighWater: number;
  entityVersions: LocalEntityVersionMap;
  baseRecords?: FlightRecord[];
  pendingOps?: LocalPendingOp[];
}

export interface LoadOrSeedSeasonWorkspaceResult {
  workspace: LocalSeasonWorkspace;
  source: LoadOrSeedSeasonWorkspaceSource;
  staleState: SeasonWorkspaceStaleState;
}

export interface LoadOrSeedSeasonWorkspaceOptions {
  forceServer?: boolean;
  loadLocalWorkspace?: (seasonId: string) => Promise<LocalSeasonWorkspace | null>;
  saveLocalWorkspace?: (workspace: LocalSeasonWorkspace, options?: SaveLocalSeasonWorkspaceOptions) => Promise<void>;
  getCachedData?: (seasonId: string) => CachedSeasonData | null;
  setCachedData?: (seasonId: string, data: Omit<CachedSeasonData, 'cachedAt'>) => void;
  loadServerBaseline?: (season: Season) => Promise<ServerSeasonWorkspaceBaseline>;
}

async function loadDefaultServerBaseline(season: Season): Promise<ServerSeasonWorkspaceBaseline> {
  const [records, modifications, modHistory, serverEventHighWater, entityVersions] = await Promise.all([
    getFlightRecords(season.id),
    getModifications(season.id),
    getModHistory(season.id),
    getSeasonEventHighWater(season.id),
    getSeasonEntityVersions(season.id),
  ]);
  return {
    rows: [],
    records,
    modifications,
    modHistory,
    serverEventHighWater,
    entityVersions,
    baseRecords: records,
    pendingOps: [],
  };
}

export async function loadOrSeedSeasonWorkspace(
  season: Season,
  options: LoadOrSeedSeasonWorkspaceOptions = {}
): Promise<LoadOrSeedSeasonWorkspaceResult> {
  const loadLocal = options.loadLocalWorkspace ?? loadLocalSeasonWorkspace;
  const saveLocal = options.saveLocalWorkspace ?? saveLocalSeasonWorkspace;
  const readCache = options.getCachedData ?? getCachedSeasonData;
  const writeCache = options.setCachedData ?? setCachedSeasonData;
  const loadServer = options.loadServerBaseline ?? loadDefaultServerBaseline;

  if (!options.forceServer) {
    const localWorkspace = await loadLocal(season.id);
    if (localWorkspace) {
      const staleState = isSeasonWorkspaceStale(localWorkspace, season);
      if (staleState !== 'clean-stale' && (staleState === 'current' || staleState === 'dirty-stale')) {
        writeCache(localWorkspace.season.id, {
          rows: localWorkspace.rows,
          records: localWorkspace.records,
          modifications: localWorkspace.modifications,
          seasonDataVersion: localWorkspace.season.dataVersion,
        });
        return { workspace: localWorkspace, source: 'local', staleState };
      }
    }

    const cached = readCache(season.id);
    if (cached && cached.seasonDataVersion === season.dataVersion) {
      const [serverEventHighWater, entityVersions] = await Promise.all([
        getSeasonEventHighWater(season.id),
        getSeasonEntityVersions(season.id),
      ]);
      const workspace = createLocalWorkspace({
        season,
        rows: cached.rows,
        records: cached.records,
        modifications: cached.modifications,
        modHistory: [],
        serverEventHighWater,
        entityVersions,
      });
      await saveLocal(workspace, { nativeFullSaveReason: 'server-baseline' });
      return { workspace, source: 'cache', staleState: 'current' };
    }
  }

  const baseline = await loadServer(season);
  const workspace = createLocalWorkspace({
    season,
    rows: baseline.rows,
    records: baseline.records,
    modifications: baseline.modifications,
    modHistory: baseline.modHistory,
    baseRecords: baseline.baseRecords ?? baseline.records,
    serverEventHighWater: baseline.serverEventHighWater,
    entityVersions: baseline.entityVersions,
    pendingOps: baseline.pendingOps ?? [],
  });
  await saveLocal(workspace, { nativeFullSaveReason: 'server-baseline' });
  writeCache(season.id, {
    rows: workspace.rows,
    records: workspace.records,
    modifications: workspace.modifications,
    seasonDataVersion: season.dataVersion,
  });
  return { workspace, source: 'server', staleState: 'current' };
}
