const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/u;

export function countCalendarMonths(from: string, to: string): number {
  if (!ISO_DATE_PATTERN.test(from) || !ISO_DATE_PATTERN.test(to)) {
    throw new Error('Khoảng ngày không hợp lệ.');
  }
  const [fromYear, fromMonth] = from.split('-').map(Number);
  const [toYear, toMonth] = to.split('-').map(Number);
  return (toYear - fromYear) * 12 + toMonth - fromMonth + 1;
}

export function shouldUseMonthlyTrend(from: string, to: string): boolean {
  return countCalendarMonths(from, to) > 3;
}
