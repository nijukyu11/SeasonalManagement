import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { initializeApp, getApps } from 'firebase/app';
import { getFirestore, collection, getDocs, doc, getDoc, query, orderBy } from 'firebase/firestore';
import { createClient } from '@supabase/supabase-js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const envPath = path.join(root, '.env.local');

function parseEnv(text) {
  return Object.fromEntries(
    text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith('#'))
      .map((line) => {
        const idx = line.indexOf('=');
        return [line.slice(0, idx), line.slice(idx + 1)];
      })
  );
}

const localEnv = parseEnv(await fs.readFile(envPath, 'utf8').catch(() => ''));
const env = { ...localEnv, ...process.env };

const supabaseUrl = env.SUPABASE_URL ?? env.NEXT_PUBLIC_SUPABASE_URL;
const serviceRoleKey = env.SUPABASE_SERVICE_ROLE_KEY;
if (!supabaseUrl || !serviceRoleKey) {
  throw new Error('Set SUPABASE_URL or NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY before running migration.');
}

const firebaseConfig = {
  apiKey: env.NEXT_PUBLIC_FIREBASE_API_KEY,
  authDomain: env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN,
  projectId: env.NEXT_PUBLIC_FIREBASE_PROJECT_ID,
  storageBucket: env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: env.NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID,
  appId: env.NEXT_PUBLIC_FIREBASE_APP_ID,
};

if (!getApps().length) initializeApp(firebaseConfig);
const firestore = getFirestore();
const supabase = createClient(supabaseUrl, serviceRoleKey, {
  auth: {
    persistSession: false,
    autoRefreshToken: false,
  },
});

async function docsOf(refOrQuery) {
  const snap = await getDocs(refOrQuery);
  return snap.docs.map((d) => ({ id: d.id, data: d.data() }));
}

async function docsOfOrdered(ref, field, direction = 'asc') {
  try {
    return await docsOf(query(ref, orderBy(field, direction)));
  } catch {
    return docsOf(ref);
  }
}

async function upsert(table, rows, onConflict) {
  if (rows.length === 0) return;
  const batchSize = 500;
  for (let i = 0; i < rows.length; i += batchSize) {
    const chunk = rows.slice(i, i + batchSize);
    const { error } = await supabase.from(table).upsert(chunk, { onConflict });
    if (error) throw new Error(`${table}: ${error.message}`);
    console.log(`${table}: ${Math.min(i + batchSize, rows.length)}/${rows.length}`);
  }
}

function pad2(value) {
  return String(value).padStart(2, '0');
}

function isoDate(date) {
  return `${date.getUTCFullYear()}-${pad2(date.getUTCMonth() + 1)}-${pad2(date.getUTCDate())}`;
}

function shiftIsoDate(iso, offsetDays) {
  const [year, month, day] = String(iso).split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  date.setUTCDate(date.getUTCDate() + offsetDays);
  return isoDate(date);
}

function minutesOf(time) {
  const match = /^(\d{1,2}):(\d{2})/.exec(String(time ?? ''));
  return match ? Number(match[1]) * 60 + Number(match[2]) : 5 * 60;
}

function lastSunday(year, month) {
  const date = new Date(Date.UTC(year, month + 1, 0));
  while (date.getUTCDay() !== 0) date.setUTCDate(date.getUTCDate() - 1);
  return isoDate(date);
}

function iataSeasonCode(operationalDate) {
  if (!operationalDate) return null;
  const year = Number(operationalDate.slice(0, 4));
  const summerStart = lastSunday(year, 2);
  const winterStart = lastSunday(year, 9);
  if (operationalDate >= summerStart && operationalDate < winterStart) return `S${String(year).slice(-2)}`;
  if (operationalDate >= winterStart) return `W${String(year).slice(-2)}`;
  return `W${String(year - 1).slice(-2)}`;
}

function operationalDate(record) {
  const scheduledDate = record.scheduledDate ?? record.date ?? '';
  const scheduledTime = record.scheduledTime ?? record.schedule ?? '';
  return minutesOf(scheduledTime) < 5 * 60 ? shiftIsoDate(scheduledDate, -1) : scheduledDate;
}

function flightSeriesId(record) {
  return ['SER', record.type, record.airline, record.flightNumber, record.route]
    .map((part) => String(part ?? 'NONE').trim().toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'NONE')
    .join('_');
}

function counterRows(scope, ownerId, counter) {
  if (counter == null) return [];
  const rows = [];
  const push = (group, itemIndex, value) => rows.push({
    [scope]: ownerId,
    counter_group: group,
    item_index: itemIndex,
    counter_value: String(value),
  });
  if (typeof counter === 'string' || typeof counter === 'number') push('__single__', 0, counter);
  else if (Array.isArray(counter)) counter.forEach((value, index) => push('__single__', index, value));
  else {
    Object.entries(counter).forEach(([group, value]) => {
      const values = Array.isArray(value) ? value : [value];
      values.forEach((entry, index) => push(group, index, entry));
    });
  }
  return rows;
}

function windowRows(scope, ownerId, windows) {
  if (!windows) return [];
  return Object.entries(windows).map(([counterKey, window]) => ({
    [scope]: ownerId,
    counter_key: counterKey,
    window_start: window.start,
    window_end: window.end,
  }));
}

function sourceRow(seasonId, row) {
  return {
    season_id: seasonId,
    row_index: row.rowIndex,
    effective: row.effective ?? '',
    discontinue: row.discontinue ?? '',
    airline: row.airline ?? '',
    aircraft: row.aircraft ?? '',
    sta: row.sta ?? null,
    arr_flight: row.arrFlight ?? null,
    arr_route: row.arrRoute ?? null,
    arr_category: row.arrFlightCategory ?? null,
    arr_code_shares: row.arrCodeShares ?? null,
    arr_int_dom_ind: row.arrIntDomInd ?? null,
    std: row.std ?? null,
    dep_flight: row.depFlight ?? null,
    dep_route: row.depRoute ?? null,
    dep_category: row.depFlightCategory ?? null,
    dep_code_shares: row.depCodeShares ?? null,
    dep_int_dom_ind: row.depIntDomInd ?? null,
    overnight_link_row_index: row.overnightLinkRowIndex ?? null,
    link_type: row.linkType ?? null,
  };
}

function sourceRowDays(seasonId, row) {
  return (row.daysOfWeek ?? []).flatMap((operates, index) =>
    operates ? [{ season_id: seasonId, row_index: row.rowIndex, iso_dow: index + 1 }] : []
  );
}

function flightRecordRow(seasonId, record) {
  const opDate = record.operationalDate ?? operationalDate(record);
  return {
    season_id: seasonId,
    record_id: record.id,
    link_id: record.linkId ?? '',
    type: record.type ?? 'A',
    airline: record.airline ?? '',
    flight_number: record.flightNumber ?? '',
    raw_flight_number: record.rawFlightNumber ?? record.flightNumber ?? '',
    request_status_code: record.requestStatusCode ?? null,
    route: record.route ?? '',
    schedule: record.schedule ?? '',
    aircraft: record.aircraft ?? '',
    category: record.category ?? '',
    code_shares: record.codeShares ?? null,
    int_dom_ind: record.intDomInd ?? null,
    pax: record.pax ?? null,
    gate: record.gate ?? null,
    stand: record.stand ?? null,
    carousel: record.carousel ?? null,
    mct: record.mct ?? null,
    fb: record.fb ?? null,
    lb: record.lb ?? null,
    bhs: record.bhs ?? null,
    ghs: record.ghs ?? null,
    date: record.date ?? '',
    scheduled_date: record.scheduledDate ?? record.date ?? '',
    scheduled_time: record.scheduledTime ?? record.schedule ?? '',
    operational_date: opDate,
    iata_season_code: record.iataSeasonCode ?? iataSeasonCode(opDate),
    flight_series_id: record.flightSeriesId ?? flightSeriesId(record),
    day_of_week: record.dayOfWeek ?? 0,
    action: record.action ?? null,
    source_row_index: record.sourceRowIndex ?? 0,
    linked_source_row_index: record.linkedSourceRowIndex ?? null,
    link_type: record.linkType ?? null,
    pair_anchor_date: record.pairAnchorDate ?? null,
    linked_record_id: record.linkedRecordId ?? null,
    source_kind: record.sourceKind ?? 'imported',
    source_side: record.sourceSide ?? 'ARR',
    status: record.status ?? 'active',
    turnaround_id: record.turnaroundId ?? null,
  };
}

function modificationRow(seasonId, mod) {
  const changedFields = Object.keys(mod).filter((field) => !['legId', 'action', 'addedLeg', 'counter', 'checkInCounterWindows'].includes(field));
  if (Object.prototype.hasOwnProperty.call(mod, 'counter')) changedFields.push('counter');
  if (Object.prototype.hasOwnProperty.call(mod, 'checkInCounterWindows')) changedFields.push('checkInCounterWindows');
  if (Object.prototype.hasOwnProperty.call(mod, 'addedLeg')) changedFields.push('addedLeg');
  return {
    season_id: seasonId,
    leg_id: mod.legId ?? mod.id,
    action: mod.action ?? 'modified',
    changed_fields: [...new Set(changedFields)],
    schedule: mod.schedule ?? null,
    aircraft: mod.aircraft ?? null,
    route: mod.route ?? null,
    code_shares: mod.codeShares ?? null,
    pax: mod.pax ?? null,
    gate: mod.gate ?? null,
    stand: mod.stand ?? null,
    carousel: mod.carousel ?? null,
    mct: mod.mct ?? null,
    fb: mod.fb ?? null,
    lb: mod.lb ?? null,
    bhs: mod.bhs ?? null,
    ghs: mod.ghs ?? null,
    check_in_start: mod.checkInStart ?? null,
    check_in_end: mod.checkInEnd ?? null,
    check_in_allocation_mode: mod.checkInAllocationMode ?? null,
  };
}

async function migrateSettings() {
  const snap = await getDoc(doc(firestore, 'appSettings', 'operational'));
  if (!snap.exists()) return;
  const settings = snap.data();
  await upsert('operational_settings', [{
    id: 'operational',
    updated_at: settings.updatedAt ?? Date.now(),
    ai_enabled: settings.aiAnalysis?.enabled !== false,
    ai_active_model_id: settings.aiAnalysis?.activeModelId ?? null,
    ai_updated_at: settings.aiAnalysis?.updatedAt ?? null,
  }], 'id');
  await upsert('operational_route_countries', (settings.routeCountries ?? []).map((entry) => ({
    route: entry.route,
    country: entry.country,
  })), 'route');
  await upsert('operational_airline_colors', (settings.airlineColors ?? []).map((entry) => ({
    airline_code: entry.airlineCode,
    color: entry.color,
  })), 'airline_code');
  await upsert('operational_aircraft_groups', (settings.aircraftGroups ?? []).map((group) => ({
    id: group.id,
    name: group.name,
    created_at: group.createdAt ?? 0,
    updated_at: group.updatedAt ?? 0,
  })), 'id');
  await upsert('operational_aircraft_group_types', (settings.aircraftGroups ?? []).flatMap((group) =>
    (group.aircraftTypes ?? []).map((aircraftType) => ({ group_id: group.id, aircraft_type: aircraftType }))
  ), 'group_id,aircraft_type');
  await upsert('operational_counter_rules', (settings.counterAllocationRules ?? []).map((rule) => ({
    id: rule.id,
    name: rule.name,
    enabled: rule.enabled !== false,
    priority_score: rule.priorityScore ?? 0,
    sort_order: rule.sortOrder ?? 0,
    condition_aircraft_types: rule.conditions?.aircraftTypes ?? [],
    condition_aircraft_groups: rule.conditions?.aircraftGroups ?? [],
    condition_airline_codes: rule.conditions?.airlineCodes ?? [],
    counter_value: rule.counterValue ?? 0,
    created_at: rule.createdAt ?? 0,
    updated_at: rule.updatedAt ?? 0,
  })), 'id');
  await upsert('operational_checkin_counters', (settings.checkInCounters ?? []).map((counter) => ({
    id: counter.id,
    label: counter.label,
    enabled: counter.enabled !== false,
    sort_order: counter.sortOrder ?? 0,
    created_at: counter.createdAt ?? 0,
    updated_at: counter.updatedAt ?? 0,
  })), 'id');
  await upsert('operational_checkin_counter_groups', (settings.checkInCounterGroups ?? []).map((group) => ({
    id: group.id,
    name: group.name,
    bhs: group.bhs ?? '',
    sort_order: group.sortOrder ?? 0,
    created_at: group.createdAt ?? 0,
    updated_at: group.updatedAt ?? 0,
  })), 'id');
  await upsert('operational_checkin_counter_group_members', (settings.checkInCounterGroups ?? []).flatMap((group) =>
    (group.counterIds ?? []).map((counterId, index) => ({ group_id: group.id, counter_id: counterId, sort_order: index }))
  ), 'group_id,counter_id');
  await upsert('operational_checkin_counter_locks', (settings.checkInCounterLocks ?? []).map((lock) => ({
    id: lock.id,
    name: lock.name,
    start_time: lock.start,
    end_time: lock.end,
    reason: lock.reason ?? null,
    enabled: lock.enabled !== false,
    created_at: lock.createdAt ?? 0,
    updated_at: lock.updatedAt ?? 0,
  })), 'id');
  await upsert('operational_checkin_counter_lock_members', (settings.checkInCounterLocks ?? []).flatMap((lock) =>
    (lock.counterIds ?? []).map((counterId, index) => ({ lock_id: lock.id, counter_id: counterId, sort_order: index }))
  ), 'lock_id,counter_id');
  await upsert('operational_gate_resources', (settings.gateResources ?? []).map((gate) => ({
    id: gate.id,
    label: gate.label,
    enabled: gate.enabled !== false,
    sort_order: gate.sortOrder ?? 0,
    created_at: gate.createdAt ?? 0,
    updated_at: gate.updatedAt ?? 0,
  })), 'id');
  await upsert('operational_gate_groups', (settings.gateGroups ?? []).map((group) => ({
    id: group.id,
    name: group.name,
    sort_order: group.sortOrder ?? 0,
    created_at: group.createdAt ?? 0,
    updated_at: group.updatedAt ?? 0,
  })), 'id');
  await upsert('operational_gate_group_members', (settings.gateGroups ?? []).flatMap((group) =>
    (group.gateIds ?? []).map((gateId, index) => ({ group_id: group.id, gate_id: gateId, sort_order: index }))
  ), 'group_id,gate_id');
  await upsert('operational_gate_locks', (settings.gateLocks ?? []).map((lock) => ({
    id: lock.id,
    name: lock.name,
    start_time: lock.start,
    end_time: lock.end,
    reason: lock.reason ?? null,
    enabled: lock.enabled !== false,
    created_at: lock.createdAt ?? 0,
    updated_at: lock.updatedAt ?? 0,
  })), 'id');
  await upsert('operational_gate_lock_members', (settings.gateLocks ?? []).flatMap((lock) =>
    (lock.gateIds ?? []).map((gateId, index) => ({ lock_id: lock.id, gate_id: gateId, sort_order: index }))
  ), 'lock_id,gate_id');
  await upsert('operational_stand_gate_mappings', (settings.standGateMappings ?? []).map((mapping) => ({
    id: mapping.id,
    stand: mapping.stand,
    gate: mapping.gate,
    sort_order: mapping.sortOrder ?? 0,
    enabled: mapping.enabled !== false,
    created_at: mapping.createdAt ?? 0,
    updated_at: mapping.updatedAt ?? 0,
  })), 'id');
  await upsert('operational_ai_models', (settings.aiAnalysis?.models ?? []).map((model, index) => ({
    id: model.id,
    label: model.label,
    provider: model.provider,
    model: model.model,
    base_url: model.baseUrl ?? null,
    enabled: model.enabled !== false,
    key_updated_at: model.keyUpdatedAt ?? null,
    sort_order: index,
  })), 'id');
}

async function migrateSeasons() {
  const seasons = await docsOfOrdered(collection(firestore, 'seasons'), 'uploadedAt', 'desc');
  await upsert('seasons', seasons.map((season) => ({
    id: season.id,
    season_code: season.data.seasonCode,
    name: season.data.name ?? season.data.seasonCode ?? '',
    file_name: season.data.fileName ?? '',
    uploaded_at: season.data.uploadedAt,
    effective_start: season.data.effectiveStart ?? '',
    effective_end: season.data.effectiveEnd ?? '',
    total_legs: season.data.totalLegs ?? 0,
    total_source_rows: season.data.totalSourceRows ?? 0,
    data_version: season.data.dataVersion ?? 0,
    last_synced_at: season.data.lastSyncedAt ?? null,
  })), 'id');

  for (const season of seasons) {
    const seasonId = season.id;
    const [sourceRows, flightRecords, modifications, modHistory] = await Promise.all([
      docsOfOrdered(collection(firestore, 'seasons', seasonId, 'sourceRows'), 'rowIndex'),
      docsOf(collection(firestore, 'seasons', seasonId, 'flightRecords')),
      docsOf(collection(firestore, 'seasons', seasonId, 'modifications')),
      docsOfOrdered(collection(firestore, 'seasons', seasonId, 'modHistory'), 'timestamp', 'desc'),
    ]);
    await upsert('season_source_rows', sourceRows.map((row) => sourceRow(seasonId, row.data)), 'season_id,row_index');
    await upsert('season_source_row_days', sourceRows.flatMap((row) => sourceRowDays(seasonId, row.data)), 'season_id,row_index,iso_dow');
    await upsert('season_flight_records', flightRecords.map((record) => flightRecordRow(seasonId, { id: record.id, ...record.data })), 'record_id');
    await upsert('season_flight_record_counters', flightRecords.flatMap((record) => counterRows('record_id', record.id, record.data.counter)), 'record_id,counter_group,item_index');
    await upsert('season_flight_record_checkin_windows', flightRecords.flatMap((record) => windowRows('record_id', record.id, record.data.checkInCounterWindows)), 'record_id,counter_key');
    await upsert('season_modifications', modifications.map((mod) => modificationRow(seasonId, { legId: mod.id, ...mod.data })), 'leg_id');
    await upsert('season_modification_counters', modifications.flatMap((mod) => counterRows('leg_id', mod.id, mod.data.counter)), 'leg_id,counter_group,item_index');
    await upsert('season_modification_checkin_windows', modifications.flatMap((mod) => windowRows('leg_id', mod.id, mod.data.checkInCounterWindows)), 'leg_id,counter_key');
    await upsert('season_modification_added_legs', modifications.filter((mod) => mod.data.addedLeg).map((mod) => ({
      ...flightRecordRow(seasonId, { id: mod.data.addedLeg.id ?? mod.id, ...mod.data.addedLeg, sourceKind: 'added', sourceSide: mod.data.addedLeg.type === 'D' ? 'DEP' : 'ARR', status: 'active' }),
      leg_id: mod.id,
    })), 'leg_id');
    await upsert('season_mod_history_entries', modHistory.map((entry) => ({
      season_id: seasonId,
      entry_id: entry.id,
      timestamp: entry.data.timestamp,
      description: entry.data.description ?? '',
    })), 'entry_id');
    await upsert('season_mod_history_changes', modHistory.flatMap((entry) =>
      (entry.data.changes ?? []).map((change, index) => ({
        entry_id: entry.id,
        change_index: index,
        leg_id: change.legId,
        previous_mod_snapshot: change.previousMod ?? null,
        new_mod_snapshot: change.newMod,
      }))
    ), 'entry_id,change_index');
    await upsert('season_mod_history_record_changes', modHistory.flatMap((entry) =>
      (entry.data.recordChanges ?? []).map((change, index) => ({
        entry_id: entry.id,
        change_index: index,
        record_id: change.recordId,
        previous_record_snapshot: change.previousRecord ?? null,
        new_record_snapshot: change.newRecord ?? null,
      }))
    ), 'entry_id,change_index');
  }
}

async function migrateAudit() {
  const sessions = await docsOfOrdered(collection(firestore, 'auditSessions'), 'lastSeenAt', 'desc');
  await upsert('audit_sessions', sessions.map((session) => ({
    id: session.id,
    started_at: session.data.startedAt,
    last_seen_at: session.data.lastSeenAt,
    payload: { id: session.id, ...session.data },
  })), 'id');

  for (const session of sessions) {
    const entries = await docsOfOrdered(collection(firestore, 'auditSessions', session.id, 'entries'), 'timestamp', 'desc');
    await upsert('audit_entries', entries.map((entry) => ({
      session_id: session.id,
      id: entry.id,
      timestamp: entry.data.timestamp,
      payload: { id: entry.id, ...entry.data },
    })), 'session_id,id');

    for (const entry of entries) {
      const chunks = await docsOfOrdered(
        collection(firestore, 'auditSessions', session.id, 'entries', entry.id, 'deltaChunks'),
        'chunkIndex'
      );
      await upsert('audit_delta_chunks', chunks.map((chunk) => ({
        session_id: session.id,
        entry_id: entry.id,
        id: chunk.id,
        chunk_index: chunk.data.chunkIndex,
        payload: { id: chunk.id, ...chunk.data },
      })), 'session_id,entry_id,id');
    }
  }
}

await migrateSettings();
await migrateSeasons();
await migrateAudit();
console.log('Firestore to Supabase migration complete.');
