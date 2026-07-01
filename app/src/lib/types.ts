// ─── Domain Types ──────────────────────────────────────────────

/** Raw row parsed from the seasonal schedule Excel file */
export interface ParsedRow {
  rowIndex: number;
  effective: string;       // e.g., "29-Mar-26"
  discontinue: string;     // e.g., "24-Oct-26"
  airline: string;         // e.g., "VJ"
  aircraft: string;        // e.g., "321"
  daysOfWeek: boolean[];   // [Mon, Tue, Wed, Thu, Fri, Sat, Sun]

  // Arrival side
  sta: string | null;
  arrFlight: string | null;
  /** Application-layer constant PAX; omitted from persistence. */
  arrFlightType: string | null;
  arrRoute: string | null;
  arrFlightCategory: string | null;
  arrCodeShares: string | null;
  arrIntDomInd: string | null;

  // Departure side
  std: string | null;
  depFlight: string | null;
  /** Application-layer constant PAX; omitted from persistence. */
  depFlightType: string | null;
  depRoute: string | null;
  depFlightCategory: string | null;
  depCodeShares: string | null;
  depIntDomInd: string | null;

  // Turnaround link: rowIndex of the paired row (ARR↔DEP)
  overnightLinkRowIndex?: number;
  // Type of turnaround link: 'overnight' (DEP next day) or 'sameday' (DEP same day)
  // Defaults to 'overnight' for backward compatibility with existing links
  linkType?: 'overnight' | 'sameday';
}

/** Enriched source row for display (has cleaned flight numbers) */
export interface DisplayRow extends ParsedRow {
  arrCleanFlight: string | null;
  depCleanFlight: string | null;
  arrRequestStatusCode: string | null;
  depRequestStatusCode: string | null;
}

/** Result of cleaning a raw flight number */
export interface CleanedFlight {
  flightNumber: string;
  rawFlightNumber: string;
  requestStatusCode: string | null;
}

export type FlightCounter = string | Array<string | number> | Record<string, string | number | Array<string | number>> | null;
export type CheckInAllocationMode = 'grouped' | 'broken';

export interface CheckInCounterWindow {
  start: string;
  end: string;
}

export type CheckInCounterWindowMap = Record<string, CheckInCounterWindow>;

/** A single flight leg (expanded in-memory) */
export interface FlightLeg {
  id: string;
  linkId: string;
  type: 'A' | 'D';
  airline: string;
  flightNumber: string;
  rawFlightNumber: string;
  requestStatusCode: string | null;
  route: string;
  schedule: string;
  aircraft: string;
  category: string;
  /** Application-layer constant PAX; omitted from persistence. */
  flightType: string;
  codeShares: string | null;
  intDomInd: string | null;
  pax: number | null;
  gate: number | null;
  stand: number | null;
  counter: FlightCounter;
  checkInStart?: string | null;
  checkInEnd?: string | null;
  checkInAllocationMode?: CheckInAllocationMode | null;
  checkInCounterWindows?: CheckInCounterWindowMap | null;
  carousel: number | null;
  mct: string | null;
  fb: string | null;
  lb: string | null;
  bhs: string | null;
  ghs: string | null;
  date: string;
  scheduledDate?: string;
  scheduledTime?: string;
  operationalDate?: string;
  iataSeasonCode?: string;
  flightSeriesId?: string;
  dayOfWeek: number;
  action: null | 'modified' | 'added' | 'deleted';
  sourceRowIndex: number;
  linkedSourceRowIndex?: number;
  turnaroundId?: string;
  linkType?: 'overnight' | 'sameday';
  pairAnchorDate?: string;
  linkedRecordId?: string;
}

/** Canonical editable flight occurrence. Source rows are import backup; records are truth. */
export interface FlightRecord extends FlightLeg {
  sourceKind: 'imported' | 'added';
  sourceSide: 'ARR' | 'DEP';
  status: 'active' | 'deleted';
  turnaroundId?: string;
  pairAnchorDate?: string;
  linkedRecordId?: string;
}

/** Modification record stored in Firestore */
export interface FlightModification {
  legId: string;
  action: 'modified' | 'deleted' | 'added';
  schedule?: string;
  aircraft?: string;
  route?: string;
  codeShares?: string | null;
  pax?: number | null;
  gate?: number | null;
  stand?: number | null;
  counter?: FlightCounter;
  checkInStart?: string | null;
  checkInEnd?: string | null;
  checkInAllocationMode?: CheckInAllocationMode | null;
  checkInCounterWindows?: CheckInCounterWindowMap | null;
  carousel?: number | null;
  mct?: string | null;
  fb?: string | null;
  lb?: string | null;
  bhs?: string | null;
  ghs?: string | null;
  addedLeg?: FlightLeg; // Stores full leg data if it's a completely new flight (e.g. copied to an empty day)
}

/** A single change within a history entry */
export interface ModHistoryChange {
  legId: string;
  previousMod: FlightModification | null; // null = leg was unmodified (original state)
  newMod: FlightModification;
}

/** A FlightRecord-level change, used for link/unlink undo */
export interface FlightRecordHistoryChange {
  recordId: string;
  previousRecord: FlightRecord | null;
  newRecord: FlightRecord | null;
}

/** A batched history entry for undo support */
export interface ModHistoryEntry {
  id: string;
  timestamp: number;
  description: string;
  changes: ModHistoryChange[];
  recordChanges?: FlightRecordHistoryChange[];
  /** Supabase sync outbox payload for after-sync Telegram notifications. */
  scheduleNotification?: unknown;
}

/** Season metadata document */
export interface Season {
  id: string;
  seasonCode: string;         // e.g., "S26", "W26" — from sheet name
  name: string;
  fileName: string;
  uploadedAt: number;
  effectiveStart: string;
  effectiveEnd: string;
  totalLegs: number;
  totalSourceRows: number;
  dataVersion?: number;
  lastSyncedAt?: number;
}

export interface AircraftGroup {
  id: string;
  name: string;
  aircraftTypes: string[];
  createdAt: number;
  updatedAt: number;
}

export interface CounterRuleConditions {
  aircraftTypes: string[];
  aircraftGroups: string[];
  airlineCodes: string[];
}

export interface CounterAllocationRule {
  id: string;
  name: string;
  enabled: boolean;
  priorityScore: number;
  sortOrder: number;
  conditions: CounterRuleConditions;
  counterValue: number;
  createdAt: number;
  updatedAt: number;
}

export interface CheckInCounterResource {
  id: string;
  label: string;
  enabled: boolean;
  sortOrder: number;
  createdAt: number;
  updatedAt: number;
}

export interface CheckInCounterGroup {
  id: string;
  name: string;
  bhs: string;
  counterIds: string[];
  sortOrder: number;
  createdAt: number;
  updatedAt: number;
}

export interface CheckInCounterLock {
  id: string;
  name: string;
  counterIds: string[];
  start: string;
  end: string;
  reason: string | null;
  enabled: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface GateResource {
  id: string;
  label: string;
  enabled: boolean;
  sortOrder: number;
  createdAt: number;
  updatedAt: number;
}

export interface GateGroup {
  id: string;
  name: string;
  gateIds: string[];
  sortOrder: number;
  createdAt: number;
  updatedAt: number;
}

export interface GateLock {
  id: string;
  name: string;
  gateIds: string[];
  start: string;
  end: string;
  reason: string | null;
  enabled: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface StandGateMapping {
  id: string;
  stand: number;
  gate: number;
  sortOrder: number;
  enabled: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface AirlineColorSetting {
  airlineCode: string;
  color: string;
}

export interface RouteCountryMapping {
  route: string;
  country: string;
}

export type AiAnalysisProvider = 'gemini' | 'openai-compatible' | 'deepseek';

export interface AiAnalysisModelSetting {
  id: string;
  label: string;
  provider: AiAnalysisProvider;
  model: string;
  baseUrl: string | null;
  enabled: boolean;
  keyUpdatedAt: number | null;
}

export interface AiAnalysisProviderKeyStatus {
  provider: AiAnalysisProvider;
  keyFingerprint: string;
  keyUpdatedAt: number;
  updatedBy: string | null;
}

export type AiAnalysisContextDocumentKind = 'rule' | 'skill';

export interface AiAnalysisContextDocument {
  id: string;
  kind: AiAnalysisContextDocumentKind;
  title: string;
  contentMd: string;
  enabled: boolean;
  sortOrder: number;
  createdAt: number;
  updatedAt: number;
}

export interface AiAnalysisSettings {
  enabled: boolean;
  activeModelId: string;
  models: AiAnalysisModelSetting[];
  contextDocuments: AiAnalysisContextDocument[];
  updatedAt: number | null;
}

export interface DashboardAlertSettings {
  arrivalBucketFlights: number | null;
  departureBucketFlights: number | null;
  adGapFlights: number | null;
  ctgAbsPct: number | null;
  paxCoverageMinPct: number | null;
}

export interface OperationalSettings {
  airlineColors: AirlineColorSetting[];
  routeCountries: RouteCountryMapping[];
  aiAnalysis: AiAnalysisSettings;
  dashboardAlerts: DashboardAlertSettings;
  aircraftGroups: AircraftGroup[];
  counterAllocationRules: CounterAllocationRule[];
  checkInCounters: CheckInCounterResource[];
  checkInCounterGroups: CheckInCounterGroup[];
  checkInCounterLocks: CheckInCounterLock[];
  gateResources: GateResource[];
  gateGroups: GateGroup[];
  gateLocks: GateLock[];
  standGateMappings: StandGateMapping[];
  updatedAt: number | null;
}

/** A pattern group used during export reconstruction */
export interface PatternGroup {
  airline: string;
  aircraft: string;
  effective: string;
  discontinue: string;
  daysOfWeek: boolean[];

  arrFlightNumber: string | null;
  arrRoute: string | null;
  arrSchedule: string | null;
  arrCategory: string | null;
  arrFlightType: string | null;
  arrCodeShares: string | null;
  arrIntDomInd: string | null;
  arrRequestStatusCode: string | null;

  depFlightNumber: string | null;
  depRoute: string | null;
  depSchedule: string | null;
  depCategory: string | null;
  depFlightType: string | null;
  depCodeShares: string | null;
  depIntDomInd: string | null;
  depRequestStatusCode: string | null;

  arrSourceRowIndex?: number | null;
  depSourceRowIndex?: number | null;
  linkType?: 'overnight' | 'sameday' | null;
}

/** Parse result with season code */
export interface ParseResult {
  seasonCode: string;
  rows: ParsedRow[];
}
