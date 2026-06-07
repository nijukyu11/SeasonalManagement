import type { RouteCountryMapping } from './types';

const ROUTE_COUNTRY_MAP: Record<string, string> = {
  "AGR": "India",
  "ALA": "Kazakhstan",
  "AMD": "India",
  "AXT": "Japan",
  "BAV": "China",
  "BAX": "Russia",
  "BHY": "China",
  "BKK": "Thailand",
  "BLR": "India",
  "BOM": "India",
  "BPE": "China",
  "BQS": "Russia",
  "CAN": "China",
  "CEB": "Philippines",
  "CGK": "Indonesia",
  "CGO": "China",
  "CGQ": "China",
  "CIT": "Kazakhstan",
  "CJJ": "Korea",
  "CJU": "Korea",
  "CKG": "China",
  "CNX": "Thailand",
  "CRK": "Phillipines",
  "CSX": "China",
  "CTS": "Japan",
  "CTU": "China",
  "CZX": "China",
  "DAT": "China",
  "DEL": "India",
  "DLC": "China",
  "DMB": "Kazakhstan",
  "DMK": "Thailand",
  "DNA": "Japan",
  "DOH": "Qata",
  "DPS": "Indonesia",
  "DVO": "Philippines",
  "DXB": "UAE",
  "DYG": "China",
  "ENH": "China",
  "FKS": "Japan",
  "FOC": "China",
  "FSZ": "Japan",
  "FUK": "Japan",
  "GMP": "China",
  "HAK": "China",
  "HET": "China",
  "HFE": "China",
  "HGH": "China",
  "HHA": "China",
  "HIA": "China",
  "HKG": "China",
  "HKT": "China",
  "HNA": "Japan",
  "HND": "Japan",
  "HRB": "China",
  "HUN": "China",
  "HYD": "India",
  "ICN": "Korea",
  "INC": "China",
  "JAI": "India",
  "JJN": "China",
  "KHH": "Taiwan",
  "KHN": "China",
  "KHV": "Russia",
  "KIJ": "Japan",
  "KIX": "Japan",
  "KJA": "Russia",
  "KMG": "China",
  "KNH": "China",
  "KNO": "Indonesia",
  "KTI": "Cambodia",
  "KTM": "Nepal",
  "KUL": "Malaysia",
  "KWE": "China",
  "KZN": "Russia",
  "LHW": "China",
  "LYI": "China",
  "MCT": "Oman",
  "MFM": "China",
  "MLE": "Maldives",
  "MNL": "Philippines",
  "MSQ": "Belarus",
  "MWX": "Korea",
  "MXP": "Italia",
  "MYJ": "Japan",
  "MZG": "Taiwan",
  "NGB": "China",
  "NGO": "Japan",
  "NKG": "China",
  "NNG": "China",
  "NOZ": "Russia",
  "NQZ": "Kazakhstan",
  "NRT": "Japan",
  "OKA": "Japan",
  "OKJ": "Japan",
  "OVB": "Russia",
  "PBH": "Bhutan",
  "PEK": "China",
  "PKX": "China",
  "PNH": "Cambodia",
  "PUS": "Korea",
  "PVG": "China",
  "REP": "Cambodia",
  "RGN": "Myanmar",
  "RMQ": "Taiwan",
  "SAI": "Cambodia",
  "SDJ": "Japan",
  "SHE": "China",
  "SHM": "Japan",
  "SIN": "Singapore",
  "SJW": "China",
  "SVO": "Russia",
  "SWA": "China",
  "SZB": "Malaysia",
  "SZX": "China",
  "TAE": "Korea",
  "TAK": "Japan",
  "TAS": "Uzbekistan",
  "TFU": "China",
  "TNA": "China",
  "TNN": "Taiwan",
  "TPE": "Taiwan",
  "TSN": "China",
  "TTT": "Taiwan",
  "TXN": "China",
  "TYN": "China",
  "UBN": "Mongolia",
  "UKB": "Japan",
  "VTE": "Lao",
  "VVO": "Russia",
  "WUH": "China",
  "WUX": "China",
  "XIY": "China",
  "XMN": "China",
  "XSP": "Singapore",
  "XUZ": "China",
  "YIH": "China",
  "YNY": "Korea",
  "ZGC": "China",
  "ZYI": "China",
};

export interface RouteCountryImportIssue {
  rowNumber: number;
  route: string;
  country: string;
  reason: string;
}

export interface RouteCountryImportResult {
  entries: RouteCountryMapping[];
  invalidRows: RouteCountryImportIssue[];
  duplicateRoutes: string[];
}

export function normalizeRouteCode(route: string | null | undefined): string {
  return String(route ?? '').trim().toUpperCase();
}

function normalizeCountryName(country: unknown): string {
  return String(country ?? '').trim();
}

function normalizeHeader(header: string): string {
  return header.trim().toLowerCase().replace(/[^a-z]/g, '');
}

function readRouteCountryCell(row: Record<string, unknown>, candidates: Set<string>): unknown {
  for (const [key, value] of Object.entries(row)) {
    if (candidates.has(normalizeHeader(key))) return value;
  }
  return undefined;
}

function buildRouteCountryMap(routeCountries: RouteCountryMapping[] | undefined): Record<string, string> {
  if (!routeCountries) return ROUTE_COUNTRY_MAP;
  return Object.fromEntries(
    routeCountries
      .map((entry) => [normalizeRouteCode(entry.route), normalizeCountryName(entry.country)] as const)
      .filter(([route, country]) => route && country)
  );
}

export function resolveCountryForRoute(
  route: string | null | undefined,
  routeCountries?: RouteCountryMapping[]
): string {
  const normalized = normalizeRouteCode(route);
  if (!normalized) return 'Unknown';
  return buildRouteCountryMap(routeCountries)[normalized] ?? 'Unknown';
}

export function listRouteCountries(): RouteCountryMapping[] {
  return Object.entries(ROUTE_COUNTRY_MAP).map(([route, country]) => ({ route, country }));
}

export function mergeRouteCountryMappings(
  currentEntries: RouteCountryMapping[],
  importedEntries: RouteCountryMapping[]
): RouteCountryMapping[] {
  const routeOrder: string[] = [];
  const merged = new Map<string, RouteCountryMapping>();

  const putEntry = (entry: RouteCountryMapping) => {
    const route = normalizeRouteCode(entry.route);
    const country = normalizeCountryName(entry.country);
    if (!route || !country) return;
    if (!merged.has(route)) routeOrder.push(route);
    merged.set(route, { route, country });
  };

  currentEntries.forEach(putEntry);
  importedEntries.forEach(putEntry);

  return routeOrder
    .map((route) => merged.get(route))
    .filter((entry): entry is RouteCountryMapping => entry != null);
}

export function parseRouteCountryRows(rows: Array<Record<string, unknown>>): RouteCountryImportResult {
  const routeHeaders = new Set(['route', 'routes']);
  const countryHeaders = new Set(['country', 'countries']);
  const entriesByRoute = new Map<string, RouteCountryMapping>();
  const duplicateRoutes = new Set<string>();
  const invalidRows: RouteCountryImportIssue[] = [];

  rows.forEach((row, index) => {
    const route = normalizeRouteCode(readRouteCountryCell(row, routeHeaders) as string | null | undefined);
    const country = normalizeCountryName(readRouteCountryCell(row, countryHeaders));
    if (!route && !country) return;
    if (!route) {
      invalidRows.push({ rowNumber: index + 2, route, country, reason: 'Route is required.' });
      return;
    }
    if (!country) {
      invalidRows.push({ rowNumber: index + 2, route, country, reason: 'Country is required.' });
      return;
    }
    if (entriesByRoute.has(route)) duplicateRoutes.add(route);
    entriesByRoute.set(route, { route, country });
  });

  return {
    entries: [...entriesByRoute.values()],
    invalidRows,
    duplicateRoutes: [...duplicateRoutes].sort(),
  };
}
