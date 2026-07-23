const CANONICAL_SCHEDULE_TIME_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)$/;
const SINGLE_DIGIT_HOUR_PATTERN = /^([0-9]):([0-5]\d)$/;
const FOUR_DIGIT_COMPACT_PATTERN = /^([01]\d|2[0-3])([0-5]\d)$/;
const THREE_DIGIT_COMPACT_PATTERN = /^([0-9])([0-5]\d)$/;

/**
 * Converts schedule input to the canonical HH:mm format.
 *
 * UI text fields historically accepted compact values such as 1025. Supporting
 * that shorthand at the input boundary keeps persisted schedule data canonical.
 */
export function normalizeScheduleTime(value: string): string | null {
  const trimmed = value.trim();
  const canonical = CANONICAL_SCHEDULE_TIME_PATTERN.exec(trimmed);
  if (canonical) return `${canonical[1]}:${canonical[2]}`;

  const singleDigitHour = SINGLE_DIGIT_HOUR_PATTERN.exec(trimmed);
  if (singleDigitHour) return `0${singleDigitHour[1]}:${singleDigitHour[2]}`;

  const fourDigitCompact = FOUR_DIGIT_COMPACT_PATTERN.exec(trimmed);
  if (fourDigitCompact) return `${fourDigitCompact[1]}:${fourDigitCompact[2]}`;

  const threeDigitCompact = THREE_DIGIT_COMPACT_PATTERN.exec(trimmed);
  if (threeDigitCompact) return `0${threeDigitCompact[1]}:${threeDigitCompact[2]}`;

  return null;
}

export function requireScheduleTime(value: string, fieldName = 'schedule'): string {
  const normalized = normalizeScheduleTime(value);
  if (!normalized) {
    throw new Error(`${fieldName} must use HH:mm format.`);
  }
  return normalized;
}
