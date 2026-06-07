import {
  collection,
  doc,
  getDocs,
  setDoc,
  updateDoc,
  deleteDoc,
  writeBatch,
  query,
  orderBy,
  limit as firestoreLimit,
  where,
  getDoc,
} from 'firebase/firestore';
import { db } from './firebase';
import type { Season, ParsedRow, FlightModification, ModHistoryEntry, FlightRecord, OperationalSettings } from './types';
import type { AuditDeltaChunk, AuditLogEntry, AuditSession } from './auditLog';
import type { SourceRowOperationPlan } from './sourceRowPatterns';
import { hydrateOperationalSettings, validateOperationalSettings } from './settingsRules';
import {
  hydrateFlightModificationFromPersistence,
  hydrateFlightRecordFromPersistence,
  hydrateModHistoryEntryFromPersistence,
  hydrateSourceRowFromPersistence,
  serializeFlightModificationForPersistence,
  serializeFlightRecordForPersistence,
  serializeModHistoryEntryForPersistence,
  serializeSourceRowForPersistence,
} from './persistenceSchema';
import {
  FIRESTORE_WRITE_BATCH_SIZE,
  chunkFirestoreWrites,
  pauseBetweenFirestoreWriteBatches,
} from './firestoreWritePlanner';
import { splitModHistoryEntriesForFirestore } from './modHistorySizing';
import { splitAuditDeltaChunks } from './auditLog';

// ─── Seasons ───────────────────────────────────────────────────

const seasonsRef = collection(db, 'seasons');
const operationalSettingsRef = doc(db, 'appSettings', 'operational');

function stripUndefinedDeep<T>(value: T): T {
  if (Array.isArray(value)) return value.map((item) => stripUndefinedDeep(item)) as T;
  if (!value || typeof value !== 'object') return value;

  const output: Record<string, unknown> = {};
  for (const [key, entryValue] of Object.entries(value as Record<string, unknown>)) {
    if (entryValue === undefined) continue;
    output[key] = stripUndefinedDeep(entryValue);
  }
  return output as T;
}

export async function getSeasons(): Promise<Season[]> {
  const snap = await getDocs(query(seasonsRef, orderBy('uploadedAt', 'desc')));
  return snap.docs.map((d) => ({ id: d.id, ...d.data() } as Season));
}

export async function getSeason(id: string): Promise<Season | null> {
  const snap = await getDoc(doc(db, 'seasons', id));
  if (!snap.exists()) return null;
  return { id: snap.id, ...snap.data() } as Season;
}

/** Find a season by its code (e.g., "S26"). */
export async function findSeasonByCode(code: string): Promise<Season | null> {
  const snap = await getDocs(query(seasonsRef, where('seasonCode', '==', code)));
  if (snap.empty) return null;
  return { id: snap.docs[0].id, ...snap.docs[0].data() } as Season;
}

export async function createSeason(season: Omit<Season, 'id'>): Promise<string> {
  const ref = doc(seasonsRef);
  await setDoc(ref, { ...season, uploadedAt: Date.now() });
  return ref.id;
}

export async function updateSeason(id: string, data: Partial<Season>): Promise<void> {
  await updateDoc(doc(db, 'seasons', id), data);
}

export async function deleteSeason(id: string): Promise<void> {
  await clearSeasonBaseline(id);
  await deleteDoc(doc(db, 'seasons', id));
}

export async function getOperationalSettings(): Promise<OperationalSettings> {
  const snap = await getDoc(operationalSettingsRef);
  if (!snap.exists()) return hydrateOperationalSettings(null);
  return hydrateOperationalSettings(snap.data() as Partial<OperationalSettings>);
}

export async function saveOperationalSettings(settings: OperationalSettings): Promise<void> {
  await setDoc(operationalSettingsRef, validateOperationalSettings(settings));
}

export async function saveAuditLogEntry(session: AuditSession, entry: AuditLogEntry): Promise<void> {
  const exactDeltas = entry.syncDelta?.exactChanges ?? entry.deltas;
  const deltaChunks = splitAuditDeltaChunks(exactDeltas);
  const entryPayload: AuditLogEntry = {
    ...entry,
    deltas: [],
    syncDelta: entry.syncDelta ? { ...entry.syncDelta, exactChanges: [] } : undefined,
    deltaChunkCount: deltaChunks.length,
  };

  await setDoc(doc(db, 'auditSessions', session.id), stripUndefinedDeep(session), { merge: true });
  await setDoc(
    doc(db, 'auditSessions', session.id, 'entries', entry.id),
    stripUndefinedDeep(entryPayload)
  );

  for (const chunk of chunkFirestoreWrites(deltaChunks)) {
    const batch = writeBatch(db);
    chunk.forEach((deltaChunk) => {
      batch.set(
        doc(db, 'auditSessions', session.id, 'entries', entry.id, 'deltaChunks', deltaChunk.id),
        stripUndefinedDeep(deltaChunk)
      );
    });
    await batch.commit();
    await pauseBetweenFirestoreWriteBatches();
  }
}

export async function getAuditSessions(maxSessions = 50): Promise<AuditSession[]> {
  const snap = await getDocs(query(collection(db, 'auditSessions'), orderBy('lastSeenAt', 'desc'), firestoreLimit(maxSessions)));
  return snap.docs.map((d) => ({ id: d.id, ...d.data() } as AuditSession));
}

export async function getAuditLogEntries(sessionId: string, maxEntries = 200): Promise<AuditLogEntry[]> {
  const snap = await getDocs(query(
    collection(db, 'auditSessions', sessionId, 'entries'),
    orderBy('timestamp', 'desc'),
    firestoreLimit(maxEntries)
  ));
  return snap.docs.map((d) => ({ id: d.id, ...d.data() } as AuditLogEntry));
}

export async function getAuditDeltaChunks(sessionId: string, entryId: string): Promise<AuditDeltaChunk[]> {
  const snap = await getDocs(query(
    collection(db, 'auditSessions', sessionId, 'entries', entryId, 'deltaChunks'),
    orderBy('chunkIndex', 'asc')
  ));
  return snap.docs.map((d) => ({ id: d.id, ...d.data() } as AuditDeltaChunk));
}

async function clearCollectionDocuments(ref: ReturnType<typeof collection>): Promise<void> {
  const snap = await getDocs(ref);
  for (const chunk of chunkFirestoreWrites(snap.docs)) {
    const batch = writeBatch(db);
    chunk.forEach((d) => batch.delete(d.ref));
    await batch.commit();
    await pauseBetweenFirestoreWriteBatches();
  }
}

/** Clear canonical atomic flight records for a season. */
export async function clearFlightRecords(seasonId: string): Promise<void> {
  await clearCollectionDocuments(collection(db, 'seasons', seasonId, 'flightRecords'));
}

/** Clear all source rows for a season (used for replace/re-import). */
export async function clearSourceRows(seasonId: string): Promise<void> {
  await clearCollectionDocuments(collection(db, 'seasons', seasonId, 'sourceRows'));
}

/** Clear all modification overlays for a season baseline replacement. */
export async function clearModifications(seasonId: string): Promise<void> {
  await clearCollectionDocuments(collection(db, 'seasons', seasonId, 'modifications'));
}

/** Clear all undo/history entries for a season baseline replacement. */
export async function clearModHistory(seasonId: string): Promise<void> {
  await clearCollectionDocuments(collection(db, 'seasons', seasonId, 'modHistory'));
}

/** Clear all season-owned schedule data before a destructive re-import baseline replacement. */
export async function clearSeasonBaseline(seasonId: string): Promise<void> {
  await clearSourceRows(seasonId);
  await clearFlightRecords(seasonId);
  await clearModifications(seasonId);
  await clearModHistory(seasonId);
}

// ─── Source Rows ───────────────────────────────────────────────

export async function batchWriteSourceRows(
  seasonId: string,
  rows: ParsedRow[],
  onProgress?: (written: number, total: number) => void
): Promise<void> {
  for (let i = 0; i < rows.length; i += FIRESTORE_WRITE_BATCH_SIZE) {
    const batch = writeBatch(db);
    const chunk = rows.slice(i, i + FIRESTORE_WRITE_BATCH_SIZE);
    for (const row of chunk) {
      const ref = doc(db, 'seasons', seasonId, 'sourceRows', String(row.rowIndex));
      batch.set(ref, serializeSourceRowForPersistence(row));
    }
    await batch.commit();
    onProgress?.(Math.min(i + FIRESTORE_WRITE_BATCH_SIZE, rows.length), rows.length);
    await pauseBetweenFirestoreWriteBatches();
  }
}

export async function getSourceRows(seasonId: string): Promise<ParsedRow[]> {
  const ref = collection(db, 'seasons', seasonId, 'sourceRows');
  const snap = await getDocs(query(ref, orderBy('rowIndex')));
  return snap.docs.map((d) => hydrateSourceRowFromPersistence(d.data() as Partial<ParsedRow>));
}

export async function batchWriteFlightRecords(
  seasonId: string,
  records: FlightRecord[],
  onProgress?: (written: number, total: number) => void
): Promise<void> {
  for (let i = 0; i < records.length; i += FIRESTORE_WRITE_BATCH_SIZE) {
    const batch = writeBatch(db);
    const chunk = records.slice(i, i + FIRESTORE_WRITE_BATCH_SIZE);
    for (const record of chunk) {
      const ref = doc(db, 'seasons', seasonId, 'flightRecords', record.id);
      batch.set(ref, serializeFlightRecordForPersistence(record));
    }
    await batch.commit();
    onProgress?.(Math.min(i + FIRESTORE_WRITE_BATCH_SIZE, records.length), records.length);
    await pauseBetweenFirestoreWriteBatches();
  }
}

export async function getFlightRecords(seasonId: string): Promise<FlightRecord[]> {
  const ref = collection(db, 'seasons', seasonId, 'flightRecords');
  const snap = await getDocs(ref);
  return snap.docs
    .map((d) => hydrateFlightRecordFromPersistence(d.data() as Partial<FlightRecord>))
    .sort((a, b) => a.date.localeCompare(b.date) || a.flightNumber.localeCompare(b.flightNumber) || a.id.localeCompare(b.id));
}

/** Add a single source row with auto-incremented rowIndex. */
export async function addSourceRow(seasonId: string, row: Omit<ParsedRow, 'rowIndex'>): Promise<ParsedRow> {
  const ref = collection(db, 'seasons', seasonId, 'sourceRows');
  const snap = await getDocs(ref);
  const maxIdx = snap.docs.reduce((max, d) => Math.max(max, (d.data() as ParsedRow).rowIndex), 0);
  const newRow = { ...row, rowIndex: maxIdx + 1 } as ParsedRow;
  await setDoc(doc(db, 'seasons', seasonId, 'sourceRows', String(newRow.rowIndex)), serializeSourceRowForPersistence(newRow));
  return newRow;
}

/** Delete a single source row. If linked to a turnaround partner, unlinks the partner too. */
export async function deleteSourceRow(seasonId: string, rowIndex: number, linkedRowIndex?: number): Promise<void> {
  const { deleteField } = await import('firebase/firestore');
  const batch = writeBatch(db);
  batch.delete(doc(db, 'seasons', seasonId, 'sourceRows', String(rowIndex)));
  if (linkedRowIndex != null) {
    batch.update(doc(db, 'seasons', seasonId, 'sourceRows', String(linkedRowIndex)), {
      overnightLinkRowIndex: deleteField(),
      linkType: deleteField(),
    });
  }
  await batch.commit();
}

/** Link two source rows as a turnaround pair (overnight or same-day). */
export async function linkSourceRows(seasonId: string, rowIndexA: number, rowIndexB: number, linkType: 'overnight' | 'sameday' = 'overnight'): Promise<void> {
  const batch = writeBatch(db);
  const refA = doc(db, 'seasons', seasonId, 'sourceRows', String(rowIndexA));
  const refB = doc(db, 'seasons', seasonId, 'sourceRows', String(rowIndexB));
  batch.update(refA, { overnightLinkRowIndex: rowIndexB, linkType });
  batch.update(refB, { overnightLinkRowIndex: rowIndexA, linkType });
  await batch.commit();
}

/** Merge matching same-day ARR-only and DEP-only rows into one consolidated source row. */
export async function mergeSameDaySourceRows(seasonId: string, rowIndexA: number, rowIndexB: number): Promise<void> {
  const { deleteField } = await import('firebase/firestore');
  const refA = doc(db, 'seasons', seasonId, 'sourceRows', String(rowIndexA));
  const refB = doc(db, 'seasons', seasonId, 'sourceRows', String(rowIndexB));
  const [snapA, snapB] = await Promise.all([getDoc(refA), getDoc(refB)]);
  if (!snapA.exists() || !snapB.exists()) throw new Error('Source row not found');

  const rowA = snapA.data() as ParsedRow;
  const rowB = snapB.data() as ParsedRow;
  const arrRow = rowA.arrFlight && !rowA.depFlight ? rowA : rowB.arrFlight && !rowB.depFlight ? rowB : null;
  const depRow = rowA.depFlight && !rowA.arrFlight ? rowA : rowB.depFlight && !rowB.arrFlight ? rowB : null;
  if (!arrRow || !depRow) throw new Error('Same-day merge requires one ARR-only row and one DEP-only row');
  if (arrRow.airline !== depRow.airline) throw new Error('Cannot merge rows with different airlines');
  if (arrRow.effective !== depRow.effective || arrRow.discontinue !== depRow.discontinue) {
    throw new Error('Cannot merge rows with different date ranges');
  }
  if (JSON.stringify(arrRow.daysOfWeek) !== JSON.stringify(depRow.daysOfWeek)) {
    throw new Error('Cannot merge rows with different operating days');
  }

  const arrRef = arrRow.rowIndex === rowIndexA ? refA : refB;
  const depRef = depRow.rowIndex === rowIndexA ? refA : refB;
  const batch = writeBatch(db);
  batch.update(arrRef, {
    std: depRow.std,
    depFlight: depRow.depFlight,
    depFlightType: deleteField(),
    depRoute: depRow.depRoute,
    depFlightCategory: depRow.depFlightCategory,
    depCodeShares: depRow.depCodeShares,
    depIntDomInd: depRow.depIntDomInd,
    overnightLinkRowIndex: deleteField(),
    linkType: deleteField(),
  });
  batch.delete(depRef);
  await batch.commit();
}

/** Unlink a turnaround pair. */
export async function unlinkSourceRows(seasonId: string, rowIndexA: number, rowIndexB: number): Promise<void> {
  const { deleteField } = await import('firebase/firestore');
  const batch = writeBatch(db);
  const refA = doc(db, 'seasons', seasonId, 'sourceRows', String(rowIndexA));
  const refB = doc(db, 'seasons', seasonId, 'sourceRows', String(rowIndexB));
  batch.update(refA, { overnightLinkRowIndex: deleteField(), linkType: deleteField() });
  batch.update(refB, { overnightLinkRowIndex: deleteField(), linkType: deleteField() });
  await batch.commit();
}

// ─── Modifications ────────────────────────────────────────────

/** Split a same-row ARR+DEP turnaround into separate ARR-only and DEP-only source rows. */
export async function splitSourceRowTurnaround(seasonId: string, rowIndex: number): Promise<number> {
  const { deleteField } = await import('firebase/firestore');
  const rowRef = doc(db, 'seasons', seasonId, 'sourceRows', String(rowIndex));
  const rowSnap = await getDoc(rowRef);
  if (!rowSnap.exists()) throw new Error(`Source row ${rowIndex} not found`);

  const row = rowSnap.data() as ParsedRow;
  if (!row.arrFlight || !row.depFlight) {
    throw new Error(`Source row ${rowIndex} is not an ARR+DEP turnaround row`);
  }

  const rowsRef = collection(db, 'seasons', seasonId, 'sourceRows');
  const rowsSnap = await getDocs(rowsRef);
  const newRowIndex = rowsSnap.docs.reduce((max, d) => {
    const data = d.data() as ParsedRow;
    return Math.max(max, data.rowIndex);
  }, 0) + 1;

  const depOnlyRow: ParsedRow = {
    ...row,
    rowIndex: newRowIndex,
    sta: null,
    arrFlight: null,
    arrFlightType: null,
    arrRoute: null,
    arrFlightCategory: null,
    arrCodeShares: null,
    arrIntDomInd: null,
  };
  delete depOnlyRow.overnightLinkRowIndex;
  delete depOnlyRow.linkType;

  const batch = writeBatch(db);
  batch.update(rowRef, {
    std: null,
    depFlight: null,
    arrFlightType: deleteField(),
    depFlightType: deleteField(),
    depRoute: null,
    depFlightCategory: null,
    depCodeShares: null,
    depIntDomInd: null,
    overnightLinkRowIndex: deleteField(),
    linkType: deleteField(),
  });
  batch.set(doc(db, 'seasons', seasonId, 'sourceRows', String(newRowIndex)), serializeSourceRowForPersistence(depOnlyRow));
  await batch.commit();

  return newRowIndex;
}

/** Apply a planned source-row rewrite. Used for confirmed granular link/unlink operations. */
export async function applySourceRowOperationPlan(seasonId: string, plan: SourceRowOperationPlan): Promise<void> {
  const BATCH_SIZE = FIRESTORE_WRITE_BATCH_SIZE;
  for (let i = 0; i < plan.writes.length; i += BATCH_SIZE) {
    const batch = writeBatch(db);
    const chunk = plan.writes.slice(i, i + BATCH_SIZE);
    for (const write of chunk) {
      const ref = doc(db, 'seasons', seasonId, 'sourceRows', String(write.rowIndex));
      if (write.type === 'delete') {
        batch.delete(ref);
      } else if (write.row) {
        batch.set(ref, serializeSourceRowForPersistence(write.row));
      }
    }
    await batch.commit();
    await pauseBetweenFirestoreWriteBatches();
  }
}

export async function getModifications(seasonId: string): Promise<Map<string, FlightModification>> {
  const ref = collection(db, 'seasons', seasonId, 'modifications');
  const snap = await getDocs(ref);
  const map = new Map<string, FlightModification>();
  snap.docs.forEach((d) => map.set(d.id, hydrateFlightModificationFromPersistence(d.data() as FlightModification)));
  return map;
}

export async function saveModification(
  seasonId: string,
  legId: string,
  mod: FlightModification
): Promise<void> {
  const ref = doc(db, 'seasons', seasonId, 'modifications', legId);
  await setDoc(ref, serializeFlightModificationForPersistence(mod));
}

export async function saveModifications(
  seasonId: string,
  mods: FlightModification[]
): Promise<void> {
  if (mods.length === 0) return;
  const BATCH_SIZE = FIRESTORE_WRITE_BATCH_SIZE;
  for (let i = 0; i < mods.length; i += BATCH_SIZE) {
    const batch = writeBatch(db);
    const chunk = mods.slice(i, i + BATCH_SIZE);
    for (const mod of chunk) {
      const ref = doc(db, 'seasons', seasonId, 'modifications', mod.legId);
      batch.set(ref, serializeFlightModificationForPersistence(mod));
    }
    await batch.commit();
    await pauseBetweenFirestoreWriteBatches();
  }
}

export async function removeModification(
  seasonId: string,
  legId: string
): Promise<void> {
  await deleteDoc(doc(db, 'seasons', seasonId, 'modifications', legId));
}

export async function deleteModifications(seasonId: string, legIds: string[]): Promise<void> {
  if (legIds.length === 0) return;
  const BATCH_SIZE = FIRESTORE_WRITE_BATCH_SIZE;
  for (let i = 0; i < legIds.length; i += BATCH_SIZE) {
    const batch = writeBatch(db);
    const chunk = legIds.slice(i, i + BATCH_SIZE);
    for (const legId of chunk) {
      batch.delete(doc(db, 'seasons', seasonId, 'modifications', legId));
    }
    await batch.commit();
    await pauseBetweenFirestoreWriteBatches();
  }
}

// ─── Modification History (Undo) ──────────────────────────────

/**
 * Save modifications AND record a history entry for undo.
 * `currentMods` is the current state of modifications (before this save).
 */
export async function saveModificationsWithHistory(
  seasonId: string,
  mods: FlightModification[],
  currentMods: Map<string, FlightModification>,
  description: string
): Promise<void> {
  if (mods.length === 0) return;

  // Build history entry capturing before/after for each affected leg
  const changes = mods.map(mod => ({
    legId: mod.legId,
    previousMod: currentMods.get(mod.legId) ?? null,
    newMod: serializeFlightModificationForPersistence(mod) as FlightModification,
  }));

  const historyRef = doc(collection(db, 'seasons', seasonId, 'modHistory'));
  const historyEntry = {
    timestamp: Date.now(),
    description,
    changes,
  };

  // Write modifications + history in batches
  const BATCH_SIZE = FIRESTORE_WRITE_BATCH_SIZE - 1; // leave room for history doc
  for (let i = 0; i < mods.length; i += BATCH_SIZE) {
    const batch = writeBatch(db);
    const chunk = mods.slice(i, i + BATCH_SIZE);
    for (const mod of chunk) {
      const ref = doc(db, 'seasons', seasonId, 'modifications', mod.legId);
      batch.set(ref, serializeFlightModificationForPersistence(mod));
    }
    // Write history doc in the first batch
    if (i === 0) {
      batch.set(historyRef, historyEntry);
    }
    await batch.commit();
    await pauseBetweenFirestoreWriteBatches();
  }
}

export async function saveModHistoryEntries(
  seasonId: string,
  entries: ModHistoryEntry[]
): Promise<void> {
  if (entries.length === 0) return;
  const entriesToWrite = splitModHistoryEntriesForFirestore(entries);
  const BATCH_SIZE = FIRESTORE_WRITE_BATCH_SIZE;
  for (let i = 0; i < entriesToWrite.length; i += BATCH_SIZE) {
    const batch = writeBatch(db);
    const chunk = entriesToWrite.slice(i, i + BATCH_SIZE);
    for (const entry of chunk) {
      const ref = doc(db, 'seasons', seasonId, 'modHistory', entry.id);
      batch.set(ref, serializeModHistoryEntryForPersistence(entry));
    }
    await batch.commit();
    await pauseBetweenFirestoreWriteBatches();
  }
}

/** Get recent modification history entries (newest first). */
export async function getModHistory(seasonId: string, limit = 20): Promise<ModHistoryEntry[]> {
  const ref = collection(db, 'seasons', seasonId, 'modHistory');
  const snap = await getDocs(query(ref, orderBy('timestamp', 'desc')));
  return snap.docs.slice(0, limit).map(d => hydrateModHistoryEntryFromPersistence({
    id: d.id,
    ...d.data(),
  } as ModHistoryEntry));
}

/**
 * Undo a set of history entries (from most recent up to and including the target entry).
 * Reverts each change by restoring `previousMod` or removing the modification entirely.
 */
export async function undoModHistoryEntries(
  seasonId: string,
  entries: ModHistoryEntry[]
): Promise<void> {
  // Process entries from newest to oldest to correctly layer reverts
  const sorted = [...entries].sort((a, b) => b.timestamp - a.timestamp);

  for (const entry of sorted) {
    const BATCH_SIZE = FIRESTORE_WRITE_BATCH_SIZE;
    for (let i = 0; i < entry.changes.length; i += BATCH_SIZE) {
      const batch = writeBatch(db);
      const chunk = entry.changes.slice(i, i + BATCH_SIZE);
      for (const change of chunk) {
        const modRef = doc(db, 'seasons', seasonId, 'modifications', change.legId);
        if (change.previousMod) {
          // Restore the previous modification state
          batch.set(modRef, serializeFlightModificationForPersistence(change.previousMod));
        } else {
          // No prior mod — remove the modification entirely
          batch.delete(modRef);
        }
      }
      await batch.commit();
      await pauseBetweenFirestoreWriteBatches();
    }

    // Delete the history entry itself
    await deleteDoc(doc(db, 'seasons', seasonId, 'modHistory', entry.id));
  }
}
