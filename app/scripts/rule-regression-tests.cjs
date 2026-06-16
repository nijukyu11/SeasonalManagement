/* eslint-disable @typescript-eslint/no-require-imports */
const fs = require('fs');
const path = require('path');
const ts = require('typescript');

const root = path.resolve(__dirname, '..');
const tempDir = path.join(root, '.tmp-rule-tests');
const readFileSync = fs.readFileSync.bind(fs);

fs.readFileSync = function readTextFileSyncWithNormalizedNewlines(filePath, options) {
  const content = readFileSync(filePath, options);
  const encoding = typeof options === 'string' ? options : options?.encoding;
  return typeof content === 'string' && encoding?.toLowerCase().replace('-', '') === 'utf8'
    ? content.replace(/\r\n/g, '\n')
    : content;
};

function compileFixtureModules() {
  fs.rmSync(tempDir, { recursive: true, force: true });
  fs.mkdirSync(tempDir, { recursive: true });
  fs.writeFileSync(path.join(tempDir, 'package.json'), '{"type":"commonjs"}\n');

  for (const name of ['types', 'importSeasonRules', 'iataSeason', 'flightPairIntegrity', 'parser', 'exporter', 'canonicalSeasonalRows', 'sourceRowPatterns', 'atomicSchedule', 'firestoreWritePlanner', 'importProgress', 'settingsRules', 'settingsPageActions', 'modHistorySizing', 'auditLog', 'detailedScheduleState', 'dailySchedule', 'dailyScheduleImport', 'dailyScheduleExport', 'checkinAllocation', 'checkInCounterSettings', 'gateAllocation', 'checkinPdfExport', 'gatePdfExport', 'seasonDataCache', 'seasonalLinkActions', 'nativeRuntime', 'nativeLocalSeasonStore', 'localSeasonStore', 'localSeasonSqlStore', 'seasonWorkspaceBootstrap', 'seasonChangeEvents', 'appSessionCleanup', 'exportSave', 'remoteStore', 'supabase', 'supabaseStore', 'seasonSync', 'seasonAutoSync', 'seasonalDisplayAggregator', 'routeCountry', 'dashboardAnalysis', 'dashboardAiShared', 'dashboardAiAnalysis', 'dashboardReportExport', 'persistenceSchema']) {
    const sourcePath = name === 'dashboardAiShared'
      ? path.join(root, 'supabase', 'functions', '_shared', 'dashboardAiShared.ts')
      : path.join(root, 'src', 'lib', `${name}.ts`);
    const source = fs.readFileSync(sourcePath, 'utf8');
    const output = ts.transpileModule(source, {
      compilerOptions: {
        target: ts.ScriptTarget.ES2019,
        module: ts.ModuleKind.CommonJS,
        esModuleInterop: true,
        jsx: ts.JsxEmit.ReactJSX,
      },
      fileName: `${name}.ts`,
    });
    const commonJsOutput = output.outputText.replace(/require\("(\.\/[^"]+)\.ts"\)/g, 'require("$1.js")');
    fs.writeFileSync(path.join(tempDir, `${name}.js`), commonJsOutput);
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function sameDays(actual, expected, label) {
  assert(
    JSON.stringify(actual) === JSON.stringify(expected),
    `${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`
  );
}

function findUndefinedPath(value, pathLabel = 'payload') {
  if (value === undefined) return pathLabel;
  if (!value || typeof value !== 'object') return null;
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      const found = findUndefinedPath(value[i], `${pathLabel}[${i}]`);
      if (found) return found;
    }
    return null;
  }
  for (const [key, entryValue] of Object.entries(value)) {
    const found = findUndefinedPath(entryValue, `${pathLabel}.${key}`);
    if (found) return found;
  }
  return null;
}

function baseRow(overrides) {
  return {
    rowIndex: 1,
    effective: '18-Jun-25',
    discontinue: '28-Jul-25',
    airline: 'VN',
    aircraft: '321',
    daysOfWeek: [true, false, true, false, true, false, true],
    sta: null,
    arrFlight: null,
    arrFlightType: null,
    arrRoute: null,
    arrFlightCategory: null,
    arrCodeShares: null,
    arrIntDomInd: null,
    std: null,
    depFlight: null,
    depFlightType: null,
    depRoute: null,
    depFlightCategory: null,
    depCodeShares: null,
    depIntDomInd: null,
    ...overrides,
  };
}

function rowSummary(group) {
  return {
    effective: group.effective,
    discontinue: group.discontinue,
    daysOfWeek: group.daysOfWeek,
    arr: group.arrFlightNumber,
    dep: group.depFlightNumber,
  };
}

function walkFiles(dir, predicate, files = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) walkFiles(fullPath, predicate, files);
    else if (predicate(fullPath)) files.push(fullPath);
  }
  return files;
}

async function workbookRowsFromBlob(blob) {
  const XLSX = require('xlsx');
  const buffer = Buffer.from(await blob.arrayBuffer());
  const workbook = XLSX.read(buffer, { type: 'buffer' });
  return XLSX.utils.sheet_to_json(workbook.Sheets[workbook.SheetNames[0]], { defval: '' });
}

async function run() {
  compileFixtureModules();
  const XLSX = require('xlsx');
  const {
    buildSeasonDisplayLabel,
    buildSeasonNameFromFileName,
    getDirtyImportGuard,
    normalizeSeasonSheetName,
  } = require(path.join(tempDir, 'importSeasonRules.js'));
  const { expandToFlightLegs, parseSeasonalSchedule } = require(path.join(tempDir, 'parser.js'));
  const {
    buildFlightSeriesId,
    buildOperationalFlightMetadata,
    getIataSeasonForOperationalDate,
    getOperationalDate,
    getSeasonDateRange,
  } = require(path.join(tempDir, 'iataSeason.js'));
  const { exportToExcel, groupFlightLegs } = require(path.join(tempDir, 'exporter.js'));
  const {
    applySourceRowRebuildPlan,
    buildCanonicalSeasonalRows,
    buildSourceRowRebuildBackup,
    buildSourceRowRebuildPlan,
    exportCanonicalSeasonalRowsToExcel,
    validateCanonicalSeasonalRoundTrip,
  } = require(path.join(tempDir, 'canonicalSeasonalRows.js'));
  const { planGranularUnlink } = require(path.join(tempDir, 'sourceRowPatterns.js'));
  const { FIRESTORE_WRITE_BATCH_SIZE, chunkFirestoreWrites } = require(path.join(tempDir, 'firestoreWritePlanner.js'));
  const {
    buildImportBatchProgress,
    buildImportProgress,
    buildLoadBatchProgress,
    buildLoadProgress,
  } = require(path.join(tempDir, 'importProgress.js'));
  const { 
    AI_ANALYSIS_DEFAULT_CONTEXT_DOCUMENT_TEMPLATES, 
    buildDefaultAiAnalysisContextDocuments, 
    evaluateCounterRules, 
    hydrateOperationalSettings, 
    removeAircraftGroupFromSettings, 
    validateOperationalSettings,
  } = require(path.join(tempDir, 'settingsRules.js'));
  const {
    FIRESTORE_MOD_HISTORY_SAFE_BYTES,
    estimateModHistoryEntryBytes,
    splitModHistoryEntryForFirestore,
  } = require(path.join(tempDir, 'modHistorySizing.js'));
  const {
    FIRESTORE_AUDIT_DELTA_SAFE_BYTES,
    buildFlightActionAuditEntry,
    buildSyncAuditDelta,
    estimateAuditPayloadBytes,
    splitAuditDeltaChunks,
  } = require(path.join(tempDir, 'auditLog.js'));
  const {
    clearSeasonDataCache,
    getCachedSeasonData,
    getCachedSeasons,
    patchCachedSeasonData,
    publishSeasonWorkspaceChanged,
    setCachedSeasonData,
    setCachedSeasons,
    subscribeSeasonWorkspaceChanges,
  } = require(path.join(tempDir, 'seasonDataCache.js'));
  const {
    buildSeasonalLinkCandidates,
    buildSeasonalLinkRoute,
    getSeasonalLinkActionState,
  } = require(path.join(tempDir, 'seasonalLinkActions.js'));
  const {
    applyLocalFlightRecordMutation,
    applyLocalModificationBatchDelta,
    createLocalWorkspace,
    clearAllLocalSeasonWorkspaces,
    deserializeModificationEntries,
    discardAllLocalPendingChanges,
    discardLocalPendingChanges,
    getPendingSyncSummary,
    loadLocalSeasonWorkspace,
    markDerivedSeasonalDirty,
    mergePendingOps,
    rebuildPendingOpsFromBaseline,
    saveLocalSeasonWorkspace,
    serializeModificationMap,
  } = require(path.join(tempDir, 'localSeasonStore.js'));
  const {
    loadOrSeedSeasonWorkspace,
  } = require(path.join(tempDir, 'seasonWorkspaceBootstrap.js'));
  const {
    applySeasonEventRange,
    buildPendingChangeEvents,
    mergeSeasonSnapshotIntoLocalWorkspace,
    mergeRemoteSeasonEvent,
    resolveSeasonConflict,
    seasonEventTargetKey,
  } = require(path.join(tempDir, 'seasonChangeEvents.js'));
  const { buildSeasonalDisplayGroups } = require(path.join(tempDir, 'seasonalDisplayAggregator.js'));
  const {
    buildPeakHourAxisTicks,
    buildDashboardOverview,
    buildDashboardComparison,
    buildEffectiveDashboardRecords,
    getDashboardOperationalDate,
    listDashboardPeriods,
  } = require(path.join(tempDir, 'dashboardAnalysis.js'));
  const {
    DASHBOARD_AI_GROUNDING_INSTRUCTIONS,
    DASHBOARD_AI_SKILL_REGISTRY,
    DASHBOARD_AI_WORKFLOW_REGISTRY,
    DASHBOARD_AI_TOOL_REGISTRY,
    DASHBOARD_AI_TOOL_SELECTION_FIXTURES,
    DASHBOARD_AI_VISUAL_REPORT_TEMPLATE_IDS,
    analyzeDashboardWithAi,
    buildDashboardAgentRuntimeConfig,
    buildDashboardAiContext,
    buildDashboardAiFunctionRequest,
    buildDashboardAiNotebookContext, 
    buildDashboardAiFollowUpBoardPatchFromCells, 
    buildDashboardAiPrompt, 
    buildDashboardAiResolvedDataRequest,
    buildDashboardAiResolvedDataFallbackAnswer,
    capDashboardAiLocalHistory,
    appendDashboardAiRunEvent,
    buildDashboardAiSessionLedger,
    compactDashboardAiSessionLedger,
    createDashboardAiRunEvent,
    evaluateDashboardAiToolPermission,
    mapSkawldEventToDashboardAiRunEvent,
    inferDashboardAiDataRequestFromText,
    isDashboardAiDataRequestPrompt,
    resolveDashboardAgentToolForPrompt,
    resolveDashboardAiDataRequest,
    resolveDashboardAiExportAction,
    resolveDashboardAiAvailableTools,
    isDashboardAiToolTraceVisible,
    resolveDashboardAiSkillForPrompt,
    resolveDashboardAiWorkflowForPrompt,
    resolveDashboardAiToolTraceSummary,
    resolveDashboardAiVisualReport,
    resolveDashboardAiBoardPatch,
    resolveDashboardAiQueryResults,
    resolveDashboardAiLocalQueryResults,
    buildDashboardAiBoardPatchFromQueryResults,
    buildDashboardAiPreparedDataContracts,
    buildDashboardAiActiveArtifactFromCell,
    inferDashboardAiDataQueryForPrompt,
    planDashboardAiSqlQueries, 
    planDashboardAiSqlDrilldownQueries, 
    profileDashboardAiQueryResults, 
    resolveDashboardAiSessionFollowUp,
    resolveDashboardAiDataScopeForPrompt, 
    scheduleDashboardAiRun,
    shouldPreferDashboardAiQueryResults, 
    verifyDashboardAiAnswerAgainstQueryResults, 
    buildDashboardAiFallbackBoardPatch,
    buildDashboardAiWorkspaceBoard,
    applyDashboardAiWorkspaceBoardPatch,
    normalizeDashboardAiWorkspaceSeasonIds,
    resolveDashboardAiWorkspaceToolForPrompt,
    DEFAULT_AI_ANALYSIS_SETTINGS,
    isDashboardAiConfigured,
    resolveDashboardAiModel,
  } = require(path.join(tempDir, 'dashboardAiAnalysis.js'));
  const {
    CANONICAL_DASHBOARD_REPORT_COLUMNS,
    buildCustomDashboardWorkbook,
    buildDashboardReportRows,
    buildMomWowAnalysisWorkbook,
    buildSanLuongSummaryWorkbook,
  } = require(path.join(tempDir, 'dashboardReportExport.js'));
  const {
    mergeRouteCountryMappings,
    normalizeRouteCode,
    parseRouteCountryRows,
    resolveCountryForRoute,
  } = require(path.join(tempDir, 'routeCountry.js'));
  const { planSync, applySuccessfulSync, finalizeSuccessfulSync, isSeasonWorkspaceStale, createWorkspaceFromRemoteSnapshot } = require(path.join(tempDir, 'seasonSync.js'));
  const {
    AUTO_SYNC_RETRY_DELAYS_MS,
    SeasonAutoSyncScheduler,
    getAutoSyncRetryDelayMs,
    isTransientSyncFailure,
  } = require(path.join(tempDir, 'seasonAutoSync.js'));
  const {
    hydrateFlightModificationFromPersistence,
    hydrateFlightRecordFromPersistence,
    hydrateSourceRowFromPersistence,
    serializeFlightModificationForPersistence,
    serializeFlightRecordForPersistence,
    serializeModHistoryEntryForPersistence,
    serializeSourceRowForPersistence,
  } = require(path.join(tempDir, 'persistenceSchema.js'));
  const {
    addedModificationsToFlightRecords,
    applyFlightRecordUpdates,
    applyModificationBatch,
    applyModificationsToFlightLegs,
    buildCanonicalAddedFlightRecords,
    buildDetailedScheduleQueryWindow,
    buildSpatialCalendarDateSelection,
    buildDetailedNewFlightModifications,
    formatLinkedFlightTime,
    filterDetailedLegs,
    filterDetailedLegsForView,
    mergeCalendarDateSelections,
    normalizeNewFlightDateSelection,
    revertFlightRecordHistoryList,
    revertModificationHistoryMap,
  } = require(path.join(tempDir, 'detailedScheduleState.js'));
  const {
    flattenRowsToFlightRecords,
    flightRecordsToLegs,
    includeLinkedLegsForExport,
    includeLinkedPairsForExport,
    findDuplicateFlightNumberViolations,
    assertNoDuplicateFlightNumbersForEffectiveRecords,
    mergeDuplicateImportPeriods,
    mergeDuplicateImportRecords,
    linkFlightRecordPairs,
    mergePersistedFlightRecords,
    unlinkFlightRecords,
  } = require(path.join(tempDir, 'atomicSchedule.js'));
  const {
    buildDailyScheduleRows,
    buildDefaultDailyDateRange,
    buildDailySummary,
    buildDailyCellModification,
    validateDailyCellEdit,
    filterDailyRows,
    formatDailyScheduleDateTime,
    getDailyRowRecordIds,
    readDailyDateRangeQuery,
    sortDailyRows,
  } = require(path.join(tempDir, 'dailySchedule.js'));
  const {
    buildDailyScheduleImportUpdate,
    partitionDailyImportRowsByIataSeason,
    parseDailyImportWorksheet,
  } = require(path.join(tempDir, 'dailyScheduleImport.js'));
  const {
    DAILY_SCHEDULE_EXPORT_HEADERS,
    buildDailyScheduleExportFileName,
    buildDailyScheduleSummaryWorkbook,
  } = require(path.join(tempDir, 'dailyScheduleExport.js'));
  const {
    sanitizeExportFileName,
  } = require(path.join(tempDir, 'exportSave.js'));
  const {
    CHECKIN_SNAP_MINUTES,
    CHECKIN_RESIZE_SNAP_MINUTES,
    addCheckInCounter,
    allocateCheckInCounters,
    breakCheckInAllocation,
    buildCheckInAllocationView,
    buildCheckInPackedRows,
    buildCheckInPeriodUnallocationModifications,
    buildCheckInRecordProjection,
    buildCheckInResizePreview,
    buildCheckInTimelineTicks,
    buildDefaultCheckInWindow,
    buildDefaultCounterRoster,
    calculateCheckInEdgeScroll,
    chooseCheckInLabelMode,
    getCheckInColorToken,
    moveCheckInAllocation,
    mergeCheckInAllocationViewPatch,
    normalizeCheckInCounterList,
    overrideCheckInTimes,
    removeCheckInCounter,
    reshapeCheckInAllocation,
    resizeCheckInAllocation,
    unallocateCheckInRecord,
  } = require(path.join(tempDir, 'checkinAllocation.js'));
  const {
    buildCheckInBhsValue,
    buildCheckInCounterResources,
    buildCheckInCounterSections,
    findCheckInLockConflict,
    parseCheckInCounterInventoryInput,
  } = require(path.join(tempDir, 'checkInCounterSettings.js'));
  const {
    buildDailyStandGateModifications,
    buildDefaultGateWindow,
    buildGateRecordProjection,
    buildGatePackedRows,
    buildGateAllocationView,
    buildGateTimelineTicks,
    formatGateFlightLabel,
    mergeGateAllocationViewPatch,
    resolveGateForStand,
  } = require(path.join(tempDir, 'gateAllocation.js'));
  const {
    buildCheckInPdfPreviewPlan,
    buildCheckInPdfPagePlan,
    buildCheckInPdfBarLabelSegments,
    calculateCheckInPdfScale,
    chooseCheckInPdfBarText,
    selectCheckInPdfPreviewGroups,
  } = require(path.join(tempDir, 'checkinPdfExport.js'));
  const {
    buildGatePdfPreviewPlan,
    buildGatePdfPagePlan,
    chooseGatePdfBarText,
    selectGatePdfPreviewGroups,
  } = require(path.join(tempDir, 'gatePdfExport.js'));
  const {
    deleteCheckInCounterFromSettings,
    renameCheckInCounterLabelInSettings,
    resolveSettingsAfterSave,
    toggleCheckInCounterGroupMembership,
    toggleCheckInCounterLockMembership,
    toggleGateLockMembership,
  } = require(path.join(tempDir, 'settingsPageActions.js'));

  const plannedWriteChunks = chunkFirestoreWrites(Array.from({ length: 501 }, (_, index) => index));
  assert(FIRESTORE_WRITE_BATCH_SIZE <= 200, `Firestore browser writes should use conservative batches, got ${FIRESTORE_WRITE_BATCH_SIZE}`);
  assert(
    JSON.stringify(plannedWriteChunks.map((chunk) => chunk.length)) === JSON.stringify([200, 200, 101]),
    `Firestore write chunks should be capped at 200, got ${JSON.stringify(plannedWriteChunks.map((chunk) => chunk.length))}`
  );

  const s26Range = getSeasonDateRange('S26');
  assert(
    s26Range.start === '2026-03-29' && s26Range.end === '2026-10-24',
    `S26 should follow IATA summer boundaries, got ${JSON.stringify(s26Range)}`
  );
  assert(getIataSeasonForOperationalDate('2026-03-29').code === 'S26', '2026-03-29 should be S26');
  assert(getIataSeasonForOperationalDate('2026-10-24').code === 'S26', '2026-10-24 should be S26');
  assert(getIataSeasonForOperationalDate('2026-10-25').code === 'W26', '2026-10-25 should be W26');
  assert(getIataSeasonForOperationalDate('2027-03-27').code === 'W26', '2027-03-27 should be W26');
  assert(getIataSeasonForOperationalDate('2027-03-28').code === 'S27', '2027-03-28 should be S27');
  assert(getOperationalDate('2026-04-02', '04:59') === '2026-04-01', '04:59 should belong to the previous operational day');
  assert(getOperationalDate('2026-04-02', '05:00') === '2026-04-02', '05:00 should start the same operational day');
  const earlyMorningMeta = buildOperationalFlightMetadata({
    scheduledDate: '2026-10-25',
    scheduledTime: '04:30',
    type: 'D',
    airline: 'VN',
    flightNumber: 'VN123',
    route: 'HAN',
  });
  assert(
    earlyMorningMeta.operationalDate === '2026-10-24' &&
      earlyMorningMeta.iataSeasonCode === 'S26' &&
      earlyMorningMeta.flightSeriesId === buildFlightSeriesId({ type: 'D', airline: 'VN', flightNumber: 'VN123', route: 'HAN' }),
    `operational metadata should use 05:00 day and stable series id, got ${JSON.stringify(earlyMorningMeta)}`
  );
  const continuousRecords = flattenRowsToFlightRecords([
    baseRow({
      rowIndex: 3001,
      effective: '25-Oct-26',
      discontinue: '25-Oct-26',
      daysOfWeek: [false, false, false, false, false, false, true],
      depFlight: '123',
      std: '04:30',
      depRoute: 'HAN',
    }),
    baseRow({
      rowIndex: 3002,
      effective: '29-Mar-26',
      discontinue: '29-Mar-26',
      daysOfWeek: [false, false, false, false, false, false, true],
      depFlight: '123',
      std: '09:00',
      depRoute: 'HAN',
    }),
  ]);
  const earlyMorningRecord = continuousRecords.find((record) => record.rawFlightNumber === '123' && record.scheduledDate === '2026-10-25');
  const springRecord = continuousRecords.find((record) => record.rawFlightNumber === '123' && record.scheduledDate === '2026-03-29');
  assert(
    earlyMorningRecord?.date === '2026-10-25' &&
      earlyMorningRecord.operationalDate === '2026-10-24' &&
      earlyMorningRecord.scheduledDate === '2026-10-25' &&
      earlyMorningRecord.iataSeasonCode === 'S26',
    `flattened records should store scheduled and operational dates separately, got ${JSON.stringify(earlyMorningRecord)}`
  );
  assert(
    earlyMorningRecord?.flightSeriesId &&
      earlyMorningRecord.flightSeriesId === springRecord?.flightSeriesId,
    `same flight direction and route should share series id across seasons, got ${JSON.stringify(continuousRecords.map((record) => ({ id: record.id, series: record.flightSeriesId })))}`
  );

  function dailyRecord(overrides) {
    return {
      id: overrides.id,
      linkId: overrides.id,
      type: overrides.type,
      airline: overrides.airline ?? 'VN',
      flightNumber: overrides.flightNumber,
      rawFlightNumber: overrides.rawFlightNumber,
      requestStatusCode: null,
      route: overrides.route,
      schedule: overrides.schedule,
      scheduledDate: overrides.scheduledDate ?? overrides.date,
      scheduledTime: overrides.schedule,
      operationalDate: overrides.date,
      iataSeasonCode: getIataSeasonForOperationalDate(overrides.date).code,
      flightSeriesId: buildFlightSeriesId({
        type: overrides.type,
        airline: overrides.airline ?? 'VN',
        flightNumber: overrides.flightNumber,
        route: overrides.route,
      }),
      aircraft: '321',
      category: 'J',
      flightType: 'PAX',
      codeShares: null,
      intDomInd: null,
      pax: null,
      gate: null,
      stand: null,
      counter: null,
      carousel: null,
      mct: null,
      fb: null,
      lb: null,
      bhs: null,
      ghs: null,
      date: overrides.date,
      dayOfWeek: new Date(`${overrides.date}T00:00:00Z`).getUTCDay(),
      action: null,
      sourceRowIndex: 1,
      sourceKind: 'imported',
      sourceSide: overrides.type === 'A' ? 'ARR' : 'DEP',
      status: 'active',
      ...overrides,
    };
  }

  function dailyImportSheetRow(length, entries) {
    const row = Array.from({ length }, () => '');
    for (const [index, value] of entries) row[index] = value;
    return row;
  }

  assert(
    JSON.stringify(DAILY_SCHEDULE_EXPORT_HEADERS) === JSON.stringify([
      'Type',
      'Flight',
      'Config',
      'STA/STD',
      'Routes',
      'TTL Pax',
      'Load Factor',
      'Airlines',
      'Ops Date',
      'Country',
      'A/C Type',
      'Stand',
      'Carousel',
      'Gate',
      'Counters',
      'MCAT',
      'FB',
      'LB',
      'GHS',
    ]),
    `Daily export headers must match Book1.xlsx exactly, got ${JSON.stringify(DAILY_SCHEDULE_EXPORT_HEADERS)}`
  );
  const dailyExportWorkbook = buildDailyScheduleSummaryWorkbook({
    rows: [
      {
        id: 'visible-pair',
        pairKey: 'visible-pair',
        dateTime: '2026-06-10T09:30',
        arr: dailyRecord({
          id: 'daily-export-arr',
          type: 'A',
          airline: 'VJ',
          flightNumber: 'VJ989',
          rawFlightNumber: '989',
          route: 'PUS',
          schedule: '09:30',
          date: '2026-06-10',
          pax: 165,
          aircraft: '32N',
          stand: 18,
          carousel: 2,
          mct: '2026-06-10T10:05',
          fb: '09:48',
          lb: '10:12',
          ghs: 'SAGS',
        }),
        dep: dailyRecord({
          id: 'daily-export-dep',
          type: 'D',
          airline: 'VJ',
          flightNumber: 'VJ990',
          rawFlightNumber: '990',
          route: 'PUS',
          schedule: '11:20',
          date: '2026-06-10',
          pax: 172,
          aircraft: '32N',
          stand: 18,
          gate: 5,
          counter: '1,2,3,4',
          ghs: 'SAGS',
        }),
      },
      {
        id: 'deleted-row',
        pairKey: 'deleted-row',
        dateTime: '2026-06-10T12:00',
        arr: dailyRecord({
          id: 'daily-export-deleted',
          type: 'A',
          flightNumber: 'VN123',
          rawFlightNumber: '123',
          route: 'HAN',
          schedule: '12:00',
          date: '2026-06-10',
          action: 'deleted',
          status: 'deleted',
        }),
      },
    ],
    routeCountries: [{ route: 'PUS', country: 'Korea' }],
  });
  const dailyExportSheet = dailyExportWorkbook.Sheets.Summary;
  const dailyExportTable = XLSX.utils.sheet_to_json(dailyExportSheet, { header: 1, defval: '' });
  assert(
    dailyExportWorkbook.SheetNames.length === 1 && dailyExportWorkbook.SheetNames[0] === 'Summary',
    `Daily export workbook must contain only a Summary sheet, got ${JSON.stringify(dailyExportWorkbook.SheetNames)}`
  );
  assert(
    JSON.stringify(dailyExportTable[0]) === JSON.stringify(DAILY_SCHEDULE_EXPORT_HEADERS),
    `Daily export header row should match Book1.xlsx, got ${JSON.stringify(dailyExportTable[0])}`
  );
  assert(
    dailyExportTable.length === 3 &&
      dailyExportTable[1][0] === 'A' &&
      dailyExportTable[1][1] === 'VJ989' &&
      dailyExportTable[1][2] === '' &&
      dailyExportTable[1][6] === 0 &&
      dailyExportTable[1][9] === 'Korea' &&
      dailyExportTable[1][11] === 18 &&
      dailyExportTable[1][12] === 2 &&
      dailyExportTable[2][0] === 'D' &&
      dailyExportTable[2][1] === 'VJ990' &&
      dailyExportTable[2][13] === 5 &&
      dailyExportTable[2][14] === '1,2,3,4' &&
      !JSON.stringify(dailyExportTable).includes('VN123'),
    `Daily export must flatten visible active legs and exclude deleted legs, got ${JSON.stringify(dailyExportTable)}`
  );
  assert(
    dailyExportSheet.D2.z === 'm/d/yy h:mm' &&
      dailyExportSheet.I2.z === 'm/d/yy' &&
      dailyExportSheet.P2.z === 'm/d/yy h:mm' &&
      dailyExportSheet.D2.t === 'n' &&
      dailyExportSheet.I2.t === 'n' &&
      dailyExportSheet.P2.t === 'n',
    `Daily export date cells must use Excel date formats, got ${JSON.stringify({ d: dailyExportSheet.D2, i: dailyExportSheet.I2, p: dailyExportSheet.P2 })}`
  );
  assert(
    Array.isArray(dailyExportSheet['!cols']) &&
      dailyExportSheet['!cols'].length === DAILY_SCHEDULE_EXPORT_HEADERS.length &&
      dailyExportSheet['!cols'][3].wch >= 14,
    `Daily export should apply Book1.xlsx-like column widths, got ${JSON.stringify(dailyExportSheet['!cols'])}`
  );
  assert(
    buildDailyScheduleExportFileName('S26', '2026-06-10T05:00', '2026-06-11T05:00').startsWith('Daily_Schedule_S26_20260610_20260611_') &&
      sanitizeExportFileName('..\\bad:name?.xlsx') === '.._bad_name_.xlsx',
    'Daily export filename and shared export filename sanitization must be deterministic and Windows-safe'
  );

  const oldDailyHeader = dailyImportSheetRow(43, [
    [1, 'AIRCRAFT_SERIES'],
    [3, 'ARR-AIRLINE_FLIGHT_SUFFIX'],
    [6, 'ARR-Scheduled'],
    [7, 'ARR-FlightType'],
    [8, 'ARR-ORIG_DEST_AIRPORT_CODE'],
    [9, 'ARR-FlightCategory'],
    [15, 'ARR-BagFirst'],
    [16, 'ARR-BagLast'],
    [17, 'ARR-PAX_TOTAL'],
    [18, 'ARRReclaimBelt'],
    [20, 'ARRStand'],
    [21, 'ARR-CODESHARES'],
    [23, 'DEP-AIRLINE_FLIGHT_SUFFIX'],
    [26, 'DEP-Scheduled'],
    [27, 'DEP-FlightType'],
    [28, 'DEP-ORIG_DEST_AIRPORT_CODE'],
    [29, 'DEP-FlightCategory'],
    [36, 'DEP-PAX_TOTAL'],
    [37, 'DEPGate'],
    [38, 'CheckInDesk'],
    [40, 'DEPStand'],
    [41, 'DEP-CODESHARES'],
  ]);
  const oldDailyRows = parseDailyImportWorksheet(XLSX.utils.aoa_to_sheet([
    oldDailyHeader,
    dailyImportSheetRow(43, [
      [1, '321'],
      [3, 'VN100'],
      [6, '2026-04-01 06:00'],
      [8, 'HAN'],
      [17, '155'],
      [23, 'VN101'],
      [26, '2026-04-01 08:00'],
      [28, 'SGN'],
      [36, '160'],
      [37, '5'],
      [38, '1,2'],
    ]),
  ]));
  assert(
    oldDailyRows.length === 1 &&
      oldDailyRows[0]['ARR-AIRLINE_FLIGHT_SUFFIX'] === 'VN100' &&
      oldDailyRows[0].AIRCRAFT_SERIES === '321' &&
      oldDailyRows[0].DEPGate === '5',
    `old OperationalTurns worksheet headers should still normalize to existing daily import keys, got ${JSON.stringify(oldDailyRows)}`
  );

  const newDailyHeader = dailyImportSheetRow(44, [
    [1, 'Aircraft'],
    [2, 'A/C Type'],
    [4, 'Arr Flight'],
    [7, 'STA'],
    [8, 'Type'],
    [9, 'From'],
    [10, 'Qual'],
    [16, 'Chocks on'],
    [17, 'Est Delivery'],
    [18, 'Ttl ARR PAX'],
    [19, 'Carousel'],
    [21, 'Arr Stand'],
    [22, 'Arr Code Shar'],
    [24, 'Dep Flight'],
    [27, 'STD'],
    [28, 'Type'],
    [29, 'To'],
    [30, 'Qual'],
    [37, 'DEP PAX'],
    [38, 'Gate'],
    [39, 'Counters'],
    [41, 'Dep Stand'],
    [42, 'Dep Code Sha'],
  ]);
  const newDailyRows = parseDailyImportWorksheet(XLSX.utils.aoa_to_sheet([
    newDailyHeader,
    dailyImportSheetRow(44, [
      [2, '32N'],
      [4, 'RF531'],
      [7, '01/04/2026 23:55'],
      [8, 'PAX'],
      [9, 'CJJ'],
      [10, 'J'],
      [16, '01/04/2026 23:46'],
      [17, '2026-04-02 00:13:00'],
      [18, '159'],
      [19, '2'],
      [21, '18'],
      [24, 'RF532'],
      [27, '02/04/2026 00:55'],
      [28, 'PAX'],
      [29, 'CJJ'],
      [30, 'J'],
      [37, '174'],
      [38, 'G5'],
      [39, 'C1, C2, C3, C4'],
      [41, '18'],
    ]),
  ]));
  assert(
    newDailyRows.length === 1 &&
      !('__EMPTY' in newDailyRows[0]) &&
      newDailyRows[0]['ARR-AIRLINE_FLIGHT_SUFFIX'] === 'RF531' &&
      newDailyRows[0]['ARR-Scheduled'] === '01/04/2026 23:55' &&
      newDailyRows[0]['DEP-AIRLINE_FLIGHT_SUFFIX'] === 'RF532' &&
      newDailyRows[0].DEPGate === 'G5' &&
      newDailyRows[0].CheckInDesk === 'C1, C2, C3, C4',
    `new OperationalTurns worksheet should ignore blank column A while preserving row 2 as data, got ${JSON.stringify(newDailyRows)}`
  );
  const newDailyImportUpdate = buildDailyScheduleImportUpdate({
    records: [],
    modifications: new Map(),
    importRows: newDailyRows,
    timestamp: 1770000000001,
    historyId: 'daily-new-operationalturns-format',
  });
  const newDailyArrRecord = newDailyImportUpdate.records.find((record) => record.type === 'A');
  const newDailyDepRecord = newDailyImportUpdate.records.find((record) => record.type === 'D');
  assert(
    newDailyArrRecord?.scheduledDate === '2026-04-01' &&
      newDailyArrRecord.operationalDate === '2026-04-01' &&
      newDailyArrRecord.iataSeasonCode === 'S26' &&
      newDailyArrRecord.flightSeriesId &&
      newDailyDepRecord?.scheduledDate === '2026-04-02' &&
      newDailyDepRecord.operationalDate === '2026-04-01' &&
      newDailyDepRecord.gate === 5 &&
      newDailyDepRecord.counter === '1,2,3,4',
    `new OperationalTurns import should normalize resources and preserve continuous metadata, got ${JSON.stringify({ arr: newDailyArrRecord, dep: newDailyDepRecord })}`
  );
  const splitSeasonDailyBatches = partitionDailyImportRowsByIataSeason([
    {
      AIRCRAFT_SERIES: '320',
      'ARR-AIRLINE_FLIGHT_SUFFIX': 'VN250',
      'ARR-Scheduled': '2026-03-28 23:30:00',
      'ARR-ORIG_DEST_AIRPORT_CODE': 'HAN',
      'DEP-AIRLINE_FLIGHT_SUFFIX': 'VN260',
      'DEP-Scheduled': '2026-10-25 05:30:00',
      'DEP-ORIG_DEST_AIRPORT_CODE': 'SGN',
      DEPGate: 'G4',
      CheckInDesk: 'C1,C2',
    },
  ]);
  const w25Batch = splitSeasonDailyBatches.find((batch) => batch.seasonCode === 'W25');
  const w26Batch = splitSeasonDailyBatches.find((batch) => batch.seasonCode === 'W26');
  const w25Update = buildDailyScheduleImportUpdate({
    records: [],
    modifications: new Map(),
    importRows: w25Batch?.rows ?? [],
    timestamp: 1770000000002,
    historyId: 'daily-import-split-w25',
  });
  const w26Update = buildDailyScheduleImportUpdate({
    records: [],
    modifications: new Map(),
    importRows: w26Batch?.rows ?? [],
    timestamp: 1770000000003,
    historyId: 'daily-import-split-w26',
  });
  assert(
    splitSeasonDailyBatches.length === 2 &&
      w25Batch?.legCount === 1 &&
      w26Batch?.legCount === 1 &&
      w25Update.records.length === 1 &&
      w25Update.records[0].iataSeasonCode === 'W25' &&
      w25Update.records[0].type === 'A' &&
      w26Update.records.length === 1 &&
      w26Update.records[0].iataSeasonCode === 'W26' &&
      w26Update.records[0].type === 'D',
    `Daily import rows crossing IATA seasons must split by leg so each season receives only its own records, got ${JSON.stringify({
      batches: splitSeasonDailyBatches,
      w25Records: w25Update.records,
      w26Records: w26Update.records,
    })}`
  );

  const smartOverwrite = buildDailyScheduleImportUpdate({
    records: [
      dailyRecord({ id: 'match-arr', type: 'A', flightNumber: 'VN100', rawFlightNumber: '100', route: 'HAN', schedule: '06:00', date: '2026-04-01' }),
      dailyRecord({ id: 'missing-dep', type: 'D', flightNumber: 'VN200', rawFlightNumber: '200', route: 'SGN', schedule: '07:00', date: '2026-04-01' }),
      dailyRecord({ id: 'outside-dep', type: 'D', flightNumber: 'VN300', rawFlightNumber: '300', route: 'CXR', schedule: '07:00', date: '2026-04-03' }),
    ],
    modifications: new Map(),
    importRows: [
      {
        'ARR-AIRLINE_FLIGHT_SUFFIX': 'VN100',
        'ARR-Scheduled': '2026-04-01 06:00',
        'ARR-ORIG_DEST_AIRPORT_CODE': 'HAN',
        'ARR-PAX': 155,
        AIRCRAFT_SERIES: '321',
      },
      {
        'DEP-AIRLINE_FLIGHT_SUFFIX': 'VN400',
        'DEP-Scheduled': '2026-04-01 08:00',
        'DEP-ORIG_DEST_AIRPORT_CODE': 'DLI',
        AIRCRAFT_SERIES: '321',
      },
    ],
    timestamp: 1770000000000,
    historyId: 'daily-smart-overwrite',
  });
  const deletedRecord = smartOverwrite.records.find((record) => record.id === 'missing-dep');
  const outsideRecord = smartOverwrite.records.find((record) => record.id === 'outside-dep');
  assert(
    smartOverwrite.stats.updated === 1 &&
      smartOverwrite.stats.inserted === 1 &&
      smartOverwrite.stats.deleted === 1 &&
      smartOverwrite.modifications.get('match-arr')?.pax === 155,
    `Daily Smart Overwrite should update matches, insert new rows, and count deletes, got ${JSON.stringify({ stats: smartOverwrite.stats, mod: smartOverwrite.modifications.get('match-arr') })}`
  );
  assert(deletedRecord?.status === 'deleted' && deletedRecord.action === 'deleted', `missing in-range flight should be marked deleted, got ${JSON.stringify(deletedRecord)}`);
  assert(outsideRecord?.status === 'active', `outside-range flight should remain active, got ${JSON.stringify(outsideRecord)}`);

  const sourceProgress = buildImportBatchProgress('Saving source rows', 100, 200, 35, 55);
  assert(sourceProgress.percent === 45, `source row progress should interpolate to 45%, got ${JSON.stringify(sourceProgress)}`);
  assert(sourceProgress.detail === '100 / 200', `source row progress should include write counts, got ${JSON.stringify(sourceProgress)}`);
  const cappedProgress = buildImportProgress('Done', 140);
  assert(cappedProgress.percent === 100, `import progress should cap percent at 100, got ${JSON.stringify(cappedProgress)}`);
  const lowLoadProgress = buildLoadProgress('Checking local workspace', -12, undefined, { indeterminate: true });
  assert(
    lowLoadProgress.percent === 0 && lowLoadProgress.indeterminate === true,
    `load progress should cap below 0 and preserve indeterminate flag, got ${JSON.stringify(lowLoadProgress)}`
  );
  const highLoadProgress = buildLoadProgress('Rendering', 150, 'Preparing view');
  assert(
    highLoadProgress.percent === 100 && highLoadProgress.detail === 'Preparing view',
    `load progress should cap above 100 and preserve detail, got ${JSON.stringify(highLoadProgress)}`
  );
  const loadBatchProgress = buildLoadBatchProgress('Hydrating schedule records', 50, 200, 20, 80);
  assert(
    loadBatchProgress.percent === 35 && loadBatchProgress.detail === '50 / 200',
    `load batch progress should interpolate and include counts, got ${JSON.stringify(loadBatchProgress)}`
  );

  const emptyOperationalSettings = hydrateOperationalSettings(null);
  assert(
    Array.isArray(emptyOperationalSettings.aircraftGroups) &&
      emptyOperationalSettings.aircraftGroups.length === 0 &&
      Array.isArray(emptyOperationalSettings.counterAllocationRules) &&
      emptyOperationalSettings.counterAllocationRules.length === 0 &&
      Array.isArray(emptyOperationalSettings.airlineColors) &&
      emptyOperationalSettings.airlineColors.some((item) => item.airlineCode === 'VJ' && item.color === '#ED1B24') &&
      emptyOperationalSettings.airlineColors.some((item) => item.airlineCode === 'VN' && item.color === '#004B87') &&
      emptyOperationalSettings.airlineColors.some((item) => item.airlineCode === 'QV' && item.color === '#003C71') &&
      Array.isArray(emptyOperationalSettings.checkInCounters) &&
      emptyOperationalSettings.checkInCounters.length === 0 &&
      Array.isArray(emptyOperationalSettings.checkInCounterGroups) &&
      emptyOperationalSettings.checkInCounterGroups.length === 0 &&
      Array.isArray(emptyOperationalSettings.checkInCounterLocks) &&
      emptyOperationalSettings.checkInCounterLocks.length === 0 &&
      Array.isArray(emptyOperationalSettings.gateLocks) &&
      emptyOperationalSettings.gateLocks.length === 0 &&
      Array.isArray(emptyOperationalSettings.routeCountries) &&
      emptyOperationalSettings.routeCountries.some((item) => item.route === 'ICN' && item.country === 'Korea') &&
      emptyOperationalSettings.routeCountries.some((item) => item.route === 'RMQ' && item.country === 'Taiwan'),
    `missing operational settings should hydrate empty operational arrays plus default airline colors and route-country map, got ${JSON.stringify(emptyOperationalSettings)}`
  );
  assert(
    JSON.stringify(emptyOperationalSettings.gateResources.map((gate) => gate.label)) === JSON.stringify(['1', '2', '3', '4', '5', '6', '7', '8', '9', '10']) &&
      JSON.stringify(emptyOperationalSettings.gateGroups.map((group) => ({ name: group.name, gateIds: group.gateIds }))) === JSON.stringify([
        { name: 'Gate 1-3', gateIds: ['GATE_1', 'GATE_2', 'GATE_3'] },
        { name: 'Gate PBB', gateIds: ['GATE_4', 'GATE_5', 'GATE_6', 'GATE_7'] },
        { name: 'Gate 8-10', gateIds: ['GATE_8', 'GATE_9', 'GATE_10'] },
      ]) &&
      JSON.stringify(emptyOperationalSettings.standGateMappings.map((mapping) => [mapping.stand, mapping.gate])) === JSON.stringify([[14, 7], [16, 6], [18, 5], [20, 4]]),
    `missing operational settings should hydrate default gate inventory, groups, and stand mappings, got ${JSON.stringify(emptyOperationalSettings)}`
  );
  const gateRecord = {
    id: 'dep-1',
    linkId: 'pair-1',
    type: 'D',
    airline: 'VN',
    flightNumber: 'VN318',
    rawFlightNumber: '318',
    requestStatusCode: null,
    route: 'HAN',
    schedule: '10:30',
    aircraft: '321',
    category: 'J',
    flightType: 'PAX',
    codeShares: null,
    intDomInd: null,
    pax: 180,
    gate: 7,
    stand: 14,
    counter: null,
    carousel: null,
    mct: null,
    fb: null,
    lb: null,
    bhs: null,
    ghs: null,
    date: '2026-05-09',
    dayOfWeek: 6,
    action: null,
    sourceRowIndex: 1,
    sourceKind: 'imported',
    sourceSide: 'DEP',
    status: 'active',
  };
  const auditedGateRecord = { ...gateRecord, gate: null, schedule: '10:00' };
  const auditActionEntry = buildFlightActionAuditEntry({
    sessionId: 'audit-session-1',
    timestamp: 1778292000000,
    seasonId: 'season-s26',
    seasonCode: 'S26',
    module: 'gate',
    category: 'user-action',
    operation: 'Assigned flight VN318 to Gate 6',
    beforeRecords: [auditedGateRecord],
    afterRecords: [{ ...auditedGateRecord, gate: 6, schedule: '10:30' }],
    targetRecordIds: ['dep-1'],
  });
  assert(
    auditActionEntry.operation === 'Assigned flight VN318 to Gate 6' &&
      auditActionEntry.targetFlightLabels.includes('VN318') &&
      auditActionEntry.targetFlightIds.includes('dep-1') &&
      auditActionEntry.deltas.some((delta) => delta.field === 'gate' && delta.before === null && delta.after === 6) &&
      auditActionEntry.deltas.some((delta) => delta.field === 'schedule' && delta.before === '10:00' && delta.after === '10:30'),
    `flight action audit entries must preserve exact operation text, targets, and field-level deltas, got ${JSON.stringify(auditActionEntry)}`
  );
  const syncAuditWorkspace = createLocalWorkspace({
    season: { id: 'season-s26', seasonCode: 'S26', startDate: '2026-03-29', endDate: '2026-10-24', dataVersion: 1 },
    rows: [],
    records: [
      { ...gateRecord, id: 'dep-1', gate: 6 },
      { ...gateRecord, id: 'dep-2', flightNumber: 'VN319', rawFlightNumber: '319', date: '2026-05-10', gate: 5 },
      { ...gateRecord, id: 'dep-3', flightNumber: 'VN320', rawFlightNumber: '320', status: 'deleted', date: '2026-05-11' },
    ],
    modifications: new Map([
      ['dep-1', { legId: 'dep-1', gate: 6, updatedAt: 1778292000000 }],
    ]),
    modHistory: [],
    baseRecords: [
      { ...gateRecord, id: 'dep-1', gate: null },
      { ...gateRecord, id: 'dep-3', flightNumber: 'VN320', rawFlightNumber: '320', date: '2026-05-11' },
    ],
    baseModificationEntries: [],
    pendingOps: [
      { type: 'flightRecord', id: 'dep-1', record: { ...gateRecord, id: 'dep-1', gate: 6 } },
      { type: 'flightRecord', id: 'dep-2', record: { ...gateRecord, id: 'dep-2', flightNumber: 'VN319', rawFlightNumber: '319', date: '2026-05-10', gate: 5 } },
      { type: 'flightRecord', id: 'dep-3', record: { ...gateRecord, id: 'dep-3', flightNumber: 'VN320', rawFlightNumber: '320', status: 'deleted', date: '2026-05-11' } },
      { type: 'modification', id: 'dep-1', mod: { legId: 'dep-1', gate: 6, updatedAt: 1778292000000 } },
    ],
  });
  const syncAuditDelta = buildSyncAuditDelta(syncAuditWorkspace);
  assert(
    syncAuditDelta.records === 3 &&
      syncAuditDelta.modifications === 1 &&
      syncAuditDelta.flightsAdded === 1 &&
      syncAuditDelta.flightsRemoved === 1 &&
      syncAuditDelta.flightsModified === 1 &&
      syncAuditDelta.affectedPeriod.from === '2026-05-09' &&
      syncAuditDelta.affectedPeriod.to === '2026-05-11' &&
      syncAuditDelta.exactChanges.length >= 3,
    `sync audit deltas must include pending counts, added/removed/modified flight counts, affected period, and exact changes, got ${JSON.stringify(syncAuditDelta)}`
  );
  const oversizedAuditDeltas = Array.from({ length: 12 }, (_, index) => ({
    targetType: 'flight',
    targetId: `flight-${index}`,
    targetLabel: `VN${String(index).padStart(3, '0')}`,
    field: 'payload',
    before: null,
    after: 'x'.repeat(1200),
  }));
  const auditDeltaChunks = splitAuditDeltaChunks(oversizedAuditDeltas, 2500);
  assert(
    FIRESTORE_AUDIT_DELTA_SAFE_BYTES < 1048576 &&
      auditDeltaChunks.length > 1 &&
      auditDeltaChunks.every((chunk) => estimateAuditPayloadBytes(chunk) <= 2500) &&
      auditDeltaChunks.flatMap((chunk) => chunk.items).length === oversizedAuditDeltas.length,
    `audit delta chunks must stay below the Firestore-safe byte threshold without dropping items, got ${JSON.stringify(auditDeltaChunks.map((chunk) => estimateAuditPayloadBytes(chunk)))}`
  );
  const gateWindow = buildDefaultGateWindow(gateRecord);
  assert(
    gateWindow.start === '2026-05-09T08:00' && gateWindow.end === '2026-05-09T10:30',
    `gate allocation default window should be STD - 150 minutes to STD, got ${JSON.stringify(gateWindow)}`
  );
  const gateView = buildGateAllocationView({
    records: [gateRecord],
    modifications: new Map(),
    settings: emptyOperationalSettings,
    from: '2026-05-09T05:00',
    to: '2026-05-10T05:00',
    groupByGateGroup: true,
    pixelsPerMinute: 1,
  });
  assert(
    gateView.resourceBars.length === 1 &&
      gateView.resourceBars[0].gate === 7 &&
      gateView.resourceBars[0].flightNumber === 'VN318' &&
      !('requiredCounters' in gateView.resourceBars[0]) &&
      gateView.resourceRows.map((row) => row.label).slice(0, 10).join(',') === '1,2,3,4,5,6,7,8,9,10' &&
      gateView.resourceSections.some((section) => section.name === 'Gate PBB'),
    `gate allocation view should render one bar per departure gate with configured gate groups, got ${JSON.stringify(gateView)}`
  );
  const gateUnallocatedProjection = buildGateRecordProjection({
    recordId: gateRecord.id,
    record: { ...gateRecord, gate: null },
    from: '2026-05-09T05:00',
    to: '2026-05-10T05:00',
    roster: gateView.roster,
    pixelsPerMinute: 1,
  });
  const patchedGateView = mergeGateAllocationViewPatch(gateView, gateUnallocatedProjection);
  assert(
    patchedGateView.resourceRows === gateView.resourceRows &&
      patchedGateView.resourceSections === gateView.resourceSections &&
      patchedGateView.resourceBars.length === 0 &&
      patchedGateView.unallocated.length === 1 &&
      patchedGateView.unallocated[0].record.id === gateRecord.id,
    `gate allocation optimistic patch should update only changed flight bars/pool without rebuilding resource rows, got ${JSON.stringify(patchedGateView)}`
  );
  assert(formatGateFlightLabel({ airline: 'vn', flightNumber: 'VN318', rawFlightNumber: '318' }) === 'VN318', 'gate bar labels should be carrier plus 3-digit flight number');
  assert(resolveGateForStand(18, emptyOperationalSettings) === 5, 'stand 18 should map to gate 5 by default');
  const standMods = buildDailyStandGateModifications({
    row: { arr: { ...gateRecord, id: 'arr-1', type: 'A', gate: null, sourceSide: 'ARR' }, dep: { ...gateRecord, gate: null, stand: null } },
    record: { ...gateRecord, id: 'arr-1', type: 'A', gate: null, sourceSide: 'ARR' },
    field: 'arrStand',
    value: '16',
    settings: emptyOperationalSettings,
    previousModifications: new Map(),
  });
  assert(
    standMods.length === 2 &&
      standMods[0].legId === 'arr-1' &&
      standMods[0].stand === 16 &&
      standMods[1].legId === 'dep-1' &&
      standMods[1].gate === 6,
    `editing Daily arrStand should also populate the linked departure gate from mapping, got ${JSON.stringify(standMods)}`
  );
  assert(
    buildGateTimelineTicks('2026-05-09T08:00', '2026-05-09T10:30').major.some((tick) => tick.label === '10:00'),
    'gate timeline should use the same hourly timeline tick model as allocation views'
  );
  const packedGatePool = buildGatePackedRows([
    { record: gateRecord, window: gateWindow },
    { record: { ...gateRecord, id: 'dep-2', flightNumber: 'VN319', rawFlightNumber: '319', schedule: '10:45' }, window: buildDefaultGateWindow({ ...gateRecord, schedule: '10:45' }) },
  ], '2026-05-09T05:00', '2026-05-09T12:00');
  assert(
    packedGatePool.laneCount === 2 &&
      packedGatePool.items.every((item) => item.leftPercent >= 0 && item.widthPercent > 0),
    `gate unallocated pool should pack overlapping flight bars into timeline lanes, got ${JSON.stringify(packedGatePool)}`
  );
  const gatePdfView = buildGateAllocationView({
    records: [
      { ...gateRecord, id: 'GATE-PDF-PBB', flightNumber: 'VN318', rawFlightNumber: '318', gate: 7 },
      { ...gateRecord, id: 'GATE-PDF-LOW', flightNumber: 'FD635', rawFlightNumber: '635', airline: 'FD', gate: 2, schedule: '12:00' },
    ],
    modifications: new Map(),
    settings: emptyOperationalSettings,
    from: '2026-05-09T05:00',
    to: '2026-05-10T05:00',
    groupByGateGroup: true,
    pixelsPerMinute: 1,
  });
  const gatePdfPagePlan = buildGatePdfPagePlan({
    view: gatePdfView,
    maxBodyHeightPx: 96,
  });
  assert(
    gatePdfPagePlan.length === 3 &&
      gatePdfPagePlan.map((page) => page.sectionName).join('|') === 'Gate 1-3|Gate PBB|Gate 8-10' &&
      gatePdfPagePlan.every((page) => page.pageInGroup === 1 && page.groupPageCount === 1),
    `Gate PDF page plan should keep each gate group intact on one A4 landscape page, got ${JSON.stringify(gatePdfPagePlan)}`
  );
  const gatePdfPreview = buildGatePdfPreviewPlan({
    records: [
      { ...gateRecord, id: 'GATE-PDF-PBB', flightNumber: 'VN318', rawFlightNumber: '318', gate: 7 },
      { ...gateRecord, id: 'GATE-PDF-LOW', flightNumber: 'FD635', rawFlightNumber: '635', airline: 'FD', gate: 2, schedule: '12:00' },
    ],
    modifications: new Map(),
    settings: emptyOperationalSettings,
    range: { from: '2026-05-09T05:00', to: '2026-05-10T05:00' },
    selectedGroupIds: ['GATE_GROUP_PBB'],
  });
  const gatePdfRefilteredPreview = selectGatePdfPreviewGroups(gatePdfPreview, ['GATE_GROUP_1_3']);
  assert(
    gatePdfPreview.availableGroups.map((group) => group.id).join('|') === 'GATE_GROUP_1_3|GATE_GROUP_PBB|GATE_GROUP_8_10' &&
      gatePdfPreview.selectedGroupIds.join('|') === 'GATE_GROUP_PBB' &&
      gatePdfPreview.pages.length === 1 &&
      gatePdfPreview.pages[0].sectionName === 'Gate PBB' &&
      gatePdfRefilteredPreview.view === gatePdfPreview.view &&
      gatePdfRefilteredPreview.pages.length === 1 &&
      gatePdfRefilteredPreview.pages[0].sectionName === 'Gate 1-3',
    `Gate PDF preview should expose selectable gate groups and reuse the grouped export view, got ${JSON.stringify(gatePdfPreview.pages)}`
  );
  assert(
    JSON.stringify([
      chooseGatePdfBarText({ widthPx: 70, flightNumber: 'VN318' }),
      chooseGatePdfBarText({ widthPx: 12, flightNumber: 'VN318' }),
    ]) === JSON.stringify(['VN318', '']),
    'Gate PDF bar text should show only the carrier plus 3-digit flight number when the bar is wide enough'
  );
  const normalizedSettings = validateOperationalSettings({
    airlineColors: [
      { airlineCode: ' vj ', color: 'ed1b24' },
      { airlineCode: 'vn', color: '#004b87' },
    ],
    aircraftGroups: [
      { id: 'big', name: ' Big ', aircraftTypes: [' a321 ', 'B787', 'A321'], createdAt: 1, updatedAt: 2 },
    ],
    counterAllocationRules: [
      {
        id: 'rule-1',
        name: ' VJ Default ',
        enabled: true,
        priorityScore: 10,
        sortOrder: 2,
        createdAt: 3,
        updatedAt: 4,
        conditions: { aircraftTypes: [' a321 '], aircraftGroups: [], airlineCodes: [' vj '] },
        counterValue: 3,
      },
    ],
    routeCountries: [
      { route: ' icn ', country: ' South Korea ' },
      { route: 'bkk', country: 'Thailand' },
    ],
    updatedAt: 5,
  });
  assert(
    normalizedSettings.aircraftGroups[0].name === 'Big' &&
      JSON.stringify(normalizedSettings.aircraftGroups[0].aircraftTypes) === JSON.stringify(['A321', 'B787']) &&
      normalizedSettings.counterAllocationRules[0].name === 'VJ Default' &&
      normalizedSettings.counterAllocationRules[0].conditions.airlineCodes[0] === 'VJ' &&
      JSON.stringify(normalizedSettings.airlineColors) === JSON.stringify([
        { airlineCode: 'VJ', color: '#ED1B24' },
        { airlineCode: 'VN', color: '#004B87' },
      ]) &&
      JSON.stringify(normalizedSettings.routeCountries) === JSON.stringify([
        { route: 'ICN', country: 'South Korea' },
        { route: 'BKK', country: 'Thailand' },
      ]),
    `operational settings should trim and uppercase codes, got ${JSON.stringify(normalizedSettings)}`
  );
  let duplicateRouteCountryError = null;
  try {
    validateOperationalSettings({
      airlineColors: [],
      aircraftGroups: [],
      counterAllocationRules: [],
      routeCountries: [
        { route: 'ICN', country: 'Korea' },
        { route: ' icn ', country: 'South Korea' },
      ],
      updatedAt: 3,
    });
  } catch (err) {
    duplicateRouteCountryError = err;
  }
  assert(
    duplicateRouteCountryError?.message.includes('Duplicate route-country route ICN'),
    `duplicate route-country routes should be rejected, got ${duplicateRouteCountryError?.message}`
  );
  let duplicateAirlineColorError = null;
  try {
    validateOperationalSettings({
      airlineColors: [
        { airlineCode: 'VJ', color: '#ED1B24' },
        { airlineCode: 'vj', color: '#004B87' },
      ],
      aircraftGroups: [],
      counterAllocationRules: [],
      updatedAt: 3,
    });
  } catch (err) {
    duplicateAirlineColorError = err;
  }
  assert(
    duplicateAirlineColorError?.message.includes('Duplicate airline color code VJ'),
    `duplicate airline color codes should be rejected, got ${duplicateAirlineColorError?.message}`
  );
  let invalidAirlineColorError = null;
  try {
    validateOperationalSettings({
      airlineColors: [{ airlineCode: 'VJ', color: 'red' }],
      aircraftGroups: [],
      counterAllocationRules: [],
      updatedAt: 3,
    });
  } catch (err) {
    invalidAirlineColorError = err;
  }
  assert(
    invalidAirlineColorError?.message.includes('Airline color VJ must use #RRGGBB'),
    `invalid airline color hex values should be rejected, got ${invalidAirlineColorError?.message}`
  );
  let duplicateGroupNameError = null;
  try {
    validateOperationalSettings({
      aircraftGroups: [
        { id: 'big', name: 'Big', aircraftTypes: ['A321'], createdAt: 1, updatedAt: 1 },
        { id: 'big-2', name: ' big ', aircraftTypes: ['B787'], createdAt: 2, updatedAt: 2 },
      ],
      counterAllocationRules: [],
      updatedAt: 3,
    });
  } catch (err) {
    duplicateGroupNameError = err;
  }
  assert(
    duplicateGroupNameError?.message.includes('Group names must be unique'),
    `duplicate A/C group names should be rejected, got ${duplicateGroupNameError?.message}`
  );
  let duplicateAircraftError = null;
  try {
    validateOperationalSettings({
      aircraftGroups: [
        { id: 'big', name: 'Big', aircraftTypes: ['A321'], createdAt: 1, updatedAt: 1 },
        { id: 'small', name: 'Small', aircraftTypes: [' a321 '], createdAt: 2, updatedAt: 2 },
      ],
      counterAllocationRules: [],
      updatedAt: 3,
    });
  } catch (err) {
    duplicateAircraftError = err;
  }
  assert(
    duplicateAircraftError?.message.includes('may belong to only one A/C group'),
    `duplicate aircraft group membership should be rejected, got ${duplicateAircraftError?.message}`
  );
  let invalidCounterRuleError = null;
  try {
    validateOperationalSettings({
      aircraftGroups: [],
      counterAllocationRules: [
        {
          id: 'invalid',
          name: 'Invalid',
          enabled: true,
          priorityScore: 1,
          sortOrder: 1,
          createdAt: 1,
          updatedAt: 1,
          conditions: { aircraftTypes: [], aircraftGroups: [], airlineCodes: [] },
          counterValue: 0,
        },
      ],
      updatedAt: 1,
    });
  } catch (err) {
    invalidCounterRuleError = err;
  }
  assert(
    invalidCounterRuleError?.message.includes('at least one condition'),
    `invalid counter rules should be rejected before use, got ${invalidCounterRuleError?.message}`
  );
  let duplicateCounterLabelError = null;
  try {
    validateOperationalSettings({
      aircraftGroups: [],
      counterAllocationRules: [],
      checkInCounters: [
        { id: 'counter-1', label: 'A01', enabled: true, sortOrder: 1, createdAt: 1, updatedAt: 1 },
        { id: 'counter-2', label: ' a01 ', enabled: true, sortOrder: 2, createdAt: 2, updatedAt: 2 },
      ],
      checkInCounterGroups: [],
      checkInCounterLocks: [],
      updatedAt: 1,
    });
  } catch (err) {
    duplicateCounterLabelError = err;
  }
  assert(
    duplicateCounterLabelError?.message.includes('Counter labels must be unique'),
    `duplicate check-in counter labels should be rejected case-insensitively, got ${duplicateCounterLabelError?.message}`
  );
  let duplicateCounterGroupMembershipError = null;
  try {
    validateOperationalSettings({
      aircraftGroups: [],
      counterAllocationRules: [],
      checkInCounters: [
        { id: 'counter-1', label: 'A01', enabled: true, sortOrder: 1, createdAt: 1, updatedAt: 1 },
      ],
      checkInCounterGroups: [
        { id: 'group-1', name: 'Zone A', bhs: 'BHS1', counterIds: ['counter-1'], sortOrder: 1, createdAt: 1, updatedAt: 1 },
        { id: 'group-2', name: 'Zone B', bhs: 'BHS2', counterIds: [' counter-1 '], sortOrder: 2, createdAt: 2, updatedAt: 2 },
      ],
      checkInCounterLocks: [],
      updatedAt: 1,
    });
  } catch (err) {
    duplicateCounterGroupMembershipError = err;
  }
  assert(
    duplicateCounterGroupMembershipError?.message.includes('may belong to only one counter group'),
    `duplicate check-in counter group membership should be rejected, got ${duplicateCounterGroupMembershipError?.message}`
  );
  let invalidCounterLockWindowError = null;
  try {
    validateOperationalSettings({
      aircraftGroups: [],
      counterAllocationRules: [],
      checkInCounters: [
        { id: 'counter-1', label: 'A01', enabled: true, sortOrder: 1, createdAt: 1, updatedAt: 1 },
      ],
      checkInCounterGroups: [],
      checkInCounterLocks: [
        {
          id: 'lock-1',
          name: 'Maintenance',
          counterIds: ['counter-1'],
          start: '2026-05-08T08:00',
          end: '2026-05-08T08:00',
          reason: null,
          enabled: true,
          createdAt: 1,
          updatedAt: 1,
        },
      ],
      updatedAt: 1,
    });
  } catch (err) {
    invalidCounterLockWindowError = err;
  }
  assert(
    invalidCounterLockWindowError?.message.includes('lock start must be before end'),
    `enabled check-in counter locks should reject start >= end, got ${invalidCounterLockWindowError?.message}`
  );
  let invalidGateLockWindowError = null;
  try {
    validateOperationalSettings({
      gateResources: [
        { id: 'gate-1', label: '1', enabled: true, sortOrder: 1, createdAt: 1, updatedAt: 1 },
      ],
      gateGroups: [],
      gateLocks: [
        {
          id: 'gl1',
          name: 'Gate 1 Maintenance',
          gateIds: ['gate-1'],
          start: '2026-05-08T06:00',
          end: '2026-05-08T05:00',
          reason: null,
          enabled: true,
          createdAt: 1,
          updatedAt: 1,
        },
      ],
      standGateMappings: [],
      updatedAt: 1,
    });
  } catch (err) {
    invalidGateLockWindowError = err;
  }
  assert(
    invalidGateLockWindowError?.message.includes('lock start must be before end'),
    `enabled gate locks should reject start >= end, got ${invalidGateLockWindowError?.message}`
  );
  assert(
    JSON.stringify(parseCheckInCounterInventoryInput('1-3, M1-M3, Transit').map((item) => item.label)) === JSON.stringify(['1', '2', '3', 'M1', 'M2', 'M3', 'Transit']),
    `counter inventory input should parse numeric ranges, prefixed ranges, and custom labels`
  );
  assert(
    JSON.stringify(parseCheckInCounterInventoryInput('M1-3').map((item) => item.label)) === JSON.stringify(['M1', 'M2', 'M3']),
    `counter inventory input should parse prefixed ranges with implicit end prefix`
  );
  assert(
    JSON.stringify(parseCheckInCounterInventoryInput('A01-A03').map((item) => item.label)) === JSON.stringify(['A01', 'A02', 'A03']),
    `counter inventory input should preserve zero padding in prefixed ranges`
  );
  assert(
    JSON.stringify(parseCheckInCounterInventoryInput('GateA gatea GATEB;gateb').map((item) => item.label)) === JSON.stringify(['GateA', 'GATEB']),
    `counter inventory input should de-dupe case-insensitively while preserving first spelling`
  );
  const pageActionSettings = validateOperationalSettings({
    aircraftGroups: [],
    counterAllocationRules: [],
    checkInCounters: [
      { id: 'c1', label: '1', enabled: true, sortOrder: 1, createdAt: 1, updatedAt: 1 },
      { id: 'c2', label: '2', enabled: true, sortOrder: 2, createdAt: 1, updatedAt: 1 },
      { id: 'c3', label: 'Transit', enabled: true, sortOrder: 3, createdAt: 1, updatedAt: 1 },
    ],
    checkInCounterGroups: [
      { id: 'g1', name: 'Island A', bhs: 'BHS-A', counterIds: ['c1', 'c2'], sortOrder: 1, createdAt: 1, updatedAt: 1 },
      { id: 'g2', name: 'Transit Group', bhs: 'BHS-T', counterIds: ['c3'], sortOrder: 2, createdAt: 1, updatedAt: 1 },
    ],
    checkInCounterLocks: [
      { id: 'l1', name: 'Maintenance A', counterIds: ['c1', 'c2'], start: '2026-05-08T04:00', end: '2026-05-08T06:00', reason: 'A', enabled: true, createdAt: 1, updatedAt: 1 },
      { id: 'l2', name: 'Maintenance T', counterIds: ['c3'], start: '2026-05-08T07:00', end: '2026-05-08T08:00', reason: 'T', enabled: true, createdAt: 1, updatedAt: 1 },
    ],
    updatedAt: 1,
  });
  const pageActionSavedSnapshot = JSON.stringify(pageActionSettings);
  const pageActionNormalizedSave = validateOperationalSettings({ ...pageActionSettings, updatedAt: 50 });
  assert(
    resolveSettingsAfterSave(pageActionSettings, pageActionSavedSnapshot, pageActionNormalizedSave).updatedAt === 50,
    'save completion guard should accept the normalized saved settings when local state still matches the saving snapshot'
  );
  const pageActionConcurrentEdit = validateOperationalSettings({
    ...pageActionSettings,
    checkInCounters: pageActionSettings.checkInCounters.map((counter) => (
      counter.id === 'c1' ? { ...counter, label: '1 Draft', updatedAt: 40 } : counter
    )),
    updatedAt: 40,
  });
  assert(
    JSON.stringify(resolveSettingsAfterSave(pageActionConcurrentEdit, pageActionSavedSnapshot, pageActionNormalizedSave)) === JSON.stringify(pageActionConcurrentEdit),
    'save completion guard should preserve newer local settings when current state differs from the saving snapshot'
  );
  const counterDeletedSettings = deleteCheckInCounterFromSettings(pageActionSettings, 'c2', 60);
  assert(
    JSON.stringify(counterDeletedSettings.checkInCounters.map((counter) => counter.id)) === JSON.stringify(['c1', 'c3']) &&
      JSON.stringify(counterDeletedSettings.checkInCounterGroups.find((group) => group.id === 'g1')?.counterIds) === JSON.stringify(['c1']) &&
      JSON.stringify(counterDeletedSettings.checkInCounterGroups.find((group) => group.id === 'g2')?.counterIds) === JSON.stringify(['c3']) &&
      JSON.stringify(counterDeletedSettings.checkInCounterLocks.find((lock) => lock.id === 'l1')?.counterIds) === JSON.stringify(['c1']) &&
      JSON.stringify(counterDeletedSettings.checkInCounterLocks.find((lock) => lock.id === 'l2')?.counterIds) === JSON.stringify(['c3']),
    `counter delete helper should remove only the deleted counter and clean group/lock refs, got ${JSON.stringify(counterDeletedSettings)}`
  );
  const movedToGroupB = toggleCheckInCounterGroupMembership(pageActionSettings, 'g2', 'c2', 70);
  assert(
    JSON.stringify(movedToGroupB.checkInCounterGroups.find((group) => group.id === 'g1')?.counterIds) === JSON.stringify(['c1']) &&
      JSON.stringify(movedToGroupB.checkInCounterGroups.find((group) => group.id === 'g2')?.counterIds) === JSON.stringify(['c3', 'c2']),
    `group membership toggle should move a counter into the target group and remove it from other groups, got ${JSON.stringify(movedToGroupB.checkInCounterGroups)}`
  );
  const toggledOffGroupB = toggleCheckInCounterGroupMembership(movedToGroupB, 'g2', 'c2', 71);
  assert(
    JSON.stringify(toggledOffGroupB.checkInCounterGroups.find((group) => group.id === 'g1')?.counterIds) === JSON.stringify(['c1']) &&
      JSON.stringify(toggledOffGroupB.checkInCounterGroups.find((group) => group.id === 'g2')?.counterIds) === JSON.stringify(['c3']),
    `group membership toggle should remove an existing target membership without restoring previous groups, got ${JSON.stringify(toggledOffGroupB.checkInCounterGroups)}`
  );
  const lockAddedSettings = toggleCheckInCounterLockMembership(pageActionSettings, 'l2', 'c1', 80);
  assert(
    JSON.stringify(lockAddedSettings.checkInCounterLocks.find((lock) => lock.id === 'l1')?.counterIds) === JSON.stringify(['c1', 'c2']) &&
      JSON.stringify(lockAddedSettings.checkInCounterLocks.find((lock) => lock.id === 'l2')?.counterIds) === JSON.stringify(['c3', 'c1']),
    `lock membership toggle should add the counter to only the target lock, got ${JSON.stringify(lockAddedSettings.checkInCounterLocks)}`
  );
  const lockRemovedSettings = toggleCheckInCounterLockMembership(lockAddedSettings, 'l2', 'c1', 81);
  assert(
    JSON.stringify(lockRemovedSettings.checkInCounterLocks.find((lock) => lock.id === 'l1')?.counterIds) === JSON.stringify(['c1', 'c2']) &&
      JSON.stringify(lockRemovedSettings.checkInCounterLocks.find((lock) => lock.id === 'l2')?.counterIds) === JSON.stringify(['c3']),
    `lock membership toggle should remove the counter from only the target lock, got ${JSON.stringify(lockRemovedSettings.checkInCounterLocks)}`
  );
  const gateActionSettings = validateOperationalSettings({
    gateResources: [
      { id: 'gate-1', label: '1', enabled: true, sortOrder: 1, createdAt: 1, updatedAt: 1 },
      { id: 'gate-2', label: '2', enabled: true, sortOrder: 2, createdAt: 1, updatedAt: 1 },
    ],
    gateGroups: [],
    gateLocks: [
      { id: 'gl1', name: 'Gate 1 Maintenance', gateIds: ['gate-1'], start: '2026-05-08T04:00', end: '2026-05-08T06:00', reason: 'A', enabled: true, createdAt: 1, updatedAt: 1 },
      { id: 'gl2', name: 'Gate 2 Maintenance', gateIds: ['gate-2'], start: '2026-05-08T07:00', end: '2026-05-08T08:00', reason: 'B', enabled: true, createdAt: 1, updatedAt: 1 },
    ],
    standGateMappings: [],
    updatedAt: 1,
  });
  const gateLockAddedSettings = toggleGateLockMembership(gateActionSettings, 'gl2', 'gate-1', 82);
  assert(
    JSON.stringify(gateLockAddedSettings.gateLocks.find((lock) => lock.id === 'gl1')?.gateIds) === JSON.stringify(['gate-1']) &&
      JSON.stringify(gateLockAddedSettings.gateLocks.find((lock) => lock.id === 'gl2')?.gateIds) === JSON.stringify(['gate-2', 'gate-1']),
    `gate lock membership toggle should add the gate to only the target lock, got ${JSON.stringify(gateLockAddedSettings.gateLocks)}`
  );
  const gateLockRemovedSettings = toggleGateLockMembership(gateLockAddedSettings, 'gl2', 'gate-1', 83);
  assert(
    JSON.stringify(gateLockRemovedSettings.gateLocks.find((lock) => lock.id === 'gl1')?.gateIds) === JSON.stringify(['gate-1']) &&
      JSON.stringify(gateLockRemovedSettings.gateLocks.find((lock) => lock.id === 'gl2')?.gateIds) === JSON.stringify(['gate-2']),
    `gate lock membership toggle should remove the gate from only the target lock, got ${JSON.stringify(gateLockRemovedSettings.gateLocks)}`
  );
  const renamedCounterSettings = renameCheckInCounterLabelInSettings(pageActionSettings, 'c1', '  Renamed  ', 90);
  assert(
    renamedCounterSettings.checkInCounters.find((counter) => counter.id === 'c1')?.label === 'Renamed' &&
      renamedCounterSettings.checkInCounters.find((counter) => counter.id === 'c1')?.updatedAt === 90 &&
      renamedCounterSettings.checkInCounters.find((counter) => counter.id === 'c2')?.label === '2' &&
      renamedCounterSettings.checkInCounters.find((counter) => counter.id === 'c2')?.updatedAt === 1,
    `confirmed counter rename helper should update only the target counter label and timestamp, got ${JSON.stringify(renamedCounterSettings.checkInCounters)}`
  );
  const counterSettings = validateOperationalSettings({
    aircraftGroups: [],
    counterAllocationRules: [],
    checkInCounters: [
      { id: 'c1', label: '1', enabled: true, sortOrder: 1, createdAt: 1, updatedAt: 1 },
      { id: 'c2', label: '2', enabled: true, sortOrder: 2, createdAt: 1, updatedAt: 1 },
      { id: 'm1', label: 'M1', enabled: true, sortOrder: 3, createdAt: 1, updatedAt: 1 },
    ],
    checkInCounterGroups: [
      { id: 'g1', name: 'Island A', bhs: 'BHS-A', counterIds: ['c1', 'c2'], sortOrder: 1, createdAt: 1, updatedAt: 1 },
      { id: 'g2', name: 'Mobility', bhs: 'BHS-M', counterIds: ['m1'], sortOrder: 2, createdAt: 1, updatedAt: 1 },
    ],
    checkInCounterLocks: [
      { id: 'l1', name: 'C2 Outage', counterIds: ['c2'], start: '2026-05-08T04:00', end: '2026-05-08T07:00', reason: 'Maintenance', enabled: true, createdAt: 1, updatedAt: 1 },
    ],
    updatedAt: 1,
  });
  const resourceRows = buildCheckInCounterResources({ settings: counterSettings, assignedCounters: [], groupByCounterGroup: false, visibleWindow: { start: '2026-05-08T03:00', end: '2026-05-08T08:00' } });
  assert(
    JSON.stringify(resourceRows.map((row) => row.label)) === JSON.stringify(['1', '2', 'M1']) &&
      resourceRows[1].groupName === 'Island A' &&
      resourceRows[1].activeLocks.length === 1,
    `configured counter resources should preserve order, group metadata, and active locks, got ${JSON.stringify(resourceRows)}`
  );
  assert(
    buildCheckInBhsValue([1, 2], resourceRows) === 'BHS-A' &&
      buildCheckInBhsValue([1, 'M1'], resourceRows) === 'BHS-A,BHS-M',
    `BHS mapping should resolve one or multiple counter groups`
  );
  assert(
    buildCheckInBhsValue(['1'], resourceRows) === 'BHS-A',
    `BHS mapping should normalize assigned numeric strings to configured numeric counters`
  );
  assert(
    findCheckInLockConflict([2], { start: '2026-05-08T05:00', end: '2026-05-08T06:00' }, resourceRows)?.lock.name === 'C2 Outage',
    'active lock conflicts should be detected for overlapping allocation windows'
  );
  assert(
    findCheckInLockConflict(['2'], { start: '2026-05-08T05:00', end: '2026-05-08T06:00' }, resourceRows)?.lock.name === 'C2 Outage',
    'active lock conflicts should normalize assigned numeric strings to configured numeric counters'
  );
  assert(
    findCheckInLockConflict([2], { start: '2026-05-08T07:00', end: '2026-05-08T08:00' }, resourceRows) == null,
    'active lock conflicts should ignore exact boundary adjacency'
  );
  const noDuplicateLegacyRows = buildCheckInCounterResources({ settings: counterSettings, assignedCounters: ['1'], groupByCounterGroup: false });
  assert(
    noDuplicateLegacyRows.length === 3 &&
      noDuplicateLegacyRows.filter((row) => row.label === '1').length === 1 &&
      noDuplicateLegacyRows.every((row) => !row.isLegacy),
    `assigned numeric strings should match configured numeric labels instead of appending legacy duplicates, got ${JSON.stringify(noDuplicateLegacyRows)}`
  );
  const duplicateCanonicalCounterSettings = validateOperationalSettings({
    aircraftGroups: [],
    counterAllocationRules: [],
    checkInCounters: [
      { id: 'numeric-1', label: '1', enabled: true, sortOrder: 1, createdAt: 1, updatedAt: 1 },
      { id: 'numeric-01', label: '01', enabled: true, sortOrder: 2, createdAt: 1, updatedAt: 1 },
    ],
    checkInCounterGroups: [
      { id: 'canonical-group', name: 'Canonical', bhs: 'BHS-C', counterIds: ['numeric-1', 'numeric-01'], sortOrder: 1, createdAt: 1, updatedAt: 1 },
    ],
    checkInCounterLocks: [
      { id: 'canonical-lock', name: 'Canonical Lock', counterIds: ['numeric-01'], start: '2026-05-08T05:00', end: '2026-05-08T06:00', reason: null, enabled: true, createdAt: 1, updatedAt: 1 },
    ],
    updatedAt: 1,
  });
  const duplicateCanonicalRows = buildCheckInCounterResources({ settings: duplicateCanonicalCounterSettings, assignedCounters: [], groupByCounterGroup: false, visibleWindow: { start: '2026-05-08T04:00', end: '2026-05-08T07:00' } });
  assert(
    duplicateCanonicalRows.length === 1 &&
      duplicateCanonicalRows[0].label === '1' &&
      duplicateCanonicalRows[0].counterId === 'numeric-1' &&
      duplicateCanonicalRows[0].activeLocks[0]?.lock.name === 'Canonical Lock' &&
      buildCheckInBhsValue(['01'], duplicateCanonicalRows) === 'BHS-C' &&
      findCheckInLockConflict(['01'], { start: '2026-05-08T05:30', end: '2026-05-08T05:45' }, duplicateCanonicalRows)?.lock.name === 'Canonical Lock',
    `configured counters with duplicate canonical identities should preserve the first row and merge duplicate lock metadata, got ${JSON.stringify(duplicateCanonicalRows)}`
  );
  const disabledLockSettings = validateOperationalSettings({
    aircraftGroups: [],
    counterAllocationRules: [],
    checkInCounters: [
      { id: 'c1', label: '1', enabled: true, sortOrder: 1, createdAt: 1, updatedAt: 1 },
    ],
    checkInCounterGroups: [],
    checkInCounterLocks: [
      { id: 'disabled-lock', name: 'Disabled Outage', counterIds: ['c1'], start: '2026-05-08T05:00', end: '2026-05-08T06:00', reason: null, enabled: false, createdAt: 1, updatedAt: 1 },
    ],
    updatedAt: 1,
  });
  const disabledLockRows = buildCheckInCounterResources({ settings: disabledLockSettings, assignedCounters: [], groupByCounterGroup: false, visibleWindow: { start: '2026-05-08T04:00', end: '2026-05-08T07:00' } });
  assert(
    disabledLockRows[0].activeLocks.length === 0 &&
      findCheckInLockConflict([1], { start: '2026-05-08T05:30', end: '2026-05-08T05:45' }, disabledLockRows) == null,
    `disabled locks should not appear as active lock conflicts, got ${JSON.stringify(disabledLockRows)}`
  );
  const lockOutsideVisibleRows = buildCheckInCounterResources({ settings: counterSettings, assignedCounters: [], groupByCounterGroup: false, visibleWindow: { start: '2026-05-08T08:00', end: '2026-05-08T09:00' } });
  assert(
    lockOutsideVisibleRows[1].activeLocks.length === 0 &&
      findCheckInLockConflict(['2'], { start: '2026-05-08T05:00', end: '2026-05-08T06:00' }, lockOutsideVisibleRows)?.lock.name === 'C2 Outage',
    `lock conflicts should still be detected when display activeLocks were filtered by visible window, got ${JSON.stringify(lockOutsideVisibleRows)}`
  );
  const groupedResourceSettings = validateOperationalSettings({
    aircraftGroups: [],
    counterAllocationRules: [],
    checkInCounters: [
      { id: 'ungrouped', label: 'Z1', enabled: true, sortOrder: 0, createdAt: 1, updatedAt: 1 },
      { id: 'a2', label: '2', enabled: true, sortOrder: 2, createdAt: 1, updatedAt: 1 },
      { id: 'b1', label: 'M1', enabled: true, sortOrder: 1, createdAt: 1, updatedAt: 1 },
      { id: 'a1', label: '1', enabled: true, sortOrder: 1, createdAt: 1, updatedAt: 1 },
    ],
    checkInCounterGroups: [
      { id: 'group-b', name: 'Island B', bhs: 'BHS-B', counterIds: ['b1'], sortOrder: 2, createdAt: 1, updatedAt: 1 },
      { id: 'group-a', name: 'Island A', bhs: 'BHS-A', counterIds: ['a1', 'a2'], sortOrder: 1, createdAt: 1, updatedAt: 1 },
    ],
    checkInCounterLocks: [],
    updatedAt: 1,
  });
  const groupedRows = buildCheckInCounterResources({ settings: groupedResourceSettings, assignedCounters: ['L1'], groupByCounterGroup: true });
  const groupedSections = buildCheckInCounterSections(groupedRows);
  assert(
    JSON.stringify(groupedRows.map((row) => row.label)) === JSON.stringify(['1', '2', 'M1', 'Z1', 'L1']) &&
      JSON.stringify(groupedSections.map((section) => [section.id, section.startIndex, section.endIndex])) === JSON.stringify([
        ['group-a', 0, 1],
        ['group-b', 2, 2],
        ['ungrouped', 3, 3],
        ['legacy', 4, 4],
      ]),
    `grouped counter resources should sort into contiguous sections, got ${JSON.stringify({ groupedRows, groupedSections })}`
  );
  const counterRuleSettings = validateOperationalSettings({
    aircraftGroups: [
      { id: 'grp-big', name: 'Big', aircraftTypes: ['A321', 'B787'], createdAt: 1, updatedAt: 1 },
    ],
    counterAllocationRules: [
      {
        id: 'aircraft-a321',
        name: 'A321 default',
        enabled: true,
        priorityScore: 10,
        sortOrder: 1,
        createdAt: 10,
        updatedAt: 10,
        conditions: { aircraftTypes: ['A321'], aircraftGroups: [], airlineCodes: [] },
        counterValue: 4,
      },
      {
        id: 'airline-vj',
        name: 'VJ override',
        enabled: true,
        priorityScore: 20,
        sortOrder: 2,
        createdAt: 11,
        updatedAt: 11,
        conditions: { aircraftTypes: [], aircraftGroups: [], airlineCodes: ['VJ'] },
        counterValue: 3,
      },
      {
        id: 'specific-vj-a321',
        name: 'Specific tie',
        enabled: true,
        priorityScore: 20,
        sortOrder: 3,
        createdAt: 12,
        updatedAt: 12,
        conditions: { aircraftTypes: ['A321'], aircraftGroups: [], airlineCodes: ['VJ'] },
        counterValue: 5,
      },
      {
        id: 'older-sort',
        name: 'Sort order tie',
        enabled: true,
        priorityScore: 20,
        sortOrder: 0,
        createdAt: 20,
        updatedAt: 20,
        conditions: { aircraftTypes: [], aircraftGroups: [], airlineCodes: ['QZ'] },
        counterValue: 2,
      },
      {
        id: 'later-sort',
        name: 'Later sort',
        enabled: true,
        priorityScore: 20,
        sortOrder: 1,
        createdAt: 19,
        updatedAt: 19,
        conditions: { aircraftTypes: [], aircraftGroups: [], airlineCodes: ['QZ'] },
        counterValue: 6,
      },
    ],
    updatedAt: 99,
  });
  const vjA321Rule = evaluateCounterRules({ aircraft: 'A321', airline: 'VJ' }, counterRuleSettings);
  assert(
    vjA321Rule.counterValue === 5 && vjA321Rule.rule?.id === 'specific-vj-a321',
    `score-first precedence should use specificity as tie-break, got ${JSON.stringify(vjA321Rule)}`
  );
  const qzA330Rule = evaluateCounterRules({ aircraft: 'A330', airline: 'QZ' }, counterRuleSettings);
  assert(
    qzA330Rule.counterValue === 2 && qzA330Rule.rule?.id === 'older-sort',
    `equal specificity rules should use lower sortOrder, got ${JSON.stringify(qzA330Rule)}`
  );
  const removedGroupSettings = removeAircraftGroupFromSettings({
    aircraftGroups: [{ id: 'grp-big', name: 'Big', aircraftTypes: ['A321'], createdAt: 1, updatedAt: 1 }],
    counterAllocationRules: [{
      id: 'group-only',
      name: 'Group only',
      enabled: true,
      priorityScore: 1,
      sortOrder: 1,
      createdAt: 1,
      updatedAt: 1,
      conditions: { aircraftTypes: [], aircraftGroups: ['grp-big'], airlineCodes: [] },
      counterValue: 4,
    }],
    checkInCounters: [
      { id: 'counter-1', label: 'A01', enabled: true, sortOrder: 1, createdAt: 1, updatedAt: 1 },
    ],
    checkInCounterGroups: [
      { id: 'counter-group-1', name: 'Zone A', bhs: 'BHS1', counterIds: ['counter-1'], sortOrder: 1, createdAt: 1, updatedAt: 1 },
    ],
    checkInCounterLocks: [
      {
        id: 'counter-lock-1',
        name: 'Maintenance',
        counterIds: ['counter-1'],
        start: '2026-05-08T08:00',
        end: '2026-05-08T09:00',
        reason: 'PM',
        enabled: true,
        createdAt: 1,
        updatedAt: 1,
      },
    ],
    updatedAt: 1,
  }, 'grp-big', 2);
  assert(
    removedGroupSettings.aircraftGroups.length === 0 &&
      removedGroupSettings.counterAllocationRules[0].enabled === false &&
      removedGroupSettings.counterAllocationRules[0].conditions.aircraftGroups.length === 0 &&
      removedGroupSettings.checkInCounters.length === 1 &&
      removedGroupSettings.checkInCounterGroups.length === 1 &&
      removedGroupSettings.checkInCounterLocks.length === 1,
    `deleting an A/C group should remove references, disable empty rules, and preserve check-in settings, got ${JSON.stringify(removedGroupSettings)}`
  );

  assert(normalizeSeasonSheetName(' S26 ') === 'S26', 'season sheet name should trim surrounding whitespace');
  assert(normalizeSeasonSheetName('W27') === 'W27', 'season sheet name should accept winter season codes');
  assert(
    buildSeasonNameFromFileName('DAD_SeasonalS26.xlsx', 'S26') === 'S26' &&
      buildSeasonNameFromFileName('OperationalTurns_W26.xlsx', 'W26') === 'W26' &&
      buildSeasonNameFromFileName('W25.xlsx', 'W25') === 'W25',
    'season import names must use the canonical season code instead of imported file names'
  );
  assert(
    buildSeasonDisplayLabel({ seasonCode: 'S26', name: 'DAD SeasonalS26' }) === 'S26' &&
      buildSeasonDisplayLabel({ seasonCode: 'W26', name: 'W26' }) === 'W26' &&
      buildSeasonDisplayLabel({ seasonCode: 'W25', name: 'OperationalTurns W25' }) === 'W25',
    'season selection/filter labels must use only canonical season codes'
  );
  let invalidSeasonNameError = null;
  try {
    normalizeSeasonSheetName('DAD_SeasonalS26');
  } catch (err) {
    invalidSeasonNameError = err;
  }
  assert(
    invalidSeasonNameError?.message.includes('first worksheet name'),
    `invalid season sheet names should be rejected with a sheet-name error, got ${invalidSeasonNameError?.message}`
  );
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet([{
    Effective: '29-Mar-26',
    Discontinue: '24-Oct-26',
    Airline: 'VN',
    Aircraft: '321',
    Mon: 1,
    Tue: 0,
    Wed: 0,
    Thu: 0,
    Fri: 0,
    Sat: 0,
    Sun: 0,
    STA: '12:40',
    ARRFlight: '319',
    ARRRoute: 'NRT',
  }]), ' S26 ');
  assert(parseSeasonalSchedule(workbook).seasonCode === 'S26', 'parser should use the trimmed first worksheet name as season code');
  const lowercaseWorkbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(lowercaseWorkbook, XLSX.utils.json_to_sheet([{
    Effective: '29-Mar-26',
    Discontinue: '29-Mar-26',
    Airline: 'vj',
    Aircraft: '32n',
    Mon: 0,
    Tue: 0,
    Wed: 0,
    Thu: 0,
    Fri: 0,
    Sat: 0,
    Sun: 1,
    STA: '12:40',
    ARRFlight: '8511',
    ARRFlightType: 'pax',
    ARRRoute: 'icn',
    ARRFlightCategory: 'j',
    ARRCodeShares: 'vn9001',
    ARRIntDomInd: 'i',
    STD: '14:10',
    DEPFlight: '890a',
    DEPFlightType: 'pax',
    DEPRoute: 'bkk',
    DEPFlightCategory: 'j',
    DEPCodeShares: 'vj999',
    DEPIntDomInd: 'i',
  }]), 'S26');
  const lowercaseParsed = parseSeasonalSchedule(lowercaseWorkbook).rows[0];
  const lowercaseLegs = expandToFlightLegs([lowercaseParsed]);
  assert(
    lowercaseParsed.airline === 'VJ' &&
      lowercaseParsed.aircraft === '32N' &&
      lowercaseParsed.arrRoute === 'ICN' &&
      lowercaseParsed.arrFlightType === 'PAX' &&
      lowercaseParsed.arrCodeShares === 'VN9001' &&
      lowercaseParsed.depFlight === '890A' &&
      lowercaseLegs.some((leg) => leg.flightNumber === 'VJ8511' && leg.route === 'ICN' && leg.codeShares === 'VN9001') &&
      lowercaseLegs.some((leg) => leg.flightNumber === 'VJ890A' && leg.route === 'BKK' && leg.codeShares === 'VJ999'),
    `seasonal import should normalize aviation code fields to uppercase, got ${JSON.stringify({ row: lowercaseParsed, legs: lowercaseLegs })}`
  );
  const dirtyGuard = getDirtyImportGuard({
    targetSeasonId: 'season-s26',
    targetSeasonCode: 'S26',
    activeSeasonId: 'season-s26',
    pendingCount: 3,
  });
  assert(
    dirtyGuard.shouldBlock && dirtyGuard.scope === 'active' && dirtyGuard.message.includes('3 unsynced'),
    `same-season dirty re-import should be blocked before overwrite, got ${JSON.stringify(dirtyGuard)}`
  );
  const cleanGuard = getDirtyImportGuard({
    targetSeasonId: 'season-w26',
    targetSeasonCode: 'W26',
    activeSeasonId: 'season-s26',
    pendingCount: 0,
  });
  assert(!cleanGuard.shouldBlock, `clean different-season import should not block active season, got ${JSON.stringify(cleanGuard)}`);

  clearSeasonDataCache();
  setCachedSeasons([{ id: 'season-1', seasonCode: 'S26', uploadedAt: 1 }]);
  assert(getCachedSeasons()?.[0].id === 'season-1', `season list cache should be readable, got ${JSON.stringify(getCachedSeasons())}`);
  setCachedSeasonData('season-1', {
    rows: [{ rowIndex: 1 }],
    records: [{ id: 'R1' }],
    modifications: new Map([['R1', { legId: 'R1', action: 'modified' }]]),
  });
  const cachedSeasonData = getCachedSeasonData('season-1');
  assert(cachedSeasonData?.records.length === 1, `season data cache should return records, got ${JSON.stringify(cachedSeasonData)}`);
  patchCachedSeasonData('season-1', { records: [{ id: 'R2' }] });
  assert(getCachedSeasonData('season-1')?.records[0].id === 'R2', `season data patch should update records, got ${JSON.stringify(getCachedSeasonData('season-1'))}`);
  let observedWorkspaceChange = null;
  const unsubscribeWorkspaceChange = subscribeSeasonWorkspaceChanges((event) => {
    observedWorkspaceChange = event;
  });
  publishSeasonWorkspaceChanged({ seasonId: 'season-1', localRevision: 7, source: 'rule-test' });
  unsubscribeWorkspaceChange();
  assert(
    observedWorkspaceChange?.seasonId === 'season-1' &&
      observedWorkspaceChange.localRevision === 7 &&
      observedWorkspaceChange.source === 'rule-test' &&
      observedWorkspaceChange.eventSeq > 0,
    `season workspace change events should publish same-session revision metadata, got ${JSON.stringify(observedWorkspaceChange)}`
  );
  const linkedActionState = getSeasonalLinkActionState({ recordCount: 3, linkedPartnerCount: 1 });
  assert(linkedActionState.canUnlink && linkedActionState.canLink, `linked seasonal group should show link and unlink, got ${JSON.stringify(linkedActionState)}`);
  const unlinkedActionState = getSeasonalLinkActionState({ recordCount: 3, linkedPartnerCount: 0 });
  assert(unlinkedActionState.canLink && !unlinkedActionState.canUnlink, `unlinked seasonal group should show link only, got ${JSON.stringify(unlinkedActionState)}`);
  const route = buildSeasonalLinkRoute('season-1', { airline: 'VN', arrFlightNumber: '8', depFlightNumber: null }, { dateFrom: '2026-03-29' });
  assert(route === '/detailed?season=season-1&arrFlight=VN008&dateFrom=2026-03-29', `seasonal link route should preserve filter context, got ${route}`);
  const serializedMods = serializeModificationMap(new Map([
    ['R1', { legId: 'R1', action: 'modified', schedule: '10:00' }],
    ['R2', { legId: 'R2', action: 'deleted' }],
  ]));
  const deserializedMods = deserializeModificationEntries(serializedMods);
  assert(deserializedMods.get('R1')?.schedule === '10:00' && deserializedMods.get('R2')?.action === 'deleted', `local modification map should round-trip, got ${JSON.stringify(Array.from(deserializedMods.entries()))}`);
  const mergedPending = mergePendingOps([
    { type: 'flightRecord', record: { id: 'R1', route: 'HAN' } },
    { type: 'modification', mod: { legId: 'R1', action: 'modified', schedule: '10:00' } },
    { type: 'flightRecord', record: { id: 'R1', route: 'DAD' } },
    { type: 'modification', mod: { legId: 'R1', action: 'modified', schedule: '11:00' } },
  ]);
  assert(mergedPending.length === 2, `pending ops should merge by logical id, got ${JSON.stringify(mergedPending)}`);
  assert(mergedPending.find((op) => op.type === 'flightRecord')?.record.route === 'DAD', `latest flight record pending op should win, got ${JSON.stringify(mergedPending)}`);
  assert(mergedPending.find((op) => op.type === 'modification')?.mod.schedule === '11:00', `latest modification pending op should win, got ${JSON.stringify(mergedPending)}`);
  const localWorkspace = createLocalWorkspace({
    season: { id: 'season-1', seasonCode: 'S26', dataVersion: 2 },
    rows: [{ rowIndex: 1 }],
    records: [{ id: 'R1' }],
    modifications: new Map([['R1', { legId: 'R1', action: 'deleted' }]]),
    modHistory: [],
  });
  assert(localWorkspace.syncMeta.baseServerVersion === 2, `workspace should capture base server version, got ${JSON.stringify(localWorkspace.syncMeta)}`);
  assert(localWorkspace.syncMeta.syncStatus === 'synced', `new workspace should start synced, got ${JSON.stringify(localWorkspace.syncMeta)}`);
  let bootstrappedSave = null;
  const bootstrapped = await loadOrSeedSeasonWorkspace(
    { id: 'bootstrap-season', seasonCode: 'S26', dataVersion: 9 },
    {
      loadLocalWorkspace: async () => null,
      saveLocalWorkspace: async (workspace) => {
        bootstrappedSave = workspace;
      },
      getCachedData: () => null,
      setCachedData: () => undefined,
      loadServerBaseline: async () => ({
        rows: [{ rowIndex: 1 }],
        records: [{ id: 'BOOT-R1', date: '2026-04-01', schedule: '09:00', type: 'D', status: 'active' }],
        modifications: new Map(),
        modHistory: [],
        serverEventHighWater: 14,
        entityVersions: { flight_record: { 'BOOT-R1': 5 } },
      }),
    }
  );
  assert(
    bootstrapped.source === 'server' &&
      bootstrapped.workspace.records[0].id === 'BOOT-R1' &&
      bootstrapped.workspace.syncMeta.lastServerSeq === 14 &&
      bootstrappedSave?.season.id === 'bootstrap-season',
    `missing local workspace should seed from server and persist locally, got ${JSON.stringify({
      source: bootstrapped.source,
      records: bootstrapped.workspace.records,
      syncMeta: bootstrapped.workspace.syncMeta,
      savedSeasonId: bootstrappedSave?.season.id,
    })}`
  );
  const dirtyWorkspace = markDerivedSeasonalDirty(localWorkspace);
  assert(dirtyWorkspace.derivedSeasonal == null && dirtyWorkspace.syncMeta.localRevision === 1, `dirtying derived cache should clear it and bump revision, got ${JSON.stringify(dirtyWorkspace.syncMeta)}`);
  const conflictPlan = planSync({ baseServerVersion: 2, serverVersion: 3, pendingOps: [{ type: 'flightRecord', record: { id: 'R1' } }] });
  assert(conflictPlan.status === 'conflict', `sync should block on server version drift, got ${JSON.stringify(conflictPlan)}`);
  const remoteRefreshPlan = planSync({ baseServerVersion: 2, serverVersion: 3, pendingOps: [] });
  assert(remoteRefreshPlan.status === 'refresh', `sync should refresh clean local workspaces when the server version advances, got ${JSON.stringify(remoteRefreshPlan)}`);
  const cleanPlan = planSync({ baseServerVersion: 2, serverVersion: 2, pendingOps: mergedPending });
  assert(cleanPlan.status === 'ready' && cleanPlan.writtenCounts.records === 1 && cleanPlan.writtenCounts.modifications === 1, `clean sync should count coalesced pending ops, got ${JSON.stringify(cleanPlan)}`);
  const syncedWorkspace = applySuccessfulSync({ ...dirtyWorkspace, pendingOps: mergedPending }, 3);
  assert(syncedWorkspace.pendingOps.length === 0 && syncedWorkspace.syncMeta.baseServerVersion === 3 && syncedWorkspace.syncMeta.syncStatus === 'synced', `successful sync should clear pending ops and update baseline, got ${JSON.stringify(syncedWorkspace.syncMeta)}`);
  const syncStartWorkspace = createLocalWorkspace({
    season: { id: 'sync-race-season', seasonCode: 'S26', dataVersion: 4 },
    rows: [],
    records: [{ id: 'SYNC-R1', route: 'SENT' }],
    modifications: new Map(),
    modHistory: [],
    baseRecords: [{ id: 'SYNC-R1', route: 'BASE' }],
    pendingOps: [{ type: 'flightRecord', record: { id: 'SYNC-R1', route: 'SENT' } }],
    syncMeta: {
      baseServerVersion: 4,
      localRevision: 1,
      pendingCount: 1,
      lastLocalChangeAt: 100,
      syncStatus: 'dirty',
    },
  });
  const syncLatestWorkspace = createLocalWorkspace({
    season: { id: 'sync-race-season', seasonCode: 'S26', dataVersion: 4 },
    rows: [],
    records: [{ id: 'SYNC-R1', route: 'AFTER_RPC_STARTED' }],
    modifications: new Map(),
    modHistory: [],
    baseRecords: [{ id: 'SYNC-R1', route: 'BASE' }],
    pendingOps: [{ type: 'flightRecord', record: { id: 'SYNC-R1', route: 'AFTER_RPC_STARTED' } }],
    syncMeta: {
      baseServerVersion: 4,
      localRevision: 2,
      pendingCount: 1,
      lastLocalChangeAt: 200,
      syncStatus: 'dirty',
    },
  });
  const finalizedRaceWorkspace = finalizeSuccessfulSync(syncStartWorkspace, syncLatestWorkspace, 5);
  assert(
    finalizedRaceWorkspace.syncMeta.baseServerVersion === 5 &&
      finalizedRaceWorkspace.syncMeta.syncStatus === 'dirty' &&
      finalizedRaceWorkspace.syncMeta.localRevision === 2 &&
      finalizedRaceWorkspace.syncMeta.lastLocalChangeAt === 200 &&
      finalizedRaceWorkspace.baseRecords[0].route === 'SENT' &&
      finalizedRaceWorkspace.records[0].route === 'AFTER_RPC_STARTED' &&
      finalizedRaceWorkspace.pendingOps.length === 1 &&
      finalizedRaceWorkspace.pendingOps[0].type === 'flightRecord' &&
      finalizedRaceWorkspace.pendingOps[0].record.route === 'AFTER_RPC_STARTED',
    `successful sync must preserve local edits created during the RPC, got ${JSON.stringify({
      syncMeta: finalizedRaceWorkspace.syncMeta,
      baseRecords: finalizedRaceWorkspace.baseRecords,
      records: finalizedRaceWorkspace.records,
      pendingOps: finalizedRaceWorkspace.pendingOps,
    })}`
  );
  const finalizedCleanWorkspace = finalizeSuccessfulSync(syncStartWorkspace, syncStartWorkspace, 5);
  assert(
    finalizedCleanWorkspace.syncMeta.syncStatus === 'synced' &&
      finalizedCleanWorkspace.pendingOps.length === 0 &&
      finalizedCleanWorkspace.baseRecords[0].route === 'SENT',
    `successful sync without in-flight edits should still clear pending ops, got ${JSON.stringify({
      syncMeta: finalizedCleanWorkspace.syncMeta,
      baseRecords: finalizedCleanWorkspace.baseRecords,
      pendingOps: finalizedCleanWorkspace.pendingOps,
    })}`
  );
  const staleCleanWorkspace = createLocalWorkspace({
    season: { id: 'stale-season', seasonCode: 'S26', dataVersion: 1 },
    rows: [],
    records: [{ id: 'STALE-1', route: 'OLD' }],
    modifications: new Map(),
    modHistory: [],
    baseRecords: [{ id: 'STALE-1', route: 'OLD' }],
    syncMeta: {
      baseServerVersion: 1,
      lastServerSeq: 5,
      localRevision: 1,
      pendingCount: 0,
      lastLocalChangeAt: null,
      syncStatus: 'synced',
    },
  });
  const staleDirtyWorkspace = rebuildPendingOpsFromBaseline({
    ...staleCleanWorkspace,
    records: [{ id: 'STALE-1', route: 'LOCAL' }],
  }, 800);
  assert(
    typeof isSeasonWorkspaceStale === 'function' &&
      isSeasonWorkspaceStale(staleCleanWorkspace, { id: 'stale-season', seasonCode: 'S26', dataVersion: 2 }) === 'clean-stale' &&
      isSeasonWorkspaceStale(staleDirtyWorkspace, { id: 'stale-season', seasonCode: 'S26', dataVersion: 2 }) === 'dirty-stale' &&
      isSeasonWorkspaceStale(staleCleanWorkspace, { id: 'stale-season', seasonCode: 'S26', dataVersion: 1 }) === 'current',
    'season sync must classify stale clean and dirty local workspaces from server dataVersion changes'
  );
  const entityMergeWorkspace = createLocalWorkspace({
    season: { id: 'entity-merge-season', seasonCode: 'S26', dataVersion: 8 },
    rows: [],
    records: [{ id: 'EM-1', route: 'DAD', gate: 1, stand: 5, status: 'active' }],
    modifications: new Map(),
    modHistory: [],
    baseRecords: [{ id: 'EM-1', route: 'DAD', gate: 1, stand: 5, status: 'active' }],
    entityVersions: { 'flightRecord:EM-1': { gate: 12, stand: 12 } },
    syncMeta: {
      baseServerVersion: 8,
      lastServerSeq: 12,
      clientId: 'client-local',
      localRevision: 1,
      pendingCount: 1,
      lastLocalChangeAt: 500,
      syncStatus: 'dirty',
    },
  });
  const dirtyEntityMergeWorkspace = rebuildPendingOpsFromBaseline({
    ...entityMergeWorkspace,
    records: [{ id: 'EM-1', route: 'DAD', gate: 3, stand: 5, status: 'active' }],
  }, 500);
  const pendingEvents = buildPendingChangeEvents(dirtyEntityMergeWorkspace, { clientId: 'client-local', now: 1000 });
  assert(
    pendingEvents.length === 1 &&
      pendingEvents[0].targetType === 'flightRecord' &&
      pendingEvents[0].targetId === 'EM-1' &&
      JSON.stringify(pendingEvents[0].changedFields) === JSON.stringify(['gate']) &&
      pendingEvents[0].opPayload.baseFieldVersions.gate === 12,
    `pending change events should capture stable target, changed fields, and base field versions, got ${JSON.stringify(pendingEvents)}`
  );
  const exactFieldVersionWorkspace = rebuildPendingOpsFromBaseline(createLocalWorkspace({
    season: { id: 'entity-version-season', seasonCode: 'S26', dataVersion: 8 },
    rows: [],
    records: [{ id: 'EV-1', route: 'DAD', gate: 4, stand: 2, status: 'active' }],
    modifications: new Map(),
    modHistory: [],
    baseRecords: [{ id: 'EV-1', route: 'DAD', gate: 1, stand: 2, status: 'active' }],
    entityVersions: {
      'flightRecord:EV-1': {
        gate: 22,
        stand: 18,
      },
    },
    syncMeta: {
      baseServerVersion: 8,
      lastServerSeq: 99,
      clientId: 'client-local',
      localRevision: 1,
      pendingCount: 1,
      lastLocalChangeAt: 700,
      syncStatus: 'dirty',
    },
  }), 700);
  const exactFieldVersionEvents = buildPendingChangeEvents(exactFieldVersionWorkspace, { clientId: 'client-local', now: 1001 });
  assert(
    typeof seasonEventTargetKey === 'function' &&
      seasonEventTargetKey('flightRecord', 'EV-1') === 'flightRecord:EV-1' &&
      exactFieldVersionEvents.length === 1 &&
      exactFieldVersionEvents[0].opPayload.baseFieldVersions.gate === 22 &&
      exactFieldVersionEvents[0].opPayload.baseFieldVersions.gate !== exactFieldVersionWorkspace.syncMeta.lastServerSeq,
    `pending events must use exact per-entity field versions instead of global lastServerSeq, got ${JSON.stringify(exactFieldVersionEvents)}`
  );
  const remoteStandEvent = {
    eventId: 'remote-stand',
    seasonId: 'entity-merge-season',
    clientId: 'client-remote',
    opId: 'remote-stand-op',
    actorUserId: 'remote-user',
    serverSeq: 13,
    targetType: 'flightRecord',
    targetId: 'EM-1',
    changedFields: ['stand'],
    opPayload: {
      type: 'flightRecord',
      record: { id: 'EM-1', route: 'DAD', gate: 1, stand: 9, status: 'active' },
      baseFieldVersions: { stand: 12 },
    },
    createdAt: '2026-05-20T00:00:00.000Z',
  };
  const mergedRemoteStand = mergeRemoteSeasonEvent(dirtyEntityMergeWorkspace, remoteStandEvent, { clientId: 'client-local' });
  assert(
    mergedRemoteStand.applied &&
      !mergedRemoteStand.conflict &&
      mergedRemoteStand.workspace.records[0].gate === 3 &&
      mergedRemoteStand.workspace.records[0].stand === 9 &&
      mergedRemoteStand.workspace.pendingOps.length === 1 &&
      mergedRemoteStand.workspace.pendingOps[0].record.gate === 3 &&
      mergedRemoteStand.workspace.syncMeta.lastServerSeq === 13,
    `different-field remote changes should merge without clearing local pending edits, got ${JSON.stringify({
      records: mergedRemoteStand.workspace.records,
      pendingOps: mergedRemoteStand.workspace.pendingOps,
      syncMeta: mergedRemoteStand.workspace.syncMeta,
    })}`
  );
  const remoteGateEvent = {
    ...remoteStandEvent,
    eventId: 'remote-gate',
    opId: 'remote-gate-op',
    serverSeq: 14,
    changedFields: ['gate'],
    opPayload: {
      type: 'flightRecord',
      record: { id: 'EM-1', route: 'DAD', gate: 7, stand: 5, status: 'active' },
      baseFieldVersions: { gate: 12 },
    },
  };
  const conflictedRemoteGate = mergeRemoteSeasonEvent(dirtyEntityMergeWorkspace, remoteGateEvent, { clientId: 'client-local' });
  assert(
    !conflictedRemoteGate.applied &&
      conflictedRemoteGate.conflict &&
      conflictedRemoteGate.workspace.records[0].gate === 3 &&
      conflictedRemoteGate.workspace.syncMeta.conflicts.length === 1 &&
      conflictedRemoteGate.workspace.syncMeta.conflicts[0].overlappingFields[0] === 'gate',
    `same-field remote changes should create review items while preserving local value, got ${JSON.stringify(conflictedRemoteGate.workspace.syncMeta.conflicts)}`
  );
  const acceptedRemoteGate = resolveSeasonConflict(
    conflictedRemoteGate.workspace,
    conflictedRemoteGate.workspace.syncMeta.conflicts[0].id,
    'acceptRemote'
  );
  assert(
    acceptedRemoteGate.records[0].gate === 7 &&
      acceptedRemoteGate.syncMeta.conflicts.length === 0,
    `accepting remote conflict should apply remote field and clear review item, got ${JSON.stringify({
      records: acceptedRemoteGate.records,
      conflicts: acceptedRemoteGate.syncMeta.conflicts,
    })}`
  );
  const manualReviewGate = resolveSeasonConflict(
    conflictedRemoteGate.workspace,
    conflictedRemoteGate.workspace.syncMeta.conflicts[0].id,
    'editManually'
  );
  assert(
    manualReviewGate.records[0].gate === 3 &&
      manualReviewGate.syncMeta.conflicts.length === 1,
    `manual conflict review should preserve local value and keep the review item visible, got ${JSON.stringify({
      records: manualReviewGate.records,
      conflicts: manualReviewGate.syncMeta.conflicts,
    })}`
  );
  const modDirtyWorkspace = rebuildPendingOpsFromBaseline(createLocalWorkspace({
    season: { id: 'entity-merge-season', seasonCode: 'S26', dataVersion: 8 },
    rows: [],
    records: [],
    modifications: new Map([['LEG-1', { legId: 'LEG-1', action: 'modified', gate: 4 }]]),
    modHistory: [],
    baseModificationEntries: [['LEG-1', { legId: 'LEG-1', action: 'modified', gate: 2 }]],
    entityVersions: { 'modification:LEG-1': { gate: 12, __delete__: 12 } },
    syncMeta: {
      baseServerVersion: 8,
      lastServerSeq: 12,
      clientId: 'client-local',
      localRevision: 1,
      pendingCount: 1,
      lastLocalChangeAt: 600,
      syncStatus: 'dirty',
    },
  }), 600);
  const remoteDeleteEvent = {
    eventId: 'remote-delete',
    seasonId: 'entity-merge-season',
    clientId: 'client-remote',
    opId: 'remote-delete-op',
    actorUserId: 'remote-user',
    serverSeq: 15,
    targetType: 'modification',
    targetId: 'LEG-1',
    changedFields: ['__delete__'],
    opPayload: {
      type: 'modificationDelete',
      legId: 'LEG-1',
      baseFieldVersions: { __delete__: 12 },
    },
    createdAt: '2026-05-20T00:00:00.000Z',
  };
  const deleteVsEdit = mergeRemoteSeasonEvent(modDirtyWorkspace, remoteDeleteEvent, { clientId: 'client-local' });
  assert(
    deleteVsEdit.conflict &&
      deleteVsEdit.workspace.modifications.get('LEG-1').gate === 4,
    `delete-vs-edit remote changes should require review and preserve local modification, got ${JSON.stringify({
      conflicts: deleteVsEdit.workspace.syncMeta.conflicts,
      modifications: Array.from(deleteVsEdit.workspace.modifications.entries()),
    })}`
  );
  const ownRealtimeEvent = mergeRemoteSeasonEvent(dirtyEntityMergeWorkspace, { ...remoteStandEvent, clientId: 'client-local' }, { clientId: 'client-local' });
  assert(ownRealtimeEvent.skipped && !ownRealtimeEvent.applied, `own realtime event should be ignored, got ${JSON.stringify(ownRealtimeEvent)}`);
  assert(typeof applySeasonEventRange === 'function', 'seasonChangeEvents must expose applySeasonEventRange for deterministic cursor catch-up');
  const ownRangeWorkspace = applySeasonEventRange(dirtyEntityMergeWorkspace, [
    { ...remoteStandEvent, clientId: 'client-local', serverSeq: 16 },
  ], { clientId: 'client-local' }).workspace;
  assert(
    ownRangeWorkspace.records[0].stand === 5 &&
      ownRangeWorkspace.syncMeta.lastServerSeq === 16 &&
      ownRangeWorkspace.entityVersions['flightRecord:EM-1'].stand === 16 &&
      ownRangeWorkspace.syncMeta.appliedEventIds.includes('remote-stand'),
    `own events received through catch-up must advance cursor and entity field versions without duplicating data, got ${JSON.stringify({
      records: ownRangeWorkspace.records,
      entityVersions: ownRangeWorkspace.entityVersions,
      syncMeta: ownRangeWorkspace.syncMeta,
    })}`
  );
  assert(typeof mergeSeasonSnapshotIntoLocalWorkspace === 'function', 'seasonChangeEvents must expose mergeSeasonSnapshotIntoLocalWorkspace for large backlog snapshot catch-up');
  const snapshotServerWorkspace = createLocalWorkspace({
    season: { id: 'entity-merge-season', seasonCode: 'S26', dataVersion: 9 },
    rows: [],
    records: [{ id: 'EM-1', route: 'DAD', gate: 1, stand: 11, status: 'active' }],
    modifications: new Map(),
    modHistory: [],
    entityVersions: { 'flightRecord:EM-1': { gate: 12, stand: 18 } },
    serverEventHighWater: 18,
  });
  const cleanSnapshotMerged = mergeSeasonSnapshotIntoLocalWorkspace(entityMergeWorkspace, snapshotServerWorkspace, { clientId: 'client-local' });
  assert(
    cleanSnapshotMerged.records[0].stand === 11 &&
      cleanSnapshotMerged.pendingOps.length === 0 &&
      cleanSnapshotMerged.syncMeta.lastServerSeq === 18 &&
      cleanSnapshotMerged.entityVersions['flightRecord:EM-1'].stand === 18,
    `clean snapshot catch-up should replace local baseline and working copy, got ${JSON.stringify({
      records: cleanSnapshotMerged.records,
      pendingOps: cleanSnapshotMerged.pendingOps,
      syncMeta: cleanSnapshotMerged.syncMeta,
      entityVersions: cleanSnapshotMerged.entityVersions,
    })}`
  );
  const dirtySnapshotMerged = mergeSeasonSnapshotIntoLocalWorkspace(dirtyEntityMergeWorkspace, snapshotServerWorkspace, { clientId: 'client-local' });
  assert(
    dirtySnapshotMerged.records[0].gate === 3 &&
      dirtySnapshotMerged.records[0].stand === 11 &&
      dirtySnapshotMerged.pendingOps.length === 1 &&
      dirtySnapshotMerged.pendingOps[0].type === 'flightRecord' &&
      dirtySnapshotMerged.pendingOps[0].record.gate === 3 &&
      dirtySnapshotMerged.syncMeta.lastServerSeq === 18 &&
      (dirtySnapshotMerged.syncMeta.conflicts?.length ?? 0) === 0,
    `dirty snapshot catch-up should preserve local non-conflicting edits while replacing remote baseline fields, got ${JSON.stringify({
      records: dirtySnapshotMerged.records,
      pendingOps: dirtySnapshotMerged.pendingOps,
      syncMeta: dirtySnapshotMerged.syncMeta,
    })}`
  );
  const conflictingSnapshotWorkspace = createLocalWorkspace({
    season: { id: 'entity-merge-season', seasonCode: 'S26', dataVersion: 10 },
    rows: [],
    records: [{ id: 'EM-1', route: 'DAD', gate: 8, stand: 11, status: 'active' }],
    modifications: new Map(),
    modHistory: [],
    entityVersions: { 'flightRecord:EM-1': { gate: 19, stand: 18 } },
    serverEventHighWater: 19,
  });
  const conflictSnapshotMerged = mergeSeasonSnapshotIntoLocalWorkspace(dirtyEntityMergeWorkspace, conflictingSnapshotWorkspace, { clientId: 'client-local' });
  assert(
    conflictSnapshotMerged.records[0].gate === 3 &&
      conflictSnapshotMerged.records[0].stand === 11 &&
      conflictSnapshotMerged.pendingOps.length === 1 &&
      (conflictSnapshotMerged.syncMeta.conflicts?.length ?? 0) === 1 &&
      conflictSnapshotMerged.syncMeta.conflicts[0].overlappingFields[0] === 'gate' &&
      conflictSnapshotMerged.syncMeta.syncStatus === 'dirty',
    `dirty snapshot catch-up should create review items only for same-field newer server versions, got ${JSON.stringify({
      records: conflictSnapshotMerged.records,
      pendingOps: conflictSnapshotMerged.pendingOps,
      syncMeta: conflictSnapshotMerged.syncMeta,
    })}`
  );
  const snapshotSourceRow = baseRow({
    rowIndex: 77,
    effective: '01-Apr-26',
    discontinue: '08-Apr-26',
    daysOfWeek: [false, false, true, false, false, false, false],
    airline: 'VN',
    aircraft: '321',
    sta: '08:00',
    arrFlight: 'VN100',
    arrRoute: 'HAN',
    std: '09:00',
    depFlight: 'VN101',
    depRoute: 'HAN',
  });
  const partialSnapshotWorkspace = createWorkspaceFromRemoteSnapshot({
    season: { id: 'snapshot-hydrate-season', seasonCode: 'S26', dataVersion: 11 },
    sourceRows: [snapshotSourceRow],
    records: [{
      id: 'LEG_D_2026-04-01_77_VN_VN101_HAN_09_00_321',
      date: '2026-04-01',
      operationalDate: '2026-04-01',
      airline: 'VN',
      flightNumber: 'VN101',
      rawFlightNumber: 'VN101',
      route: 'HAN',
      schedule: '09:00',
      aircraft: '321',
      type: 'D',
      sourceSide: 'DEP',
      sourceRowIndex: 77,
      sourceKind: 'imported',
      status: 'active',
      gate: 5,
    }],
    modifications: new Map(),
    modHistory: [],
    cursor: { serverHighWater: 22 },
    entityVersions: {},
  }, { clientId: 'client-local' });
  assert(
    partialSnapshotWorkspace.records.length >= 4 &&
      partialSnapshotWorkspace.baseRecords.length === partialSnapshotWorkspace.records.length &&
      partialSnapshotWorkspace.pendingOps.length === 0 &&
      partialSnapshotWorkspace.records.some((record) => record.gate === 5) &&
      partialSnapshotWorkspace.syncMeta.lastServerSeq === 22,
    `remote snapshot hydration must rebuild generated records instead of shrinking to persisted rows, got ${JSON.stringify({
      records: partialSnapshotWorkspace.records.length,
      baseRecords: partialSnapshotWorkspace.baseRecords.length,
      pendingOps: partialSnapshotWorkspace.pendingOps,
      syncMeta: partialSnapshotWorkspace.syncMeta,
    })}`
  );
  await clearAllLocalSeasonWorkspaces();
  const reviewOnlyWorkspace = createLocalWorkspace({
    season: { id: 'review-only-season', seasonCode: 'S26', dataVersion: 8 },
    rows: [],
    records: [],
    modifications: new Map(),
    modHistory: [],
    pendingOps: [],
    syncMeta: {
      baseServerVersion: 8,
      lastServerSeq: 8,
      localRevision: 1,
      pendingCount: 0,
      lastLocalChangeAt: null,
      syncStatus: 'synced',
      conflicts: [conflictedRemoteGate.workspace.syncMeta.conflicts[0]],
    },
  });
  await saveLocalSeasonWorkspace(reviewOnlyWorkspace);
  const reviewOnlySummary = await getPendingSyncSummary('review-only-season');
  assert(
    reviewOnlySummary.pendingCount === 0 &&
      reviewOnlySummary.conflictCount === 1 &&
      reviewOnlySummary.syncStatus === 'needs_review',
    `pending sync summary must keep unresolved conflicts visible even when no pending ops remain, got ${JSON.stringify(reviewOnlySummary)}`
  );
  const schedulerTimers = [];
  const schedulerClearedTimers = [];
  const schedulerIdleCallbacks = [];
  const schedulerStates = [];
  const schedulerRuns = [];
  let schedulerTimerId = 1;
  let schedulerIdleId = 1;
  let schedulerBlockedReason = null;
  let schedulerOnline = true;
  let schedulerPendingCount = 1;
  const scheduler = new SeasonAutoSyncScheduler({
    setTimeout: (callback, delay) => {
      const id = schedulerTimerId++;
      schedulerTimers.push({ id, callback, delay });
      return id;
    },
    clearTimeout: (id) => schedulerClearedTimers.push(id),
    requestIdleCallback: (callback) => {
      const id = schedulerIdleId++;
      schedulerIdleCallbacks.push({ id, callback });
      return id;
    },
    cancelIdleCallback: (id) => schedulerClearedTimers.push(`idle:${id}`),
    isOnline: () => schedulerOnline,
    getPendingCount: async () => schedulerPendingCount,
    getBlockedReason: () => schedulerBlockedReason,
    run: async (seasonId, mode) => {
      schedulerRuns.push({ seasonId, mode });
      return { status: 'synced', message: 'ok' };
    },
    onState: (seasonId, state) => schedulerStates.push({ seasonId, state }),
  });
  scheduler.notifyLocalChange('manual-season');
  scheduler.notifyLocalChange('manual-season');
  assert(
    schedulerTimers.length === 0 &&
      schedulerIdleCallbacks.length === 0 &&
      schedulerRuns.length === 0 &&
      schedulerStates.some((entry) => entry.seasonId === 'manual-season' && entry.state.status === 'dirty'),
    `sync scheduler must not auto-run local workspace changes, got ${JSON.stringify({ schedulerTimers, schedulerIdleCallbacks, schedulerRuns, schedulerStates })}`
  );
  await scheduler.syncNow('manual-season');
  assert(
    schedulerRuns.length === 1 &&
      schedulerRuns[0].seasonId === 'manual-season' &&
      schedulerRuns[0].mode === 'manual',
    `manual sync should still run on demand, got ${JSON.stringify(schedulerRuns)}`
  );
  schedulerOnline = false;
  scheduler.notifyLocalChange('offline-season');
  assert(
    schedulerStates.some((entry) => entry.seasonId === 'offline-season' && entry.state.status === 'offline'),
    `manual sync scheduler should mark offline seasons without scheduling sync, got ${JSON.stringify(schedulerStates)}`
  );
  schedulerOnline = true;
  schedulerBlockedReason = 'Dragging allocation';
  await scheduler.syncNow('blocked-season');
  assert(
    schedulerRuns.length === 1 &&
      schedulerStates.some((entry) => entry.seasonId === 'blocked-season' && entry.state.status === 'dirty' && entry.state.message === 'Dragging allocation'),
    `manual sync scheduler should respect blockers before runs, got ${JSON.stringify({ schedulerRuns, schedulerStates })}`
  );
  schedulerBlockedReason = null;
  assert(getAutoSyncRetryDelayMs(0) === null && getAutoSyncRetryDelayMs(4) == null, `automatic retry delays should be disabled, got ${AUTO_SYNC_RETRY_DELAYS_MS.join(',')}`);
  assert(isTransientSyncFailure('Failed to fetch') && !isTransientSyncFailure('Server version changed from 1 to 2'), 'transient sync failure classification should stay available for status messaging');
  const mergeMutationWorkspace = createLocalWorkspace({
    season: { id: 'merge-mutation-season', seasonCode: 'S26', dataVersion: 2 },
    rows: [],
    records: [
      { id: 'MERGE-A', route: 'LATEST', linkId: null, linkedRecordId: null, linkType: null },
      { id: 'MERGE-B', route: 'OLD', linkId: null, linkedRecordId: null, linkType: null },
    ],
    modifications: new Map(),
    modHistory: [],
  });
  await saveLocalSeasonWorkspace(mergeMutationWorkspace);
  const mergedMutationWorkspace = await applyLocalFlightRecordMutation(
    'merge-mutation-season',
    {
      records: [
        { id: 'MERGE-A', route: 'STALE', linkId: null, linkedRecordId: null, linkType: null },
        { id: 'MERGE-B', route: 'NEW', linkId: 'PAIR-B', linkedRecordId: 'MERGE-A', linkType: 'sameday' },
      ],
      updatedRecords: [
        { id: 'MERGE-B', route: 'NEW', linkId: 'PAIR-B', linkedRecordId: 'MERGE-A', linkType: 'sameday' },
      ],
    },
    {
      id: 'LOCAL_MERGE_1',
      timestamp: 10,
      description: 'Linked 1 flight occurrence(s)',
      changes: [],
      recordChanges: [],
    }
  );
  const persistedMutationWorkspace = await loadLocalSeasonWorkspace('merge-mutation-season');
  assert(
    mergedMutationWorkspace.records.find((record) => record.id === 'MERGE-A')?.route === 'LATEST' &&
      persistedMutationWorkspace?.records.find((record) => record.id === 'MERGE-A')?.route === 'LATEST',
    `local record mutation should merge changed records into latest workspace without stale overwrite, got ${JSON.stringify(mergedMutationWorkspace.records)}`
  );
  assert(
    mergedMutationWorkspace.records.find((record) => record.id === 'MERGE-B')?.route === 'NEW' &&
      mergedMutationWorkspace.pendingOps.length === 2,
    `local record mutation should persist updated records and history only, got ${JSON.stringify(mergedMutationWorkspace.records)} ${JSON.stringify(mergedMutationWorkspace.pendingOps)}`
  );
  const baselineRecord = {
    id: 'LINK-A',
    linkId: 'PAIR-1',
    linkedRecordId: 'LINK-D',
    linkType: 'sameday',
    route: 'NRT-DAD',
  };
  const linkedBaselineWorkspace = createLocalWorkspace({
    season: { id: 'season-1', seasonCode: 'S26', dataVersion: 2 },
    rows: [],
    records: [baselineRecord],
    modifications: new Map(),
    modHistory: [],
  });
  const relinkedWorkspace = rebuildPendingOpsFromBaseline({
    ...linkedBaselineWorkspace,
    records: [baselineRecord],
    pendingOps: [
      { type: 'flightRecord', record: { ...baselineRecord, linkId: null, linkedRecordId: null, linkType: null } },
      { type: 'flightRecord', record: baselineRecord },
    ],
    syncMeta: { ...linkedBaselineWorkspace.syncMeta, pendingCount: 2, syncStatus: 'dirty' },
  });
  assert(relinkedWorkspace.pendingOps.length === 0 && relinkedWorkspace.syncMeta.pendingCount === 0 && relinkedWorkspace.syncMeta.syncStatus === 'synced', `relinking back to baseline should clear pending ops, got ${JSON.stringify(relinkedWorkspace.syncMeta)} ${JSON.stringify(relinkedWorkspace.pendingOps)}`);
  const undoneModWorkspace = rebuildPendingOpsFromBaseline({
    ...localWorkspace,
    modifications: new Map(localWorkspace.baseModificationEntries),
    modHistory: [...localWorkspace.baseModHistory],
    pendingOps: [
      { type: 'modification', mod: { legId: 'R1', action: 'modified', schedule: '10:00' } },
      { type: 'modificationDelete', legId: 'R1' },
      { type: 'modHistory', entry: { id: 'LOCAL_1', timestamp: 1, description: 'Modified 1 flight(s)', changes: [] } },
    ],
    syncMeta: { ...localWorkspace.syncMeta, pendingCount: 3, syncStatus: 'dirty' },
  });
  assert(undoneModWorkspace.pendingOps.length === 0 && undoneModWorkspace.syncMeta.pendingCount === 0 && undoneModWorkspace.syncMeta.syncStatus === 'synced', `undoing a local mod back to baseline should clear pending modification/history ops, got ${JSON.stringify(undoneModWorkspace.syncMeta)} ${JSON.stringify(undoneModWorkspace.pendingOps)}`);
  const noOpEditBaseline = createLocalWorkspace({
    season: { id: 'season-1', seasonCode: 'S26', dataVersion: 2 },
    rows: [],
    records: [{ id: 'R-SCH', schedule: '09:00', aircraft: '321', route: 'HAN-DAD', codeShares: null }],
    modifications: new Map(),
    modHistory: [],
  });
  const reversedEditWorkspace = rebuildPendingOpsFromBaseline({
    ...noOpEditBaseline,
    modifications: new Map([['R-SCH', { legId: 'R-SCH', action: 'modified', schedule: '09:00', aircraft: '321', codeShares: null }]]),
    modHistory: [{ id: 'LOCAL_2', timestamp: 2, description: 'Modified 1 flight(s)', changes: [] }],
    syncMeta: { ...noOpEditBaseline.syncMeta, pendingCount: 2, syncStatus: 'dirty' },
  });
  assert(reversedEditWorkspace.pendingOps.length === 0 && reversedEditWorkspace.modifications.size === 0 && reversedEditWorkspace.syncMeta.pendingCount === 0, `editing a flight back to its baseline values should remove the no-op mod, got ${JSON.stringify(reversedEditWorkspace.syncMeta)} ${JSON.stringify(Array.from(reversedEditWorkspace.modifications.entries()))}`);
  const discardPendingWorkspace = rebuildPendingOpsFromBaseline(createLocalWorkspace({
    season: { id: 'discard-session-season', seasonCode: 'S26', dataVersion: 8 },
    rows: [{ rowIndex: 1, airline: 'LOCAL' }],
    records: [{ id: 'DISCARD-1', route: 'LOCAL', gate: 4 }],
    modifications: new Map([['DISCARD-1', { legId: 'DISCARD-1', action: 'modified', gate: 4 }]]),
    modHistory: [{ id: 'LOCAL-DISCARD', timestamp: 2, description: 'Local pending edit', changes: [] }],
    baseRows: [{ rowIndex: 1, airline: 'BASE' }],
    baseRecords: [{ id: 'DISCARD-1', route: 'BASE', gate: 2 }],
    baseModificationEntries: [['DISCARD-1', { legId: 'DISCARD-1', action: 'modified', gate: 2 }]],
    baseModHistory: [{ id: 'BASE-DISCARD', timestamp: 1, description: 'Baseline history', changes: [] }],
    syncMeta: {
      baseServerVersion: 8,
      lastServerSeq: 12,
      clientId: 'client-local',
      localRevision: 1,
      pendingCount: 1,
      lastLocalChangeAt: 700,
      syncStatus: 'dirty',
      conflicts: [{ id: 'conflict-1' }],
    },
  }), 700);
  await saveLocalSeasonWorkspace(discardPendingWorkspace);
  const discardedSessionWorkspace = await discardLocalPendingChanges('discard-session-season');
  assert(
    discardedSessionWorkspace &&
      discardedSessionWorkspace.pendingOps.length === 0 &&
      discardedSessionWorkspace.syncMeta.pendingCount === 0 &&
      discardedSessionWorkspace.syncMeta.lastLocalChangeAt === null &&
      discardedSessionWorkspace.syncMeta.baseServerVersion === 8 &&
      discardedSessionWorkspace.syncMeta.lastServerSeq === 12 &&
      discardedSessionWorkspace.syncMeta.clientId === 'client-local' &&
      discardedSessionWorkspace.syncMeta.syncStatus === 'needs_review' &&
      discardedSessionWorkspace.records[0].route === 'BASE' &&
      discardedSessionWorkspace.rows[0].airline === 'BASE' &&
      discardedSessionWorkspace.modifications.get('DISCARD-1')?.gate === 2 &&
      discardedSessionWorkspace.modHistory[0].id === 'BASE-DISCARD',
    `discarding pending local changes should restore baseline workspace data while preserving server sync metadata, got ${JSON.stringify({
      rows: discardedSessionWorkspace?.rows,
      records: discardedSessionWorkspace?.records,
      modifications: Array.from(discardedSessionWorkspace?.modifications.entries() ?? []),
      modHistory: discardedSessionWorkspace?.modHistory,
      syncMeta: discardedSessionWorkspace?.syncMeta,
      pendingOps: discardedSessionWorkspace?.pendingOps,
    })}`
  );
  const discardAllPendingWorkspace = rebuildPendingOpsFromBaseline(createLocalWorkspace({
    season: { id: 'discard-all-season', seasonCode: 'S26', dataVersion: 9 },
    rows: [{ rowIndex: 1, airline: 'LOCAL_ALL' }],
    records: [{ id: 'DISCARD-ALL-1', route: 'LOCAL_ALL', gate: 9 }],
    modifications: new Map(),
    modHistory: [{ id: 'LOCAL-ALL-DISCARD', timestamp: 3, description: 'Local pending all edit', changes: [] }],
    baseRows: [{ rowIndex: 1, airline: 'BASE_ALL' }],
    baseRecords: [{ id: 'DISCARD-ALL-1', route: 'BASE_ALL', gate: 3 }],
    baseModificationEntries: [],
    baseModHistory: [{ id: 'BASE-ALL-DISCARD', timestamp: 2, description: 'Baseline all history', changes: [] }],
    syncMeta: {
      baseServerVersion: 9,
      lastServerSeq: 19,
      clientId: 'client-all-local',
      localRevision: 2,
      pendingCount: 1,
      lastLocalChangeAt: 800,
      syncStatus: 'dirty',
    },
  }), 800);
  await saveLocalSeasonWorkspace(discardAllPendingWorkspace);
  const discardAllSummary = await discardAllLocalPendingChanges();
  const discardedAllWorkspace = await loadLocalSeasonWorkspace('discard-all-season');
  assert(
    discardAllSummary.seasonIds.includes('discard-all-season') &&
      discardAllSummary.discardedCount >= 1 &&
      discardedAllWorkspace &&
      discardedAllWorkspace.pendingOps.length === 0 &&
      discardedAllWorkspace.records[0].route === 'BASE_ALL' &&
      discardedAllWorkspace.syncMeta.lastServerSeq === 19 &&
      discardedAllWorkspace.syncMeta.clientId === 'client-all-local',
    `discardAllLocalPendingChanges should discard unsynced edits while preserving IndexedDB season baseline and sync cursor metadata, got ${JSON.stringify({
      discardAllSummary,
      records: discardedAllWorkspace?.records,
      syncMeta: discardedAllWorkspace?.syncMeta,
      pendingOps: discardedAllWorkspace?.pendingOps,
    })}`
  );
  const linkedRecordsForUndo = [
    { id: 'UNDO-A', linkId: 'L1', linkedRecordId: 'UNDO-D', linkType: 'sameday', route: 'NRT-DAD' },
    { id: 'UNDO-D', linkId: 'L1', linkedRecordId: 'UNDO-A', linkType: 'sameday', route: 'DAD-NRT' },
  ];
  const unlinkedRecordsForUndo = linkedRecordsForUndo.map((record) => ({
    ...record,
    linkId: record.id,
    linkedRecordId: null,
    linkType: null,
  }));
  const recordUndoHistory = [{
    id: 'LOCAL_LINK_1',
    timestamp: 3,
    description: 'Unlinked 2 flight occurrence(s)',
    changes: [],
    recordChanges: unlinkedRecordsForUndo.map((record, index) => ({
      recordId: record.id,
      previousRecord: linkedRecordsForUndo[index],
      newRecord: record,
    })),
  }];
  const restoredRecordHistory = revertFlightRecordHistoryList(unlinkedRecordsForUndo, recordUndoHistory);
  assert(
    JSON.stringify(restoredRecordHistory) === JSON.stringify(linkedRecordsForUndo),
    `record history undo should restore link fields, got ${JSON.stringify(restoredRecordHistory)}`
  );
  const recordOnlyPendingHistoryWorkspace = rebuildPendingOpsFromBaseline({
    ...linkedBaselineWorkspace,
    records: unlinkedRecordsForUndo,
    modHistory: recordUndoHistory,
  });
  assert(
    recordOnlyPendingHistoryWorkspace.pendingOps.some((op) => op.type === 'flightRecord') &&
      recordOnlyPendingHistoryWorkspace.pendingOps.some((op) => op.type === 'modHistory'),
    `record-only link/unlink changes should queue record and history ops, got ${JSON.stringify(recordOnlyPendingHistoryWorkspace.pendingOps)}`
  );
  assert(formatLinkedFlightTime('01:30', 'overnight', 'D') === '01:30 +1', `overnight linked DEP time should show +1, got ${formatLinkedFlightTime('01:30', 'overnight', 'D')}`);
  assert(formatLinkedFlightTime('23:30', 'overnight', 'A') === '23:30 -1', `overnight linked ARR time should show -1, got ${formatLinkedFlightTime('23:30', 'overnight', 'A')}`);
  assert(formatLinkedFlightTime('10:15', 'sameday', 'D') === '10:15', `same-day linked time should not show offset, got ${formatLinkedFlightTime('10:15', 'sameday', 'D')}`);
  assert(formatLinkedFlightTime('', 'overnight', 'D') === '—', `missing linked time should use placeholder, got ${formatLinkedFlightTime('', 'overnight', 'D')}`);
  const aprilCalendar = [
    null, null, '2026-04-01', '2026-04-02', '2026-04-03', '2026-04-04', '2026-04-05',
    '2026-04-06', '2026-04-07', '2026-04-08', '2026-04-09', '2026-04-10', '2026-04-11', '2026-04-12',
    '2026-04-13', '2026-04-14', '2026-04-15', '2026-04-16', '2026-04-17', '2026-04-18', '2026-04-19',
    '2026-04-20', '2026-04-21', '2026-04-22', '2026-04-23', '2026-04-24', '2026-04-25', '2026-04-26',
    '2026-04-27', '2026-04-28', '2026-04-29', '2026-04-30', null, null, null,
  ];
  const mondayColumnSelection = buildSpatialCalendarDateSelection(aprilCalendar, '2026-04-06', '2026-04-27');
  assert(
    JSON.stringify(mondayColumnSelection) === JSON.stringify(['2026-04-06', '2026-04-13', '2026-04-20', '2026-04-27']),
    `same-column sweep should select only Mondays, got ${JSON.stringify(mondayColumnSelection)}`
  );
  const spatialBlockSelection = buildSpatialCalendarDateSelection(aprilCalendar, '2026-04-06', '2026-04-22');
  assert(
    JSON.stringify(spatialBlockSelection) === JSON.stringify([
      '2026-04-06', '2026-04-07', '2026-04-08',
      '2026-04-13', '2026-04-14', '2026-04-15',
      '2026-04-20', '2026-04-21', '2026-04-22',
    ]),
    `multi-column sweep should select the spatial rectangle only, got ${JSON.stringify(spatialBlockSelection)}`
  );
  assert(
    JSON.stringify(mergeCalendarDateSelections(['2026-04-06', '2026-04-13'], ['2026-04-20'], 'append')) ===
      JSON.stringify(['2026-04-06', '2026-04-13', '2026-04-20']),
    'Ctrl-drag sweep should append a new validity vector instead of replacing existing dates'
  );
  assert(
    JSON.stringify(mergeCalendarDateSelections(['2026-04-06', '2026-04-13'], ['2026-04-20'], 'replace')) ===
      JSON.stringify(['2026-04-20']),
    'plain drag sweep should replace the active validity vector'
  );
  const discreteNewFlightDates = normalizeNewFlightDateSelection({ kind: 'dates', dates: ['2026-04-20', '2026-04-06', '2026-04-20'] });
  assert(
    JSON.stringify(discreteNewFlightDates) === JSON.stringify(['2026-04-06', '2026-04-20']),
    `new flight discrete date selection should de-duplicate and sort dates, got ${JSON.stringify(discreteNewFlightDates)}`
  );
  const rangedNewFlightDates = normalizeNewFlightDateSelection({ kind: 'range', dates: ['2026-04-06', '2026-04-08'] });
  assert(
    JSON.stringify(rangedNewFlightDates) === JSON.stringify(['2026-04-06', '2026-04-07', '2026-04-08']),
    `new flight date range selection should expand inclusively, got ${JSON.stringify(rangedNewFlightDates)}`
  );
  const detailedNewFlightMods = buildDetailedNewFlightModifications({
    dates: discreteNewFlightDates,
    airline: 'VJ',
    flightType: 'turnaround',
    aircraft: '321',
    category: 'J',
    arrFlightNum: '55',
    arrRoute: 'SGN-DAD',
    arrTime: '09:00',
    arrCodeShares: '',
    depFlightNum: '56',
    depRoute: 'DAD-SGN',
    depTime: '10:00',
    depCodeShares: '',
    idSeed: 'TEST',
  });
  assert(detailedNewFlightMods.length === 4, `turnaround new flight should create ARR+DEP mods for each selected date, got ${detailedNewFlightMods.length}`);
  assert(
    detailedNewFlightMods.filter((mod) => mod.addedLeg?.date === '2026-04-06').length === 2 &&
      detailedNewFlightMods.filter((mod) => mod.addedLeg?.date === '2026-04-20').length === 2,
    `new flight mods should cover every selected date, got ${JSON.stringify(detailedNewFlightMods.map((mod) => mod.addedLeg?.date))}`
  );
  const qzAddedMods = buildDetailedNewFlightModifications({
    dates: ['2026-05-18', '2026-05-25', '2026-06-01'],
    airline: 'QZ',
    flightType: 'turnaround',
    aircraft: '320',
    category: 'J',
    arrFlightNum: '480',
    arrRoute: 'DPS',
    arrTime: '18:35',
    arrCodeShares: '',
    depFlightNum: '481',
    depRoute: 'DPS',
    depTime: '19:05',
    depCodeShares: '',
    idSeed: 'QZ_EXPORT',
  });
  const qzAddedRecords = addedModificationsToFlightRecords(qzAddedMods);
  assert(
    qzAddedRecords.length === qzAddedMods.length &&
      qzAddedRecords.every((record) => record.sourceKind === 'added' && record.status === 'active' && record.action == null),
    `Detailed-added flight payloads should become canonical local records, got ${JSON.stringify(qzAddedRecords)}`
  );
  const dailyCanonicalInput = buildDetailedNewFlightModifications({
    dates: ['2026-05-08'],
    airline: 'VJ',
    flightType: 'departure',
    aircraft: '321',
    category: 'J',
    arrFlightNum: '',
    arrRoute: '',
    arrTime: '',
    arrCodeShares: '',
    depFlightNum: '827',
    depRoute: 'DAD-SGN',
    depTime: '08:00',
    depCodeShares: '',
    idSeed: 'CANONICAL_DAILY',
  });
  const detailedCanonicalInput = buildDetailedNewFlightModifications({
    dates: ['2026-05-08'],
    airline: 'VJ',
    flightType: 'departure',
    aircraft: '321',
    category: 'J',
    arrFlightNum: '',
    arrRoute: '',
    arrTime: '',
    arrCodeShares: '',
    depFlightNum: '827',
    depRoute: 'DAD-SGN',
    depTime: '08:00',
    depCodeShares: '',
    idSeed: 'CANONICAL_DAILY',
  });
  const dailyCanonicalRecords = buildCanonicalAddedFlightRecords(dailyCanonicalInput);
  const detailedCanonicalRecords = buildCanonicalAddedFlightRecords(detailedCanonicalInput);
  const canonicalRecordKeys = Object.keys(dailyCanonicalRecords[0] ?? {}).sort();
  assert(
    dailyCanonicalRecords.length === 1 &&
      JSON.stringify(dailyCanonicalRecords) === JSON.stringify(detailedCanonicalRecords) &&
      JSON.stringify(canonicalRecordKeys) === JSON.stringify(Object.keys(detailedCanonicalRecords[0] ?? {}).sort()) &&
      dailyCanonicalRecords.every((record) =>
        record.sourceKind === 'added' &&
        record.sourceSide === 'DEP' &&
        record.status === 'active' &&
        record.action === null &&
        record.counter === null &&
        !findUndefinedPath(record)
      ),
    `Daily and Detailed new-flight commits must share one canonical FlightRecord shape, got ${JSON.stringify({ dailyCanonicalRecords, detailedCanonicalRecords })}`
  );
  const qzAddedPatternGroups = groupFlightLegs(flightRecordsToLegs(qzAddedRecords));
  const qzAddedExportGroups = qzAddedPatternGroups.map(rowSummary);
  assert(
    qzAddedExportGroups.some((group) =>
      group.arr === '480' &&
      group.dep === '481' &&
      group.effective === '2026-05-18' &&
      group.discontinue === '2026-06-01'
    ),
    `Detailed-added QZ turnaround records should be visible to Seasonal export, got ${JSON.stringify(qzAddedExportGroups)}`
  );
  const qzExportRows = await workbookRowsFromBlob(exportToExcel(qzAddedPatternGroups, 'S26'));
  assert(
    qzExportRows.some((row) =>
      row.ARRFlight === '480' &&
      row.DEPFlight === '481' &&
      row.ARRFlightType === 'PAX' &&
      row.DEPFlightType === 'PAX'
    ),
    `exported ARRFlightType and DEPFlightType should be PAX for added QZ pairs, got ${JSON.stringify(qzExportRows)}`
  );
  const schemaSourceRow = baseRow({
    rowIndex: 301,
    arrFlight: '480',
    arrFlightType: 'J',
    arrFlightCategory: 'C',
    arrRoute: 'DPS',
    sta: '18:35',
    depFlight: '481',
    depFlightType: 'CARGO',
    depFlightCategory: 'G',
    depRoute: 'DPS',
    std: '19:05',
  });
  const persistedSourceRow = serializeSourceRowForPersistence(schemaSourceRow);
  assert(
    !Object.prototype.hasOwnProperty.call(persistedSourceRow, 'arrFlightType') &&
      !Object.prototype.hasOwnProperty.call(persistedSourceRow, 'depFlightType') &&
      persistedSourceRow.arrFlightCategory === 'C' &&
      persistedSourceRow.depFlightCategory === 'G',
    `persisted source rows should omit FlightType and keep FlightCategory, got ${JSON.stringify(persistedSourceRow)}`
  );
  const hydratedSourceRow = hydrateSourceRowFromPersistence(persistedSourceRow);
  assert(
    hydratedSourceRow.arrFlightType === null &&
      hydratedSourceRow.depFlightType === null &&
      hydratedSourceRow.arrFlightCategory === 'C' &&
      hydratedSourceRow.depFlightCategory === 'G',
    `hydrated source rows should provide nullable compatibility FlightType and keep categories, got ${JSON.stringify(hydratedSourceRow)}`
  );
  const persistedFlightRecord = serializeFlightRecordForPersistence({ ...qzAddedRecords[0], category: 'G', flightType: 'J' });
  assert(
    !Object.prototype.hasOwnProperty.call(persistedFlightRecord, 'flightType') &&
      persistedFlightRecord.category === 'G',
    `persisted flight records should omit flightType and keep category, got ${JSON.stringify(persistedFlightRecord)}`
  );
  const hydratedFlightRecord = hydrateFlightRecordFromPersistence(persistedFlightRecord);
  assert(
    hydratedFlightRecord.flightType === 'PAX' &&
      hydratedFlightRecord.category === 'G',
    `hydrated flight records should use application-layer PAX and keep category, got ${JSON.stringify(hydratedFlightRecord)}`
  );
  assert(
    hydratedFlightRecord.pax === null &&
      hydratedFlightRecord.gate === null &&
      hydratedFlightRecord.stand === null &&
      hydratedFlightRecord.counter === null &&
      hydratedFlightRecord.carousel === null &&
      hydratedFlightRecord.mct === null &&
      hydratedFlightRecord.fb === null &&
      hydratedFlightRecord.lb === null &&
      hydratedFlightRecord.bhs === null &&
      hydratedFlightRecord.ghs === null,
    `legacy hydrated flight records should default operational fields to null, got ${JSON.stringify(hydratedFlightRecord)}`
  );
  const operationalFlightRecord = {
    ...qzAddedRecords[0],
    pax: 180,
    gate: 4,
    stand: 12,
    counter: ['M1', 'M2', 3],
    carousel: 6,
    mct: '06:15',
    fb: '06:45',
    lb: '07:10',
    bhs: 'BHS-A',
    ghs: 'GHS-OPS',
  };
  const persistedOperationalRecord = serializeFlightRecordForPersistence(operationalFlightRecord);
  assert(
    persistedOperationalRecord.pax === 180 &&
      persistedOperationalRecord.gate === 4 &&
      persistedOperationalRecord.stand === 12 &&
      Array.isArray(persistedOperationalRecord.counter) &&
      persistedOperationalRecord.counter[0] === 'M1' &&
      persistedOperationalRecord.carousel === 6 &&
      persistedOperationalRecord.mct === '06:15' &&
      persistedOperationalRecord.fb === '06:45' &&
      persistedOperationalRecord.lb === '07:10' &&
      persistedOperationalRecord.bhs === 'BHS-A' &&
      persistedOperationalRecord.ghs === 'GHS-OPS',
    `persisted flight records should keep operational fields, got ${JSON.stringify(persistedOperationalRecord)}`
  );
  let invalidGateError = null;
  try {
    serializeFlightRecordForPersistence({ ...operationalFlightRecord, gate: 0 });
  } catch (err) {
    invalidGateError = err;
  }
  assert(
    invalidGateError?.message.includes('gate must be a positive integer'),
    `invalid gate values should be rejected, got ${invalidGateError?.message}`
  );
  let invalidCarouselError = null;
  try {
    serializeFlightRecordForPersistence({ ...operationalFlightRecord, carousel: 0 });
  } catch (err) {
    invalidCarouselError = err;
  }
  assert(
    invalidCarouselError?.message.includes('carousel must be a positive integer'),
    `invalid carousel values should be rejected, got ${invalidCarouselError?.message}`
  );
  let invalidMctError = null;
  try {
    serializeFlightRecordForPersistence({ ...operationalFlightRecord, mct: '2026-05-08 06:15' });
  } catch (err) {
    invalidMctError = err;
  }
  assert(
    invalidMctError?.message.includes('mct must use HH:mm format'),
    `invalid mct values should be rejected, got ${invalidMctError?.message}`
  );
  const persistedOperationalMod = serializeFlightModificationForPersistence({
    legId: 'OPS_SCHEMA',
    action: 'modified',
    pax: 120,
    gate: 2,
    stand: 5,
    counter: '1, 2, M3',
    carousel: 4,
    mct: '11:00',
    fb: '11:25',
    lb: '11:45',
    bhs: 'BHS-B',
    ghs: 'GHS-B',
  });
  assert(
    persistedOperationalMod.pax === 120 &&
      persistedOperationalMod.gate === 2 &&
      persistedOperationalMod.stand === 5 &&
      persistedOperationalMod.counter === '1, 2, M3' &&
      persistedOperationalMod.carousel === 4 &&
      persistedOperationalMod.mct === '11:00' &&
      persistedOperationalMod.fb === '11:25' &&
      persistedOperationalMod.lb === '11:45' &&
      persistedOperationalMod.bhs === 'BHS-B' &&
      persistedOperationalMod.ghs === 'GHS-B',
    `persisted modifications should keep operational field overlays, got ${JSON.stringify(persistedOperationalMod)}`
  );
  const persistedCheckInRecord = serializeFlightRecordForPersistence({
    ...operationalFlightRecord,
    id: 'CHECKIN_RECORD',
    checkInStart: '2026-05-08T04:45',
    checkInEnd: '2026-05-08T07:15',
    checkInAllocationMode: 'grouped',
  });
  assert(
    persistedCheckInRecord.checkInStart === '2026-05-08T04:45' &&
      persistedCheckInRecord.checkInEnd === '2026-05-08T07:15' &&
      persistedCheckInRecord.checkInAllocationMode === 'grouped',
    `check-in allocation fields should persist on flight records, got ${JSON.stringify(persistedCheckInRecord)}`
  );

  const hydratedCheckInRecord = hydrateFlightRecordFromPersistence({
    ...persistedCheckInRecord,
    flightType: undefined,
  });
  assert(
    hydratedCheckInRecord.checkInStart === '2026-05-08T04:45' &&
      hydratedCheckInRecord.checkInEnd === '2026-05-08T07:15' &&
      hydratedCheckInRecord.checkInAllocationMode === 'grouped',
    `check-in allocation fields should hydrate on flight records, got ${JSON.stringify(hydratedCheckInRecord)}`
  );

  const persistedCheckInMod = serializeFlightModificationForPersistence({
    legId: 'CHECKIN_RECORD',
    action: 'modified',
    counter: [1, 2, 5],
    checkInStart: '2026-05-08T05:00',
    checkInEnd: '2026-05-08T07:30',
    checkInAllocationMode: 'broken',
    checkInCounterWindows: {
      'N:1': { start: '2026-05-08T05:00', end: '2026-05-08T07:30' },
      'N:2': { start: '2026-05-08T05:15', end: '2026-05-08T07:45' },
    },
  });
  assert(
    Array.isArray(persistedCheckInMod.counter) &&
      persistedCheckInMod.counter.length === 3 &&
      persistedCheckInMod.counter[0] === 1 &&
      persistedCheckInMod.counter[1] === 2 &&
      persistedCheckInMod.counter[2] === 5 &&
      persistedCheckInMod.checkInStart === '2026-05-08T05:00' &&
      persistedCheckInMod.checkInEnd === '2026-05-08T07:30' &&
      persistedCheckInMod.checkInAllocationMode === 'broken' &&
      persistedCheckInMod.checkInCounterWindows?.['N:2']?.start === '2026-05-08T05:15',
    `check-in allocation fields should persist on modifications, got ${JSON.stringify(persistedCheckInMod)}`
  );

  let invalidCheckInTimeError = null;
  try {
    serializeFlightModificationForPersistence({
      legId: 'CHECKIN_INVALID',
      action: 'modified',
      checkInStart: '2026-05-08 05:00',
    });
  } catch (err) {
    invalidCheckInTimeError = err;
  }
  assert(
    invalidCheckInTimeError?.message.includes('checkInStart must use yyyy-mm-ddTHH:mm format'),
    `invalid check-in datetime should be rejected, got ${invalidCheckInTimeError?.message}`
  );
  let invalidCheckInCounterWindowError = null;
  try {
    serializeFlightModificationForPersistence({
      legId: 'CHECKIN_INVALID_COUNTER_WINDOW',
      action: 'modified',
      checkInCounterWindows: {
        'N:1': { start: '2026-05-08 05:00', end: '2026-05-08T07:00' },
      },
    });
  } catch (err) {
    invalidCheckInCounterWindowError = err;
  }
  assert(
    invalidCheckInCounterWindowError?.message.includes('checkInCounterWindows.N:1.start must use yyyy-mm-ddTHH:mm format'),
    `invalid per-counter check-in windows should be rejected, got ${invalidCheckInCounterWindowError?.message}`
  );
  let impossibleCheckInDateError = null;
  try {
    serializeFlightModificationForPersistence({
      legId: 'CHECKIN_IMPOSSIBLE_DATE',
      action: 'modified',
      checkInStart: '2026-02-31T05:00',
    });
  } catch (err) {
    impossibleCheckInDateError = err;
  }
  assert(
    impossibleCheckInDateError?.message.includes('checkInStart must use yyyy-mm-ddTHH:mm format'),
    `impossible check-in dates should be rejected, got ${impossibleCheckInDateError?.message}`
  );
  const persistedAddedMod = serializeFlightModificationForPersistence({
    legId: 'ADD_SCHEMA',
    action: 'added',
    addedLeg: {
      ...qzAddedRecords[0],
      id: 'ADD_SCHEMA',
      category: 'C',
      flightType: 'J',
      pax: 90,
      gate: 8,
      stand: 9,
      counter: [1, 2, 3],
      carousel: 7,
      mct: '12:05',
      fb: '12:25',
      lb: '12:45',
      bhs: 'BHS-C',
      ghs: 'GHS-C',
    },
  });
  assert(
    persistedAddedMod.addedLeg &&
      !Object.prototype.hasOwnProperty.call(persistedAddedMod.addedLeg, 'flightType') &&
      persistedAddedMod.addedLeg.category === 'C' &&
      persistedAddedMod.addedLeg.pax === 90 &&
      persistedAddedMod.addedLeg.gate === 8 &&
      Array.isArray(persistedAddedMod.addedLeg.counter) &&
      persistedAddedMod.addedLeg.carousel === 7 &&
      persistedAddedMod.addedLeg.mct === '12:05',
    `persisted added modifications should omit addedLeg.flightType and keep category, got ${JSON.stringify(persistedAddedMod)}`
  );
  const hydratedAddedMod = hydrateFlightModificationFromPersistence(persistedAddedMod);
  assert(
    hydratedAddedMod.addedLeg?.flightType === 'PAX' &&
      hydratedAddedMod.addedLeg.category === 'C',
    `hydrated added modifications should restore application-layer PAX and keep category, got ${JSON.stringify(hydratedAddedMod)}`
  );
  const persistedModHistoryWithoutRecordChanges = serializeModHistoryEntryForPersistence({
    id: 'LOCAL_SCHEMA_HISTORY',
    timestamp: 1,
    description: 'Modified one flight',
    changes: [
      {
        legId: 'QZ480',
        previousMod: null,
        newMod: { legId: 'QZ480', action: 'modified', schedule: '18:40' },
      },
    ],
  });
  const undefinedPath = findUndefinedPath(persistedModHistoryWithoutRecordChanges);
  assert(
    undefinedPath == null &&
      !Object.prototype.hasOwnProperty.call(persistedModHistoryWithoutRecordChanges, 'recordChanges'),
    `persisted mod history should omit undefined optional fields, found ${undefinedPath} in ${JSON.stringify(persistedModHistoryWithoutRecordChanges)}`
  );
  const oversizedDailyImportHistory = {
    id: 'LOCAL_DAILY_IMPORT_BIG',
    timestamp: 1778211390297,
    description: 'Daily import: updated 0, inserted 2500',
    changes: [],
    recordChanges: Array.from({ length: 2500 }, (_, index) => ({
      recordId: `DAILY_IMPORT_BIG_${index}`,
      previousRecord: null,
      newRecord: {
        ...qzAddedRecords[0],
        id: `DAILY_IMPORT_BIG_${index}`,
        linkId: `DAILY_IMPORT_BIG_${index}`,
        flightNumber: `QZ${String(index + 1).padStart(4, '0')}`,
        rawFlightNumber: String(index + 1).padStart(4, '0'),
        date: `2026-05-${String((index % 28) + 1).padStart(2, '0')}`,
      },
    })),
  };
  assert(
    estimateModHistoryEntryBytes(oversizedDailyImportHistory) > FIRESTORE_MOD_HISTORY_SAFE_BYTES,
    'oversized daily import fixture should exceed the conservative Firestore history size cap'
  );
  const splitDailyImportHistory = splitModHistoryEntryForFirestore(oversizedDailyImportHistory);
  assert(
    splitDailyImportHistory.length > 1 &&
      splitDailyImportHistory.every((entry) => estimateModHistoryEntryBytes(entry) <= FIRESTORE_MOD_HISTORY_SAFE_BYTES) &&
      splitDailyImportHistory.flatMap((entry) => entry.recordChanges ?? []).length === oversizedDailyImportHistory.recordChanges.length &&
      new Set(splitDailyImportHistory.map((entry) => entry.id)).size === splitDailyImportHistory.length,
    `oversized modHistory entries should split into unique Firestore-safe documents, got ${JSON.stringify(splitDailyImportHistory.map((entry) => ({ id: entry.id, bytes: estimateModHistoryEntryBytes(entry), records: entry.recordChanges?.length ?? 0 })))}`
  );
  const smallHistory = {
    id: 'LOCAL_DAILY_IMPORT_SMALL',
    timestamp: 1,
    description: 'Daily import small',
    changes: [],
    recordChanges: [oversizedDailyImportHistory.recordChanges[0]],
  };
  const splitSmallHistory = splitModHistoryEntryForFirestore(smallHistory);
  assert(
    splitSmallHistory.length === 1 && splitSmallHistory[0].id === smallHistory.id,
    `small modHistory entries should keep their original id, got ${JSON.stringify(splitSmallHistory)}`
  );
  const qzSelectedAddedLegs = includeLinkedLegsForExport(flightRecordsToLegs(qzAddedRecords), [qzAddedRecords[0].id]);
  assert(
    qzSelectedAddedLegs.some((leg) => leg.rawFlightNumber === '481') &&
      groupFlightLegs(qzSelectedAddedLegs).some((group) => group.arrFlightNumber === '480' && group.depFlightNumber === '481'),
    `selected Seasonal export should include Detailed-added linked counterpart legs, got ${JSON.stringify(qzSelectedAddedLegs)}`
  );
  const seasonalRecord = (overrides) => ({
    id: overrides.id,
    linkId: overrides.id,
    type: overrides.type,
    airline: overrides.airline ?? 'VN',
    flightNumber: `${overrides.airline ?? 'VN'}${overrides.rawFlightNumber.padStart(3, '0')}`,
    rawFlightNumber: overrides.rawFlightNumber,
    requestStatusCode: null,
    route: overrides.route ?? (overrides.type === 'A' ? 'NRT-DAD' : 'DAD-NRT'),
    schedule: overrides.schedule,
    aircraft: overrides.aircraft ?? '321',
    category: 'J',
    flightType: 'J',
    codeShares: null,
    intDomInd: null,
    pax: overrides.pax ?? null,
    gate: null,
    stand: null,
    counter: null,
    carousel: null,
    mct: null,
    fb: null,
    lb: null,
    bhs: null,
    ghs: null,
    date: overrides.date,
    dayOfWeek: 1,
    action: null,
    sourceRowIndex: overrides.sourceRowIndex ?? 1,
    sourceKind: 'imported',
    sourceSide: overrides.type === 'A' ? 'ARR' : 'DEP',
    status: 'active',
  });
  const seasonalCandidates = buildSeasonalLinkCandidates([
    seasonalRecord({ id: 'A1', type: 'A', rawFlightNumber: '100', date: '2026-03-30', schedule: '23:00' }),
    seasonalRecord({ id: 'A2', type: 'A', rawFlightNumber: '100', date: '2026-03-31', schedule: '23:00' }),
    seasonalRecord({ id: 'A3', type: 'A', rawFlightNumber: '100', date: '2026-04-01', schedule: '23:00' }),
    seasonalRecord({ id: 'D1', type: 'D', rawFlightNumber: '101', date: '2026-03-31', schedule: '01:00' }),
    seasonalRecord({ id: 'D2', type: 'D', rawFlightNumber: '101', date: '2026-04-01', schedule: '01:00' }),
    seasonalRecord({ id: 'D3', type: 'D', rawFlightNumber: '102', date: '2026-03-30', schedule: '23:30' }),
  ], {
    airline: 'VN',
    side: 'A',
    arrFlightNumber: '100',
    depFlightNumber: null,
    recordIds: ['A1', 'A2', 'A3'],
  });
  const overnightCandidate = seasonalCandidates.find((candidate) => candidate.flightNumber === 'VN101');
  assert(overnightCandidate?.linkType === 'overnight', `seasonal link should infer overnight candidate, got ${JSON.stringify(seasonalCandidates)}`);
  assert(
    JSON.stringify(overnightCandidate.arrIds) === JSON.stringify(['A1', 'A2']) &&
    JSON.stringify(overnightCandidate.depIds) === JSON.stringify(['D1', 'D2']),
    `seasonal link should include all matching overnight periods only, got ${JSON.stringify(overnightCandidate)}`
  );
  assert(overnightCandidate.effective === '2026-03-30' && overnightCandidate.discontinue === '2026-03-31', `seasonal link candidate should expose matched period, got ${JSON.stringify(overnightCandidate)}`);
  const displayGroupsFromLocal = buildSeasonalDisplayGroups([
    seasonalRecord({ id: 'DG-A1', type: 'A', rawFlightNumber: '100', date: '2026-03-30', schedule: '23:00' }),
    seasonalRecord({ id: 'DG-D1', type: 'D', rawFlightNumber: '101', date: '2026-03-31', schedule: '01:00' }),
  ], new Map());
  assert(displayGroupsFromLocal.length === 2, `seasonal display aggregator should be side-specific UI only, got ${JSON.stringify(displayGroupsFromLocal)}`);
  assert(displayGroupsFromLocal[0].recordIds.length === 1 && displayGroupsFromLocal[0].validityPeriods[0] === '2026-03-30 - 2026-03-30', `display group should expose compact UI fields, got ${JSON.stringify(displayGroupsFromLocal[0])}`);

  const dashboardRecords = [
    seasonalRecord({ id: 'DASH-JUN-VJ1', type: 'D', airline: 'VJ', rawFlightNumber: '101', route: 'ICN', aircraft: '321', date: '2026-06-03', schedule: '10:00', pax: 180 }),
    seasonalRecord({ id: 'DASH-JUN-VN1', type: 'A', airline: 'VN', rawFlightNumber: '201', route: 'BKK', aircraft: '320', date: '2026-06-04', schedule: '23:30', pax: 140 }),
    seasonalRecord({ id: 'DASH-JUL-VJ1', type: 'D', airline: 'VJ', rawFlightNumber: '101', route: 'ICN', aircraft: '321', date: '2026-07-03', schedule: '11:00', pax: 190 }),
    seasonalRecord({ id: 'DASH-JUL-VJ2', type: 'A', airline: 'VJ', rawFlightNumber: '102', route: 'ICN', aircraft: '321', date: '2026-07-04', schedule: '12:00', pax: 170 }),
    seasonalRecord({ id: 'DASH-JUL-AK1', type: 'D', airline: 'AK', rawFlightNumber: '301', route: 'KUL', aircraft: '320', date: '2026-07-05', schedule: '19:00', pax: 160 }),
    seasonalRecord({ id: 'DASH-W31-VJ1', type: 'D', airline: 'VJ', rawFlightNumber: '401', route: 'ICN', aircraft: '321', date: '2026-08-01', schedule: '08:00', pax: 180 }),
    seasonalRecord({ id: 'DASH-W32-VJ1', type: 'D', airline: 'VJ', rawFlightNumber: '401', route: 'ICN', aircraft: '321', date: '2026-08-04', schedule: '01:00', pax: 185 }),
    seasonalRecord({ id: 'DASH-W32-UO1', type: 'A', airline: 'UO', rawFlightNumber: '501', route: 'HKG', aircraft: '333', date: '2026-08-05', schedule: '03:30', pax: 210 }),
  ];
  const effectiveDashboardRecords = buildEffectiveDashboardRecords(dashboardRecords, new Map([
    ['DASH-JUL-AK1', { legId: 'DASH-JUL-AK1', action: 'deleted' }],
    ['DASH-JUL-VJ2', { legId: 'DASH-JUL-VJ2', action: 'modified', route: 'PUS', pax: 175 }],
    ['DASH-JUL-ADD1', { legId: 'DASH-JUL-ADD1', action: 'added', addedLeg: seasonalRecord({ id: 'DASH-JUL-ADD1', type: 'D', airline: 'VN', rawFlightNumber: '777', route: 'ICN', aircraft: '789', date: '2026-07-06', schedule: '14:00', pax: 230 }) }],
  ]));
  assert(!effectiveDashboardRecords.some((record) => record.id === 'DASH-JUL-AK1'), `dashboard effective records should remove deleted legs, got ${JSON.stringify(effectiveDashboardRecords)}`);
  assert(effectiveDashboardRecords.find((record) => record.id === 'DASH-JUL-VJ2')?.route === 'PUS', `dashboard effective records should apply modified fields, got ${JSON.stringify(effectiveDashboardRecords.find((record) => record.id === 'DASH-JUL-VJ2'))}`);
  assert(effectiveDashboardRecords.some((record) => record.id === 'DASH-JUL-ADD1'), `dashboard effective records should include added legs, got ${JSON.stringify(effectiveDashboardRecords)}`);
  assert(normalizeRouteCode(' icn ') === 'ICN', `route-country lookup should normalize route codes, got ${normalizeRouteCode(' icn ')}`);
  assert(resolveCountryForRoute('ICN') === 'Korea', `ICN should map to Korea, got ${resolveCountryForRoute('ICN')}`);
  assert(resolveCountryForRoute(' bkk ') === 'Thailand', `BKK should map to Thailand with normalization, got ${resolveCountryForRoute(' bkk ')}`);
  assert(resolveCountryForRoute('SIN') === 'Singapore', `SIN should map to Singapore, got ${resolveCountryForRoute('SIN')}`);
  assert(resolveCountryForRoute('RMQ') === 'Taiwan', `RMQ conflict should resolve to Taiwan, got ${resolveCountryForRoute('RMQ')}`);
  assert(resolveCountryForRoute('XXX') === 'Unknown', `missing route should fall back to Unknown, got ${resolveCountryForRoute('XXX')}`);
  assert(resolveCountryForRoute('ICN', [{ route: 'ICN', country: 'South Korea' }]) === 'South Korea', 'route-country lookup should prefer settings overrides');
  const parsedRouteCountryRows = parseRouteCountryRows([
    { Route: ' icn ', Country: 'South Korea' },
    { Routes: 'bkk', Country: 'Thailand' },
    { Route: 'ICN', Country: 'Korea Updated' },
    { Route: '', Country: 'Empty Route' },
  ]);
  assert(
    JSON.stringify(parsedRouteCountryRows.entries) === JSON.stringify([
      { route: 'ICN', country: 'Korea Updated' },
      { route: 'BKK', country: 'Thailand' },
    ]) &&
      JSON.stringify(parsedRouteCountryRows.duplicateRoutes) === JSON.stringify(['ICN']) &&
      parsedRouteCountryRows.invalidRows.length === 1,
    `route-country import parser should normalize headers, routes, duplicates, and invalid rows, got ${JSON.stringify(parsedRouteCountryRows)}`
  );
  const mergedRouteCountries = mergeRouteCountryMappings(
    [
      { route: 'ICN', country: 'Korea' },
      { route: 'HKG', country: 'Hong Kong' },
    ],
    [
      { route: ' icn ', country: 'South Korea' },
      { route: 'bkk', country: 'Thailand' },
    ]
  );
  assert(
    JSON.stringify(mergedRouteCountries) === JSON.stringify([
      { route: 'ICN', country: 'South Korea' },
      { route: 'HKG', country: 'Hong Kong' },
      { route: 'BKK', country: 'Thailand' },
    ]),
    `route-country upload should update existing routes and add new routes without replacing the full map, got ${JSON.stringify(mergedRouteCountries)}`
  );
  const dashboardOverview = buildDashboardOverview({
    records: effectiveDashboardRecords,
    typeFilter: 'all',
    timeBasis: 'local',
    monthFrom: '2026-06',
    monthTo: '2026-08',
    airline: 'all',
    country: 'all',
    route: 'all',
  });
  assert(
    dashboardOverview.kpis.totalFlights === 8 &&
      dashboardOverview.kpis.totalPax === 1490 &&
      dashboardOverview.kpis.avgFlightsPerDay === 1 &&
      dashboardOverview.kpis.peakMonth.key === '2026-07' &&
      dashboardOverview.kpis.peakMonth.flights === 3 &&
      dashboardOverview.kpis.topAirline.key === 'VJ' &&
      dashboardOverview.kpis.topRoute.key === 'ICN',
    `overview KPI row should summarize the filtered season, got ${JSON.stringify(dashboardOverview.kpis)}`
  );
  const julyTrend = dashboardOverview.monthlyTrend.find((row) => row.key === '2026-07');
  assert(julyTrend?.arrivals === 1 && julyTrend.departures === 2 && julyTrend.total === 3, `overview monthly trend should split ARR/DEP, got ${JSON.stringify(dashboardOverview.monthlyTrend)}`);
  assert(dashboardOverview.airlineRanking[0]?.key === 'VJ' && dashboardOverview.airlineRanking[0].flights === 5, `overview airline ranking should use flights and share, got ${JSON.stringify(dashboardOverview.airlineRanking)}`);
  const koreaRouteContribution = dashboardOverview.countryRouteContribution.find((row) => row.country === 'Korea' && row.route === 'ICN');
  assert(koreaRouteContribution?.flights === 5, `overview country/route contribution should map routes to countries, got ${JSON.stringify(dashboardOverview.countryRouteContribution)}`);
  const wednesdayCell = dashboardOverview.weekdayHeatmap.find((cell) => cell.month === '2026-06' && cell.weekday === 'Wed');
  assert(wednesdayCell?.flights === 1 && wednesdayCell.avgFlightsPerDay === 1, `overview heatmap should average flights by month and weekday, got ${JSON.stringify(dashboardOverview.weekdayHeatmap)}`);
  assert(Array.isArray(dashboardOverview.dailyTrend), `overview daily flight trend should be exposed as an array, got ${JSON.stringify(dashboardOverview.dailyTrend)}`);
  const dailyTrendTotal = dashboardOverview.dailyTrend.reduce((sum, row) => sum + row.total, 0);
  const julyPeakDay = dashboardOverview.dailyTrend.find((row) => row.date === '2026-07-06');
  assert(
    dailyTrendTotal === dashboardOverview.kpis.totalFlights &&
      julyPeakDay?.month === '2026-07' &&
      julyPeakDay.day === '06' &&
      julyPeakDay.departures === 1 &&
      julyPeakDay.total === 1,
    `overview daily flight trend should expose daily ARR/DEP rows that reconcile to total flights, got ${JSON.stringify(dashboardOverview.dailyTrend)}`
  );
  assert(dashboardOverview.aircraftMix[0]?.key === '321' && dashboardOverview.aircraftMix[0].flights === 5, `overview equipment mix should rank aircraft types, got ${JSON.stringify(dashboardOverview.aircraftMix)}`);
  assert(
    dashboardOverview.peakHourAverage[0]?.bucket === '05:00' &&
      dashboardOverview.peakHourAverage.at(-1)?.bucket === '04:30' &&
      dashboardOverview.peakHourAverage.reduce((sum, row) => sum + row.flights, 0) === dashboardOverview.kpis.totalFlights &&
      dashboardOverview.peakHourAverage.reduce((sum, row) => sum + row.arrivals + row.departures, 0) === dashboardOverview.kpis.totalFlights,
    `overview peak hour average should use 30-minute operational order from 05:00 to 05:00, got ${JSON.stringify(dashboardOverview.peakHourAverage)}`
  );
  const julyPeakHourOverview = buildDashboardOverview({
    records: effectiveDashboardRecords,
    typeFilter: 'all',
    timeBasis: 'local',
    monthFrom: '2026-06',
    monthTo: '2026-08',
    peakHourMonth: '2026-07',
    airline: 'all',
    country: 'all',
    route: 'all',
  });
  const julyPeakHourTotals = julyPeakHourOverview.peakHourAverage.reduce((totals, row) => ({
    flights: totals.flights + row.flights,
    arrivals: totals.arrivals + row.arrivals,
    departures: totals.departures + row.departures,
  }), { flights: 0, arrivals: 0, departures: 0 });
  assert(
    julyPeakHourOverview.kpis.totalFlights === dashboardOverview.kpis.totalFlights &&
      julyPeakHourTotals.flights === 3 &&
      julyPeakHourTotals.arrivals === 1 &&
      julyPeakHourTotals.departures === 2,
    `peak-hour month drilldown should only narrow the peak-hour series while preserving overview KPIs, got ${JSON.stringify({ kpis: julyPeakHourOverview.kpis, julyPeakHourTotals })}`
  );
  const utcDashboardOverview = buildDashboardOverview({
    records: effectiveDashboardRecords,
    typeFilter: 'all',
    timeBasis: 'utc',
    monthFrom: '2026-06',
    monthTo: '2026-08',
    airline: 'all',
    country: 'all',
    route: 'all',
  });
  assert(
    utcDashboardOverview.kpis.totalFlights === dashboardOverview.kpis.totalFlights &&
      utcDashboardOverview.peakHourAverage[0]?.bucket === '22:00' &&
      utcDashboardOverview.peakHourAverage.at(-1)?.bucket === '21:30' &&
      utcDashboardOverview.peakHourAverage.some((row) => row.bucket === '18:00' && row.flights > 0),
    `UTC overview should shift and reorder peak-hour buckets without changing totals, got ${JSON.stringify(utcDashboardOverview.peakHourAverage)}`
  );
  const localPeakHourTicks = buildPeakHourAxisTicks('local').map((tick) => tick.label);
  const utcPeakHourTicks = buildPeakHourAxisTicks('utc').map((tick) => tick.label);
  assert(
    localPeakHourTicks[0] === '05:00' &&
      localPeakHourTicks.at(-1) === '05:00 +1' &&
      utcPeakHourTicks[0] === '22:00' &&
      utcPeakHourTicks[1] === '00:00 +1' &&
      utcPeakHourTicks.at(-1) === '22:00 +1' &&
      !utcPeakHourTicks.includes('05:00 +1'),
    `peak hour axis ticks should convert local +7 axis to UTC labels, got local=${JSON.stringify(localPeakHourTicks)} utc=${JSON.stringify(utcPeakHourTicks)}`
  );
  const operationalDayRecords = [
    seasonalRecord({ id: 'DASH-OP-JUN', type: 'D', airline: 'VJ', rawFlightNumber: '601', route: 'ICN', aircraft: '321', date: '2026-07-01', schedule: '04:30', pax: 120 }),
    seasonalRecord({ id: 'DASH-OP-JUL-LATE', type: 'D', airline: 'VJ', rawFlightNumber: '602', route: 'ICN', aircraft: '321', date: '2026-07-01', schedule: '23:30', pax: 130 }),
    seasonalRecord({ id: 'DASH-OP-JUL-EARLY', type: 'A', airline: 'VN', rawFlightNumber: '603', route: 'BKK', aircraft: '320', date: '2026-07-02', schedule: '04:30', pax: 140 }),
  ];
  assert(
    JSON.stringify(operationalDayRecords.map((record) => getDashboardOperationalDate(record))) === JSON.stringify(['2026-06-30', '2026-07-01', '2026-07-01']),
    `dashboard operational date should count local +7 flights before 05:00 into the previous day, got ${JSON.stringify(operationalDayRecords.map((record) => getDashboardOperationalDate(record)))}`
  );
  const operationalDayOverview = buildDashboardOverview({
    records: operationalDayRecords,
    typeFilter: 'all',
    timeBasis: 'utc',
    monthFrom: '2026-07',
    monthTo: '2026-07',
    airline: 'all',
    country: 'all',
    route: 'all',
  });
  assert(
    operationalDayOverview.kpis.totalFlights === 2 &&
      operationalDayOverview.kpis.avgFlightsPerDay === 2 &&
      operationalDayOverview.monthlyTrend.length === 1 &&
      operationalDayOverview.monthlyTrend[0].key === '2026-07' &&
      operationalDayOverview.monthlyTrend[0].total === 2 &&
      operationalDayOverview.dailyTrend.length === 1 &&
      operationalDayOverview.dailyTrend[0].date === '2026-07-01' &&
      operationalDayOverview.dailyTrend[0].total === 2 &&
      operationalDayOverview.weekdayHeatmap.some((cell) => cell.month === '2026-07' && cell.weekday === 'Wed' && cell.flights === 2) &&
      operationalDayOverview.peakHourAverage.reduce((sum, row) => sum + row.flights, 0) === 2,
    `overview should group month, day, weekday, average day count, and peak-hour operating days by local +7 operational day, got ${JSON.stringify(operationalDayOverview)}`
  );
  const operationalDayComparison = buildDashboardComparison({
    records: operationalDayRecords,
    mode: 'mom',
    metric: 'flights',
    currentPeriod: '2026-07',
    previousPeriod: '2026-06',
    typeFilter: 'all',
    timeBasis: 'utc',
    dimension: 'dayOfWeek',
  });
  assert(
    operationalDayComparison.current.total === 2 &&
      operationalDayComparison.previous.total === 1 &&
      operationalDayComparison.drivers.some((driver) => driver.key === 'Wed' && driver.currentValue === 2),
    `MoM comparison should use local +7 operational day instead of raw record date, got ${JSON.stringify(operationalDayComparison)}`
  );
  const koreaOverview = buildDashboardOverview({
    records: effectiveDashboardRecords,
    typeFilter: 'all',
    timeBasis: 'local',
    monthFrom: '2026-06',
    monthTo: '2026-08',
    airline: 'all',
    country: 'Korea',
    route: 'all',
  });
  assert(koreaOverview.kpis.totalFlights === 6 && koreaOverview.countryOptions.includes('Korea'), `overview country filter should use route-country lookup, got ${JSON.stringify(koreaOverview)}`);
  const customRouteCountryMap = [
    { route: 'ICN', country: 'South Korea' },
    { route: 'PUS', country: 'South Korea' },
    { route: 'BKK', country: 'Thailand' },
    { route: 'HKG', country: 'Hong Kong' },
  ];
  const customCountryOverview = buildDashboardOverview({
    records: effectiveDashboardRecords,
    typeFilter: 'all',
    timeBasis: 'local',
    monthFrom: '2026-06',
    monthTo: '2026-08',
    airline: 'all',
    country: 'South Korea',
    route: 'all',
    routeCountries: customRouteCountryMap,
  });
  assert(
    customCountryOverview.kpis.totalFlights === 6 &&
      customCountryOverview.countryOptions.includes('South Korea') &&
      customCountryOverview.countryRouteContribution.some((row) => row.country === 'South Korea' && row.route === 'ICN'),
    `overview should use settings route-country map overrides, got ${JSON.stringify(customCountryOverview)}`
  );
  const momComparison = buildDashboardComparison({
    records: effectiveDashboardRecords,
    mode: 'mom',
    metric: 'flights',
    currentPeriod: '2026-07',
    previousPeriod: '2026-06',
    typeFilter: 'all',
    timeBasis: 'local',
    dimension: 'airline',
  });
  assert(momComparison.current.total === 3 && momComparison.previous.total === 2 && momComparison.delta === 1, `MoM dashboard comparison should compare July against June, got ${JSON.stringify(momComparison)}`);
  assert(momComparison.periodLabels.current === 'Jul 2026' && momComparison.periodLabels.previous === 'Jun 2026', `MoM comparison should expose readable period labels, got ${JSON.stringify(momComparison.periodLabels)}`);
  const vjDriver = momComparison.drivers.find((driver) => driver.key === 'VJ');
  assert(vjDriver?.currentValue === 2 && vjDriver.previousValue === 1 && vjDriver.delta === 1, `MoM airline driver should expose current/previous/delta, got ${JSON.stringify(vjDriver)}`);
  assert(vjDriver?.ctgPct === 0.5, `MoM airline driver CTG should be delta divided by previous total, got ${JSON.stringify(vjDriver)}`);
  assert(Math.abs((vjDriver?.shareShift ?? 0) - (2 / 3 - 1 / 2)) < 0.000001, `MoM airline driver mix shift should be current share minus previous share, got ${JSON.stringify(vjDriver)}`);
  const contributionTotal = momComparison.drivers.reduce((sum, driver) => sum + driver.delta, 0);
  assert(contributionTotal === momComparison.delta, `MoM driver deltas should reconcile to total delta, got ${contributionTotal} vs ${momComparison.delta}`);
  const countryComparison = buildDashboardComparison({
    records: effectiveDashboardRecords,
    mode: 'mom',
    metric: 'flights',
    currentPeriod: '2026-07',
    previousPeriod: '2026-06',
    typeFilter: 'all',
    timeBasis: 'local',
    dimension: 'country',
  });
  const koreaDriver = countryComparison.drivers.find((driver) => driver.key === 'Korea');
  const thailandDriver = countryComparison.drivers.find((driver) => driver.key === 'Thailand');
  assert(koreaDriver?.currentValue === 3 && koreaDriver.previousValue === 1 && koreaDriver.delta === 2, `country driver should map ICN/PUS to Korea, got ${JSON.stringify(countryComparison.drivers)}`);
  assert(thailandDriver?.currentValue === 0 && thailandDriver.previousValue === 1 && thailandDriver.delta === -1, `country driver should map BKK to Thailand, got ${JSON.stringify(countryComparison.drivers)}`);
  assert(!countryComparison.drivers.some((driver) => driver.key === 'Unknown'), `mapped dashboard country drivers should not fall back to Unknown for known routes, got ${JSON.stringify(countryComparison.drivers)}`);
  const countryContributionTotal = countryComparison.drivers.reduce((sum, driver) => sum + driver.delta, 0);
  assert(countryContributionTotal === countryComparison.delta, `country driver deltas should reconcile to total delta, got ${countryContributionTotal} vs ${countryComparison.delta}`);
  const customCountryComparison = buildDashboardComparison({
    records: effectiveDashboardRecords,
    mode: 'mom',
    metric: 'flights',
    currentPeriod: '2026-07',
    previousPeriod: '2026-06',
    typeFilter: 'all',
    timeBasis: 'local',
    dimension: 'country',
    routeCountries: customRouteCountryMap,
  });
  assert(
    customCountryComparison.drivers.some((driver) => driver.key === 'South Korea' && driver.currentValue === 3 && driver.previousValue === 1) &&
      !customCountryComparison.drivers.some((driver) => driver.key === 'Korea'),
    `country comparison should use settings route-country overrides, got ${JSON.stringify(customCountryComparison.drivers)}`
  );
  const depOnlyComparison = buildDashboardComparison({
    records: effectiveDashboardRecords,
    mode: 'mom',
    metric: 'flights',
    currentPeriod: '2026-07',
    previousPeriod: '2026-06',
    typeFilter: 'D',
    timeBasis: 'local',
    dimension: 'airline',
  });
  assert(depOnlyComparison.current.total === 2 && depOnlyComparison.previous.total === 1, `ARR/DEP filter should change comparison totals, got ${JSON.stringify(depOnlyComparison)}`);
  const wowComparison = buildDashboardComparison({
    records: effectiveDashboardRecords,
    mode: 'wow',
    metric: 'flights',
    currentPeriod: '2026-W32',
    previousPeriod: '2026-W31',
    typeFilter: 'all',
    timeBasis: 'local',
    dimension: 'route',
  });
  assert(wowComparison.current.total === 2 && wowComparison.previous.total === 1 && wowComparison.periodLabels.current === 'Week 32 2026', `WoW comparison should use derived week periods, got ${JSON.stringify(wowComparison)}`);
  const localHourComparison = buildDashboardComparison({
    records: effectiveDashboardRecords,
    mode: 'wow',
    metric: 'flights',
    currentPeriod: '2026-W32',
    previousPeriod: '2026-W31',
    typeFilter: 'all',
    timeBasis: 'local',
    dimension: 'hourBucket',
  });
  const utcHourComparison = buildDashboardComparison({
    records: effectiveDashboardRecords,
    mode: 'wow',
    metric: 'flights',
    currentPeriod: '2026-W32',
    previousPeriod: '2026-W31',
    typeFilter: 'all',
    timeBasis: 'utc',
    dimension: 'hourBucket',
  });
  assert(localHourComparison.current.total === utcHourComparison.current.total, `time basis should not change totals, got ${JSON.stringify({ localHourComparison, utcHourComparison })}`);
  assert(localHourComparison.drivers.some((driver) => driver.key === '01:00') && utcHourComparison.drivers.some((driver) => driver.key === '18:00'), `UTC hour buckets should shift local +7 times back seven hours, got ${JSON.stringify({ local: localHourComparison.drivers, utc: utcHourComparison.drivers })}`);
  const crossSeasonYoyRecords = [
    seasonalRecord({ id: 'YOY-W24-DEC', type: 'D', airline: 'VN', rawFlightNumber: '701', route: 'ICN', aircraft: '321', date: '2024-12-28', schedule: '10:00', pax: 180 }),
    seasonalRecord({ id: 'YOY-W25-JAN', type: 'D', airline: 'VN', rawFlightNumber: '702', route: 'ICN', aircraft: '321', date: '2025-01-04', schedule: '10:00', pax: 190 }),
    seasonalRecord({ id: 'YOY-S25-JUL', type: 'D', airline: 'VN', rawFlightNumber: '703', route: 'ICN', aircraft: '321', date: '2025-07-04', schedule: '10:00', pax: 200 }),
    seasonalRecord({ id: 'YOY-S26-JUL', type: 'A', airline: 'VJ', rawFlightNumber: '704', route: 'BKK', aircraft: '320', date: '2026-07-04', schedule: '11:00', pax: 210 }),
  ];
  const yoyMonthPeriods = listDashboardPeriods(crossSeasonYoyRecords, 'yoy', 'month');
  const yoyYearPeriods = listDashboardPeriods(crossSeasonYoyRecords, 'yoy', 'year');
  assert(
    yoyMonthPeriods.some((period) => period.key === '2026-07' && period.label === 'Jul 2026') &&
      yoyMonthPeriods.some((period) => period.key === '2025-07') &&
      yoyYearPeriods.some((period) => period.key === '2024') &&
      yoyYearPeriods.some((period) => period.key === '2025') &&
      yoyYearPeriods.some((period) => period.key === '2026'),
    `YoY period options should group cross-season records by calendar month/year, got ${JSON.stringify({ yoyMonthPeriods, yoyYearPeriods })}`
  );
  const yoyYearComparison = buildDashboardComparison({
    records: crossSeasonYoyRecords,
    mode: 'yoy',
    granularity: 'year',
    metric: 'flights',
    currentPeriod: '2025',
    previousPeriod: '2024',
    typeFilter: 'all',
    timeBasis: 'local',
    dimension: 'airline',
  });
  assert(
    yoyYearComparison.current.total === 2 &&
      yoyYearComparison.previous.total === 1 &&
      yoyYearComparison.periodLabels.current === '2025' &&
      yoyYearComparison.periodLabels.previous === '2024',
    `YoY year comparison should split Winter by calendar year and compare cross-season totals, got ${JSON.stringify(yoyYearComparison)}`
  );
  const aiFilters = {
    comparisonMode: 'mom',
    metric: 'flights',
    typeFilter: 'D',
    dimension: 'airline',
    timeBasis: 'local',
  };
  const aiWaterfallRows = [
    {
      dimension: 'airline',
      label: 'Airline',
      result: depOnlyComparison,
      topDriver: depOnlyComparison.drivers[0] ?? null,
      reconciledDelta: depOnlyComparison.drivers.reduce((sum, driver) => sum + driver.delta, 0),
    },
  ];
  const aiSelectedDriver = depOnlyComparison.drivers.find((driver) => driver.key === 'VJ') ?? null;
  const aiSelectedDriverRecords = [
    seasonalRecord({ id: 'AI-KEEP-1', type: 'D', airline: 'VJ', rawFlightNumber: '901', route: 'ICN', aircraft: '321', date: '2026-07-03', schedule: '11:00', pax: 190 }),
    seasonalRecord({ id: 'AI-KEEP-2', type: 'D', airline: 'VJ', rawFlightNumber: '902', route: 'ICN', aircraft: '321', date: '2026-06-03', schedule: '10:00', pax: 180 }),
    { ...seasonalRecord({ id: 'AI-DELETED', type: 'D', airline: 'VJ', rawFlightNumber: '903', route: 'ICN', aircraft: '321', date: '2026-07-05', schedule: '12:00', pax: 170 }), status: 'deleted' },
  ];
  const aiContext = buildDashboardAiContext({
    comparison: depOnlyComparison,
    filters: aiFilters,
    waterfallRows: aiWaterfallRows,
    selectedDriver: aiSelectedDriver,
    selectedDriverRecords: aiSelectedDriverRecords,
    seasonRecords: effectiveDashboardRecords,
    routeCountries: customRouteCountryMap,
    maxSelectedRecords: 1,
  });
  assert(aiContext.contextVersion === 2, `AI context should expose a v2 marker, got ${JSON.stringify(aiContext)}`);
  assert(aiContext.filters.typeFilter === 'D' && aiContext.filters.dimension === 'airline' && aiContext.comparison.mode === 'mom', `AI context should include active filters and comparison mode, got ${JSON.stringify(aiContext.filters)}`);
  assert(aiContext.comparison.drivers.length === depOnlyComparison.drivers.length, `AI context should include every active driver row, got ${JSON.stringify(aiContext.comparison.drivers)}`);
  assert(aiContext.selectedDriverRecords.truncated === true && aiContext.selectedDriverRecords.totalRecords === 2 && aiContext.selectedDriverRecords.records.length === 1, `AI context should cap selected driver records with truncation metadata, got ${JSON.stringify(aiContext.selectedDriverRecords)}`);
  assert(!JSON.stringify(aiContext).includes('AI-DELETED'), `AI context must exclude deleted selected records, got ${JSON.stringify(aiContext.selectedDriverRecords)}`);
  assert(
    aiContext.seasonCatalog.totalRecords === effectiveDashboardRecords.length &&
      aiContext.seasonCatalog.months.some((month) => month.key === '2026-08') &&
      aiContext.seasonCatalog.weeks.some((week) => week.key === '2026-W32') &&
      aiContext.seasonCatalog.topAirlines.some((row) => row.key === 'VJ') &&
      aiContext.seasonCatalog.topCountries.some((row) => row.key === 'South Korea') &&
      aiContext.seasonCatalog.dateRange.from === '2026-06-03' &&
      aiContext.seasonCatalog.dateRange.to === '2026-08-04',
    `AI context should include a compact season-wide catalog outside the active MoM/WoW month, got ${JSON.stringify(aiContext.seasonCatalog)}`
  );
  const augustRequest = resolveDashboardAiDataRequest({
    type: 'dashboard-data-request',
    scope: 'records',
    months: ['2026-08'],
    typeFilter: 'D',
    airlines: ['VJ'],
    metric: 'flights',
    dimension: 'airline',
    maxRecords: 20,
  });
  assert(augustRequest?.months?.[0] === '2026-08' && augustRequest.typeFilter === 'D', `AI data request should accept validated month and ARR/DEP filters, got ${JSON.stringify(augustRequest)}`);
  const resolvedAugustRequest = buildDashboardAiResolvedDataRequest(augustRequest, {
    records: effectiveDashboardRecords,
    routeCountries: customRouteCountryMap,
    fallbackFilters: aiContext.filters,
    maxRecords: 5,
  });
  assert(
    resolvedAugustRequest.totalRecords === 2 &&
      resolvedAugustRequest.records.length === 2 &&
      resolvedAugustRequest.records.every((record) => record.airline === 'VJ' && record.type === 'D' && record.date.startsWith('2026-08')) &&
      resolvedAugustRequest.aggregations.byMonth.some((row) => row.key === '2026-08' && row.flights === 2) &&
      resolvedAugustRequest.aggregations.byDimension.some((row) => row.key === 'VJ' && row.flights === 2),
    `AI data request resolver should pull historical/cross-month slices from local effective records, got ${JSON.stringify(resolvedAugustRequest)}`
  );
  const aiScopeSeasonCatalog = [
    { seasonId: 'season-w24', seasonCode: 'W24', name: 'Winter 2024', dateRange: { from: '2024-10-27', to: '2025-03-29' } },
    { seasonId: 'season-s25', seasonCode: 'S25', name: 'Summer 2025', dateRange: { from: '2025-03-30', to: '2025-10-25' } },
    { seasonId: 'season-w25', seasonCode: 'W25', name: 'Winter 2025', dateRange: { from: '2025-10-26', to: '2026-03-28' } },
    { seasonId: 'season-s26', seasonCode: 'S26', name: 'Summer 2026', dateRange: { from: '2026-03-29', to: '2026-10-24' } },
    { seasonId: 'season-w26', seasonCode: 'W26', name: 'Winter 2026', dateRange: { from: '2026-10-25', to: '2027-03-27' } },
  ];
  const fullMarchAiScope = resolveDashboardAiDataScopeForPrompt({
    prompt: 'phÃ¢n tÃ­ch thÃ¡ng 3',
    activeSeasonId: 'season-s26',
    selectedSeasonIds: ['season-s26'],
    availableSeasonCatalog: aiScopeSeasonCatalog,
  });
  assert(
    fullMarchAiScope.scope === 'full-calendar-month' &&
      JSON.stringify(fullMarchAiScope.months) === JSON.stringify(['2026-03']) &&
      JSON.stringify(fullMarchAiScope.seasonIds) === JSON.stringify(['season-w25', 'season-s26']),
    `AI month scope should resolve the latest full calendar month across season boundaries, got ${JSON.stringify(fullMarchAiScope)}`
  );
  const octoberAiScope = resolveDashboardAiDataScopeForPrompt({
    prompt: 'top route thÃ¡ng 10/2026',
    activeSeasonId: 'season-s26',
    selectedSeasonIds: ['season-s26'],
    availableSeasonCatalog: aiScopeSeasonCatalog,
  });
  assert(
    octoberAiScope.scope === 'full-calendar-month' &&
      JSON.stringify(octoberAiScope.months) === JSON.stringify(['2026-10']) &&
      JSON.stringify(octoberAiScope.seasonIds) === JSON.stringify(['season-s26', 'season-w26']),
    `AI transition-month scope should include both overlapping seasons, got ${JSON.stringify(octoberAiScope)}`
  );
  const yoyMarchAiScope = resolveDashboardAiDataScopeForPrompt({
    prompt: 'YoY thÃ¡ng 3/2026',
    activeSeasonId: 'season-s26',
    selectedSeasonIds: ['season-s26'],
    availableSeasonCatalog: aiScopeSeasonCatalog,
  });
  assert(
    yoyMarchAiScope.scope === 'full-calendar-month' &&
      JSON.stringify(yoyMarchAiScope.months) === JSON.stringify(['2026-03', '2025-03']) &&
      JSON.stringify(yoyMarchAiScope.seasonIds) === JSON.stringify(['season-w24', 'season-s25', 'season-w25', 'season-s26']),
    `AI YoY month scope should load full calendar months from both years, got ${JSON.stringify(yoyMarchAiScope)}`
  );
  const explicitSeasonAiScope = resolveDashboardAiDataScopeForPrompt({
    prompt: 'chá»‰ trong W25 thÃ¡ng 3',
    activeSeasonId: 'season-s26',
    selectedSeasonIds: ['season-s26'],
    availableSeasonCatalog: aiScopeSeasonCatalog,
  });
  assert(
    explicitSeasonAiScope.scope === 'selected-seasons' &&
      JSON.stringify(explicitSeasonAiScope.months) === JSON.stringify(['2026-03']) &&
      JSON.stringify(explicitSeasonAiScope.seasonIds) === JSON.stringify(['season-w25']),
    `AI explicit season scope should keep the season filter while resolving month inside that season, got ${JSON.stringify(explicitSeasonAiScope)}`
  );
  const dateRangeAiScope = resolveDashboardAiDataScopeForPrompt({
    prompt: 'from 2026-03-15 to 2026-04-15',
    activeSeasonId: 'season-s26',
    selectedSeasonIds: ['season-s26'],
    availableSeasonCatalog: aiScopeSeasonCatalog,
  });
  assert(
    dateRangeAiScope.scope === 'date-range' &&
      dateRangeAiScope.dateRange?.from === '2026-03-15' &&
      dateRangeAiScope.dateRange?.to === '2026-04-15' &&
      JSON.stringify(dateRangeAiScope.seasonIds) === JSON.stringify(['season-w25', 'season-s26']),
    `AI date-range scope should load all seasons overlapping the calendar range, got ${JSON.stringify(dateRangeAiScope)}`
  );
  const scopedMarchSql = planDashboardAiSqlQueries({
    userPrompt: 'ngÃ y cao Ä‘iá»ƒm thÃ¡ng 3',
    context: { dataScope: fullMarchAiScope },
    source: 'local-sqlite',
  });
  assert(
    scopedMarchSql[0]?.params?.[0] === '2026-03',
    `AI SQL planner should use the resolved full-month scope when prompt omits year, got ${JSON.stringify(scopedMarchSql)}`
  );
  const makeMonthComparisonRecords = (month, total, arrivals, airlineCounts, routeCounts) => {
    const records = [];
    const airlineEntries = Object.entries(airlineCounts);
    const routeEntries = Object.entries(routeCounts);
    const valueForRow = (entries, row) => {
      let offset = 0;
      for (const [key, count] of entries) {
        if (row < offset + count) return key;
        offset += count;
      }
      return entries.at(-1)?.[0] ?? 'UNK';
    };
    let index = 0;
    for (let row = 0; row < total; row += 1) {
      index += 1;
      records.push(seasonalRecord({
        id: `AI-${month}-${index}`,
        type: row < arrivals ? 'A' : 'D',
        airline: valueForRow(airlineEntries, row),
        rawFlightNumber: String(1000 + index),
        route: valueForRow(routeEntries, row),
        aircraft: '321',
        date: `2026-${month}-${String(row % 28 + 1).padStart(2, '0')}`,
        schedule: '12:00',
        pax: 0,
      }));
    }
    return records;
  };
  const monthComparisonRecords = [
    ...makeMonthComparisonRecords('05', 3532, 1768, { VJ: 1300, VN: 900, AK: 700, FD: 632 }, { ICN: 1100, BKK: 900, SIN: 800, KUL: 732 }),
    ...makeMonthComparisonRecords('06', 3504, 1753, { VJ: 1240, VN: 910, AK: 680, FD: 674 }, { ICN: 1030, BKK: 920, SIN: 780, KUL: 774 }),
  ];
  const localAiQueryResults = resolveDashboardAiLocalQueryResults([
    {
      queryId: 'local-june-days',
      view: 'flight_operations',
      filters: { dateFrom: '2026-06-01', dateTo: '2026-06-07' },
      groupBy: ['ops_date'],
      metrics: ['flights', 'arrivals', 'departures'],
      orderBy: 'flights',
      limit: 10,
    },
    {
      queryId: 'local-june-vj-routes',
      view: 'flight_operations',
      filters: { months: ['2026-06'], airlines: ['VJ'] },
      groupBy: ['route'],
      metrics: ['flights', 'pax'],
      orderBy: 'flights',
      limit: 10,
    },
  ], {
    seasonRows: [{
      seasonId: 'season-s26',
      seasonCode: 'S26',
      records: monthComparisonRecords,
      dataSource: 'local',
      pendingCount: 2,
    }],
    routeCountries: customRouteCountryMap,
  });
  assert(
    localAiQueryResults.length === 2 &&
      localAiQueryResults[0].rows.length === 7 &&
      localAiQueryResults[0].rows.every((row) => String(row.ops_date).startsWith('2026-06-')) &&
      localAiQueryResults[0].dataQualityNotes.some((note) => note.includes('SQLite local')) &&
      localAiQueryResults[1].rows.some((row) => row.route === 'ICN' && row.flights === 1030),
    `AI local query resolver should answer date/month/season queries from native-loaded records with SQLite source notes, got ${JSON.stringify(localAiQueryResults)}`
  );
  const inferredPeakDayQuery = inferDashboardAiDataQueryForPrompt({
    userPrompt: 'tim ngay cao diem cua thang 6 va diem bat thuong so voi cac ngay con lai',
    context: { dataScope: { months: ['2026-06'] }, selectedSeason: 'S26 2026' },
  });
  const peakDayFallbackResults = inferredPeakDayQuery
    ? resolveDashboardAiLocalQueryResults([inferredPeakDayQuery], {
        seasonRows: [{
          seasonId: 'season-s26',
          seasonCode: 'S26',
          records: monthComparisonRecords,
          dataSource: 'local',
          pendingCount: 0,
        }],
        routeCountries: customRouteCountryMap,
      })
    : [];
  assert(
    inferredPeakDayQuery?.filters?.months?.[0] === '2026-06' &&
      inferredPeakDayQuery.groupBy.includes('ops_date') &&
      peakDayFallbackResults[0]?.rows.length > 0 &&
      peakDayFallbackResults[0].rows.every((row) => String(row.ops_date).startsWith('2026-06-')),
    `Peak-day anomaly prompt must infer an ops_date local fallback query when native SQL is unavailable, got ${JSON.stringify({ inferredPeakDayQuery, peakDayFallbackResults })}`
  );
  const inferredJuneMayRequest = inferDashboardAiDataRequestFromText({
    userPrompt: 'táº¡o báº£ng so sÃ¡nh cÃ¡c Ä‘iá»ƒm khÃ¡c biá»‡t ná»•i báº­t cá»§a thÃ¡ng 6 vá»›i thÃ¡ng 5 theo hÃ£ng bay vÃ  Ä‘Æ°á»ng bay',
    assistantText: 'Payload hiá»‡n táº¡i chÆ°a cÃ³ báº£ng phÃ¢n rÃ£ chi tiáº¿t theo hÃ£ng bay hay Ä‘Æ°á»ng bay. Há»‡ thá»‘ng sáº½ gá»­i yÃªu cáº§u truy xuáº¥t dá»¯ liá»‡u so sÃ¡nh chi tiáº¿t giai Ä‘oáº¡n nÃ y.',
    context: aiContext,
  });
  const resolvedJuneMayRequest = buildDashboardAiResolvedDataRequest(inferredJuneMayRequest, {
    records: monthComparisonRecords,
    routeCountries: customRouteCountryMap,
    fallbackFilters: { ...aiContext.filters, typeFilter: 'all', dimension: 'airline' },
    maxRecords: 20,
  });
  const deterministicJuneMayAnswer = buildDashboardAiResolvedDataFallbackAnswer({
    userPrompt: 'táº¡o báº£ng so sÃ¡nh cÃ¡c Ä‘iá»ƒm khÃ¡c biá»‡t ná»•i báº­t cá»§a thÃ¡ng 6 vá»›i thÃ¡ng 5 theo hÃ£ng bay vÃ  Ä‘Æ°á»ng bay',
    resolvedDataRequest: resolvedJuneMayRequest,
  });
  assert(
    isDashboardAiDataRequestPrompt('Payload hiá»‡n táº¡i chÆ°a cÃ³ báº£ng phÃ¢n rÃ£ chi tiáº¿t theo hÃ£ng bay hay Ä‘Æ°á»ng bay. Há»‡ thá»‘ng sáº½ gá»­i yÃªu cáº§u truy xuáº¥t dá»¯ liá»‡u so sÃ¡nh chi tiáº¿t giai Ä‘oáº¡n nÃ y.') &&
      inferredJuneMayRequest?.months?.[0] === '2026-06' &&
      inferredJuneMayRequest.months?.[1] === '2026-05' &&
      inferredJuneMayRequest.dimension === 'airline' &&
      resolvedJuneMayRequest.comparison?.current.flights === 3504 &&
      resolvedJuneMayRequest.comparison.previous.flights === 3532 &&
      resolvedJuneMayRequest.comparison.delta === -28 &&
      resolvedJuneMayRequest.comparison.current.arrivals === 1753 &&
      resolvedJuneMayRequest.comparison.current.departures === 1751 &&
      resolvedJuneMayRequest.comparison.previous.arrivals === 1768 &&
      resolvedJuneMayRequest.comparison.previous.departures === 1764 &&
      resolvedJuneMayRequest.comparison.drivers.some((driver) => driver.key === 'VJ' && driver.delta === -60) &&
      deterministicJuneMayAnswer.boardPatch?.blocks.some((block) => block.table?.templateId === 'custom-table' && block.source === 'resolvedDataRequest') &&
      !JSON.stringify(deterministicJuneMayAnswer.boardPatch).includes('comparison-drivers'),
    `Dashboard AI auto-fetch inference should resolve June vs May comparison details and deterministic notebook blocks, got ${JSON.stringify({ inferredJuneMayRequest, comparison: resolvedJuneMayRequest.comparison, deterministicJuneMayAnswer })}`
  );
  const resolvedContext = buildDashboardAiContext({
    comparison: depOnlyComparison,
    filters: aiContext.filters,
    waterfallRows: aiWaterfallRows,
    selectedDriver: aiSelectedDriver,
    selectedDriverRecords: aiSelectedDriverRecords,
    seasonRecords: effectiveDashboardRecords,
    routeCountries: customRouteCountryMap,
    resolvedDataRequest: resolvedAugustRequest,
  });
  assert(
    resolvedContext.resolvedDataRequest?.request.months?.[0] === '2026-08' &&
      resolvedContext.resolvedDataRequest.records.length === 2,
    `AI context should carry one resolved broader-data payload for the follow-up call, got ${JSON.stringify(resolvedContext.resolvedDataRequest)}`
  );
  assert(
    resolveDashboardAiDataRequest({ type: 'dashboard-data-request', scope: 'records', months: ['2026-13'] }) == null &&
      resolveDashboardAiDataRequest({ type: 'dashboard-data-request', scope: 'records', sql: 'drop table flight_records' }) == null,
    'AI data request parser must reject invalid period keys and arbitrary query fields'
  );
  const aiPrompt = buildDashboardAiPrompt({
    userPrompt: 'Why did VJ volume drop this week?',
    context: aiContext,
  });
  assert(
    aiPrompt.includes('DASHBOARD_CONTEXT_JSON') &&
      aiPrompt.includes('"typeFilter": "D"') &&
      aiPrompt.includes('"drivers"') &&
      DASHBOARD_AI_GROUNDING_INSTRUCTIONS.includes('only from the supplied dashboard JSON'),
    `AI prompt must inject dashboard JSON and grounding instructions, got ${aiPrompt}`
  );
  assert(
    DEFAULT_AI_ANALYSIS_SETTINGS.activeModelId === 'gemini-flash' &&
      DEFAULT_AI_ANALYSIS_SETTINGS.models.some((model) => model.id === 'qwen-plus' && model.provider === 'openai-compatible') &&
      DEFAULT_AI_ANALYSIS_SETTINGS.models.some((model) => model.id === 'deepseek-v4-flash' && model.provider === 'deepseek' && model.baseUrl === 'https://api.deepseek.com') &&
      Array.isArray(DEFAULT_AI_ANALYSIS_SETTINGS.contextDocuments) &&
      DEFAULT_AI_ANALYSIS_SETTINGS.contextDocuments.length === 0,
    `AI settings should default to Gemini with optional Qwen-compatible and DeepSeek model metadata, got ${JSON.stringify(DEFAULT_AI_ANALYSIS_SETTINGS)}`
  );
  const hydratedAiContextDocuments = validateOperationalSettings({
    aiAnalysis: {
      ...DEFAULT_AI_ANALYSIS_SETTINGS,
      contextDocuments: [
        { id: 'rule-ops', kind: 'rule', title: 'Ops Rule', contentMd: '# Rule\nUse ops_date.', enabled: true, sortOrder: 0, createdAt: 1, updatedAt: 1 },
        { id: 'skill-peak', kind: 'skill', title: 'Peak Skill', contentMd: '# Skill\nFind peak day.', enabled: false, sortOrder: 1, createdAt: 1, updatedAt: 1 },
      ],
    },
  }).aiAnalysis.contextDocuments;
  assert( 
    hydratedAiContextDocuments.length === 2 && 
      hydratedAiContextDocuments[0].contentMd.includes('Use ops_date') && 
      hydratedAiContextDocuments[1].enabled === false, 
    `AI settings mapper should round-trip rule/skill markdown documents, got ${JSON.stringify(hydratedAiContextDocuments)}` 
  ); 
  const defaultAiSkillPack = buildDefaultAiAnalysisContextDocuments(12345);  
  assert(  
    AI_ANALYSIS_DEFAULT_CONTEXT_DOCUMENT_TEMPLATES.length === 14 &&  
      defaultAiSkillPack.some((document) => document.id === 'default-rule-schema-contract' && document.kind === 'rule' && document.contentMd.includes('dashboard_ai_flight_operations')) &&  
      defaultAiSkillPack.some((document) => document.id === 'default-skill-eda-profile' && document.kind === 'skill' && document.contentMd.includes('Workflow')) &&  
      defaultAiSkillPack.some((document) => document.id === 'default-rule-safe-rendering-policy' && document.contentMd.includes('`<script>`')) &&  
      defaultAiSkillPack.some((document) => document.id === 'default-rule-agent-role-and-source-priority' && document.contentMd.includes('SQLite local')) && 
      defaultAiSkillPack.some((document) => document.id === 'default-rule-aviation-terms-and-synonyms' && document.contentMd.includes('`ops_date`') && document.contentMd.includes('PAX')) && 
      defaultAiSkillPack.some((document) => document.id === 'default-rule-query-examples-flight-operations' && document.contentMd.includes('PAX') && document.contentMd.includes('ORDER BY pax DESC')) && 
      defaultAiSkillPack.some((document) => document.id === 'default-rule-analysis-reasoning-contract' && document.contentMd.includes('query result/profile')) && 
      defaultAiSkillPack.some((document) => document.id === 'default-rule-visualization-intent-router' && document.contentMd.includes('chart block') && document.contentMd.includes('custom-table')) && 
      defaultAiSkillPack.every((document) => document.createdAt === 12345 && document.updatedAt === 12345),  
    `Default AI EDA skill pack should seed editable markdown rules/skills, got ${JSON.stringify(defaultAiSkillPack)}`  
  );  
  const resolvedAiModel = resolveDashboardAiModel(DEFAULT_AI_ANALYSIS_SETTINGS, 'qwen-plus'); 
  assert(
    resolvedAiModel?.provider === 'openai-compatible' &&
      resolvedAiModel.model === 'qwen-plus' &&
      resolvedAiModel.baseUrl === 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1',
    `AI model resolver should pick enabled runtime model settings, got ${JSON.stringify(resolvedAiModel)}`
  );
  const resolvedDeepSeekModel = resolveDashboardAiModel(DEFAULT_AI_ANALYSIS_SETTINGS, 'deepseek-v4-flash');
  assert(
    resolvedDeepSeekModel?.provider === 'deepseek' &&
      resolvedDeepSeekModel.model === 'deepseek-v4-flash' &&
      resolvedDeepSeekModel.baseUrl === 'https://api.deepseek.com',
    `AI model resolver should preserve DeepSeek provider settings, got ${JSON.stringify(resolvedDeepSeekModel)}`
  );
  const cappedAiHistory = capDashboardAiLocalHistory([
    { id: 'm1', role: 'user', content: 'Older message', createdAt: 1, context: aiContext },
    { id: 'm2', role: 'assistant', content: 'Recent answer', createdAt: 2, modelId: 'gemini-flash' },
  ], { maxMessages: 1, maxBytes: 1000 });
  assert(
    cappedAiHistory.length === 1 &&
      cappedAiHistory[0].id === 'm2' &&
      !JSON.stringify(cappedAiHistory).includes('DASHBOARD_CONTEXT_JSON') &&
      !JSON.stringify(cappedAiHistory).includes('selectedDriverRecords'),
    `Local AI history should be capped and must not persist dashboard context JSON, got ${JSON.stringify(cappedAiHistory)}`
  );
  const functionRequest = buildDashboardAiFunctionRequest({
    userPrompt: 'Explain top drivers',
    context: aiContext,
    history: [{ role: 'assistant', content: 'Previous answer' }],
    model: resolvedAiModel,
  });
  assert(
    functionRequest.modelId === 'qwen-plus' &&
      functionRequest.context === aiContext &&
      functionRequest.history.length === 1 &&
      functionRequest.maxRounds === 4 &&
      functionRequest.allowedTools.includes('query_dashboard_data') &&
      functionRequest.allowedTools.includes('compose_dashboard_ai_board') &&
      functionRequest.allowedTools.includes('suggest_visual_report') &&
      functionRequest.allowedReportTemplates.includes('mom-wow-analysis') &&
      functionRequest.allowedVisualReports.includes('peak-hour') &&
      !JSON.stringify(functionRequest).includes('apiKey'),
    `Frontend AI request should target the Edge Function by model id, allowed tools, report templates, and must not carry provider API keys, got ${JSON.stringify(functionRequest)}`
  );
  const toolsetAvailabilityWithoutModel = resolveDashboardAiAvailableTools({
    aiConfigured: false,
    operatorAuthorized: true,
    hasSelectedSeason: true,
    hasLocalRecords: true,
    selectedSeasonCount: 1,
    exportEnabled: true,
  });
  const toolsetAvailabilityWithTooManySeasons = resolveDashboardAiAvailableTools({
    aiConfigured: true,
    operatorAuthorized: true,
    hasSelectedSeason: true,
    hasLocalRecords: true,
    selectedSeasonCount: 4,
    exportEnabled: true,
  });
  const toolsetAvailabilityReady = resolveDashboardAiAvailableTools({
    aiConfigured: true,
    operatorAuthorized: true,
    hasSelectedSeason: true,
    hasLocalRecords: true,
    selectedSeasonCount: 2,
    exportEnabled: true,
  });
  assert(
    DASHBOARD_AI_TOOL_REGISTRY.every((tool) => tool.toolset && Array.isArray(tool.requires) && tool.outputContract) &&
      toolsetAvailabilityWithoutModel.every((tool) => tool.availability === 'disabled' && tool.disabledReason) &&
      toolsetAvailabilityWithTooManySeasons.find((tool) => tool.name === 'compose_dashboard_ai_board')?.availability === 'disabled' &&
      toolsetAvailabilityReady.find((tool) => tool.name === 'compose_dashboard_ai_board')?.availability === 'enabled' &&
      toolsetAvailabilityReady.find((tool) => tool.name === 'suggest_custom_workbook')?.toolset === 'dashboard-export',
    `Dashboard AI toolset gating should annotate tools with toolsets, requirements, and runtime availability, got ${JSON.stringify({ toolsetAvailabilityWithoutModel, toolsetAvailabilityWithTooManySeasons, toolsetAvailabilityReady })}`
  );
  const monthDriverSkill = resolveDashboardAiSkillForPrompt('táº¡o báº£ng so sÃ¡nh cÃ¡c Ä‘iá»ƒm khÃ¡c biá»‡t ná»•i báº­t cá»§a thÃ¡ng 6 vá»›i thÃ¡ng 5 theo hÃ£ng bay vÃ  Ä‘Æ°á»ng bay'); 
  const peakHourSkill = resolveDashboardAiSkillForPrompt('váº½ biá»ƒu Ä‘á»“ peak hour cho mÃ¹a Ä‘ang chá»n'); 
  const sqlAnalystSkill = resolveDashboardAiSkillForPrompt('thá»‘ng kÃª tá»« ngÃ y 01/06/2026 Ä‘áº¿n ngÃ y 07/06/2026 báº±ng raw local SQL'); 
  const edaProfileSkill = resolveDashboardAiSkillForPrompt('EDA tá»•ng quan dá»¯ liá»‡u thÃ¡ng 6, kiá»ƒm tra missing vÃ  outlier'); 
  const safeRenderingSkill = resolveDashboardAiSkillForPrompt('táº¡o HTML preview nhÆ°ng khÃ´ng cháº¡y script hoáº·c Python'); 
  assert( 
    DASHBOARD_AI_SKILL_REGISTRY.every((skill) => skill.id && skill.descriptionVi && Array.isArray(skill.triggersVi) && skill.preferredTool) && 
      monthDriverSkill?.id === 'month-comparison-drivers' && 
      monthDriverSkill.contextProfile === 'validated-sql' && 
      monthDriverSkill.blocks.some((block) => block.table?.templateId === 'custom-table' && block.source === 'resolvedDataRequest') && 
      peakHourSkill?.id === 'peak-hour-analysis' && 
      peakHourSkill.contextProfile === 'peak-hour' && 
      sqlAnalystSkill?.id === 'validated-sql-analyst' && 
      sqlAnalystSkill.contextProfile === 'validated-sql' && 
      edaProfileSkill?.id === 'eda-profile' && 
      safeRenderingSkill?.id === 'safe-rendering-policy', 
    `Dashboard AI skill registry should route Vietnamese prompts to report/EDA/safe-rendering skills, got ${JSON.stringify({ skills: DASHBOARD_AI_SKILL_REGISTRY, monthDriverSkill, peakHourSkill, sqlAnalystSkill, edaProfileSkill, safeRenderingSkill })}` 
  ); 
  const notebookContext = buildDashboardAiNotebookContext([
    {
      id: 'cell-1',
      prompt: 'táº¡o báº£ng so sÃ¡nh thÃ¡ng 6 vá»›i thÃ¡ng 5',
      assistantText: 'ÄÃ£ táº¡o báº£ng so sÃ¡nh theo hÃ£ng bay.',
      blocks: deterministicJuneMayAnswer.boardPatch?.blocks ?? [],
      toolTraceSummary: [{ tool: 'compose_dashboard_ai_board', status: 'accepted', reason: 'ÄÃ£ táº¡o block so sÃ¡nh.' }],
      exportAction: null,
      createdAt: 1,
      modelId: 'qwen-plus',
    },
  ], { maxCells: 1 });
  assert(
    notebookContext.cells.length === 1 &&
      notebookContext.cells[0].blockSummaries.some((block) => block.type === 'table' && block.templateId === 'custom-table') &&
      notebookContext.cells[0].toolTraceSummary[0].reason === 'ÄÃ£ táº¡o block so sÃ¡nh.' &&
      !JSON.stringify(notebookContext).includes('records') &&
      !JSON.stringify(notebookContext).includes('rows'),
    `Notebook memory lite should summarize prior cells without raw rendered rows, got ${JSON.stringify(notebookContext)}`
  );
  const vietnamesePrompt = buildDashboardAiPrompt({
    userPrompt: 'Táº¡o báº£ng so sÃ¡nh thÃ¡ng 6 vá»›i thÃ¡ng 5',
    context: aiContext,
    selectedSkillId: monthDriverSkill?.id,
    contextProfile: monthDriverSkill?.contextProfile,
    notebookContext,
    availableTools: toolsetAvailabilityReady,
    language: 'vi',
  });
  assert(
    vietnamesePrompt.includes('STABLE_AGENT_CONTRACT') &&
      vietnamesePrompt.includes('LANGUAGE_POLICY') &&
      vietnamesePrompt.includes('language: vi') &&
      (vietnamesePrompt.includes('LuÃ´n tráº£ lá»i báº±ng tiáº¿ng Viá»‡t') || vietnamesePrompt.includes('LuÃƒÂ´n trÃ¡ÂºÂ£ lÃ¡Â»Âi bÃ¡ÂºÂ±ng tiÃ¡ÂºÂ¿ng ViÃ¡Â»â€¡t')) &&
      vietnamesePrompt.includes('EPHEMERAL_DASHBOARD_CONTEXT') &&
      vietnamesePrompt.includes('month-comparison-drivers') &&
      vietnamesePrompt.includes('notebookContext') &&
      !vietnamesePrompt.includes('apiKey'),
    `Dashboard AI prompt should separate stable contract from ephemeral context and enforce Vietnamese output, got ${vietnamesePrompt}`
  );
  const functionRequestWithHermesPattern = buildDashboardAiFunctionRequest({
    userPrompt: 'Táº¡o báº£ng so sÃ¡nh thÃ¡ng 6 vá»›i thÃ¡ng 5',
    context: aiContext,
    history: [{ role: 'assistant', content: 'CÃ¢u tráº£ lá»i trÆ°á»›c' }],
    model: resolvedAiModel,
    preferredTool: 'compose_dashboard_ai_board',
    availableTools: toolsetAvailabilityReady,
    selectedSkillId: monthDriverSkill?.id,
    contextProfile: monthDriverSkill?.contextProfile,
    notebookContext,
    language: 'vi',
    providerFallback: true,
  });
  assert(
    functionRequestWithHermesPattern.language === 'vi' &&
      functionRequestWithHermesPattern.selectedSkillId === 'month-comparison-drivers' &&
      functionRequestWithHermesPattern.contextProfile === 'validated-sql' &&
      functionRequestWithHermesPattern.notebookContext?.cells.length === 1 &&
      functionRequestWithHermesPattern.availableTools.some((tool) => tool.name === 'compose_dashboard_ai_board' && tool.availability === 'enabled') &&
      functionRequestWithHermesPattern.providerFallback === true,
    `Frontend AI request should carry Vietnamese language, selected skill, tool availability, notebook context, and provider fallback flags, got ${JSON.stringify(functionRequestWithHermesPattern)}`
  );
  const agentRuntimeConfig = buildDashboardAgentRuntimeConfig();
  assert(
    agentRuntimeConfig.ownerWorkflow === 'dashboard-report-analysis' &&
      agentRuntimeConfig.maxRounds === 4 &&
      agentRuntimeConfig.hooks.includes('allowed_tool_list') &&
      agentRuntimeConfig.tools.some((tool) => tool.name === 'query_dashboard_data' && tool.outputContract.includes('reporting.flight_operations')) &&
      agentRuntimeConfig.tools.some((tool) => tool.name === 'compose_dashboard_ai_board' && tool.outputContract.includes('whitelisted board blocks')) &&
      agentRuntimeConfig.tools.some((tool) => tool.name === 'suggest_visual_report' && tool.description.includes('visual report')),
    `Dashboard agent runtime should expose one owner workflow, bounded loop, hooks, and precise tool descriptions, got ${JSON.stringify(agentRuntimeConfig)}`
  );
  assert(
    JSON.stringify(DASHBOARD_AI_TOOL_REGISTRY.map((tool) => tool.name)) === JSON.stringify(['query_dashboard_data', 'suggest_custom_workbook', 'suggest_visual_report', 'compose_dashboard_ai_board']) &&
      DASHBOARD_AI_TOOL_SELECTION_FIXTURES.every((fixture) => fixture.prompt && fixture.expectedTool && fixture.tuningSurface && fixture.fixHint) &&
      resolveDashboardAgentToolForPrompt('xuáº¥t sáº£n lÆ°á»£ng thÃ¡ng 7 sang Excel') === 'suggest_custom_workbook' &&
      resolveDashboardAgentToolForPrompt('váº½ peak hour visual report cho thÃ¡ng nÃ y') === 'suggest_visual_report' &&
      resolveDashboardAgentToolForPrompt('so sÃ¡nh thÃ¡ng 8 VJ ngoÃ i báº£ng hiá»‡n táº¡i') === 'query_dashboard_data' &&
      resolveDashboardAgentToolForPrompt('táº¡o workbook riÃªng gá»“m airline vÃ  route') === 'suggest_custom_workbook',
    `Dashboard agent tool registry and prompt fixtures should lock report/data/visual routing, got ${JSON.stringify({ tools: DASHBOARD_AI_TOOL_REGISTRY, fixtures: DASHBOARD_AI_TOOL_SELECTION_FIXTURES })}`
  );
  assert(
    resolveDashboardAgentToolForPrompt('AI workspace whiteboard compare three seasons') === 'compose_dashboard_ai_board',
    'Dashboard agent routing should send AI workspace whiteboard prompts to compose_dashboard_ai_board'
  );
  const workspaceRoutingResults = [
    'Build visual report',
    'Draw peak hour chart',
    'Create driver table',
    'Compare selected seasons',
    'táº¡o báº£ng tráº¯ng so sÃ¡nh 3 mÃ¹a',
    'váº½ biá»ƒu Ä‘á»“ peak hour',
    'láº­p report dáº¡ng báº£ng',
  ].map((prompt) => ({ prompt, tool: resolveDashboardAiWorkspaceToolForPrompt(prompt) }));
  assert(
    workspaceRoutingResults.every((entry) => entry.tool === 'compose_dashboard_ai_board'),
    `AI Workspace visual/table/chart presets and Vietnamese prompts must route to compose_dashboard_ai_board, got ${JSON.stringify(workspaceRoutingResults)}`
  );
  const safeVisualReport = resolveDashboardAiVisualReport({
    templateId: 'peak-hour',
    title: 'Peak Hour Visual <script>',
    filters: { comparisonMode: 'mom', metric: 'flights', typeFilter: 'D', dimension: 'hourBucket', timeBasis: 'utc' },
    blocks: [
      { id: '../peak block', type: 'peak-hour', title: 'UTC Peak Hour', source: 'overview', metric: 'flights', dimension: 'hourBucket', limit: 99, html: '<script>alert(1)</script>' },
      { id: 'notes', type: 'insight-notes', title: 'Notes', source: 'comparison', limit: 3 },
    ],
    insights: ['DEP wave concentrates around 18 UTC.', '=unsafe formula insight'],
    dataQualityNotes: ['Uses active dashboard filters only.'],
  });
  assert(
    safeVisualReport?.templateId === 'peak-hour' &&
      safeVisualReport.title === 'Peak Hour Visual script' &&
      safeVisualReport.filters.timeBasis === 'utc' &&
      safeVisualReport.blocks[0].id === 'peak-block' &&
      safeVisualReport.blocks[0].limit === 24 &&
      safeVisualReport.blocks[0].type === 'peak-hour' &&
      safeVisualReport.blocks[1].type === 'insight-notes' &&
      safeVisualReport.insights[1] === "'=unsafe formula insight" &&
      DASHBOARD_AI_VISUAL_REPORT_TEMPLATE_IDS.includes('airline-mix') &&
      !JSON.stringify(safeVisualReport).includes('html') &&
      !JSON.stringify(safeVisualReport).includes('<script>'),
    `AI visual report sanitizer should accept whitelisted visual specs and strip unsafe fields, got ${JSON.stringify(safeVisualReport)}`
  );
  assert(
    resolveDashboardAiVisualReport({ templateId: 'raw-html', title: 'Unsafe', blocks: [{ type: 'html', title: 'x' }] }) == null &&
      resolveDashboardAiToolTraceSummary([{ tool: 'write_file', status: 'accepted', reason: 'nope' }]).length === 0 &&
      resolveDashboardAiToolTraceSummary([{ tool: 'suggest_visual_report', status: 'accepted', reason: 'safe visual' }])[0].tool === 'suggest_visual_report',
    'AI visual report and tool trace parsers must reject unknown templates, unknown tools, and arbitrary write actions'
  );
  const safeBoardPatch = resolveDashboardAiBoardPatch({
    title: 'AI Workspace <script>',
    blocks: [
      {
        id: '../chart block',
        type: 'chart',
        title: 'Peak Hour Chart',
        source: 'overview',
        chart: { chartType: 'bar-ranking', title: 'Peak Hour', source: 'overview', series: ['flights'], limit: 99, html: '<script>alert(1)</script>' },
      },
      {
        id: 'driver-table',
        type: 'table',
        title: 'Driver Table',
        source: 'resolvedDataRequest',
        table: { templateId: 'custom-table', title: 'Drivers', columns: ['label', 'current', 'previous', 'delta', 'deltaPct'], rows: [{ label: 'VN', current: 10, previous: 8, delta: 2, deltaPct: 25 }], source: 'resolvedDataRequest', sourceQueryId: 'drivers-query', limit: 40 },
      },
      {
        id: 'notes',
        type: 'insight-list',
        title: 'Notes',
        source: 'resolvedDataRequest',
        insights: ['=unsafe formula note', 'Use selected seasons only.'],
      },
    ],
    arbitraryWrite: { path: 'C:/unsafe.xlsx' },
  });
  const initialAiBoard = buildDashboardAiWorkspaceBoard({
    seasonIds: ['season-c', 'season-a', 'season-a', 'season-b'],
    title: 'Current AI Board',
    now: new Date('2026-05-19T00:00:00.000Z'),
  });
  const updatedAiBoard = applyDashboardAiWorkspaceBoardPatch(initialAiBoard, safeBoardPatch, {
    now: new Date('2026-05-19T00:10:00.000Z'),
  });
  assert(
    JSON.stringify(normalizeDashboardAiWorkspaceSeasonIds(['season-b', 'season-a', 'season-c', 'season-d', 'season-a'])) === JSON.stringify(['season-b', 'season-a', 'season-c']) &&
      safeBoardPatch?.title === 'AI Workspace script' &&
      safeBoardPatch.blocks.length === 3 &&
      safeBoardPatch.blocks[0].id === 'chart-block' &&
      safeBoardPatch.blocks[0].chart?.chartType === 'bar-ranking' &&
      safeBoardPatch.blocks[0].chart?.limit === 24 &&
      safeBoardPatch.blocks[1].table?.limit === 24 &&
      safeBoardPatch.blocks[1].table?.templateId === 'custom-table' &&
      safeBoardPatch.blocks[2].insights?.[0] === "'=unsafe formula note" &&
      updatedAiBoard.seasonIds.length === 3 &&
      updatedAiBoard.blocks.length === 3 &&
      !JSON.stringify(safeBoardPatch).includes('html') &&
      !JSON.stringify(safeBoardPatch).includes('<script>') &&
      !JSON.stringify(safeBoardPatch).includes('arbitraryWrite'),
    `AI Workspace board patch sanitizer should accept whitelisted board blocks, cap multi-season scope, and reject unsafe fields, got ${JSON.stringify({ safeBoardPatch, updatedAiBoard })}`
  );
  assert(
    resolveDashboardAiBoardPatch({ title: 'Unsafe', blocks: [{ type: 'iframe', title: 'x', source: 'overview' }] }) == null &&
      resolveDashboardAiBoardPatch({ title: 'Unsafe', blocks: [{ type: 'chart', title: 'x', source: 'overview', chart: { chartType: 'raw-html', source: 'overview' } }] }) == null,
    'AI Workspace board parser must reject unknown block and chart types'
  );
  const safeQueryResults = resolveDashboardAiQueryResults([{
    queryId: 'route-pax',
    view: 'flight_operations',
    columns: ['Route', 'Pax', 'Flights'],
    rows: [
      { Route: 'HAN', Pax: 1200, Flights: 12, Unsafe: '<script>alert(1)</script>' },
      { Route: 'SGN', Pax: '=SUM(1,2)', Flights: 10 },
    ],
    rowCount: 2,
    truncated: false,
    dataQualityNotes: ['Nguá»“n dá»¯ liá»‡u reporting.flight_operations'],
  }]);
  const queryBoardPatch = buildDashboardAiBoardPatchFromQueryResults(safeQueryResults, 'Top 10 route cÃ³ PAX cao nháº¥t trong thÃ¡ng 3');
  assert(
    safeQueryResults[0]?.columns.join('|') === 'Route|Pax|Flights' &&
      safeQueryResults[0].rows[1].Pax === "'=SUM(1,2)" &&
      queryBoardPatch?.blocks.some((block) => block.table?.templateId === 'custom-table' && block.table.rows?.[0].Route === 'HAN') &&
      queryBoardPatch.blocks.some((block) => block.chart?.sourceQueryId === 'route-pax' && block.chart.series.includes('Pax')) &&
      !JSON.stringify(queryBoardPatch).includes('<script>'),
    `Query-first AI blocks should preserve custom columns/rows, sanitize unsafe cells, and drive charts from sourceQueryId, got ${JSON.stringify({ safeQueryResults, queryBoardPatch })}`
  );
  const dateRangeQuery = inferDashboardAiDataQueryForPrompt({
    userPrompt: 'thá»‘ng kÃª tá»« 01/06/2026 Ä‘áº¿n 07/06/2026',
    context: aiContext,
  });
  const consecutiveSeasonQuery = inferDashboardAiDataQueryForPrompt({
    userPrompt: 'so sÃ¡nh mÃ¹a liÃªn tiáº¿p',
    context: {
      ...aiContext,
      multiSeasonCatalog: {
        seasonIds: ['season-s25', 'season-s26'],
        seasons: [
          { seasonId: 'season-s25', seasonCode: 'S25', name: 'DAD S25', totalRecords: 100, dateRange: { from: '2025-03-30', to: '2025-10-25' } },
          { seasonId: 'season-s26', seasonCode: 'S26', name: 'DAD S26', totalRecords: 120, dateRange: { from: '2026-03-29', to: '2026-10-24' } },
        ],
      },
    },
  });
  const countryQuery = inferDashboardAiDataQueryForPrompt({
    userPrompt: 'top quá»‘c gia cÃ³ nhiá»u chuyáº¿n bay nháº¥t',
    context: aiContext,
  });
  const aircraftQuery = inferDashboardAiDataQueryForPrompt({
    userPrompt: 'thá»‘ng kÃª theo mÃ¡y bay thÃ¡ng 7',
    context: aiContext,
  });
  const arrDepMixQuery = inferDashboardAiDataQueryForPrompt({
    userPrompt: 'tá»•ng ARR/DEP mix thÃ¡ng 7',
    context: aiContext,
  });
  assert(
    dateRangeQuery?.filters.dateFrom === '2026-06-01' &&
      dateRangeQuery.filters.dateTo === '2026-06-07' &&
      dateRangeQuery.groupBy.includes('ops_date') &&
      consecutiveSeasonQuery?.filters.seasonIds?.join('|') === 'season-s25|season-s26' &&
      consecutiveSeasonQuery.groupBy.includes('season') &&
      countryQuery?.groupBy.includes('country') &&
      aircraftQuery?.groupBy.includes('aircraft') &&
      arrDepMixQuery?.groupBy.includes('type'),
    `AI query inference should parse date ranges, selected consecutive seasons, and dynamic dimensions, got ${JSON.stringify({ dateRangeQuery, consecutiveSeasonQuery, countryQuery, aircraftQuery, arrDepMixQuery })}`
  );
  assert(
    shouldPreferDashboardAiQueryResults({
      userPrompt: 'thá»‘ng kÃª tá»« 01/06/2026 Ä‘áº¿n 07/06/2026',
      queryResults: safeQueryResults,
      boardPatch: safeBoardPatch,
    }),
    'Query-intent responses with queryResults should reject stale provider boardPatch without matching sourceQueryId'
  );
  const richNotebookPatch = resolveDashboardAiBoardPatch({ 
    title: 'BÃ¡o cÃ¡o rich',
    blocks: [
      {
        id: 'rich-1',
        type: 'rich-markdown',
        title: 'TÃ³m táº¯t markdown',
        source: 'resolvedDataRequest',
        markdown: {
          content: '## BÃ¡o cÃ¡o\n\n| Chá»‰ tiÃªu | GiÃ¡ trá»‹ |\n| --- | ---: |\n| Chuyáº¿n bay | 10 |',
        },
      },
      {
        id: 'html-1',
        type: 'html-preview',
        title: 'HTML preview',
        source: 'resolvedDataRequest',
        htmlPreview: {
          html: '<div onclick="alert(1)"><script>alert(1)</script><form><input /></form><strong>OK</strong><iframe src="https://x.test"></iframe></div>',
        },
      },
    ],
    append: false,
  });
  const htmlPreview = richNotebookPatch?.blocks.find((block) => block.type === 'html-preview')?.htmlPreview?.html ?? '';
  assert( 
    richNotebookPatch?.blocks.some((block) => block.type === 'rich-markdown' && block.markdown?.content.includes('| Chá»‰ tiÃªu | GiÃ¡ trá»‹ |')) && 
      htmlPreview.includes('<strong>OK</strong>') && 
      !/script|onclick|<form|<iframe/i.test(htmlPreview), 
    `Rich notebook blocks should keep markdown tables and sanitize sandboxed HTML preview, got ${JSON.stringify(richNotebookPatch)}` 
  ); 
  const profileQueryResults = [{ 
    queryId: 'peak-day-daily', 
    view: 'flight_operations', 
    columns: ['ops_date', 'flights', 'pax', 'airline'], 
    rows: [ 
      { ops_date: '2026-06-01', flights: 90, pax: 1200, airline: 'VN' }, 
      { ops_date: '2026-06-02', flights: 300, pax: 2400, airline: 'VJ' }, 
      { ops_date: '2026-06-03', flights: null, pax: 0, airline: 'VN' }, 
    ], 
    rowCount: 3, 
    truncated: false, 
    dataQualityNotes: ['Nguá»“n: SQLite local'], 
  }]; 
  const profiles = profileDashboardAiQueryResults(profileQueryResults); 
  const passedVerification = verifyDashboardAiAnswerAgainstQueryResults({ assistantText: 'NgÃ y cao Ä‘iá»ƒm cÃ³ 300 chuyáº¿n vÃ  2400 PAX.', queryResults: profileQueryResults, profiles });  
  const derivedVerification = verifyDashboardAiAnswerAgainstQueryResults({ assistantText: 'NgÃ y cao Ä‘iá»ƒm cÃ³ 300 chuyáº¿n, vÆ°á»£t trung bÃ¬nh 195.0 chuyáº¿n/ngÃ y khoáº£ng 53.8%.', queryResults: profileQueryResults, profiles });  
  const warningVerification = verifyDashboardAiAnswerAgainstQueryResults({ assistantText: 'NgÃ y cao Ä‘iá»ƒm cÃ³ 999 chuyáº¿n.', queryResults: profileQueryResults, profiles });  
  assert(  
    profiles[0].dateCoverage.from === '2026-06-01' && 
      profiles[0].dateCoverage.to === '2026-06-03' && 
      profiles[0].nullCounts.flights === 1 && 
      profiles[0].distinctCounts.airline === 2 && 
      profiles[0].metricStats.pax.max === 2400 &&  
      profiles[0].outlierCandidates.some((candidate) => candidate.column === 'flights') &&  
      passedVerification.status === 'passed' &&  
      derivedVerification.status === 'passed' && 
      warningVerification.status === 'warning' &&  
      warningVerification.unsupportedNumbers.includes('999'),  
    `Dashboard AI should profile query results, accept derived averages/percentages, and warn on unsupported answer numbers, got ${JSON.stringify({ profiles, passedVerification, derivedVerification, warningVerification })}`  
  );  
  const followUpDriverPatch = buildDashboardAiFollowUpBoardPatchFromCells({ 
    userPrompt: 'phÃ¢n tÃ­ch driver', 
    cells: [{ 
      id: 'cell-peak', 
      prompt: 'TÃ¬m ngÃ y cao Ä‘iá»ƒm cá»§a thÃ¡ng 6', 
      assistantText: 'NgÃ y cao Ä‘iá»ƒm lÃ  2026-06-02.', 
      blocks: buildDashboardAiBoardPatchFromQueryResults([ 
        profileQueryResults[0], 
        { 
          queryId: 'peak-day-drilldown', 
          view: 'flight_operations', 
          columns: ['airline', 'route', 'local_hour', 'type', 'flights', 'pax'], 
          rows: [ 
            { airline: 'VJ', route: 'SIN', local_hour: 8, type: 'D', flights: 4, pax: 640 }, 
            { airline: 'VN', route: 'HAN', local_hour: 9, type: 'A', flights: 3, pax: 420 }, 
            { airline: 'VN', route: 'HAN', local_hour: 10, type: 'D', flights: 2, pax: 300 }, 
          ], 
          rowCount: 3, 
          truncated: false, 
          dataQualityNotes: [], 
        }, 
      ], 'TÃ¬m ngÃ y cao Ä‘iá»ƒm cá»§a thÃ¡ng 6')?.blocks ?? [], 
      toolTraceSummary: [], 
      exportAction: null, 
      createdAt: 1, 
      modelId: 'qwen-plus', 
    }], 
  }); 
  assert( 
    followUpDriverPatch?.title.includes('Driver') && 
      followUpDriverPatch.blocks.some((block) => block.id === 'followup-driver-airline-table' && block.table?.rows?.some((row) => row.airline === 'VJ' && row.flights === 4)) && 
      followUpDriverPatch.blocks.some((block) => block.type === 'insight-list' && block.insights?.some((insight) => insight.includes('cell'))), 
    `Short driver follow-up should reuse previous peak-day rich chat rows instead of falling back to MoM context, got ${JSON.stringify(followUpDriverPatch)}` 
  ); 
  const initialAnomalyPatch = buildDashboardAiBoardPatchFromQueryResults([ 
    profileQueryResults[0], 
    { 
      queryId: 'peak-day-drilldown', 
      view: 'flight_operations', 
      columns: ['airline', 'route', 'local_hour', 'type', 'flights', 'pax'], 
      rows: [ 
        { airline: 'VJ', route: 'SIN', local_hour: 8, type: 'D', flights: 4, pax: 640 }, 
        { airline: 'VN', route: 'HAN', local_hour: 9, type: 'A', flights: 3, pax: 420 }, 
        { airline: 'VN', route: 'HAN', local_hour: 10, type: 'D', flights: 2, pax: 300 }, 
      ], 
      rowCount: 3, 
      truncated: false, 
      dataQualityNotes: [], 
    }, 
  ], 'tim ngay cao diem cua thang 6 va diem bat thuong so voi cac ngay con lai'); 
  const providerPartialPatch = resolveDashboardAiBoardPatch({ 
    title: 'Partial provider patch', 
    blocks: [{ 
      id: 'partial-table', 
      type: 'table', 
      title: 'Báº£ng provider thiáº¿u driver', 
      source: 'resolvedDataRequest', 
      table: { templateId: 'custom-table', title: 'Báº£ng provider thiáº¿u driver', columns: ['ops_date', 'flights'], rows: [{ ops_date: '2026-06-02', flights: 300 }], source: 'resolvedDataRequest', sourceQueryId: 'peak-day-daily', filters: {}, limit: 1 }, 
    }], 
    append: false, 
  }); 
  assert(
      !initialAnomalyPatch?.blocks.some((block) => block.id === 'peak-day-driver-airline-table' || block.id === 'peak-day-driver-route-table' || block.id === 'peak-day-driver-hour-chart') &&
      initialAnomalyPatch?.blocks.some((block) => block.id === 'peak-day-baseline-required' && block.insights?.some((insight) => insight.includes('baseline'))) &&
      shouldPreferDashboardAiQueryResults({ userPrompt: 'tim ngay cao diem cua thang 6 va diem bat thuong so voi cac ngay con lai', queryResults: profileQueryResults, boardPatch: providerPartialPatch }), 
    `Initial anomaly prompt should not label same-day drilldown as anomaly when baseline-vs-rest rows are missing, got ${JSON.stringify({ initialAnomalyPatch, providerPartialPatch })}` 
  ); 
  const anomalyDrilldownPlans = planDashboardAiSqlDrilldownQueries({
    userPrompt: 'TÃƒÂ¬m ngÃƒÂ y cao Ã„â€˜iÃ¡Â»Æ’m cÃ¡Â»Â§a thÃƒÂ¡ng 6 vÃƒÂ  Ã„â€˜iÃ¡Â»Æ’m bÃ¡ÂºÂ¥t thÃ†Â°Ã¡Â»Âng so vÃ¡Â»â€ºi cÃƒÂ¡c ngÃƒÂ y cÃƒÂ²n lÃ¡ÂºÂ¡i',
    queryResults: [profileQueryResults[0]],
    source: 'local-sqlite',
  });
  const initialBaselineAnomalyPatch = buildDashboardAiBoardPatchFromQueryResults([
    profileQueryResults[0],
    {
      queryId: 'peak-day-drilldown',
      view: 'flight_operations',
      columns: ['airline', 'route', 'local_hour', 'type', 'flights', 'pax'],
      rows: [
        { airline: 'VJ', route: 'SIN', local_hour: 8, type: 'D', flights: 4, pax: 640 },
        { airline: 'VN', route: 'HAN', local_hour: 9, type: 'A', flights: 3, pax: 420 },
        { airline: 'VN', route: 'HAN', local_hour: 10, type: 'D', flights: 2, pax: 300 },
      ],
      rowCount: 3,
      truncated: false,
      dataQualityNotes: [],
    },
    {
      queryId: 'peak-day-airline-baseline',
      view: 'flight_operations',
      columns: ['airline', 'peak_flights', 'baseline_avg_flights', 'delta_vs_baseline', 'delta_pct', 'peak_pax'],
      rows: [
        { airline: 'VJ', peak_flights: 4, baseline_avg_flights: 1.0, delta_vs_baseline: 3.0, delta_pct: 300.0, peak_pax: 640 },
        { airline: 'VN', peak_flights: 5, baseline_avg_flights: 4.0, delta_vs_baseline: 1.0, delta_pct: 25.0, peak_pax: 720 },
      ],
      rowCount: 2,
      truncated: false,
      dataQualityNotes: [],
    },
    {
      queryId: 'peak-day-route-baseline',
      view: 'flight_operations',
      columns: ['route', 'peak_flights', 'baseline_avg_flights', 'delta_vs_baseline', 'delta_pct', 'peak_pax'],
      rows: [
        { route: 'SIN', peak_flights: 4, baseline_avg_flights: 0.5, delta_vs_baseline: 3.5, delta_pct: 700.0, peak_pax: 640 },
      ],
      rowCount: 1,
      truncated: false,
      dataQualityNotes: [],
    },
  ], 'TÃƒÂ¬m ngÃƒÂ y cao Ã„â€˜iÃ¡Â»Æ’m cÃ¡Â»Â§a thÃƒÂ¡ng 6 vÃƒÂ  Ã„â€˜iÃ¡Â»Æ’m bÃ¡ÂºÂ¥t thÃ†Â°Ã¡Â»Âng so vÃ¡Â»â€ºi cÃƒÂ¡c ngÃƒÂ y cÃƒÂ²n lÃ¡ÂºÂ¡i');
  assert(
    anomalyDrilldownPlans.some((plan) => plan.queryId === 'peak-day-airline-baseline' && plan.sql.includes('ops_date != ?')) &&
      anomalyDrilldownPlans.some((plan) => plan.queryId === 'peak-day-route-baseline' && plan.sql.includes('ops_date != ?')) &&
      initialBaselineAnomalyPatch?.blocks.some((block) => block.id === 'peak-day-baseline-airline-table' && block.table?.rows?.some((row) => row.airline === 'VJ' && row.delta_vs_baseline === 3.0)) &&
      initialBaselineAnomalyPatch.blocks.some((block) => block.id === 'peak-day-baseline-route-table' && block.table?.rows?.some((row) => row.route === 'SIN' && row.delta_vs_baseline === 3.5)) &&
      initialBaselineAnomalyPatch.blocks.some((block) => block.id === 'peak-day-driver-insights' && block.insights?.some((insight) => insight.includes('baseline'))),
    `Initial anomaly prompt should compare peak-day drivers against the other days in the month, got ${JSON.stringify({ anomalyDrilldownPlans, initialBaselineAnomalyPatch })}`
  );
  const memoryCell = {
    id: 'cell-peak',
    prompt: 'tim ngay cao diem thang 6',
    assistantText: 'Ngay cao diem la 2026-06-02.',
    blocks: initialBaselineAnomalyPatch?.blocks ?? [],
    toolTraceSummary: [],
    exportAction: null,
    createdAt: 10,
    modelId: 'qwen-plus',
    queryResults: [
      profileQueryResults[0],
      {
        queryId: 'peak-day-drilldown',
        view: 'flight_operations',
        columns: ['airline', 'route', 'local_hour', 'type', 'flights', 'pax'],
        rows: [
          { airline: 'VJ', route: 'SIN', local_hour: 8, type: 'D', flights: 4, pax: 640 },
          { airline: 'VN', route: 'HAN', local_hour: 9, type: 'A', flights: 3, pax: 420 },
          { airline: 'VN', route: 'HAN', local_hour: 10, type: 'D', flights: 2, pax: 300 },
          ...Array.from({ length: 140 }, (_, index) => ({ airline: `X${index}`, route: `R${index}`, local_hour: index % 24, type: 'D', flights: 1, pax: 10 })),
        ],
        rowCount: 143,
        truncated: false,
        dataQualityNotes: [],
      },
      {
        queryId: 'peak-day-route-baseline',
        view: 'flight_operations',
        columns: ['route', 'peak_flights', 'baseline_avg_flights', 'delta_vs_baseline', 'delta_pct', 'peak_pax'],
        rows: [{ route: 'SIN', peak_flights: 4, baseline_avg_flights: 0.5, delta_vs_baseline: 3.5, delta_pct: 700, peak_pax: 640 }],
        rowCount: 1,
        truncated: false,
        dataQualityNotes: [],
      },
    ],
    resultProfiles: profiles,
    answerVerification: passedVerification,
  };
  memoryCell.activeArtifact = buildDashboardAiActiveArtifactFromCell(memoryCell, { sourceCellIndex: 1 });
  const oldMemoryCell = {
    ...memoryCell,
    id: 'cell-old',
    prompt: 'old',
    assistantText: 'old',
    createdAt: 1,
    queryResults: [{
      queryId: 'old-large',
      view: 'flight_operations',
      columns: ['idx', 'flights'],
      rows: Array.from({ length: 130 }, (_, index) => ({ idx: index, flights: index })),
      rowCount: 130,
      truncated: false,
      dataQualityNotes: [],
    }],
    activeArtifact: null,
  };
  const memoryContext = buildDashboardAiNotebookContext([oldMemoryCell, memoryCell], { maxCells: 2, activeCellId: 'cell-peak', maxActiveRows: 2 });
  const driverFollowUp = resolveDashboardAiSessionFollowUp({ userPrompt: 'phan tich driver', cells: [memoryCell] });
  const routeFollowUpFromPinned = resolveDashboardAiSessionFollowUp({ userPrompt: 'so sanh ngay do theo route', cells: [memoryCell], pinnedCellId: 'cell-peak' });
  const routeSqlFollowUp = resolveDashboardAiSessionFollowUp({
    userPrompt: 'so sanh ngay do theo route',
    cells: [{
      ...memoryCell,
      id: 'cell-minimal',
      blocks: [],
      queryResults: [profileQueryResults[0]],
      activeArtifact: {
        sourceCellId: 'cell-minimal',
        queryIds: ['peak-day-daily'],
        dateRange: { from: '2026-06-02', to: '2026-06-02' },
        month: '2026-06',
        seasonIds: [],
        entities: { peakDate: '2026-06-02', metric: 'flights', routes: [], airlines: [], hours: [] },
        blockIds: [],
        summaryVi: 'NgÃ y cao Ä‘iá»ƒm 2026-06-02',
      },
    }],
  });
  const chartFollowUp = resolveDashboardAiSessionFollowUp({ userPrompt: 've them chart tu bang tren', cells: [memoryCell] });
  const missingPinnedFallsBack = resolveDashboardAiSessionFollowUp({ userPrompt: 'phan tich driver', cells: [memoryCell], pinnedCellId: 'deleted-cell' });
  const freshScopedAnomalyPrompt = resolveDashboardAiSessionFollowUp({
    userPrompt: 'tim ngay cao diem cua thang 6 va diem bat thuong so voi cac ngay con lai',
    cells: [memoryCell],
  });
  const freshScopedRoutePrompt = resolveDashboardAiSessionFollowUp({
    userPrompt: 'Top 10 route co PAX cao nhat trong thang 3',
    cells: [memoryCell],
  });
  const staleFollowUpPatchForFreshPrompt = buildDashboardAiFollowUpBoardPatchFromCells({
    userPrompt: 'tim ngay cao diem cua thang 6 va diem bat thuong so voi cac ngay con lai',
    cells: [memoryCell],
  });
  assert(
    memoryCell.activeArtifact?.entities?.peakDate === '2026-06-02' &&
      memoryContext.activeArtifact?.sourceCellId === 'cell-peak' &&
      memoryContext.activeQuerySample?.some((result) => result.queryId === 'peak-day-drilldown' && result.rows.length === 2 && result.truncated === true) &&
      !('queryResults' in memoryContext.cells[0]) &&
      driverFollowUp?.sourceCellId === 'cell-peak' &&
      driverFollowUp.assistantText.includes('#1') &&
      driverFollowUp.boardPatch?.blocks.some((block) => block.id === 'peak-day-baseline-route-table') &&
      routeFollowUpFromPinned?.sourceCellId === 'cell-peak' &&
      routeFollowUpFromPinned.boardPatch?.blocks.some((block) => block.table?.sourceQueryId === 'peak-day-route-baseline') &&
      routeSqlFollowUp?.sqlQueryPlans?.some((plan) => plan.queryId === 'followup-route-by-date' && plan.params[0] === '2026-06-02') &&
      chartFollowUp?.boardPatch?.blocks.some((block) => block.id === 'followup-chart-from-table' && block.type === 'chart') &&
      missingPinnedFallsBack?.sourceCellId === 'cell-peak' &&
      freshScopedAnomalyPrompt === null &&
      freshScopedRoutePrompt === null &&
      staleFollowUpPatchForFreshPrompt === null,
    `Dashboard AI session memory should persist capped active query context, resolve follow-up prompts from active/pinned cells, and not hijack fresh scoped prompts, got ${JSON.stringify({ memoryContext, driverFollowUp, routeFollowUpFromPinned, routeSqlFollowUp, chartFollowUp, missingPinnedFallsBack, freshScopedAnomalyPrompt, freshScopedRoutePrompt, staleFollowUpPatchForFreshPrompt })}`
  );
  const visualFallbackPatch = buildDashboardAiFallbackBoardPatch({  
    userPrompt: 'Build visual report',
    preferredTool: 'compose_dashboard_ai_board',
    visualReport: safeVisualReport,
  });
  const markdownOnlyFallbackPatch = buildDashboardAiFallbackBoardPatch({
    userPrompt: 'Build visual report',
    preferredTool: 'compose_dashboard_ai_board',
  });
  const peakHourFallbackPatch = buildDashboardAiFallbackBoardPatch({
    userPrompt: 'váº½ biá»ƒu Ä‘á»“ peak hour',
    preferredTool: 'compose_dashboard_ai_board',
  });
  const tableFallbackPatch = buildDashboardAiFallbackBoardPatch({
    userPrompt: 'láº­p report dáº¡ng báº£ng',
    preferredTool: 'compose_dashboard_ai_board',
  });
  assert(
    visualFallbackPatch?.blocks.some((block) => block.type === 'chart' && block.chart?.filters?.dimension === 'hourBucket') &&
      markdownOnlyFallbackPatch?.blocks.some((block) => block.type === 'kpi') &&
      markdownOnlyFallbackPatch?.blocks.some((block) => block.type === 'chart' && block.chart?.chartType === 'line-trend') &&
      markdownOnlyFallbackPatch?.blocks.some((block) => block.type === 'table' && block.table?.templateId === 'airline-ranking') &&
      markdownOnlyFallbackPatch?.blocks.some((block) => block.type === 'insight-list') &&
      peakHourFallbackPatch?.blocks.some((block) => block.type === 'table' && block.table?.templateId === 'peak-hour') &&
      tableFallbackPatch?.blocks.some((block) => block.type === 'table'),
    `AI Workspace fallback should synthesize safe board blocks for visual/text-only responses, got ${JSON.stringify({ visualFallbackPatch, markdownOnlyFallbackPatch, peakHourFallbackPatch, tableFallbackPatch })}`
  );
  const comparisonDifferenceFallbackPatch = buildDashboardAiFallbackBoardPatch({
    userPrompt: 'tao bang so sanh cac diem khac biet noi bat cua thang 6 voi thang 5',
    preferredTool: 'compose_dashboard_ai_board',
  });
  assert(
    comparisonDifferenceFallbackPatch?.blocks[0]?.table?.templateId === 'custom-table' &&
      comparisonDifferenceFallbackPatch.blocks[0].source === 'resolvedDataRequest' &&
      comparisonDifferenceFallbackPatch.blocks[0].table?.filters?.currentMonth === '06' &&
      comparisonDifferenceFallbackPatch.blocks[0].table?.filters?.previousMonth === '05' &&
      /kh.{0,6}c bi.{0,6}t/i.test(comparisonDifferenceFallbackPatch.blocks[0].title) &&
      comparisonDifferenceFallbackPatch.blocks.some((block) => block.chart?.chartType === 'waterfall' && block.title.includes('Waterfall')) &&
      comparisonDifferenceFallbackPatch.blocks.some((block) => block.insights?.some((insight) => insight.includes('SQL') || insight.includes('query'))) &&
      !JSON.stringify(comparisonDifferenceFallbackPatch).includes('comparison-drivers') &&
      !comparisonDifferenceFallbackPatch.blocks.some((block) => block.table?.templateId === 'season-summary') &&
      !comparisonDifferenceFallbackPatch.blocks.some((block) => block.table?.templateId === 'airline-ranking'),
    `AI Workspace fallback should map month comparison prompts to query-only custom blocks, got ${JSON.stringify(comparisonDifferenceFallbackPatch)}`
  );
  const edgeInvocations = [];
  const edgeAnswer = await analyzeDashboardWithAi({
    userPrompt: 'Explain top drivers',
    context: aiContext,
    history: [{ role: 'assistant', content: 'Previous answer' }],
    model: resolvedAiModel,
    supabaseClient: {
      functions: {
        invoke: async (name, options) => {
          edgeInvocations.push({ name, options });
          return {
            data: {
              assistantText: 'Edge grounded answer',
              visualReport: safeVisualReport,
              boardPatch: safeBoardPatch,
              toolTraceSummary: [{ tool: 'suggest_visual_report', status: 'accepted', reason: 'visual requested' }],
            },
            error: null,
          };
        },
      },
    },
  });
  assert(edgeAnswer.assistantText === 'Edge grounded answer', `AI frontend helper should extract Edge Function assistantText, got ${JSON.stringify(edgeAnswer)}`);
  assert(
    edgeAnswer.visualReport?.templateId === 'peak-hour' &&
      edgeAnswer.boardPatch?.blocks[0]?.type === 'chart' &&
      edgeAnswer.toolTraceSummary[0]?.tool === 'suggest_visual_report',
    `AI frontend helper should extract sanitized visual reports, board patches, and tool trace summaries, got ${JSON.stringify(edgeAnswer)}`
  );
  assert(
    edgeInvocations[0]?.name === 'dashboard-ai-analysis' &&
      edgeInvocations[0].options.body.modelId === 'qwen-plus' &&
      edgeInvocations[0].options.body.context === aiContext &&
      edgeInvocations[0].options.body.maxRounds === 4 &&
      edgeInvocations[0].options.body.allowedVisualReports.includes('peak-hour') &&
      edgeInvocations[0].options.body.userPrompt === 'Explain top drivers',
    `AI frontend helper should invoke dashboard-ai-analysis with model id and dashboard context, got ${JSON.stringify(edgeInvocations[0])}`
  );
  const textOnlyBoardAnswer = await analyzeDashboardWithAi({
    userPrompt: 'Build visual report',
    context: aiContext,
    model: resolvedAiModel,
    preferredTool: 'compose_dashboard_ai_board',
    supabaseClient: {
      functions: {
        invoke: async () => ({
          data: {
            assistantText: '### Markdown only report\nNo structured boardPatch was returned.',
          },
          error: null,
        }),
      },
    },
  });
  assert(
    textOnlyBoardAnswer.boardPatch?.blocks.some((block) => block.type === 'chart') &&
      textOnlyBoardAnswer.boardPatch.blocks.some((block) => block.type === 'table') &&
      textOnlyBoardAnswer.toolTraceSummary.some((trace) => trace.tool === 'compose_dashboard_ai_board'),
    `Text-only visual responses should still synthesize AI Workspace board blocks, got ${JSON.stringify(textOnlyBoardAnswer)}`
  );
  const edgeDataRequestAnswer = await analyzeDashboardWithAi({
    userPrompt: 'Compare August VJ departures',
    context: aiContext,
    model: resolvedAiModel,
    supabaseClient: {
      functions: {
        invoke: async () => ({
          data: {
            assistantText: 'I need broader August records before answering.',
            dataRequest: {
              type: 'dashboard-data-request',
              scope: 'records',
              months: ['2026-08'],
              typeFilter: 'D',
              airlines: ['VJ'],
            },
          },
          error: null,
        }),
      },
    },
  });
  assert(
    edgeDataRequestAnswer.dataRequest?.months?.[0] === '2026-08' &&
      edgeDataRequestAnswer.exportAction == null,
    `AI frontend helper should accept validated Edge Function data requests for a one-step broader-data follow-up, got ${JSON.stringify(edgeDataRequestAnswer)}`
  );
  const staleProviderBoardAnswer = await analyzeDashboardWithAi({
    userPrompt: 'thá»‘ng kÃª tá»« 01/06/2026 Ä‘áº¿n 07/06/2026',
    context: aiContext,
    model: resolvedAiModel,
    supabaseClient: {
      functions: {
        invoke: async () => ({
          data: {
            assistantText: 'ÄÃ£ truy váº¥n khoáº£ng ngÃ y.',
            queryResults: [{
              queryId: 'date-range',
              view: 'flight_operations',
              columns: ['ops_date', 'flights'],
              rows: [{ ops_date: '2026-06-01', flights: 42 }],
              rowCount: 1,
              truncated: false,
              dataQualityNotes: ['Nguá»“n dá»¯ liá»‡u: reporting.flight_operations; queryId=date-range.'],
            }],
            boardPatch: safeBoardPatch,
          },
          error: null,
        }),
      },
    },
  });
  assert(
    staleProviderBoardAnswer.boardPatch?.blocks.some((block) => block.table?.sourceQueryId === 'date-range') &&
      staleProviderBoardAnswer.toolTraceSummary.some((trace) => trace.fallbackReason?.includes('queryResults')),
    `Query-intent frontend helper should prefer queryResults over stale provider boardPatch, got ${JSON.stringify(staleProviderBoardAnswer)}`
  );
  let retryAttempts = 0;
  const transientRetryAnswer = await analyzeDashboardWithAi({
    userPrompt: 'Táº¡o bÃ¡o cÃ¡o trá»±c quan',
    context: aiContext,
    model: resolvedAiModel,
    preferredTool: 'compose_dashboard_ai_board',
    providerFallback: true,
    supabaseClient: {
      functions: {
        invoke: async () => {
          retryAttempts += 1;
          if (retryAttempts === 1) {
            return { data: null, error: { message: '503 Service Unavailable' } };
          }
          return {
            data: {
              assistantText: 'ÄÃ£ táº¡o bÃ¡o cÃ¡o trá»±c quan tá»« dá»¯ liá»‡u dashboard.',
              boardPatch: markdownOnlyFallbackPatch,
            },
            error: null,
          };
        },
      },
    },
  });
  assert(
    retryAttempts === 2 &&
      (transientRetryAnswer.assistantText.includes('ÄÃ£ táº¡o') || transientRetryAnswer.assistantText.includes('Ã„ÂÃƒÂ£ tÃ¡ÂºÂ¡o')) &&
      transientRetryAnswer.toolTraceSummary.some((trace) => trace.providerAttempt === 2 && (trace.reason.includes('Thá»­ láº¡i') || trace.reason.includes('ThÃ¡Â»Â­ lÃ¡ÂºÂ¡i'))),
    `AI frontend helper should retry one transient provider failure and annotate the tool trace, got ${JSON.stringify({ retryAttempts, transientRetryAnswer })}`
  );
  let schemaAttempts = 0;
  let schemaRetried = false;
  try {
    await analyzeDashboardWithAi({
      userPrompt: 'Táº¡o bÃ¡o cÃ¡o lá»—i schema',
      context: aiContext,
      model: resolvedAiModel,
      providerFallback: true,
      supabaseClient: {
        functions: {
          invoke: async () => {
            schemaAttempts += 1;
            return { data: { assistantText: '' }, error: null };
          },
        },
      },
    });
  } catch {
    schemaRetried = schemaAttempts > 1;
  }
  assert(
    schemaAttempts === 1 && schemaRetried === false,
    `AI frontend helper must not retry malformed provider schema responses, got ${JSON.stringify({ schemaAttempts, schemaRetried })}`
  );
  let edgeConfigRejected = false;
  try {
    await analyzeDashboardWithAi({
      userPrompt: 'Should fail',
      context: aiContext,
      model: null,
      supabaseClient: {
        functions: {
          invoke: async () => {
            throw new Error('invoke should not run when model is missing');
          },
        },
      },
    });
  } catch (error) {
    edgeConfigRejected = error.name === 'DashboardAiConfigurationError';
  }
  assert(edgeConfigRejected, 'AI frontend helper should reject missing runtime model with a UI-safe configuration error');
  assert(isDashboardAiConfigured(DEFAULT_AI_ANALYSIS_SETTINGS), `AI settings with enabled runtime models should be configured, got ${JSON.stringify(DEFAULT_AI_ANALYSIS_SETTINGS)}`);
  const safeMomExportAction = resolveDashboardAiExportAction({
    type: 'dashboard-template-export',
    templateId: 'mom-wow-analysis',
    format: 'xlsx',
    fileName: 'mom-wow-analysis.xlsx',
  });
  const safeSanLuongExportAction = resolveDashboardAiExportAction({
    type: 'dashboard-template-export',
    templateId: 'sanluong-summary',
    format: 'xlsx',
    fileName: 'sanluong-summary.xlsx',
  });
  assert(safeMomExportAction?.type === 'dashboard-template-export' && safeMomExportAction.templateId === 'mom-wow-analysis' && safeSanLuongExportAction?.fileName === 'sanluong-summary.xlsx', `AI export action parser should accept whitelisted report template actions, got ${JSON.stringify({ safeMomExportAction, safeSanLuongExportAction })}`);
  const safeCustomExportAction = resolveDashboardAiExportAction({
    type: 'dashboard-custom-workbook',
    format: 'xlsx',
    fileName: '../custom needs.xlsx',
    workbookSpec: {
      title: 'Custom Needs',
      sheets: [
        {
          name: '=Unsafe Sheet Name',
          columns: ['Airline', 'Flights', 'Formula'],
          rows: [
            { Airline: 'VJ', Flights: 2, Formula: '=SUM(A1:A2)' },
            { Airline: 'VN', Flights: 1, Formula: '@hidden' },
          ],
          notes: 'AI generated summary from validated dashboard data.',
        },
      ],
    },
  });
  assert(
    safeCustomExportAction?.type === 'dashboard-custom-workbook' &&
      safeCustomExportAction.fileName === 'custom_needs.xlsx' &&
      safeCustomExportAction.workbookSpec.sheets[0].name === 'Unsafe Sheet Name' &&
      safeCustomExportAction.workbookSpec.sheets[0].rows[0].Formula === "'=SUM(A1:A2)" &&
      safeCustomExportAction.workbookSpec.sheets[0].rows[1].Formula === "'@hidden",
    `AI custom workbook parser should sanitize file/sheet names and formula-like cells, got ${JSON.stringify(safeCustomExportAction)}`
  );
  assert(
    resolveDashboardAiExportAction({ type: 'dashboard-template-export', templateId: 'raw-data', format: 'xlsx', fileName: 'raw-data.xlsx' }) == null &&
      resolveDashboardAiExportAction({ type: 'dashboard-template-export', templateId: 'mom-wow-analysis', format: 'csv', fileName: 'mom-wow-analysis.csv' }) == null &&
      resolveDashboardAiExportAction({ type: 'write-file', templateId: 'mom-wow-analysis', format: 'xlsx', fileName: 'mom-wow-analysis.xlsx', path: 'C:/unsafe.xlsx' }) == null,
    'AI export action parser must reject unknown actions, formats, filenames, and arbitrary file-write JSON'
  );
  const dashboardReportRows = buildDashboardReportRows({
    records: [
      seasonalRecord({ id: 'REP-A1', type: 'A', airline: 'VJ', rawFlightNumber: '901', route: 'ICN', aircraft: '321', date: '2026-07-03', schedule: '11:00', pax: 190 }),
      seasonalRecord({ id: 'REP-D1', type: 'D', airline: 'VJ', rawFlightNumber: '902', route: 'ICN', aircraft: '321', date: '2026-07-03', schedule: '23:30', pax: 181 }),
      seasonalRecord({ id: 'REP-D2', type: 'D', airline: 'VN', rawFlightNumber: '903', route: 'PUS', aircraft: '789', date: '2026-07-04', schedule: '01:00', pax: 230 }),
      { ...seasonalRecord({ id: 'REP-DELETED', type: 'D', airline: 'AK', rawFlightNumber: '999', route: 'KUL', aircraft: '320', date: '2026-07-05', schedule: '12:00', pax: 100 }), status: 'deleted' },
    ],
    routeCountries: customRouteCountryMap,
    timeBasis: 'local',
  });
  assert(
    JSON.stringify(CANONICAL_DASHBOARD_REPORT_COLUMNS) === JSON.stringify(['Type', 'Flight', 'Config', 'STA/STD', 'Routes', 'Pax', 'Note', 'Airlines', 'Ops Date', 'Country', 'Weeknum', 'UTC', 'HourUTC', 'A/C Type', 'DayIndex', 'Weekday', 'IsoWeek']) &&
      dashboardReportRows.length === 3 &&
      dashboardReportRows[0].Country === 'South Korea' &&
      dashboardReportRows[0].Note === 'Bags Delivered' &&
      dashboardReportRows[2].UTC === '2026-07-03 18:00' &&
      dashboardReportRows[2].HourUTC === 18 &&
      dashboardReportRows[2].DayIndex === 4 &&
      dashboardReportRows[2].IsoWeek === '2026-W27' &&
      !JSON.stringify(dashboardReportRows).includes('REP-DELETED'),
    `dashboard report rows should normalize active FlightRecords into canonical SanLuong columns, got ${JSON.stringify(dashboardReportRows)}`
  );
  const sanLuongWorkbook = buildSanLuongSummaryWorkbook({
    records: dashboardReportRows.map((row, index) => seasonalRecord({
      id: `REP-WB-${index}`,
      type: row.Type,
      airline: row.Airlines,
      rawFlightNumber: String(row.Flight).replace(row.Airlines, ''),
      route: row.Routes,
      aircraft: row['A/C Type'],
      date: String(row['Ops Date']).slice(0, 10),
      schedule: String(row['STA/STD']).slice(11, 16),
      pax: row.Pax,
    })),
    routeCountries: customRouteCountryMap,
    seasonCode: 'S26',
    timeBasis: 'local',
    generatedAt: new Date('2026-07-10T00:00:00Z'),
  });
  assert(
    ['Report Guide', 'Data', 'Airline', 'Country', 'Routes', 'Frequency', 'Month', 'Week', 'PeakHour', 'Per30min', '30days', 'ACType'].every((name) => sanLuongWorkbook.SheetNames.includes(name)),
    `SanLuong summary workbook should include guide, raw Data, and generated pivot-style sheets, got ${JSON.stringify(sanLuongWorkbook.SheetNames)}`
  );
  const sanLuongDataRows = XLSX.utils.sheet_to_json(sanLuongWorkbook.Sheets.Data, { defval: '' });
  const sanLuongAirlineRows = XLSX.utils.sheet_to_json(sanLuongWorkbook.Sheets.Airline, { defval: '' });
  assert(
    sanLuongDataRows.length === 3 &&
      Object.keys(sanLuongDataRows[0]).includes('IsoWeek') &&
      sanLuongAirlineRows.some((row) => row.Airlines === 'VJ' && row['Total Flight'] === 2 && row['Total Pax'] === 371),
    `SanLuong summary workbook should populate raw rows and airline summary rows, got ${JSON.stringify({ sanLuongDataRows, sanLuongAirlineRows })}`
  );
  const customDashboardWorkbook = buildCustomDashboardWorkbook(safeCustomExportAction.workbookSpec, {
    seasonCode: 'S26',
    generatedAt: new Date('2026-07-10T00:00:00Z'),
  });
  const customRows = XLSX.utils.sheet_to_json(customDashboardWorkbook.Sheets['Unsafe Sheet Name'], { defval: '' });
  const customGuideRows = XLSX.utils.sheet_to_json(customDashboardWorkbook.Sheets['Report Guide'], { defval: '' });
  assert(
    customDashboardWorkbook.SheetNames.includes('Report Guide') &&
      customDashboardWorkbook.SheetNames.includes('Unsafe Sheet Name') &&
      customRows.some((row) => row.Airline === 'VJ' && row.Formula === "'=SUM(A1:A2)") &&
      customGuideRows.some((row) => row.Field === 'Template' && row.Value === 'dashboard-custom-workbook'),
    `custom dashboard workbook should be generated locally from the validated spec, got ${JSON.stringify({ sheets: customDashboardWorkbook.SheetNames, customRows, customGuideRows })}`
  );
  const momWorkbook = buildMomWowAnalysisWorkbook({
    context: aiContext,
    aiNotes: 'Edge grounded answer',
    seasonCode: 'S26',
    generatedAt: new Date('2026-07-10T00:00:00Z'),
  });
  assert(
    ['Report Guide', 'Summary', 'Drivers', 'Waterfall', 'Selected Records', 'AI Notes'].every((name) => momWorkbook.SheetNames.includes(name)),
    `MoM/WoW analysis workbook should include expected sheets, got ${JSON.stringify(momWorkbook.SheetNames)}`
  );
  const momSummaryRows = XLSX.utils.sheet_to_json(momWorkbook.Sheets.Summary, { defval: '' });
  const momDriverRows = XLSX.utils.sheet_to_json(momWorkbook.Sheets.Drivers, { defval: '' });
  const momAiRows = XLSX.utils.sheet_to_json(momWorkbook.Sheets['AI Notes'], { defval: '' });
  assert(
    momSummaryRows.some((row) => row.Field === 'Comparison Mode' && row.Value === 'mom') &&
      momDriverRows.some((row) => row.Driver === 'VJ') &&
      momAiRows.some((row) => String(row.Value).includes('Edge grounded answer')),
    `MoM/WoW workbook should include comparison metadata, drivers, and latest AI answer, got ${JSON.stringify({ momSummaryRows, momDriverRows, momAiRows })}`
  );
  const emptyComparison = buildDashboardComparison({
    records: effectiveDashboardRecords,
    mode: 'mom',
    metric: 'flights',
    currentPeriod: '2026-05',
    previousPeriod: '2026-04',
    typeFilter: 'all',
    timeBasis: 'local',
    dimension: 'airline',
  });
  assert(emptyComparison.status === 'empty', `empty/partial comparison should expose empty status, got ${JSON.stringify(emptyComparison)}`);

  const detailedStateRecords = [
    { id: 'R1', route: 'HAN', schedule: '10:00', status: 'active', action: null, flightNumber: 'VN001', type: 'A', date: '2026-03-30', linkId: 'R1' },
    { id: 'R2', route: 'DAD', schedule: '11:00', status: 'active', action: null, flightNumber: 'VN002', type: 'D', date: '2026-03-30', linkId: 'R2' },
  ];
  const detailedUpdatedRecords = applyFlightRecordUpdates(detailedStateRecords, [{ ...detailedStateRecords[0], route: 'SGN' }]);
  assert(detailedUpdatedRecords[0].route === 'SGN' && detailedUpdatedRecords[1].route === 'DAD', `flight record updates should replace by id without refetching, got ${JSON.stringify(detailedUpdatedRecords)}`);
  const detailedMods = applyModificationBatch(new Map(), [
    { legId: 'R1', action: 'modified', route: 'CXR', schedule: '12:00' },
    { legId: 'NEW1', action: 'added', addedLeg: { id: 'NEW1', flightNumber: 'VN003', type: 'A', date: '2026-03-31', route: 'HUI', schedule: '13:00', action: null, linkId: 'NEW1' } },
  ]);
  const detailedLegs = applyModificationsToFlightLegs(detailedStateRecords, detailedMods);
  assert(detailedLegs.some((leg) => leg.id === 'R1' && leg.route === 'CXR'), `modified detailed leg should update locally, got ${JSON.stringify(detailedLegs)}`);
  assert(detailedLegs.some((leg) => leg.id === 'NEW1'), `added detailed leg should appear locally, got ${JSON.stringify(detailedLegs)}`);
  const revertedMods = revertModificationHistoryMap(detailedMods, [{
    id: 'H1',
    timestamp: 1,
    description: 'test',
    changes: [
      { legId: 'R1', previousMod: null, newMod: { legId: 'R1', action: 'modified', route: 'CXR', schedule: '12:00' } },
      { legId: 'NEW1', previousMod: null, newMod: { legId: 'NEW1', action: 'added' } },
    ],
  }]);
  assert(revertedMods.size === 0, `undo should revert local modification map, got ${JSON.stringify(Array.from(revertedMods.entries()))}`);
  const filteredDetailedLegs = filterDetailedLegs(detailedLegs, 'VN001', null);
  assert(filteredDetailedLegs.length === 1 && filteredDetailedLegs[0].flightNumber === 'VN001', `detailed filter should avoid refetching for visible legs, got ${JSON.stringify(filteredDetailedLegs)}`);
  const blankDetailedLegs = filterDetailedLegs(detailedLegs, null, null);
  assert(blankDetailedLegs.length === 0, `detailed filter should render no flights when no Seasonal flight was selected, got ${JSON.stringify(blankDetailedLegs)}`);
  const detailedLinkedQueryWindow = buildDetailedScheduleQueryWindow({
    dateFrom: '2026-05-01',
    dateTo: '2026-05-31',
    targetArrFlight: 'VN100',
    targetDepFlight: null,
  });
  assert(
    detailedLinkedQueryWindow.flightNumberFilter == null &&
      detailedLinkedQueryWindow.dateFrom === '2026-04-30' &&
      detailedLinkedQueryWindow.dateTo === '2026-06-01',
    `detailed linked-flight query must keep counterpart legs in scope by dropping flight filter and expanding the date window, got ${JSON.stringify(detailedLinkedQueryWindow)}`
  );
  const detailedVisibleRangeLegs = filterDetailedLegsForView([
    { id: 'RANGE-OUT', route: 'HAN', schedule: '11:00', status: 'active', action: null, flightNumber: 'VN100', rawFlightNumber: '100', airline: 'VN', type: 'A', date: '2026-04-30', linkId: 'RANGE-OUT' },
    { id: 'RANGE-IN', route: 'DAD', schedule: '12:00', status: 'active', action: null, flightNumber: 'VN100', rawFlightNumber: '100', airline: 'VN', type: 'A', date: '2026-05-01', linkId: 'RANGE-IN' },
    { id: 'RANGE-LINKED', route: 'SGN', schedule: '13:00', status: 'active', action: null, flightNumber: 'VN101', rawFlightNumber: '101', airline: 'VN', type: 'D', date: '2026-05-02', linkId: 'RANGE-IN' },
  ], 'VN100', null, '2026-05-01', '2026-05-31');
  assert(
    detailedVisibleRangeLegs.length === 1 && detailedVisibleRangeLegs[0].id === 'RANGE-IN',
    `detailed visible legs should still respect the requested date range after the wider linked-flight query, got ${JSON.stringify(detailedVisibleRangeLegs)}`
  );

  const smartMergedRows = [
    baseRow({
      rowIndex: 1,
      arrFlight: '8',
      arrFlightType: 'J',
      arrRoute: 'HAN',
      arrFlightCategory: 'J',
      sta: '23:00',
    }),
    baseRow({
      rowIndex: 2,
      effective: '29-Jul-25',
      discontinue: '29-Jul-25',
      daysOfWeek: [false, true, false, false, false, false, false],
      arrFlight: '8',
      arrFlightType: 'J',
      arrRoute: 'HAN',
      arrFlightCategory: 'J',
      sta: '23:00',
    }),
  ];
  const smartGroups = groupFlightLegs(expandToFlightLegs(smartMergedRows)).map(rowSummary);
  assert(smartGroups.length === 2, `smart merged source rows should export as 2 rows, got ${JSON.stringify(smartGroups)}`);
  assert(smartGroups[0].effective === '2025-06-18', 'first smart row effective should stay 18-Jun');
  assert(smartGroups[0].discontinue === '2025-07-28', 'first smart row discontinue should stay 28-Jul');
  sameDays(smartGroups[0].daysOfWeek, [true, false, true, false, true, false, true], 'first smart row DOW');
  assert(smartGroups[1].effective === '2025-07-29', 'second smart row effective should stay 29-Jul');
  assert(smartGroups[1].discontinue === '2025-07-29', 'second smart row discontinue should stay 29-Jul');
  sameDays(smartGroups[1].daysOfWeek, [false, true, false, false, false, false, false], 'second smart row DOW');

  const weSplitPatternRows = [
    ['24-Jun-26', '25-Jun-26', [false, false, true, true, false, false, false]],
    ['27-Jun-26', '28-Jun-26', [false, false, false, false, false, true, true]],
    ['01-Jul-26', '02-Jul-26', [false, false, true, true, false, false, false]],
    ['04-Jul-26', '05-Jul-26', [false, false, false, false, false, true, true]],
    ['08-Jul-26', '09-Jul-26', [false, false, true, true, false, false, false]],
    ['11-Jul-26', '12-Jul-26', [false, false, false, false, false, true, true]],
    ['15-Jul-26', '16-Jul-26', [false, false, true, true, false, false, false]],
    ['18-Jul-26', '19-Jul-26', [false, false, false, false, false, true, true]],
    ['22-Jul-26', '23-Jul-26', [false, false, true, true, false, false, false]],
    ['25-Jul-26', '26-Jul-26', [false, false, false, false, false, true, true]],
    ['29-Jul-26', '30-Jul-26', [false, false, true, true, false, false, false]],
    ['01-Aug-26', '02-Aug-26', [false, false, false, false, false, true, true]],
  ].map(([effective, discontinue, daysOfWeek], index) =>
    baseRow({
      rowIndex: 600 + index,
      effective,
      discontinue,
      airline: 'WE',
      aircraft: '332',
      daysOfWeek,
      arrFlight: '201',
      arrFlightType: 'PAX',
      arrRoute: 'ICN',
      arrFlightCategory: 'J',
      sta: '21:10',
      depFlight: '202',
      depFlightType: 'PAX',
      depRoute: 'ICN',
      depFlightCategory: 'J',
      std: '22:40',
    })
  );
  const wePatternGroups = groupFlightLegs(expandToFlightLegs(weSplitPatternRows));
  const weMergedGroups = wePatternGroups.map(rowSummary);
  assert(weMergedGroups.length === 1, `WE split source rows should merge into one export row, got ${JSON.stringify(weMergedGroups)}`);
  assert(weMergedGroups[0].effective === '2026-06-24', `WE merged row should start 24-Jun-26, got ${weMergedGroups[0].effective}`);
  assert(weMergedGroups[0].discontinue === '2026-08-02', `WE merged row should end 02-Aug-26, got ${weMergedGroups[0].discontinue}`);
  sameDays(weMergedGroups[0].daysOfWeek, [false, false, true, true, false, true, true], 'WE merged split source DOW');
  const weExportRows = await workbookRowsFromBlob(exportToExcel(wePatternGroups, 'S26'));
  assert(weExportRows.length === 1, `WE seasonal workbook export should contain one merged row, got ${JSON.stringify(weExportRows)}`);
  assert(
    weExportRows[0].Effective === '24-Jun-26' &&
      weExportRows[0].Discontinue === '2-Aug-26' &&
      weExportRows[0].Mon === 0 &&
      weExportRows[0].Tue === 0 &&
      weExportRows[0].Wed === 1 &&
      weExportRows[0].Thu === 1 &&
      weExportRows[0].Fri === 0 &&
      weExportRows[0].Sat === 1 &&
      weExportRows[0].Sun === 1,
    `WE seasonal workbook export should use 0011011 for 24-Jun-26 through 2-Aug-26, got ${JSON.stringify(weExportRows[0])}`
  );

  const canonicalWeRecords = flattenRowsToFlightRecords(weSplitPatternRows);
  const canonicalWe = buildCanonicalSeasonalRows({ records: canonicalWeRecords, modifications: new Map() });
  assert(canonicalWe.validation.valid, `canonical WE export should round-trip, got ${JSON.stringify(canonicalWe.validation)}`);
  const canonicalWeDirectValidation = validateCanonicalSeasonalRoundTrip(canonicalWe.rows, canonicalWeRecords);
  assert(
    canonicalWeDirectValidation.valid,
    `direct canonical WE validation should pass, got ${JSON.stringify(canonicalWeDirectValidation)}`
  );
  assert(canonicalWe.rows.length === 1, `canonical WE split DB records should merge into one row, got ${JSON.stringify(canonicalWe.rows)}`);
  assert(
    canonicalWe.rows[0].effective === '24-Jun-26' &&
      canonicalWe.rows[0].discontinue === '2-Aug-26' &&
      JSON.stringify(canonicalWe.rows[0].daysOfWeek) === JSON.stringify([false, false, true, true, false, true, true]),
    `canonical WE row should cover 24-Jun-26..2-Aug-26 with 0011011, got ${JSON.stringify(canonicalWe.rows[0])}`
  );
  const canonicalWeWorkbookRows = await workbookRowsFromBlob(exportCanonicalSeasonalRowsToExcel(canonicalWe.rows, 'S26'));
  assert(canonicalWeWorkbookRows.length === 1, `canonical WE workbook should contain one row, got ${JSON.stringify(canonicalWeWorkbookRows)}`);
  assert(
    canonicalWeWorkbookRows[0].Effective === '24-Jun-26' &&
      canonicalWeWorkbookRows[0].Discontinue === '2-Aug-26' &&
      canonicalWeWorkbookRows[0].Mon === 0 &&
      canonicalWeWorkbookRows[0].Tue === 0 &&
      canonicalWeWorkbookRows[0].Wed === 1 &&
      canonicalWeWorkbookRows[0].Thu === 1 &&
      canonicalWeWorkbookRows[0].Fri === 0 &&
      canonicalWeWorkbookRows[0].Sat === 1 &&
      canonicalWeWorkbookRows[0].Sun === 1,
    `canonical WE workbook should use 0011011, got ${JSON.stringify(canonicalWeWorkbookRows[0])}`
  );
  const vnContextOnlyRecords = flattenRowsToFlightRecords([
    baseRow({
      rowIndex: 700,
      effective: '24-Jun-26',
      discontinue: '2-Aug-26',
      airline: 'VN',
      aircraft: '321',
      daysOfWeek: [false, false, true, true, false, true, true],
      arrFlight: '900',
      arrFlightType: 'PAX',
      arrRoute: 'HAN',
      arrFlightCategory: 'J',
      sta: '09:00',
    }),
  ]);
  const selectedWeIds = canonicalWeRecords.filter((record) => record.airline === 'WE').map((record) => record.id);
  assert(selectedWeIds.length > 0, 'canonical selected export fixture should include WE record ids');
  const selectedCanonicalWe = buildCanonicalSeasonalRows({
    records: [...canonicalWeRecords, ...vnContextOnlyRecords],
    modifications: new Map(),
    selectedRecordIds: selectedWeIds,
  });
  assert(
    selectedCanonicalWe.validation.valid &&
      selectedCanonicalWe.rows.length === 1 &&
      selectedCanonicalWe.rows[0].airline === 'WE' &&
      selectedCanonicalWe.rows[0].effective === '24-Jun-26' &&
      selectedCanonicalWe.rows[0].discontinue === '2-Aug-26',
    `canonical selected export should scan full DB context but emit only selected flight rows, got ${JSON.stringify(selectedCanonicalWe)}`
  );

  const unlinkedOvernightLikeRows = [
    baseRow({
      rowIndex: 10,
      arrFlight: '100',
      arrFlightType: 'J',
      arrRoute: 'HAN',
      arrFlightCategory: 'J',
      sta: '23:00',
    }),
    baseRow({
      rowIndex: 11,
      effective: '18-Jun-25',
      discontinue: '28-Jul-25',
      depFlight: '101',
      depFlightType: 'J',
      depRoute: 'HAN',
      depFlightCategory: 'J',
      std: '01:00',
    }),
  ];
  const unlinkedGroups = groupFlightLegs(expandToFlightLegs(unlinkedOvernightLikeRows)).map(rowSummary);
  const unlinkedDepGroup = unlinkedGroups.find((group) => group.dep === '101');
  assert(unlinkedDepGroup, `unlinked DEP group should remain present, got ${JSON.stringify(unlinkedGroups)}`);
  assert(unlinkedDepGroup.effective === '2025-06-18', 'unlinked DEP effective must not be inferred as +1');
  assert(unlinkedDepGroup.discontinue === '2025-07-28', 'unlinked DEP discontinue must not be inferred as +1');
  sameDays(unlinkedDepGroup.daysOfWeek, [true, false, true, false, true, false, true], 'unlinked DEP DOW');

  const explicitOvernightRows = [
    baseRow({
      rowIndex: 20,
      arrFlight: '200',
      arrFlightType: 'J',
      arrRoute: 'HAN',
      arrFlightCategory: 'J',
      sta: '23:00',
      overnightLinkRowIndex: 21,
      linkType: 'overnight',
    }),
    baseRow({
      rowIndex: 21,
      effective: '19-Jun-25',
      discontinue: '29-Jul-25',
      daysOfWeek: [true, true, false, true, false, true, false],
      depFlight: '201',
      depFlightType: 'J',
      depRoute: 'HAN',
      depFlightCategory: 'J',
      std: '01:00',
      overnightLinkRowIndex: 20,
      linkType: 'overnight',
    }),
  ];
  const explicitGroups = groupFlightLegs(expandToFlightLegs(explicitOvernightRows)).map(rowSummary);
  const explicitDep = explicitGroups.find((group) => group.dep === '201');
  assert(explicitDep, `explicit DEP group should remain present, got ${JSON.stringify(explicitGroups)}`);
  assert(explicitDep.effective === '2025-06-19', 'explicit overnight DEP effective should map from ARR +1');
  assert(explicitDep.discontinue === '2025-07-29', 'explicit overnight DEP discontinue should map from ARR +1');
  sameDays(explicitDep.daysOfWeek, [true, true, false, true, false, true, false], 'explicit overnight DEP DOW');

  const linkedRowsForUnlink = [
    baseRow({
      rowIndex: 30,
      effective: '30-Mar-26',
      discontinue: '07-Apr-26',
      daysOfWeek: [true, true, false, false, false, false, false],
      arrFlight: '300',
      arrFlightType: 'J',
      arrRoute: 'HAN',
      arrFlightCategory: 'J',
      sta: '10:00',
      overnightLinkRowIndex: 31,
      linkType: 'sameday',
    }),
    baseRow({
      rowIndex: 31,
      effective: '30-Mar-26',
      discontinue: '07-Apr-26',
      daysOfWeek: [true, true, false, false, false, false, false],
      depFlight: '301',
      depFlightType: 'J',
      depRoute: 'HAN',
      depFlightCategory: 'J',
      std: '11:00',
      overnightLinkRowIndex: 30,
      linkType: 'sameday',
    }),
  ];
  const unlinkPlan = planGranularUnlink(
    linkedRowsForUnlink,
    [
      { sourceRowIndex: 30, date: '2026-03-30' },
      { sourceRowIndex: 30, date: '2026-03-31' },
    ],
    {
      fromDate: '2026-03-30',
      toDate: '2026-03-31',
      opDays: [true, true, false, false, false, false, false],
    },
    100
  );
  const setRows = unlinkPlan.writes.filter((write) => write.type === 'set').map((write) => write.row);
  assert(setRows.length === 4, `manual linked unlink should smart-merge into 4 set rows, got ${setRows.length}`);
  assert(
    setRows.some((row) => row.arrFlight === '300' && row.overnightLinkRowIndex != null && row.effective === '6-Apr-26' && row.discontinue === '7-Apr-26'),
    `remaining ARR dates should be one linked smart-merged row, got ${JSON.stringify(setRows)}`
  );
  assert(
    setRows.some((row) => row.depFlight === '301' && row.overnightLinkRowIndex != null && row.effective === '6-Apr-26' && row.discontinue === '7-Apr-26'),
    `remaining DEP dates should be one linked smart-merged row, got ${JSON.stringify(setRows)}`
  );
  assert(
    setRows.some((row) => row.arrFlight === '300' && row.overnightLinkRowIndex == null && row.effective === '30-Mar-26' && row.discontinue === '31-Mar-26'),
    `selected ARR dates should be one unlinked smart-merged row, got ${JSON.stringify(setRows)}`
  );
  assert(
    setRows.some((row) => row.depFlight === '301' && row.overnightLinkRowIndex == null && row.effective === '30-Mar-26' && row.discontinue === '31-Mar-26'),
    `selected DEP dates should be one unlinked smart-merged row, got ${JSON.stringify(setRows)}`
  );

  const numericDateSameRow = baseRow({
    rowIndex: 50,
    effective: 46111,
    discontinue: 46119,
    daysOfWeek: [true, true, false, false, false, false, false],
    arrFlight: '480',
    arrFlightType: 'J',
    arrRoute: 'HAN',
    arrFlightCategory: 'J',
    sta: '10:00',
    depFlight: '481',
    depFlightType: 'J',
    depRoute: 'DPS',
    depFlightCategory: 'J',
    std: '11:00',
  });
  const numericDatePlan = planGranularUnlink(
    [numericDateSameRow],
    [{ sourceRowIndex: 50, date: '2026-03-30' }],
    {
      fromDate: '2026-03-30',
      toDate: '2026-03-30',
      opDays: [true, false, false, false, false, false, false],
    },
    200
  );
  assert(
    numericDatePlan.writes.length > 0,
    'source-imported same-row turnarounds with Excel serial dates should produce an unlink plan'
  );
  assert(
    numericDatePlan.writes.some((write) => write.type === 'delete' && write.rowIndex === 50),
    `numeric-date same-row unlink should delete the original consolidated row, got ${JSON.stringify(numericDatePlan.writes)}`
  );

  const atomicRows = [
    baseRow({
      rowIndex: 70,
      effective: '30-Mar-26',
      discontinue: '31-Mar-26',
      daysOfWeek: [true, true, false, false, false, false, false],
      arrFlight: '480',
      arrFlightType: 'J',
      arrRoute: 'CGK-DAD',
      arrFlightCategory: 'J',
      sta: '23:10',
      depFlight: '481',
      depFlightType: 'J',
      depRoute: 'DAD-CGK',
      depFlightCategory: 'J',
      std: '01:20',
    }),
    baseRow({
      rowIndex: 71,
      effective: '30-Mar-26',
      discontinue: '30-Mar-26',
      daysOfWeek: [true, false, false, false, false, false, false],
      arrFlight: '480',
      arrFlightType: 'J',
      arrRoute: 'CGK-DAD',
      arrFlightCategory: 'J',
      sta: '23:10',
    }),
  ];
  const atomicRecords = flattenRowsToFlightRecords(atomicRows);
  assert(atomicRecords.length === 5, `atomic import should create 5 individual records, got ${atomicRecords.length}`);
  assert(new Set(atomicRecords.map((record) => record.id)).size === atomicRecords.length, 'every atomic record should have a unique id');
  const linkedArr = atomicRecords.find((record) => record.sourceRowIndex === 70 && record.type === 'A' && record.date === '2026-03-30');
  const linkedDep = atomicRecords.find((record) => record.sourceRowIndex === 70 && record.type === 'D' && record.pairAnchorDate === '2026-03-30');
  assert(linkedArr && linkedDep, `expected linked ARR/DEP records, got ${JSON.stringify(atomicRecords)}`);
  assert(linkedArr.turnaroundId === linkedDep.turnaroundId, 'imported same-row pair should share a turnaroundId');
  assert(linkedArr.linkType === 'overnight' && linkedDep.linkType === 'overnight', 'DEP before ARR should preserve overnight link type');
  assert(linkedDep.date === '2026-03-31', `overnight DEP atomic date should be absolute +1, got ${linkedDep.date}`);

  const selectedWithPair = includeLinkedPairsForExport(atomicRecords, [linkedArr.id]);
  assert(
    selectedWithPair.some((record) => record.id === linkedDep.id),
    'selecting one linked atomic record for export should include its paired record'
  );
  const atomicGroups = groupFlightLegs(flightRecordsToLegs(selectedWithPair)).map(rowSummary);
  assert(
    atomicGroups.some((group) => group.arr === '480' && group.effective === '2026-03-30' && group.discontinue === '2026-03-30'),
    `selected atomic export should include ARR anchored row, got ${JSON.stringify(atomicGroups)}`
  );
  assert(
    atomicGroups.some((group) => group.dep === '481' && group.effective === '2026-03-31' && group.discontinue === '2026-03-31'),
    `selected atomic export should include overnight DEP +1 row, got ${JSON.stringify(atomicGroups)}`
  );

  const manualLinkedRecords = flattenRowsToFlightRecords([
    baseRow({
      rowIndex: 80,
      effective: '30-Mar-26',
      discontinue: '31-Mar-26',
      daysOfWeek: [true, true, false, false, false, false, false],
      arrFlight: '580',
      arrFlightType: 'J',
      arrRoute: 'CGK-DAD',
      arrFlightCategory: 'J',
      sta: '23:10',
      overnightLinkRowIndex: 81,
      linkType: 'overnight',
    }),
    baseRow({
      rowIndex: 81,
      effective: '31-Mar-26',
      discontinue: '01-Apr-26',
      daysOfWeek: [false, true, true, false, false, false, false],
      depFlight: '581',
      depFlightType: 'J',
      depRoute: 'DAD-CGK',
      depFlightCategory: 'J',
      std: '01:20',
      overnightLinkRowIndex: 80,
      linkType: 'overnight',
    }),
  ]);
  const manualArr = manualLinkedRecords.find((record) => record.type === 'A' && record.date === '2026-03-30');
  const manualDep = manualLinkedRecords.find((record) => record.type === 'D' && record.date === '2026-03-31');
  assert(manualArr && manualDep, `manual linked rows should flatten into paired records, got ${JSON.stringify(manualLinkedRecords)}`);
  assert(manualArr.turnaroundId === manualDep.turnaroundId, 'manual linked separate rows should share turnaroundId');
  assert(manualDep.pairAnchorDate === '2026-03-30', 'manual overnight DEP should retain ARR anchor date');

  const sameDayLinkedRecords = flattenRowsToFlightRecords([
    baseRow({
      rowIndex: 90,
      effective: '30-Mar-26',
      discontinue: '31-Mar-26',
      daysOfWeek: [true, true, false, false, false, false, false],
      arrFlight: '680',
      arrFlightType: 'J',
      arrRoute: 'CGK-DAD',
      arrFlightCategory: 'J',
      sta: '10:10',
      depFlight: '681',
      depFlightType: 'J',
      depRoute: 'DAD-CGK',
      depFlightCategory: 'J',
      std: '11:20',
    }),
  ]);
  const sameDayGroups = groupFlightLegs(flightRecordsToLegs(sameDayLinkedRecords)).map(rowSummary);
  assert(
    sameDayGroups.length === 1 && sameDayGroups[0].arr === '680' && sameDayGroups[0].dep === '681',
    `same-day linked records must consolidate into one export row, got ${JSON.stringify(sameDayGroups)}`
  );
  const canonicalSameDay = buildCanonicalSeasonalRows({ records: sameDayLinkedRecords, modifications: new Map() });
  assert(
    canonicalSameDay.validation.valid &&
      canonicalSameDay.rows.length === 1 &&
      canonicalSameDay.rows[0].arrFlight === '680' &&
      canonicalSameDay.rows[0].depFlight === '681',
    `canonical same-day linked records should export as one round-tripping row, got ${JSON.stringify(canonicalSameDay)}`
  );
  const turnaroundOnlyRecords = sameDayLinkedRecords.map((record) => {
    const next = { ...record };
    delete next.linkedRecordId;
    return next;
  });
  const canonicalTurnaroundOnly = buildCanonicalSeasonalRows({ records: turnaroundOnlyRecords, modifications: new Map() });
  assert(
    canonicalTurnaroundOnly.validation.valid &&
      canonicalTurnaroundOnly.rows.length === 1 &&
      canonicalTurnaroundOnly.rows[0].arrFlight === '680' &&
      canonicalTurnaroundOnly.rows[0].depFlight === '681',
    `canonical pairing should fall back to turnaroundId when linkedRecordId is absent, got ${JSON.stringify(canonicalTurnaroundOnly)}`
  );
  const pairAnchorOnlyRecords = sameDayLinkedRecords.map((record) => {
    const next = { ...record };
    delete next.linkedRecordId;
    delete next.turnaroundId;
    return next;
  });
  const canonicalPairAnchorOnly = buildCanonicalSeasonalRows({ records: pairAnchorOnlyRecords, modifications: new Map() });
  assert(
    canonicalPairAnchorOnly.validation.valid &&
      canonicalPairAnchorOnly.rows.length === 1 &&
      canonicalPairAnchorOnly.rows[0].arrFlight === '680' &&
      canonicalPairAnchorOnly.rows[0].depFlight === '681',
    `canonical pairing should fall back to linkId/pairAnchorDate/linkType when direct links are absent, got ${JSON.stringify(canonicalPairAnchorOnly)}`
  );

  const overnightGroups = groupFlightLegs(flightRecordsToLegs(manualLinkedRecords)).map(rowSummary);
  assert(
    overnightGroups.some((group) => group.arr === '580' && group.dep == null && group.effective === '2026-03-30'),
    `overnight ARR side must export as its own row, got ${JSON.stringify(overnightGroups)}`
  );
  assert(
    overnightGroups.some((group) => group.dep === '581' && group.arr == null && group.effective === '2026-03-31'),
    `overnight DEP side must export as its own +1 row, got ${JSON.stringify(overnightGroups)}`
  );
  const canonicalOvernight = buildCanonicalSeasonalRows({ records: manualLinkedRecords, modifications: new Map() });
  assert(canonicalOvernight.validation.valid, `canonical overnight rows should round-trip, got ${JSON.stringify(canonicalOvernight.validation)}`);
  assert(
    canonicalOvernight.rows.some((row) => row.arrFlight === '580' && row.depFlight === '581' && row.effective === '30-Mar-26'),
    `canonical representable overnight records should export as an inferred overnight row, got ${JSON.stringify(canonicalOvernight.rows)}`
  );

  const canonicalUnlinked = buildCanonicalSeasonalRows({ records: flattenRowsToFlightRecords(unlinkedOvernightLikeRows), modifications: new Map() });
  assert(
    canonicalUnlinked.validation.valid &&
      canonicalUnlinked.rows.some((row) => row.arrFlight === '100' && row.depFlight == null) &&
      canonicalUnlinked.rows.some((row) => row.depFlight === '101' && row.arrFlight == null),
    `canonical unlinked ARR-only and DEP-only records must not be paired, got ${JSON.stringify(canonicalUnlinked)}`
  );

  const canonicalModifiedBase = flattenRowsToFlightRecords([
    baseRow({
      rowIndex: 610,
      effective: '01-Jun-26',
      discontinue: '02-Jun-26',
      daysOfWeek: [true, true, false, false, false, false, false],
      airline: 'VN',
      aircraft: '321',
      arrFlight: '700',
      arrFlightType: 'PAX',
      arrRoute: 'HAN',
      arrFlightCategory: 'J',
      arrCodeShares: 'VN1700',
      arrIntDomInd: 'D',
      sta: '10:00',
    }),
  ]);
  const modifiedCanonicalTarget = canonicalModifiedBase.find((record) => record.type === 'A' && record.date === '2026-06-01');
  const deletedCanonicalTarget = canonicalModifiedBase.find((record) => record.type === 'A' && record.date === '2026-06-02');
  assert(modifiedCanonicalTarget && deletedCanonicalTarget, 'canonical modification fixture should include two ARR records');
  const addedCanonicalLeg = {
    ...flightRecordsToLegs([modifiedCanonicalTarget])[0],
    id: 'VN704_2026-06-03_A',
    linkId: 'VN704_2026-06-03_A',
    flightNumber: 'VN704',
    rawFlightNumber: '704',
    route: 'DAD',
    schedule: '13:00',
    aircraft: '32Q',
    category: 'C',
    codeShares: 'VN1704',
    intDomInd: 'I',
    date: '2026-06-03',
    scheduledDate: '2026-06-03',
    dayOfWeek: 3,
    sourceRowIndex: 999,
  };
  const canonicalModified = buildCanonicalSeasonalRows({
    records: canonicalModifiedBase.map((record) => record.id === modifiedCanonicalTarget.id ? { ...record, category: 'F' } : record),
    modifications: new Map([
      [modifiedCanonicalTarget.id, { legId: modifiedCanonicalTarget.id, action: 'modified', schedule: '12:35', route: 'SGN', aircraft: '359', codeShares: 'VN2700' }],
      [deletedCanonicalTarget.id, { legId: deletedCanonicalTarget.id, action: 'deleted' }],
      [addedCanonicalLeg.id, { legId: addedCanonicalLeg.id, action: 'added', addedLeg: addedCanonicalLeg }],
    ]),
  });
  assert(canonicalModified.validation.valid, `canonical modified/deleted/added records should round-trip, got ${JSON.stringify(canonicalModified.validation)}`);
  assert(
    canonicalModified.rows.some((row) => row.arrFlight === '700' && row.sta === '12:35' && row.arrRoute === 'SGN' && row.aircraft === '359' && row.arrCodeShares === 'VN2700' && row.arrFlightCategory === 'F') &&
      !canonicalModified.rows.some((row) => row.arrFlight === '700' && row.effective === '2-Jun-26') &&
      canonicalModified.rows.some((row) => row.arrFlight === '704' && row.effective === '3-Jun-26' && row.arrRoute === 'DAD'),
    `canonical export must use effective modified/deleted/added DB records, got ${JSON.stringify(canonicalModified.rows)}`
  );

  const incompleteCanonicalRecords = flattenRowsToFlightRecords([
    baseRow({
      rowIndex: 620,
      effective: '01-Jun-26',
      discontinue: '01-Jun-26',
      daysOfWeek: [true, false, false, false, false, false, false],
      arrFlight: '720',
      arrFlightType: 'PAX',
      arrRoute: 'HAN',
      arrFlightCategory: 'J',
      sta: '10:00',
    }),
    baseRow({
      rowIndex: 621,
      effective: '10-Jun-26',
      discontinue: '10-Jun-26',
      daysOfWeek: [false, false, true, false, false, false, false],
      arrFlight: '720',
      arrFlightType: 'PAX',
      arrRoute: 'HAN',
      arrFlightCategory: 'J',
      sta: '10:00',
    }),
  ]);
  const incompleteCanonical = buildCanonicalSeasonalRows({ records: incompleteCanonicalRecords, modifications: new Map() });
  assert(
    incompleteCanonical.validation.valid &&
      incompleteCanonical.rows.length === 2 &&
      incompleteCanonical.rows.every((row) => row.effective === row.discontinue),
    `canonical incomplete recurrence must split instead of creating phantom dates, got ${JSON.stringify(incompleteCanonical)}`
  );

  const rebuildPlan = buildSourceRowRebuildPlan({
    records: canonicalWeRecords,
    modifications: new Map(),
    currentRows: weSplitPatternRows,
    syncMeta: { seasonId: 'season-test', baseServerVersion: 1, localRevision: 0, pendingCount: 0, lastLocalChangeAt: null, syncStatus: 'synced' },
    pendingOps: [],
  });
  assert(rebuildPlan.validation.valid && rebuildPlan.canApply, `clean canonical rebuild plan should be applicable, got ${JSON.stringify(rebuildPlan)}`);
  assert(rebuildPlan.rows.length === 1 && rebuildPlan.diffSummary.rebuiltRows === 1, `rebuild plan should produce one canonical WE row, got ${JSON.stringify(rebuildPlan)}`);
  const rebuildBackup = buildSourceRowRebuildBackup({
    seasonId: 'season-test',
    currentRows: weSplitPatternRows,
    plan: rebuildPlan,
    createdAt: 123,
  });
  let replaceCalled = false;
  await applySourceRowRebuildPlan('season-test', rebuildPlan, {
    backup: rebuildBackup,
    syncMeta: { seasonId: 'season-test', baseServerVersion: 1, localRevision: 0, pendingCount: 0, lastLocalChangeAt: null, syncStatus: 'synced' },
    pendingOps: [],
    replaceSourceRows: async (seasonId, rows) => {
      replaceCalled = seasonId === 'season-test' && rows.length === 1 && rows[0].airline === 'WE';
    },
  });
  assert(replaceCalled, 'applySourceRowRebuildPlan should call only the provided source-row replacement hook after backup and validation');
  const dirtyRebuildPlan = buildSourceRowRebuildPlan({
    records: canonicalWeRecords,
    modifications: new Map(),
    currentRows: weSplitPatternRows,
    syncMeta: { seasonId: 'season-test', baseServerVersion: 1, localRevision: 0, pendingCount: 1, lastLocalChangeAt: 456, syncStatus: 'dirty' },
    pendingOps: [{ type: 'sourceRow', row: weSplitPatternRows[0] }],
  });
  assert(!dirtyRebuildPlan.canApply && dirtyRebuildPlan.blockReason.includes('pending'), `dirty rebuild plan should be blocked, got ${JSON.stringify(dirtyRebuildPlan)}`);
  let dirtyBlocked = false;
  try {
    await applySourceRowRebuildPlan('season-test', dirtyRebuildPlan, {
      backup: rebuildBackup,
      syncMeta: { seasonId: 'season-test', baseServerVersion: 1, localRevision: 0, pendingCount: 1, lastLocalChangeAt: 456, syncStatus: 'dirty' },
      pendingOps: [{ type: 'sourceRow', row: weSplitPatternRows[0] }],
      replaceSourceRows: async () => {
        throw new Error('dirty rebuild should not write');
      },
    });
  } catch (err) {
    dirtyBlocked = err.message.includes('pending');
  }
  assert(dirtyBlocked, 'dirty/pending source-row rebuild should be blocked before write');
  let backupBlocked = false;
  try {
    await applySourceRowRebuildPlan('season-test', rebuildPlan, {
      syncMeta: { seasonId: 'season-test', baseServerVersion: 1, localRevision: 0, pendingCount: 0, lastLocalChangeAt: null, syncStatus: 'synced' },
      pendingOps: [],
      replaceSourceRows: async () => {
        throw new Error('missing backup rebuild should not write');
      },
    });
  } catch (err) {
    backupBlocked = err.message.includes('backup');
  }
  assert(backupBlocked, 'source-row rebuild should require a backup before write');

  const duplicateRows = [
    baseRow({
      rowIndex: 100,
      effective: '30-Mar-26',
      discontinue: '30-Mar-26',
      daysOfWeek: [true, false, false, false, false, false, false],
      arrFlight: '900',
      arrFlightType: 'J',
      arrRoute: 'HAN',
      arrFlightCategory: 'J',
      sta: '10:00',
    }),
    baseRow({
      rowIndex: 101,
      effective: '30-Mar-26',
      discontinue: '30-Mar-26',
      daysOfWeek: [true, false, false, false, false, false, false],
      depFlight: '900',
      depFlightType: 'J',
      depRoute: 'SGN',
      depFlightCategory: 'J',
      std: '12:00',
    }),
  ];
  const duplicateViolations = findDuplicateFlightNumberViolations(flattenRowsToFlightRecords(duplicateRows));
  assert(duplicateViolations.length === 1, `duplicate flight numbers on the same date should be rejected, got ${JSON.stringify(duplicateViolations)}`);
  assert(duplicateViolations[0].date === '2026-03-30' && duplicateViolations[0].flightNumber === 'VN900', 'duplicate violation should identify the exact date and flight');

  const deletedRecreateRows = [
    baseRow({
      rowIndex: 120,
      effective: '10-Jun-26',
      discontinue: '10-Jun-26',
      daysOfWeek: [false, false, true, false, false, false, false],
      airline: 'VJ',
      arrFlight: '989',
      arrFlightType: 'PAX',
      arrRoute: 'ICN-DAD',
      arrFlightCategory: 'J',
      sta: '10:00',
    }),
    baseRow({
      rowIndex: 121,
      effective: '10-Jun-26',
      discontinue: '10-Jun-26',
      daysOfWeek: [false, false, true, false, false, false, false],
      airline: 'VJ',
      arrFlight: '989',
      arrFlightType: 'PAX',
      arrRoute: 'ICN-DAD',
      arrFlightCategory: 'J',
      sta: '11:00',
    }),
  ];
  const [originalVj989, recreatedVj989] = flattenRowsToFlightRecords(deletedRecreateRows);
  let activeDuplicateError = null;
  try {
    assertNoDuplicateFlightNumbersForEffectiveRecords([originalVj989], new Map(), [recreatedVj989]);
  } catch (err) {
    activeDuplicateError = err;
  }
  assert(
    activeDuplicateError?.message.includes('Duplicate flight number VJ989 on 2026-06-10'),
    `active VJ989 duplicate should still be rejected, got ${activeDuplicateError?.message}`
  );

  const deletedBaseVj989 = { ...originalVj989, status: 'deleted', action: 'deleted' };
  assertNoDuplicateFlightNumbersForEffectiveRecords([deletedBaseVj989], new Map(), [recreatedVj989]);
  assertNoDuplicateFlightNumbersForEffectiveRecords(
    [originalVj989],
    new Map([[originalVj989.id, { legId: originalVj989.id, action: 'deleted' }]]),
    [recreatedVj989]
  );
  assertNoDuplicateFlightNumbersForEffectiveRecords(
    [originalVj989],
    new Map(),
    [recreatedVj989],
    [{ legId: originalVj989.id, action: 'deleted' }]
  );
  const unrelatedDuplicateAk649Rows = [
    baseRow({
      rowIndex: 122,
      effective: '08-Aug-26',
      discontinue: '08-Aug-26',
      daysOfWeek: [false, false, false, false, false, true, false],
      airline: 'AK',
      arrFlight: '649',
      arrFlightType: 'PAX',
      arrRoute: 'KUL-DAD',
      arrFlightCategory: 'J',
      sta: '10:00',
    }),
    baseRow({
      rowIndex: 123,
      effective: '08-Aug-26',
      discontinue: '08-Aug-26',
      daysOfWeek: [false, false, false, false, false, true, false],
      airline: 'AK',
      arrFlight: '649',
      arrFlightType: 'PAX',
      arrRoute: 'KUL-DAD',
      arrFlightCategory: 'J',
      sta: '11:00',
    }),
    baseRow({
      rowIndex: 124,
      effective: '09-Aug-26',
      discontinue: '09-Aug-26',
      daysOfWeek: [false, false, false, false, false, false, true],
      airline: 'VN',
      depFlight: '321',
      depFlightType: 'PAX',
      depRoute: 'DAD-SGN',
      depFlightCategory: 'J',
      std: '12:00',
    }),
  ];
  const unrelatedDuplicateRecords = flattenRowsToFlightRecords(unrelatedDuplicateAk649Rows);
  const unrelatedDeleteRecord = unrelatedDuplicateRecords.find((record) => record.flightNumber === 'VN321');
  assert(unrelatedDeleteRecord, 'unrelated delete fixture should include VN321');
  assertNoDuplicateFlightNumbersForEffectiveRecords(
    unrelatedDuplicateRecords,
    new Map(),
    [],
    [{ legId: unrelatedDeleteRecord.id, action: 'deleted' }]
  );
  const unrelatedAddedRecord = {
    ...unrelatedDeleteRecord,
    id: 'added-vn322-2026-08-09',
    flightNumber: 'VN322',
    rawFlightNumber: '322',
    action: 'added',
    status: 'active',
  };
  assertNoDuplicateFlightNumbersForEffectiveRecords(
    unrelatedDuplicateRecords,
    new Map(),
    [unrelatedAddedRecord],
    []
  );

  const duplicateImportRows = [
    baseRow({
      rowIndex: 102,
      effective: '29-Mar-26',
      discontinue: '24-Oct-26',
      daysOfWeek: [true, true, true, true, true, true, true],
      arrFlight: '319',
      arrFlightType: 'PAX',
      arrRoute: 'NRT',
      arrFlightCategory: 'PAX',
      sta: '12:40',
    }),
    baseRow({
      rowIndex: 103,
      effective: '29-Mar-26',
      discontinue: '24-Oct-26',
      daysOfWeek: [true, true, true, true, true, true, true],
      arrFlight: '319',
      arrFlightType: 'PAX',
      arrRoute: 'NRT',
      arrFlightCategory: 'PAX',
      sta: '12:40',
    }),
  ];
  const mergedDuplicateImport = mergeDuplicateImportPeriods(duplicateImportRows);
  assert(mergedDuplicateImport.rows.length === 1, `exact duplicate import rows should be merged, got ${JSON.stringify(mergedDuplicateImport.rows)}`);
  assert(mergedDuplicateImport.duplicatePeriods.length === 1, `merged duplicates should be reported, got ${JSON.stringify(mergedDuplicateImport.duplicatePeriods)}`);
  assert(
    mergedDuplicateImport.duplicatePeriods[0].flightNumber === 'VN319' &&
    mergedDuplicateImport.duplicatePeriods[0].effective === '2026-03-29' &&
    mergedDuplicateImport.duplicatePeriods[0].discontinue === '2026-10-24',
    `duplicate report should identify VN319 duplicate period, got ${JSON.stringify(mergedDuplicateImport.duplicatePeriods)}`
  );
  const mergedDuplicateViolations = findDuplicateFlightNumberViolations(flattenRowsToFlightRecords(mergedDuplicateImport.rows));
  assert(mergedDuplicateViolations.length === 0, `safe duplicate import merge should bypass duplicate validation, got ${JSON.stringify(mergedDuplicateViolations)}`);

  const mismatchedDuplicateImportRows = [
    baseRow({
      rowIndex: 104,
      effective: '13-Jul-26',
      discontinue: '28-Sep-26',
      daysOfWeek: [true, false, false, false, false, false, false],
      aircraft: '321',
      arrFlight: '55',
      arrFlightType: 'PAX',
      arrRoute: 'HAN-DAD',
      arrFlightCategory: 'J',
      arrCodeShares: 'VN1055',
      arrIntDomInd: 'I',
      sta: '12:00',
    }),
    baseRow({
      rowIndex: 105,
      effective: '13-Jul-26',
      discontinue: '05-Oct-26',
      daysOfWeek: [true, false, false, false, false, false, false],
      aircraft: '330',
      arrFlight: '055',
      arrFlightType: 'CARGO',
      arrRoute: 'SGN-DAD',
      arrFlightCategory: 'F',
      arrCodeShares: 'QH1055',
      arrIntDomInd: 'D',
      sta: '12:20',
    }),
  ].map((row) => ({ ...row, airline: 'VJ' }));
  const rowMergedMismatchedDuplicates = mergeDuplicateImportPeriods(mismatchedDuplicateImportRows);
  const vj055Rows = rowMergedMismatchedDuplicates.rows.filter((row) => row.airline === 'VJ' && (row.arrFlight === '55' || row.arrFlight === '055'));
  const vj055FirstPhase = vj055Rows.find((row) => row.aircraft === '321');
  const vj055SecondPhase = vj055Rows.find((row) => row.aircraft === '330');
  assert(vj055Rows.length === 2, `VJ055 overlap should be trimmed into two source phases, got ${JSON.stringify(vj055Rows)}`);
  assert(
    vj055FirstPhase?.effective === '13-Jul-26' &&
    vj055FirstPhase?.discontinue === '28-Sep-26',
    `VJ055 321 phase should stay 13-Jul to 28-Sep, got ${JSON.stringify(vj055FirstPhase)}`
  );
  assert(
    vj055SecondPhase?.effective === '5-Oct-26' &&
    vj055SecondPhase?.discontinue === '5-Oct-26',
    `VJ055 330 phase should be trimmed to 05-Oct only, got ${JSON.stringify(vj055SecondPhase)}`
  );
  assert(
    vj055FirstPhase?.arrRoute === 'HAN-DAD' &&
    vj055FirstPhase?.sta === '12:00' &&
    vj055FirstPhase?.arrFlightType === 'PAX' &&
    vj055FirstPhase?.arrFlightCategory === 'J' &&
    vj055FirstPhase?.arrCodeShares === 'VN1055' &&
    vj055FirstPhase?.arrIntDomInd === 'I',
    `overlap period should keep all fields from the earlier VJ055 phase, got ${JSON.stringify(vj055FirstPhase)}`
  );
  assert(
    vj055SecondPhase?.arrRoute === 'SGN-DAD' &&
    vj055SecondPhase?.sta === '12:20' &&
    vj055SecondPhase?.arrFlightType === 'CARGO' &&
    vj055SecondPhase?.arrFlightCategory === 'F' &&
    vj055SecondPhase?.arrCodeShares === 'QH1055' &&
    vj055SecondPhase?.arrIntDomInd === 'D',
    `non-overlap period should keep all fields from the later VJ055 phase, got ${JSON.stringify(vj055SecondPhase)}`
  );
  const mismatchedRecords = flattenRowsToFlightRecords(rowMergedMismatchedDuplicates.rows);
  assert(
    findDuplicateFlightNumberViolations(mismatchedRecords).length === 0,
    `source-level overlap trim should remove VJ055 duplicates, got ${JSON.stringify(findDuplicateFlightNumberViolations(mismatchedRecords))}`
  );
  assert(
    rowMergedMismatchedDuplicates.duplicatePeriods.some((period) =>
      period.flightNumber === 'VJ055' &&
      period.effective === '2026-07-13' &&
      period.discontinue === '2026-09-28'
    ),
    `source-level overlap trim should report VJ055 duplicate period, got ${JSON.stringify(rowMergedMismatchedDuplicates.duplicatePeriods)}`
  );

  const rawMismatchedRecords = flattenRowsToFlightRecords(mismatchedDuplicateImportRows);
  const recordMergedMismatchedDuplicates = mergeDuplicateImportRecords(rawMismatchedRecords);
  assert(
    findDuplicateFlightNumberViolations(recordMergedMismatchedDuplicates.records).length === 0,
    `record duplicate import safety net should bypass validation, got ${JSON.stringify(recordMergedMismatchedDuplicates.records)}`
  );
  const hydratedMismatchedDuplicate = mergePersistedFlightRecords(rowMergedMismatchedDuplicates.rows, recordMergedMismatchedDuplicates.records);
  assert(
    findDuplicateFlightNumberViolations(hydratedMismatchedDuplicate.records).length === 0,
    `source fallback should not restore import-merged duplicates, got ${JSON.stringify(hydratedMismatchedDuplicate.records)}`
  );

  const phaseRows = [
    baseRow({
      rowIndex: 110,
      effective: '30-Mar-26',
      discontinue: '07-Apr-26',
      daysOfWeek: [true, true, false, false, false, false, false],
      arrFlight: '710',
      arrFlightType: 'J',
      arrRoute: 'CGK-DAD',
      arrFlightCategory: 'J',
      sta: '10:00',
      depFlight: '711',
      depFlightType: 'J',
      depRoute: 'DAD-CGK',
      depFlightCategory: 'J',
      std: '11:00',
    }),
  ];
  const phaseRecords = flattenRowsToFlightRecords(phaseRows);
  const firstArr = phaseRecords.find((record) => record.type === 'A' && record.date === '2026-03-30');
  assert(firstArr, 'phase test should have a first ARR record');
  const unlinkedPhase = unlinkFlightRecords(phaseRecords, [firstArr.id]);
  const stillLinkedArr = unlinkedPhase.records.find((record) => record.type === 'A' && record.date === '2026-03-31');
  const unlinkedArr = unlinkedPhase.records.find((record) => record.id === firstArr.id);
  const unlinkedDep = unlinkedPhase.records.find((record) => record.id === firstArr.linkedRecordId);
  assert(unlinkedArr && unlinkedArr.turnaroundId == null && unlinkedArr.linkId === unlinkedArr.id, 'unlink should clear only the selected ARR occurrence');
  assert(unlinkedDep && unlinkedDep.turnaroundId == null && unlinkedDep.linkId === unlinkedDep.id, 'unlink should clear the selected occurrence counterpart');
  assert(stillLinkedArr && stillLinkedArr.turnaroundId != null, 'unlinking one date must not clear the rest of the phase');

  const unlinkedArrIds = unlinkedPhase.records
    .filter((record) => record.type === 'A' && record.turnaroundId == null && record.date === '2026-03-30')
    .map((record) => record.id);
  const unlinkedDepIds = unlinkedPhase.records
    .filter((record) => record.type === 'D' && record.turnaroundId == null && record.date === '2026-03-30')
    .map((record) => record.id);
  const relinkedPhase = linkFlightRecordPairs(unlinkedPhase.records, unlinkedArrIds, unlinkedDepIds, 'sameday');
  const relinkedArr = relinkedPhase.records.find((record) => record.id === unlinkedArrIds[0]);
  const relinkedDep = relinkedPhase.records.find((record) => record.id === unlinkedDepIds[0]);
  assert(relinkedArr && relinkedDep && relinkedArr.linkedRecordId === relinkedDep.id, 'manual same-day relink should reconnect selected occurrences');
  assert(relinkedArr?.linkType === 'sameday' && relinkedDep?.linkType === 'sameday', 'manual relink should preserve same-day link type');

  const legacyRows = [
    baseRow({
      rowIndex: 120,
      effective: '30-Mar-26',
      discontinue: '31-Mar-26',
      daysOfWeek: [true, true, false, false, false, false, false],
      arrFlight: '810',
      arrFlightType: 'J',
      arrRoute: 'CGK-DAD',
      arrFlightCategory: 'J',
      sta: '10:00',
      depFlight: '811',
      depFlightType: 'J',
      depRoute: 'DAD-CGK',
      depFlightCategory: 'J',
      std: '11:00',
    }),
    baseRow({
      rowIndex: 121,
      effective: '30-Mar-26',
      discontinue: '30-Mar-26',
      daysOfWeek: [true, false, false, false, false, false, false],
      arrFlight: '812',
      arrFlightType: 'J',
      arrRoute: 'SIN-DAD',
      arrFlightCategory: 'J',
      sta: '12:00',
    }),
  ];
  const legacyBase = flattenRowsToFlightRecords(legacyRows);
  const legacyFirstArr = legacyBase.find((record) => record.type === 'A' && record.rawFlightNumber === '810' && record.date === '2026-03-30');
  assert(legacyFirstArr, 'legacy merge test needs a linked ARR record');
  const legacyUnlinked = unlinkFlightRecords(legacyBase, [legacyFirstArr.id]);
  const partialPersistedDocs = legacyUnlinked.updatedRecords;
  const recoveredLegacy = mergePersistedFlightRecords(legacyRows, partialPersistedDocs);
  assert(
    recoveredLegacy.records.length === legacyBase.length,
    `partial persisted flightRecords should hydrate with source fallback, got ${recoveredLegacy.records.length} of ${legacyBase.length}`
  );
  assert(recoveredLegacy.needsFullPersist, 'partial persisted collection should request a full repair write');
  assert(
    recoveredLegacy.records.some((record) => record.rawFlightNumber === '812'),
    `unrelated source-backed flights must survive partial unlink persistence, got ${JSON.stringify(recoveredLegacy.records)}`
  );
  const recoveredUnlinkedArr = recoveredLegacy.records.find((record) => record.id === legacyFirstArr.id);
  assert(
    recoveredUnlinkedArr && recoveredUnlinkedArr.turnaroundId == null,
    'recovered partial collection must preserve the unlink mutation overlay'
  );

  const defaultDailyRange = buildDefaultDailyDateRange('2026-05-08');
  assert(
    JSON.stringify(defaultDailyRange) === JSON.stringify({ from: '2026-05-08T05:00', to: '2026-05-09T05:00' }),
    `daily default range should be 05:00 to next-day 05:00, got ${JSON.stringify(defaultDailyRange)}`
  );
  assert(
    JSON.stringify(readDailyDateRangeQuery(new URLSearchParams('from=2026-05-08T05%3A00&to=2026-05-09T05%3A00'))) ===
      JSON.stringify({ from: '2026-05-08T05:00', to: '2026-05-09T05:00' }),
    'allocation day range query should accept valid local datetime from/to params'
  );
  assert(
    readDailyDateRangeQuery(new URLSearchParams('from=2026-05-09T05%3A00&to=2026-05-08T05%3A00')) == null &&
      readDailyDateRangeQuery(new URLSearchParams('from=2026-02-31T05%3A00&to=2026-03-01T05%3A00')) == null &&
      readDailyDateRangeQuery(new URLSearchParams('from=2026-05-08T25%3A00&to=2026-05-09T05%3A00')) == null,
    'allocation day range query should reject inverted or invalid local datetime params'
  );
  const dailyFixtureRecords = [
    {
      id: 'DAILY-EARLY-A',
      linkId: 'DAILY-EARLY-A',
      type: 'A',
      airline: 'VN',
      flightNumber: 'VN090',
      rawFlightNumber: '090',
      requestStatusCode: null,
      route: 'HAN-DAD',
      schedule: '04:40',
      aircraft: '321',
      category: 'J',
      flightType: 'PAX',
      codeShares: null,
      intDomInd: null,
      pax: 80,
      gate: null,
      stand: 11,
      counter: null,
      carousel: null,
      mct: null,
      fb: null,
      lb: null,
      bhs: null,
      ghs: null,
      date: '2026-05-08',
      dayOfWeek: 5,
      action: null,
      sourceRowIndex: 200,
      sourceKind: 'imported',
      sourceSide: 'ARR',
      status: 'active',
    },
    {
      id: 'DAILY-LINK-A',
      linkId: 'DAILY-LINK',
      type: 'A',
      airline: 'VN',
      flightNumber: 'VN100',
      rawFlightNumber: '100',
      requestStatusCode: null,
      route: 'SGN-DAD',
      schedule: '08:10',
      aircraft: '321',
      category: 'J',
      flightType: 'PAX',
      codeShares: null,
      intDomInd: null,
      pax: 90,
      gate: 9,
      stand: null,
      counter: null,
      carousel: 1,
      mct: '08:00',
      fb: null,
      lb: null,
      bhs: 'BHS-A1',
      ghs: null,
      date: '2026-05-08',
      dayOfWeek: 5,
      action: null,
      sourceRowIndex: 201,
      sourceKind: 'imported',
      sourceSide: 'ARR',
      status: 'active',
      linkType: 'sameday',
      pairAnchorDate: '2026-05-08',
      linkedRecordId: 'DAILY-LINK-D',
    },
    {
      id: 'DAILY-LINK-D',
      linkId: 'DAILY-LINK',
      type: 'D',
      airline: 'VN',
      flightNumber: 'VN101',
      rawFlightNumber: '101',
      requestStatusCode: null,
      route: 'DAD-SGN',
      schedule: '09:20',
      aircraft: '321',
      category: 'J',
      flightType: 'PAX',
      codeShares: 'VN1101',
      intDomInd: null,
      pax: 100,
      gate: 5,
      stand: null,
      counter: 'C12',
      carousel: null,
      mct: '09:00',
      fb: null,
      lb: null,
      bhs: null,
      ghs: null,
      date: '2026-05-08',
      dayOfWeek: 5,
      action: null,
      sourceRowIndex: 201,
      sourceKind: 'imported',
      sourceSide: 'DEP',
      status: 'active',
      linkType: 'sameday',
      pairAnchorDate: '2026-05-08',
      linkedRecordId: 'DAILY-LINK-A',
    },
    {
      id: 'DAILY-LATE-D',
      linkId: 'DAILY-LATE-D',
      type: 'D',
      airline: 'VN',
      flightNumber: 'VN200',
      rawFlightNumber: '200',
      requestStatusCode: null,
      route: 'DAD-HAN',
      schedule: '05:00',
      aircraft: '321',
      category: 'J',
      flightType: 'PAX',
      codeShares: null,
      intDomInd: null,
      pax: null,
      gate: null,
      stand: null,
      counter: null,
      carousel: null,
      mct: null,
      fb: null,
      lb: null,
      bhs: null,
      ghs: null,
      date: '2026-05-09',
      dayOfWeek: 6,
      action: null,
      sourceRowIndex: 202,
      sourceKind: 'imported',
      sourceSide: 'DEP',
      status: 'active',
    },
  ];
  const defaultDailyRows = buildDailyScheduleRows({
    records: dailyFixtureRecords,
    modifications: new Map(),
    from: defaultDailyRange.from,
    to: defaultDailyRange.to,
  });
  assert(
    !defaultDailyRows.some((row) => row.arr?.id === 'DAILY-EARLY-A' || row.dep?.id === 'DAILY-EARLY-A'),
    `default daily range should not include 04:40 flights, got ${JSON.stringify(defaultDailyRows)}`
  );
  assert(
    !defaultDailyRows.some((row) => row.arr?.id === 'DAILY-LATE-D' || row.dep?.id === 'DAILY-LATE-D'),
    `daily range should exclude records exactly at the upper to boundary, got ${JSON.stringify(defaultDailyRows)}`
  );
  const linkedDailyRow = defaultDailyRows.find((row) => row.arr?.id === 'DAILY-LINK-A' || row.dep?.id === 'DAILY-LINK-D');
  assert(
    linkedDailyRow?.arr?.id === 'DAILY-LINK-A' && linkedDailyRow?.dep?.id === 'DAILY-LINK-D',
    `same-day linked ARR/DEP records should consolidate into one row, got ${JSON.stringify(defaultDailyRows)}`
  );
  assert(
    JSON.stringify(getDailyRowRecordIds(linkedDailyRow)) === JSON.stringify(['DAILY-LINK-A', 'DAILY-LINK-D']),
    `daily row record ids should include ARR and DEP ids, got ${JSON.stringify(getDailyRowRecordIds(linkedDailyRow))}`
  );
  assert(
    formatDailyScheduleDateTime(linkedDailyRow.arr) === '2026-05-08 08:10' &&
      formatDailyScheduleDateTime(linkedDailyRow.dep) === '2026-05-08 09:20',
    `daily STA/STD display should use yyyy-mm-dd hh:mm, got ${formatDailyScheduleDateTime(linkedDailyRow.arr)} ${formatDailyScheduleDateTime(linkedDailyRow.dep)}`
  );
  const overlayDailyRows = buildDailyScheduleRows({
    records: dailyFixtureRecords,
    modifications: new Map([['DAILY-EARLY-A', { legId: 'DAILY-EARLY-A', action: 'modified', schedule: '05:05' }]]),
    from: defaultDailyRange.from,
    to: defaultDailyRange.to,
  });
  assert(
    overlayDailyRows.some((row) => row.arr?.id === 'DAILY-EARLY-A' && row.arr.schedule === '05:05'),
    `daily modification overlay should affect range inclusion and row output, got ${JSON.stringify(overlayDailyRows)}`
  );
  const wideDailyRows = buildDailyScheduleRows({
    records: dailyFixtureRecords,
    modifications: new Map(),
    from: '2026-05-08T00:00',
    to: '2026-05-09T05:01',
  });
  const wideDailySummary = buildDailySummary(wideDailyRows);
  assert(
    wideDailySummary.arr === 2 && wideDailySummary.dep === 2 && wideDailySummary.total === 4,
    `wide daily range should summarize ARR 2, DEP 2, TOTAL 4, got ${JSON.stringify(wideDailySummary)}`
  );
  const filteredByGridFields = filterDailyRows(wideDailyRows, {
    aircraft: '321',
    arrFlight: 'VN100',
    sta: '2026-05-08 08:10',
    mcat: '08:00',
    from: 'SGN',
    arrPax: 90,
    carousel: 1,
    depFlight: 'VN101',
    std: '2026-05-08 09:20',
    mcdt: '09:00',
    to: 'SGN',
    depPax: 100,
    gate: 5,
    counters: 'C12',
  });
  assert(
    filteredByGridFields.length === 1 && filteredByGridFields[0].arr?.id === 'DAILY-LINK-A' && filteredByGridFields[0].dep?.id === 'DAILY-LINK-D',
    `daily grid-specific filters should match approved columns, got ${JSON.stringify(filteredByGridFields)}`
  );
  assert(
    filterDailyRows(wideDailyRows, { gate: 9 }).length === 0,
    `daily gate filter should read DEP gate only, not linked ARR gate, got ${JSON.stringify(filterDailyRows(wideDailyRows, { gate: 9 }))}`
  );
  assert(
    filterDailyRows(wideDailyRows, { arrStand: 11 }).some((row) => row.arr?.id === 'DAILY-EARLY-A'),
    `daily arrStand filter should match single-side ARR rows, got ${JSON.stringify(filterDailyRows(wideDailyRows, { arrStand: 11 }))}`
  );
  const sortedByCarousel = sortDailyRows(wideDailyRows, { field: 'carousel', direction: 'asc' });
  assert(
    sortedByCarousel.some((row) => row.arr?.carousel === 1),
    `daily sort should accept approved grid column fields like carousel, got ${JSON.stringify(sortedByCarousel)}`
  );
  const sortedByGate = sortDailyRows(wideDailyRows, { field: 'gate', direction: 'asc' });
  assert(
    sortedByGate.findIndex((row) => row.dep?.id === 'DAILY-LINK-D') < sortedByGate.findIndex((row) => row.arr?.id === 'DAILY-EARLY-A'),
    `daily gate sort should use DEP gate only, got ${JSON.stringify(sortedByGate)}`
  );
  const crossDateStaRows = [
    {
      id: 'STA-LATE-DAY',
      pairKey: 'single:STA-LATE-DAY',
      dateTime: '2026-05-08T23:00',
      arr: { id: 'STA-LATE-DAY', type: 'A', flightNumber: 'VN901', date: '2026-05-08', schedule: '23:00' },
    },
    {
      id: 'STA-NEXT-DAY',
      pairKey: 'single:STA-NEXT-DAY',
      dateTime: '2026-05-09T01:00',
      arr: { id: 'STA-NEXT-DAY', type: 'A', flightNumber: 'VN902', date: '2026-05-09', schedule: '01:00' },
    },
  ];
  assert(
    sortDailyRows(crossDateStaRows, { field: 'sta', direction: 'asc' })[0].id === 'STA-LATE-DAY',
    `daily STA sort should compare full date-time, got ${JSON.stringify(sortDailyRows(crossDateStaRows, { field: 'sta', direction: 'asc' }))}`
  );
  const crossDateStdRows = [
    {
      id: 'STD-LATE-DAY',
      pairKey: 'single:STD-LATE-DAY',
      dateTime: '2026-05-08T23:00',
      dep: { id: 'STD-LATE-DAY', type: 'D', flightNumber: 'VN903', date: '2026-05-08', schedule: '23:00' },
    },
    {
      id: 'STD-NEXT-DAY',
      pairKey: 'single:STD-NEXT-DAY',
      dateTime: '2026-05-09T01:00',
      dep: { id: 'STD-NEXT-DAY', type: 'D', flightNumber: 'VN904', date: '2026-05-09', schedule: '01:00' },
    },
  ];
  assert(
    sortDailyRows(crossDateStdRows, { field: 'std', direction: 'asc' })[0].id === 'STD-LATE-DAY',
    `daily STD sort should compare full date-time, got ${JSON.stringify(sortDailyRows(crossDateStdRows, { field: 'std', direction: 'asc' }))}`
  );
  const mixedStaRows = [
    {
      id: 'LINKED-EARLY',
      pairKey: 'linked:LINKED-EARLY-A:LINKED-EARLY-D',
      dateTime: '2026-05-08T06:00',
      arr: { id: 'LINKED-EARLY-A', type: 'A', flightNumber: 'VN905', date: '2026-05-08', schedule: '06:00' },
      dep: { id: 'LINKED-EARLY-D', type: 'D', flightNumber: 'VN906', date: '2026-05-08', schedule: '07:00' },
    },
    {
      id: 'STANDALONE-DEP-MID',
      pairKey: 'single:STANDALONE-DEP-MID',
      dateTime: '2026-05-08T08:00',
      dep: { id: 'STANDALONE-DEP-MID', type: 'D', flightNumber: 'VN907', date: '2026-05-08', schedule: '08:00' },
    },
    {
      id: 'LINKED-LATE',
      pairKey: 'linked:LINKED-LATE-A:LINKED-LATE-D',
      dateTime: '2026-05-08T10:00',
      arr: { id: 'LINKED-LATE-A', type: 'A', flightNumber: 'VN908', date: '2026-05-08', schedule: '10:00' },
      dep: { id: 'LINKED-LATE-D', type: 'D', flightNumber: 'VN909', date: '2026-05-08', schedule: '11:00' },
    },
  ];
  assert(
    JSON.stringify(sortDailyRows(mixedStaRows, { field: 'sta', direction: 'asc' }).map((row) => row.id)) === JSON.stringify(['LINKED-EARLY', 'STANDALONE-DEP-MID', 'LINKED-LATE']),
    `daily STA sort should place standalone DEP rows by actual datetime, got ${JSON.stringify(sortDailyRows(mixedStaRows, { field: 'sta', direction: 'asc' }).map((row) => row.id))}`
  );
  const mixedStdRows = [
    {
      id: 'LINKED-EARLY-STD',
      pairKey: 'linked:LINKED-EARLY-STD-A:LINKED-EARLY-STD-D',
      dateTime: '2026-05-08T06:00',
      arr: { id: 'LINKED-EARLY-STD-A', type: 'A', flightNumber: 'VN910', date: '2026-05-08', schedule: '06:00' },
      dep: { id: 'LINKED-EARLY-STD-D', type: 'D', flightNumber: 'VN911', date: '2026-05-08', schedule: '07:00' },
    },
    {
      id: 'STANDALONE-ARR-MID',
      pairKey: 'single:STANDALONE-ARR-MID',
      dateTime: '2026-05-08T08:00',
      arr: { id: 'STANDALONE-ARR-MID', type: 'A', flightNumber: 'VN912', date: '2026-05-08', schedule: '08:00' },
    },
    {
      id: 'LINKED-LATE-STD',
      pairKey: 'linked:LINKED-LATE-STD-A:LINKED-LATE-STD-D',
      dateTime: '2026-05-08T10:00',
      arr: { id: 'LINKED-LATE-STD-A', type: 'A', flightNumber: 'VN913', date: '2026-05-08', schedule: '10:00' },
      dep: { id: 'LINKED-LATE-STD-D', type: 'D', flightNumber: 'VN914', date: '2026-05-08', schedule: '11:00' },
    },
  ];
  assert(
    JSON.stringify(sortDailyRows(mixedStdRows, { field: 'std', direction: 'asc' }).map((row) => row.id)) === JSON.stringify(['LINKED-EARLY-STD', 'STANDALONE-ARR-MID', 'LINKED-LATE-STD']),
    `daily STD sort should place standalone ARR rows by actual datetime, got ${JSON.stringify(sortDailyRows(mixedStdRows, { field: 'std', direction: 'asc' }).map((row) => row.id))}`
  );
  assert(
    buildDailyCellModification(dailyFixtureRecords[1], 'sta', '10:30').schedule === '10:30',
    'daily STA cell edit should map to schedule modification'
  );
  assert(
    buildDailyCellModification(dailyFixtureRecords[1], 'mcat', '08:15').mct === '08:15' &&
      buildDailyCellModification(dailyFixtureRecords[2], 'mcdt', '09:45').mct === '09:45',
    'daily MCAT/MCDT cell edits should map to mct modification'
  );
  assert(
    buildDailyCellModification(dailyFixtureRecords[1], 'carousel', '2').carousel === 2,
    'daily carousel cell edit should map to numeric carousel modification'
  );
  assert(
    buildDailyCellModification(dailyFixtureRecords[1], 'bhs', 'B2').bhs === 'B2',
    'daily bhs cell edit should map to bhs modification'
  );
  assert(
    buildDailyCellModification(dailyFixtureRecords[2], 'gate', '12').gate === 12,
    'daily gate cell edit should map to numeric gate modification'
  );
  let unsupportedFlightEditError = null;
  try {
    buildDailyCellModification(dailyFixtureRecords[1], 'arrFlight', 'VN102');
  } catch (err) {
    unsupportedFlightEditError = err;
  }
  assert(
    unsupportedFlightEditError?.message.includes('Unsupported daily schedule field'),
    `daily flight-number cell mapping should be unsupported for now, got ${unsupportedFlightEditError?.message}`
  );
  const duplicateFlightEdit = validateDailyCellEdit({
    records: dailyFixtureRecords,
    record: dailyFixtureRecords[2],
    field: 'depFlight',
    value: 'VN100',
  });
  assert(!duplicateFlightEdit.valid, `duplicate daily flight number edit should be rejected, got ${JSON.stringify(duplicateFlightEdit)}`);
  const validStaEdit = validateDailyCellEdit({
    records: dailyFixtureRecords,
    record: dailyFixtureRecords[1],
    field: 'sta',
    value: '06:25',
  });
  assert(validStaEdit.valid, `valid daily STA edit should be accepted, got ${JSON.stringify(validStaEdit)}`);
  const invalidTimeEdit = validateDailyCellEdit({
    records: dailyFixtureRecords,
    record: dailyFixtureRecords[1],
    field: 'sta',
    value: '4:60',
  });
  assert(!invalidTimeEdit.valid, `invalid daily time edit should be rejected, got ${JSON.stringify(invalidTimeEdit)}`);
  const invalidNumericEdit = validateDailyCellEdit({
    records: dailyFixtureRecords,
    record: dailyFixtureRecords[2],
    field: 'gate',
    value: 'A12',
  });
  assert(!invalidNumericEdit.valid, `invalid daily numeric edit should be rejected, got ${JSON.stringify(invalidNumericEdit)}`);
  const invalidCarouselEdit = validateDailyCellEdit({
    records: dailyFixtureRecords,
    record: dailyFixtureRecords[1],
    field: 'carousel',
    value: '0',
  });
  assert(!invalidCarouselEdit.valid, `invalid daily carousel edit should be rejected, got ${JSON.stringify(invalidCarouselEdit)}`);

  const dailyImportUpdate = buildDailyScheduleImportUpdate({
    records: dailyFixtureRecords,
    modifications: new Map(),
    importRows: [{
      'AIRCRAFT_SERIES': '32n',
      'ARR-AIRLINE_FLIGHT_SUFFIX': 'vn100',
      'ARR-Scheduled': '2026-05-08 08:25:00',
      'ARR-ORIG_DEST_AIRPORT_CODE': 'hkg',
      'ARR-FlightCategory': 'j',
      'ARR-FlightType': 'pax',
      'ARR-STATUS_CODE': 'arr',
      'ARR-PAX_TOTAL': '123',
      'ARR-MCT': '2026-05-08 08:29:00',
      'ARR-BagFirst': '2026-05-08 08:41:00',
      'ARR-BagLast': '2026-05-08 09:02:00',
      'ARRReclaimBelt': '2',
      'ARRStand': '12',
      'ARR-CODESHARES': 'vn9001',
      'DEP-AIRLINE_FLIGHT_SUFFIX': 'vn301',
      'DEP-Scheduled': '2026-05-08 12:45:00',
      'DEP-ORIG_DEST_AIRPORT_CODE': 'hkg',
      'DEP-FlightCategory': 'j',
      'DEP-FlightType': 'pax',
      'DEP-STATUS_CODE': 'dep',
      'DEP-PAX_TOTAL': '130',
      'DEP-MCT': '2026-05-08 12:32:00',
      'DEPGate': '4',
      'DEPStand': '12',
      'CheckInDesk': 'm1,m2',
      'DEP-CODESHARES': 'vn9301',
    }],
    timestamp: 1700000000000,
    historyId: 'LOCAL_DAILY_IMPORT_TEST',
    nextSourceRowIndex: 900,
  });
  assert(
    dailyImportUpdate.stats.updated === 1 && dailyImportUpdate.stats.inserted === 1,
    `daily import should update matched ARR and insert missing DEP, got ${JSON.stringify(dailyImportUpdate.stats)}`
  );
  const importedArrMod = dailyImportUpdate.modifications.get('DAILY-LINK-A');
  assert(
    importedArrMod?.schedule === '08:25' &&
      importedArrMod?.pax === 123 &&
      importedArrMod?.mct === '08:29' &&
      importedArrMod?.fb === '08:41' &&
      importedArrMod?.lb === '09:02' &&
      importedArrMod?.carousel === 2 &&
      importedArrMod?.stand === 12 &&
      importedArrMod?.route === 'HKG' &&
      importedArrMod?.codeShares === 'VN9001',
    `daily import should map ARR operational fields to a local modification, got ${JSON.stringify(importedArrMod)}`
  );
  const importedDep = dailyImportUpdate.records.find((record) => record.flightNumber === 'VN301');
  const importedArr = dailyImportUpdate.records.find((record) => record.id === 'DAILY-LINK-A');
  assert(
    importedDep?.type === 'D' &&
      importedDep.schedule === '12:45' &&
      importedDep.date === '2026-05-08' &&
      importedDep.pax === 130 &&
      importedDep.mct === '12:32' &&
      importedDep.gate === 4 &&
      importedDep.stand === 12 &&
      importedDep.counter === 'M1,M2' &&
      importedDep.codeShares === 'VN9301',
    `daily import should create missing DEP records with mapped fields, got ${JSON.stringify(importedDep)}`
  );
  assert(
    importedArr?.linkedRecordId === importedDep?.id &&
      importedDep?.linkedRecordId === importedArr?.id &&
      importedArr?.linkType === 'sameday' &&
      dailyImportUpdate.historyEntry?.recordChanges?.some((change) => change.recordId === importedDep?.id && change.previousRecord == null),
    `daily import should link imported row pairs and record inserted history, got ${JSON.stringify({ arr: importedArr, dep: importedDep, history: dailyImportUpdate.historyEntry })}`
  );

  const alphanumericAirlineImportUpdate = buildDailyScheduleImportUpdate({
    records: [],
    modifications: new Map(),
    importRows: [{
      'AIRCRAFT_SERIES': '320',
      'ARR-AIRLINE_FLIGHT_SUFFIX': '5J5756',
      'ARR-Scheduled': '2026-04-01 21:30:00',
      'ARR-ORIG_DEST_AIRPORT_CODE': 'MNL',
      'DEP-AIRLINE_FLIGHT_SUFFIX': '7C1101',
      'DEP-Scheduled': '2026-04-01 22:30:00',
      'DEP-ORIG_DEST_AIRPORT_CODE': 'ICN',
    }],
    timestamp: 1700000000001,
    historyId: 'LOCAL_DAILY_IMPORT_ALPHANUMERIC_AIRLINE_TEST',
    nextSourceRowIndex: 950,
  });
  assert(
    alphanumericAirlineImportUpdate.stats.inserted === 2 &&
      alphanumericAirlineImportUpdate.stats.skipped === 0 &&
      alphanumericAirlineImportUpdate.records.some((record) => record.flightNumber === '5J5756' && record.airline === '5J') &&
      alphanumericAirlineImportUpdate.records.some((record) => record.flightNumber === '7C1101' && record.airline === '7C'),
    `daily import should accept alphanumeric IATA airline codes, got ${JSON.stringify({
      stats: alphanumericAirlineImportUpdate.stats,
      records: alphanumericAirlineImportUpdate.records.map((record) => ({
        airline: record.airline,
        flightNumber: record.flightNumber,
      })),
    })}`
  );

  const checkInRecord = {
    id: 'CHECKIN-VJ827',
    linkId: 'CHECKIN-VJ827',
    type: 'D',
    airline: 'VJ',
    flightNumber: 'VJ827',
    rawFlightNumber: '827',
    requestStatusCode: null,
    route: 'SGN',
    schedule: '07:45',
    aircraft: '321',
    category: 'J',
    flightType: 'PAX',
    codeShares: null,
    intDomInd: null,
    pax: 180,
    gate: 5,
    stand: null,
    counter: null,
    carousel: null,
    mct: null,
    fb: null,
    lb: null,
    bhs: null,
    ghs: null,
    date: '2026-05-08',
    dayOfWeek: 5,
    action: null,
    sourceRowIndex: 90,
    sourceKind: 'imported',
    sourceSide: 'DEP',
    status: 'active',
  };
  const checkInSettings = validateOperationalSettings({
    aircraftGroups: [],
    counterAllocationRules: [{
      id: 'vj-321',
      name: 'VJ 321 default',
      enabled: true,
      priorityScore: 10,
      sortOrder: 1,
      createdAt: 1,
      updatedAt: 1,
      conditions: { aircraftTypes: ['321'], aircraftGroups: [], airlineCodes: ['VJ'] },
      counterValue: 3,
    }],
    updatedAt: 1,
  });

  const defaultWindow = buildDefaultCheckInWindow(checkInRecord);
  assert(
    defaultWindow.start === '2026-05-08T04:45' &&
      defaultWindow.end === '2026-05-08T06:55',
    `default check-in window should be STD -3h to -50m, got ${JSON.stringify(defaultWindow)}`
  );
  assert(CHECKIN_SNAP_MINUTES === 15, `check-in snap should be 15 minutes, got ${CHECKIN_SNAP_MINUTES}`);
  assert(CHECKIN_RESIZE_SNAP_MINUTES === 1, `check-in resize snap should be 1 minute, got ${CHECKIN_RESIZE_SNAP_MINUTES}`);
  const resizeMarkerPreview = buildCheckInResizePreview({
    edge: 'start',
    anchorX: 100,
    anchorTime: '2026-05-08T09:00',
    startClientX: 104,
    clientX: 141,
    pixelsPerMinute: 1.5,
    timelineWidth: 1000,
  });
  const resizeMarkerRecord = {
    ...checkInRecord,
    id: 'CHECKIN-MARKER',
    counter: [1],
    checkInStart: '2026-05-08T09:00',
    checkInEnd: '2026-05-08T10:00',
    checkInAllocationMode: 'grouped',
  };
  const resizeMarkerCommitted = resizeCheckInAllocation({
    record: resizeMarkerRecord,
    counter: 1,
    edge: 'start',
    minuteDelta: resizeMarkerPreview.minuteDelta,
    records: [resizeMarkerRecord],
    modifications: new Map(),
    settings: checkInSettings,
  });
  assert(
    resizeMarkerPreview.minuteDelta === 25 &&
      resizeMarkerPreview.markerX === 137.5 &&
      resizeMarkerPreview.time === '2026-05-08T09:25' &&
      resizeMarkerPreview.label === '09:25' &&
      resizeMarkerCommitted.checkInStart === '2026-05-08T09:25',
    `resize marker preview should use handle-click delta and match committed snapped edge time, got ${JSON.stringify({ resizeMarkerPreview, resizeMarkerCommitted })}`
  );
  assert(
    JSON.stringify(normalizeCheckInCounterList('1,2,5')) === JSON.stringify([1, 2, 5]) &&
      JSON.stringify(normalizeCheckInCounterList('1-3')) === JSON.stringify([1, 2, 3]) &&
      JSON.stringify(normalizeCheckInCounterList(['M1', 'M2'])) === JSON.stringify(['M1', 'M2']) &&
      JSON.stringify(normalizeCheckInCounterList({ counters: [1, 2, 'M1'] })) === JSON.stringify([1, 2, 'M1']),
    'check-in counter normalization should handle CSV, ranges, arrays, and object payloads'
  );
  assert(
    JSON.stringify(buildDefaultCounterRoster([{ ...checkInRecord, counter: [3, 1, 'M2'] }])) === JSON.stringify([
      1, 2, 3, 4, 5, 6, 7, 8, 9, 10,
      11, 12, 13, 14, 15, 16, 17, 18, 19, 20,
      'M1', 'M2', 'M3', 'M4', 'M5',
    ]),
    `default counter roster should keep baseline counters plus assigned counters, got ${JSON.stringify(buildDefaultCounterRoster([{ ...checkInRecord, counter: [3, 1, 'M2'] }]))}`
  );

  const allocated = allocateCheckInCounters({
    record: checkInRecord,
    records: [checkInRecord],
    modifications: new Map(),
    settings: checkInSettings,
    roster: [1, 2, 3, 4, 5, 'M1'],
    startCounter: 1,
  });
  assert(
    JSON.stringify(allocated.counter) === JSON.stringify([1, 2, 3]) &&
      allocated.checkInAllocationMode === 'grouped',
    `allocating should assign contiguous counters and grouped mode, got ${JSON.stringify(allocated)}`
  );

  const secondAllocated = allocateCheckInCounters({
    record: { ...checkInRecord, id: 'CHECKIN-VJ828', flightNumber: 'VJ828', rawFlightNumber: '828' },
    records: [
      checkInRecord,
      { ...checkInRecord, id: 'CHECKIN-VJ828', flightNumber: 'VJ828', rawFlightNumber: '828' },
    ],
    modifications: new Map([['CHECKIN-VJ827', { legId: 'CHECKIN-VJ827', action: 'modified', ...allocated }]]),
    settings: checkInSettings,
    roster: buildDefaultCounterRoster([{ ...checkInRecord, counter: [1, 2, 3] }]),
    startCounter: 4,
  });
  assert(
    JSON.stringify(secondAllocated.counter) === JSON.stringify([4, 5, 6]),
    `second allocation should use baseline roster rows beyond existing counters, got ${JSON.stringify(secondAllocated)}`
  );

  const allocatedView = buildCheckInAllocationView({
    records: [checkInRecord],
    modifications: new Map([['CHECKIN-VJ827', { legId: 'CHECKIN-VJ827', action: 'modified', ...allocated }]]),
    settings: checkInSettings,
    from: '2026-05-08T04:00',
    to: '2026-05-08T08:00',
    roster: [1, 2, 3, 4, 5, 'M1'],
    pixelsPerMinute: 4,
  });
  assert(
    allocatedView.resourceBars.length === 3 &&
      allocatedView.resourceBars.every((bar) => bar.flightNumber === 'VJ827') &&
      allocatedView.resourceBars.every((bar) => bar.groupId === 'CHECKIN-VJ827') &&
      allocatedView.resourceBars.every((bar) => bar.stackIndex === 0 && bar.stackLaneCount === 1) &&
      JSON.stringify(allocatedView.resourceBars.map((bar) => bar.counter)) === JSON.stringify([1, 2, 3]),
    `grouped allocation should render one discrete bar per counter, got ${JSON.stringify(allocatedView.resourceBars)}`
  );
  const canonicalAddedCheckInView = buildCheckInAllocationView({
    records: dailyCanonicalRecords,
    modifications: new Map(),
    settings: checkInSettings,
    from: '2026-05-08T04:00',
    to: '2026-05-08T08:30',
    roster: [1, 2, 3, 4, 5, 'M1'],
    pixelsPerMinute: 4,
  });
  assert(
    canonicalAddedCheckInView.resourceBars.length === 0 &&
      canonicalAddedCheckInView.unallocated.length === 1 &&
      canonicalAddedCheckInView.unallocated[0].record.id === dailyCanonicalRecords[0].id &&
      canonicalAddedCheckInView.unallocated[0].record.sourceKind === 'added',
    `canonical Daily/Detailed-added no-counter departures should render in Check-in unallocated, got ${JSON.stringify(canonicalAddedCheckInView)}`
  );

  const checkInDomainSettings = validateOperationalSettings({
    aircraftGroups: [],
    counterAllocationRules: [{
      id: 'domain-vj-321',
      name: 'Domain VJ 321',
      enabled: true,
      priorityScore: 10,
      sortOrder: 1,
      createdAt: 1,
      updatedAt: 1,
      conditions: { aircraftTypes: ['321'], aircraftGroups: [], airlineCodes: ['VJ'] },
      counterValue: 2,
    }],
    checkInCounters: [
      { id: 'domain-c1', label: '1', enabled: true, sortOrder: 1, createdAt: 1, updatedAt: 1 },
      { id: 'domain-c2', label: '2', enabled: true, sortOrder: 2, createdAt: 1, updatedAt: 1 },
      { id: 'domain-m1', label: 'M1', enabled: true, sortOrder: 3, createdAt: 1, updatedAt: 1 },
      { id: 'domain-z1', label: 'Z1', enabled: true, sortOrder: 0, createdAt: 1, updatedAt: 1 },
    ],
    checkInCounterGroups: [
      { id: 'domain-island-a', name: 'Island A', bhs: 'BHS-A', counterIds: ['domain-c1', 'domain-c2'], sortOrder: 1, createdAt: 1, updatedAt: 1 },
      { id: 'domain-mobility', name: 'Mobility', bhs: 'BHS-M', counterIds: ['domain-m1'], sortOrder: 2, createdAt: 1, updatedAt: 1 },
    ],
    checkInCounterLocks: [
      { id: 'domain-m1-lock', name: 'M1 Outage', counterIds: ['domain-m1'], start: '2026-05-08T05:00', end: '2026-05-08T06:00', reason: 'Maintenance', enabled: true, createdAt: 1, updatedAt: 1 },
    ],
    updatedAt: 1,
  });
  const settingsBackedView = buildCheckInAllocationView({
    records: [
      { ...checkInRecord, counter: ['1'] },
      { ...checkInRecord, id: 'CHECKIN-LEGACY', flightNumber: 'VJ830', rawFlightNumber: '830', counter: ['L1'] },
    ],
    modifications: new Map(),
    settings: checkInDomainSettings,
    from: '2026-05-08T04:00',
    to: '2026-05-08T08:00',
    pixelsPerMinute: 4,
    groupByCounterGroup: true,
  });
  assert(
    JSON.stringify(settingsBackedView.resourceRows.map((row) => row.label)) === JSON.stringify(['1', '2', 'M1', 'Z1', 'L1']) &&
      JSON.stringify(settingsBackedView.roster) === JSON.stringify([1, 2, 'M1', 'Z1', 'L1']) &&
      JSON.stringify(settingsBackedView.resourceSections.map((section) => [section.id, section.startIndex, section.endIndex])) === JSON.stringify([
        ['domain-island-a', 0, 1],
        ['domain-mobility', 2, 2],
        ['ungrouped', 3, 3],
        ['legacy', 4, 4],
      ]) &&
      settingsBackedView.resourceRows.filter((row) => row.label === '1').length === 1,
    `allocation view should expose grouped configured resource rows without duplicate legacy rows, got ${JSON.stringify(settingsBackedView)}`
  );

  const domainResources = settingsBackedView.resourceRows;
  const bhsAllocated = allocateCheckInCounters({
    record: checkInRecord,
    records: [checkInRecord],
    modifications: new Map(),
    settings: checkInDomainSettings,
    roster: settingsBackedView.roster,
    resources: domainResources,
    startCounter: 1,
  });
  assert(
    JSON.stringify(bhsAllocated.counter) === JSON.stringify([1, 2]) &&
      bhsAllocated.bhs === 'BHS-A',
    `settings-backed allocation should write derived BHS into the modification, got ${JSON.stringify(bhsAllocated)}`
  );
  const bhsReshaped = reshapeCheckInAllocation({
    record: { ...checkInRecord, counter: [1, 'M1'], checkInAllocationMode: 'broken' },
    roster: settingsBackedView.roster,
    resources: domainResources,
    records: [],
    modifications: new Map(),
  });
  assert(
    JSON.stringify(bhsReshaped.counter) === JSON.stringify([1, 2]) &&
      bhsReshaped.checkInAllocationMode === 'grouped' &&
      bhsReshaped.bhs === 'BHS-A',
    `settings-backed reshape should write derived BHS for reshaped counters, got ${JSON.stringify(bhsReshaped)}`
  );
  const bhsMoved = moveCheckInAllocation({
    record: { ...checkInRecord, counter: [2, 'M1'], checkInAllocationMode: 'grouped' },
    roster: settingsBackedView.roster,
    resources: domainResources,
    rowDelta: -1,
    minuteDelta: 0,
    records: [],
    modifications: new Map(),
  });
  assert(
    JSON.stringify(bhsMoved.counter) === JSON.stringify([1, 2]) &&
      bhsMoved.bhs === 'BHS-A',
    `settings-backed move should write derived BHS after moving to a configured group, got ${JSON.stringify(bhsMoved)}`
  );
  const bhsAdded = addCheckInCounter({
    record: { ...checkInRecord, counter: [1, 2], checkInStart: '2026-05-08T06:00', checkInEnd: '2026-05-08T06:55', checkInAllocationMode: 'grouped' },
    roster: settingsBackedView.roster,
    resources: domainResources,
    records: [],
    modifications: new Map(),
  });
  assert(
    JSON.stringify(bhsAdded.counter) === JSON.stringify([1, 2, 'M1']) &&
      bhsAdded.bhs === 'BHS-A,BHS-M',
    `settings-backed add should write comma-separated derived BHS for multi-group counters, got ${JSON.stringify(bhsAdded)}`
  );

  const lockedExistingView = buildCheckInAllocationView({
    records: [{ ...checkInRecord, counter: ['M1'], checkInStart: '2026-05-08T05:15', checkInEnd: '2026-05-08T05:45' }],
    modifications: new Map(),
    settings: checkInDomainSettings,
    from: '2026-05-08T04:00',
    to: '2026-05-08T08:00',
    pixelsPerMinute: 4,
    groupByCounterGroup: true,
  });
  assert(
    lockedExistingView.resourceBars.length === 1 &&
      lockedExistingView.resourceBars[0].counter === 'M1' &&
      lockedExistingView.resourceBars[0].bhs === 'BHS-M' &&
      lockedExistingView.resourceBars[0].lockConflict?.lock.name === 'M1 Outage',
    `existing allocation on a locked counter should stay visible with BHS and lock metadata, got ${JSON.stringify(lockedExistingView.resourceBars)}`
  );

  const assertLockedCheckInChange = (label, action) => {
    let error = null;
    try {
      action();
    } catch (err) {
      error = err;
    }
    assert(
      error?.message.includes('locked') && error.message.includes('M1 Outage'),
      `${label} should reject active check-in counter locks, got ${error?.message}`
    );
  };
  assertLockedCheckInChange('allocation', () => allocateCheckInCounters({
    record: { ...checkInRecord, aircraft: '320' },
    records: [],
    modifications: new Map(),
    settings: checkInDomainSettings,
    roster: settingsBackedView.roster,
    resources: domainResources,
    startCounter: 'M1',
  }));
  assertLockedCheckInChange('move', () => moveCheckInAllocation({
    record: { ...checkInRecord, counter: [2], checkInAllocationMode: 'grouped' },
    roster: settingsBackedView.roster,
    resources: domainResources,
    rowDelta: 1,
    minuteDelta: 0,
    records: [],
    modifications: new Map(),
  }));
  assertLockedCheckInChange('add', () => addCheckInCounter({
    record: { ...checkInRecord, counter: [1, 2], checkInAllocationMode: 'grouped' },
    roster: settingsBackedView.roster,
    resources: domainResources,
    records: [],
    modifications: new Map(),
  }));
  assertLockedCheckInChange('reshape', () => reshapeCheckInAllocation({
    record: { ...checkInRecord, counter: ['M1', 'L1'], checkInAllocationMode: 'broken' },
    roster: settingsBackedView.roster,
    resources: domainResources,
    records: [],
    modifications: new Map(),
  }));
  assertLockedCheckInChange('resize', () => resizeCheckInAllocation({
    record: { ...checkInRecord, counter: ['M1'], checkInStart: '2026-05-08T04:00', checkInEnd: '2026-05-08T04:45', checkInAllocationMode: 'grouped' },
    edge: 'end',
    minuteDelta: 30,
    resources: domainResources,
    records: [],
    modifications: new Map(),
  }));
  assertLockedCheckInChange('override', () => overrideCheckInTimes({
    record: { ...checkInRecord, counter: ['M1'], checkInAllocationMode: 'grouped' },
    start: '2026-05-08T05:15',
    end: '2026-05-08T05:45',
    resources: domainResources,
    records: [],
    modifications: new Map(),
  }));

  const overlappingView = buildCheckInAllocationView({
    records: [
      { ...checkInRecord, id: 'OVERLAP-A', flightNumber: 'VJ827', counter: [1] },
      { ...checkInRecord, id: 'OVERLAP-B', flightNumber: 'VJ828', rawFlightNumber: '828', counter: [1] },
      { ...checkInRecord, id: 'OVERLAP-C', flightNumber: 'VJ829', rawFlightNumber: '829', schedule: '10:00', counter: [1] },
    ],
    modifications: new Map(),
    settings: checkInSettings,
    from: '2026-05-08T04:00',
    to: '2026-05-08T11:00',
    roster: [1],
    pixelsPerMinute: 4,
  });
  const overlapA = overlappingView.resourceBars.find((bar) => bar.recordId === 'OVERLAP-A');
  const overlapB = overlappingView.resourceBars.find((bar) => bar.recordId === 'OVERLAP-B');
  const overlapC = overlappingView.resourceBars.find((bar) => bar.recordId === 'OVERLAP-C');
  assert(
    overlapA?.stackLaneCount === 2 &&
      overlapB?.stackLaneCount === 2 &&
      overlapA.stackIndex !== overlapB.stackIndex &&
      overlapC?.stackIndex === 0,
    `overlapping bars on the same counter should stack into expanded lanes, got ${JSON.stringify(overlappingView.resourceBars)}`
  );
  const deletedCheckInView = buildCheckInAllocationView({
    records: [{ ...checkInRecord, counter: [1] }],
    modifications: new Map([['CHECKIN-VJ827', { legId: 'CHECKIN-VJ827', action: 'deleted' }]]),
    settings: checkInSettings,
    from: '2026-05-08T04:00',
    to: '2026-05-08T08:00',
    roster: [1, 2, 3],
    pixelsPerMinute: 4,
  });
  assert(
    deletedCheckInView.resourceBars.length === 0 &&
      deletedCheckInView.unallocated.length === 0,
    `deleted modified records should be absent from check-in allocation view, got ${JSON.stringify(deletedCheckInView)}`
  );

  const clippedBeforeView = buildCheckInAllocationView({
    records: [{
      ...checkInRecord,
      counter: [1],
      checkInStart: '2026-05-08T04:30',
      checkInEnd: '2026-05-08T06:00',
    }],
    modifications: new Map(),
    settings: checkInSettings,
    from: '2026-05-08T05:00',
    to: '2026-05-08T07:00',
    roster: [1],
    pixelsPerMinute: 4,
  });
  assert(
    clippedBeforeView.resourceBars[0]?.leftPercent === 0 &&
      clippedBeforeView.resourceBars[0]?.widthPercent === 50,
    `bars starting before the timeline should clip to visible range, got ${JSON.stringify(clippedBeforeView.resourceBars[0])}`
  );

  const clippedAfterView = buildCheckInAllocationView({
    records: [{
      ...checkInRecord,
      counter: [1],
      checkInStart: '2026-05-08T06:00',
      checkInEnd: '2026-05-08T08:00',
    }],
    modifications: new Map(),
    settings: checkInSettings,
    from: '2026-05-08T05:00',
    to: '2026-05-08T07:00',
    roster: [1],
    pixelsPerMinute: 4,
  });
  assert(
    clippedAfterView.resourceBars[0]?.leftPercent === 50 &&
      clippedAfterView.resourceBars[0]?.widthPercent === 50,
    `bars ending after the timeline should clip to visible range, got ${JSON.stringify(clippedAfterView.resourceBars[0])}`
  );

  let equalCheckInRangeError = null;
  try {
    buildCheckInAllocationView({
      records: [checkInRecord],
      modifications: new Map(),
      settings: checkInSettings,
      from: '2026-05-08T05:00',
      to: '2026-05-08T05:00',
      roster: [1],
      pixelsPerMinute: 4,
    });
  } catch (err) {
    equalCheckInRangeError = err;
  }
  assert(
    equalCheckInRangeError?.message.includes('Timeline start must be before end'),
    `equal check-in view ranges should be rejected, got ${equalCheckInRangeError?.message}`
  );

  let reversedCheckInRangeError = null;
  try {
    buildCheckInAllocationView({
      records: [checkInRecord],
      modifications: new Map(),
      settings: checkInSettings,
      from: '2026-05-08T08:00',
      to: '2026-05-08T05:00',
      roster: [1],
      pixelsPerMinute: 4,
    });
  } catch (err) {
    reversedCheckInRangeError = err;
  }
  assert(
    reversedCheckInRangeError?.message.includes('Timeline start must be before end'),
    `reversed check-in view ranges should be rejected, got ${reversedCheckInRangeError?.message}`
  );

  const broken = breakCheckInAllocation({ record: checkInRecord, currentCounter: [1, 2, 5] });
  assert(
    broken.checkInAllocationMode === 'broken' &&
      JSON.stringify(broken.counter) === JSON.stringify([1, 2, 5]) &&
      broken.checkInCounterWindows?.['N:1']?.start === '2026-05-08T04:45' &&
      broken.checkInCounterWindows?.['N:5']?.end === '2026-05-08T06:55',
    `break shape should preserve broken counter payload [1,2,5], got ${JSON.stringify(broken)}`
  );
  const brokenIndividualView = buildCheckInAllocationView({
    records: [{
      ...checkInRecord,
      counter: [1, 2],
      checkInAllocationMode: 'broken',
      checkInCounterWindows: {
        'N:1': { start: '2026-05-08T04:45', end: '2026-05-08T06:55' },
        'N:2': { start: '2026-05-08T05:15', end: '2026-05-08T07:25' },
      },
    }],
    modifications: new Map(),
    settings: checkInSettings,
    from: '2026-05-08T04:00',
    to: '2026-05-08T08:00',
    roster: [1, 2],
    pixelsPerMinute: 1,
  });
  assert(
    brokenIndividualView.resourceBars.find((bar) => bar.counter === 1)?.start === '2026-05-08T04:45' &&
      brokenIndividualView.resourceBars.find((bar) => bar.counter === 2)?.start === '2026-05-08T05:15',
    `broken bars should render each counter's individual window, got ${JSON.stringify(brokenIndividualView.resourceBars)}`
  );
  const reshaped = reshapeCheckInAllocation({
    record: { ...checkInRecord, counter: [1, 2, 5], checkInAllocationMode: 'broken' },
    roster: [1, 2, 3, 4, 5],
    records: [],
    modifications: new Map(),
  });
  assert(
    reshaped.checkInAllocationMode === 'grouped' &&
      JSON.stringify(reshaped.counter) === JSON.stringify([1, 2, 3]) &&
      reshaped.checkInStart === '2026-05-08T04:45' &&
      reshaped.checkInEnd === '2026-05-08T06:55',
    `reshape should restore a broken shape to grouped contiguous counters while preserving the shared window, got ${JSON.stringify(reshaped)}`
  );

  const movedBrokenCounter = moveCheckInAllocation({
    record: { ...checkInRecord, counter: [1, 2, 5], checkInAllocationMode: 'broken' },
    roster: [1, 2, 3, 4, 5],
    counter: 2,
    rowDelta: 2,
    minuteDelta: 0,
    records: [],
    modifications: new Map(),
  });
  assert(
    JSON.stringify(movedBrokenCounter.counter) === JSON.stringify([1, 4, 5]) &&
      movedBrokenCounter.checkInStart === '2026-05-08T04:45' &&
      movedBrokenCounter.checkInEnd === '2026-05-08T06:55' &&
      movedBrokenCounter.checkInAllocationMode === 'broken',
    `broken counter drag should move only the selected counter and preserve shared window, got ${JSON.stringify(movedBrokenCounter)}`
  );
  const movedBrokenCounterWindow = moveCheckInAllocation({
    record: {
      ...checkInRecord,
      counter: [1, 2],
      checkInAllocationMode: 'broken',
      checkInCounterWindows: {
        'N:1': { start: '2026-05-08T04:45', end: '2026-05-08T06:55' },
        'N:2': { start: '2026-05-08T05:30', end: '2026-05-08T07:00' },
      },
    },
    roster: [1, 2, 3],
    counter: 2,
    rowDelta: 1,
    minuteDelta: 0,
    records: [],
    modifications: new Map(),
  });
  assert(
    JSON.stringify(movedBrokenCounterWindow.counter) === JSON.stringify([1, 3]) &&
      movedBrokenCounterWindow.checkInCounterWindows?.['N:3']?.start === '2026-05-08T05:30' &&
      !movedBrokenCounterWindow.checkInCounterWindows?.['N:2'],
    `moving one broken counter should carry its individual window to the new counter, got ${JSON.stringify(movedBrokenCounterWindow)}`
  );

  const moved = moveCheckInAllocation({
    record: { ...checkInRecord, counter: [1, 2, 3], checkInAllocationMode: 'grouped' },
    roster: [1, 2, 3, 4, 5],
    rowDelta: 1,
    minuteDelta: 15,
    records: [],
    modifications: new Map(),
  });
  assert(
    JSON.stringify(moved.counter) === JSON.stringify([2, 3, 4]) &&
      moved.checkInStart === '2026-05-08T05:00' &&
      moved.checkInEnd === '2026-05-08T07:10',
    `grouped move should shift counters and snapped time together, got ${JSON.stringify(moved)}`
  );

  const resized = resizeCheckInAllocation({
    record: { ...checkInRecord, counter: [1, 2, 3], checkInAllocationMode: 'grouped' },
    edge: 'end',
    minuteDelta: 15,
    records: [],
    modifications: new Map(),
  });
  assert(resized.checkInEnd === '2026-05-08T07:10', `resize should update shared end time, got ${JSON.stringify(resized)}`);
  const minuteResized = resizeCheckInAllocation({
    record: { ...checkInRecord, counter: [1, 2, 3], checkInAllocationMode: 'grouped' },
    edge: 'end',
    minuteDelta: 1,
    records: [],
    modifications: new Map(),
  });
  assert(minuteResized.checkInEnd === '2026-05-08T06:56', `resize should snap to every minute, got ${JSON.stringify(minuteResized)}`);
  const brokenCounterResized = resizeCheckInAllocation({
    record: {
      ...checkInRecord,
      counter: [1, 2],
      checkInAllocationMode: 'broken',
      checkInCounterWindows: {
        'N:1': { start: '2026-05-08T04:45', end: '2026-05-08T06:55' },
        'N:2': { start: '2026-05-08T05:15', end: '2026-05-08T07:15' },
      },
    },
    counter: 2,
    edge: 'end',
    minuteDelta: 10,
    records: [],
    modifications: new Map(),
  });
  assert(
    brokenCounterResized.checkInCounterWindows?.['N:1']?.end === '2026-05-08T06:55' &&
      brokenCounterResized.checkInCounterWindows?.['N:2']?.end === '2026-05-08T07:25' &&
      brokenCounterResized.checkInStart === '2026-05-08T04:45' &&
      brokenCounterResized.checkInEnd === '2026-05-08T06:55',
    `broken counter resize should update only the selected counter window, got ${JSON.stringify(brokenCounterResized)}`
  );

  let checkInOverlapError = null;
  let overlappingMove = null;
  try {
    overlappingMove = moveCheckInAllocation({
      record: { ...checkInRecord, counter: [1], checkInAllocationMode: 'grouped' },
      roster: [1, 2, 3],
      rowDelta: 0,
      minuteDelta: 0,
      records: [{ ...checkInRecord, id: 'CHECKIN-CONFLICT', flightNumber: 'VJ828', schedule: '08:00', counter: [1] }],
      modifications: new Map(),
    });
  } catch (err) {
    checkInOverlapError = err;
  }
  assert(
    checkInOverlapError == null &&
      JSON.stringify(overlappingMove?.counter) === JSON.stringify([1]),
    `same-counter overlapping check-in windows should be allowed and stacked, got ${checkInOverlapError?.message ?? JSON.stringify(overlappingMove)}`
  );
  let deletedCheckInOverlapError = null;
  try {
    moveCheckInAllocation({
      record: { ...checkInRecord, counter: [1], checkInAllocationMode: 'grouped' },
      roster: [1, 2, 3],
      rowDelta: 0,
      minuteDelta: 0,
      records: [{ ...checkInRecord, id: 'CHECKIN-DELETED-CONFLICT', flightNumber: 'VJ828', schedule: '08:00', counter: [1] }],
      modifications: new Map([['CHECKIN-DELETED-CONFLICT', { legId: 'CHECKIN-DELETED-CONFLICT', action: 'deleted' }]]),
    });
  } catch (err) {
    deletedCheckInOverlapError = err;
  }
  assert(
    deletedCheckInOverlapError == null,
    `deleted modified records should not block overlap validation, got ${deletedCheckInOverlapError?.message}`
  );

  const overridden = overrideCheckInTimes({
    record: checkInRecord,
    start: '2026-05-08T05:00',
    end: '2026-05-08T07:30',
  });
  assert(
    overridden.checkInStart === '2026-05-08T05:00' && overridden.checkInEnd === '2026-05-08T07:30',
    `override times should persist exact values, got ${JSON.stringify(overridden)}`
  );
  const brokenCounterOverride = overrideCheckInTimes({
    record: {
      ...checkInRecord,
      counter: [1, 2],
      checkInAllocationMode: 'broken',
      checkInCounterWindows: {
        'N:1': { start: '2026-05-08T04:45', end: '2026-05-08T06:55' },
        'N:2': { start: '2026-05-08T05:15', end: '2026-05-08T07:15' },
      },
    },
    counter: 2,
    start: '2026-05-08T05:45',
    end: '2026-05-08T07:45',
  });
  assert(
    brokenCounterOverride.checkInCounterWindows?.['N:1']?.start === '2026-05-08T04:45' &&
      brokenCounterOverride.checkInCounterWindows?.['N:2']?.start === '2026-05-08T05:45' &&
      brokenCounterOverride.checkInCounterWindows?.['N:2']?.end === '2026-05-08T07:45' &&
      brokenCounterOverride.checkInStart === '2026-05-08T04:45' &&
      brokenCounterOverride.checkInEnd === '2026-05-08T06:55',
    `broken counter override should update only the selected counter window, got ${JSON.stringify(brokenCounterOverride)}`
  );

  const addedCounter = addCheckInCounter({
    record: { ...checkInRecord, counter: [1, 2], checkInAllocationMode: 'grouped' },
    roster: [1, 2, 3],
    records: [],
    modifications: new Map(),
  });
  assert(JSON.stringify(addedCounter.counter) === JSON.stringify([1, 2, 3]), `add counter should append next contiguous row, got ${JSON.stringify(addedCounter)}`);

  const removedCounter = removeCheckInCounter({
    record: { ...checkInRecord, counter: [1, 2, 3], checkInAllocationMode: 'grouped' },
    clickedCounter: 2,
  });
  assert(JSON.stringify(removedCounter.counter) === JSON.stringify([1, 2]), `remove grouped counter should remove lowest row, got ${JSON.stringify(removedCounter)}`);
  const removedCounterWithBhs = removeCheckInCounter({
    record: { ...checkInRecord, counter: [1, 'M1'], checkInAllocationMode: 'broken', bhs: 'BHS-A,BHS-M' },
    clickedCounter: 'M1',
    resources: domainResources,
  });
  assert(
    JSON.stringify(removedCounterWithBhs.counter) === JSON.stringify([1]) &&
      removedCounterWithBhs.bhs === 'BHS-A',
    `remove counter should recalculate derived BHS from remaining counters when resources are provided, got ${JSON.stringify(removedCounterWithBhs)}`
  );
  const removedCounterWithNoBhs = removeCheckInCounter({
    record: { ...checkInRecord, counter: ['Z1', 'L1'], checkInAllocationMode: 'broken', bhs: 'BHS-STALE' },
    clickedCounter: 'Z1',
    resources: domainResources,
  });
  assert(
    JSON.stringify(removedCounterWithNoBhs.counter) === JSON.stringify(['L1']) &&
      removedCounterWithNoBhs.bhs === null,
    `remove counter should clear derived BHS when remaining counters have no BHS mapping, got ${JSON.stringify(removedCounterWithNoBhs)}`
  );
  const removedBrokenCounter = removeCheckInCounter({
    record: { ...checkInRecord, counter: [1, 2, 5], checkInAllocationMode: 'broken' },
    clickedCounter: 2,
  });
  assert(
    JSON.stringify(removedBrokenCounter.counter) === JSON.stringify([1, 5]) &&
      removedBrokenCounter.checkInAllocationMode === 'broken' &&
      removedBrokenCounter.checkInStart === '2026-05-08T04:45',
    `dragging a broken block back to unallocated should remove only that counter, got ${JSON.stringify(removedBrokenCounter)}`
  );

  const unallocatedCheckIn = unallocateCheckInRecord({ ...checkInRecord, counter: [1, 2], checkInStart: '2026-05-08T05:00', checkInEnd: '2026-05-08T07:30', checkInAllocationMode: 'grouped', bhs: 'BHS-A' });
  assert(
    unallocatedCheckIn.counter === null &&
      unallocatedCheckIn.checkInStart === null &&
      unallocatedCheckIn.checkInEnd === null &&
      unallocatedCheckIn.checkInAllocationMode === null &&
      unallocatedCheckIn.bhs === null,
    `unallocate should clear counter and check-in overrides, got ${JSON.stringify(unallocatedCheckIn)}`
  );
  const periodGroupedRecord = {
    ...checkInRecord,
    id: 'CHECKIN-PERIOD-GROUPED',
    counter: [1, 2],
    checkInStart: '2026-05-08T05:00',
    checkInEnd: '2026-05-08T07:30',
    checkInAllocationMode: 'grouped',
  };
  const periodGroupedView = buildCheckInAllocationView({
    records: [periodGroupedRecord],
    modifications: new Map(),
    settings: checkInSettings,
    from: '2026-05-08T04:00',
    to: '2026-05-08T08:00',
    roster: [1, 2, 3, 4, 5, 'M1'],
    pixelsPerMinute: 4,
  });
  const periodGroupedMods = buildCheckInPeriodUnallocationModifications({
    records: [periodGroupedRecord],
    resourceBars: periodGroupedView.resourceBars,
    resources: periodGroupedView.resourceRows,
    settings: checkInSettings,
  });
  assert(
    periodGroupedMods.length === 1 &&
      periodGroupedMods[0].counter === null &&
      periodGroupedMods[0].checkInStart === null &&
      periodGroupedMods[0].checkInEnd === null,
    `period unallocate should fully clear grouped allocations visible in the selected window, got ${JSON.stringify(periodGroupedMods)}`
  );
  const periodBrokenRecord = {
    ...checkInRecord,
    id: 'CHECKIN-PERIOD-BROKEN',
    counter: [1, 2, 5],
    checkInStart: '2026-05-08T04:45',
    checkInEnd: '2026-05-08T06:55',
    checkInAllocationMode: 'broken',
    checkInCounterWindows: {
      'N:1': { start: '2026-05-08T05:00', end: '2026-05-08T06:00' },
      'N:2': { start: '2026-05-08T09:00', end: '2026-05-08T10:00' },
      'N:5': { start: '2026-05-08T05:30', end: '2026-05-08T06:30' },
    },
  };
  const periodBrokenView = buildCheckInAllocationView({
    records: [periodBrokenRecord],
    modifications: new Map(),
    settings: checkInSettings,
    from: '2026-05-08T04:00',
    to: '2026-05-08T07:00',
    roster: [1, 2, 3, 4, 5, 'M1'],
    pixelsPerMinute: 4,
  });
  const periodBrokenMods = buildCheckInPeriodUnallocationModifications({
    records: [periodBrokenRecord],
    resourceBars: periodBrokenView.resourceBars,
    resources: periodBrokenView.resourceRows,
    settings: checkInSettings,
  });
  assert(
    periodBrokenMods.length === 1 &&
      JSON.stringify(periodBrokenMods[0].counter) === JSON.stringify([2]) &&
      periodBrokenMods[0].checkInAllocationMode === 'broken' &&
      JSON.stringify(periodBrokenMods[0].checkInCounterWindows) === JSON.stringify({
        'N:2': { start: '2026-05-08T09:00', end: '2026-05-08T10:00' },
      }),
    `period unallocate should remove only visible broken counters while preserving outside-period counters, got ${JSON.stringify(periodBrokenMods)}`
  );

  assert(
    chooseCheckInLabelMode(220) === 'full' &&
      chooseCheckInLabelMode(120) === 'compact' &&
      chooseCheckInLabelMode(90) === 'flightOnly',
    `label mode should shrink time text at medium widths before hiding times, got ${chooseCheckInLabelMode(220)} / ${chooseCheckInLabelMode(120)} / ${chooseCheckInLabelMode(90)}`
  );

  const ticks = buildCheckInTimelineTicks('2026-05-08T04:00', '2026-05-08T05:00');
  assert(
    ticks.minor.length === 5 &&
      ticks.major.some((tick) => tick.label === '04:00') &&
      ticks.macro.some((tick) => tick.label.includes('2026-05-08')),
    `timeline ticks should include macro, hour, and 15-minute ticks, got ${JSON.stringify(ticks)}`
  );
  const vjColor = getCheckInColorToken(checkInRecord);
  const vjColorAgain = getCheckInColorToken({ ...checkInRecord, id: 'CHECKIN-VJ999', flightNumber: 'VJ999', rawFlightNumber: '999' });
  const twColor = getCheckInColorToken({ ...checkInRecord, id: 'CHECKIN-TW008', airline: 'TW', flightNumber: 'TW008', rawFlightNumber: '008' });
  const managedVjColor = getCheckInColorToken(checkInRecord, {
    airlineColors: [{ airlineCode: 'VJ', color: '#ED1B24' }],
  });
  const unmanagedZzColor = getCheckInColorToken({ ...checkInRecord, airline: 'ZZ', flightNumber: 'ZZ123', rawFlightNumber: '123' }, {
    airlineColors: [{ airlineCode: 'VJ', color: '#ED1B24' }],
  });
  const unmanagedZzColorAgain = getCheckInColorToken({ ...checkInRecord, airline: 'ZZ', flightNumber: 'ZZ456', rawFlightNumber: '456' }, {
    airlineColors: [{ airlineCode: 'VJ', color: '#ED1B24' }],
  });
  assert(
    vjColor.backgroundColor === vjColorAgain.backgroundColor &&
      vjColor.backgroundColor !== twColor.backgroundColor &&
      vjColor.borderColor !== twColor.borderColor &&
      managedVjColor.backgroundColor === '#ED1B24' &&
      managedVjColor.borderColor === '#ED1B24' &&
      managedVjColor.textColor === '#FFFFFF' &&
      unmanagedZzColor.backgroundColor === unmanagedZzColorAgain.backgroundColor,
    `check-in colors should use managed airline colors when configured and deterministic fallback colors for new airlines, got ${JSON.stringify({ vjColor, vjColorAgain, twColor, managedVjColor, unmanagedZzColor, unmanagedZzColorAgain })}`
  );
  const packedRows = buildCheckInPackedRows([
    {
      record: { ...checkInRecord, id: 'PACK-A', flightNumber: 'VJ801' },
      requiredCounters: 1,
      ruleName: 'Default',
      window: { start: '2026-05-08T05:00', end: '2026-05-08T06:00' },
    },
    {
      record: { ...checkInRecord, id: 'PACK-B', flightNumber: 'VJ802' },
      requiredCounters: 1,
      ruleName: 'Default',
      window: { start: '2026-05-08T05:30', end: '2026-05-08T06:30' },
    },
    {
      record: { ...checkInRecord, id: 'PACK-C', flightNumber: 'VJ803' },
      requiredCounters: 1,
      ruleName: 'Default',
      window: { start: '2026-05-08T06:00', end: '2026-05-08T07:00' },
    },
  ], '2026-05-08T05:00', '2026-05-08T07:00');
  assert(
    packedRows.laneCount === 2 &&
      packedRows.items.find((item) => item.record.id === 'PACK-A')?.laneIndex === 0 &&
      packedRows.items.find((item) => item.record.id === 'PACK-B')?.laneIndex === 1 &&
      packedRows.items.find((item) => item.record.id === 'PACK-C')?.laneIndex === 0,
    `timeline masonry should reuse lanes only when windows do not overlap, got ${JSON.stringify(packedRows)}`
  );
  const projectionBaseRecords = [
    { ...checkInRecord, id: 'PROJECT-A', flightNumber: 'VJ841', rawFlightNumber: '841', counter: [1], checkInStart: '2026-05-08T05:00', checkInEnd: '2026-05-08T07:00' },
    { ...checkInRecord, id: 'PROJECT-B', flightNumber: 'VJ842', rawFlightNumber: '842', counter: [2], checkInStart: '2026-05-08T05:30', checkInEnd: '2026-05-08T07:30' },
  ];
  const projectionFullView = buildCheckInAllocationView({
    records: projectionBaseRecords,
    modifications: new Map(),
    settings: checkInSettings,
    from: '2026-05-08T04:00',
    to: '2026-05-08T08:00',
    roster: [1, 2, 3, 4],
    pixelsPerMinute: 4,
  });
  const singleProjection = buildCheckInRecordProjection({
    recordId: 'PROJECT-B',
    record: projectionBaseRecords[1],
    settings: checkInSettings,
    from: '2026-05-08T04:00',
    to: '2026-05-08T08:00',
    roster: projectionFullView.roster,
    resourceRows: projectionFullView.resourceRows,
    pixelsPerMinute: 4,
  });
  assert(
    JSON.stringify(singleProjection.resourceBars) === JSON.stringify(projectionFullView.resourceBars.filter((bar) => bar.recordId === 'PROJECT-B')) &&
      singleProjection.unallocated.length === 0,
    `single-record projection should match the equivalent slice of the full allocation view, got ${JSON.stringify(singleProjection)}`
  );
  const projectedMoveRecord = { ...projectionBaseRecords[1], counter: [1], checkInStart: '2026-05-08T05:15', checkInEnd: '2026-05-08T07:15' };
  const projectedMove = buildCheckInRecordProjection({
    recordId: 'PROJECT-B',
    record: projectedMoveRecord,
    settings: checkInSettings,
    from: '2026-05-08T04:00',
    to: '2026-05-08T08:00',
    roster: projectionFullView.roster,
    resourceRows: projectionFullView.resourceRows,
    pixelsPerMinute: 4,
  });
  const patchedMoveView = mergeCheckInAllocationViewPatch(projectionFullView, projectedMove);
  const canonicalMoveView = buildCheckInAllocationView({
    records: [projectionBaseRecords[0], projectedMoveRecord],
    modifications: new Map(),
    settings: checkInSettings,
    from: '2026-05-08T04:00',
    to: '2026-05-08T08:00',
    roster: [1, 2, 3, 4],
    pixelsPerMinute: 4,
  });
  assert(
    JSON.stringify(patchedMoveView.resourceBars) === JSON.stringify(canonicalMoveView.resourceBars) &&
      JSON.stringify(patchedMoveView.unallocated) === JSON.stringify(canonicalMoveView.unallocated),
    `merged single-record move patch should match a canonical full rebuild, got ${JSON.stringify(patchedMoveView)}`
  );
  const projectedUnallocate = buildCheckInRecordProjection({
    recordId: 'PROJECT-B',
    record: { ...projectionBaseRecords[1], counter: null, checkInStart: null, checkInEnd: null, checkInAllocationMode: null },
    settings: checkInSettings,
    from: '2026-05-08T04:00',
    to: '2026-05-08T08:00',
    roster: projectionFullView.roster,
    resourceRows: projectionFullView.resourceRows,
    pixelsPerMinute: 4,
  });
  const patchedUnallocateView = mergeCheckInAllocationViewPatch(patchedMoveView, projectedUnallocate);
  assert(
    patchedUnallocateView.resourceBars.every((bar) => bar.recordId !== 'PROJECT-B') &&
      patchedUnallocateView.unallocated.some((item) => item.record.id === 'PROJECT-B'),
    `merged unallocate patch should remove old bars and insert a pool item, got ${JSON.stringify(patchedUnallocateView)}`
  );
  const projectedDelete = buildCheckInRecordProjection({
    recordId: 'PROJECT-B',
    record: null,
    settings: checkInSettings,
    from: '2026-05-08T04:00',
    to: '2026-05-08T08:00',
    roster: projectionFullView.roster,
    resourceRows: projectionFullView.resourceRows,
    pixelsPerMinute: 4,
  });
  const patchedDeleteView = mergeCheckInAllocationViewPatch(patchedUnallocateView, projectedDelete);
  assert(
    patchedDeleteView.resourceBars.every((bar) => bar.recordId !== 'PROJECT-B') &&
      patchedDeleteView.unallocated.every((item) => item.record.id !== 'PROJECT-B'),
    `merged delete patch should remove bars and unallocated pool entries for the record, got ${JSON.stringify(patchedDeleteView)}`
  );
  const pdfSettings = validateOperationalSettings({
    aircraftGroups: [],
    counterAllocationRules: [{
      id: 'pdf-default',
      name: 'PDF default',
      enabled: true,
      priorityScore: 10,
      sortOrder: 1,
      createdAt: 1,
      updatedAt: 1,
      conditions: { aircraftTypes: ['321'], aircraftGroups: [], airlineCodes: [] },
      counterValue: 2,
    }],
    checkInCounters: [
      { id: 'c1', label: '1', enabled: true, sortOrder: 1, createdAt: 1, updatedAt: 1 },
      { id: 'c2', label: '2', enabled: true, sortOrder: 2, createdAt: 1, updatedAt: 1 },
      { id: 'c3', label: '3', enabled: true, sortOrder: 3, createdAt: 1, updatedAt: 1 },
      { id: 'c4', label: '4', enabled: true, sortOrder: 4, createdAt: 1, updatedAt: 1 },
    ],
    checkInCounterGroups: [
      { id: 'island-a', name: 'Island A', bhs: 'A', counterIds: ['c1', 'c2'], sortOrder: 1, createdAt: 1, updatedAt: 1 },
      { id: 'island-b', name: 'Island B', bhs: 'B', counterIds: ['c3', 'c4'], sortOrder: 2, createdAt: 1, updatedAt: 1 },
    ],
    checkInCounterLocks: [],
    updatedAt: 1,
  });
  const pdfView = buildCheckInAllocationView({
    records: [
      { ...checkInRecord, id: 'PDF-A1', flightNumber: 'VJ901', rawFlightNumber: '901', counter: [1], checkInStart: '2026-05-08T04:30', checkInEnd: '2026-05-08T06:00' },
      { ...checkInRecord, id: 'PDF-B1', flightNumber: 'TW902', rawFlightNumber: '902', airline: 'TW', counter: [3], checkInStart: '2026-05-08T05:00', checkInEnd: '2026-05-08T06:30' },
    ],
    modifications: new Map(),
    settings: pdfSettings,
    from: '2026-05-08T04:00',
    to: '2026-05-08T08:00',
    groupByCounterGroup: true,
    pixelsPerMinute: 3,
  });
  const pdfPagePlan = buildCheckInPdfPagePlan({
    view: pdfView,
    maxBodyHeightPx: 52,
    resourceRowHeightPx: 36,
    barHeightPx: 24,
    rowGapPx: 4,
    rowPaddingPx: 12,
  });
  assert(
    pdfView.resourceSections.map((section) => section.name).join('|') === 'Island A|Island B' &&
      pdfPagePlan.length === 2 &&
      pdfPagePlan.every((page) => page.rowIndexes.every((rowIndex) => {
        const section = pdfView.resourceSections.find((item) => item.id === page.sectionId);
        return section && rowIndex >= section.startIndex && rowIndex <= section.endIndex;
      })) &&
      JSON.stringify(pdfPagePlan.map((page) => page.rowIndexes)) === JSON.stringify([[0, 1], [2, 3]]) &&
      pdfPagePlan.every((page) => page.pageInGroup === 1 && page.groupPageCount === 1),
    `PDF page plan should keep each counter group intact on a single page instead of splitting by row count, got ${JSON.stringify(pdfPagePlan)}`
  );
  const pdfScale = calculateCheckInPdfScale({
    sourceWidthPx: 1000,
    sourceHeightPx: 1800,
    pageWidthMm: 297,
    pageHeightMm: 210,
    marginMm: 5,
  });
  assert(
    pdfScale.orientation === 'landscape' &&
      pdfScale.marginMm === 5 &&
      pdfScale.outputWidthMm <= pdfScale.printableWidthMm &&
      pdfScale.outputHeightMm <= pdfScale.printableHeightMm &&
      pdfScale.scaleMode === 'height' &&
      pdfScale.scale < (25.4 / 96),
    `PDF scale should fit tall counter groups onto A4 landscape instead of throwing after heavy rendering, got ${JSON.stringify(pdfScale)}`
  );
  const pdfPreview = buildCheckInPdfPreviewPlan({
    records: [
      { ...checkInRecord, id: 'PDF-A1', flightNumber: 'VJ901', rawFlightNumber: '901', counter: [1], checkInStart: '2026-05-08T04:30', checkInEnd: '2026-05-08T06:00' },
      { ...checkInRecord, id: 'PDF-B1', flightNumber: 'TW902', rawFlightNumber: '902', airline: 'TW', counter: [3], checkInStart: '2026-05-08T05:00', checkInEnd: '2026-05-08T06:30' },
    ],
    modifications: new Map(),
    settings: pdfSettings,
    range: { from: '2026-05-08T04:00', to: '2026-05-08T08:00' },
    selectedGroupIds: ['island-b'],
  });
  assert(
    pdfPreview.availableGroups.map((group) => group.id).join('|') === 'island-a|island-b' &&
      pdfPreview.selectedGroupIds.join('|') === 'island-b' &&
      pdfPreview.pages.length === 1 &&
      pdfPreview.pages[0].sectionId === 'island-b' &&
      pdfPreview.pages[0].pageIndex === 0 &&
      pdfPreview.pages[0].outputWidthMm <= pdfPreview.pages[0].printableWidthMm &&
      pdfPreview.pages[0].outputHeightMm <= pdfPreview.pages[0].printableHeightMm,
    `PDF preview should use selected counter groups and expose final pagination/scale before export, got ${JSON.stringify(pdfPreview.pages)}`
  );
  const pdfBasePreview = buildCheckInPdfPreviewPlan({
      records: [
        { ...checkInRecord, id: 'PDF-A1', flightNumber: 'VJ901', rawFlightNumber: '901', counter: [1], checkInStart: '2026-05-08T04:30', checkInEnd: '2026-05-08T06:00' },
        { ...checkInRecord, id: 'PDF-B1', flightNumber: 'TW902', rawFlightNumber: '902', airline: 'TW', counter: [3], checkInStart: '2026-05-08T05:00', checkInEnd: '2026-05-08T06:30' },
      ],
      modifications: new Map(),
      settings: pdfSettings,
      range: { from: '2026-05-08T04:00', to: '2026-05-08T08:00' },
    });
  const pdfRefilteredPreview = selectCheckInPdfPreviewGroups(pdfBasePreview, ['island-a']);
  assert(
    pdfRefilteredPreview.view === pdfBasePreview.view &&
      pdfRefilteredPreview.selectedGroupIds.join('|') === 'island-a' &&
      pdfRefilteredPreview.pages.length === 1 &&
      pdfRefilteredPreview.pages[0].sectionId === 'island-a',
    `PDF preview group filtering should reuse the base export view and only replace page selection, got ${JSON.stringify(pdfRefilteredPreview.pages)}`
  );
  const pdfWideCounters = Array.from({ length: 27 }, (_, index) => ({
    id: `wide-c${index + 1}`,
    label: String(index + 1),
    enabled: true,
    sortOrder: index + 1,
    createdAt: 1,
    updatedAt: 1,
  }));
  const pdfWidePreview = buildCheckInPdfPreviewPlan({
    records: [
      { ...checkInRecord, id: 'PDF-WIDE-1', flightNumber: 'AK641', rawFlightNumber: '641', counter: [4], checkInStart: '2026-05-09T13:00', checkInEnd: '2026-05-09T15:00' },
      { ...checkInRecord, id: 'PDF-WIDE-2', flightNumber: 'RS512', rawFlightNumber: '512', airline: 'RS', counter: [7], checkInStart: '2026-05-09T21:30', checkInEnd: '2026-05-09T23:30' },
    ],
    modifications: new Map(),
    settings: validateOperationalSettings({
      aircraftGroups: [],
      counterAllocationRules: [],
      checkInCounters: pdfWideCounters,
      checkInCounterGroups: [{
        id: 'ct01',
        name: 'CT01',
        bhs: 'CT01',
        counterIds: pdfWideCounters.map((counter) => counter.id),
        sortOrder: 1,
        createdAt: 1,
        updatedAt: 1,
      }],
      checkInCounterLocks: [],
      updatedAt: 1,
    }),
    range: { from: '2026-05-09T05:00', to: '2026-05-10T05:00' },
    selectedGroupIds: ['ct01'],
  });
  assert(
    pdfWidePreview.pages.length === 1 &&
      pdfWidePreview.pages[0].scaleMode === 'width' &&
      Math.abs(pdfWidePreview.pages[0].outputWidthMm - pdfWidePreview.pages[0].printableWidthMm) < 0.01 &&
      pdfWidePreview.pages[0].outputHeightMm > 175 &&
      pdfWidePreview.pages[0].barFontSizePt >= 5.2,
    `PDF 24-hour preview should fit the printable A4 width without rendering as a shrunken strip, got ${JSON.stringify(pdfWidePreview.pages[0])}`
  );
  assert(
    JSON.stringify([
      buildCheckInPdfBarLabelSegments({ widthPx: 140, startLabel: '04:45', flightNumber: 'VJ827', endLabel: '07:15' }),
      buildCheckInPdfBarLabelSegments({ widthPx: 62, startLabel: '04:45', flightNumber: 'BR384', endLabel: '06:15' }),
      buildCheckInPdfBarLabelSegments({ widthPx: 58, startLabel: '04:45', flightNumber: 'VJ827', endLabel: '07:15' }),
      buildCheckInPdfBarLabelSegments({ widthPx: 18, startLabel: '04:45', flightNumber: 'VJ827', endLabel: '07:15' }),
      chooseCheckInPdfBarText({ widthPx: 58, startLabel: '04:45', flightNumber: 'VJ827', endLabel: '07:15' }),
    ]) === JSON.stringify([
      [
        { role: 'start', text: '04:45', anchor: 'start', align: 'left', fontSizePx: 6 },
        { role: 'flight', text: 'VJ827', anchor: 'center', align: 'center', fontSizePx: 7 },
        { role: 'end', text: '07:15', anchor: 'end', align: 'right', fontSizePx: 6 },
      ],
      [
        { role: 'start', text: '04:45', anchor: 'start', align: 'left', fontSizePx: 6 },
        { role: 'flight', text: 'BR384', anchor: 'center', align: 'center', fontSizePx: 7 },
        { role: 'end', text: '06:15', anchor: 'end', align: 'right', fontSizePx: 6 },
      ],
      [{ role: 'flight', text: 'VJ827', anchor: 'center', align: 'center', fontSizePx: 7 }],
      [],
      'VJ827',
    ]),
    'PDF bar labels should use left open time, centered smaller flight ID, and right close time on real 24-hour export bar widths, then fall back without overlap'
  );
  const edgeScroll = calculateCheckInEdgeScroll({
    pointerX: 295,
    pointerY: 195,
    rect: { left: 0, top: 0, right: 300, bottom: 200 },
    threshold: 40,
    maxSpeed: 24,
  });
  const centeredScroll = calculateCheckInEdgeScroll({
    pointerX: 150,
    pointerY: 100,
    rect: { left: 0, top: 0, right: 300, bottom: 200 },
    threshold: 40,
    maxSpeed: 24,
  });
  assert(
    edgeScroll.x > 0 &&
      edgeScroll.y > 0 &&
      centeredScroll.x === 0 &&
      centeredScroll.y === 0,
    `edge scrolling should accelerate near boundaries and stop in the center, got ${JSON.stringify({ edgeScroll, centeredScroll })}`
  );
  const checkInPageSource = fs.readFileSync(path.join(root, 'src', 'app', 'checkin', 'page.tsx'), 'utf8');
  const checkInWorkerSource = fs.readFileSync(path.join(root, 'src', 'app', 'checkin', 'checkInLocalCommitWorker.ts'), 'utf8');
  const localSeasonStoreSource = fs.readFileSync(path.join(root, 'src', 'lib', 'localSeasonStore.ts'), 'utf8');
  const localSeasonSqlStoreSource = fs.readFileSync(path.join(root, 'src', 'lib', 'localSeasonSqlStore.ts'), 'utf8');
  const nativeRuntimePath = path.join(root, 'src', 'lib', 'nativeRuntime.ts');
  const nativeRuntimeSource = fs.existsSync(nativeRuntimePath) ? fs.readFileSync(nativeRuntimePath, 'utf8') : '';
  const nativeLocalSeasonStorePath = path.join(root, 'src', 'lib', 'nativeLocalSeasonStore.ts');
  const nativeLocalSeasonStoreSource = fs.existsSync(nativeLocalSeasonStorePath)
    ? fs.readFileSync(nativeLocalSeasonStorePath, 'utf8')
    : '';
  const uiUndoMemorySource = fs.existsSync(path.join(root, 'src', 'lib', 'uiUndoMemory.ts'))
    ? fs.readFileSync(path.join(root, 'src', 'lib', 'uiUndoMemory.ts'), 'utf8')
    : '';
  const flightBarDragImageSource = fs.readFileSync(path.join(root, 'src', 'lib', 'flightBarDragImage.ts'), 'utf8');
  assert(
    checkInPageSource.includes('const refreshCheckInWindow = useCallback(async') &&
      checkInPageSource.includes('onNativeRefresh: async () => {') &&
      checkInPageSource.includes('await refreshCheckInWindow();'),
    'Check-in must refresh its native allocation window when workspace changes are delivered on route activation'
  );
  const extractCheckInObjectCalls = (callName) => {
    const blocks = [];
    let searchFrom = 0;
    const marker = `${callName}({`;
    while (true) {
      const markerIndex = checkInPageSource.indexOf(marker, searchFrom);
      if (markerIndex < 0) break;
      const objectStart = markerIndex + callName.length + 1;
      let depth = 0;
      let endIndex = -1;
      for (let index = objectStart; index < checkInPageSource.length; index += 1) {
        const char = checkInPageSource[index];
        if (char === '{') depth += 1;
        if (char === '}') {
          depth -= 1;
          if (depth === 0) {
            endIndex = index + 1;
            break;
          }
        }
      }
      assert(endIndex > objectStart, `could not parse ${callName} source call`);
      blocks.push(checkInPageSource.slice(markerIndex, endIndex));
      searchFrom = endIndex;
    }
    return blocks;
  };
  const assertCheckInMutationContext = (callName, { minCalls = 1, settingsRequired = true } = {}) => {
    const blocks = extractCheckInObjectCalls(callName);
    assert(blocks.length >= minCalls, `expected at least ${minCalls} ${callName} calls, got ${blocks.length}`);
    for (const block of blocks) {
      assert(
        block.includes('resources: allocationResult.view.resourceRows') ||
          block.includes('resources: view.resourceRows'),
        `${callName} live UI calls must pass current allocation resource rows, got ${block}`
      );
      if (settingsRequired) {
        assert(block.includes('settings'), `${callName} live UI calls must pass settings, got ${block}`);
      }
    }
  };
  assert(
    checkInPageSource.includes('handlePoolDrop') &&
      checkInPageSource.includes('unallocateCheckInRecord(record)') &&
      extractCheckInObjectCalls('removeCheckInCounter').some((block) =>
        block.includes('clickedCounter: drag.counter') &&
          (block.includes('resources: allocationResult.view.resourceRows') ||
            block.includes('resources: view.resourceRows'))
      ) &&
      checkInPageSource.includes('onDrop={handlePoolDrop}') &&
      checkInPageSource.includes('setPoolDropActiveIfChanged(true)'),
    'Check-in Allocation must allow dragging allocated bars back to the Unallocated Pool to clear counters locally'
  );
  assert(
    checkInPageSource.includes('groupByCounterGroup') &&
      checkInPageSource.includes('setGroupByCounterGroup') &&
      checkInPageSource.includes("useSessionState('checkin:groupByCounterGroup', true)") &&
      checkInPageSource.includes('Group by island') &&
      /buildCheckInAllocationView\(\{[\s\S]*groupByCounterGroup,/.test(checkInPageSource),
    'Check-in Allocation Gantt must expose Group by island, default it on, and pass groupByCounterGroup into the allocation view'
  );
  assert(
    checkInPageSource.includes('displayAllocationView.resourceSections.map') &&
      checkInPageSource.includes('displayAllocationView.resourceRows.slice') &&
      checkInPageSource.includes('resource.activeLocks.length > 0') &&
      checkInPageSource.includes('resource.label'),
    'Check-in Allocation resource grid must render section-aware resource rows with row lock indicators'
  );
  assert(
    checkInPageSource.includes('dragRowOffset') &&
      checkInPageSource.includes('groupStartIndex') &&
      /dragRowOffset:\s*bar\.counterIndex\s*-\s*groupStartIndex/.test(checkInPageSource),
    'Check-in Allocation allocated drag state must store grouped slice offset metadata for preview alignment'
  );
  assert(
    checkInPageSource.includes('const previewStartRow = Math.max(') &&
      checkInPageSource.includes('hoveredRowIndex - dragRowOffset') &&
      checkInPageSource.includes('scheduleDropPreviewUpdate(dropTarget.previewStartRow)'),
    'Check-in Allocation resource drag-over preview must subtract the stored grouped slice offset before setting activeDropRowIndex'
  );
  assert(
    checkInPageSource.includes('function resolveDropTargetRow') &&
      checkInPageSource.includes('const dropTarget = resolveDropTargetRow(drag, rowIndex, view)') &&
      checkInPageSource.includes('const dropTarget = resolveDropTargetRow(dragStateRef.current, rowIndex, view)') &&
      checkInPageSource.includes('scheduleDropPreviewUpdate(dropTarget.previewStartRow)') &&
      checkInPageSource.includes('handleResourceDrop(event, dropTarget.rowIndex, dropTarget.counter)'),
    'Check-in Allocation preview and drop commit must share the same resolved drop target row/counter'
  );
  assert(
    checkInPageSource.includes('bar.lockConflict') &&
      checkInPageSource.includes('LockConflict') &&
      checkInPageSource.includes('lockConflict.lock.name'),
    'Check-in Allocation bars must render lock conflict styling and expose LockConflict plus lock name in operator tooltip text'
  );
  assertCheckInMutationContext('allocateCheckInCounters');
  assertCheckInMutationContext('moveCheckInAllocation');
  assertCheckInMutationContext('resizeCheckInAllocation');
  assertCheckInMutationContext('reshapeCheckInAllocation');
  assertCheckInMutationContext('addCheckInCounter');
  assertCheckInMutationContext('removeCheckInCounter', { minCalls: 2 });
  assertCheckInMutationContext('overrideCheckInTimes');
  const handleMoveStart = checkInPageSource.indexOf('const handleMove = useCallback(async (');
  const handleMoveEnd = checkInPageSource.indexOf('const handleResizeCommit = useCallback', handleMoveStart + 1);
  const handleMoveBody = handleMoveStart >= 0 && handleMoveEnd > handleMoveStart
    ? checkInPageSource.slice(handleMoveStart, handleMoveEnd)
    : '';
  const handleResizeStart = checkInPageSource.indexOf('const handleResizeCommit = useCallback(async (');
  const handleResizeEnd = checkInPageSource.indexOf('useEffect(() => {', handleResizeStart + 1);
  const handleResizeBody = handleResizeStart >= 0 && handleResizeEnd > handleResizeStart
    ? checkInPageSource.slice(handleResizeStart, handleResizeEnd)
    : '';
  assert(
    handleMoveBody.includes('minuteDelta: 0') &&
      !handleMoveBody.includes('endClientX - drag.startClientX') &&
      !handleMoveBody.includes('/ timelinePixelsPerMinute') &&
      handleResizeBody.includes('minuteDelta: preview.minuteDelta') &&
      checkInPageSource.includes('overrideCheckInTimes({') &&
      checkInPageSource.includes('start: overrideDraft.start') &&
      checkInPageSource.includes('end: overrideDraft.end'),
    'Check-in allocated bar drag/drop must lock the time axis while resize handles and Override Times remain the only UI time-edit paths'
  );
  assert(
    checkInPageSource.includes('counter: state.bar.counter') &&
      checkInPageSource.includes('counter: bar.counter') &&
      checkInPageSource.includes('counter: overrideDraft.counter'),
    'Check-in broken-shape resize and Override Times must pass the clicked counter so edits affect only that counter block'
  );
  assert(
    uiUndoMemorySource.includes('export const MAX_UI_UNDO_ENTRIES = 20') &&
      uiUndoMemorySource.includes('export function trimUiUndoEntries') &&
      uiUndoMemorySource.includes('export function trimUiUndoStack') &&
      uiUndoMemorySource.includes('entries.slice(0, limit)') &&
      uiUndoMemorySource.includes('entries.slice(entries.length - limit)'),
    'UI undo memory must have a shared 20-entry cap for newest-first history lists and push/pop undo stacks'
  );
  assert(
    checkInPageSource.includes("import { trimUiUndoStack } from '@/lib/uiUndoMemory';") &&
      checkInPageSource.includes('checkInUndoStackRef.current = trimUiUndoStack(checkInUndoStackRef.current);') &&
      checkInPageSource.includes("window.addEventListener('pagehide', clearOnPageExit)") &&
      checkInPageSource.includes("window.addEventListener('beforeunload', clearOnPageExit)") &&
      checkInPageSource.includes("window.removeEventListener('pagehide', clearOnPageExit)") &&
      checkInPageSource.includes("window.removeEventListener('beforeunload', clearOnPageExit)"),
    'Check-in volatile undo stack must be capped after pushes and cleared on pagehide/beforeunload'
  );
  assert(
    checkInPageSource.includes('ganttFullscreenRef') &&
      checkInPageSource.includes('isGanttFullscreen') &&
      checkInPageSource.includes('requestFullscreen') &&
      checkInPageSource.includes('exitFullscreen') &&
      checkInPageSource.includes('fullscreenchange') &&
      checkInPageSource.includes("aria-label={isGanttFullscreen ? 'Exit Gantt fullscreen' : 'Enter Gantt fullscreen'}") &&
      checkInPageSource.indexOf('{contextMenu && (') > checkInPageSource.indexOf('ref={ganttFullscreenRef}') &&
      checkInPageSource.indexOf('{overrideDraft && (') > checkInPageSource.indexOf('ref={ganttFullscreenRef}'),
    'Check-in Allocation Gantt fullscreen must target its own wrapper and keep local overlays inside the fullscreen element'
  );
  assert(
    checkInPageSource.includes("['reshape', 'dataset_linked', 'Reshape']") &&
      checkInPageSource.includes("action: 'break' | 'reshape' | 'add' | 'remove' | 'override' | 'unallocate'") &&
      !checkInPageSource.includes("title: 'Unallocate Check-in'") &&
      !checkInPageSource.includes("confirmLabel: 'Unallocate'"),
    'Check-in Allocation context menu must expose Reshape and right-click Unallocate must commit without a confirmation dialog'
  );
  assert(
    checkInPageSource.includes('const DEFAULT_TIMELINE_PIXELS_PER_MINUTE = 1.5') &&
      checkInPageSource.includes('const MIN_TIMELINE_PIXELS_PER_MINUTE = 0.5') &&
      checkInPageSource.includes('const MAX_TIMELINE_PIXELS_PER_MINUTE = 4') &&
      checkInPageSource.includes('const TIMELINE_ZOOM_STEP = 0.25') &&
      checkInPageSource.includes('timelinePixelsPerMinute') &&
      checkInPageSource.includes('handleTimelineZoom') &&
      checkInPageSource.includes('aria-label="Zoom out timeline"') &&
      checkInPageSource.includes('aria-label="Zoom in timeline"') &&
      checkInPageSource.includes('pixelsPerMinute: timelinePixelsPerMinute') &&
      checkInPageSource.includes('buildTimelineWidth(fromDateTime, toDateTime, timelinePixelsPerMinute)') &&
      checkInPageSource.includes('buildCheckInResizePreview({') &&
      checkInPageSource.includes('pixelsPerMinute: timelinePixelsPerMinute') &&
      checkInPageSource.indexOf('aria-label="Zoom in timeline"') < checkInPageSource.indexOf("aria-label={isGanttFullscreen ? 'Exit Gantt fullscreen' : 'Enter Gantt fullscreen'}"),
    'Check-in Allocation Gantt must expose adjacent zoom controls and use the selected x-axis scale for width, drag, resize, and snap-line calculations'
  );
  assert(
    checkInPageSource.includes("bar.labelMode === 'compact'") &&
      checkInPageSource.includes('text-[8px]') &&
      checkInPageSource.includes('left-1') &&
      checkInPageSource.includes('right-1') &&
      checkInPageSource.includes("bar.labelMode === 'flightOnly'"),
    'Check-in Allocation bars must keep open/close times visible with compact smaller text before falling back to flight-only labels'
  );
  assert(
    checkInPageSource.includes('resizeDragGuardRef') &&
      checkInPageSource.includes('startResizeInteraction') &&
      checkInPageSource.includes('resizeDragGuardRef.current = true') &&
      checkInPageSource.includes('anchorX') &&
      checkInPageSource.includes('anchorTime') &&
      checkInPageSource.includes('updateSnapLine(nextResizeState, clientX)') &&
      checkInPageSource.includes('if (resizeDragGuardRef.current || resizeState)') &&
      checkInPageSource.includes('draggable={false}') &&
      checkInPageSource.includes('resizeDragGuardRef.current = false'),
    'Check-in Allocation resize handles must suppress parent drag and show the 1-minute snap crosshair immediately while resizing'
  );
  assert(
    checkInPageSource.includes('snapLineLabel?: string | null') &&
      checkInPageSource.includes('snapLineX?: number | null') &&
      checkInPageSource.includes('buildCheckInResizePreview({') &&
      checkInPageSource.includes('setSnapLineLabelIfChanged(preview.label)') &&
      checkInPageSource.includes('minuteDelta: preview.minuteDelta') &&
      !checkInPageSource.includes('Math.round(snapLineX / timelinePixelsPerMinute)') &&
      checkInPageSource.includes('snapLineX != null && snapLineLabel') &&
      checkInPageSource.includes('style={{ left: snapLineX }}') &&
      checkInPageSource.includes('snapLineX={snapLineX}') &&
      checkInPageSource.includes('snapLineLabel={snapLineLabel}') &&
      checkInPageSource.includes('style={{ left: LABEL_COLUMN_WIDTH + snapLineX }}'),
    'Check-in Allocation resize snap-line time value must render inside the sticky timeline header while the vertical guideline tracks the grid'
  );
  assert(
    checkInPageSource.includes('snapLineAnimationFrameRef') &&
      checkInPageSource.includes('dropPreviewAnimationFrameRef') &&
      checkInPageSource.includes('scheduleSnapLineUpdate') &&
      checkInPageSource.includes('scheduleDropPreviewUpdate') &&
      checkInPageSource.includes('requestAnimationFrame') &&
      checkInPageSource.includes('setActiveDropRowIndexIfChanged'),
    'Check-in Allocation high-frequency drag and resize feedback must be requestAnimationFrame-throttled with no-op state guards'
  );
  const verticalEdgeScrollStart = checkInPageSource.indexOf('const applyVerticalEdgeScroll = useCallback');
  const verticalEdgeScrollEnd = checkInPageSource.indexOf('const updateSnapLine = useCallback', verticalEdgeScrollStart + 1);
  const verticalEdgeScrollBody = verticalEdgeScrollStart >= 0 && verticalEdgeScrollEnd > verticalEdgeScrollStart
    ? checkInPageSource.slice(verticalEdgeScrollStart, verticalEdgeScrollEnd)
    : '';
  assert(
    verticalEdgeScrollBody.includes('container.scrollTop += velocity.y') &&
      !verticalEdgeScrollBody.includes('container.scrollLeft') &&
      checkInPageSource.includes("if (drag?.kind === 'allocated')") &&
      checkInPageSource.includes("if (dragStateRef.current.kind === 'allocated')") &&
      checkInPageSource.includes('applyVerticalEdgeScroll(event.clientX, event.clientY);'),
    'Check-in allocated bar drag-over must use vertical-only edge scrolling so horizontal timeline movement stays locked during reassignment'
  );
  assert(
    checkInPageSource.includes("logCheckInPerformance('buildCheckInAllocationView'") &&
      checkInPageSource.includes("logCheckInPerformance('commitCheckInModifications'"),
    'Check-in Allocation must keep lightweight performance timing around view rebuilds and local commit operations'
  );
  const optimisticApplyIndex = checkInPageSource.indexOf('applyOptimisticCheckInModifications([mod])');
  const scheduledCommitIndex = checkInPageSource.indexOf('scheduleAccumulatedCheckInCommit({');
  assert(
    checkInPageSource.includes('applyOptimisticCheckInModifications') &&
      optimisticApplyIndex >= 0 &&
      scheduledCommitIndex >= 0 &&
      optimisticApplyIndex < scheduledCommitIndex &&
      checkInPageSource.includes('rollbackAccumulatedCheckInCommit') &&
      checkInPageSource.includes('applyOptimisticCheckInModifications(entry.undoEntry.mods)'),
    'Check-in Allocation must update the in-memory modification overlay before scheduling the accumulator commit, then rollback only the failed accumulator group'
  );
  assert(
    checkInPageSource.includes('const CHECKIN_COMMIT_DEBOUNCE_MS = 400') &&
      checkInPageSource.includes('const CHECKIN_SYNC_SUMMARY_DEBOUNCE_MS = 300') &&
      checkInPageSource.includes('checkInCommitAccumulatorRef') &&
      checkInPageSource.includes('checkInCommitFlushTimerRef') &&
      checkInPageSource.includes('pendingCheckInSyncSummaryRef') &&
      checkInPageSource.includes('checkInSyncSummaryTimerRef') &&
      checkInPageSource.includes('mergePendingCheckInCommit') &&
      checkInPageSource.includes('scheduleSyncSummaryUpdate') &&
      checkInPageSource.includes('scheduleCheckInAuditEntry') &&
      checkInPageSource.includes('scheduleAccumulatedCheckInCommit') &&
      checkInPageSource.includes('flushAccumulatedCheckInCommit') &&
      checkInPageSource.includes('window.setTimeout') &&
      checkInPageSource.includes('CHECKIN_COMMIT_DEBOUNCE_MS') &&
      checkInPageSource.includes('legIds') &&
      checkInPageSource.includes('window.clearTimeout(checkInCommitFlushTimerRef.current)') &&
      checkInPageSource.includes('const entry = checkInCommitAccumulatorRef.current') &&
      checkInPageSource.includes('checkInCommitAccumulatorRef.current = null') &&
      checkInPageSource.includes('void flushAccumulatedCheckInCommit(entry)') &&
      checkInPageSource.includes('const auditRecords = entry.legIds.map((legId) => recordById.get(legId)).filter((record): record is FlightRecord => Boolean(record));') &&
      checkInPageSource.includes('beforeRecords: auditRecords') &&
      checkInPageSource.includes('afterRecords: auditRecords') &&
      checkInPageSource.indexOf('const result = await persistCheckInModifications') < checkInPageSource.indexOf('scheduleCheckInAuditEntry(entry, result)') &&
      !checkInPageSource.includes('checkInAccumulatorLegKeyRef') &&
      !checkInPageSource.includes('buildCheckInAccumulatorKey') &&
      !checkInPageSource.includes('collectOverlappingCheckInAccumulatorKeys') &&
      !checkInPageSource.includes('checkInCommitAccumulatorRef.current.set') &&
      !checkInPageSource.includes('window.clearTimeout(overlapping.timerId)') &&
      !checkInPageSource.includes('void appendAuditLogEntry(createFlightActionAuditFromHistory({') &&
      !checkInPageSource.includes('recordLocalModificationCommitIntent') &&
      !checkInPageSource.includes('pendingDebouncedCheckInCommitsRef') &&
      !checkInPageSource.includes('latestCheckInCommitTokenByLegRef') &&
      !checkInPageSource.includes('commitToken'),
    'Check-in Allocation must use one global in-memory accumulator flush, debounce sync-summary state, and defer audit construction after a flushed persistence response'
  );
  assert(
    checkInPageSource.includes("new Worker(new URL('./checkInLocalCommitWorker.ts', import.meta.url), { type: 'module' })") &&
      checkInPageSource.includes('persistCheckInModifications') &&
      checkInPageSource.includes('checkInCommitWorkerRef') &&
      checkInPageSource.includes('checkInCommitRequestsRef') &&
      checkInPageSource.includes('Worker') &&
      checkInPageSource.includes('warmupCheckInCommitWorker') &&
      checkInPageSource.includes('commitCheckInModificationsOnMainThread') &&
      checkInPageSource.includes('scheduleSyncSummaryUpdate(result.syncMeta)') &&
      checkInPageSource.includes('setSyncSummary((current) =>') &&
      !/await persistCheckInModifications\([\s\S]*refreshWorkspaceState\(season\.id, workspace\)[\s\S]*logCheckInPerformance/.test(checkInPageSource),
    'Check-in Allocation successful per-operation persistence must use the local commit worker and update lightweight sync summary without a full workspace refresh'
  );
  assert(
    checkInWorkerSource.includes("type: 'commit'") &&
      checkInWorkerSource.includes("type: 'warmup'") &&
      checkInWorkerSource.includes('requestId') &&
      checkInWorkerSource.includes('let commitChain = Promise.resolve()') &&
      checkInWorkerSource.includes('commitChain = commitChain.then(runCommit, runCommit)') &&
      checkInWorkerSource.includes('applyLocalModificationBatch') &&
      !checkInWorkerSource.includes('loadLocalSeasonWorkspace') &&
      checkInWorkerSource.includes("ok: true") &&
      checkInWorkerSource.includes("ok: false") &&
      checkInWorkerSource.includes('syncMeta') &&
      !checkInWorkerSource.includes('commitToken') &&
      !checkInWorkerSource.includes('applyLocalModificationBatchWithCommitToken'),
    'Check-in local commit worker must warm up without full workspace hydration, serialize commits with a Promise chain, and use standard modification batch persistence'
  );
  assert(
    localSeasonStoreSource.includes('export async function applyLocalModificationBatch') &&
      !localSeasonStoreSource.includes('recordLocalModificationCommitIntent') &&
      !localSeasonStoreSource.includes('applyLocalModificationBatchWithCommitToken') &&
      !localSeasonStoreSource.includes('LocalCommitTokenMap'),
    'Local season store must not expose Check-in commit token persistence after accumulator and serial worker ordering replaces it'
  );
  assert(
    checkInPageSource.includes('handleUnallocateAllInPeriod') &&
      checkInPageSource.includes('buildCheckInPeriodUnallocationModifications') &&
      checkInPageSource.includes('commitCheckInModificationBatch') &&
      checkInPageSource.includes('aria-label="Unallocate all counters in selected period"') &&
      checkInPageSource.includes('disabled={syncing || summary.counterBlocks === 0}'),
    'Check-in Allocation toolbar must expose an Unallocate All action that batch-clears counters in the selected timeline period'
  );
  assert(
    checkInPageSource.includes('latestCheckInModificationsRef') &&
      checkInPageSource.includes('optimisticAllocationView') &&
      checkInPageSource.includes('buildCheckInRecordProjection') &&
      checkInPageSource.includes('mergeCheckInAllocationViewPatch') &&
      checkInPageSource.includes('displayAllocationView') &&
      checkInPageSource.includes('clearOptimisticAllocationView'),
    'Check-in Allocation interactions must use a patched optimistic Gantt view backed by the latest modification ref'
  );
  const allocationResultBody = checkInPageSource.slice(
    checkInPageSource.indexOf('const allocationResult = useMemo'),
    checkInPageSource.indexOf('const displayAllocationView')
  );
  const optimisticApplyBody = checkInPageSource.slice(
    checkInPageSource.indexOf('const applyOptimisticCheckInModifications'),
    checkInPageSource.indexOf('const mergeCheckInUndoEntries')
  );
  const renderResourceBarStart = checkInPageSource.indexOf('const renderResourceBar = useCallback');
  const renderResourceBarEnd = checkInPageSource.indexOf('  return (\n    <div className="flex h-screen', renderResourceBarStart + 1);
  const renderResourceBarBody = renderResourceBarStart >= 0 && renderResourceBarEnd > renderResourceBarStart
    ? checkInPageSource.slice(renderResourceBarStart, renderResourceBarEnd)
    : '';
  const checkInWorkerCommitStart = checkInWorkerSource.indexOf('async function commitCheckInModifications');
  const checkInWorkerCommitEnd = checkInWorkerSource.indexOf('async function warmupCheckInCommitWorker');
  const checkInWorkerCommitBody = checkInWorkerCommitStart >= 0 && checkInWorkerCommitEnd > checkInWorkerCommitStart
    ? checkInWorkerSource.slice(checkInWorkerCommitStart, checkInWorkerCommitEnd)
    : '';
  const localDeltaCommitStart = localSeasonStoreSource.indexOf('export async function applyLocalModificationBatchDelta');
  const localDeltaCommitEnd = localSeasonStoreSource.indexOf('export async function applyLocalFlightRecordMutation', localDeltaCommitStart + 1);
  const localDeltaCommitBody = localDeltaCommitStart >= 0 && localDeltaCommitEnd > localDeltaCommitStart
    ? localSeasonStoreSource.slice(localDeltaCommitStart, localDeltaCommitEnd)
    : '';
  const checkInDeltaAssertions = {
    hasFunction: typeof applyLocalModificationBatchDelta === 'function',
    workerUsesDelta: checkInWorkerSource.includes('applyLocalModificationBatchDelta'),
    workerAvoidsLoad: !checkInWorkerCommitBody.includes('loadLocalSeasonWorkspace'),
    workerAvoidsFullBatch: !checkInWorkerCommitBody.includes('applyLocalModificationBatch('),
    readsSqlDelta: localDeltaCommitBody.includes('readLocalSeasonSqlDeltaState(sqlDb, seasonId, affectedLegIds)'),
    replacesSqlPending: localDeltaCommitBody.includes('replaceLocalSeasonSqlPendingState('),
    keepsAffectedMods: localDeltaCommitBody.includes('affectedModifications'),
    avoidsFullSave: !localDeltaCommitBody.includes('saveLocalSeasonWorkspace('),
  };
  assert(
    Object.values(checkInDeltaAssertions).every(Boolean),
    `Check-in local commit worker must use a delta-only SQLite modification commit instead of hydrating and rewriting the full season workspace after the debounce, got ${JSON.stringify(checkInDeltaAssertions)}`
  );
  assert(
    nativeRuntimeSource.includes('function getTauriGlobal') &&
      nativeRuntimeSource.includes('globalThis as') &&
      !localSeasonSqlStoreSource.includes("'__TAURI_INTERNALS__' in window") &&
      !localSeasonSqlStoreSource.includes("'__TAURI__' in window") &&
      checkInWorkerSource.includes('applyLocalModificationBatchDelta') &&
      !checkInWorkerSource.includes('loadLocalSeasonWorkspace') &&
      nativeLocalSeasonStoreSource.includes('runNativeLocalModificationBatchDelta') &&
      nativeLocalSeasonStoreSource.includes("invoke<NativeLocalModificationBatchDeltaResult>('apply_local_modification_batch_delta'") &&
      checkInPageSource.includes('runNativeLocalModificationBatchDelta') &&
      checkInPageSource.includes('const nativeResult = await runNativeLocalModificationBatchDelta') &&
      checkInPageSource.includes("source: 'checkin-native'"),
    'Check-in allocation native/Tauri commits must avoid worker-only window crashes and route desktop persistence through native row-level SQLite delta writes'
  );
  const checkInMainThreadCommitStart = checkInPageSource.indexOf('const commitCheckInModificationsOnMainThread');
  const checkInMainThreadCommitEnd = checkInPageSource.indexOf('const getCheckInCommitWorker', checkInMainThreadCommitStart + 1);
  const checkInMainThreadCommitBody = checkInMainThreadCommitStart >= 0 && checkInMainThreadCommitEnd > checkInMainThreadCommitStart
    ? checkInPageSource.slice(checkInMainThreadCommitStart, checkInMainThreadCommitEnd)
    : '';
  assert(
    checkInMainThreadCommitBody.includes('applyLocalModificationBatchDelta(seasonId, mods, {') &&
      !checkInMainThreadCommitBody.includes('loadLocalSeasonWorkspace') &&
      !checkInMainThreadCommitBody.includes('applyLocalModificationBatch(') &&
      checkInMainThreadCommitBody.includes("source: 'checkin'"),
    'Check-in main-thread fallback commit must use delta-only local persistence when the worker is unavailable'
  );
  const pendingSummaryStart = localSeasonStoreSource.indexOf('export async function getPendingSyncSummary');
  const pendingSummaryEnd = localSeasonStoreSource.indexOf('export async function updateLocalSyncMeta', pendingSummaryStart + 1);
  const pendingSummaryBody = pendingSummaryStart >= 0 && pendingSummaryEnd > pendingSummaryStart
    ? localSeasonStoreSource.slice(pendingSummaryStart, pendingSummaryEnd)
    : '';
  assert(
    pendingSummaryBody.includes('readLocalSeasonSqlSyncMeta(sqlDb, seasonId)') &&
      pendingSummaryBody.includes('getOptionalSqlDbForLocalStore()') &&
      pendingSummaryBody.includes('loadLocalSeasonWorkspace') &&
      pendingSummaryBody.indexOf('readLocalSeasonSqlSyncMeta(sqlDb, seasonId)') < pendingSummaryBody.indexOf('loadLocalSeasonWorkspace'),
    'Check-in local workspace change notifications must read pending sync summary from SQLite syncMeta before falling back to full workspace hydration'
  );
  assert(
    allocationResultBody.includes('modifications,') &&
      checkInPageSource.includes('promoteLatestCheckInModificationsForView') &&
      checkInPageSource.includes('const latestModifications = new Map(latestCheckInModificationsRef.current)') &&
      checkInPageSource.includes('promoteLatestCheckInModificationsForView();') &&
      optimisticApplyBody.includes('const workingModifications = latestCheckInModificationsRef.current') &&
      optimisticApplyBody.includes('workingModifications.set(mod.legId') &&
      optimisticApplyBody.includes('setOptimisticAllocationView(patchedView)') &&
      !optimisticApplyBody.includes('new Map(latestCheckInModificationsRef.current)') &&
      !optimisticApplyBody.includes('replaceCheckInModifications(workingModifications, { render: false })') &&
      !checkInPageSource.includes('pendingCanonicalModificationsRef') &&
      !checkInPageSource.includes('scheduleCanonicalCheckInModificationsCommit') &&
      !checkInPageSource.includes('CANONICAL_REBUILD_DEBOUNCE_MS') &&
      !optimisticApplyBody.includes('requestIdleCallback') &&
      !optimisticApplyBody.includes('setModifications(next'),
    'Check-in Allocation drag/drop/resize commits must not schedule a delayed full allocation-view rebuild; the next view-input change should rebuild from the latest modification ref'
  );
  assert(
    checkInPageSource.includes('const groupedBarMetadataByRecordId = useMemo') &&
      checkInPageSource.includes('new Map<string, CheckInGroupedBarMetadata>()') &&
      checkInPageSource.includes('for (const bar of displayAllocationView?.resourceBars ?? [])') &&
      checkInPageSource.includes('groupedSpan: existing.groupedSpan + 1') &&
      checkInPageSource.includes('groupStartIndex: Math.min(existing.groupStartIndex, bar.counterIndex)') &&
      checkInPageSource.includes('const CheckInResourceBarButton = memo(function CheckInResourceBarButton') &&
      checkInPageSource.includes('function areCheckInResourceBarButtonPropsEqual') &&
      renderResourceBarBody.includes('<CheckInResourceBarButton') &&
      renderResourceBarBody.includes('groupedBarMetadataByRecordId.get(bar.recordId)') &&
      !renderResourceBarBody.includes('resourceBars.filter') &&
      !renderResourceBarBody.includes('groupedBars.map'),
    'Check-in resource bar rendering must use memoized grouped metadata and avoid per-bar resourceBars scans during rapid drag/drop'
  );
  assert(
    checkInPageSource.includes('function TimelineGridBackground') &&
      checkInPageSource.includes('backgroundImage') &&
      checkInPageSource.includes('backgroundSize') &&
      !checkInPageSource.includes('<TimelineGridLines ticks={timeline.ticks} />\n                                  {bars.map(renderResourceBar)}'),
    'Check-in Allocation resource rows must use a CSS timeline grid background instead of per-row TimelineGridLines DOM spans'
  );
  assert(
    checkInPageSource.includes('translate3d(${left}px') &&
      checkInPageSource.includes('transition-[transform,width,box-shadow,background-color,border-color]') &&
      checkInPageSource.includes('left: 0,') &&
      checkInPageSource.includes('top: 0,'),
    'Check-in Allocation bars must animate movement with transform instead of left/top transitions'
  );
  assert(
    checkInPageSource.includes('rounded-[4px]') &&
      checkInPageSource.includes('border border-white') &&
      checkInPageSource.includes("const isBrokenShape = bar.mode === 'broken'") &&
      checkInPageSource.includes("border: isBrokenShape ? '1px dashed #FFFFFF' : '1px solid #FFFFFF'") &&
      !checkInPageSource.includes('dark:border-[#1E1E1E]') &&
      !checkInPageSource.includes('borderColor: color.borderColor'),
    'Check-in Allocation broken live Gantt bars must use a dashed neutral white separator border while other bars keep the solid 1px white separator'
  );
  const checkInUnallocatedBarBody = checkInPageSource.slice(
    checkInPageSource.indexOf('const renderUnallocatedBar = (item: CheckInPackedItem)'),
    checkInPageSource.indexOf('const renderResourceBar = useCallback')
  );
  const checkInResourceBarBody = checkInPageSource.slice(
    checkInPageSource.indexOf('const CheckInResourceBarButton = memo(function CheckInResourceBarButton'),
    checkInPageSource.indexOf('}, areCheckInResourceBarButtonPropsEqual);')
  );
  assert(
    checkInUnallocatedBarBody.includes("border: '1px solid #FFFFFF'") &&
      checkInResourceBarBody.includes("border: isBrokenShape ? '1px dashed #FFFFFF' : '1px solid #FFFFFF'") &&
      [checkInUnallocatedBarBody, checkInResourceBarBody].every((body) =>
        body.includes('borderRadius: 4') &&
        body.includes('background: color.backgroundColor') &&
        body.includes("backgroundImage: 'none'") &&
        body.includes('opacity: 1') &&
        body.includes('backgroundColor: color.backgroundColor') &&
        !body.includes('dark:border-[#1E1E1E]') &&
        !body.includes('borderStyle:') &&
        !body.includes('opacity-60')
      ),
    'Check-in Allocation flight bars must render as fully opaque solid fills with no feathered fade, no dark border override, and a 1px solid #FFFFFF frame'
  );
  assert(
    flightBarDragImageSource.includes('export function setSolidFlightBarDragImage') &&
      flightBarDragImageSource.includes('event.dataTransfer.setDragImage') &&
      flightBarDragImageSource.includes("ctx.fillStyle = backgroundColor") &&
      flightBarDragImageSource.includes("ctx.strokeStyle = '#FFFFFF'") &&
      flightBarDragImageSource.includes('ctx.lineWidth = 1') &&
      flightBarDragImageSource.includes('const radius = 4') &&
      flightBarDragImageSource.includes('canvas.style.opacity = \'1\'') &&
      checkInPageSource.includes("import { setSolidFlightBarDragImage } from '@/lib/flightBarDragImage'") &&
      checkInPageSource.match(/setSolidFlightBarDragImage\(/g)?.length >= 2,
    'Check-in Allocation drag must use a custom fully opaque solid flight-bar drag image instead of the browser default feathered ghost'
  );
  assert(
    checkInPageSource.includes('getResourceRowStripeClass') &&
      checkInPageSource.includes('rowIndex % 2 === 0') &&
      checkInPageSource.includes('bg-surface-container-lowest') &&
      checkInPageSource.includes('bg-surface-container-low/60') &&
      checkInPageSource.includes('rowStripeClass') &&
      checkInPageSource.includes('labelStripeClass'),
    'Check-in Allocation resource grid must render gentle zebra striping across odd and even counter rows'
  );
  assert(
    checkInPageSource.includes('checkInUndoStackRef') &&
      checkInPageSource.includes('buildCheckInUndoModification') &&
      checkInPageSource.includes('handleUndoCheckInAllocation') &&
      checkInPageSource.includes('trackUndo?: boolean') &&
      checkInPageSource.includes("event.key.toLowerCase() === 'z'") &&
      checkInPageSource.includes('event.ctrlKey || event.metaKey') &&
      checkInPageSource.includes('event.preventDefault()') &&
      checkInPageSource.includes('commitCheckInModificationBatch(entry.mods'),
    'Check-in Allocation must support Ctrl+Z undo for the latest local allocation operation through the normal commit path'
  );
  const checkInPdfExportSource = fs.readFileSync(path.join(root, 'src', 'lib', 'checkinPdfExport.ts'), 'utf8');
  const readPdfNumericConst = (name) => {
    const match = checkInPdfExportSource.match(new RegExp(`const ${name} = (\\d+)`));
    return match ? Number(match[1]) : Number.NaN;
  };
  const pdfBarHeightPx = readPdfNumericConst('PDF_BAR_HEIGHT_PX');
  const pdfBarFontSizePx = readPdfNumericConst('PDF_BAR_FONT_SIZE_PX');
  const pdfBarTimeFontSizePx = readPdfNumericConst('PDF_BAR_TIME_FONT_SIZE_PX');
  assert(
    Number.isFinite(pdfBarHeightPx) &&
      Number.isFinite(pdfBarFontSizePx) &&
      Number.isFinite(pdfBarTimeFontSizePx) &&
      pdfBarFontSizePx === 7 &&
      pdfBarTimeFontSizePx === 6 &&
      pdfBarHeightPx >= pdfBarFontSizePx + 6,
    `Check-in PDF bar text must use compact 7px flight labels and 6px edge time labels without cropping, got bar ${pdfBarHeightPx}px, flight ${pdfBarFontSizePx}px, time ${pdfBarTimeFontSizePx}px`
  );
  assert(
    !checkInPdfExportSource.includes("padding: '6px 8px'") &&
      !checkInPdfExportSource.includes("padding: '7px 8px'"),
    'Check-in PDF fixed-height text cells must not use vertical padding that can crop html2canvas text'
  );
  assert(
    !checkInPdfExportSource.includes('Resource Grid') &&
      !checkInPdfExportSource.includes('resourceRows.length} counters') &&
      !checkInPdfExportSource.includes('PDF_RESOURCE_HEADER_HEIGHT_PX'),
    'Check-in PDF export must omit the Resource Grid counter summary row to keep page content focused and reduce vertical pressure'
  );
  assert(
    checkInPdfExportSource.includes('drawCheckInPdfBarLabels') &&
      checkInPdfExportSource.includes('pdf.text(') &&
      checkInPdfExportSource.includes('buildCheckInPdfBarLabelSegments') &&
      checkInPdfExportSource.includes('showBarLabels: false') &&
      checkInPdfExportSource.includes('if (showLabel && labelSegments.length > 0)') &&
      checkInPdfExportSource.includes('align: overlay.align'),
    'Check-in PDF export must draw segmented flight and edge-time labels as native jsPDF text overlays instead of relying on clipped html2canvas bar text'
  );
  assert(
    !checkInPdfExportSource.includes('applyGridBackground(timelineCell') &&
      !checkInPdfExportSource.includes('function applyGridBackground') &&
      !checkInPdfExportSource.includes('buildGridBackground') &&
      checkInPdfExportSource.includes('context.timelineTicks.major') &&
      !checkInPdfExportSource.includes('context.timelineTicks.minor'),
    'Check-in PDF export must remove body/minor grid lines while keeping header hour markers'
  );
  assert(
    checkInPdfExportSource.includes("borderRadius: '4px'") &&
      checkInPdfExportSource.includes("border: '1px solid #FFFFFF'") &&
      !checkInPdfExportSource.includes("border: `1px ${bar.mode === 'broken' ? 'dashed' : 'solid'} #FFFFFF`") &&
      !checkInPdfExportSource.includes("bar.mode === 'broken' ? 'dashed'") &&
      !checkInPdfExportSource.includes('${color.borderColor}`'),
    'Check-in PDF export bars must keep a solid neutral 1px separator border and must not show the live broken-shape dashed cue'
  );
  assert(
    !checkInPdfExportSource.includes('window.print') &&
      !checkInPdfExportSource.includes('@media print') &&
      !checkInPageSource.includes('window.print'),
    'Check-in PDF export must not use native browser print or print CSS'
  );
  assert(
    checkInPdfExportSource.includes("import('html2canvas')") &&
      checkInPdfExportSource.includes("import('jspdf')") &&
      checkInPdfExportSource.includes('new jsPDF({') &&
      checkInPdfExportSource.includes("orientation: 'landscape'") &&
      checkInPdfExportSource.includes("format: 'a4'"),
    'Check-in PDF export must use html2canvas and jsPDF with A4 landscape output'
  );
  assert(
    checkInPdfExportSource.includes('compress: true') &&
      checkInPdfExportSource.includes('const PDF_CANVAS_SCALE = 1.5') &&
      checkInPdfExportSource.includes("const PDF_EXPORT_IMAGE_MIME_TYPE = 'image/jpeg'") &&
      checkInPdfExportSource.includes('const PDF_EXPORT_IMAGE_QUALITY = 0.82') &&
      checkInPdfExportSource.includes('scale: PDF_CANVAS_SCALE') &&
      checkInPdfExportSource.includes('canvas.toDataURL(PDF_EXPORT_IMAGE_MIME_TYPE, PDF_EXPORT_IMAGE_QUALITY)') &&
      checkInPdfExportSource.includes("'JPEG'") &&
      !checkInPdfExportSource.includes('compress: false') &&
      !checkInPdfExportSource.includes('scale: 2') &&
      !checkInPdfExportSource.includes("toDataURL('image/png')"),
    'Check-in PDF export must use compressed JPEG page images at a lower canvas scale to keep exported files small'
  );
  assert(
    checkInPdfExportSource.includes('groupByCounterGroup: true') &&
      checkInPdfExportSource.includes('buildCheckInAllocationView') &&
      checkInPdfExportSource.includes('buildCheckInPdfPagePlan') &&
      checkInPdfExportSource.includes('export function renderCheckInPdfPageElement') &&
      checkInPdfExportSource.includes('calculateCheckInPdfScale') &&
      checkInPdfExportSource.includes('page.groupPageCount') &&
      checkInPdfExportSource.includes('html2canvas(pageElement'),
    'Check-in PDF export helper must build a grouped export view, page by counter group, and render virtual pages to canvas'
  );
  assert(
    checkInPageSource.includes('Export PDF') &&
      checkInPageSource.includes('exportDraft') &&
      checkInPageSource.includes('selectedGroupIds') &&
      checkInPageSource.includes('exportPreview') &&
      checkInPageSource.includes('buildCheckInPdfPreviewPlan') &&
      checkInPageSource.includes('selectCheckInPdfPreviewGroups') &&
      checkInPageSource.includes('useDeferredValue') &&
      checkInPageSource.includes('scheduleRenderPreviewPages') &&
      checkInPageSource.includes('renderCheckInPdfPageElement') &&
      checkInPageSource.includes('previewPageRefs') &&
      checkInPageSource.includes('ResizeObserver') &&
      checkInPageSource.includes('lg:grid-cols-[minmax(360px,380px)_minmax(0,1fr)]') &&
      checkInPageSource.includes('w-full min-w-0') &&
      checkInPageSource.includes('PDF Preview') &&
      checkInPageSource.includes('handleOpenExportDialog') &&
      checkInPageSource.includes('handleExportCheckInPdf') &&
      checkInPageSource.includes('exportCheckInAllocationPdf') &&
      checkInPageSource.includes('CheckIn_Allocation_') &&
      checkInPageSource.includes('Export PDF Failed') &&
      checkInPageSource.includes('type="datetime-local"'),
    'Check-in page must expose an Export PDF configuration modal with datetime fields, counter-group selection, WYSIWYG preview, loading state, and error handling'
  );
  const settingsPageSource = fs.readFileSync(path.join(root, 'src', 'app', 'settings', 'page.tsx'), 'utf8');
  const settingsComponentsDir = path.join(root, 'src', 'app', 'settings', 'components');
  const settingsComponentSources = fs.existsSync(settingsComponentsDir)
    ? Object.fromEntries(
        walkFiles(settingsComponentsDir, (filePath) => filePath.endsWith('.tsx')).map((filePath) => [
          path.basename(filePath),
          fs.readFileSync(filePath, 'utf8'),
        ])
      )
    : {};
  const settingsUiSource = [settingsPageSource, ...Object.values(settingsComponentSources)].join('\n');
  const gateSettingsTabButtonSource = settingsPageSource;
  const gateSettingsSectionSource = settingsComponentSources['GatesTab.tsx'] ?? settingsPageSource.slice(
    settingsPageSource.indexOf("{activeTab === 'gateAllocation' && ("),
    settingsPageSource.indexOf("{activeTab === 'airlineColors' && (")
  );
  const counterSettingsSectionSource = settingsComponentSources['CheckInCountersTab.tsx'] ?? settingsPageSource.slice(
    settingsPageSource.indexOf("{activeTab === 'checkinCounters' && ("),
    settingsPageSource.indexOf("{activeTab === 'gateAllocation' && (")
  );
  const locksOutagesSectionSource = settingsComponentSources['LocksAndOutagesTab.tsx'] ?? '';
  assert(
    checkInPageSource.includes('getCheckInColorToken(item.record, settings)') &&
      checkInPageSource.includes('getCheckInColorToken(record ?? { airline: bar.flightNumber.slice(0, 2), flightNumber: bar.flightNumber, rawFlightNumber: bar.flightNumber }, settings)') &&
      checkInPdfExportSource.includes('getCheckInColorToken(record ?? {') &&
      checkInPdfExportSource.includes('preview.settings') &&
      checkInPdfExportSource.includes('getCheckInColorToken(recordById.get(bar.recordId) ?? {'),
    'Check-in allocation and PDF export must resolve bar colors from OperationalSettings airline color overrides'
  );
  assert(
    settingsPageSource.includes("'airlineColors'") &&
      settingsUiSource.includes('Airline Colors') &&
      settingsUiSource.includes('type=\"color\"') &&
      settingsUiSource.includes('airlineColors') &&
      settingsUiSource.includes('addAirlineColor') &&
      settingsUiSource.includes('updateAirlineColor') &&
      settingsUiSource.includes('deleteAirlineColor'),
    'Settings page must expose an Airline Colors tab with color inputs for managing per-airline colors'
  );
  assert(
    settingsPageSource.includes("'routeCountries'") &&
      settingsPageSource.includes("'routeCountries'") &&
      settingsUiSource.includes('Route-Country') &&
      settingsUiSource.includes('routeCountrySearch') &&
      settingsUiSource.includes('addOrUpdateRouteCountry') &&
      settingsUiSource.includes('updateRouteCountry') &&
      settingsUiSource.includes('deleteRouteCountry') &&
      settingsUiSource.includes('handleRouteCountryImport') &&
      settingsUiSource.includes('accept=".xls,.xlsx"') &&
      settingsPageSource.includes('parseRouteCountryRows') &&
      settingsPageSource.includes('mergeRouteCountryMappings') &&
      settingsUiSource.includes('Update From Excel') &&
      settingsUiSource.includes('Update Route-Country Map') &&
      !settingsUiSource.includes('Replace From Excel') &&
      !settingsUiSource.includes('Replace Route-Country Map') &&
      settingsPageSource.includes('routeCountries'),
    'Settings page must expose a Route-Country tab for editing the dashboard route-country map and updating it from Excel without full replacement'
  );
  assert(
    settingsPageSource.includes("'locksAndOutages'") &&
      settingsPageSource.includes("'locksAndOutages'") &&
      settingsPageSource.includes('Locks / Outages') &&
      locksOutagesSectionSource.includes('Counter Locks') &&
      locksOutagesSectionSource.includes('Gate Locks') &&
      locksOutagesSectionSource.includes('addCheckInCounterLock') &&
      locksOutagesSectionSource.includes('addGateLock') &&
      locksOutagesSectionSource.includes('toggleCheckInCounterLockCounter(lock, counter.id)') &&
      locksOutagesSectionSource.includes('toggleGateLockGate(lock, gate.id)') &&
      !counterSettingsSectionSource.includes('Add Counter Lock') &&
      !counterSettingsSectionSource.includes('Delete Counter Lock') &&
      !gateSettingsSectionSource.includes('Add Gate Lock') &&
      !gateSettingsSectionSource.includes('Delete Gate Lock'),
    'Settings route must expose counter and gate lock controls in a dedicated Locks / Outages tab instead of burying them in resource tabs'
  );
  assert(
    settingsPageSource.includes("'gateAllocation'") &&
      gateSettingsTabButtonSource.includes('Gate') &&
      !gateSettingsTabButtonSource.includes('Gate Allocation') &&
      gateSettingsSectionSource.includes('Gate Inventory') &&
      gateSettingsSectionSource.includes('Gate Groups') &&
      gateSettingsSectionSource.includes('Stand Mapping Table') &&
      gateSettingsSectionSource.includes('Add Stand Mapping') &&
      gateSettingsSectionSource.includes('Add Gate') &&
      gateSettingsSectionSource.includes('addGateResource') &&
      gateSettingsSectionSource.includes('deleteGateResource') &&
      gateSettingsSectionSource.includes('Delete Gate') &&
      gateSettingsSectionSource.includes('{gateResources.length} gates configured') &&
      gateSettingsSectionSource.includes('Gate inventory table') &&
      gateSettingsSectionSource.includes('data-testid="gate-inventory-groups-stack"') &&
      gateSettingsSectionSource.includes('className="space-y-5"') &&
      gateSettingsSectionSource.includes('w-full overflow-hidden rounded-lg border border-surface-variant bg-surface-container-lowest shadow-sm') &&
      gateSettingsSectionSource.includes('w-full rounded-lg border border-surface-variant bg-surface-container-lowest shadow-sm') &&
      gateSettingsSectionSource.includes('sm:grid-cols-[minmax(80px,1fr)_90px_120px_120px]') &&
      gateSettingsSectionSource.includes('Action') &&
      gateSettingsSectionSource.includes('Disabled') &&
      gateSettingsSectionSource.includes('Add Group') &&
      gateSettingsSectionSource.includes('addGateGroup') &&
      settingsPageSource.indexOf("'gateAllocation'") < settingsPageSource.indexOf("'locksAndOutages'"),
    'Settings Gate tab must be titled Gate and expose add-gate/add-group controls before the dedicated lock tab'
  );
  const gatePageSource = fs.readFileSync(path.join(root, 'src', 'app', 'gate', 'page.tsx'), 'utf8');
  const gatePdfExportSource = fs.readFileSync(path.join(root, 'src', 'lib', 'gatePdfExport.ts'), 'utf8');
  const gateWorkerSource = fs.existsSync(path.join(root, 'src', 'app', 'gate', 'gateLocalCommitWorker.ts'))
    ? fs.readFileSync(path.join(root, 'src', 'app', 'gate', 'gateLocalCommitWorker.ts'), 'utf8')
    : '';
  const dailyPageSourceForGate = fs.readFileSync(path.join(root, 'src', 'app', 'daily', 'page.tsx'), 'utf8');
  const gateCommitBody = gatePageSource.slice(
    gatePageSource.indexOf('const commitGateModification = useCallback'),
    gatePageSource.indexOf('const clearGateDragState')
  );
  const gatePointerMoveBody = gatePageSource.slice(
    gatePageSource.indexOf('const handleGatePointerMove = useCallback'),
    gatePageSource.indexOf('const handleGatePointerUp = useCallback')
  );
  const gatePointerUpBody = gatePageSource.slice(
    gatePageSource.indexOf('const handleGatePointerUp = useCallback'),
    gatePageSource.indexOf('const dragOverlay = pointerDragState')
  );
  const gateOptimisticBody = gatePageSource.slice(
    gatePageSource.indexOf('const applyOptimisticGateModification = useCallback'),
    gatePageSource.indexOf('const refreshGateWorkspaceState')
  );
  const gateWorkerCommitStart = gateWorkerSource.indexOf('async function commitGateModifications');
  const gateWorkerCommitEnd = gateWorkerSource.indexOf('workerScope.onmessage', gateWorkerCommitStart + 1);
  const gateWorkerCommitBody = gateWorkerCommitStart >= 0 && gateWorkerCommitEnd > gateWorkerCommitStart
    ? gateWorkerSource.slice(gateWorkerCommitStart, gateWorkerCommitEnd)
    : '';
  const gateMainThreadCommitBody = gatePageSource.slice(
    gatePageSource.indexOf('const commitGateModificationsOnMainThread = useCallback'),
    gatePageSource.indexOf('const getGateCommitWorker')
  );
  const gatePersistBody = gatePageSource.slice(
    gatePageSource.indexOf('const persistGateModifications = useCallback'),
    gatePageSource.indexOf('const scheduleGateSyncSummaryUpdate')
  );
  const gateFlushBody = gatePageSource.slice(
    gatePageSource.indexOf('const flushAccumulatedGateCommit = useCallback'),
    gatePageSource.indexOf('const scheduleAccumulatedGateCommit = useCallback')
  );
  assert(
    gatePageSource.includes('Gate Allocation') &&
      gatePageSource.includes('buildGateAllocationView') &&
      gatePageSource.includes('Gate Gantt') &&
      gatePageSource.includes('Resource Grid') &&
      gatePageSource.includes('<PbbIcon') &&
      !gatePageSource.includes('door_front') &&
      gatePageSource.includes('buildGatePackedRows') &&
      gatePageSource.includes('renderUnallocatedBar') &&
      gatePageSource.includes('timelinePixelsPerMinute') &&
      gatePageSource.includes('handleTimelineZoom') &&
      gatePageSource.includes('aria-label="Zoom out timeline"') &&
      gatePageSource.includes('aria-label="Zoom in timeline"') &&
      gatePageSource.includes("aria-label={isGanttFullscreen ? 'Exit Gantt fullscreen' : 'Enter Gantt fullscreen'}") &&
      gatePageSource.includes('allocateGate') &&
      gatePageSource.includes('unallocateGate') &&
      gatePageSource.includes('pointerDragState') &&
      gatePageSource.includes('dragOverlay') &&
      gatePageSource.includes('handleGatePointerDown') &&
      gatePageSource.includes('handleGatePointerMove') &&
      gatePageSource.includes('handleGatePointerUp') &&
      gatePageSource.includes('resolveGatePointerDrop') &&
      gatePageSource.includes('onPointerDown={(event) => handleGatePointerDown(event,') &&
      gatePageSource.includes('onPointerMove={handleGatePointerMove}') &&
      gatePageSource.includes('onPointerUp={handleGatePointerUp}') &&
      !gatePageSource.includes('draggable={!syncing}') &&
      !gatePageSource.includes('dataTransfer') &&
      gatePageSource.includes('commitGateModification') &&
      gatePageSource.includes('allocateGate(record, resource.gate)') &&
      gatePageSource.includes('unallocateGate(record)') &&
      gatePageSource.includes('applyOptimisticGateModification') &&
      gatePageSource.includes('optimisticGateAllocationView') &&
      gatePageSource.includes('buildGateRecordProjection') &&
      gatePageSource.includes('mergeGateAllocationViewPatch') &&
      gateOptimisticBody.includes('const workingModifications = latestGateModificationsRef.current') &&
      gateOptimisticBody.includes('workingModifications.set(mergedMod.legId, mergedMod)') &&
      !gateOptimisticBody.includes('new Map(latestGateModificationsRef.current)') &&
      !gateOptimisticBody.includes('replaceGateModifications(workingModifications, { render: false })') &&
      gatePageSource.includes('handleUnallocateAllGatesInPeriod') &&
      gatePageSource.includes('commitGateModificationBatch') &&
      gatePageSource.includes('aria-label="Unallocate all gates in selected period"') &&
      gatePageSource.includes('disabled={syncing || summary.gateBlocks === 0}') &&
      gatePageSource.includes('Export PDF') &&
      gatePageSource.includes('exportDraft') &&
      gatePageSource.includes('selectedGroupIds') &&
      gatePageSource.includes('exportPreview') &&
      gatePageSource.includes('buildGatePdfPreviewPlan') &&
      gatePageSource.includes('selectGatePdfPreviewGroups') &&
      gatePageSource.includes('useDeferredValue') &&
      gatePageSource.includes('scheduleRenderPreviewPages') &&
      gatePageSource.includes('renderGatePdfPageElement') &&
      gatePageSource.includes('previewPageRefs') &&
      gatePageSource.includes('ResizeObserver') &&
      gatePageSource.includes('handleOpenExportDialog') &&
      gatePageSource.includes('handleExportGatePdf') &&
      gatePageSource.includes('exportGateAllocationPdf') &&
      gatePageSource.includes('Gate_Allocation_') &&
      gatePageSource.includes('Export PDF Failed') &&
      gatePageSource.includes('type="datetime-local"') &&
      !gateOptimisticBody.includes('setModifications') &&
      gateCommitBody.includes('applyOptimisticGateModification(mergedMod)') &&
      gateCommitBody.includes('scheduleAccumulatedGateCommit({') &&
      gateCommitBody.indexOf('applyOptimisticGateModification(mergedMod)') < gateCommitBody.indexOf('scheduleAccumulatedGateCommit({') &&
      !gateCommitBody.includes('await persistGateModifications(seasonId, [mod], description)') &&
      !gateCommitBody.includes('const workspace = await applyLocalModificationBatch') &&
      gatePageSource.includes("new Worker(new URL('./gateLocalCommitWorker.ts', import.meta.url), { type: 'module' })") &&
      !gatePageSource.includes('<option value="">Gate</option>') &&
      settingsPageSource.includes("'gateAllocation'") &&
      settingsUiSource.includes('Gate Inventory') &&
      settingsUiSource.includes('Stand Mapping Table') &&
      settingsUiSource.includes('toggleGateGroupGate') &&
      dailyPageSourceForGate.includes('buildDailyStandGateModifications'),
    'Gate Allocation route must support drag/drop assignment, movement, pool unallocation, settings tab, and Daily stand-to-gate mapping'
  );
  assert(
    gateWorkerSource.includes('applyLocalModificationBatchDelta') &&
      !gateWorkerCommitBody.includes('loadLocalSeasonWorkspace') &&
      !gateWorkerCommitBody.includes('applyLocalModificationBatch(') &&
      nativeLocalSeasonStoreSource.includes('runNativeLocalModificationBatchDelta') &&
      gatePageSource.includes('runNativeLocalModificationBatchDelta') &&
      gatePageSource.includes('const nativeResult = await runNativeLocalModificationBatchDelta') &&
      gatePageSource.includes("source: 'gate-native'") &&
      gatePageSource.includes('const GATE_COMMIT_DEBOUNCE_MS = 400') &&
      gatePageSource.includes('const GATE_SYNC_SUMMARY_DEBOUNCE_MS = 300') &&
      gatePageSource.includes('interface PendingAccumulatedGateCommit') &&
      gatePageSource.includes('gateCommitAccumulatorRef') &&
      gatePageSource.includes('gateCommitFlushTimerRef') &&
      gatePageSource.includes('pendingGateSyncSummaryRef') &&
      gatePageSource.includes('gateSyncSummaryTimerRef') &&
      gatePageSource.includes('const scheduleGateSyncSummaryUpdate = useCallback') &&
      gatePageSource.includes('const scheduleGateAuditEntry = useCallback') &&
      gatePageSource.includes('const mergePendingGateCommit = useCallback') &&
      gatePageSource.includes('const flushAccumulatedGateCommit = useCallback') &&
      gatePageSource.includes('const scheduleAccumulatedGateCommit = useCallback') &&
      gatePageSource.includes('window.setTimeout(() => {') &&
      gatePageSource.includes('}, GATE_COMMIT_DEBOUNCE_MS)') &&
      gateMainThreadCommitBody.includes('applyLocalModificationBatchDelta') &&
      gateMainThreadCommitBody.includes("source: 'gate'") &&
      gatePersistBody.includes("source: 'gate-worker'") &&
      gateFlushBody.includes('scheduleGateSyncSummaryUpdate(result.syncMeta)') &&
      gateFlushBody.includes('publishWorkspaceChange(') &&
      gateFlushBody.includes('result.affectedIds') &&
      gateFlushBody.includes('result.syncMeta') &&
      gateFlushBody.includes('scheduleGateAuditEntry(entry, result)'),
    'Gate Allocation commits must use delta-only persistence, one debounced accumulated flush, debounced sync summary updates, and idle audit scheduling'
  );
  assert(
    gatePointerMoveBody.includes("currentClientX: current.kind === 'allocated' ? current.currentClientX : event.clientX") &&
      gatePointerMoveBody.includes('updateGatePointerPreview(event.clientX, event.clientY, next)') &&
      gatePointerUpBody.includes('allocateGate(record, resource.gate)') &&
      !gatePointerUpBody.includes('minuteDelta') &&
      !gatePointerUpBody.includes('timeDelta') &&
      !gatePointerUpBody.includes('gateStart') &&
      !gatePointerUpBody.includes('gateEnd'),
    'Gate allocated pointer drag must lock the overlay X axis and commit gate reassignment only, leaving time windows unchanged'
  );
  assert(
    gatePdfExportSource.includes("import('html2canvas')") &&
      gatePdfExportSource.includes("import('jspdf')") &&
      gatePdfExportSource.includes('new jsPDF({') &&
      gatePdfExportSource.includes("orientation: 'landscape'") &&
      gatePdfExportSource.includes("format: 'a4'") &&
      gatePdfExportSource.includes('groupByGateGroup: true') &&
      gatePdfExportSource.includes('buildGateAllocationView') &&
      gatePdfExportSource.includes('buildGatePdfPagePlan') &&
      gatePdfExportSource.includes('export function renderGatePdfPageElement') &&
      gatePdfExportSource.includes('calculateGatePdfScale') &&
      gatePdfExportSource.includes('page.groupPageCount') &&
      gatePdfExportSource.includes('html2canvas(pageElement') &&
      gatePdfExportSource.includes('drawGatePdfBarLabels') &&
      gatePdfExportSource.includes('pdf.text(') &&
      gatePdfExportSource.includes('showBarLabels: false') &&
      gatePdfExportSource.includes("borderRadius: '4px'") &&
      gatePdfExportSource.includes("border: '1px solid #FFFFFF'") &&
      !gatePdfExportSource.includes('window.print') &&
      !gatePdfExportSource.includes('@media print'),
    'Gate PDF export helper must build a grouped A4 landscape client-side export with native label overlays and solid framed gate bars'
  );
  assert(
    gatePdfExportSource.includes('compress: true') &&
      gatePdfExportSource.includes('const PDF_CANVAS_SCALE = 1.5') &&
      gatePdfExportSource.includes("const PDF_EXPORT_IMAGE_MIME_TYPE = 'image/jpeg'") &&
      gatePdfExportSource.includes('const PDF_EXPORT_IMAGE_QUALITY = 0.82') &&
      gatePdfExportSource.includes('scale: PDF_CANVAS_SCALE') &&
      gatePdfExportSource.includes('canvas.toDataURL(PDF_EXPORT_IMAGE_MIME_TYPE, PDF_EXPORT_IMAGE_QUALITY)') &&
      gatePdfExportSource.includes("'JPEG'") &&
      !gatePdfExportSource.includes('compress: false') &&
      !gatePdfExportSource.includes('scale: 2') &&
      !gatePdfExportSource.includes("toDataURL('image/png')"),
    'Gate PDF export must use compressed JPEG page images at a lower canvas scale to keep exported files small'
  );
  const gateUnallocatedBarBody = gatePageSource.slice(
    gatePageSource.indexOf('const renderUnallocatedBar = (item: GatePackedItem)'),
    gatePageSource.indexOf('const renderResourceBar = (bar: GateResourceBar)')
  );
  const gateResourceBarBody = gatePageSource.slice(
    gatePageSource.indexOf('const renderResourceBar = (bar: GateResourceBar)'),
    gatePageSource.indexOf('  return (\n    <div className="flex h-screen')
  );
  assert(
    [gateUnallocatedBarBody, gateResourceBarBody].every((body) =>
      body.includes("border: '1px solid #FFFFFF'") &&
      body.includes('borderRadius: 4') &&
      body.includes('background: color.backgroundColor') &&
      body.includes("backgroundImage: 'none'") &&
      body.includes('opacity: 1') &&
      body.includes('backgroundColor: color.backgroundColor') &&
      !body.includes('dark:border-[#1E1E1E]') &&
      !body.includes('opacity-60')
    ),
    'Gate Allocation flight bars must render as fully opaque solid fills with no feathered fade, no dark border override, and a 1px solid #FFFFFF frame'
  );
  assert(
    !gatePageSource.includes("import { setSolidFlightBarDragImage } from '@/lib/flightBarDragImage'") &&
      !gatePageSource.includes('setSolidFlightBarDragImage('),
    'Gate Allocation drag must avoid native browser drag previews entirely and use the in-app pointer overlay instead'
  );

  const browserDialogViolations = walkFiles(
    path.join(root, 'src', 'app'),
    (file) => /\.(tsx?|jsx?)$/.test(file)
  ).flatMap((file) => {
    const source = fs.readFileSync(file, 'utf8');
    return source
      .split(/\r?\n/)
      .flatMap((line, index) => /\b(alert|confirm)\s*\(/.test(line)
        ? [`${path.relative(root, file)}:${index + 1}:${line.trim()}`]
        : []);
  });
  assert(
    browserDialogViolations.length === 0,
    `native browser dialogs should not be used in app UI:\n${browserDialogViolations.join('\n')}`
  );
  const appDialogSource = fs.readFileSync(path.join(root, 'src', 'app', 'components', 'AppDialog.tsx'), 'utf8');
  assert(
    appDialogSource.includes('createPortal') &&
      appDialogSource.includes('APP_DIALOG_ROOT_ID') &&
      appDialogSource.includes('document.body.appendChild'),
    'AppDialog must render through a document.body portal so page overflow/flex containers cannot clip it'
  );
  assert(
    appDialogSource.includes("position: 'fixed'") &&
      appDialogSource.includes("width: '100vw'") &&
      appDialogSource.includes("height: '100vh'") &&
      appDialogSource.includes("width: 'min(480px, calc(100vw - 32px))'") &&
      appDialogSource.includes("flex: '0 0 min(480px, calc(100vw - 32px))'"),
    'AppDialog overlay/card geometry must use inline fixed dimensions so table/page CSS cannot collapse the modal'
  );
  const detailedPageSource = fs.readFileSync(path.join(root, 'src', 'app', 'detailed', 'page.tsx'), 'utf8');
  assert(
    detailedPageSource.includes('isSelectedCell = isInSelection || isSweepTarget') &&
      detailedPageSource.includes('isToday && !isSelectedCell'),
    'Detailed calendar today highlight must yield to active or committed selection coloring'
  );
  const newFlightModalSource = fs.readFileSync(path.join(root, 'src', 'app', 'components', 'NewFlightModal.tsx'), 'utf8');
  assert(
    newFlightModalSource.includes('prefillDateSelection?: NewFlightDateSelection') &&
      !newFlightModalSource.includes('prefillDate?: string') &&
      detailedPageSource.includes('prefillDateSelection={newFlightDateSelection}'),
    'Detailed Add Flight modal must accept a date selection vector instead of a single prefill date'
  );
  assert(
    detailedPageSource.includes('const hasExplicitDetailedFlightSelection = Boolean(targetArrFlight || targetDepFlight);') &&
      detailedPageSource.includes('if (!hasExplicitDetailedFlightSelection) {') &&
      detailedPageSource.includes("sessionStorage.setItem('detailed_arr', hasExplicitDetailedFlightSelection ? activeArr || '' : '');") &&
      detailedPageSource.includes("sessionStorage.setItem('detailed_dep', hasExplicitDetailedFlightSelection ? activeDep || '' : '');"),
    'Detailed season-only routes must not restore or persist stale ARR/DEP flight filters'
  );
  assert(
    detailedPageSource.includes('runNativeScheduleMutation') &&
      detailedPageSource.includes('const detailedCommitSeqRef = useRef(0);') &&
      detailedPageSource.includes('const rollbackState = captureDetailedOptimisticRollbackState();') &&
      detailedPageSource.includes('restoreDetailedOptimisticState(rollbackState);') &&
      detailedPageSource.includes('await runNativeScheduleMutation(season.id, addedRecords, [], regularMods, historyEntry)') &&
      detailedPageSource.indexOf('setCurrentMods(nextMods);') < detailedPageSource.indexOf('await runNativeScheduleMutation(season.id, addedRecords, [], regularMods, historyEntry)') &&
      !detailedPageSource.includes('const workspace = await applyLocalModificationBatch(season.id, regularMods, historyEntry);'),
    'Detailed Schedule mass edits/adds/deletes must optimistically update visible state, persist only selected IDs through native mutation, and rollback immediately on failed commits'
  );
  const homePageSource = fs.readFileSync(path.join(root, 'src', 'app', 'page.tsx'), 'utf8');
  const seasonalRoutePath = path.join(root, 'src', 'app', 'seasonal', 'page.tsx');
  const seasonalRouteSource = fs.existsSync(seasonalRoutePath) ? fs.readFileSync(seasonalRoutePath, 'utf8') : '';
  const seasonalPageSource = fs.readFileSync(path.join(root, 'src', 'app', 'SeasonalSchedulePage.tsx'), 'utf8');
  const dailyPageSource = fs.readFileSync(path.join(root, 'src', 'app', 'daily', 'page.tsx'), 'utf8');
  assert(
    dailyPageSource.includes('buildCanonicalAddedFlightRecords') &&
      detailedPageSource.includes('buildCanonicalAddedFlightRecords') &&
      !dailyPageSource.includes('const addedRecords = addedModificationsToFlightRecords(mods);') &&
      !detailedPageSource.includes('const addedRecords = addedModificationsToFlightRecords(addedMods);'),
    'Daily and Detailed new-flight commits must use the shared canonical added FlightRecord builder, not page-local conversion paths'
  );
  const dashboardPageSource = fs.readFileSync(path.join(root, 'src', 'app', 'dashboard', 'page.tsx'), 'utf8');
  const dashboardAiSource = fs.readFileSync(path.join(root, 'src', 'lib', 'dashboardAiAnalysis.ts'), 'utf8');
  const pythonAgentMainSource = fs.readFileSync(path.join(root, 'ai-agent', 'agent', 'main.py'), 'utf8');
  const pythonAgentContractsSource = fs.readFileSync(path.join(root, 'ai-agent', 'agent', 'contracts.py'), 'utf8');
  const pythonAgentProviderSource = fs.readFileSync(path.join(root, 'ai-agent', 'agent', 'provider_clients.py'), 'utf8');
  const pythonAgentSqlValidatorSource = fs.readFileSync(path.join(root, 'ai-agent', 'agent', 'sql_validator.py'), 'utf8');
  const tauriLibSourceForAiAgent = fs.readFileSync(path.join(root, 'src-tauri', 'src', 'lib.rs'), 'utf8');
  const tauriConfigSourceForAiAgent = fs.readFileSync(path.join(root, 'src-tauri', 'tauri.conf.json'), 'utf8');
  const packageSourceForAiAgent = fs.readFileSync(path.join(root, 'package.json'), 'utf8');
  const dashboardAiRunKernelSymbols = [
    'DashboardAiRunEvent',
    'evaluateDashboardAiToolPermission',
    'scheduleDashboardAiRun',
    'createDashboardAiRunEvent',
    'appendDashboardAiRunEvent',
    'compactDashboardAiSessionLedger',
    'buildDashboardAiSessionLedger',
    'mapSkawldEventToDashboardAiRunEvent',
  ];
  const missingDashboardAiRunKernelSymbols = dashboardAiRunKernelSymbols.filter((symbol) => !dashboardAiSource.includes(symbol));
  assert(
    missingDashboardAiRunKernelSymbols.length === 0,
    `dashboardAiAnalysis.ts must expose the Skawld-inspired run kernel contract; missing ${missingDashboardAiRunKernelSymbols.join(', ')}`
  );
  assert(
    /export\s+(type|interface)\s+DashboardAiRunEvent\b/.test(dashboardAiSource),
    'dashboardAiAnalysis.ts must export DashboardAiRunEvent as the stable run-event ledger shape'
  );
  assert(
    dashboardAiSource.includes('evaluateDashboardAiToolPermission') &&
      dashboardAiSource.includes('allowedTools') &&
      dashboardAiSource.includes('requiresConfirmation') &&
      dashboardAiSource.includes('readOnly'),
    'Dashboard AI tool permission evaluator must gate tools by allowedTools, confirmation requirements, and read-only status'
  );
  assert(
    dashboardAiSource.includes('scheduleDashboardAiRun') &&
      dashboardAiSource.includes('createDashboardAiRunEvent') &&
      dashboardAiSource.includes('appendDashboardAiRunEvent'),
    'Dashboard AI run kernel must provide scheduler and run-event helper functions before wiring a larger agent runtime'
  );
  assert(
    dashboardAiSource.includes('analyzeDashboardWithLocalAgent') &&
      dashboardAiSource.includes('localAgentClient') &&
      dashboardPageSource.includes('callNativeDashboardAiAgent') &&
      dashboardPageSource.includes('analyzeDashboardWithLocalAgent') &&
      dashboardPageSource.includes('Python Agent') &&
      pythonAgentMainSource.includes('Provider gọi trực tiếp từ máy local') &&
      pythonAgentProviderSource.includes('generativelanguage.googleapis.com') &&
      pythonAgentProviderSource.includes('https://api.deepseek.com') &&
      pythonAgentProviderSource.includes('/chat/completions') &&
      pythonAgentSqlValidatorSource.includes('SELECT') &&
      pythonAgentSqlValidatorSource.includes('WITH') &&
      pythonAgentSqlValidatorSource.includes('dashboard_ai_flight_operations') &&
      pythonAgentSqlValidatorSource.includes('FORBIDDEN_KEYWORDS'),
    'Dashboard AI must include the local Python Agent path, direct Gemini/Qwen/DeepSeek clients, and mirrored read-only SQL validation'
  );
  assert(
    !dashboardPageSource.includes('fetchDashboardAiProviderKey') &&
      !dashboardAiSource.includes('providerKey: string') &&
      !dashboardAiSource.includes('providerKey: request.providerKey') &&
      tauriLibSourceForAiAgent.includes('fetch_ai_provider_key') &&
      tauriLibSourceForAiAgent.includes('fetch_dashboard_ai_provider_key_native') &&
      tauriLibSourceForAiAgent.includes('providerKey') &&
      tauriLibSourceForAiAgent.includes('supabase_url') &&
      tauriLibSourceForAiAgent.includes('access_token'),
    'Desktop Dashboard AI must fetch synced provider keys inside Tauri/Rust and must not expose raw provider keys to React dashboard runtime'
  );
  assert(
    tauriConfigSourceForAiAgent.includes('"externalBin"') &&
      tauriConfigSourceForAiAgent.includes('binaries/dashboard-ai-agent') &&
      tauriConfigSourceForAiAgent.includes('npm run python:agent:bundle && npm run build') &&
      packageSourceForAiAgent.includes('"python:agent:bundle"') &&
      packageSourceForAiAgent.includes('scripts/build-python-agent.cjs') &&
      fs.existsSync(path.join(root, 'scripts', 'build-python-agent.cjs')) &&
      fs.existsSync(path.join(root, 'ai-agent', 'agent_sidecar.py')),
    'Native build must package the Python AI Agent as a Tauri externalBin sidecar instead of requiring uvicorn on every installed machine'
  );
  assert(
    dashboardPageSource.includes('if (isTauriRuntime() && localAgentError && !response)') &&
      dashboardPageSource.includes('Provider local chưa sẵn sàng') &&
      dashboardPageSource.includes('hãy đồng bộ API key') &&
      dashboardPageSource.indexOf('if (isTauriRuntime() && localAgentError && !response)') <
        dashboardPageSource.indexOf('response = response ?? await analyzeDashboardWithAi') &&
      !dashboardPageSource.includes('provider_direct_local: Python Agent local chưa xử lý được request nên đã fallback'),
    'Desktop Dashboard AI must not fall through to the legacy Edge provider when the local Python provider/key path fails'
  );
  assert(
    dashboardAiSource.includes('compactDashboardAiSessionLedger') &&
      dashboardAiSource.includes('buildDashboardAiSessionLedger') &&
      dashboardAiSource.includes('DashboardAiRunEvent'),
    'Dashboard AI run kernel must provide compaction and session ledger helpers for bounded local AI state'
  );
  assert(
    tauriLibSourceForAiAgent.includes('call_dashboard_ai_agent') &&
      tauriLibSourceForAiAgent.includes('dashboard_ai_agent_health') &&
      tauriLibSourceForAiAgent.includes('ensure_dashboard_ai_agent_running') &&
      tauriLibSourceForAiAgent.includes('.sidecar("dashboard-ai-agent")') &&
      tauriLibSourceForAiAgent.includes('127.0.0.1') &&
      tauriLibSourceForAiAgent.includes('x-seasonal-ai-agent-token') &&
      tauriLibSourceForAiAgent.includes('sqlitePath') &&
      tauriLibSourceForAiAgent.includes('seasonal-management-local.db'),
    'Tauri must proxy React requests to the local Python AI Agent and inject the desktop SQLite path instead of letting React call localhost directly'
  );
  assert(
    dashboardPageSource.includes('appendDashboardAiRunEvent') &&
      dashboardPageSource.indexOf('appendDashboardAiRunEvent') < dashboardPageSource.indexOf('const nextCell'),
    'Dashboard page must append run events through the event ledger helper before creating AI notebook cells'
  );
  const runEvent = createDashboardAiRunEvent('run-1', 'tool_call_end', {
    tool: 'query_dashboard_data',
    status: 'executed',
    reason: 'ÄÃ£ cháº¡y query local.',
  });
  const cappedRunEvents = appendDashboardAiRunEvent([
    createDashboardAiRunEvent('run-0', 'user', { prompt: 'old' }),
  ], runEvent, { maxEvents: 1 });
  const allowQueryPermission = evaluateDashboardAiToolPermission({
    tool: 'query_dashboard_data',
    allowedTools: ['query_dashboard_data'],
    availableTools: DASHBOARD_AI_TOOL_REGISTRY,
    input: { limit: 9999 },
  });
  const denyUnknownToolPermission = evaluateDashboardAiToolPermission({
    tool: 'query_dashboard_data',
    allowedTools: [],
    availableTools: DASHBOARD_AI_TOOL_REGISTRY,
  });
  const askExportPermission = evaluateDashboardAiToolPermission({
    tool: 'suggest_custom_workbook',
    allowedTools: ['suggest_custom_workbook'],
    availableTools: DASHBOARD_AI_TOOL_REGISTRY,
    readOnly: false,
    requiresConfirmation: true,
  });
  const scheduledRun = scheduleDashboardAiRun([
    { id: 'q1', tool: 'query_dashboard_data', input: { limit: 800 }, parallelSafe: true },
    { id: 'q2', tool: 'suggest_visual_report', parallelSafe: true },
    { id: 'x1', tool: 'suggest_custom_workbook' },
  ], {
    allowedTools: ['query_dashboard_data', 'suggest_visual_report'],
    availableTools: DASHBOARD_AI_TOOL_REGISTRY,
  });
  const compactedLedger = compactDashboardAiSessionLedger([
    createDashboardAiRunEvent('run-1', 'user', { prompt: 'p1' }),
    createDashboardAiRunEvent('run-1', 'result', { message: 'a1' }),
    createDashboardAiRunEvent('run-2', 'user', { prompt: 'p2' }),
  ], { maxProviderEvents: 2 });
  const builtLedger = buildDashboardAiSessionLedger([{
    id: 'cell-ledger',
    prompt: 'p',
    assistantText: 'a',
    blocks: [],
    toolTraceSummary: [],
    exportAction: null,
    createdAt: 1,
    runEvents: [runEvent],
  }], { maxProviderEvents: 4 });
  assert(
    cappedRunEvents.length === 1 &&
      cappedRunEvents[0].id === runEvent.id &&
      allowQueryPermission.decision === 'allow' &&
      allowQueryPermission.readOnly === true &&
      allowQueryPermission.updatedInput?.limit === 500 &&
      denyUnknownToolPermission.decision === 'deny' &&
      askExportPermission.decision === 'ask' &&
      scheduledRun.parallelBatches[0]?.length === 2 &&
      scheduledRun.rejected.some((entry) => entry.item.id === 'x1') &&
      compactedLedger.compacted === true &&
      compactedLedger.providerView.length === 2 &&
      builtLedger.events.some((event) => event.id === runEvent.id),
    `Dashboard AI run kernel should cap ledgers, gate tools, batch parallel-safe calls, and preserve stored run events, got ${JSON.stringify({ cappedRunEvents, allowQueryPermission, denyUnknownToolPermission, askExportPermission, scheduledRun, compactedLedger, builtLedger })}`
  );
  const mappedSkawldInitEvent = mapSkawldEventToDashboardAiRunEvent({
    type: 'system',
    subtype: 'init',
    session_id: 'sk-session',
    run_id: 'sk-run-1',
    model: 'mock-dashboard-model',
    tools: ['query_local_sql'],
    permission_mode: 'default',
    cwd: root,
  });
  const mappedSkawldToolStartEvent = mapSkawldEventToDashboardAiRunEvent({
    type: 'tool_call_start',
    tool_use_id: 'tool-1',
    tool_name: 'query_dashboard_data',
    input: { sql: 'SELECT ops_date, COUNT(*) AS flights FROM dashboard_ai_flight_operations GROUP BY ops_date LIMIT 30' },
  }, { runId: 'fallback-run' });
  const mappedSkawldToolEndEvent = mapSkawldEventToDashboardAiRunEvent({
    type: 'tool_call_end',
    tool_use_id: 'tool-1',
    tool_name: 'query_dashboard_data',
    is_error: false,
    duration_ms: 42,
  }, { runId: 'fallback-run' });
  const mappedSkawldResultEvent = mapSkawldEventToDashboardAiRunEvent({
    type: 'result',
    subtype: 'success',
    stop_reason: 'end_turn',
    total_usage: { input_tokens: 10, output_tokens: 20 },
    duration_ms: 100,
    final_text: 'Káº¿t quáº£ tiáº¿ng Viá»‡t.',
  }, { runId: 'fallback-run' });
  assert(
    mappedSkawldInitEvent?.type === 'init' &&
      mappedSkawldInitEvent.runId === 'sk-run-1' &&
      mappedSkawldInitEvent.metadata?.sessionId === 'sk-session' &&
      mappedSkawldToolStartEvent?.type === 'tool_call_start' &&
      mappedSkawldToolStartEvent.tool === 'query_dashboard_data' &&
      mappedSkawldToolStartEvent.status === 'started' &&
      mappedSkawldToolEndEvent?.type === 'tool_call_end' &&
      mappedSkawldToolEndEvent.durationMs === 42 &&
      mappedSkawldResultEvent?.type === 'result' &&
      mappedSkawldResultEvent.usage?.totalTokens === 30,
    `Skawld event mapper must preserve run ids, tool names, duration, status, and usage for Dashboard AI events, got ${JSON.stringify({ mappedSkawldInitEvent, mappedSkawldToolStartEvent, mappedSkawldToolEndEvent, mappedSkawldResultEvent })}`
  );
  const layoutSource = fs.readFileSync(path.join(root, 'src', 'app', 'layout.tsx'), 'utf8');
  const globalCssSource = fs.readFileSync(path.join(root, 'src', 'app', 'globals.css'), 'utf8');
  const appShellSource = fs.readFileSync(path.join(root, 'src', 'app', 'components', 'AppShell.tsx'), 'utf8');
  const appSidebarSource = fs.readFileSync(path.join(root, 'src', 'app', 'components', 'AppSidebar.tsx'), 'utf8');
  const workspacePageHeaderPath = path.join(root, 'src', 'app', 'components', 'WorkspacePageHeader.tsx');
  const workspacePageHeaderSource = fs.existsSync(workspacePageHeaderPath) ? fs.readFileSync(workspacePageHeaderPath, 'utf8') : '';
  const headerActionMenuPath = path.join(root, 'src', 'app', 'components', 'HeaderActionMenu.tsx');
  const headerActionMenuSource = fs.existsSync(headerActionMenuPath) ? fs.readFileSync(headerActionMenuPath, 'utf8') : '';
  const nativeCloseCleanupGuardPath = path.join(root, 'src', 'app', 'components', 'NativeCloseCleanupGuard.tsx');
  const nativeCloseCleanupGuardSource = fs.existsSync(nativeCloseCleanupGuardPath) ? fs.readFileSync(nativeCloseCleanupGuardPath, 'utf8') : '';
  const nativeStartupSessionResetPath = path.join(root, 'src', 'app', 'components', 'NativeStartupSessionReset.tsx');
  const nativeStartupSessionResetSource = fs.existsSync(nativeStartupSessionResetPath) ? fs.readFileSync(nativeStartupSessionResetPath, 'utf8') : '';
  const loadingStatusPanelPath = path.join(root, 'src', 'app', 'components', 'LoadingStatusPanel.tsx');
  const loadingStatusPanelSource = fs.existsSync(loadingStatusPanelPath) ? fs.readFileSync(loadingStatusPanelPath, 'utf8') : '';
  assert(
    seasonalPageSource.includes('if (selectedRecordIds.size === 0)') &&
      seasonalPageSource.includes('Select flights to export') &&
      !seasonalPageSource.includes('selectedRecordIds.size > 0 ? Array.from(selectedRecordIds) : undefined') &&
      !seasonalPageSource.includes('Export Updated Schedule'),
    'Seasonal canonical export must require selected flights; full export should happen only when the user selects all rows'
  );
  assert(
    seasonalPageSource.includes('const [isExporting, setIsExporting]') &&
      seasonalPageSource.includes('toggleAllFilteredSelection') &&
      seasonalPageSource.includes('allFilteredSelected') &&
      seasonalPageSource.includes('hasPartialFilteredSelection') &&
      seasonalPageSource.includes('node.indeterminate = hasPartialFilteredSelection') &&
      seasonalPageSource.includes('aria-label="Select all flights in current table for export"') &&
      seasonalPageSource.includes('Exporting...'),
    'Seasonal export UX must include a header select-all checkbox and show Exporting... while canonical export is running'
  );
  const tauriDefaultCapabilityPath = path.join(root, 'src-tauri', 'capabilities', 'default.json');
  const tauriDefaultCapabilitySource = fs.existsSync(tauriDefaultCapabilityPath) ? fs.readFileSync(tauriDefaultCapabilityPath, 'utf8') : '';
  const syncActionButtonSource = fs.readFileSync(
    path.join(root, 'src', 'app', 'components', 'SyncActionButton.tsx'),
    'utf8'
  );
  const fetchServerUpdatesButtonPath = path.join(root, 'src', 'app', 'components', 'FetchServerUpdatesButton.tsx');
  const fetchServerUpdatesButtonSource = fs.existsSync(fetchServerUpdatesButtonPath)
    ? fs.readFileSync(fetchServerUpdatesButtonPath, 'utf8')
    : '';
  const operatorAuthGatePath = path.join(root, 'src', 'app', 'components', 'OperatorAuthGate.tsx');
  const operatorAuthGateSource = fs.existsSync(operatorAuthGatePath) ? fs.readFileSync(operatorAuthGatePath, 'utf8') : '';
  const pbbIconSource = fs.existsSync(path.join(root, 'src', 'app', 'components', 'PbbIcon.tsx'))
    ? fs.readFileSync(path.join(root, 'src', 'app', 'components', 'PbbIcon.tsx'), 'utf8')
    : '';
  const seasonDataCacheSource = fs.readFileSync(path.join(root, 'src', 'lib', 'seasonDataCache.ts'), 'utf8');
  const appSessionCleanupPath = path.join(root, 'src', 'lib', 'appSessionCleanup.ts');
  const appSessionCleanupSource = fs.existsSync(appSessionCleanupPath) ? fs.readFileSync(appSessionCleanupPath, 'utf8') : '';
  const auditLogSource = fs.existsSync(path.join(root, 'src', 'lib', 'auditLog.ts'))
    ? fs.readFileSync(path.join(root, 'src', 'lib', 'auditLog.ts'), 'utf8')
    : '';
  const firestoreSource = fs.readFileSync(path.join(root, 'src', 'lib', 'firestore.ts'), 'utf8');
  const remoteStoreSource = fs.existsSync(path.join(root, 'src', 'lib', 'remoteStore.ts'))
    ? fs.readFileSync(path.join(root, 'src', 'lib', 'remoteStore.ts'), 'utf8')
    : '';
  const supabaseClientSource = fs.existsSync(path.join(root, 'src', 'lib', 'supabase.ts'))
    ? fs.readFileSync(path.join(root, 'src', 'lib', 'supabase.ts'), 'utf8')
    : '';
  const supabaseStoreSource = fs.existsSync(path.join(root, 'src', 'lib', 'supabaseStore.ts'))
    ? fs.readFileSync(path.join(root, 'src', 'lib', 'supabaseStore.ts'), 'utf8')
    : '';
  const nativeSeasonBootstrapSource = fs.existsSync(path.join(root, 'src', 'lib', 'nativeSeasonBootstrap.ts'))
    ? fs.readFileSync(path.join(root, 'src', 'lib', 'nativeSeasonBootstrap.ts'), 'utf8')
    : '';
  const seasonSyncSource = fs.readFileSync(path.join(root, 'src', 'lib', 'seasonSync.ts'), 'utf8');
  const seasonWorkspaceBootstrapSource = fs.readFileSync(path.join(root, 'src', 'lib', 'seasonWorkspaceBootstrap.ts'), 'utf8');
  const seasonAutoSyncSource = fs.readFileSync(path.join(root, 'src', 'lib', 'seasonAutoSync.ts'), 'utf8');
  const seasonChangeEventsSource = fs.readFileSync(path.join(root, 'src', 'lib', 'seasonChangeEvents.ts'), 'utf8');
  const seasonConflictResolutionSource = fs.readFileSync(path.join(root, 'src', 'lib', 'seasonConflictResolution.ts'), 'utf8');
  const iataSeasonSource = fs.readFileSync(path.join(root, 'src', 'lib', 'iataSeason.ts'), 'utf8');
  const seasonSyncProviderSource = fs.readFileSync(path.join(root, 'src', 'app', 'components', 'SeasonSyncProvider.tsx'), 'utf8');
  const seasonConflictReviewControlSource = fs.readFileSync(path.join(root, 'src', 'app', 'components', 'SeasonConflictReviewControl.tsx'), 'utf8');
  const detailedConfirmModalSource = fs.readFileSync(path.join(root, 'src', 'app', 'detailed', 'ConfirmModal.tsx'), 'utf8');
  const appRuntimeLegacySyncRefs = walkFiles(
    path.join(root, 'src', 'app'),
    (filePath) => /\.(?:ts|tsx|js|jsx)$/.test(filePath)
  ).flatMap((filePath) => {
    const source = fs.readFileSync(filePath, 'utf8');
    const hits = [];
    if (/\bsyncSeasonWorkspace\s*(?:\(|,|\})/.test(source)) hits.push('syncSeasonWorkspace');
    if (/\bloadOrSeedSeasonWorkspace\s*(?:\(|,|\})/.test(source)) hits.push('loadOrSeedSeasonWorkspace');
    if (/\bapplyLocalModificationBatch\s*(?:\(|,|\})/.test(source)) hits.push('applyLocalModificationBatch');
    if (/from ['"]@\/lib\/firestore['"]|from ['"]\.\.?\/.*firestore['"]|firebase\/firestore|getFirestore\s*\(/.test(source)) hits.push('firestore sync helper');
    return hits.map((hit) => `${path.relative(root, filePath)}:${hit}`);
  });
  assert(
    appRuntimeLegacySyncRefs.length === 0,
    `App runtime files must not import/call legacy sync or Firestore helpers: ${appRuntimeLegacySyncRefs.join(', ')}`
  );
  const operationalRouteSources = [detailedPageSource, dailyPageSource, seasonalPageSource, checkInPageSource, gatePageSource];
  assert(
    operationalRouteSources.every((source) =>
      !source.includes('loadLocalSeasonWorkspace') &&
      !source.includes('applyLocalModificationBatch(') &&
      !source.includes('applyLocalFlightRecordMutation(') &&
      !source.includes('applyLocalSourceRows(')
    ) &&
      [detailedPageSource, dailyPageSource, checkInPageSource, gatePageSource].every((source) => !source.includes('saveLocalSeasonWorkspace')) &&
      (!seasonalPageSource.includes('saveLocalSeasonWorkspace') || seasonalPageSource.includes("nativeFullSaveReason: 'import-reset'")) &&
      detailedPageSource.includes('queryNativeScheduleWindow') &&
      dailyPageSource.includes('queryNativeScheduleWindow') &&
      (seasonalPageSource.includes('queryNativeSourceRowsWindow') || seasonalPageSource.includes('queryNativeScheduleWindow')) &&
      checkInPageSource.includes('runNativeLocalModificationBatchDelta') &&
      gatePageSource.includes('runNativeLocalModificationBatchDelta'),
    'Operational routes must use native atomic mutation/query APIs and must not call full-workspace persistence helpers'
  );
  assert(
    detailedConfirmModalSource.includes('recordsById') &&
      detailedConfirmModalSource.includes('nativeChangeCount') &&
      !detailedConfirmModalSource.includes('originalLegs.find'),
    'Detailed Confirm Changes modal must render proposed changes from a bounded record lookup, not only visible legs'
  );
  assert(
    dailyPageSource.includes('partitionDailyImportRowsByIataSeason') &&
      dailyPageSource.includes('for (const batch of batches)') &&
      dailyPageSource.includes('findSeasonByCode(seasonCode)') &&
      dailyPageSource.includes('createSeason(seasonFields)') &&
      dailyPageSource.includes('getSeasonDateRange(seasonCode)') &&
      dailyPageSource.includes('ensureNativeLocalSeason(targetSeason)') &&
      dailyPageSource.includes('seasonId: targetSeason.id') &&
      dailyPageSource.includes('runNativeScheduleMutation(') &&
      dailyPageSource.includes('targetSeason.id,') &&
      dailyPageSource.includes('router.push(`/daily?season=${routedSeason.id}`)'),
    'Daily import must split files by inferred IATA season, create/bootstrap missing seasons, and commit each batch to its target season_id'
  );
  const tsconfigSource = fs.readFileSync(path.join(root, 'tsconfig.json'), 'utf8');
  const packageJsonSource = fs.readFileSync(path.join(root, 'package.json'), 'utf8');
  const packageJson = JSON.parse(packageJsonSource);
  const tauriConfigPath = path.join(root, 'src-tauri', 'tauri.conf.json');
  const tauriConfigSource = fs.existsSync(tauriConfigPath) ? fs.readFileSync(tauriConfigPath, 'utf8') : '';
  const tauriMainPath = path.join(root, 'src-tauri', 'src', 'main.rs');
  const tauriMainSource = fs.existsSync(tauriMainPath) ? fs.readFileSync(tauriMainPath, 'utf8') : '';
  const tauriLibPath = path.join(root, 'src-tauri', 'src', 'lib.rs');
  const tauriLibSource = fs.existsSync(tauriLibPath) ? fs.readFileSync(tauriLibPath, 'utf8') : '';
  const nativeCatchupRustPath = path.join(root, 'src-tauri', 'src', 'native_catchup.rs');
  const nativeCatchupRustSource = fs.existsSync(nativeCatchupRustPath) ? fs.readFileSync(nativeCatchupRustPath, 'utf8') : '';
  const nativeSeasonCatchupPath = path.join(root, 'src', 'lib', 'nativeSeasonCatchup.ts');
  const nativeSeasonCatchupSource = fs.existsSync(nativeSeasonCatchupPath) ? fs.readFileSync(nativeSeasonCatchupPath, 'utf8') : '';
  const tauriCargoPath = path.join(root, 'src-tauri', 'Cargo.toml');
  const tauriCargoSource = fs.existsSync(tauriCargoPath) ? fs.readFileSync(tauriCargoPath, 'utf8') : '';
  const supabaseSchemaPath = path.join(root, 'supabase', 'schema.sql');
  const supabaseSchemaSource = fs.existsSync(supabaseSchemaPath) ? fs.readFileSync(supabaseSchemaPath, 'utf8') : '';
  const migrationScriptPath = path.join(root, 'scripts', 'migrate-firestore-to-supabase.mjs');
  const migrationScriptSource = fs.existsSync(migrationScriptPath) ? fs.readFileSync(migrationScriptPath, 'utf8') : '';
  const auditPagePath = path.join(root, 'src', 'app', 'audit', 'page.tsx');
  const auditPageSource = fs.existsSync(auditPagePath) ? fs.readFileSync(auditPagePath, 'utf8') : '';
  const appRouteCachePath = path.join(root, 'src', 'app', 'components', 'AppRouteCache.tsx');
  const routeCacheContextPath = path.join(root, 'src', 'app', 'components', 'RouteCacheContext.tsx');
  const appRouteCacheSource = fs.existsSync(appRouteCachePath) ? fs.readFileSync(appRouteCachePath, 'utf8') : '';
  const routeCacheContextSource = fs.existsSync(routeCacheContextPath) ? fs.readFileSync(routeCacheContextPath, 'utf8') : '';
  const skawldCheckScriptPath = path.join(root, 'scripts', 'check-skawld-sdk.mjs');
  const skawldCheckScriptSource = fs.existsSync(skawldCheckScriptPath) ? fs.readFileSync(skawldCheckScriptPath, 'utf8') : '';
  const skawldHarnessScriptPath = path.join(root, 'scripts', 'skawld-dashboard-agent-harness.mjs');
  const skawldHarnessScriptSource = fs.existsSync(skawldHarnessScriptPath) ? fs.readFileSync(skawldHarnessScriptPath, 'utf8') : '';
  const skawldHarnessTestScriptPath = path.join(root, 'scripts', 'test-skawld-dashboard-agent-harness.mjs');
  const skawldHarnessTestScriptSource = fs.existsSync(skawldHarnessTestScriptPath) ? fs.readFileSync(skawldHarnessTestScriptPath, 'utf8') : '';
  const dashboardAiLocalSqlSourcePath = path.join(root, 'scripts', 'dashboard-ai-local-sql-source.mjs');
  const dashboardAiLocalSqlSource = fs.existsSync(dashboardAiLocalSqlSourcePath) ? fs.readFileSync(dashboardAiLocalSqlSourcePath, 'utf8') : '';
  const seasonWorkspaceRefreshHookPath = path.join(root, 'src', 'app', 'hooks', 'useSeasonWorkspaceRefresh.ts');
  const seasonWorkspaceRefreshHookSource = fs.existsSync(seasonWorkspaceRefreshHookPath) ? fs.readFileSync(seasonWorkspaceRefreshHookPath, 'utf8') : '';
  const sessionStateHookSource = fs.readFileSync(path.join(root, 'src', 'app', 'hooks', 'useSessionState.ts'), 'utf8');
  const sessionScrollHookSource = fs.readFileSync(path.join(root, 'src', 'app', 'hooks', 'useSessionScrollRestoration.ts'), 'utf8');
  const skawldProductionImports = walkFiles(
    path.join(root, 'src'),
    (filePath) => /\.(?:ts|tsx|js|jsx|mjs|cjs)$/.test(filePath)
  ).filter((filePath) => fs.readFileSync(filePath, 'utf8').includes('@skawld/agent-sdk'));
  assert(
    skawldCheckScriptSource.includes("import('@skawld/agent-sdk')") &&
      skawldCheckScriptSource.includes('devOnly') &&
      skawldCheckScriptSource.includes('process.exitCode = 1') &&
      skawldCheckScriptSource.includes('requiredExports') &&
      skawldCheckScriptSource.includes("import('@skawld/agent-sdk/tools')") &&
      skawldCheckScriptSource.includes("import('@skawld/agent-sdk/sessions')") &&
      skawldCheckScriptSource.includes("import('@skawld/agent-sdk/permissions')"),
    'Skawld SDK compatibility spike must stay dev-only, dynamically import the SDK and subpath APIs, and report requiredExports'
  );
  assert(
    packageJson.devDependencies?.['@skawld/agent-sdk'] === '^0.1.0' &&
      packageJson.devDependencies?.['better-sqlite3'] === '^11.10.0' &&
      packageJson.scripts?.['skawld:dashboard-harness'] === 'node scripts/skawld-dashboard-agent-harness.mjs' &&
      packageJson.scripts?.['test:skawld-dashboard-harness'] === 'node scripts/test-skawld-dashboard-agent-harness.mjs',
    'package.json must install @skawld/agent-sdk and better-sqlite3 as dev dependencies and expose the dev-only dashboard harness scripts'
  );
  assert(
    skawldHarnessScriptSource.includes("import('@skawld/agent-sdk')") &&
      skawldHarnessScriptSource.includes("import('@skawld/agent-sdk/providers')") &&
      skawldHarnessScriptSource.includes("import('@skawld/agent-sdk/tools')") &&
      skawldHarnessScriptSource.includes('query_local_sql') &&
      skawldHarnessScriptSource.includes('--source') &&
      skawldHarnessScriptSource.includes('local-sqlite') &&
      skawldHarnessScriptSource.includes('DashboardAiRuntimeSpikeResult') &&
      skawldHarnessScriptSource.includes("status: 'completed'") &&
      skawldHarnessScriptSource.includes('dev-only') &&
      skawldHarnessScriptSource.includes('production'),
    'Skawld dashboard harness must be a dev-only runtime spike with a query_local_sql adapter, event capture, local-sqlite source option, and a clear production warning'
  );
  assert(
    dashboardAiLocalSqlSource.includes('DEFAULT_DASHBOARD_AI_LOCAL_DB_PATH') &&
      dashboardAiLocalSqlSource.includes('better-sqlite3') &&
      dashboardAiLocalSqlSource.includes('CREATE TEMP VIEW dashboard_ai_flight_operations') &&
      dashboardAiLocalSqlSource.includes('validateDashboardAiSql') &&
      dashboardAiLocalSqlSource.includes('Dashboard AI SQL can only read dashboard_ai_flight_operations'),
    'Skawld dashboard harness must have a dev-only local SQLite source that mirrors the Rust/Tauri dashboard_ai_flight_operations read-only gateway'
  );
  assert(
    skawldHarnessTestScriptSource.includes('TEST_TREE') &&
      skawldHarnessTestScriptSource.includes('basic-month-total') &&
      skawldHarnessTestScriptSource.includes('month-comparison') &&
      skawldHarnessTestScriptSource.includes('peak-day-anomaly') &&
      skawldHarnessTestScriptSource.includes('single-day-detail') &&
      skawldHarnessTestScriptSource.includes('specific-flight') &&
      skawldHarnessTestScriptSource.includes('--source') &&
      skawldHarnessTestScriptSource.includes('local-sqlite') &&
      skawldHarnessTestScriptSource.includes('tool_call_start') &&
      skawldHarnessTestScriptSource.includes('tool_call_end'),
    'Skawld dashboard harness test tree must cover month totals, month comparison, peak day anomaly, single-day detail, and a specific flight through runtime tool events for mock and local SQLite sources'
  );
  assert(
    skawldProductionImports.length === 0,
    `Skawld SDK compatibility spike must not import @skawld/agent-sdk from production src files, found ${JSON.stringify(skawldProductionImports.map((filePath) => path.relative(root, filePath)))}`
  );
  assert(
    seasonSyncSource.includes('updateLocalSyncMeta') &&
      seasonSyncSource.includes('async function persistLocalSyncMeta') &&
      !/saveLocalSeasonWorkspace\(\{[\s\S]{0,220}syncStatus: 'failed'/.test(seasonSyncSource) &&
      !/saveLocalSeasonWorkspace\(\{[\s\S]{0,220}syncStatus: 'syncing'/.test(seasonSyncSource),
    'Season sync status-only transitions must update local sync metadata without rewriting the full local workspace snapshot'
  );
  assert(
    seasonalPageSource.includes("import { filterUiUndoEntriesForSession, trimUiUndoEntries } from '@/lib/uiUndoMemory';") &&
      detailedPageSource.includes("import { filterUiUndoEntriesForSession, trimUiUndoEntries } from '@/lib/uiUndoMemory';") &&
      seasonalPageSource.includes('setModHistory(trimUiUndoEntries(filterUiUndoEntriesForSession([historyEntry, ...modHistory])))') &&
      detailedPageSource.includes('setModHistory(trimUiUndoEntries(filterUiUndoEntriesForSession([historyEntry, ...modHistory])))') &&
      seasonalPageSource.includes('const historyToUndoFrom = modHistory;') &&
      detailedPageSource.includes('const historyToUndoFrom = modHistory;') &&
      !dailyPageSource.includes('const [, setModHistory]') &&
      !gatePageSource.includes('const [, setModHistory]') &&
      !checkInPageSource.includes('const [, setModHistory]'),
    'UI modHistory must be capped where Undo is rendered and not retained in pages without Undo UI'
  );
  assert(
    appRouteCacheSource.includes('const MAX_CACHED_ROUTE_ENTRIES = 5') &&
      appRouteCacheSource.includes("const ALLOCATION_CACHE_PATHS = new Set(['/checkin', '/gate'])") &&
      appRouteCacheSource.includes('const seasonId = params.get(') &&
      appRouteCacheSource.includes('return seasonId ? `${pathname}?season=${seasonId}` : pathname;') &&
      appRouteCacheSource.includes('function trimCachedRouteEntries') &&
      appRouteCacheSource.includes('entries.length <= MAX_CACHED_ROUTE_ENTRIES') &&
      appRouteCacheSource.includes('entries.filter((entry) => entry.key !== activeKey)') &&
      appRouteCacheSource.includes('return trimCachedRouteEntries([...entriesWithoutActive, nextEntry], activeCacheKey);') &&
      appRouteCacheSource.includes('const visibleEntries = useMemo(() =>') &&
      appRouteCacheSource.includes('cachedEntries.map((entry) => entry.key === activeCacheKey ? activeEntry : entry)') &&
      appRouteCacheSource.includes('return trimCachedRouteEntries(entries, activeCacheKey);') &&
      appRouteCacheSource.includes('<RouteCacheProvider active={active} cacheKey={entry.key} search={entry.search}>'),
    'App route cache must cap inactive cached route panels and normalize Check-in/Gate cache keys by season while preserving live search params'
  );
  assert(
    homePageSource.includes("import DashboardPage from './dashboard/page';") &&
      homePageSource.includes('<DashboardPage routeBase="/" />') &&
      seasonalRouteSource.includes("export { default } from '../SeasonalSchedulePage';") &&
      dashboardPageSource.includes("routeBase?: '/' | '/dashboard'") &&
      dashboardPageSource.includes('const dashboardRoute = routeBase;'),
    'Homepage must render the dashboard while preserving Seasonal Schedule on the /seasonal route'
  );
  assert(
    layoutSource.includes('<AppShell>{children}</AppShell>') &&
      appShellSource.includes('<AppSidebar />') &&
      appShellSource.includes('<AppRouteCache>{children}</AppRouteCache>') &&
      appShellSource.includes('app-shell-content') &&
      globalCssSource.includes('.app-shell-content aside') &&
      globalCssSource.includes('display: none !important') &&
      globalCssSource.includes('.app-shell-content .ml-64'),
    'Root layout must provide one global app shell and neutralize legacy route-local sidebar offsets'
  );
  assert(
    !appSidebarSource.includes("import Link from 'next/link'") &&
      appSidebarSource.includes('useRouter') &&
      appSidebarSource.includes('const router = useRouter();') &&
      appSidebarSource.includes('const navigateTo = useCallback((href: string) => {') &&
      appSidebarSource.includes('router.push(href);') &&
      appSidebarSource.includes('type="button"') &&
      appSidebarSource.includes('onClick={() => navigateTo(item.href)}') &&
      !appSidebarSource.includes('<a ') &&
      !appSidebarSource.includes('<Link') &&
      appSidebarSource.includes('usePathname') &&
      appSidebarSource.includes("{ href: '/', label: 'Dashboard'") &&
      appSidebarSource.includes("{ href: '/seasonal', label: 'Seasonal Schedule'") &&
      appSidebarSource.indexOf("{ href: '/', label: 'Dashboard'") < appSidebarSource.indexOf("{ href: '/seasonal', label: 'Seasonal Schedule'") &&
      appSidebarSource.includes("const MODULE_PATHS = new Set(NAV_ITEMS.map((item) => item.href));") &&
      appSidebarSource.includes('appSidebarCollapsed') &&
      appSidebarSource.includes("data-collapsed={collapsed ? 'true' : 'false'}") &&
      appSidebarSource.includes('relative z-40') &&
      !appSidebarSource.includes('relative z-[1100]') &&
      appSidebarSource.includes('onPointerDown={handleTogglePointerDown}') &&
      appSidebarSource.includes('ignoreNextClickRef') &&
      ['Seasonal Schedule', 'Dashboard', 'Detailed Schedule', 'Daily Schedule', 'Check-in Allocation', 'Gate Allocation', 'Audit Log', 'Settings'].every((label) => appSidebarSource.includes(label)),
    'Global sidebar must be a persistent client-side navigation component with a collapsible icon-only mode and uniform menu items'
  );
  assert(
    appDialogSource.includes('zIndex: 1000') &&
      appSidebarSource.includes('relative z-40') &&
      !appSidebarSource.includes('relative z-[1100]'),
    'Global sidebar must stay below route-level dialogs and export previews so modal content is not covered by navigation'
  );
  assert(
    ![
      seasonalPageSource,
      dashboardPageSource,
      detailedPageSource,
      dailyPageSource,
      checkInPageSource,
      gatePageSource,
      settingsPageSource,
      appSidebarSource,
    ].some((source) =>
      source.includes('window.location') ||
      source.includes('location.href') ||
      source.includes('location.assign') ||
      source.includes('location.replace')
    ),
    'Module tab navigation must stay on Next client routing instead of browser document navigation'
  );
  assert( 
    appSidebarSource.includes('if (querySeasonId) return querySeasonId;') && 
      appSidebarSource.indexOf('if (querySeasonId) return querySeasonId;') < appSidebarSource.indexOf("if (typeof window === 'undefined') return null;") && 
      appSidebarSource.includes('const [collapsed, setCollapsed] = useState(false);') && 
      appSidebarSource.includes("sessionStorage.getItem(SIDEBAR_COLLAPSED_KEY) === 'true'"), 
    'Global sidebar must keep the first client render hydration-stable while restoring query season and collapse state after mount' 
  ); 
  assert(
    appSidebarSource.includes('function scheduleAfterHydration') &&
      appSidebarSource.includes('window.requestAnimationFrame') &&
      appSidebarSource.includes('window.cancelAnimationFrame') &&
      !appSidebarSource.includes('const timeoutId = window.setTimeout(() => {\n      setCollapsed'),
    'Global sidebar must defer persisted collapse restoration until after hydration so route changes do not regenerate the tree'
  );
  assert(
    appSidebarSource.includes('APP_SIDEBAR_LAST_MODULE_ROUTE_PREFIX') &&
      appSidebarSource.includes('type LastModuleRoutes') &&
      appSidebarSource.includes('function readStoredModuleRoutes') &&
      appSidebarSource.includes('function getPreservedModuleHref') &&
      appSidebarSource.includes('sessionStorage.setItem(`${APP_SIDEBAR_LAST_MODULE_ROUTE_PREFIX}${pathname}`, currentHref)') &&
      appSidebarSource.includes('getPreservedModuleHref(item.href, activeSeasonId, lastModuleRoutes)'),
    'Global sidebar must navigate back to the last cached module URL, including Detailed Schedule filters, instead of collapsing routes to season-only hrefs'
  );
  assert(
    pbbIconSource.includes('Passenger boarding bridge') &&
      appSidebarSource.includes("import PbbIcon from './PbbIcon';") &&
      appSidebarSource.includes("{ href: '/gate', label: 'Gate Allocation', icon: 'pbb' }") &&
      appSidebarSource.includes("item.icon === 'pbb'") &&
      !appSidebarSource.includes('door_front'),
    'Gate Allocation navigation must use a passenger boarding bridge icon instead of the generic door icon'
  );
  assert( 
    appRouteCacheSource.includes('type CachedRouteEntry') && 
      appRouteCacheSource.includes('usePathname') && 
      appRouteCacheSource.includes('useSearchParams') && 
      appRouteCacheSource.includes('setCachedEntries') && 
      appRouteCacheSource.includes('data-route-cache-key') &&
      appRouteCacheSource.includes('data-route-cache-active') &&
      appRouteCacheSource.includes('<RouteCacheProvider') &&
      routeCacheContextSource.includes('useCachedRouteSearchParams') &&
      routeCacheContextSource.includes('useCachedRouteActivity') &&
      globalCssSource.includes('.app-route-cache-panel[data-route-cache-active="false"]'), 
    'App shell must keep visited module routes mounted as inactive cached panels with per-route search params' 
  ); 
  assert(
      globalCssSource.includes('.app-route-cache-panel[data-route-cache-active="false"]') &&
      globalCssSource.includes('display: none;') &&
      appDialogSource.includes('useCachedRouteActivity') &&
      appDialogSource.includes('window.setTimeout(() => setDialog(null), 0)') &&
      appDialogSource.includes('if (!dialog || !isRouteActive) return null;'),
    'Inactive cached route panels and their body-level dialog portals must not block interaction on the active tab'
  );
  assert(
    appRouteCacheSource.includes("import CheckInAllocationPage from '../checkin/page';") &&
      appRouteCacheSource.includes("import GateAllocationPage from '../gate/page';") &&
      appRouteCacheSource.includes('function renderCachedRouteModule') &&
      appRouteCacheSource.includes("case '/checkin':") &&
      appRouteCacheSource.includes('return <CheckInAllocationPage />;') &&
      appRouteCacheSource.includes("case '/gate':") &&
      appRouteCacheSource.includes('return <GateAllocationPage />;') &&
      !appRouteCacheSource.includes('children: ReactNode;') &&
      appRouteCacheSource.includes('const entriesWithoutActive = entries.filter((entry) => entry.key !== activeCacheKey);') &&
      appRouteCacheSource.includes('return trimCachedRouteEntries([...entriesWithoutActive, nextEntry], activeCacheKey);') &&
      appRouteCacheSource.includes('const visibleEntries = useMemo(() =>') &&
      !appRouteCacheSource.includes('children: entry.key === activeCacheKey ? children : entry.children') &&
      !appRouteCacheSource.includes('return entries.map((entry) => (entry.key === activeCacheKey ? activeEntry : entry));'),
    'App route cache must render cached module instances independently from current Next route children'
  );
  assert( 
    !checkInPageSource.includes("useRouter, useSearchParams") && 
      !gatePageSource.includes("useRouter, useSearchParams") && 
      !dailyPageSource.includes("useRouter, useSearchParams") &&
      !dashboardPageSource.includes("useRouter, useSearchParams") &&
      !detailedPageSource.includes("useRouter, useSearchParams") &&
      [checkInPageSource, gatePageSource, dailyPageSource, dashboardPageSource, detailedPageSource, settingsPageSource].every((source) => source.includes('useCachedRouteSearchParams')) &&
      checkInPageSource.includes('useCachedRouteActivity') &&
      gatePageSource.includes('useCachedRouteActivity') &&
      detailedPageSource.includes('useCachedRouteActivity') &&
      [checkInPageSource, gatePageSource, detailedPageSource].every((source) => source.includes('if (!isRouteActive) return undefined;')),
    'Cached module pages must read their own cached search params and disable global listeners while inactive'
  );
  assert(
    sessionStateHookSource.includes('sessionStorage.getItem(key)') &&
      sessionStateHookSource.includes('sessionStorage.setItem(key, JSON.stringify(value))') &&
      sessionScrollHookSource.includes('requestAnimationFrame') &&
      sessionScrollHookSource.includes('scrollLeft') &&
      sessionScrollHookSource.includes('scrollTop') &&
      checkInPageSource.includes("useSessionState('checkin:fromDateTime'") &&
      checkInPageSource.includes("'checkin:timelinePixelsPerMinute'") &&
      checkInPageSource.includes("useSessionScrollRestoration('checkin:gantt-scroll'") &&
      gatePageSource.includes("useSessionState('gate:fromDateTime'") &&
      gatePageSource.includes("'gate:timelinePixelsPerMinute'") &&
      gatePageSource.includes("useSessionScrollRestoration('gate:gantt-scroll'") &&
      dailyPageSource.includes("useSessionState<DailyFilterState>('daily:filters'") &&
      dailyPageSource.includes("function handleAllocationNavigation(path: '/checkin' | '/gate')") &&
      dailyPageSource.includes("params.set('from', fromDateTime)") &&
      dailyPageSource.includes("params.set('to', toDateTime)") &&
      dailyPageSource.includes("router.push(`${path}?${params.toString()}`)") &&
      dailyPageSource.includes('title="Open Check-in Allocation for current day range"') &&
      dailyPageSource.includes('title="Open Gate Allocation for current day range"') &&
      dailyPageSource.indexOf('title="Open Check-in Allocation for current day range"') <
        dailyPageSource.indexOf('<div className="flex flex-wrap items-center gap-3 px-4 py-3">') &&
      dailyPageSource.indexOf('title="Open Gate Allocation for current day range"') <
        dailyPageSource.indexOf('<div className="flex flex-wrap items-center gap-3 px-4 py-3">') &&
      checkInPageSource.includes("const requestedRange = readDailyDateRangeQuery(searchParams);") &&
      checkInPageSource.includes('requestedRange ?? buildDefaultDailyDateRange(todayIso())') &&
      checkInPageSource.includes('const rangeKey = `${requestedRange.from}|${requestedRange.to}`;') &&
      checkInPageSource.includes('setFromDateTime(requestedRange.from)') &&
      checkInPageSource.includes('setToDateTime(requestedRange.to)') &&
      gatePageSource.includes("const requestedRange = readDailyDateRangeQuery(searchParams);") &&
      gatePageSource.includes('requestedRange ?? buildDefaultDailyDateRange(todayIso())') &&
      gatePageSource.includes('const rangeKey = `${requestedRange.from}|${requestedRange.to}`;') &&
      gatePageSource.includes('setFromDateTime(requestedRange.from)') &&
      gatePageSource.includes('setToDateTime(requestedRange.to)') &&
      dailyPageSource.includes("useSessionScrollRestoration('daily:grid-scroll'") &&
      dashboardPageSource.includes("useSessionState<DashboardView>('dashboard:view'") &&
      dashboardPageSource.includes("useSessionScrollRestoration('dashboard:scroll'") &&
      detailedPageSource.includes("useSessionScrollRestoration('detailed:calendar-scroll'") &&
      detailedPageSource.includes('const visibleLegIds = new Set(finalLegs.map((leg) => leg.id));') &&
      detailedPageSource.includes('const preservedVisibleIds = Array.from(prev).filter((id) => visibleLegIds.has(id));') &&
      detailedPageSource.includes('return preservedVisibleIds.length > 0 ? new Set(preservedVisibleIds) : new Set([finalLegs[0].id]);') &&
      settingsPageSource.includes("useSessionState<SettingsTab>('settings:activeTab'"),
    'Main modules must preserve filter/control state and scroll positions within the current browser session'
  );
  assert(
    seasonDataCacheSource.includes('subscribeSeasonWorkspaceChanges') &&
      seasonDataCacheSource.includes('publishSeasonWorkspaceChanged') &&
      seasonDataCacheSource.includes('eventSeq') &&
      seasonWorkspaceRefreshHookSource.includes('subscribeSeasonWorkspaceChanges') &&
      !seasonWorkspaceRefreshHookSource.includes('loadLocalSeasonWorkspace') &&
      seasonWorkspaceRefreshHookSource.includes('onNativeRefresh') &&
      seasonWorkspaceRefreshHookSource.includes("policy: 'background' | 'on-activation'") &&
      seasonWorkspaceRefreshHookSource.includes('useCachedRouteActivity') &&
      seasonWorkspaceRefreshHookSource.includes('function isSameWorkspaceChangeSource') &&
      seasonWorkspaceRefreshHookSource.includes('eventSource.startsWith(`${ownSource}-`)') &&
      seasonWorkspaceRefreshHookSource.includes('isSameWorkspaceChangeSource(event.source, sourceRef.current)') &&
      seasonWorkspaceRefreshHookSource.includes('staleEventRef') &&
      [dailyPageSource, dashboardPageSource, detailedPageSource, seasonalPageSource, checkInPageSource, gatePageSource].every((source) =>
        source.includes('useSeasonWorkspaceRefresh') && source.includes("policy: 'on-activation'")
      ),
    'Cached flight-data modules must subscribe to same-session season workspace changes and refresh inactive route panels via native invalidation only on activation'
  );
  assert(
    [seasonalPageSource, detailedPageSource, dailyPageSource, checkInPageSource, gatePageSource].every((source) =>
      source.includes('publishSeasonWorkspaceChanged(')
    ) &&
      checkInWorkerSource.includes('syncMeta') &&
      checkInWorkerSource.includes('affectedIds') &&
      gateWorkerSource.includes('syncMeta') &&
      gateWorkerSource.includes('affectedIds') &&
      checkInPageSource.includes("'checkin-worker'") &&
      gatePageSource.includes("'gate-worker'"),
    'All flight-data write paths, including Check-in and Gate workers, must publish season workspace changes for other cached tabs'
  );
  assert(
    seasonSyncProviderSource.includes('const WORKSPACE_CHANGE_DEBOUNCE_MS = 200') &&
      seasonSyncProviderSource.includes('pendingWorkspaceChangeSeasonIdsRef') &&
      seasonSyncProviderSource.includes('pendingWorkspaceChangeSourcesRef') &&
      seasonSyncProviderSource.includes('workspaceChangeDebounceTimerRef') &&
      seasonSyncProviderSource.includes('window.clearTimeout(workspaceChangeDebounceTimerRef.current)') &&
      seasonSyncProviderSource.includes('window.setTimeout(() =>') &&
      seasonSyncProviderSource.includes('WORKSPACE_CHANGE_DEBOUNCE_MS') &&
      seasonSyncProviderSource.includes('const seasonIds = Array.from(pendingWorkspaceChangeSeasonIdsRef.current)') &&
      seasonSyncProviderSource.includes('const source = pendingWorkspaceChangeSourcesRef.current.get(seasonId)') &&
      seasonSyncProviderSource.includes('pendingWorkspaceChangeSourcesRef.current.delete(seasonId)') &&
      seasonSyncProviderSource.includes('void queryNativeSyncSummary(seasonId).then((summary) =>') &&
      seasonSyncProviderSource.includes('source,'),
    'SeasonSyncProvider must debounce rapid workspace-change notifications into one native sync-summary read and scheduler notification per season'
  );
  const useSeasonSyncStart = seasonSyncProviderSource.indexOf('export function useSeasonSync(');
  const useSeasonSyncEnd = seasonSyncProviderSource.indexOf('export function useSeasonSyncActions', useSeasonSyncStart + 1);
  const useSeasonSyncSource = useSeasonSyncStart >= 0 && useSeasonSyncEnd > useSeasonSyncStart
    ? seasonSyncProviderSource.slice(useSeasonSyncStart, useSeasonSyncEnd)
    : '';
  assert(
    useSeasonSyncSource.includes('context.ensureLiveSeason(seasonId)') &&
      !useSeasonSyncSource.includes('getPendingSyncSummary') &&
      !useSeasonSyncSource.includes('notifyLocalChange'),
    'useSeasonSync mount must not auto-prime existing IndexedDB pending work into the auto-sync scheduler'
  );
  assert(
    localSeasonStoreSource.includes('export async function discardLocalPendingChanges') &&
      localSeasonStoreSource.includes('rows: cloneJson(workspace.baseRows)') &&
      localSeasonStoreSource.includes('records: cloneJson(workspace.baseRecords)') &&
      localSeasonStoreSource.includes('modifications: deserializeModificationEntries(workspace.baseModificationEntries)') &&
      localSeasonStoreSource.includes('modHistory: cloneJson(workspace.baseModHistory)') &&
      localSeasonStoreSource.includes('pendingOps: []') &&
      localSeasonStoreSource.includes("syncStatus: conflictCount > 0 ? 'needs_review' : 'synced'"),
    'localSeasonStore must expose a discard helper that restores baseline data and clears only pending local sync state'
  );
  assert(
    localSeasonStoreSource.includes('const memoryLocalSeasonWorkspaces') &&
      localSeasonStoreSource.includes('getOptionalSqlDbForLocalStore') &&
      localSeasonStoreSource.includes('export async function clearAllLocalSeasonWorkspaces') &&
      localSeasonStoreSource.includes('clearLocalSeasonSqlWorkspaces(sqlDb)') &&
      localSeasonStoreSource.includes('memoryLocalSeasonWorkspaces.clear()') &&
      localSeasonStoreSource.includes('export async function discardAllLocalPendingChanges') &&
      localSeasonStoreSource.includes('listLocalSeasonSqlPendingSummaries') &&
      localSeasonStoreSource.includes('discardLocalSeasonSqlPendingChanges') &&
      localSeasonSqlStoreSource.includes('export async function listLocalSeasonSqlPendingSummaries') &&
      localSeasonSqlStoreSource.includes('export async function discardLocalSeasonSqlPendingChanges') &&
      appSessionCleanupSource.includes('export async function clearNativeAppSessionData') &&
      appSessionCleanupSource.includes('export function clearNativeAppEphemeralData') &&
      !appSessionCleanupSource.includes('clearAllLocalSeasonWorkspaces()') &&
      appSessionCleanupSource.includes('discardAllLocalPendingChanges') &&
      appSessionCleanupSource.includes('resetUiUndoSession') &&
      appSessionCleanupSource.includes('clearSeasonDataCache()') &&
      appSessionCleanupSource.includes("key.startsWith('sb-')") &&
      appSessionCleanupSource.includes("key.startsWith('dashboard:aiNotebook:')") &&
      appSessionCleanupSource.includes("key.startsWith('season-sync:')") &&
      !appSessionCleanupSource.includes('LOCAL_CLIENT_STORAGE_KEY') &&
      !appSessionCleanupSource.includes('resetSeasonClientIdMemory') &&
      nativeCloseCleanupGuardSource.includes('export default function NativeCloseCleanupGuard') &&
      !nativeCloseCleanupGuardSource.includes("import { isTauri } from '@tauri-apps/api/core';") &&
      !nativeCloseCleanupGuardSource.includes('isTauri()') &&
      nativeCloseCleanupGuardSource.includes("import('@tauri-apps/api/window')") &&
      nativeCloseCleanupGuardSource.includes('appWindow.onCloseRequested') &&
      nativeCloseCleanupGuardSource.includes('event.preventDefault()') &&
      nativeCloseCleanupGuardSource.includes('if (!confirmed)') &&
      nativeCloseCleanupGuardSource.indexOf('const confirmed = await showConfirm') < nativeCloseCleanupGuardSource.indexOf('if (!confirmed)') &&
      nativeCloseCleanupGuardSource.includes('Close App') &&
      nativeCloseCleanupGuardSource.includes('Discarding local session edits') &&
      nativeCloseCleanupGuardSource.includes('clearNativeAppSessionData({') &&
      nativeCloseCleanupGuardSource.includes('discardPendingLocalChanges: true') &&
      nativeCloseCleanupGuardSource.includes('resetUndoSession: true') &&
      nativeCloseCleanupGuardSource.includes('CLOSE_CLEANUP_TIMEOUT_MS') &&
      nativeCloseCleanupGuardSource.includes('Promise.race') &&
      nativeCloseCleanupGuardSource.includes("status: 'timeout'") &&
      nativeCloseCleanupGuardSource.includes("status: 'failed'") &&
      nativeCloseCleanupGuardSource.includes('w-full max-w-sm') &&
      nativeCloseCleanupGuardSource.includes("width: 'min(420px, calc(100vw - 32px))'") &&
      nativeCloseCleanupGuardSource.includes("flex: '0 0 min(420px, calc(100vw - 32px))'") &&
      nativeCloseCleanupGuardSource.includes('await appWindow.destroy()') &&
      !nativeCloseCleanupGuardSource.includes('await appWindow.close()') &&
      tauriDefaultCapabilitySource.includes('"windows": ["main"]') &&
      tauriDefaultCapabilitySource.includes('"core:default"') &&
      tauriDefaultCapabilitySource.includes('"core:window:allow-destroy"') &&
      appShellSource.includes('<NativeCloseCleanupGuard />') &&
      appShellSource.indexOf('<NativeCloseCleanupGuard />') < appShellSource.indexOf('<OperatorAuthGate>') &&
      !nativeCloseCleanupGuardSource.includes('__TAURI_INTERNALS__') &&
      !seasonSyncProviderSource.includes('UNSYNCED_DISCARD_MARKER_KEY') &&
      !seasonSyncProviderSource.includes('consumePendingDiscardSeasonIds') &&
      !seasonSyncProviderSource.includes('writePendingDiscardSeasonIds') &&
      !seasonSyncProviderSource.includes('discardSessionPendingChanges') &&
      !seasonSyncProviderSource.includes('appWindow.onCloseRequested') &&
      !seasonSyncProviderSource.includes('handlePageHide') &&
      !seasonSyncProviderSource.includes("window.addEventListener('pagehide'") &&
      !seasonSyncProviderSource.includes("window.removeEventListener('pagehide'") &&
      !seasonSyncProviderSource.includes("window.addEventListener('beforeunload', handleBeforeUnload)") &&
      !seasonSyncProviderSource.includes('event.returnValue') &&
      !seasonSyncProviderSource.includes('startupDiscardReady'),
    'Native app close cleanup must preserve the database while discarding pending local edits and Undo history'
  );
  assert(
    appShellSource.includes("import NativeStartupSessionReset from './NativeStartupSessionReset';") &&
      appShellSource.includes('<NativeStartupSessionReset>') &&
      appShellSource.includes('</NativeStartupSessionReset>') &&
      appShellSource.indexOf('<NativeStartupSessionReset>') < appShellSource.indexOf('<OperatorAuthGate>') &&
      nativeStartupSessionResetSource.includes('export default function NativeStartupSessionReset') &&
      nativeStartupSessionResetSource.includes("import('@tauri-apps/api/core')") &&
      nativeStartupSessionResetSource.includes('isTauri()') &&
      nativeStartupSessionResetSource.includes('clearNativeAppEphemeralData({ preserveAuth: true })') &&
      nativeStartupSessionResetSource.includes('resetUiUndoSession()') &&
      !nativeStartupSessionResetSource.includes('clearNativeAppSessionData') &&
      !nativeStartupSessionResetSource.includes('discardPendingLocalChanges') &&
      !nativeStartupSessionResetSource.includes('STARTUP_CLEANUP_TIMEOUT_MS') &&
      !nativeStartupSessionResetSource.includes('Promise.race') &&
      nativeStartupSessionResetSource.includes('setReady(true)') &&
      nativeStartupSessionResetSource.includes('LoadingStatusPanel') &&
      nativeStartupSessionResetSource.includes('buildLoadProgress') &&
      !nativeStartupSessionResetSource.includes('Starting fresh session...') &&
      tauriCargoSource.includes('tauri-plugin-single-instance') &&
      tauriLibSource.includes('tauri_plugin_single_instance::init') &&
      tauriLibSource.includes('get_webview_window("main")') &&
      tauriLibSource.includes('window.set_focus()'),
    'Native startup must clear only ephemeral UI/Undo state; pending local edits are discarded by the native close guard, not by first-open cleanup'
  );
  assert(
    nativeCatchupRustSource.includes('static SQLITE_SCHEMA_INIT_LOCK') &&
      nativeCatchupRustSource.includes('fn is_sqlite_lock_error') &&
      nativeCatchupRustSource.includes('ErrorCode::DatabaseBusy') &&
      nativeCatchupRustSource.includes('ErrorCode::DatabaseLocked') &&
      nativeCatchupRustSource.includes('fn initialize_native_db_connection') &&
      nativeCatchupRustSource.includes('std::thread::sleep') &&
      nativeCatchupRustSource.includes('schema init retry') &&
      nativeCatchupRustSource.includes('initialize_native_db_connection(&conn)'),
    'Native SQLite schema initialization must be serialized and retry database-locked failures on fresh installs'
  );
  assert(
    loadingStatusPanelSource.includes('export default function LoadingStatusPanel') &&
      loadingStatusPanelSource.includes('progress.indeterminate') &&
      loadingStatusPanelSource.includes('role="progressbar"') &&
      loadingStatusPanelSource.includes('aria-valuenow') &&
      loadingStatusPanelSource.includes('w-[min(28rem,calc(100vw-3rem))]') &&
      loadingStatusPanelSource.includes('min-w-[min(20rem,calc(100vw-3rem))]') &&
      loadingStatusPanelSource.includes('text-balance') &&
      loadingStatusPanelSource.includes('w-full min-w-0') &&
      [
        nativeStartupSessionResetSource,
        seasonalPageSource,
        dailyPageSource,
        detailedPageSource,
        checkInPageSource,
        gatePageSource,
        dashboardPageSource,
        settingsPageSource,
        auditPageSource,
      ].every((source) => source.includes('LoadingStatusPanel')) &&
      [
        seasonalPageSource,
        dailyPageSource,
        detailedPageSource,
        checkInPageSource,
        gatePageSource,
        dashboardPageSource,
      ].every((source) => source.includes('buildLoadProgress')),
    'Cold-start and heavy module loading states must use LoadingStatusPanel with a visible progress/status bar'
  );
  assert(
    seasonAutoSyncSource.includes("status: 'dirty'") &&
      seasonAutoSyncSource.includes("message: summary.pendingCount === 0 ? null : 'Unsynced local changes. Use Save to push them to the server.'") &&
      seasonAutoSyncSource.includes('getAutoSyncRetryDelayMs(retryAttempt: number): number | null') &&
      seasonAutoSyncSource.includes('return null;') &&
      !seasonAutoSyncSource.includes('this.schedule(seasonId, AUTO_SYNC_DEBOUNCE_MS)') &&
      !seasonAutoSyncSource.includes('this.schedule(seasonId, retryDelay)') &&
      !seasonAutoSyncSource.includes("status: 'scheduled'") &&
      !seasonAutoSyncSource.includes("'Auto syncing'") &&
      !seasonAutoSyncSource.includes("'Auto sync scheduled'"),
    'SeasonAutoSyncScheduler must be manual-only: local changes stay dirty, no debounce auto-run, and transient failures do not retry automatically'
  );
  assert(
    appShellSource.includes('useSeasonSyncSessionWarning') &&
      appShellSource.includes('function SeasonSyncSessionWarningBanner') &&
      appShellSource.includes('function SeasonSyncStartupCatchUpStatus') &&
      appShellSource.includes('<SeasonSyncSessionWarningBanner />') &&
      appShellSource.includes('<SeasonSyncStartupCatchUpStatus />') &&
      !appShellSource.includes("import LoadingStatusPanel from './LoadingStatusPanel';") &&
      !appShellSource.includes('<LoadingStatusPanel') &&
      appShellSource.includes('h-0.5') &&
      appShellSource.includes('Updating in background') &&
      appShellSource.includes('Refreshing server snapshot') &&
      appShellSource.includes('You can switch modules safely.') &&
      appShellSource.includes('Closing the app discards unsynced edits but keeps downloaded season data.') &&
      !appShellSource.includes('reloading this tab will discard local unsynced changes.'),
    'AppShell must render warning and compact non-card catch-up status surfaces without blocking module navigation'
  );
  assert(
    appShellSource.indexOf('<AppSidebar />') < appShellSource.indexOf('<SeasonSyncProvider>') &&
      appShellSource.indexOf('<SeasonSyncSessionWarningBanner />') > appShellSource.indexOf('<SeasonSyncProvider>') &&
      appShellSource.indexOf('<AppRouteCache>{children}</AppRouteCache>') > appShellSource.indexOf('<SeasonSyncProvider>'),
    'AppSidebar must stay outside SeasonSyncProvider so dirty sync state cannot block module navigation'
  );
  assert(
    seasonSyncProviderSource.includes('const seasonSyncStateStore = createSeasonSyncStateStore();') &&
      seasonSyncProviderSource.includes('const seasonSyncWarningStore = createSeasonSyncWarningStore();') &&
      !seasonSyncProviderSource.includes('states: Record<string, SeasonAutoSyncState>') &&
      !seasonSyncProviderSource.includes('sessionPendingSeasonIds: string[];') &&
      !seasonSyncProviderSource.includes('const [states, setStates]') &&
      !seasonSyncProviderSource.includes('const [sessionPendingSeasonIds, setSessionPendingSeasonIds]') &&
      seasonSyncProviderSource.includes('useSyncExternalStore') &&
      seasonSyncProviderSource.includes('seasonSyncStateStore.subscribe(seasonId, listener)') &&
      seasonSyncProviderSource.includes('seasonSyncWarningStore.subscribe') &&
      !seasonSyncProviderSource.includes("message: 'Checking server changes.'") &&
      !seasonSyncProviderSource.includes("progress: 'Checking server changes'") &&
      seasonSyncProviderSource.includes('const isRouteActive = useCachedRouteActivity();') &&
      seasonSyncProviderSource.includes('if (!seasonId || !context || !isRouteActive) return undefined;'),
    'SeasonSyncProvider must publish sync state through per-season external stores so inactive cached pages and global navigation are not invalidated by dirty state'
  );
  assert(
    seasonSyncSource.includes('export const SNAPSHOT_CATCHUP_BACKLOG_THRESHOLD = 100') &&
      seasonSyncSource.includes('export const MAX_EVENT_REPLAY_BACKLOG = SNAPSHOT_CATCHUP_BACKLOG_THRESHOLD') &&
      !seasonSyncProviderSource.includes('SNAPSHOT_CATCHUP_BACKLOG_THRESHOLD') &&
      !seasonSyncProviderSource.includes('backlog > SNAPSHOT_CATCHUP_BACKLOG_THRESHOLD') &&
      seasonSyncProviderSource.includes('runNativeSeasonCatchup') &&
      seasonSyncProviderSource.includes("'native-catchup'") &&
      seasonSyncProviderSource.includes('quiet?: boolean') &&
      seasonSyncProviderSource.includes('blockingUi?: boolean') &&
      seasonSyncProviderSource.includes('const getBlockedGuard = useCallback') &&
      seasonSyncProviderSource.includes('if (!blockedGuard.quiet)') &&
      seasonSyncProviderSource.includes('MANUAL_FETCH_REPLAY_EVENT_WINDOW') &&
      seasonSyncProviderSource.includes('replayingRecentEvents') &&
      seasonSyncProviderSource.includes('localCursor: catchUpStartSeq') &&
      seasonSyncProviderSource.includes('reconcileManifest: manualFetch') &&
      seasonSyncProviderSource.includes('Updating in background: 0 / ${catchUpBacklog}') &&
      seasonSyncProviderSource.includes('checkNativeSeasonIntegrity') &&
      seasonSyncProviderSource.includes('Native server update fetch is unavailable.') &&
      !seasonSyncProviderSource.includes('let didApplyPagedEvents = false') &&
      !seasonSyncProviderSource.includes('didApplyPagedEvents = true') &&
      !seasonSyncProviderSource.includes('if (didApplyPagedEvents)') &&
      seasonSyncProviderSource.includes("source: 'manual-sync'") &&
      seasonSyncProviderSource.includes("reason: 'Manual save running'") &&
      [seasonalPageSource, detailedPageSource, dailyPageSource, checkInPageSource, gatePageSource].every((source) =>
        source.includes("reason: 'Loading server snapshot'") &&
          source.includes('quiet: true') &&
          source.includes('blockingUi: false')
      ),
    'Live catch-up must be background-only, use quiet hydration guards, and prefer native delta replay instead of routine snapshot refresh'
  );
  assert(
    auditLogSource.includes('export type AuditSession') &&
      auditLogSource.includes('export type AuditLogEntry') &&
      auditLogSource.includes('export type AuditDeltaItem') &&
      auditLogSource.includes('export type AuditSyncDelta') &&
      auditLogSource.includes('export type AuditActor') &&
      auditLogSource.includes('getOrCreateAuditSessionId') &&
      auditLogSource.includes('appendAuditLogEntry') &&
      auditLogSource.includes('buildFlightActionAuditEntry') &&
      auditLogSource.includes('buildSyncAuditDelta') &&
      auditLogSource.includes('splitAuditDeltaChunks'),
    'Audit log domain helpers must expose session, entry, delta, sync delta, actor, append, action-delta, sync-delta, and chunking APIs'
  );
  assert(
    firestoreSource.includes('auditSessions') &&
      firestoreSource.includes('saveAuditLogEntry') &&
      firestoreSource.includes('getAuditSessions') &&
      firestoreSource.includes('getAuditLogEntries') &&
      firestoreSource.includes('getAuditDeltaChunks') &&
      firestoreSource.includes('deltaChunks') &&
      firestoreSource.includes('splitAuditDeltaChunks'),
    'Firestore audit persistence must write top-level audit sessions, entry subcollections, and split exact deltas into deltaChunks'
  );
  assert(
    packageJsonSource.includes('"@supabase/supabase-js"') &&
      packageJsonSource.includes('"@tauri-apps/cli"') &&
      packageJsonSource.includes('"tauri"') &&
      packageJsonSource.includes('"native:dev"') &&
      packageJsonSource.includes('"native:build"'),
    'Supabase migration must add Supabase client dependency and Tauri native build scripts'
  );
  assert(
    tauriMainSource.includes('#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]'),
    'Tauri release builds on Windows must use the GUI subsystem so launching the app does not open a console window'
  );
  assert(
    remoteStoreSource.includes('export interface RemoteStore') &&
      remoteStoreSource.includes('export function getRemoteStore') &&
      remoteStoreSource.includes('supabaseStore') &&
      remoteStoreSource.includes('firestoreStore') &&
      [
        seasonalPageSource,
        detailedPageSource,
        dailyPageSource,
        checkInPageSource,
        gatePageSource,
        dashboardPageSource,
        settingsPageSource,
        auditPageSource,
      ].every((source) => !source.includes('@/lib/firestore')),
    'App pages must depend on the backend-neutral RemoteStore instead of importing firestore.ts directly'
  );
  assert(
    supabaseClientSource.includes("from '@supabase/supabase-js'") &&
      supabaseClientSource.includes('NEXT_PUBLIC_SUPABASE_URL') &&
      supabaseClientSource.includes('NEXT_PUBLIC_SUPABASE_ANON_KEY') &&
      supabaseClientSource.includes('boundSupabaseFetch') &&
      supabaseClientSource.includes('globalThis.fetch(input, init)') &&
      supabaseClientSource.includes('global:') &&
      !supabaseClientSource.includes('SERVICE_ROLE') &&
      supabaseStoreSource.includes('export const supabaseStore') &&
      supabaseStoreSource.includes("rpc('sync_season_workspace'") &&
      seasonSyncSource.includes('getRemoteStore()') &&
      seasonSyncSource.includes('syncSeasonWorkspaceRemote') &&
      !seasonSyncSource.includes("import('./firestore')"),
    'Sync must route through Supabase-capable RemoteStore and use a Supabase RPC for atomic workspace sync'
  );
  assert(
    supabaseClientSource.includes('invokeSupabaseFunction') &&
      supabaseClientSource.includes('boundSupabaseFetch(functionUrl') &&
      supabaseStoreSource.includes("invokeSupabaseFunction<Partial<RemoteScheduleNotificationFlushResult>>('schedule-telegram-notify'") &&
      !supabaseStoreSource.includes("functions.invoke('schedule-telegram-notify'"),
    'Schedule Telegram flush must use the shared bound fetch helper instead of the Supabase functions client so notification delivery cannot throw WebView Illegal invocation during schedule sync'
  );
  assert(
    nativeLocalSeasonStoreSource.includes("'scheduleNotification'") &&
      seasonalPageSource.includes('await runNativeScheduleMutation(\n        activeSeason.id,\n        addedRecords,\n        [],\n        regularMods,\n        historyEntry\n      )') &&
      nativeCatchupRustSource.includes('"sourceRow" => {}') &&
      nativeCatchupRustSource.includes('"scheduleNotification".to_string()') &&
      seasonalPageSource.includes('commitDraftBeforeSave') &&
      !seasonalPageSource.includes('Save & Publish') &&
      seasonalPageSource.includes('setDraftState({') &&
      detailedPageSource.includes('await runNativeScheduleMutation(season.id, addedRecords, [], regularMods, historyEntry)') &&
      detailedPageSource.includes('ADD TO DRAFT') &&
      detailedPageSource.includes('commitDraftBeforeSave') &&
      !detailedPageSource.includes('Save & Publish') &&
      !detailedPageSource.includes('description: historyEntry.description,\n        });') &&
      !seasonalPageSource.includes('description: historyEntry.description,\n      });'),
    'Seasonal and Detailed Save must commit drafts with full ModHistoryEntry before upload so scheduleNotification reaches the Supabase Telegram delivery trigger'
  );
  assert(
    detailedPageSource.includes('prefill={null}') &&
      detailedPageSource.includes('prefillLinked={null}') &&
      !detailedPageSource.includes('prefill={legs.length > 0 ? legs[0] : null}') &&
      !detailedPageSource.includes('prefillLinked={legs.length > 0 && legs[0].linkId ? legs.find'),
    'Detailed generic Add Flight must open blank and default to Turnaround instead of inheriting a selected single-leg prefill'
  );
  assert(
    nativeCatchupRustSource.includes('flush_schedule_notifications') &&
      nativeCatchupRustSource.includes('schedule-telegram-notify') &&
      nativeCatchupRustSource.includes('notification_flush_error') &&
      nativeSeasonCatchupSource.includes('notificationFlushError?: string'),
    'Native pending sync must best-effort flush schedule-telegram-notify after successful upload without failing the local sync result'
  );
  assert(
    seasonSyncSource.includes('function flushScheduleNotifications') &&
      seasonSyncSource.includes('try {') &&
      seasonSyncSource.includes('Promise.resolve(remoteStore.flushScheduleNotifications({ seasonId }))') &&
      seasonSyncProviderSource.includes('Promise.resolve(remoteStore.flushScheduleNotifications?.({ seasonId }))'),
    'Schedule Telegram notification flushing must be fully best-effort and must not be able to synchronously fail workspace sync or live catch-up'
  );
  assert(
    seasonSyncProviderSource.includes('function browserSetTimeout') &&
      seasonSyncProviderSource.includes('window.setTimeout(callback, delay)') &&
      seasonSyncProviderSource.includes('function browserClearTimeout') &&
      seasonSyncProviderSource.includes('window.clearTimeout(handle as unknown as number)') &&
      seasonSyncProviderSource.includes('setTimeout: browserSetTimeout') &&
      seasonSyncProviderSource.includes('clearTimeout: browserClearTimeout') &&
      !seasonSyncProviderSource.includes('\n      setTimeout,\n') &&
      !seasonSyncProviderSource.includes('\n      clearTimeout,\n'),
    'SeasonSyncProvider must bind browser timer APIs before passing them to the auto-sync scheduler so manual sync cannot throw WebView Illegal invocation while cancelling a scheduled Detailed sync'
  );
  assert(
    supabaseStoreSource.includes('const SUPABASE_SELECT_PAGE_SIZE = 1000') &&
      supabaseStoreSource.includes('async function selectAllRows') &&
      supabaseStoreSource.includes('.range(from, to)') &&
      supabaseStoreSource.includes('async function countRows') &&
      supabaseStoreSource.includes("select('*', { count: 'exact', head: true })") &&
      supabaseStoreSource.includes('verifySeasonImportCounts') &&
      remoteStoreSource.includes('verifySeasonImportCounts?') &&
      seasonalPageSource.includes('verifySeasonImportCounts') &&
      supabaseStoreSource.includes('Remote import verification failed') &&
      supabaseStoreSource.includes("selectAllRows<FlightRecordRelationalRow>('season_flight_records'") &&
      supabaseStoreSource.includes('readRowsByInFilter') &&
      supabaseStoreSource.includes('selectAllRows<T>(table') &&
      seasonSyncSource.includes('export function isSeasonWorkspaceStale') &&
      seasonWorkspaceBootstrapSource.includes('isSeasonWorkspaceStale') &&
      seasonWorkspaceBootstrapSource.includes('loadOrSeedSeasonWorkspace') &&
      seasonWorkspaceBootstrapSource.includes('forceServer') &&
      seasonWorkspaceBootstrapSource.includes('loadDefaultServerBaseline') &&
      seasonWorkspaceBootstrapSource.includes('clean-stale') &&
      seasonWorkspaceBootstrapSource.includes('dirty-stale') &&
      [detailedPageSource, dailyPageSource, dashboardPageSource].every((source) =>
        source.includes('queryNativeScheduleWindow') && !source.includes("buildLoadProgress('Checking local workspace'")
      ) &&
      [checkInPageSource, gatePageSource].every((source) =>
        source.includes('queryNativeAllocationWindow') && !source.includes("buildLoadProgress('Checking local workspace'")
      ) &&
      seasonalPageSource.includes('queryNativeScheduleWindow') &&
      seasonalPageSource.includes('sourceRows: []') &&
      seasonalPageSource.includes('sourceRows: 0'),
    'Supabase large season reads must be paginated, imports must verify remote counts, and operational routes must use native viewport reads instead of first-open workspace hydration'
  );
  assert(
      seasonChangeEventsSource.includes('buildPendingChangeEvents') &&
      seasonChangeEventsSource.includes('applySeasonEventRange') &&
      seasonChangeEventsSource.includes('workspace.entityVersions') &&
      seasonChangeEventsSource.includes('mergeRemoteSeasonEvent') &&
      seasonChangeEventsSource.includes('resolveSeasonConflict') &&
      seasonChangeEventsSource.includes('__delete__') &&
      localSeasonStoreSource.includes('entityVersions') &&
      localSeasonStoreSource.includes('entityVersions: cloneJson(entityVersions)') &&
      remoteStoreSource.includes('getSeasonEventHighWater') &&
      remoteStoreSource.includes('getSeasonEntityVersions') &&
      remoteStoreSource.includes('throughSeq?: number') &&
      remoteStoreSource.includes('getSeasonWorkspaceSnapshot') &&
      remoteStoreSource.includes("transport?: 'auto' | 'rpc' | 'paged'") &&
      !nativeSeasonBootstrapSource.includes('runNativeSeasonCatchup') &&
      !nativeSeasonBootstrapSource.includes('localCursor: 0') &&
      remoteStoreSource.includes('loadSeasonEventPage') &&
      remoteStoreSource.includes('RemoteSeasonEventPage') &&
      remoteStoreSource.includes('syncSeasonWorkspaceRemoteV2') &&
      remoteStoreSource.includes('loadSeasonEventsSince') &&
      remoteStoreSource.includes('subscribeToSeasonEvents') &&
      supabaseStoreSource.includes('getSeasonEventHighWater') &&
      supabaseStoreSource.includes("rpc('get_season_workspace_snapshot'") &&
      supabaseStoreSource.includes('loadSeasonWorkspaceSnapshotPaged') &&
      supabaseStoreSource.includes('isStatementTimeoutError') &&
      !nativeSeasonBootstrapSource.includes('runNativeSeasonCatchup') &&
      supabaseStoreSource.includes("rpc('get_season_change_event_page'") &&
      supabaseStoreSource.includes('p_through_seq') &&
      supabaseStoreSource.includes('p_limit') &&
      supabaseStoreSource.includes('hasMore') &&
      (supabaseStoreSource.includes("from('season_entity_versions')") ||
        supabaseStoreSource.includes("selectAllRows<SeasonEntityVersionRow>('season_entity_versions'")) &&
      supabaseStoreSource.includes('serverHighWater') &&
      supabaseStoreSource.includes("rpc('sync_season_workspace_v2'") &&
      supabaseStoreSource.includes("from('season_change_events')") &&
      supabaseStoreSource.includes('postgres_changes') &&
      supabaseStoreSource.includes(".channel(`season-change-events:") &&
      seasonSyncSource.includes('buildPendingChangeEvents') &&
      seasonSyncSource.includes('catchUpSeasonWorkspace') &&
      seasonSyncSource.includes('applySeasonEventRange') &&
      seasonSyncSource.includes('createWorkspaceFromRemoteSnapshot') &&
      seasonSyncSource.includes('mergeSnapshotPersistedRecords') &&
      seasonSyncSource.includes('getSeasonEventHighWater') &&
      seasonSyncSource.includes('getSeasonEntityVersions') &&
      seasonSyncSource.includes('getSeasonWorkspaceSnapshot') &&
      seasonSyncSource.includes('loadSeasonEventPage') &&
      seasonSyncSource.includes('SNAPSHOT_CATCHUP_BACKLOG_THRESHOLD') &&
      seasonSyncSource.includes('MAX_EVENT_REPLAY_BACKLOG') &&
      seasonSyncSource.includes('CATCH_UP_EVENT_PAGE_SIZE') &&
      seasonSyncSource.includes('serverHighWater') &&
      !seasonSyncSource.includes('applyServerSeq(finalizeSuccessfulSync') &&
      !seasonSyncSource.includes('remoteStore.loadSeasonEventsSince') &&
      seasonSyncSource.includes('syncSeasonWorkspaceRemoteV2') &&
      seasonWorkspaceBootstrapSource.includes('getSeasonEventHighWater') &&
      seasonWorkspaceBootstrapSource.includes('getSeasonEntityVersions') &&
      seasonWorkspaceBootstrapSource.includes('serverEventHighWater') &&
      seasonWorkspaceBootstrapSource.includes('entityVersions') &&
      [detailedPageSource, dailyPageSource, checkInPageSource, gatePageSource].every((source) =>
        source.includes('queryNative')
      ) &&
      seasonalPageSource.includes('queryNativeScheduleWindow') &&
      seasonalPageSource.includes('sourceRows: 0') &&
      !seasonSyncProviderSource.includes('applySeasonEventRange') &&
      seasonSyncProviderSource.includes('subscribeToSeasonEvents') &&
      !seasonSyncProviderSource.includes('loadSeasonEventPage') &&
      seasonSyncProviderSource.includes('CATCH_UP_EVENT_PAGE_SIZE') &&
      seasonSyncProviderSource.includes('catchUpInFlightRef') &&
      !seasonSyncProviderSource.includes('loadOrSeedSeasonWorkspace') &&
      seasonSyncProviderSource.includes('runNativeSeasonCatchup') &&
      seasonSyncProviderSource.includes("'native-catchup'") &&
      !seasonSyncProviderSource.includes('workspace?.syncMeta.lastServerSeq ?? workspace?.syncMeta.baseServerVersion ?? 0') &&
      !seasonSyncProviderSource.includes('remoteStore.loadSeasonEventsSince(seasonId, lastServerSeq)') &&
      seasonSyncProviderSource.includes('catching_up') &&
      seasonSyncProviderSource.includes('needs_review') &&
      seasonSyncProviderSource.includes('runCatchUpSeason') &&
      seasonSyncProviderSource.includes("status: 'failed'") &&
      seasonSyncProviderSource.includes("status: conflictCount > 0 ? 'needs_review' : (pendingCount > 0 ? 'dirty' : 'live')") &&
      seasonSyncSource.includes('conflictsFromServerRejectedEvents') &&
      seasonSyncSource.includes('withRemotePayload') &&
      seasonSyncSource.includes('localFields: pickFields') &&
      seasonSyncSource.includes('remoteFields: pickFields') &&
      seasonConflictResolutionSource.includes('publishSeasonWorkspaceChanged') &&
      seasonConflictReviewControlSource.includes('queryNativeConflictSummary') &&
      !seasonConflictReviewControlSource.includes('loadLocalSeasonWorkspace') &&
      seasonConflictReviewControlSource.includes('Keep mine') &&
      seasonConflictReviewControlSource.includes('Accept remote') &&
      seasonConflictReviewControlSource.includes('Edit manually') &&
      [seasonalPageSource, detailedPageSource, dailyPageSource, checkInPageSource, gatePageSource].every((source) => source.includes('SeasonConflictReviewControl')),
    'Live local-first sync must expose event-level merge helpers, Supabase v2 RPC, Realtime subscription, catch-up, and review status plumbing'
  );
  assert(
      supabaseSchemaSource.includes('create or replace function public.get_season_workspace_snapshot') &&
      supabaseSchemaSource.includes('create or replace function public.get_season_change_event_page') &&
      supabaseSchemaSource.includes('least(greatest(coalesce(p_limit, 200), 1), 500)') &&
      supabaseSchemaSource.includes("'events', events") &&
      supabaseSchemaSource.includes("'nextCursor'") &&
      supabaseSchemaSource.includes("'hasMore'") &&
      supabaseSchemaSource.includes("'serverHighWater'") &&
      supabaseSchemaSource.includes('grant execute on function public.get_season_workspace_snapshot(text, integer) to authenticated') &&
      supabaseSchemaSource.includes('grant execute on function public.get_season_change_event_page(text, bigint, bigint, integer) to authenticated'),
    'Supabase schema must expose a snapshot RPC and a bounded event-page RPC for catch-up without replaying unbounded season_change_events'
  );
  assert(
      tauriLibSource.includes('run_season_catchup') &&
      tauriLibSource.includes('apply_local_modification_batch_delta') &&
      tauriLibSource.includes('apply_schedule_mutation') &&
      tauriLibSource.includes('apply_allocation_mutation') &&
      tauriLibSource.includes('check_season_integrity') &&
      tauriLibSource.includes('query_season_freshness') &&
      tauriLibSource.includes('merge_season_snapshot') &&
      tauriLibSource.includes('query_schedule_window') &&
      tauriLibSource.includes('query_allocation_window') &&
      tauriLibSource.includes('query_sync_summary') &&
      tauriLibSource.includes('query_conflict_summary') &&
      tauriLibSource.includes('resolve_season_conflict') &&
      tauriLibSource.includes('refresh_season_catchup_token') &&
      tauriLibSource.includes('cancel_season_catchup') &&
      tauriCargoSource.includes('rusqlite') &&
      tauriCargoSource.includes('reqwest') &&
      nativeCatchupRustSource.includes('PRAGMA journal_mode = WAL') &&
      nativeCatchupRustSource.includes('PRAGMA busy_timeout') &&
      nativeCatchupRustSource.includes('wal_checkpoint(PASSIVE)') &&
      nativeCatchupRustSource.includes('season-catchup-token-required') &&
      nativeCatchupRustSource.includes('season-catchup-token-refreshed') &&
      nativeCatchupRustSource.includes('get_season_change_event_page') &&
      nativeCatchupRustSource.includes('fetch_remote_flight_record_manifest') &&
      nativeCatchupRustSource.includes('reconcile_flight_record_manifest_on_connection') &&
      nativeCatchupRustSource.includes('apply_event_page') &&
      nativeCatchupRustSource.includes('apply_local_modification_batch_delta_to_connection') &&
      nativeCatchupRustSource.includes('apply_schedule_mutation_to_connection') &&
      nativeCatchupRustSource.includes('check_season_integrity_on_connection') &&
      nativeCatchupRustSource.includes('query_season_freshness_on_connection') &&
      nativeCatchupRustSource.includes('merge_season_snapshot_on_connection') &&
      nativeCatchupRustSource.includes('resolve_season_conflict_on_connection') &&
      nativeCatchupRustSource.includes('schedule-mutated') &&
      nativeCatchupRustSource.includes('integrity-failed') &&
      nativeCatchupRustSource.includes('lastServerSeq') &&
      nativeSeasonCatchupSource.includes('runNativeSeasonCatchup') &&
      nativeSeasonCatchupSource.includes('reconcileManifest') &&
      nativeSeasonCatchupSource.includes('effectiveTotal') &&
      nativeSeasonCatchupSource.includes('deletedModificationTotal') &&
      nativeSeasonCatchupSource.includes('checkNativeSeasonIntegrity') &&
      nativeSeasonCatchupSource.includes('queryNativeSeasonFreshness') &&
      nativeSeasonCatchupSource.includes('mergeNativeSeasonSnapshot') &&
      nativeSeasonCatchupSource.includes('resolveNativeSeasonConflict') &&
      nativeSeasonCatchupSource.includes('queryNativeScheduleWindow') &&
      nativeLocalSeasonStoreSource.includes('runNativeScheduleMutation') &&
      localSeasonStoreSource.includes('runNativeScheduleMutation') &&
      nativeRuntimeSource.includes('function getTauriGlobal') &&
      nativeSeasonCatchupSource.includes("export { isTauriRuntime } from './nativeRuntime'") &&
      !nativeSeasonCatchupSource.includes("'__TAURI_INTERNALS__' in window") &&
      !nativeSeasonCatchupSource.includes("'__TAURI__' in window") &&
      nativeSeasonCatchupSource.includes('season-catchup-token-required') &&
      nativeSeasonCatchupSource.includes('refresh_season_catchup_token') &&
      nativeSeasonCatchupSource.includes('getSupabaseClient().auth.getSession') &&
      nativeSeasonCatchupSource.includes('getSupabaseClient().auth.refreshSession') &&
      seasonSyncProviderSource.includes('runNativeSeasonCatchup') &&
      seasonSyncProviderSource.includes('checkNativeSeasonIntegrity') &&
      seasonSyncProviderSource.includes('native-baseline-refresh') &&
      seasonSyncProviderSource.includes('native-baseline-merge') &&
      remoteStoreSource.includes('Native desktop runtime requires NEXT_PUBLIC_REMOTE_BACKEND=supabase') &&
      remoteStoreSource.includes('isTauriRuntime()') &&
      !seasonSyncProviderSource.includes('remoteStore.loadSeasonEventPage(seasonId, cursor') &&
      !seasonSyncProviderSource.includes('remoteStore.loadSeasonEventPage?.(seasonId, cursor') &&
      !seasonSyncProviderSource.includes('applySeasonEventRange(currentWorkspace') &&
      !seasonSyncProviderSource.includes('saveLocalSeasonWorkspace(currentWorkspace') &&
      !seasonSyncProviderSource.includes("source: publishSource ?? 'paged-catchup'"),
    'Native catch-up must use Tauri Rust worker, WAL SQLite, token refresh handoff, passive checkpoints, fail closed on desktop, and avoid UI-side event-page replay'
  );
  assert(
    nativeCatchupRustSource.includes('normalize_modification_payload') &&
      nativeCatchupRustSource.includes('deleted_modification_total') &&
      nativeCatchupRustSource.includes('effective_total') &&
      seasonalPageSource.includes('activeDisplayLegs') &&
      seasonalPageSource.includes('flightStats.total') &&
      dashboardPageSource.includes('buildEffectiveDashboardRecords(records, modifications)') &&
      dashboardPageSource.includes('overview.kpis.totalFlights'),
    'Native schedule reads and user-facing flight counters must use normalized modification DTOs and effective totals, not raw rows'
  );
  assert(
    localSeasonStoreSource.includes('nativeFullSaveReason') &&
      localSeasonStoreSource.includes('isNativeFullWorkspaceSaveAllowed') &&
      localSeasonStoreSource.includes('Native desktop full-workspace saves are disabled') &&
      localSeasonStoreSource.includes("'sync-baseline'") &&
      localSeasonStoreSource.includes("'session-discard'") &&
      localSeasonStoreSource.includes("'undo-reset'") &&
      localSeasonStoreSource.includes('runNativeLocalModificationBatchDelta') &&
      localSeasonStoreSource.indexOf('runNativeLocalModificationBatchDelta') < localSeasonStoreSource.indexOf('export async function applyLocalModificationBatch') &&
      seasonWorkspaceBootstrapSource.includes("nativeFullSaveReason: 'server-baseline'") &&
      seasonSyncSource.match(/nativeFullSaveReason: 'sync-baseline'/g)?.length >= 5 &&
      seasonalPageSource.includes('importNativeSeasonSnapshot({') &&
      seasonalPageSource.includes('sourceRows: []') &&
      !seasonalPageSource.includes("nativeFullSaveReason: 'undo-reset'") &&
      detailedPageSource.includes('runNativeScheduleMutation') &&
      !detailedPageSource.includes("nativeFullSaveReason: 'undo-reset'") &&
      localSeasonSqlStoreSource.includes('sqlWriteQueueTail') &&
      localSeasonSqlStoreSource.includes('function enqueueSqlWrite') &&
      localSeasonSqlStoreSource.includes('function beginTransactionWithRecovery') &&
      localSeasonSqlStoreSource.includes('cannot start a transaction within a transaction') &&
      localSeasonSqlStoreSource.includes('db.supportsExplicitTransactions === false') &&
      !seasonSyncProviderSource.includes('saveLocalSeasonWorkspace(currentWorkspace') &&
      !seasonSyncProviderSource.includes("source: publishSource ?? 'paged-catchup'"),
    'Desktop full-workspace SQLite saves must be blocked unless the call is an explicit import, server baseline seed, or repair path'
  );
  assert(
    syncActionButtonSource.includes('export default function SyncActionButton') &&
      syncActionButtonSource.includes('const [clickLocked, setClickLocked] = useState(false)') &&
      syncActionButtonSource.includes('const clickLockedRef = useRef(false)') &&
      syncActionButtonSource.includes('const busy = syncing || clickLocked') &&
      syncActionButtonSource.includes('if (busy || clickLockedRef.current) return;') &&
      syncActionButtonSource.includes('clickLockedRef.current = true') &&
      syncActionButtonSource.includes('aria-busy={busy ?') &&
      syncActionButtonSource.includes('animate-spin') &&
      syncActionButtonSource.includes('min-w-[116px]') &&
      syncActionButtonSource.includes('disabled={busy}') &&
      syncActionButtonSource.includes('setClickLocked(true)') &&
      syncActionButtonSource.includes('clickLockedRef.current = false') &&
      syncActionButtonSource.includes('finally') &&
      syncActionButtonSource.includes("const label = busy ? 'Saving...' : 'Save'") &&
      syncActionButtonSource.includes("title={busy ? progress ?? 'Save in progress' : progress ?? 'Save changes to server'}") &&
      !syncActionButtonSource.includes("'Syncing...'") &&
      !syncActionButtonSource.includes("'Sync now'") &&
      !syncActionButtonSource.includes("'Sync'") &&
      [seasonalPageSource, detailedPageSource, dailyPageSource, checkInPageSource, gatePageSource].every((source) =>
        source.includes('SyncActionButton') &&
        source.includes('pendingCount={syncPendingCount}') &&
        source.includes('progress={syncProgress}')
      ) &&
      [seasonalPageSource, detailedPageSource, dailyPageSource, checkInPageSource, gatePageSource].every(
        (source) => !source.includes("{syncing ? 'Syncing' : syncPendingCount > 0 ? 'Sync now' : 'Sync'}")
      ),
    'All module save buttons must use the shared immediate-lock action button with Save/Saving labels, spinner, aria-busy, and stable width'
  );
  assert(
    seasonAutoSyncSource.includes('prepareSync?: (seasonId: string, mode: AutoSyncMode, source: string | null) => Promise<void> | void') &&
      seasonAutoSyncSource.indexOf('await this.runtime.prepareSync?.(seasonId, mode, record.source);') < seasonAutoSyncSource.indexOf('const pendingCount = await this.runtime.getPendingCount(seasonId);') &&
      seasonSyncProviderSource.includes('prepareSync: async (seasonId, mode, source)') &&
      seasonSyncProviderSource.includes('await guard.beforeSync?.();') &&
      detailedPageSource.includes('beforeSync: commitDraftBeforeSave') &&
      seasonalPageSource.includes('beforeSync: commitDraftBeforeSave') &&
      !detailedPageSource.includes("reason: 'Draft schedule edits are waiting") &&
      !seasonalPageSource.includes("reason: 'Draft schedule edits are waiting"),
    'Manual Save must commit Seasonal/Detailed drafts before pending-count evaluation and before native upload'
  );
  assert(
    detailedPageSource.includes('handleDeleteSelectedLegs') &&
      detailedPageSource.includes("e.key === 'Delete'") &&
      detailedPageSource.includes('handleDeleteSelectedLegs();') &&
      detailedPageSource.includes("confirmLabel=\"ADD TO DRAFT\"") &&
      detailedPageSource.includes('Delete Selected') &&
      dailyPageSource.includes('dailyDeleteShortcutInFlightRef') &&
      dailyPageSource.includes("event.key !== 'Delete'") &&
      dailyPageSource.includes('await handleDeleteSelected();') &&
      dailyPageSource.includes("title: 'Delete Selected Flights'"),
    'Detailed and Daily routes must bind unmodified Delete to the same selected-delete confirmation paths'
  );
  assert(
    fetchServerUpdatesButtonSource.includes('export default function FetchServerUpdatesButton') &&
      fetchServerUpdatesButtonSource.includes('onFetch') &&
      fetchServerUpdatesButtonSource.includes('Fetch Updates') &&
      fetchServerUpdatesButtonSource.includes('Fetching...') &&
      fetchServerUpdatesButtonSource.includes('Fetch latest server updates. Local edits are not uploaded.') &&
      fetchServerUpdatesButtonSource.includes('aria-busy={busy ?') &&
      fetchServerUpdatesButtonSource.includes('animate-spin') &&
      fetchServerUpdatesButtonSource.includes('cloud_sync') &&
      seasonSyncProviderSource.includes('fetchUpdatesNow: (seasonId: string, source: string) => Promise<SyncResult>') &&
      seasonSyncProviderSource.includes('const fetchUpdatesNow = useCallback(async (seasonId: string, source: string)') &&
      seasonSyncProviderSource.includes('manual-fetch') &&
      seasonSyncProviderSource.includes('runManualFetchSeason') &&
      seasonSyncProviderSource.includes("message: 'No server updates found.'") &&
      seasonSyncProviderSource.includes('context.fetchUpdatesNow(seasonId, source)') &&
      seasonSyncProviderSource.includes('syncNow,') &&
      seasonSyncProviderSource.includes('fetchUpdatesNow,') &&
      [seasonalPageSource, detailedPageSource, dailyPageSource, checkInPageSource, gatePageSource, dashboardPageSource].every((source) =>
        source.includes('FetchServerUpdatesButton') &&
        source.includes('fetchUpdatesNow') &&
        source.includes('onFetch={handleFetchUpdates}')
      ) &&
      fetchServerUpdatesButtonSource.indexOf('onFetch') >= 0 &&
      !fetchServerUpdatesButtonSource.includes('syncNow'),
    'Manual server updates must use a separate FetchServerUpdatesButton and SeasonSyncProvider fetchUpdatesNow path instead of overloading local Sync'
  );
  assert(
    appShellSource.includes('OperatorAuthGate') &&
      operatorAuthGateSource.includes('NEXT_PUBLIC_REMOTE_BACKEND') &&
      operatorAuthGateSource.includes("backend === 'supabase'") &&
      operatorAuthGateSource.includes('auth.getSession()') &&
      operatorAuthGateSource.includes('auth.onAuthStateChange') &&
      operatorAuthGateSource.includes('signInWithPassword') &&
      operatorAuthGateSource.includes('signOut') &&
      operatorAuthGateSource.includes("from('app_operators')") &&
      operatorAuthGateSource.includes('Operator access is not enabled for this account') &&
      operatorAuthGateSource.includes('operator-auth-card') &&
      operatorAuthGateSource.includes('operator-auth-control') &&
      globalCssSource.includes('.operator-auth-screen') &&
      globalCssSource.includes('position: fixed') &&
      globalCssSource.includes('width: 100vw') &&
      globalCssSource.includes('width: min(384px, calc(100vw - 48px))') &&
      globalCssSource.includes('.operator-auth-control'),
    'Supabase mode must require an authenticated app operator before rendering a fixed-width login shell'
  );
  assert(
    appRouteCacheSource.includes('memo(') &&
      appRouteCacheSource.includes('function CachedRoutePanel') &&
      appRouteCacheSource.includes('previous.active === next.active') &&
      appRouteCacheSource.includes('previous.entry.key === next.entry.key') &&
      appRouteCacheSource.includes('previous.entry.pathname === next.entry.pathname') &&
      appRouteCacheSource.includes('previous.entry.search === next.entry.search'),
    'Route cache must memoize cached panels so inactive heavy pages do not rerender on unrelated tab switches'
  );
  assert(
    seasonWorkspaceRefreshHookSource.includes('requestIdleCallback') &&
      seasonWorkspaceRefreshHookSource.includes('scheduleActivationRefreshRef') &&
      seasonWorkspaceRefreshHookSource.includes('activationRefreshHandleRef') &&
      seasonWorkspaceRefreshHookSource.includes('cancelIdleCallback') &&
      seasonWorkspaceRefreshHookSource.includes("policyRef.current === 'on-activation'") &&
      seasonWorkspaceRefreshHookSource.includes('isSameWorkspaceChangeSource(event.source, sourceRef.current)'),
    'Workspace refresh must preserve same-source filtering and defer on-activation IndexedDB reloads until after tab activation'
  );
  assert(
    seasonDataCacheSource.includes('cachedOperationalSettings') &&
      seasonDataCacheSource.includes('getCachedOperationalSettings') &&
      seasonDataCacheSource.includes('setCachedOperationalSettings') &&
      seasonDataCacheSource.includes('cachedOperationalSettings = null') &&
      remoteStoreSource.includes('getCachedOperationalSettings') &&
      remoteStoreSource.includes('setCachedOperationalSettings') &&
      remoteStoreSource.includes('const cached = getCachedOperationalSettings()') &&
      remoteStoreSource.includes('setCachedOperationalSettings(settings)'),
    'Operational settings must use the shared in-memory cache and clear it with the app data cache'
  );
  assert(
    supabaseSchemaSource.includes('create table if not exists public.seasons') &&
      supabaseSchemaSource.includes('create table if not exists public.season_source_rows') &&
      supabaseSchemaSource.includes('create table if not exists public.season_flight_records') &&
      supabaseSchemaSource.includes('create table if not exists public.season_modifications') &&
      supabaseSchemaSource.includes('create table if not exists public.season_mod_history_entries') &&
      supabaseSchemaSource.includes('create table if not exists public.season_mod_history_changes') &&
      supabaseSchemaSource.includes('create table if not exists public.operational_settings') &&
      supabaseSchemaSource.includes('create table if not exists public.audit_sessions') &&
      supabaseSchemaSource.includes('create table if not exists public.audit_entries') &&
      supabaseSchemaSource.includes('create table if not exists public.audit_delta_chunks') &&
      supabaseSchemaSource.includes('create table if not exists public.season_change_events') &&
      supabaseSchemaSource.includes('create table if not exists public.season_entity_versions') &&
      supabaseSchemaSource.includes('create or replace function public.sync_season_workspace') &&
      supabaseSchemaSource.includes('create or replace function public.sync_season_workspace_v2') &&
      supabaseSchemaSource.includes('alter publication supabase_realtime add table public.season_change_events') &&
      supabaseSchemaSource.includes('alter table public.seasons enable row level security') &&
      supabaseSchemaSource.includes('to authenticated'),
    'Supabase schema must define app tables, atomic sync RPCs, live event log, entity versions, Realtime publication, indexes, and authenticated RLS policies'
  );
  const tableDefinition = (source, tableName) => {
    const marker = `create table if not exists ${tableName}`;
    const start = source.indexOf(marker);
    assert(start >= 0, `Missing table definition for ${tableName}`);
    const next = source.indexOf('\n\n', start);
    return source.slice(start, next >= 0 ? next : source.length);
  };
  const relationalCoreTables = [
    'public.seasons',
    'public.season_source_rows',
    'public.season_flight_records',
    'public.season_flight_record_counters',
    'public.season_flight_record_checkin_windows',
    'public.season_modifications',
    'public.season_modification_added_legs',
    'public.season_modification_counters',
    'public.season_modification_checkin_windows',
    'public.season_mod_history_entries',
    'public.season_mod_history_changes',
    'public.season_mod_history_record_changes',
    'public.operational_settings',
    'public.operational_route_countries',
    'public.operational_airline_colors',
    'public.operational_aircraft_groups',
    'public.operational_counter_rules',
    'public.operational_checkin_counters',
    'public.operational_checkin_counter_groups',
    'public.operational_checkin_counter_group_members',
    'public.operational_checkin_counter_locks',
    'public.operational_checkin_counter_lock_members',
    'public.operational_gate_resources',
    'public.operational_gate_groups',
    'public.operational_gate_group_members',
    'public.operational_gate_locks',
    'public.operational_gate_lock_members',
    'public.operational_stand_gate_mappings',
    'public.operational_ai_models',
  ];
  for (const tableName of relationalCoreTables) {
    assert(
      !/\bpayload\s+jsonb\b/i.test(tableDefinition(supabaseSchemaSource, tableName)),
      `${tableName} must be relational and must not keep a business payload jsonb column`
    );
  }
  const flightRecordTable = tableDefinition(supabaseSchemaSource, 'public.season_flight_records');
  assert(
    flightRecordTable.includes('record_id text primary key') &&
      flightRecordTable.includes('season_id text not null references public.seasons(id) on delete restrict') &&
      flightRecordTable.includes('scheduled_date text') &&
      flightRecordTable.includes('operational_date text') &&
      flightRecordTable.includes('iata_season_code text') &&
      flightRecordTable.includes('flight_series_id text') &&
      !flightRecordTable.includes('primary key (season_id, record_id)') &&
      tableDefinition(supabaseSchemaSource, 'public.season_modifications').includes('season_id text not null references public.seasons(id) on delete restrict') &&
      tableDefinition(supabaseSchemaSource, 'public.season_modifications').includes('leg_id text primary key') &&
      tableDefinition(supabaseSchemaSource, 'public.season_modification_added_legs').includes('season_id text not null references public.seasons(id) on delete restrict') &&
      tableDefinition(supabaseSchemaSource, 'public.season_mod_history_entries').includes('season_id text not null references public.seasons(id) on delete restrict') &&
      tableDefinition(supabaseSchemaSource, 'public.season_change_events').includes('season_id text not null references public.seasons(id) on delete restrict') &&
      tableDefinition(supabaseSchemaSource, 'public.season_entity_versions').includes('season_id text not null references public.seasons(id) on delete cascade') &&
      tableDefinition(supabaseSchemaSource, 'public.season_entity_versions').includes('primary key (season_id, target_type, target_id)') &&
      iataSeasonSource.includes('getSeasonDateRange') &&
      iataSeasonSource.includes('getOperationalDate') &&
      iataSeasonSource.includes('buildFlightSeriesId'),
    'Continuous storage must use global record keys, season-scoped entity clocks, plus scheduled, operational, IATA season, and series metadata'
  );
  const removeModificationStart = supabaseStoreSource.indexOf('async removeModification(seasonId: string, legId: string)');
  const removeModificationEnd = supabaseStoreSource.indexOf('async deleteModifications(seasonId: string, legIds: string[])', removeModificationStart);
  const removeModificationSource = supabaseStoreSource.slice(removeModificationStart, removeModificationEnd);
  const deleteModificationsStart = supabaseStoreSource.indexOf('async deleteModifications(seasonId: string, legIds: string[])');
  const deleteModificationsEnd = supabaseStoreSource.indexOf('async saveModificationsWithHistory', deleteModificationsStart);
  const deleteModificationsSource = supabaseStoreSource.slice(deleteModificationsStart, deleteModificationsEnd);
  const modificationChildrenStart = supabaseStoreSource.indexOf('async function writeModificationChildren');
  const modificationChildrenEnd = supabaseStoreSource.indexOf('async function readModificationChildren', modificationChildrenStart);
  const modificationChildrenSource = supabaseStoreSource.slice(modificationChildrenStart, modificationChildrenEnd);
  assert(
    removeModificationSource.includes(".from('season_modifications').delete().eq('season_id', seasonId).eq('leg_id', legId)") &&
      deleteModificationsSource.includes(".from('season_modifications').delete().eq('season_id', seasonId).in('leg_id', chunk)") &&
      modificationChildrenSource.includes(".from('season_modification_added_legs').delete().eq('season_id', seasonId).eq('leg_id', mod.legId)"),
    'Season-scoped modification deletes must filter by season_id before leg_id; no-schema pass only covers tables that already carry season_id'
  );
  const uniqueSeasonCodeMigrationPath = path.join(root, 'supabase', 'migrations', '20260616_unique_seasons_season_code.sql');
  const uniqueSeasonCodeMigrationSource = fs.existsSync(uniqueSeasonCodeMigrationPath)
    ? fs.readFileSync(uniqueSeasonCodeMigrationPath, 'utf8')
    : '';
  assert(
    supabaseSchemaSource.includes('create unique index if not exists seasons_season_code_unique_idx on public.seasons (season_code)') &&
      uniqueSeasonCodeMigrationSource.includes('create unique index if not exists seasons_season_code_unique_idx on public.seasons (season_code)') &&
      supabaseStoreSource.includes('Duplicate season_code detected'),
    'Season code must be unique and duplicate lookup errors must be surfaced clearly'
  );
  const workspaceSnapshotStart = supabaseSchemaSource.indexOf('create or replace function public.get_season_workspace_snapshot');
  const workspaceSnapshotEnd = supabaseSchemaSource.indexOf('grant execute on function public.get_season_workspace_snapshot', workspaceSnapshotStart);
  const workspaceSnapshotSource = supabaseSchemaSource.slice(
    workspaceSnapshotStart,
    workspaceSnapshotEnd >= 0 ? workspaceSnapshotEnd : supabaseSchemaSource.length
  );
  const dashboardFlightLoaderStart = supabaseStoreSource.indexOf('async function readFlightRecordRowsForDashboardSeason');
  const dashboardFlightLoaderEnd = supabaseStoreSource.indexOf('async function hydrateFlightRecordRows', dashboardFlightLoaderStart);
  const dashboardFlightLoaderSource = supabaseStoreSource.slice(dashboardFlightLoaderStart, dashboardFlightLoaderEnd);
  const dashboardModificationLoaderStart = supabaseStoreSource.indexOf('async function readModificationRowsForDashboardSeason');
  const dashboardModificationLoaderEnd = supabaseStoreSource.indexOf('async function readModificationsForDashboardSeason', dashboardModificationLoaderStart);
  const dashboardModificationLoaderSource = supabaseStoreSource.slice(dashboardModificationLoaderStart, dashboardModificationLoaderEnd);
  const operationalGroupingMetadataPattern = /\b(file_name|uploaded_at|import[_A-Za-z0-9]*|batch[_A-Za-z0-9]*|session[_A-Za-z0-9]*)\b/;
  assert(
    workspaceSnapshotSource.includes('where r.season_id = p_season_id') &&
      !workspaceSnapshotSource.includes('r.iata_season_code = s.season_code') &&
      !workspaceSnapshotSource.includes('al.iata_season_code = s.season_code') &&
      !workspaceSnapshotSource.includes('left join season_row s on true') &&
      !operationalGroupingMetadataPattern.test(workspaceSnapshotSource) &&
      !operationalGroupingMetadataPattern.test(dashboardFlightLoaderSource) &&
      !operationalGroupingMetadataPattern.test(dashboardModificationLoaderSource) &&
      !supabaseStoreSource.includes('load IATA season flight record rows') &&
      !supabaseStoreSource.includes('load IATA season added modification legs') &&
      !supabaseStoreSource.includes('load IATA season added modifications') &&
      supabaseSchemaSource.includes('create index if not exists season_flight_records_season_operational_idx on public.season_flight_records (season_id, operational_date, type, status') &&
      localSeasonSqlStoreSource.includes('CREATE INDEX IF NOT EXISTS idx_local_flight_records_operational_lookup ON local_flight_records (season_id, is_base, operational_date, type, status'),
    'Operational season loading must use exact season_id filters only; IATA season code and import metadata are reporting dimensions, not grouping keys'
  );
  const syncV2Start = supabaseSchemaSource.indexOf('create or replace function public.sync_season_workspace_v2');
  const syncV2End = supabaseSchemaSource.indexOf('create schema if not exists reporting', syncV2Start);
  const syncV2Source = supabaseSchemaSource.slice(syncV2Start, syncV2End);
  assert(
    syncV2Source.includes('where season_id = p_season_id and target_type = v_target_type and target_id = v_target_id') &&
      syncV2Source.includes('where client_id = p_client_id and op_id = v_op_id') &&
      syncV2Source.includes('on conflict (client_id, op_id) do nothing') &&
      syncV2Source.includes('to_jsonb(applied_seq)') &&
      syncV2Source.includes('server_high_water') &&
      syncV2Source.includes('applied_events := applied_events ||') &&
      syncV2Source.includes("'serverSeq', applied_seq") &&
      /if applied_seq is not null then[\s\S]*perform public\.apply_workspace_op_json\(p_season_id, event_payload\)[\s\S]*applied_events := applied_events \|\|[\s\S]*continue;/.test(syncV2Source) &&
      /if applied_seq is null then[\s\S]*raise exception 'Duplicate sync op % could not be resolved to a server sequence'[\s\S]*perform public\.apply_workspace_op_json\(p_season_id, event_payload\)[\s\S]*applied_events := applied_events \|\|[\s\S]*continue;/.test(syncV2Source) &&
      !syncV2Source.includes("to_jsonb(coalesce((next_field_versions->>changed_field)::bigint, 0) + 1)") &&
      supabaseSchemaSource.includes('create or replace function public.get_season_event_high_water') &&
      supabaseSchemaSource.includes('grant execute on function public.get_season_event_high_water(text) to authenticated') &&
      supabaseSchemaSource.includes('grant select on public.season_entity_versions to authenticated') &&
      supabaseSchemaSource.includes('create index if not exists season_entity_versions_target_idx on public.season_entity_versions (season_id, target_type, target_id)'),
    'Supabase v2 sync must scope entity clocks by season, make duplicate op retries reapply idempotent row mutations, store field versions as applied server_seq, and return applied events plus server high-water for exact catch-up'
  );
  assert(
    nativeCatchupRustSource.includes('pub fn validate_pending_sync_result_coverage') &&
      nativeCatchupRustSource.includes('validate_pending_sync_result_coverage(') &&
      nativeCatchupRustSource.indexOf('validate_pending_sync_result_coverage(') < nativeCatchupRustSource.indexOf('finalize_successful_pending_sync(&conn, &input.season_id, &rpc_result)') &&
      nativeCatchupRustSource.includes('Native pending sync refused to finalize because the server response did not acknowledge'),
    'Native pending sync must fail closed instead of clearing local pending ops unless the server response acknowledges every pending opId'
  );
  assert(
    supabaseStoreSource.includes('const SYNC_V2_EVENT_CHUNK_SIZE') &&
      supabaseStoreSource.includes('for (let start = 0; start < input.pendingEvents.length; start += SYNC_V2_EVENT_CHUNK_SIZE)') &&
      supabaseStoreSource.includes('p_pending_events: chunk') &&
      supabaseStoreSource.includes('baseServerSeq = nextServerSeq') &&
      supabaseStoreSource.includes('serverHighWater') &&
      supabaseStoreSource.includes("input.onProgress?.('Saving workspace events', Math.min(start + chunk.length, input.pendingEvents.length), input.pendingEvents.length)"),
    'Supabase store must chunk v2 sync event RPC calls so large schedule edits do not hit Postgres statement timeout'
  );
  assert(
    supabaseSchemaSource.includes("jsonb_typeof(record_payload->'checkInCounterWindows') = 'object'") &&
      supabaseSchemaSource.includes("jsonb_typeof(mod_payload->'checkInCounterWindows') = 'object'") &&
      !supabaseSchemaSource.includes("jsonb_each(coalesce(record_payload->'checkInCounterWindows', '{}'::jsonb))") &&
      !supabaseSchemaSource.includes("jsonb_each(coalesce(mod_payload->'checkInCounterWindows', '{}'::jsonb))"),
    'Supabase check-in window writers must treat JSON null/non-object checkInCounterWindows as empty so grouped allocation sync does not crash in jsonb_each'
  );
  assert(
    supabaseSchemaSource.includes('create schema if not exists reporting') &&
      supabaseSchemaSource.includes('create or replace view reporting.flight_operations') &&
      supabaseSchemaSource.includes('coalesce(r.iata_season_code, s.season_code') &&
      supabaseSchemaSource.includes('coalesce(r.operational_date, r.date) as ops_date') &&
      supabaseSchemaSource.includes('create or replace view reporting.summary_airline') &&
      supabaseSchemaSource.includes('create or replace view reporting.summary_country') &&
      supabaseSchemaSource.includes('create or replace view reporting.summary_route') &&
      supabaseSchemaSource.includes('create or replace view reporting.summary_month') &&
      supabaseSchemaSource.includes('create or replace view reporting.summary_week') &&
      supabaseSchemaSource.includes('create or replace view reporting.summary_peak_hour') &&
      supabaseSchemaSource.includes('create or replace view reporting.summary_aircraft') &&
      supabaseSchemaSource.includes('create or replace view reporting.summary_arr_dep_mix') &&
      supabaseSchemaSource.includes('alter view reporting.flight_operations set (security_invoker = true)') &&
      supabaseSchemaSource.includes('grant usage on schema reporting to authenticated') &&
      supabaseSchemaSource.includes('grant usage on schema reporting') &&
      supabaseSchemaSource.includes('grant select on all tables in schema reporting'),
    'Relational Supabase schema must expose read-only reporting views for Looker Studio'
  );
  assert(
    supabaseStoreSource.includes('toFlightRecordRow') &&
      supabaseStoreSource.includes('fromFlightRecordRows') &&
      supabaseStoreSource.includes('writeFlightRecordCounters') &&
      supabaseStoreSource.includes('readFlightRecordCounters') &&
      supabaseStoreSource.includes('writeOperationalSettingsRelational') &&
      supabaseStoreSource.includes('readOperationalSettingsRelational') &&
      !supabaseStoreSource.includes("from('season_flight_records').select('payload')") &&
      !supabaseStoreSource.includes("from('season_source_rows').select('payload')") &&
      !supabaseStoreSource.includes("from('operational_settings').select('payload')"),
    'Supabase store must hydrate core/settings state through relational row mappers instead of business payload columns'
  );
  assert(
    remoteStoreSource.includes('RemoteDashboardSeasonData') &&
      remoteStoreSource.includes('getDashboardSeasonData') &&
      dashboardPageSource.includes('queryNativeScheduleWindow') &&
      !dashboardPageSource.includes('loadOrSeedSeasonWorkspace') &&
      seasonWorkspaceBootstrapSource.includes('loadDefaultServerBaseline') &&
      seasonWorkspaceBootstrapSource.includes('getFlightRecords') &&
      seasonWorkspaceBootstrapSource.includes('getModifications') &&
      !dashboardPageSource.includes('getSourceRows(targetSeason.id)') &&
      !dashboardPageSource.includes('getFlightRecords(targetSeason.id)') &&
      !dashboardPageSource.includes('getModifications(targetSeason.id)') &&
      supabaseStoreSource.includes('readFlightRecordsForDashboardSeason') &&
      supabaseStoreSource.includes('readModificationsForDashboardSeason') &&
      supabaseStoreSource.includes('readRowsByInFilter') &&
      supabaseStoreSource.includes("selectAllRows<FlightRecordRelationalRow>('season_flight_records'") &&
      supabaseStoreSource.includes("selectAllRows<ModificationAddedLegRelationalRow>('season_modification_added_legs'"),
    'Dashboard and AI data loading must use native local SQLite reads instead of page-local remote payload or full workspace bootstrap reads'
  );
  const settingsWriteOrder = supabaseStoreSource.slice(
    supabaseStoreSource.indexOf('async function writeOperationalSettingsRelational'),
    supabaseStoreSource.indexOf('async function writeFlightRecordCounters')
  );
  assert(
    settingsWriteOrder.indexOf("clearTableRows('operational_checkin_counter_group_members'") <
      settingsWriteOrder.indexOf("replaceTableRows('operational_checkin_counter_groups'") &&
      settingsWriteOrder.indexOf("replaceTableRows('operational_checkin_counter_groups'") <
      settingsWriteOrder.indexOf("upsertTableRows('operational_checkin_counter_group_members'") &&
      settingsWriteOrder.indexOf("clearTableRows('operational_aircraft_group_types'") <
      settingsWriteOrder.indexOf("replaceTableRows('operational_aircraft_groups'") &&
      settingsWriteOrder.indexOf("replaceTableRows('operational_aircraft_groups'") <
      settingsWriteOrder.indexOf("upsertTableRows('operational_aircraft_group_types'") &&
      settingsWriteOrder.indexOf("clearTableRows('operational_gate_group_members'") <
      settingsWriteOrder.indexOf("replaceTableRows('operational_gate_groups'") &&
      settingsWriteOrder.indexOf("replaceTableRows('operational_gate_groups'") <
      settingsWriteOrder.indexOf("upsertTableRows('operational_gate_group_members'"),
    'Relational settings writes must clear child member tables first, write parent groups, then insert child members to satisfy FK constraints'
  );
  assert(
    tauriConfigSource.includes('"frontendDist": "../out"') &&
      tauriConfigSource.includes('"beforeBuildCommand": "npm run python:agent:bundle && npm run build"') &&
      tauriConfigSource.includes('"dragDropEnabled": false') &&
      migrationScriptSource.includes('firebase/app') &&
      migrationScriptSource.includes('@supabase/supabase-js') &&
      migrationScriptSource.includes('SUPABASE_SERVICE_ROLE_KEY') &&
      migrationScriptSource.includes('season_flight_records'),
    'Native packaging must preserve static export packaging and disable Tauri webview drag-drop interception so HTML5 drag/drop works on Windows'
  );
  assert(
    appSidebarSource.includes("{ href: '/audit', label: 'Audit Log'") &&
      appRouteCacheSource.includes("import AuditLogPage from '../audit/page';") &&
      appRouteCacheSource.includes("'/audit'") &&
      appRouteCacheSource.includes("case '/audit':") &&
      appRouteCacheSource.includes('return <AuditLogPage />;') &&
      auditPageSource.includes('getAuditSessions') &&
      auditPageSource.includes('getAuditLogEntries') &&
      auditPageSource.includes('getAuditDeltaChunks') &&
      auditPageSource.includes('getOrCreateAuditSessionId') &&
      auditPageSource.includes('Audit Log') &&
      !auditPageSource.includes('<aside') &&
      auditPageSource.includes('aria-label="Audit sessions"') &&
      auditPageSource.includes('h-screen min-w-0 overflow-hidden') &&
      auditPageSource.includes('grid-cols-1') &&
      auditPageSource.includes('lg:grid-cols-[minmax(240px,320px)_minmax(0,1fr)]') &&
      auditPageSource.includes('sm:grid-cols-2') &&
      auditPageSource.includes('xl:grid-cols-4') &&
      auditPageSource.includes('w-full min-w-0') &&
      auditPageSource.includes('min-h-0 flex-1 overflow-auto'),
    'Audit Log must be available from the global sidebar, route cache, and /audit route UI'
  );
  assert(
    [seasonalPageSource, detailedPageSource, dailyPageSource, checkInPageSource, gatePageSource, settingsPageSource].every((source) =>
      source.includes('appendAuditLogEntry(')
    ) &&
      seasonSyncSource.includes('buildSyncAuditDelta') &&
      seasonSyncSource.includes('appendAuditLogEntry(') &&
      checkInPageSource.includes("'checkin-worker'") &&
      gatePageSource.includes("'gate-worker'"),
    'Detailed, Daily, Seasonal, Check-in, Gate, Settings, and Sync write paths must append non-blocking audit entries'
  );
  assert(
    ![seasonalPageSource, detailedPageSource, dailyPageSource, checkInPageSource, gatePageSource].some((source) =>
      source.includes('syncSummary.pendingCount === 0')
    ) &&
      seasonSyncSource.includes("plan.status === 'refresh'") &&
      seasonSyncSource.includes('loadServerSeasonWorkspace'),
    'Sync actions must stay available for remote refresh and pull newer server workspaces when local has no pending changes'
  );
  assert(
    JSON.parse(tsconfigSource).exclude.includes('out'),
    'TypeScript must exclude the generated static export out directory so post-build worker assets are not typechecked as source'
  );
  assert(
    dashboardPageSource.includes('Seasonal Dashboard') &&
      !dashboardPageSource.includes('Báº£ng Ä‘iá»u khiá»ƒn hiá»‡u suáº¥t mÃ¹a bay') &&
      dashboardPageSource.includes("useSessionState<DashboardView>('dashboard:view', 'overview')") &&
      dashboardPageSource.includes('Tổng quan') &&
      dashboardPageSource.includes('Phân tích MoM / WoW') &&
      dashboardPageSource.includes('buildDashboardOverview') &&
      dashboardPageSource.includes('Xu hướng chuyến bay theo tháng') &&
      dashboardPageSource.includes('Xu hướng chuyến bay theo ngày') &&
      dashboardPageSource.includes('Tìm ngày cao điểm trong tháng đã chọn') &&
      dashboardPageSource.includes('setOverviewDailyMonth') &&
      dashboardPageSource.includes('function handleDailyTrendDoubleClick(date: string)') &&
      dashboardPageSource.includes("params.set('date', date)") &&
      dashboardPageSource.includes('router.push(`/daily?${params.toString()}`)') &&
      dashboardPageSource.includes('onDoubleClick={() => handleDailyTrendDoubleClick(row.date)}') &&
      dailyPageSource.includes("const requestedDailyDate = normalizeDailyDateParam(searchParams.get('date'));") &&
      dailyPageSource.includes('buildDefaultDailyDateRange(requestedDailyDate ?? todayIso())') &&
      dailyPageSource.includes('const next = buildDefaultDailyDateRange(requestedDailyDate);') &&
      dashboardPageSource.includes('Hiệu suất hãng bay') &&
      dashboardPageSource.includes('Đóng góp theo quốc gia / đường bay') &&
      dashboardPageSource.includes('expandedOverviewCountries') &&
      dashboardPageSource.includes('expand_more') &&
      dashboardPageSource.includes('Bản đồ tải') &&
      dashboardPageSource.includes('Tháng x thứ trong tuần') &&
      dashboardPageSource.includes('WEEKDAY_COLUMNS') &&
      dashboardPageSource.includes('cellMap.get(`${month.key}|${weekday.key}`)') &&
      dashboardPageSource.includes('weekday.label') &&
      dashboardPageSource.includes('HEATMAP_CELL_TONES') &&
      dashboardPageSource.includes('heatmapCellTone') &&
      dashboardPageSource.includes('bg-indigo-900') &&
      dashboardPageSource.includes('bg-cyan-100') &&
      !dashboardPageSource.includes('rgba(14, 165, 233') &&
      dashboardPageSource.includes('Trung bình theo khung giờ cao điểm') &&
      dashboardPageSource.includes('Trung bình chuyến / 30 phút') &&
      dashboardPageSource.includes('Ngày khai thác 05:00-05:00') &&
      dashboardPageSource.includes('buildPeakHourAxisTicks') &&
      dashboardPageSource.includes('height: `${Math.max(4, row.avgFlightsPerDay / overviewMaxPeakHourAverage * 100)}%`') &&
      !dashboardPageSource.includes('Equipment Mix') &&
      dashboardPageSource.includes('So sánh: MoM / WoW') &&
      dashboardPageSource.includes('comparisonMode') &&
      dashboardPageSource.includes('DateRangeFilter') &&
      dashboardPageSource.includes('overviewPeakHourMonth') &&
      dashboardPageSource.includes('comparisonGranularity') &&
      dashboardPageSource.includes('resolveDashboardAiDataScopeForPrompt') &&
      dashboardPageSource.includes('requestScopedRecords') &&
      !dashboardPageSource.includes('buildDashboardAiResolvedDataRequest(dataRequest, {\n          records: effectiveRecords') &&
      dashboardPageSource.includes("setComparisonMode('yoy')") &&
      dashboardPageSource.includes('selectedDriverRecordLimit') &&
      dashboardPageSource.includes('Hiển thị thêm') &&
      (dashboardPageSource.match(/<select value=\{typeFilter\}/g) ?? []).length === 1 &&
      (dashboardPageSource.match(/<select value=\{timeBasis\}/g) ?? []).length === 1 &&
      !dashboardPageSource.includes("label: 'TrÃ¡ÂºÂ¡ng thÃƒÂ¡i'") &&
      dashboardPageSource.includes('resolveCountryForRoute') &&
      dashboardPageSource.includes('buildDashboardComparison') &&
      dashboardPageSource.includes('buildEffectiveDashboardRecords') &&
      dashboardPageSource.includes('Thác nước biến động') &&
      dashboardPageSource.includes('Xếp hạng CTG') &&
      dashboardPageSource.includes('Nhóm tác nhân') &&
      dashboardPageSource.includes('Dịch chuyển cơ cấu') &&
      dashboardPageSource.includes('CTG') &&
      dashboardPageSource.includes('formatPointPct') &&
      !dashboardPageSource.includes('Danh sách giải thích') &&
      !dashboardPageSource.includes('Đóng góp %') &&
      !dashboardPageSource.includes('Không có tác nhân') &&
      !dashboardPageSource.includes('Ã„') &&
      !dashboardPageSource.includes('Ãƒ') &&
      !dashboardPageSource.includes('contributing') &&
      !dashboardPageSource.includes('offsetting') &&
      !dashboardPageSource.includes('No material driver movement') &&
      dashboardPageSource.includes('Lịch chi tiết') &&
      dashboardPageSource.includes('Lịch ngày'),
    'Dashboard route must render the MoM/WoW analysis drilldown panels and verification links'
  );
  const dashboardAiSharedSource = fs.readFileSync(path.join(root, 'supabase', 'functions', '_shared', 'dashboardAiShared.ts'), 'utf8');
  const dashboardReportExportSource = fs.readFileSync(path.join(root, 'src', 'lib', 'dashboardReportExport.ts'), 'utf8');
  const exportSavePath = path.join(root, 'src', 'lib', 'exportSave.ts');
  const exportSaveSource = fs.existsSync(exportSavePath) ? fs.readFileSync(exportSavePath, 'utf8') : '';
  const dailyScheduleExportPath = path.join(root, 'src', 'lib', 'dailyScheduleExport.ts');
  const dailyScheduleExportSource = fs.existsSync(dailyScheduleExportPath) ? fs.readFileSync(dailyScheduleExportPath, 'utf8') : '';
  const exportNotificationProviderPath = path.join(root, 'src', 'app', 'components', 'ExportNotificationProvider.tsx');
  const exportNotificationProviderSource = fs.existsSync(exportNotificationProviderPath)
    ? fs.readFileSync(exportNotificationProviderPath, 'utf8')
    : '';
  assert(
    exportSaveSource.includes('export interface ExportSaveResult') &&
      exportSaveSource.includes('export async function saveExportBlob') &&
      exportSaveSource.includes('export async function openSavedExport') &&
      exportSaveSource.includes('export async function revealSavedExport') &&
      exportSaveSource.includes('export function sanitizeExportFileName') &&
      exportSaveSource.includes("invoke<ExportSaveResult>('save_export_file'") &&
      exportSaveSource.includes("invoke<void>('open_export_file'") &&
      exportSaveSource.includes("invoke<void>('reveal_export_file'"),
    'Shared export save helper must support native Tauri save/open/reveal and browser fallback surfaces'
  );
  assert(
    exportNotificationProviderSource.includes('export function useExportNotifications') &&
      exportNotificationProviderSource.includes('notifyExportCompleted') &&
      exportNotificationProviderSource.includes('Export completed') &&
      exportNotificationProviderSource.includes('Open file') &&
      exportNotificationProviderSource.includes('Show in folder') &&
      exportNotificationProviderSource.includes('openSavedExport') &&
      exportNotificationProviderSource.includes('revealSavedExport') &&
      appShellSource.includes('<ExportNotificationProvider>') &&
      appShellSource.includes('</ExportNotificationProvider>'),
    'AppShell must provide global export completion notifications with open and reveal actions'
  );
  assert(
    dailyScheduleExportSource.includes('export const DAILY_SCHEDULE_EXPORT_HEADERS') &&
      dailyScheduleExportSource.includes('buildDailyScheduleSummaryWorkbook') &&
      dailyScheduleExportSource.includes('buildDailyScheduleExportFileName') &&
      dailyScheduleExportSource.includes("XLSX.utils.book_append_sheet(workbook, worksheet, 'Summary')") &&
      dailyScheduleExportSource.includes("cell.z = 'm/d/yy h:mm'") &&
      dailyScheduleExportSource.includes("cell.z = 'm/d/yy'") &&
      dailyScheduleExportSource.includes('resolveCountryForRoute') &&
      dailyScheduleExportSource.includes('leg.action ===') &&
      dailyScheduleExportSource.includes('Load Factor'),
    'Daily date-range export builder must create a Book1-compatible Summary workbook from visible active rows'
  );
  assert(
    dailyPageSource.includes('buildDailyScheduleSummaryWorkbook') &&
      dailyPageSource.includes('buildDailyScheduleExportFileName') &&
      dailyPageSource.includes('saveWorkbookAsXlsx') &&
      dailyPageSource.includes('notifyExportCompleted') &&
      dailyPageSource.includes('sortedRows') &&
      dailyPageSource.includes('Export Excel'),
    'Daily Schedule page must export the currently visible filtered/sorted rows through the shared save notification path'
  );
  assert(
    tauriLibSource.includes('save_export_file') &&
      tauriLibSource.includes('open_export_file') &&
      tauriLibSource.includes('reveal_export_file') &&
      tauriLibSource.includes('generate_handler!') &&
      tauriLibSource.includes('download_dir') &&
      tauriLibSource.includes('sanitize_export_file_name') &&
      tauriCargoSource.includes('base64') &&
      tauriCargoSource.includes('serde') &&
      tauriCargoSource.includes('dirs'),
    'Tauri native shell must expose safe export save/open/reveal commands backed by the Windows Downloads folder'
  );
  assert(
    seasonalPageSource.includes('notifyExportCompleted') &&
      detailedPageSource.includes('notifyExportCompleted') &&
      dashboardPageSource.includes('notifyExportCompleted') &&
      checkInPageSource.includes('notifyExportCompleted') &&
      gatePageSource.includes('notifyExportCompleted') &&
      !dashboardReportExportSource.includes('URL.createObjectURL(blob)') &&
      !seasonalPageSource.includes('XLSX.writeFile(') &&
      !detailedPageSource.includes('XLSX.writeFile(') &&
      !checkInPageSource.includes('pdf.save(fileName)') &&
      !gatePageSource.includes('pdf.save(fileName)') &&
      !checkInPdfExportSource.includes('pdf.save(fileName)') &&
      !gatePdfExportSource.includes('pdf.save(fileName)'),
    'Existing Excel/PDF exports must use the shared save pipeline and completion notification instead of silent direct downloads'
  );
  const schemaSource = fs.readFileSync(path.join(root, 'supabase', 'schema.sql'), 'utf8');
  const dashboardAiFunctionSource = fs.readFileSync(path.join(root, 'supabase', 'functions', 'dashboard-ai-analysis', 'index.ts'), 'utf8');
  const aiWorkspacePanelSource = fs.readFileSync(path.join(root, 'src', 'app', 'dashboard', 'components', 'AiWorkspacePanel.tsx'), 'utf8');
  const aiNotebookCanvasSource = fs.readFileSync(path.join(root, 'src', 'app', 'dashboard', 'components', 'AiNotebookCanvas.tsx'), 'utf8');
  const aiNotebookBlockRenderersSource = fs.readFileSync(path.join(root, 'src', 'app', 'dashboard', 'components', 'AiNotebookBlockRenderers.tsx'), 'utf8');
  const dashboardAiWorkspaceUiSource = [dashboardPageSource, aiWorkspacePanelSource, aiNotebookCanvasSource, aiNotebookBlockRenderersSource].join('\n');
  const dashboardAiSubmitStart = dashboardPageSource.indexOf('const submitAiPrompt');
  const dashboardAiSubmitEnd = dashboardPageSource.indexOf('const moveAiNotebookBlock', dashboardAiSubmitStart);
  const dashboardAiSubmitSource = dashboardAiSubmitStart >= 0 && dashboardAiSubmitEnd > dashboardAiSubmitStart
    ? dashboardPageSource.slice(dashboardAiSubmitStart, dashboardAiSubmitEnd)
    : dashboardPageSource;
  const queryAggregatedMigrationSource = fs.readFileSync(path.join(root, 'supabase', 'migrations', '20260523175500_reporting_query_aggregated.sql'), 'utf8');
  const queryAggregatedWrapperMigrationSource = fs.readFileSync(path.join(root, 'supabase', 'migrations', '20260523112828_public_dashboard_ai_query_aggregated.sql'), 'utf8');
  const queryRowsMigrationPath = path.join(root, 'supabase', 'migrations', '20260527090000_public_dashboard_ai_query_rows.sql');
  const queryRowsMigrationSource = fs.existsSync(queryRowsMigrationPath) ? fs.readFileSync(queryRowsMigrationPath, 'utf8') : '';
  const dashboardAiAdminSource = fs.readFileSync(path.join(root, 'src', 'lib', 'dashboardAiAdmin.ts'), 'utf8');
  assert(
    dashboardAiWorkspaceUiSource.includes('AI Workspace') &&
      dashboardAiWorkspaceUiSource.includes('data-testid="ai-rich-chat-canvas"') &&
      dashboardAiWorkspaceUiSource.includes('data-testid="ai-rich-chat-message"') &&
      dashboardAiWorkspaceUiSource.includes('AiWorkspacePanel') &&
      dashboardAiWorkspaceUiSource.includes('AiNotebookCanvas') &&
      dashboardAiWorkspaceUiSource.includes('AiNotebookBlockCard') &&
      dashboardPageSource.includes('aiNotebook') &&
      dashboardPageSource.includes('setAiNotebook') &&
      dashboardPageSource.includes('dashboard:aiNotebook') &&
      !dashboardPageSource.includes('dashboard:aiWorkspaceBoard') &&
      !dashboardPageSource.includes('data-testid="ai-workspace-board"') &&
      !dashboardPageSource.includes("xl:grid-cols-[380px_minmax(0,1fr)]") &&
      aiNotebookBlockRenderersSource.includes('ResponsiveContainer') && 
      aiNotebookBlockRenderersSource.includes("from 'recharts'") && 
      aiNotebookBlockRenderersSource.includes('renderRichMarkdown') && 
      aiNotebookBlockRenderersSource.includes('sandbox=""') && 
      !aiNotebookBlockRenderersSource.includes('allow-popups-to-escape-sandbox') && 
      aiNotebookBlockRenderersSource.includes('htmlPreview?.html') && 
      packageJsonSource.includes('"recharts"') &&
      dashboardPageSource.includes('selectedAiSeasonIds') &&
      dashboardPageSource.includes('deleteAiNotebookCell') &&
      dashboardPageSource.includes('duplicateAiNotebookPrompt') &&
      aiNotebookBlockRenderersSource.includes('Xuất Excel block') &&
      dashboardPageSource.includes('const AI_WORKSPACE_PRESETS') &&
      dashboardPageSource.includes("mode: 'board'") &&
      dashboardPageSource.includes('preferredTool:') &&
      dashboardPageSource.includes('buildDashboardAiFallbackBoardPatch') &&
      dashboardPageSource.includes('response.boardPatch ?? buildDashboardAiFallbackBoardPatch') &&
      dashboardPageSource.includes('resolveAiWorkspaceComparison') &&
      dashboardPageSource.includes('currentMonth') &&
      dashboardPageSource.includes('previousMonth') &&
      !dashboardPageSource.includes('AI Analysis Chat') &&
      dashboardPageSource.includes('AI đang phân tích dữ liệu...') &&
      !dashboardPageSource.includes('data-testid="ai-chat-messages"') &&
      !dashboardPageSource.includes('whitespace-pre-wrap leading-relaxed') &&
      dashboardPageSource.includes('selectedAiModelId') &&
      dashboardPageSource.includes('Giải thích tác nhân chính') &&
      dashboardPageSource.includes('Tìm bất thường') &&
      dashboardPageSource.includes('Vì sao chỉ số giảm?') &&
      dashboardPageSource.includes('Đang chạy truy vấn SQL local') &&
      dashboardPageSource.includes('buildDashboardAiContext') &&
      dashboardPageSource.includes('inferDashboardAiSemanticIntent') &&
      !dashboardAiSubmitSource.includes('buildDashboardAiResolvedDataRequest') &&
      !dashboardAiSubmitSource.includes('inferDashboardAiDataRequestFromText') &&
      !dashboardAiSubmitSource.includes('buildDashboardAiResolvedDataFallbackAnswer') &&
      !dashboardAiSubmitSource.includes('isDashboardAiDataRequestPrompt') &&
      dashboardPageSource.includes('allowDataRequest: localQueryResults.length > 0 ? false : undefined') &&
      dashboardPageSource.includes('buildDashboardAiNotebookContext') &&
      dashboardPageSource.includes('resolveDashboardAiAvailableTools') &&
      dashboardPageSource.includes('resolveDashboardAiSkillForPrompt') &&
      dashboardPageSource.includes("language: 'vi'") &&
      dashboardPageSource.includes('providerFallback: true') &&
      dashboardPageSource.includes('analyzeDashboardWithAi') &&
      dashboardPageSource.includes('resolveDashboardAiModel') &&
      dashboardPageSource.includes('capDashboardAiLocalHistory'),
    'Dashboard analysis panel must expose a bounded AI chat UI with runtime model selection, broader-data follow-up, and capped local history'
  );
  assert(
    aiNotebookCanvasSource.includes('Chi tiết kỹ thuật') &&
      aiNotebookCanvasSource.includes('{aiError}') &&
      aiNotebookCanvasSource.includes('friendlyAiError(aiError)') &&
      aiNotebookCanvasSource.includes('whitespace-pre-wrap break-words'),
    'AI notebook errors must show both friendly copy and expandable raw technical details for provider/debug failures'
  );
  assert(
    tauriLibSource.includes('query_native_dashboard_ai_sql') &&
      nativeSeasonCatchupSource.includes('queryNativeDashboardAiSql') &&
      nativeCatchupRustSource.includes('QueryNativeDashboardAiSqlInput') &&
      nativeCatchupRustSource.includes('dashboard_ai_flight_operations') &&
      nativeCatchupRustSource.includes('validate_dashboard_ai_sql') &&
      nativeCatchupRustSource.includes('WITH') &&
      nativeCatchupRustSource.includes('SELECT') &&
      nativeCatchupRustSource.includes('PRAGMA') &&
      nativeCatchupRustSource.includes('ATTACH') &&
      nativeCatchupRustSource.includes('DROP') &&
      nativeCatchupRustSource.includes('INSERT') &&
      nativeCatchupRustSource.includes('UPDATE') &&
      nativeCatchupRustSource.includes('DELETE') &&
      dashboardAiFunctionSource.includes('sqlQueryPlans') &&
      dashboardAiFunctionSource.includes('dashboard_ai_flight_operations') &&
      dashboardPageSource.includes('response.sqlQueryPlans'),
    'Dashboard AI raw local SQL must execute only through a validated Tauri read-only SELECT gateway'
  );
  assert(
    nativeCatchupRustSource.includes('dashboard_ai_cte_header') &&
      nativeCatchupRustSource.includes('split_dashboard_ai_cte_definitions') &&
      !nativeCatchupRustSource.includes('upper_sql.split("SELECT").next()'),
    'Dashboard AI SQL validator must parse multiple CTE names so peak-day baseline queries using peak/baseline/keys are not rejected'
  );
  assert(
    dashboardAiSubmitSource.includes('localAiSeasonRows') &&
      dashboardAiSubmitSource.includes('requestScopedRecords') &&
      !dashboardAiSubmitSource.includes('inferredLocalQuery && requestSeasonData.length > 0'),
    'Dashboard AI submit must build local fallback rows from active effectiveRecords when AI season preload/native SQL is unavailable'
  );
  assert(
      dashboardAiSource.includes('DashboardAiSqlQueryPlan') && 
      dashboardAiSource.includes('DashboardAiSqlQueryResult') && 
      dashboardAiSource.includes('DashboardAiResultProfile') && 
      dashboardAiSource.includes('DashboardAiAnswerVerification') && 
      dashboardAiSource.includes('profileDashboardAiQueryResults') && 
      dashboardAiSource.includes('verifyDashboardAiAnswerAgainstQueryResults') && 
      dashboardAiSource.includes('profiled_query_result') && 
      dashboardAiSource.includes('verified_answer') && 
      dashboardAiSource.includes('resolveDashboardAiSqlQueryPlans') && 
      dashboardAiSource.includes('planDashboardAiSqlQueries') && 
      dashboardAiSource.includes('ops_date') &&
      dashboardAiSource.includes('peak-day-daily') &&
      dashboardAiSource.includes('peak-day-drilldown') &&
      dashboardAiSource.includes('generated_sql') &&
      dashboardAiSource.includes('validated_sql') &&
      dashboardAiSource.includes('executed_local_sql') &&
      dashboardAiSource.includes('rendered_rich_chat'), 
    'Dashboard AI must have a LuminAI-style local SQL query plan that can answer daily peak/anomaly prompts from query results'
  );
  const workflowIds = DASHBOARD_AI_WORKFLOW_REGISTRY.map((workflow) => workflow.id);
  assert(
    JSON.stringify(workflowIds) === JSON.stringify([
      'peak-day-anomaly',
      'day-vs-baseline-drivers',
      'month-comparison-drivers',
      'route-pax-ranking',
      'flight-detail-investigation',
      'eda-profile',
      'visual-report-builder',
    ]) &&
      DASHBOARD_AI_WORKFLOW_REGISTRY.every((workflow) =>
        workflow.descriptionVi &&
        Array.isArray(workflow.triggersVi) &&
        workflow.requiredGates.includes('local-sqlite-ready') &&
        workflow.requiredGates.includes('prepared-data-contract-ready') &&
        workflow.queryPlanKind &&
        workflow.renderStrategy &&
        workflow.fallbackPolicy
      ),
    `Dashboard AI workflow registry must define one owner workflow with gates/render strategy for each supported analysis path, got ${JSON.stringify(DASHBOARD_AI_WORKFLOW_REGISTRY)}`
  );
  const peakWorkflow = resolveDashboardAiWorkflowForPrompt('tìm ngày cao điểm của tháng 6 và điểm bất thường so với các ngày còn lại');
  const followupWorkflow = resolveDashboardAiWorkflowForPrompt('phân tích driver ngày đó theo hãng bay và đường bay', {
    activeArtifact: { entities: { peakDate: '2026-06-18' } },
  });
  const routePaxWorkflow = resolveDashboardAiWorkflowForPrompt('Top 10 route có PAX cao nhất trong tháng 3');
  const visualWorkflow = resolveDashboardAiWorkflowForPrompt('tạo báo cáo trực quan gồm KPI, bảng và biểu đồ');
  assert(
    peakWorkflow?.id === 'peak-day-anomaly' &&
      followupWorkflow?.id === 'day-vs-baseline-drivers' &&
      routePaxWorkflow?.id === 'route-pax-ranking' &&
      visualWorkflow?.id === 'visual-report-builder',
    `Dashboard AI workflow router must choose exactly one owner workflow before tools/provider, got ${JSON.stringify({ peakWorkflow, followupWorkflow, routePaxWorkflow, visualWorkflow })}`
  );
  const peakWorkflowSqlPlans = planDashboardAiSqlQueries({
    userPrompt: 'tìm ngày cao điểm của tháng 6 và điểm bất thường so với các ngày còn lại',
    source: 'local-sqlite',
  });
  assert(
    peakWorkflowSqlPlans.length === 1 &&
      peakWorkflowSqlPlans[0].workflowId === 'peak-day-anomaly' &&
      peakWorkflowSqlPlans[0].renderHints?.series?.includes('flights'),
    `Peak-day workflow must attach workflow metadata and render hints to SQL plans, got ${JSON.stringify(peakWorkflowSqlPlans)}`
  );
  const preparedContracts = buildDashboardAiPreparedDataContracts([
    {
      queryId: 'peak-day-daily',
      view: 'flight_operations',
      columns: ['ops_date', 'flights', 'pax'],
      rows: [
        { ops_date: '2026-06-18', flights: 128, pax: 1000 },
        { ops_date: '2026-06-19', flights: 110, pax: 900 },
      ],
      rowCount: 2,
      truncated: false,
      dataQualityNotes: [],
    },
  ], peakWorkflow);
  assert(
    preparedContracts.length === 1 &&
      preparedContracts[0].queryId === 'peak-day-daily' &&
      preparedContracts[0].grain === 'ops_date' &&
      preparedContracts[0].dateRange?.from === '2026-06-18' &&
      preparedContracts[0].metrics.includes('flights') &&
      preparedContracts[0].trusted === true,
    `Prepared-data contracts must summarize grain/date/metrics/trust for render gating, got ${JSON.stringify(preparedContracts)}`
  );
  assert(
    dashboardAiSource.includes('DashboardAiWorkflowDefinition') &&
      dashboardAiSource.includes('DashboardAiPreparedDataContract') &&
      dashboardAiSource.includes('DASHBOARD_AI_WORKFLOW_REGISTRY') &&
      dashboardAiSource.includes('resolveDashboardAiWorkflowForPrompt') &&
      dashboardAiSource.includes('buildDashboardAiPreparedDataContracts') &&
      dashboardPageSource.includes('resolveDashboardAiWorkflowForPrompt') &&
      dashboardPageSource.includes('workflowId: selectedWorkflow?.id') &&
      dashboardAiSource.includes('workflowId: request.workflowId') &&
      pythonAgentContractsSource.includes('workflow_id') &&
      pythonAgentContractsSource.includes('prepared_data_contracts') &&
      pythonAgentMainSource.includes('preparedDataContracts') &&
      pythonAgentMainSource.includes('workflowId'),
    'Dashboard AI must pass workflow owner and prepared-data contracts through TS frontend, Python sidecar contracts, and rich response payload'
  );
  const queryOnlyFallbackPatch = buildDashboardAiFallbackBoardPatch({
    userPrompt: 'so sanh thang 6 voi thang 5 theo route',
    preferredTool: 'compose_dashboard_ai_board',
  });
  const queryOnlyFallbackText = JSON.stringify(queryOnlyFallbackPatch);
  assert(!dashboardAiSubmitSource.includes('waterfallRows: aiWaterfallRows'), 'Dashboard AI Workspace must not inject MoM/WoW waterfallRows into submitAiPrompt');
  assert(!dashboardAiSubmitSource.includes('buildDashboardAiResolvedDataRequest(dataRequest'), 'Dashboard AI Workspace must not resolve legacy dataRequest payloads in submitAiPrompt');
  assert(!aiWorkspacePanelSource.includes('Xuất Excel MoM/WoW'), 'Dashboard AI Workspace toolbar must not show the fixed MoM/WoW export button');
  assert(queryOnlyFallbackText.includes('custom-table'), 'Dashboard AI query-only fallback must render custom-table blocks');
  assert(!queryOnlyFallbackText.includes('comparison-drivers'), 'Dashboard AI query-only fallback must not emit comparison-drivers');
  assert(!queryOnlyFallbackText.includes('"source":"comparison"'), 'Dashboard AI query-only fallback must not use comparison source blocks');
  assert(!dashboardAiFunctionSource.includes('"comparisonMode":"mom|wow"'), 'Dashboard AI Edge prompt must not advertise MoM/WoW comparisonMode contract');
  assert(!dashboardAiFunctionSource.includes('mom-wow-analysis|sanluong-summary'), 'Dashboard AI Edge prompt must not advertise fixed MoM/WoW/SanLuong templates');
  assert(
    aiWorkspacePanelSource.includes('Rich Chat') &&
      aiWorkspacePanelSource.includes('onClearNotebook') &&
      aiNotebookCanvasSource.includes('data-testid="ai-rich-chat-canvas"') &&
      aiNotebookCanvasSource.includes('data-testid="ai-rich-chat-message"') &&
      aiNotebookCanvasSource.includes('const continuationLabel') &&
      aiNotebookCanvasSource.includes('sourceCellIndex') &&
      aiNotebookCanvasSource.includes('onPinContext') &&
      dashboardPageSource.includes('pinnedAiContextCellId') &&
      dashboardPageSource.includes('resolveDashboardAiSessionFollowUp') &&
      dashboardPageSource.includes('queryResults: response.queryResults') &&
      aiNotebookCanvasSource.includes('assistant rich') &&
      aiNotebookCanvasSource.includes('user bubble') &&
      aiNotebookCanvasSource.includes('rendered_rich_chat') &&
      !aiNotebookCanvasSource.includes('data-testid="ai-notebook-cell"') &&
      !aiNotebookCanvasSource.includes('AI Notebook Canvas'),
    'AI Workspace must present query-grounded results as a rich chat interface instead of notebook-styled cells'
  );
  const quietSuccessfulTraces = [
    { tool: 'query_dashboard_data', status: 'executed', phase: 'profiled_query_result', reason: 'profiled_query_result: Đã lập hồ sơ 2 kết quả truy vấn gồm coverage, null/distinct, thống kê metric và outlier candidates.' },
    { tool: 'query_dashboard_data', status: 'executed', phase: 'verified_answer', reason: 'verified_answer: Các số liệu chính trong câu trả lời khớp query result/profile.' },
    { tool: 'query_dashboard_data', status: 'executed', reason: 'Nguồn: SQLite local từ dữ liệu dashboard đang hiển thị.' },
    { tool: 'query_dashboard_data', status: 'accepted', reason: 'Đã chọn tool theo hợp đồng Dashboard AI.' },
  ];
  assert(
    quietSuccessfulTraces.every((trace) => isDashboardAiToolTraceVisible(trace) === false) &&
      isDashboardAiToolTraceVisible({ tool: 'query_dashboard_data', status: 'rejected', phase: 'verified_answer', reason: 'verified_answer: Một số số liệu chưa khớp query result/profile.' }) === true &&
      isDashboardAiToolTraceVisible({ tool: 'query_dashboard_data', status: 'executed', reason: 'Nguồn: SQLite local, bao gồm thay đổi chưa đồng bộ.' }) === true &&
      aiNotebookCanvasSource.includes('visibleToolTraces') &&
      aiNotebookCanvasSource.includes('isDashboardAiToolTraceVisible'),
    'AI rich chat must hide routine successful tool traces while keeping warnings and data-quality traces visible'
  );
  assert(
    dashboardAiSource.includes('DASHBOARD_CONTEXT_JSON') &&
      dashboardAiSource.includes('only from the supplied dashboard JSON') &&
      dashboardAiSource.includes('seasonCatalog') &&
      dashboardAiSource.includes('dashboard-data-request') &&
      dashboardAiSource.includes('query_dashboard_data') &&
      dashboardAiSource.includes('DashboardAiDataQuery') &&
      dashboardAiSource.includes('DashboardAiQueryResult') &&
      dashboardAiSource.includes('rich-markdown') &&
      dashboardAiSource.includes('html-preview') &&
      dashboardAiSource.includes('sanitizeDashboardAiHtmlPreview') &&
      dashboardAiSource.includes('rejected_unsafe_render') &&
      dashboardAiSource.includes('inferDashboardAiDataQueryForPrompt') &&
      dashboardAiSource.includes('shouldPreferDashboardAiQueryResults') &&
      dashboardAiSource.includes('buildDashboardAiBoardPatchFromQueryResults') &&
      dashboardAiSource.includes('resolvedDataRequest') &&
      dashboardAiSource.includes('dashboard-ai-analysis') &&
      dashboardAiSource.includes('buildDashboardAiFunctionRequest') &&
      dashboardAiSource.includes('buildDashboardAgentRuntimeConfig') &&
      dashboardAiSource.includes('DASHBOARD_AI_TOOL_REGISTRY') &&
      dashboardAiSource.includes('DASHBOARD_AI_SKILL_REGISTRY') &&
      dashboardAiSource.includes('resolveDashboardAiAvailableTools') &&
      dashboardAiSource.includes('resolveDashboardAiSkillForPrompt') &&
      dashboardAiSource.includes('buildDashboardAiNotebookContext') &&
      dashboardAiSource.includes('STABLE_AGENT_CONTRACT') &&
      dashboardAiSource.includes('LANGUAGE_POLICY') &&
      dashboardAiSource.includes('language: vi') &&
      dashboardAiSource.includes('providerFallback') &&
      (dashboardAiSource.includes('LuÃ´n tráº£ lá»i báº±ng tiáº¿ng Viá»‡t') || dashboardAiSource.includes('LuÃƒÂ´n trÃ¡ÂºÂ£ lÃ¡Â»Âi bÃ¡ÂºÂ±ng tiÃ¡ÂºÂ¿ng ViÃ¡Â»â€¡t')) &&
      dashboardAiSource.includes('DASHBOARD_AI_TOOL_SELECTION_FIXTURES') &&
      dashboardAiSource.includes('resolveDashboardAgentToolForPrompt') &&
      dashboardAiSource.includes('resolveDashboardAiVisualReport') &&
      dashboardAiSource.includes('resolveDashboardAiBoardPatch') &&
      dashboardAiSource.includes('buildDashboardAiFallbackBoardPatch') &&
      dashboardAiSource.includes('resolveDashboardAiWorkspaceToolForPrompt') &&
      dashboardAiSource.includes('DashboardAiNotebook') &&
      dashboardAiSource.includes('DashboardAiNotebookCell') &&
      dashboardAiSource.includes('DashboardAiWorkspaceBoard') &&
      dashboardAiSource.includes('compose_dashboard_ai_board') &&
      dashboardAiSource.includes('normalizeDashboardAiWorkspaceSeasonIds') &&
      dashboardAiSource.includes('resolveDashboardAiExportAction') &&
      dashboardAiSource.includes('dashboard-custom-workbook') &&
      dashboardAiSource.includes('suggest_visual_report') &&
      dashboardAiSource.includes('allowedVisualReports') &&
      dashboardAiSource.includes('maxRounds') &&
      dashboardAiSource.includes('allowedExportActions') &&
      dashboardAiSource.includes('DEFAULT_AI_ANALYSIS_SETTINGS') &&
      dashboardAiSource.includes('capDashboardAiLocalHistory') &&
      !dashboardAiSource.includes('NEXT_PUBLIC_AI_API_KEY') &&
      !dashboardAiSource.includes('SERVICE_ROLE') &&
      !dashboardAiSource.includes('SUPABASE_SERVICE_ROLE'),
    'Dashboard AI helper must inject broad context, validate data/export actions, invoke Edge Function runtime config, cap local history, and avoid public provider keys'
  );
  assert(
    dashboardAiFunctionSource.includes('query_dashboard_data') &&
      !dashboardAiFunctionSource.includes("supabase.schema('reporting')") &&
      dashboardAiFunctionSource.includes('resolveDashboardDataQueries') &&
      dashboardAiFunctionSource.includes('sanitizeDataQueries') &&
      dashboardAiFunctionSource.includes("rpc('dashboard_ai_query_aggregated'") &&
      dashboardAiFunctionSource.includes("rpc('dashboard_ai_query_rows'") &&
      dashboardAiFunctionSource.includes('buildToolDeclarations') &&
      dashboardAiFunctionSource.includes('function_declarations') &&
      dashboardAiFunctionSource.includes('thoughtSignature') &&
      dashboardAiFunctionSource.includes('modelPart: functionCallPart') &&
      dashboardAiFunctionSource.includes('parts: [result.modelPart]') &&
      dashboardAiFunctionSource.includes('resolveAgentMaxRounds') &&
      dashboardAiFunctionSource.includes('executeGeminiToolCall') &&
      dashboardAiFunctionSource.includes('boardPatchFromQueryResults') &&
      dashboardAiFunctionSource.includes('shouldPreferQueryResults') &&
      dashboardAiFunctionSource.includes('inferPromptDateRange') &&
      dashboardAiFunctionSource.includes('selectedSeasonSetFromContext') &&
      dashboardAiFunctionSource.includes('rich-markdown') &&
      dashboardAiFunctionSource.includes('html-preview') &&
      dashboardAiFunctionSource.includes('sanitizeHtmlPreview') &&
      dashboardAiFunctionSource.includes('rejected_unsafe_render') &&
      dashboardAiFunctionSource.includes('custom-table') &&
      dashboardAiFunctionSource.includes('sourceQueryId') &&
      dashboardAiFunctionSource.includes('dashboard_ai_query_aggregated') &&
      dashboardAiSharedSource.includes('DASHBOARD_AI_QUERY_GROUP_BY_COLUMNS') &&
      dashboardAiSharedSource.includes('inferDashboardAiDataQueryFromPrompt') &&
      queryAggregatedMigrationSource.includes('create or replace function reporting.query_aggregated') &&
      queryAggregatedMigrationSource.includes('security invoker') &&
      queryAggregatedMigrationSource.includes('allowed_group_by') &&
      queryAggregatedMigrationSource.includes("count(*) filter (where type = ''A'')") &&
      queryAggregatedWrapperMigrationSource.includes('create or replace function public.dashboard_ai_query_aggregated') &&
      queryAggregatedWrapperMigrationSource.includes('reporting.query_aggregated') &&
      queryAggregatedWrapperMigrationSource.includes('security invoker') &&
      queryAggregatedWrapperMigrationSource.includes('grant execute on function public.dashboard_ai_query_aggregated') &&
      queryRowsMigrationSource.includes('create or replace function public.dashboard_ai_query_rows') &&
      queryRowsMigrationSource.includes('security invoker') &&
      queryRowsMigrationSource.includes('allowed_views') &&
      queryRowsMigrationSource.includes('grant execute on function public.dashboard_ai_query_rows') &&
      !dashboardAiFunctionSource.includes('SUPABASE_SERVICE_ROLE_KEY'),
    'Dashboard AI Edge Function must resolve query_dashboard_data through RPC aggregate/tool calling and shared allowlists without exposing service-role secrets'
  );
  assert(
    dashboardAiWorkspaceUiSource.includes('block.table?.rows') &&
      dashboardAiWorkspaceUiSource.includes('block.chart?.rows') &&
      dashboardAiWorkspaceUiSource.includes('block.chart?.series') &&
      aiNotebookBlockRenderersSource.includes("block.chart?.chartType === 'heatmap'") &&
      aiNotebookBlockRenderersSource.includes("block.chart?.chartType === 'waterfall'") &&
      aiNotebookBlockRenderersSource.includes('sandbox=""') &&
      !aiNotebookBlockRenderersSource.includes('allow-popups-to-escape-sandbox') &&
      aiNotebookBlockRenderersSource.includes('__base') &&
      aiNotebookBlockRenderersSource.includes('__delta'),
    'AI Notebook renderer must honor custom table rows, chart rows, chart series, heatmap, and waterfall specs'
  );
  assert(
    dashboardPageSource.includes('AiWorkspacePanel') &&
      aiWorkspacePanelSource.includes('actions.submitPrompt(preset.prompt') &&
      dashboardPageSource.includes('cancelAiPrompt') &&
      !dashboardPageSource.includes('data-testid="ai-notebook-cell" className="rounded-lg border border-surface-variant bg-surface-container-lowest p-4 shadow-sm"') &&
      !dashboardPageSource.includes('<input\n                    value={aiPrompt}') &&
      aiWorkspacePanelSource.includes('AI_PRESET_GROUPS') &&
      aiWorkspacePanelSource.includes('Tạo báo cáo') &&
      aiWorkspacePanelSource.includes('Hỏi AI') &&
      aiWorkspacePanelSource.includes('Xuất Excel') &&
      aiNotebookCanvasSource.includes('<textarea') &&
      aiNotebookCanvasSource.includes('Ctrl+Enter') &&
      aiNotebookCanvasSource.includes('onCancel') &&
      aiNotebookCanvasSource.includes('aria-live="polite"') &&
      aiNotebookCanvasSource.includes('elapsedSeconds') &&
      aiNotebookCanvasSource.includes('data-testid="ai-notebook-cancel"') &&
      aiNotebookCanvasSource.includes('data-testid="ai-notebook-prompt-composer"') &&
      aiNotebookBlockRenderersSource.includes('BLOCK_TYPE_LABELS') &&
      aiNotebookBlockRenderersSource.includes('SOURCE_LABELS') &&
      aiNotebookBlockRenderersSource.includes('sticky top-0') &&
      aiNotebookBlockRenderersSource.includes('hover:bg-surface-container-low') &&
      aiNotebookBlockRenderersSource.includes('AI_CHART_PALETTE') &&
      aiNotebookBlockRenderersSource.includes('grid gap-2 sm:grid-cols-2 lg:grid-cols-4') &&
      aiNotebookBlockRenderersSource.includes('animationDelay'),
    'AI Workspace UI refactor must use route-local notebook components with textarea composer, cancelable loading, grouped toolbar, translated block badges, and polished tables/charts'
  );
  assert(
    dashboardReportExportSource.includes('CANONICAL_DASHBOARD_REPORT_COLUMNS') &&
      dashboardReportExportSource.includes('buildMomWowAnalysisWorkbook') &&
      dashboardReportExportSource.includes('buildSanLuongSummaryWorkbook') &&
      dashboardReportExportSource.includes('buildCustomDashboardWorkbook') &&
      dashboardReportExportSource.includes('Report Guide') &&
      dashboardReportExportSource.includes('Frequency') &&
      dashboardReportExportSource.includes('Per30min') &&
      dashboardReportExportSource.includes('30days') &&
      dashboardReportExportSource.includes('ACType') &&
      !aiWorkspacePanelSource.includes('Xuáº¥t Excel MoM/WoW') &&
      aiWorkspacePanelSource.includes('Xuất tổng hợp sản lượng') &&
      aiNotebookCanvasSource.includes('Tải Excel') &&
      dashboardPageSource.includes('Tạo báo cáo trực quan') &&
      dashboardPageSource.includes('downloadAiNotebookExport') &&
      aiNotebookCanvasSource.includes('cell.exportAction') &&
      aiNotebookBlockRenderersSource.includes('AiNotebookBlockCard'),
    'Dashboard AI export harness must keep fixed workbooks outside MoM/WoW AI toolbar noise and expose inline notebook download controls'
  );
  assert(
    settingsUiSource.includes('AI Analysis') &&
      settingsPageSource.includes('syncDashboardAiProviderKey') &&
      settingsUiSource.includes('can_manage_ai') &&
      settingsUiSource.includes('can_use_ai') &&
      settingsUiSource.includes('Add AI Model') &&
      settingsUiSource.includes('Save & Sync Local Provider Key') &&
      settingsUiSource.includes('Save & Sync Key') &&
      settingsUiSource.includes('Default dashboard model') &&
      settingsUiSource.includes('min-w-[260px]') &&
      settingsUiSource.includes('Rules') &&
      settingsUiSource.includes('Skills') &&
      settingsUiSource.includes('Import .md') &&
      settingsUiSource.includes('New Rule') &&
      settingsUiSource.includes('New Skill') && 
      settingsUiSource.includes('Markdown editor') && 
      settingsUiSource.includes('Default AI EDA Skill Pack') && 
      settingsUiSource.includes('Install default pack') && 
      settingsUiSource.includes('Reset default pack') && 
      settingsUiSource.includes('buildDefaultAiAnalysisContextDocuments') && 
      settingsUiSource.includes('<textarea') && 
      settingsUiSource.includes('contentMd') && 
      settingsPageSource.includes('aiAnalysis'),
    'Settings route must expose AI Analysis model configuration, Rules/Skills markdown editor, and admin-only synced local provider key controls without a collapsed default model selector'
  );
  assert(
    schemaSource.includes('can_manage_ai boolean not null default false') &&
      schemaSource.includes('can_use_ai boolean not null default true') &&
      schemaSource.includes('operational_ai_provider_keys') &&
      schemaSource.includes('secret_value text not null') &&
      schemaSource.includes('key_fingerprint text not null') &&
      schemaSource.includes('app_operator_can_use_ai') &&
      schemaSource.includes('app_operator_can_manage_ai') &&
      schemaSource.includes('sync_ai_provider_key') &&
      schemaSource.includes('fetch_ai_provider_key') &&
      schemaSource.includes('list_ai_provider_key_status') &&
      schemaSource.includes('ai users can read provider keys') &&
      schemaSource.includes('ai managers can update provider keys') &&
      schemaSource.includes('operational_ai_context_documents') &&
      schemaSource.includes("kind text not null check (kind in ('rule', 'skill'))") &&
      schemaSource.includes('content_md text not null') &&
      schemaSource.includes('update public.app_operators') &&
      schemaSource.includes('set can_manage_ai = true') &&
      !schemaSource.includes('ai_chat_messages') &&
      !schemaSource.includes('ai_chat_sessions'),
    'Supabase schema must add app_operators.can_manage_ai/can_use_ai, synced provider keys, and operational_ai_context_documents while avoiding remote AI chat history tables'
  );
  assert(
    dashboardAiFunctionSource.includes('dashboard-ai-analysis') &&
      dashboardAiFunctionSource.includes('DASHBOARD_AI_GROUNDING_INSTRUCTIONS') &&
      dashboardAiFunctionSource.includes('generateContent') &&
      dashboardAiFunctionSource.includes('/chat/completions') &&
      dashboardAiFunctionSource.includes('inferExportAction') &&
      dashboardAiFunctionSource.includes('exportAction') &&
      dashboardAiFunctionSource.includes('visualReport') &&
      dashboardAiFunctionSource.includes('boardPatch') &&
      dashboardAiFunctionSource.includes('preferredTool') &&
      dashboardAiFunctionSource.includes('inferBoardPatch') &&
      dashboardAiFunctionSource.includes('toolTraceSummary') &&
      dashboardAiFunctionSource.includes('LANGUAGE_POLICY') &&
      dashboardAiFunctionSource.includes('language: vi') &&
      dashboardAiFunctionSource.includes('languagePolicy') &&
      dashboardAiFunctionSource.includes('selectedSkillId') &&
      dashboardAiFunctionSource.includes('contextProfile') &&
      dashboardAiFunctionSource.includes('notebookContext') &&
      dashboardAiFunctionSource.includes('toolsets') &&
      dashboardAiFunctionSource.includes('AI Workspace is query-only and independent') &&
      dashboardAiFunctionSource.includes('asking for data again') &&
      dashboardAiFunctionSource.includes('allowedTools') &&
      dashboardAiFunctionSource.includes('allowedVisualReports') &&
      dashboardAiFunctionSource.includes('maxRounds') &&
      dashboardAiFunctionSource.includes('compose_dashboard_ai_board') &&
      dashboardAiFunctionSource.includes('suggest_visual_report') &&
      dashboardAiFunctionSource.includes('dataRequest') &&
      dashboardAiFunctionSource.includes('dashboard-custom-workbook') &&
      dashboardAiFunctionSource.includes('parseStructuredAssistantPayload') &&
      dashboardAiFunctionSource.includes('DASHBOARD_AI_GEMINI_API_KEY') &&
      dashboardAiFunctionSource.includes('DASHBOARD_AI_OPENAI_COMPATIBLE_API_KEY') &&
      dashboardAiFunctionSource.includes('DASHBOARD_AI_DEEPSEEK_API_KEY') &&
      dashboardAiFunctionSource.includes('DeepSeek API key is not configured') &&
      dashboardAiFunctionSource.includes('app_operators') &&
      dashboardAiFunctionSource.includes("from('operational_ai_models')") &&
      dashboardAiFunctionSource.includes("from('operational_ai_context_documents')") &&
      dashboardAiFunctionSource.includes('CUSTOM_RULES_MD') && 
      dashboardAiFunctionSource.includes('CUSTOM_SKILLS_MD') && 
      dashboardAiFunctionSource.includes('validated-sql-analyst') && 
      dashboardAiFunctionSource.includes('eda-profile') && 
      dashboardAiFunctionSource.includes('answer-verification') && 
      dashboardAiFunctionSource.includes('safe-rendering-policy') && 
      dashboardAiFunctionSource.includes('HTML/CSS') && 
      dashboardAiFunctionSource.includes('Python execution') && 
      dashboardAiFunctionSource.includes('CUSTOM_CONTEXT_MAX_CHARS') && 
      dashboardAiFunctionSource.includes("select('ai_enabled,ai_active_model_id')") &&
      dashboardAiFunctionSource.includes('buildRelationalAiSettingsPayload') &&
      !dashboardAiFunctionSource.includes(".select('payload')") &&
      !dashboardAiFunctionSource.includes('NEXT_PUBLIC_AI_API_KEY'),
    'dashboard-ai-analysis Edge Function must remain a validated legacy/web fallback with grounding context and provider-secret isolation'
  );
  assert(
      dashboardAiAdminSource.includes('syncDashboardAiProviderKey') &&
      dashboardAiAdminSource.includes("rpc('sync_ai_provider_key'") &&
      dashboardAiAdminSource.includes("rpc('fetch_ai_provider_key'") &&
      dashboardAiAdminSource.includes("rpc('list_ai_provider_key_status'") &&
      dashboardAiAdminSource.includes('secret_value') &&
      dashboardAiAdminSource.includes('key_fingerprint') &&
      dashboardAiAdminSource.includes('fetchDashboardAiProviderKey') &&
      dashboardAiAdminSource.includes('can_use_ai') &&
      dashboardAiAdminSource.includes('Provider đã có key') &&
      settingsUiSource.includes('Save & Sync Local Provider Key') &&
      !settingsUiSource.includes('Keys are sent to the Edge Function secret store') &&
      settingsUiSource.includes('<option value="deepseek">DeepSeek</option>') &&
      schemaSource.includes("provider in ('gemini', 'openai-compatible', 'deepseek')") &&
      !dashboardAiAdminSource.includes("functions.invoke('rotate-dashboard-ai-key'") &&
      !settingsUiSource.includes('Rotate Provider Key'),
    'AI provider key settings must sync local provider keys through DB/RLS instead of rotating Edge Function secrets for desktop AI'
  );
  assert(
    !dashboardPageSource.includes('saveOperationalSettings') &&
      !dashboardPageSource.includes('applyLocalModificationBatch') &&
      !dashboardPageSource.includes('applyLocalFlightRecordMutation') &&
      !dashboardPageSource.includes('syncSeasonWorkspace') &&
      !dashboardPageSource.includes('saveLocalSeasonWorkspace'),
    'Dashboard analysis v1 must remain read-only against local effective records'
  );
  assert(
    appSidebarSource.includes("{ href: '/', label: 'Dashboard'") &&
      appSidebarSource.includes("{ href: '/seasonal', label: 'Seasonal Schedule'") &&
      appSidebarSource.indexOf("{ href: '/', label: 'Dashboard'") < appSidebarSource.indexOf("{ href: '/seasonal', label: 'Seasonal Schedule'") &&
      dashboardPageSource.includes('Dashboard'),
    'Dashboard navigation must be wired through the global app sidebar'
  );
  assert(
    settingsUiSource.includes('A/C Group') &&
      settingsUiSource.includes('Default Counter Allocation') &&
      settingsUiSource.includes('Check-in Counters') &&
      settingsPageSource.includes('parseCheckInCounterInventoryInput') &&
      settingsPageSource.includes('checkInCounters') &&
      settingsUiSource.includes('checkInCounterGroups') &&
      settingsUiSource.includes('checkInCounterLocks') &&
      settingsUiSource.includes('datetime-local') &&
      settingsUiSource.includes('BHS') &&
      settingsUiSource.includes('Transit') &&
      settingsUiSource.includes('Delete Counter') &&
      settingsUiSource.includes('Delete Counter Group') &&
      settingsUiSource.includes('Delete Counter Lock') &&
      settingsUiSource.includes('No A/C groups yet') &&
      settingsUiSource.includes('No counter rules yet'),
    'Settings route must render aircraft, allocation, and check-in counter configuration tabs with editable counter/group/lock management'
  );
  assert(
    settingsPageSource.includes('confirmCheckInCounterLabelChange') &&
      settingsPageSource.includes('showConfirm({') &&
      settingsPageSource.includes('Changing a counter label can affect existing groups, locks, and allocations') &&
      settingsPageSource.indexOf('showConfirm({') < settingsPageSource.indexOf('renameCheckInCounterLabelInSettings(current, counter.id, normalizedLabel, currentTimestamp())') &&
      settingsUiSource.includes('onBlur={(event) => void confirmCheckInCounterLabelChange(counter, event.target.value)}') &&
      settingsUiSource.includes('toggleCheckInCounterGroupCounter(group.id, counter.id)') &&
      settingsUiSource.includes('toggleCheckInCounterLockCounter(lock, counter.id)'),
    'Settings page must confirm identity-changing counter renames before calling the pure rename helper'
  );
  assert(
    appSidebarSource.includes("{ href: '/settings', label: 'Settings'") &&
      !seasonalPageSource.includes('Aviation Command') &&
      !seasonalPageSource.includes('Ops Control Center') &&
      !seasonalPageSource.includes('Dashboard</span>') &&
      !seasonalPageSource.includes('Analytics</span>') &&
      !seasonalPageSource.includes('Reports</span>') &&
      !seasonalPageSource.includes('notifications</span>') &&
      !seasonalPageSource.includes('account_circle</span>') &&
      !seasonalPageSource.includes('{/* SideNavBar */}') &&
      !seasonalPageSource.includes('ml-64'),
    'Seasonal route must rely on the global AppSidebar and must not render duplicate local nav, fake breadcrumbs, or placeholder notification/account controls'
  );
  assert(
    workspacePageHeaderSource.includes('export default function WorkspacePageHeader') &&
      workspacePageHeaderSource.includes('title: ReactNode') &&
      workspacePageHeaderSource.includes('primaryActions?: ReactNode') &&
      workspacePageHeaderSource.includes('secondaryActions?: ReactNode') &&
      headerActionMenuSource.includes('export interface HeaderActionMenuItem') &&
      headerActionMenuSource.includes('export default function HeaderActionMenu') &&
      headerActionMenuSource.includes('more_vert') &&
      seasonalPageSource.includes('WorkspacePageHeader') &&
      detailedPageSource.includes('WorkspacePageHeader') &&
      detailedPageSource.includes('HeaderActionMenu'),
    'Seasonal and Detailed route chrome must use shared WorkspacePageHeader and HeaderActionMenu helpers'
  );
  assert(
    seasonalPageSource.includes("setIsNewFlightOpen(true)") &&
      seasonalPageSource.includes('New Flight') &&
      seasonalPageSource.includes('material-symbols-outlined text-[16px]">add'),
    'Seasonal header must expose a New Flight primary action that opens the existing modal'
  );
  assert(
    seasonalPageSource.includes('grid-cols-1 md:grid-cols-3') &&
      seasonalPageSource.includes('Season Validity') &&
      seasonalPageSource.includes('aria-label="Seasonal schedule table toolbar"') &&
      seasonalPageSource.indexOf('aria-label="Seasonal schedule KPI summary"') < seasonalPageSource.indexOf('aria-label="Seasonal schedule table toolbar"'),
    'Seasonal KPI cards must contain metrics only, with import/filter/export actions moved into a separate toolbar'
  );
  assert(
    seasonalPageSource.includes('aria-label="Actions column"') &&
      seasonalPageSource.includes('first_page') &&
      seasonalPageSource.includes('last_page') &&
      seasonalPageSource.includes('Page {page + 1} of {totalPages}'),
    'Seasonal table must include an Actions header column and richer first/previous/next/last pagination state'
  );
  assert(
    !seasonalPageSource.includes('text-[10px] font-normal focus:outline-none focus:border-primary') &&
      seasonalPageSource.includes('type="date"') &&
      seasonalPageSource.includes('text-xs font-normal focus:outline-none focus:border-primary'),
    'Seasonal validity date filters must use readable text-xs typography instead of hardcoded 10px text'
  );
  assert(
    detailedPageSource.includes('Keyboard Shortcuts') &&
      detailedPageSource.includes('Ctrl+C') &&
      detailedPageSource.includes('Ctrl+V') &&
      detailedPageSource.includes('Ctrl+A') &&
      detailedPageSource.includes('Shift+Click') &&
      detailedPageSource.includes('showAlert({') &&
      detailedPageSource.includes("title: 'Keyboard Shortcuts'"),
    'Detailed route must expose a Shortcuts action that documents the existing keyboard interactions'
  );
  assert(
    detailedPageSource.includes('buildDetailedScheduleQueryWindow({') &&
      detailedPageSource.includes('filterDetailedLegsForView(') &&
      !detailedPageSource.includes('flightNumberFilter: targetArrFlight || targetDepFlight || null') &&
      !detailedPageSource.includes('flightNumberFilter: activeArr || activeDep || null'),
    'Detailed route must load enough schedule context to render linked-flight counterparts instead of filtering them out at the native query boundary'
  );
  assert(
    detailedPageSource.includes('assertNoDuplicateFlightNumbersForEffectiveRecords(') &&
      dailyPageSource.includes('assertNoDuplicateFlightNumbersForEffectiveRecords(') &&
      !detailedPageSource.includes('assertNoDuplicateFlightNumbers([...workspace.records, ...addedRecords])') &&
      !dailyPageSource.includes('assertNoDuplicateFlightNumbers([...workspace.records, ...addedRecords])'),
    'Detailed and Daily add flows must validate added flights against effective active records, not raw workspace.records'
  );
  assert(
    (nativeSeasonBootstrapSource.includes('importNativeSeasonSnapshot({') ||
      nativeSeasonBootstrapSource.includes('importNativeSeasonSnapshot(snapshotInput)')) &&
      !/runNativeSeasonCatchup\(\{[\s\S]{0,500}localCursor:\s*0/.test(nativeSeasonBootstrapSource) &&
      !nativeSeasonBootstrapSource.includes('localCursor: 0,'),
    'Native fresh-install bootstrap must not replay historical server events from cursor 0 after importing a server snapshot'
  );
  assert(
    supabaseSchemaSource.includes('m.leg_id in (select record_id from flight_record_ids)') &&
      supabaseSchemaSource.includes("m.action = 'added'") &&
      supabaseSchemaSource.includes('al.season_id = p_season_id') &&
      !supabaseSchemaSource.includes('where m.season_id = p_season_id\n       or m.leg_id in (select record_id from flight_record_ids)'),
    'Server workspace snapshots must exclude orphan modifications whose leg_id is not a current flight record or valid added-leg row'
  );
  assert(
    nativeCatchupRustSource.includes('filter_snapshot_modifications') &&
      nativeCatchupRustSource.includes('is_valid_snapshot_modification') &&
      nativeCatchupRustSource.includes('should_skip_orphan_modification_event') &&
      nativeCatchupRustSource.includes('native-orphan-modification') &&
      nativeCatchupRustSource.includes('filter_snapshot_modifications(&input.records, &input.modifications)'),
    'Native snapshot import and event replay must guard against orphan modification rows from stale server history'
  );

  fs.rmSync(tempDir, { recursive: true, force: true });
  console.log('rule regression tests passed');
}

run().catch((err) => {
  fs.rmSync(tempDir, { recursive: true, force: true });
  console.error(err);
  process.exit(1);
});

