export interface SeasonalFlightFilterTarget {
  arrFlightNumber?: string | null;
  depFlightNumber?: string | null;
  airline?: string | null;
}

export function parseCommaFilterTerms(value: string | null | undefined): string[] {
  return String(value ?? '')
    .split(',')
    .map((term) => term.trim().toLowerCase())
    .filter(Boolean);
}

export function matchesSeasonalFlightFilter(target: SeasonalFlightFilterTarget, filter: string | null | undefined): boolean {
  const terms = parseCommaFilterTerms(filter);
  if (terms.length === 0) return true;
  const haystack = [
    target.arrFlightNumber,
    target.depFlightNumber,
    target.airline,
  ]
    .filter((value): value is string => Boolean(value))
    .join(' ')
    .toLowerCase();
  return terms.some((term) => haystack.includes(term));
}
