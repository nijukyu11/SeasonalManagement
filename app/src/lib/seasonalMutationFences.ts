import { registerOperatorSessionCacheClearer } from './operatorSessionCacheRegistry.ts';
import { getSynchronousOperatorUserId } from './seasonalRestoreJournal.ts';

let activePublishCount = 0;
let activeDraftImportUploadCount = 0;
let activeDraftImportCommitCount = 0;
const unknownCommitOwners = new Set<string>();

registerOperatorSessionCacheClearer('seasonal-mutation-fences', () => {
  activePublishCount = 0;
  activeDraftImportUploadCount = 0;
  activeDraftImportCommitCount = 0;
  unknownCommitOwners.clear();
});

export function setSeasonalPublishActive(active: boolean): void {
  activePublishCount = active ? activePublishCount + 1 : Math.max(0, activePublishCount - 1);
}

export function isSeasonalPublishActive(): boolean {
  return activePublishCount > 0;
}

export function setSeasonalDraftImportUploading(uploading: boolean): void {
  activeDraftImportUploadCount = uploading ? activeDraftImportUploadCount + 1 : Math.max(0, activeDraftImportUploadCount - 1);
}

export function isSeasonalDraftImportUploading(): boolean {
  return activeDraftImportUploadCount > 0;
}

export function setSeasonalDraftImportCommitting(committing: boolean): void {
  activeDraftImportCommitCount = committing ? activeDraftImportCommitCount + 1 : Math.max(0, activeDraftImportCommitCount - 1);
}

export function isSeasonalDraftImportCommitting(): boolean {
  return activeDraftImportCommitCount > 0;
}

export function setSeasonalDraftImportUnknownCommit(
  ownerUserId: string | null | undefined,
  unknown: boolean,
): void {
  const resolvedOwner = (ownerUserId ?? getSynchronousOperatorUserId())?.trim();
  if (!resolvedOwner) return;
  if (unknown) {
    unknownCommitOwners.add(resolvedOwner);
  } else {
    unknownCommitOwners.delete(resolvedOwner);
  }
}

export function hasSeasonalDraftImportUnknownCommit(ownerUserId?: string | null): boolean {
  const resolvedOwner = (ownerUserId ?? getSynchronousOperatorUserId())?.trim();
  if (!resolvedOwner) return false;
  return unknownCommitOwners.has(resolvedOwner);
}
