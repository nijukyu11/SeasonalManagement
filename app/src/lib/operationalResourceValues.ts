export type NormalizedImportValue<T> =
  | { kind: 'value'; value: T }
  | { kind: 'missing' };

function textValue(value: unknown): string | null {
  if (value == null) return null;
  const text = String(value).trim();
  return text === '' ? null : text;
}

export function normalizeStandValue(value: unknown): string | null {
  const text = textValue(value);
  if (text == null) return null;
  const normalized = text
    .toUpperCase()
    .replace(/^STAND\s*/i, '')
    .replace(/\s+/g, '');
  if (!/^[1-9]\d*[A-Z]?$/.test(normalized)) {
    throw new Error(`Stand must be a positive number with an optional letter suffix, got ${text}`);
  }
  return normalized;
}

export function normalizeDailyGateValue(value: unknown): NormalizedImportValue<number> {
  const text = textValue(value);
  if (text == null || /^G$/i.test(text)) return { kind: 'missing' };
  const normalized = text.replace(/^G\s*/i, '');
  const parsed = Number(normalized);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`Gate must be G followed by a positive number, got ${text}`);
  }
  return { kind: 'value', value: parsed };
}

export function normalizeDailyCarouselValue(value: unknown): NormalizedImportValue<number> {
  const text = textValue(value);
  if (text == null || /^B$/i.test(text)) return { kind: 'missing' };
  const normalized = text.replace(/^B\s*/i, '');
  const parsed = Number(normalized);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`Carousel must be B followed by a positive number, got ${text}`);
  }
  return { kind: 'value', value: parsed };
}

export function normalizeCounterTokenText(value: string): string {
  const normalized = value.trim().toUpperCase();
  const counterMatch = /^C\s*0*(\d+)$/i.exec(normalized);
  if (counterMatch) return String(Number(counterMatch[1]));
  return normalized;
}

export function normalizeDailyCounterValue(value: unknown): NormalizedImportValue<string> {
  const text = textValue(value);
  if (text == null) return { kind: 'missing' };
  const normalized = text
    .split(/[,\s;]+/)
    .map(normalizeCounterTokenText)
    .filter(Boolean)
    .join(',');
  return normalized === ''
    ? { kind: 'missing' }
    : { kind: 'value', value: normalized };
}
