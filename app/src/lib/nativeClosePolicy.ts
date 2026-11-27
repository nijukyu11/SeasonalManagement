import {
  getAllSeasonalPlanningRouteGuards,
  type SeasonalPlanningRouteGuardState,
} from './seasonalPlanningSaveManager.ts';
import {
  getExecutingSeasonalRestoreAttempt,
  getSynchronousOperatorUserId,
  loadSeasonalRestoreAttempt,
} from './seasonalRestoreJournal.ts';
import {
  hasSeasonalDraftImportUnknownCommit,
  isSeasonalDraftImportCommitting,
  isSeasonalDraftImportUploading,
  isSeasonalPublishActive,
} from './seasonalMutationFences.ts';

export const NATIVE_CLOSE_CONFIRM_COPY = {
  title: 'Đóng ứng dụng?',
  message: 'Đóng ứng dụng sẽ hủy các bản nháp chưa lưu trong bộ nhớ và lịch sử hoàn tác. Dữ liệu đã lưu trên máy chủ không bị ảnh hưởng.',
  confirmLabel: 'Đóng ứng dụng',
  cancelLabel: 'Hủy',
} as const;

export type NativeCloseDecision =
  | {
      action: 'block';
      title: string;
      reason: string;
    }
  | {
      action: 'confirm';
      kind: 'ordinary' | 'unconfirmed-warning';
      title: string;
      message: string;
      confirmLabel: string;
      cancelLabel: string;
      tone?: 'warning' | 'error';
    };

export interface OperationalScheduleCloseStatus {
  mutating: boolean;
  importing: boolean;
  unresolvedAttempt: boolean;
}

let operationalStoreReader: (() => OperationalScheduleCloseStatus) | null = null;

export function registerOperationalScheduleCloseReader(
  reader: () => OperationalScheduleCloseStatus,
): void {
  operationalStoreReader = reader;
}

function readActiveDailyUploadJournalStatus(operatorId: string): 'uploading' | 'staged' | 'committed' | null {
  if (typeof window === 'undefined' || !window.localStorage) return null;
  try {
    const raw = window.localStorage.getItem(`daily:chunked-upload:op:${operatorId}:active`);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || parsed.operatorId !== operatorId) return null;
    return parsed?.status ?? null;
  } catch {
    return null;
  }
}

function readPersistedOperationalUnresolved(operatorId: string): boolean {
  if (typeof window === 'undefined' || !window.localStorage) return false;
  try {
    const raw = window.localStorage.getItem(`operational:pending-mutation:v2:${operatorId}`);
    if (!raw) return false;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return false;
    if (parsed.ownerUserId && parsed.ownerUserId !== operatorId) return false;
    return typeof parsed.requestId === 'string' && Boolean(parsed.requestId);
  } catch {
    return false;
  }
}

export interface NativeCloseInspectionContext {
  planningGuards?: SeasonalPlanningRouteGuardState[];
  seasonalRestoreExecuting?: boolean;
  seasonalRestorePersistedStatus?: 'executing' | 'unresolved' | 'committed' | null;
  operationalMutating?: boolean;
  operationalImporting?: boolean;
  hasOperationalUnresolvedAttempt?: boolean;
  dailyUploadJournalStatus?: 'uploading' | 'staged' | 'committed' | null;
  seasonalPublishActive?: boolean;
  seasonalDraftImportCommitting?: boolean;
  seasonalDraftImportUploading?: boolean;
  hasSeasonalDraftImportUnknownCommit?: boolean;
}

export function evaluateNativeCloseSafety(
  context?: NativeCloseInspectionContext,
): NativeCloseDecision {
  const operatorId = getSynchronousOperatorUserId();

  // =========================================================================
  // 1. HARD BLOCK: ONLY in-memory actual in-flight operations
  // =========================================================================

  // Seasonal Publish in flight
  if (context?.seasonalPublishActive ?? isSeasonalPublishActive()) {
    return {
      action: 'block',
      title: 'Đang công bố lịch mùa',
      reason: 'Ứng dụng đang thực hiện công bố lịch mùa sang lịch vận hành. Đóng ứng dụng lúc này có thể làm gián đoạn quá trình công bố. Vui lòng chờ hoàn tất.',
    };
  }

  // Seasonal Draft Import: uploading or committing in memory
  if (context?.seasonalDraftImportCommitting ?? isSeasonalDraftImportCommitting()) {
    return {
      action: 'block',
      title: 'Đang lưu nhập lịch mùa',
      reason: 'Ứng dụng đang lưu đợt nhập lịch mùa lên máy chủ. Vui lòng chờ hoàn tất trước khi đóng ứng dụng.',
    };
  }

  if (context?.seasonalDraftImportUploading ?? isSeasonalDraftImportUploading()) {
    return {
      action: 'block',
      title: 'Đang xử lý tệp lịch mùa',
      reason: 'Ứng dụng đang tải lên và xử lý tệp lịch mùa. Vui lòng chờ hoàn tất trước khi đóng ứng dụng.',
    };
  }

  // Seasonal Planning Draft Save in flight
  const planningGuards = context?.planningGuards ?? getAllSeasonalPlanningRouteGuards();
  for (const guard of planningGuards) {
    if (guard.status === 'saving') {
      return {
        action: 'block',
        title: 'Đang lưu bản nháp lịch mùa',
        reason: 'Ứng dụng đang gửi thay đổi kế hoạch lịch mùa lên máy chủ. Vui lòng chờ quá trình lưu hoàn tất trước khi đóng ứng dụng để tránh mất dữ liệu.',
      };
    }
  }

  // Seasonal Version Restore: actual in-memory execution
  const restoreExecuting = context?.seasonalRestoreExecuting ?? (operatorId ? Boolean(getExecutingSeasonalRestoreAttempt(operatorId)) : false);
  if (restoreExecuting) {
    return {
      action: 'block',
      title: 'Đang khôi phục phiên bản lịch mùa',
      reason: 'Thao tác khôi phục phiên bản lịch mùa đang được xử lý trên máy chủ. Vui lòng chờ hoàn tất trước khi đóng ứng dụng.',
    };
  }

  // Operational Schedule Store: in-memory mutating or importing
  let opMutating = context?.operationalMutating;
  let opImporting = context?.operationalImporting;
  let hasOpUnresolved = context?.hasOperationalUnresolvedAttempt;

  if (opMutating === undefined || opImporting === undefined || hasOpUnresolved === undefined) {
    if (operationalStoreReader) {
      const opState = operationalStoreReader();
      if (opMutating === undefined) opMutating = opState.mutating;
      if (opImporting === undefined) opImporting = opState.importing;
      if (hasOpUnresolved === undefined) hasOpUnresolved = opState.unresolvedAttempt;
    } else if (operatorId) {
      if (hasOpUnresolved === undefined) hasOpUnresolved = readPersistedOperationalUnresolved(operatorId);
    }
  }

  if (opMutating) {
    return {
      action: 'block',
      title: 'Đang lưu thay đổi vận hành',
      reason: 'Ứng dụng đang cập nhật phân bổ vận hành lên máy chủ. Vui lòng chờ quá trình lưu hoàn tất trước khi đóng ứng dụng.',
    };
  }

  if (opImporting) {
    return {
      action: 'block',
      title: 'Đang nhập lịch vận hành',
      reason: 'Ứng dụng đang xử lý đợt nhập dữ liệu vận hành. Vui lòng chờ hoàn tất trước khi đóng ứng dụng.',
    };
  }

  // =========================================================================
  // 2. CONFIRM WITH EXPLICIT UNCONFIRMED WARNING: unconfirmed or persisted states
  // =========================================================================

  // Seasonal Draft Import unknown-commit
  if (context?.hasSeasonalDraftImportUnknownCommit ?? hasSeasonalDraftImportUnknownCommit()) {
    return {
      action: 'confirm',
      kind: 'unconfirmed-warning',
      title: 'Đợt nhập lịch mùa chưa được xác nhận',
      message: 'Có đợt nhập lịch mùa chưa được xác nhận hoàn tất trên máy chủ. Biên nhận nhập vẫn được lưu trữ, nhưng bạn nên kiểm tra lại trạng thái nhập trước khi đóng.',
      confirmLabel: 'Đóng dù chưa xác nhận',
      cancelLabel: 'Hủy',
      tone: 'error',
    };
  }

  // Seasonal Planning: unconfirmed changes needing retry
  for (const guard of planningGuards) {
    if (guard.hasUnconfirmedChanges) {
      const memoryPayloadWarning = guard.pendingRequest
        ? 'Có thay đổi kế hoạch lịch mùa chưa được xác nhận từ máy chủ. Dữ liệu thử lại đang được giữ trong bộ nhớ tạm và sẽ bị mất nếu đóng ứng dụng lúc này.'
        : 'Có thay đổi kế hoạch lịch mùa chưa được xác nhận từ máy chủ. Vui lòng thử lưu lại hoặc kiểm tra kết nối trước khi đóng ứng dụng.';
      return {
        action: 'confirm',
        kind: 'unconfirmed-warning',
        title: 'Thay đổi kế hoạch mùa chưa được xác nhận',
        message: memoryPayloadWarning,
        confirmLabel: 'Đóng dù chưa xác nhận',
        cancelLabel: 'Hủy',
        tone: 'error',
      };
    }
  }

  // Seasonal Version Restore: persisted in journal after restart/crash (not currently in-memory executing)
  const persistedRestoreStatus = context?.seasonalRestorePersistedStatus !== undefined
    ? context.seasonalRestorePersistedStatus
    : (operatorId ? loadSeasonalRestoreAttempt(undefined, { ownerUserId: operatorId })?.status : null);

  if (persistedRestoreStatus === 'executing' || persistedRestoreStatus === 'unresolved') {
    return {
      action: 'confirm',
      kind: 'unconfirmed-warning',
      title: persistedRestoreStatus === 'unresolved' ? 'Yêu cầu khôi phục chưa được xác nhận' : 'Thao tác khôi phục trước đó chưa hoàn tất',
      message: 'Thao tác khôi phục phiên bản lịch mùa trước đó chưa nhận được xác nhận từ máy chủ. Biên nhận khôi phục vẫn được lưu để xử lý lại khi mở ứng dụng.',
      confirmLabel: 'Đóng dù chưa xác nhận',
      cancelLabel: 'Hủy',
      tone: 'error',
    };
  }

  // Operational Schedule Store: unresolved attempt in store or persisted
  if (hasOpUnresolved) {
    return {
      action: 'confirm',
      kind: 'unconfirmed-warning',
      title: 'Thao tác vận hành chưa được xác nhận',
      message: 'Có thao tác cập nhật vận hành chưa nhận được xác nhận từ máy chủ. Biên nhận thay đổi vẫn được lưu trữ.',
      confirmLabel: 'Đóng dù chưa xác nhận',
      cancelLabel: 'Hủy',
      tone: 'error',
    };
  }

  // Daily Upload Journal: stale uploading journal after restart / crash
  const dailyJournalStatus = context?.dailyUploadJournalStatus !== undefined
    ? context.dailyUploadJournalStatus
    : (operatorId ? readActiveDailyUploadJournalStatus(operatorId) : null);

  if (dailyJournalStatus === 'uploading') {
    return {
      action: 'confirm',
      kind: 'unconfirmed-warning',
      title: 'Đợt tải lên lịch ngày chưa hoàn tất',
      message: 'Có đợt tải lên tệp lịch ngày trước đó chưa hoàn tất (có thể do phiên làm việc bị gián đoạn). Biên nhận tệp vẫn được giữ lại.',
      confirmLabel: 'Đóng dù chưa xác nhận',
      cancelLabel: 'Hủy',
      tone: 'warning',
    };
  }

  // =========================================================================
  // 3. ORDINARY CONFIRM: unsent in-memory drafts or completed commits awaiting reload
  // =========================================================================
  return {
    action: 'confirm',
    kind: 'ordinary',
    title: NATIVE_CLOSE_CONFIRM_COPY.title,
    message: NATIVE_CLOSE_CONFIRM_COPY.message,
    confirmLabel: NATIVE_CLOSE_CONFIRM_COPY.confirmLabel,
    cancelLabel: NATIVE_CLOSE_CONFIRM_COPY.cancelLabel,
    tone: 'warning',
  };
}
