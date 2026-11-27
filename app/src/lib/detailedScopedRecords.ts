import { getSupabaseClient } from './supabase';
import { seasonalDraftToFlightRecord } from './seasonalPlanningContract';
import { fromFlightRecordRows, fromModificationRows } from './supabaseRelationalMappers';
import type { FlightRecord, FlightModification } from './types';

export async function getDetailedScopedRecords(seasonId: string, recordIds: string[], planning: boolean) {
  if (!recordIds.length) throw new Error('Chưa chọn dòng lịch mùa.');
  const ids = [...new Set(recordIds)];
  const records: FlightRecord[] = [];
  const modifications = new Map<string, FlightModification>();
  let epoch = '', revision = '';
  for (let start = 0; start < ids.length; start += 100) {
    const { data, error } = await getSupabaseClient().rpc('get_detailed_scoped_records_v1', {
      p_season_id: seasonId, p_record_ids: ids.slice(start, start + 100), p_planning: planning,
      p_expected_revision: start ? epoch + ':' + revision : null,
    });
    if (error) throw error;
    epoch = data.epoch;
    revision = data.revision;
    for (const item of data.records) records.push(planning ? seasonalDraftToFlightRecord(item) : fromFlightRecordRows(item.record, item.counters, item.windows));
    for (const item of data.modifications) {
      const mod = fromModificationRows(item.row, item.counters, item.windows, item.addedLeg);
      modifications.set(mod.legId, mod);
    }
  }
  return { records, modifications, epoch, revision };
}
