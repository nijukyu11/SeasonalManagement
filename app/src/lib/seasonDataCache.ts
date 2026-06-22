import type { LocalSyncMeta } from './localSeasonStore';
import type { FlightModification, FlightRecord, OperationalSettings, ParsedRow, Season } from './types';

export interface CachedSeasonData {
  rows: ParsedRow[];
  records: FlightRecord[];
  modifications: Map<string, FlightModification>;
  seasonDataVersion?: number;
  cachedAt: number;
}

type WritableCachedSeasonData = Omit<CachedSeasonData, 'cachedAt'> & { cachedAt?: number };
export interface SeasonWorkspaceChangeEvent {
  seasonId: string;
  eventSeq: number;
  localRevision: number | null;
  changedAt: number;
  source: string;
  affectedIds: string[];
  changedTargets: string[];
  syncMeta: LocalSyncMeta | null;
}

type WritableSeasonWorkspaceChangeEvent = {
  seasonId: string;
  localRevision?: number | null;
  changedAt?: number;
  source?: string;
  affectedIds?: string[];
  changedTargets?: string[];
  syncMeta?: LocalSyncMeta | null;
};
type SeasonWorkspaceChangeListener = (event: SeasonWorkspaceChangeEvent) => void;

let cachedSeasons: Season[] | null = null;
let cachedOperationalSettings: OperationalSettings | null = null;
const cachedSeasonData = new Map<string, CachedSeasonData>();
const seasonWorkspaceChangeListeners = new Set<SeasonWorkspaceChangeListener>();
let seasonWorkspaceEventSeq = 0;

export function getCachedSeasons(): Season[] | null {
  return cachedSeasons;
}

export function setCachedSeasons(seasons: Season[]): void {
  cachedSeasons = seasons;
}

export function getCachedOperationalSettings(): OperationalSettings | null {
  return cachedOperationalSettings;
}

export function setCachedOperationalSettings(settings: OperationalSettings): void {
  cachedOperationalSettings = settings;
}

export function getCachedSeasonData(seasonId: string): CachedSeasonData | null {
  return cachedSeasonData.get(seasonId) ?? null;
}

export function setCachedSeasonData(seasonId: string, data: WritableCachedSeasonData): void {
  cachedSeasonData.set(seasonId, {
    ...data,
    cachedAt: data.cachedAt ?? Date.now(),
  });
}

export function patchCachedSeasonData(seasonId: string, patch: Partial<WritableCachedSeasonData>): void {
  const current = cachedSeasonData.get(seasonId);
  if (!current) return;
  cachedSeasonData.set(seasonId, {
    ...current,
    ...patch,
    cachedAt: patch.cachedAt ?? Date.now(),
  });
}

export function clearCachedSeasonData(seasonId: string): void {
  cachedSeasonData.delete(seasonId);
}

export function clearSeasonDataCache(): void {
  cachedSeasons = null;
  cachedOperationalSettings = null;
  cachedSeasonData.clear();
}

export function subscribeSeasonWorkspaceChanges(listener: SeasonWorkspaceChangeListener): () => void {
  seasonWorkspaceChangeListeners.add(listener);
  return () => {
    seasonWorkspaceChangeListeners.delete(listener);
  };
}

export function publishSeasonWorkspaceChanged(event: WritableSeasonWorkspaceChangeEvent): SeasonWorkspaceChangeEvent {
  const nextEvent: SeasonWorkspaceChangeEvent = {
    seasonId: event.seasonId,
    eventSeq: ++seasonWorkspaceEventSeq,
    localRevision: event.localRevision ?? null,
    changedAt: event.changedAt ?? Date.now(),
    source: event.source ?? 'unknown',
    affectedIds: event.affectedIds ? Array.from(new Set(event.affectedIds)) : [],
    changedTargets: event.changedTargets ? Array.from(new Set(event.changedTargets)) : [],
    syncMeta: event.syncMeta ?? null,
  };
  for (const listener of Array.from(seasonWorkspaceChangeListeners)) listener(nextEvent);
  return nextEvent;
}
