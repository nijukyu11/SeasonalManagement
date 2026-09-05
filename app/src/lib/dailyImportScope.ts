interface DailyImportScopeTarget {
  seasonId: string;
  seasonCode: string;
  rangeStart: string;
  rangeEnd: string;
  affectedDates: string[];
  confirmedZeroFlightDates: string[];
}

interface DailyImportScopeLeg {
  seasonCode: string;
  operationalDate: string;
}

interface DailyImportScopeDiagnostic {
  code: string;
}

interface DailyImportScopePayload {
  contractVersion: 1;
  requestId: string;
  rawChecksum: string;
  canonicalChecksum: string;
  resourcePolicyHash: string;
  legs: DailyImportScopeLeg[];
  seasons: DailyImportScopeTarget[];
  diagnostics: DailyImportScopeDiagnostic[];
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function requestUuidFromHash(hash: string): string {
  const chars = hash.slice(0, 32).split('');
  chars[12] = '5';
  chars[16] = ['8', '9', 'a', 'b'][Number.parseInt(chars[16], 16) % 4];
  const compact = chars.join('');
  return `${compact.slice(0, 8)}-${compact.slice(8, 12)}-${compact.slice(12, 16)}-${compact.slice(16, 20)}-${compact.slice(20)}`;
}

function allIsoDates(from: string, to: string): string[] {
  const result: string[] = [];
  const cursor = new Date(`${from}T00:00:00Z`);
  const end = new Date(`${to}T00:00:00Z`);
  while (cursor <= end) {
    result.push(cursor.toISOString().slice(0, 10));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return result;
}

export async function confirmDailyImportZeroFlightDatesV1<T extends DailyImportScopePayload>(
  payload: T,
  confirmedDatesBySeasonId: Readonly<Record<string, readonly string[]>>,
): Promise<T> {
  const isoDate = /^\d{4}-\d{2}-\d{2}$/;
  const targets = payload.seasons.map((target) => {
    const legDates = [...new Set(payload.legs
      .filter((leg) => leg.seasonCode === target.seasonCode)
      .map((leg) => leg.operationalDate))].sort();
    const confirmedZeroFlightDates = [...new Set(confirmedDatesBySeasonId[target.seasonId] ?? [])]
      .map((date) => date.trim())
      .filter(Boolean)
      .sort();
    if (confirmedZeroFlightDates.some((date) => !isoDate.test(date)
      || !Number.isFinite(Date.parse(`${date}T00:00:00Z`))
      || new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10) !== date)) {
      throw new Error(`Ops Date xác nhận cho season ${target.seasonCode} phải có dạng YYYY-MM-DD.`);
    }
    if (confirmedZeroFlightDates.some((date) => legDates.includes(date))) {
      throw new Error(`Không thể xác nhận zero-flight cho ngày đã có leg trong season ${target.seasonCode}.`);
    }
    if (confirmedZeroFlightDates.some((date) => date < target.rangeStart || date > target.rangeEnd)) {
      throw new Error(`Ops Date xác nhận nằm ngoài phạm vi preview của season ${target.seasonCode}.`);
    }
    const affectedDates = [...new Set([...legDates, ...confirmedZeroFlightDates])].sort();
    // Never let partial confirmation shrink away a cancelled boundary date.
    const { rangeStart, rangeEnd } = target;
    const missingConfirmations = allIsoDates(rangeStart, rangeEnd)
      .filter((date) => !legDates.includes(date) && !confirmedZeroFlightDates.includes(date));
    if (missingConfirmations.length > 0) {
      throw new Error(`Season ${target.seasonCode} còn thiếu xác nhận zero-flight: ${missingConfirmations.join(', ')}.`);
    }
    return { ...target, rangeStart, rangeEnd, affectedDates, confirmedZeroFlightDates };
  });
  const diagnostics = payload.diagnostics.filter((diagnostic) => diagnostic.code !== 'DAILY_COVERAGE_GAP');
  const canonicalChecksum = await sha256Hex(stableJson({
    contractVersion: payload.contractVersion,
    legs: payload.legs,
    targets,
    resourcePolicyHash: payload.resourcePolicyHash,
  }));
  const requestId = requestUuidFromHash(await sha256Hex(stableJson({
    canonicalChecksum,
    rawChecksum: payload.rawChecksum,
    resourcePolicyHash: payload.resourcePolicyHash,
    targets,
  })));
  return { ...payload, requestId, canonicalChecksum, seasons: targets, diagnostics } as T;
}
