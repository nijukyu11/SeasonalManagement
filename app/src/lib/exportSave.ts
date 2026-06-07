import * as XLSX from 'xlsx';

export interface ExportSaveResult {
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  native: boolean;
  savedAt: string;
  filePath?: string;
  directory?: string;
  objectUrl?: string;
}

export interface SaveExportBlobInput {
  blob: Blob;
  fileName: string;
  mimeType: string;
}

const INVALID_WINDOWS_FILENAME_CHARS = /[<>:"/\\|?*\x00-\x1F]/g;
const DEFAULT_XLSX_MIME_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

export function sanitizeExportFileName(fileName: string): string {
  const cleaned = String(fileName || 'export')
    .replace(INVALID_WINDOWS_FILENAME_CHARS, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[. ]+$/g, '');
  return cleaned || 'export';
}

async function blobToBase64(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = '';
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    const chunk = bytes.subarray(offset, offset + chunkSize);
    binary += String.fromCharCode(...chunk);
  }
  return btoa(binary);
}

async function invokeTauriSave(input: SaveExportBlobInput, safeFileName: string): Promise<ExportSaveResult | null> {
  if (typeof window === 'undefined' || !('__TAURI_INTERNALS__' in window)) return null;

  const { invoke } = await import('@tauri-apps/api/core');
  const base64 = await blobToBase64(input.blob);
  return invoke<ExportSaveResult>('save_export_file', {
    input: {
      fileName: safeFileName,
      mimeType: input.mimeType,
      base64,
    },
  });
}

function browserDownload(input: SaveExportBlobInput, safeFileName: string): ExportSaveResult {
  const objectUrl = URL.createObjectURL(input.blob);
  const anchor = document.createElement('a');
  anchor.href = objectUrl;
  anchor.download = safeFileName;
  anchor.rel = 'noopener';
  anchor.style.display = 'none';
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(objectUrl), 60_000);

  return {
    fileName: safeFileName,
    mimeType: input.mimeType,
    sizeBytes: input.blob.size,
    native: false,
    savedAt: new Date().toISOString(),
    objectUrl,
  };
}

export async function saveExportBlob(input: SaveExportBlobInput): Promise<ExportSaveResult> {
  const safeFileName = sanitizeExportFileName(input.fileName);
  const nativeResult = await invokeTauriSave(input, safeFileName);
  if (nativeResult) return nativeResult;
  return browserDownload(input, safeFileName);
}

export function workbookToXlsxBlob(workbook: XLSX.WorkBook): Blob {
  const bytes = XLSX.write(workbook, { bookType: 'xlsx', type: 'array' });
  return new Blob([bytes], { type: DEFAULT_XLSX_MIME_TYPE });
}

export async function saveWorkbookAsXlsx(workbook: XLSX.WorkBook, fileName: string): Promise<ExportSaveResult> {
  return saveExportBlob({
    blob: workbookToXlsxBlob(workbook),
    fileName,
    mimeType: DEFAULT_XLSX_MIME_TYPE,
  });
}

export async function openSavedExport(result: ExportSaveResult): Promise<void> {
  if (result.native && result.filePath) {
    const { invoke } = await import('@tauri-apps/api/core');
    await invoke<void>('open_export_file', { filePath: result.filePath });
    return;
  }
  if (result.objectUrl) window.open(result.objectUrl, '_blank', 'noopener,noreferrer');
}

export async function revealSavedExport(result: ExportSaveResult): Promise<void> {
  if (result.native && result.filePath) {
    const { invoke } = await import('@tauri-apps/api/core');
    await invoke<void>('reveal_export_file', { filePath: result.filePath });
    return;
  }
  if (result.objectUrl) {
    const anchor = document.createElement('a');
    anchor.href = result.objectUrl;
    anchor.download = result.fileName;
    anchor.click();
  }
}
