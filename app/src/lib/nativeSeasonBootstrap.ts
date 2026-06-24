import { getSeasonWorkspaceSnapshot } from './remoteStore';
import {
  checkNativeSeasonIntegrity,
  ensureNativeLocalSeason,
  importNativeSeasonSnapshot,
  isTauriRuntime,
  mergeNativeSeasonSnapshot,
  queryNativeSeasonFreshness,
} from './nativeSeasonRepository';
import { getOrCreateSeasonClientId } from './seasonChangeEvents';
import type { FlightModification, Season } from './types';

type BootstrapSource = 'local' | 'server' | 'merged';

export interface NativeSeasonBaselineResult {
  seasonId: string;
  source: BootstrapSource;
}

const healthySeasonVersions = new Map<string, number>();
const inflightBaselines = new Map<string, Promise<NativeSeasonBaselineResult>>();

function modificationsToArray(modifications: Map<string, FlightModification> | FlightModification[]): FlightModification[] {
  return Array.isArray(modifications) ? modifications : Array.from(modifications.values());
}

export async function ensureNativeSeasonBaseline(season: Season): Promise<NativeSeasonBaselineResult> {
  if (!isTauriRuntime()) return { seasonId: season.id, source: 'local' };
  const remoteDataVersion = Number(season.dataVersion ?? 0);
  if (healthySeasonVersions.get(season.id) === remoteDataVersion) {
    return { seasonId: season.id, source: 'local' };
  }

  const inflightKey = `${season.id}:${remoteDataVersion}`;
  const existing = inflightBaselines.get(inflightKey);
  if (existing) return existing;

  const promise = (async () => {
    const importLatestSnapshot = async (source: 'server' | 'merged') => {
      const snapshot = await getSeasonWorkspaceSnapshot(season.id, {
        modHistoryLimit: 50,
      });
      if (!snapshot) {
        throw new Error(`Server season snapshot is unavailable for ${season.seasonCode}.`);
      }

      const snapshotInput = {
        season: snapshot.season,
        sourceRows: [],
        records: snapshot.records,
        modifications: modificationsToArray(snapshot.modifications),
        modHistory: snapshot.modHistory,
        serverEventHighWater: snapshot.cursor.serverHighWater,
        entityVersions: snapshot.entityVersions,
      };
      const result = source === 'merged'
        ? await mergeNativeSeasonSnapshot({
            ...snapshotInput,
            clientId: getOrCreateSeasonClientId(),
          })
        : await importNativeSeasonSnapshot(snapshotInput);
      if (!result) {
        throw new Error(`Native season snapshot ${source === 'merged' ? 'merge' : 'import'} is unavailable for ${season.seasonCode}.`);
      }
      await checkNativeSeasonIntegrity(season.id);
      healthySeasonVersions.set(season.id, remoteDataVersion);
      return { seasonId: season.id, source } as NativeSeasonBaselineResult;
    };

    const freshness = await queryNativeSeasonFreshness(season.id);
    const staleLocalVersion = freshness?.exists
      && freshness.localDataVersion != null
      && freshness.localDataVersion < remoteDataVersion;
    const staleBaseVersion = freshness?.exists
      && freshness.baseServerVersion != null
      && freshness.baseServerVersion < remoteDataVersion;
    if (staleLocalVersion || staleBaseVersion) {
      return importLatestSnapshot(
        (freshness?.pendingCount ?? 0) > 0 || (freshness?.conflictCount ?? 0) > 0
          ? 'merged'
          : 'server'
      );
    }

    await ensureNativeLocalSeason(season);
    try {
      await checkNativeSeasonIntegrity(season.id);
      healthySeasonVersions.set(season.id, remoteDataVersion);
      return { seasonId: season.id, source: 'local' as const };
    } catch {
      // Missing or incomplete local baseline on a fresh install is repaired from
      // the canonical server snapshot before any viewport query runs.
    }

    return importLatestSnapshot('server');
  })().finally(() => {
    inflightBaselines.delete(inflightKey);
  });

  inflightBaselines.set(inflightKey, promise);
  return promise;
}
