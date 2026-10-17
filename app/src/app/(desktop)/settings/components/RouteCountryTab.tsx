'use client';

import type { Dispatch, SetStateAction } from 'react';
import type { OperationalSettings, RouteCountryMapping } from '@/lib/types';
import { DeleteIconButton } from './SettingsTabControls';

type RouteCountryTabProps = {
  settings: OperationalSettings;
  routeCountryRoute: string;
  setRouteCountryRoute: Dispatch<SetStateAction<string>>;
  routeCountryCountry: string;
  setRouteCountryCountry: Dispatch<SetStateAction<string>>;
  routeCountrySearch: string;
  setRouteCountrySearch: Dispatch<SetStateAction<string>>;
  routeCountryImportStatus: string | null;
  routeCountryRows: RouteCountryMapping[];
  addOrUpdateRouteCountry: () => void;
  updateRouteCountry: (route: string, patch: Partial<RouteCountryMapping>) => void;
  deleteRouteCountry: (route: string) => Promise<void>;
  handleRouteCountryImport: (file: File | null) => Promise<void>;
};

export default function RouteCountryTab({
  settings,
  routeCountryRoute,
  setRouteCountryRoute,
  routeCountryCountry,
  setRouteCountryCountry,
  routeCountrySearch,
  setRouteCountrySearch,
  routeCountryImportStatus,
  routeCountryRows,
  addOrUpdateRouteCountry,
  updateRouteCountry,
  deleteRouteCountry,
  handleRouteCountryImport,
}: RouteCountryTabProps) {
  return (
    <section className="space-y-5">
      <div className="grid gap-5 xl:grid-cols-[360px_1fr]">
        <div className="rounded-lg border border-surface-variant bg-surface-container-lowest p-4 shadow-sm">
          <h2 className="font-title-md text-title-md text-on-surface">Thêm chặng - quốc gia</h2>
          <div className="mt-4 grid gap-3">
            <label className="block text-sm font-semibold text-on-surface">
              Chặng bay
              <input value={routeCountryRoute} onChange={(event) => setRouteCountryRoute(event.target.value.toUpperCase())} placeholder="ICN" className="mt-1 w-full rounded-lg border border-outline-variant bg-surface px-3 py-2 font-data-tabular text-sm focus:border-primary focus:outline-none" />
            </label>
            <label className="block text-sm font-semibold text-on-surface">
              Quốc gia
              <input value={routeCountryCountry} onChange={(event) => setRouteCountryCountry(event.target.value)} placeholder="Hàn Quốc" className="mt-1 w-full rounded-lg border border-outline-variant bg-surface px-3 py-2 text-sm focus:border-primary focus:outline-none" />
            </label>
            <button type="button" onClick={addOrUpdateRouteCountry} className="inline-flex w-fit items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-on-primary hover:bg-primary-container hover:text-on-primary-container">
              <span className="material-symbols-outlined text-[18px]">add_location_alt</span>
              Thêm / cập nhật chặng
            </button>
          </div>
        </div>

        <div className="rounded-lg border border-surface-variant bg-surface-container-lowest p-4 shadow-sm">
          <h2 className="font-title-md text-title-md text-on-surface">Cập nhật từ Excel</h2>
          <div className="mt-4 space-y-3">
            <p className="text-sm text-on-surface-variant">Tải lên tệp .xls hoặc .xlsx có hai cột tên là "Route" và "Country". Chặng đã có sẽ được cập nhật, chặng mới sẽ được thêm, chặng không có trong tệp được giữ nguyên.</p>
            <label className="inline-flex w-fit cursor-pointer items-center gap-2 rounded-lg border border-outline-variant px-4 py-2 text-sm font-semibold text-on-surface hover:bg-surface-container">
              <span className="material-symbols-outlined text-[18px]">upload_file</span>
              Tải lên tệp chặng - quốc gia
              <input
                type="file"
                accept=".xls,.xlsx"
                className="sr-only"
                onChange={(event) => {
                  const file = event.target.files?.[0] ?? null;
                  void handleRouteCountryImport(file);
                  event.currentTarget.value = '';
                }}
              />
            </label>
            {routeCountryImportStatus && (
              <div className="rounded-lg border border-teal-200 bg-teal-50 px-3 py-2 text-sm font-medium text-teal-900">{routeCountryImportStatus}</div>
            )}
          </div>
        </div>
      </div>

      <div className="rounded-lg border border-surface-variant bg-surface-container-lowest shadow-sm">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-surface-variant px-4 py-3">
          <div>
            <h2 className="font-title-md text-title-md text-on-surface">Bảng chặng - quốc gia</h2>
            <p className="text-sm text-on-surface-variant">Đã cấu hình {settings.routeCountries.length} chặng</p>
          </div>
          <label className="min-w-[260px] text-sm font-semibold text-on-surface">
            Tìm kiếm
            <input value={routeCountrySearch} onChange={(event) => setRouteCountrySearch(event.target.value)} placeholder="Chặng hoặc quốc gia" className="mt-1 w-full rounded-lg border border-outline-variant bg-surface px-3 py-2 text-sm focus:border-primary focus:outline-none" />
          </label>
        </div>
        {routeCountryRows.length === 0 ? (
          <div className="px-4 py-10 text-center text-sm text-on-surface-variant">Không có chặng nào khớp với tìm kiếm hiện tại</div>
        ) : (
          <div className="max-h-[560px] overflow-auto">
            <div className="grid min-w-[720px] grid-cols-[140px_1fr_56px] gap-3 border-b border-surface-variant bg-surface-container-low px-4 py-2 text-xs font-semibold uppercase tracking-wide text-on-surface-variant">
              <span>Chặng bay</span>
              <span>Quốc gia</span>
              <span className="text-right">Thao tác</span>
            </div>
            <div className="divide-y divide-surface-variant">
              {routeCountryRows.map((item) => (
                <div key={item.route} className="grid min-w-[720px] grid-cols-[140px_1fr_56px] items-center gap-3 px-4 py-3">
                  <input value={item.route} onChange={(event) => updateRouteCountry(item.route, { route: event.target.value })} className="rounded-lg border border-outline-variant bg-surface px-3 py-2 font-data-tabular text-sm font-semibold focus:border-primary focus:outline-none" />
                  <input value={item.country} onChange={(event) => updateRouteCountry(item.route, { country: event.target.value })} className="rounded-lg border border-outline-variant bg-surface px-3 py-2 text-sm focus:border-primary focus:outline-none" />
                  <DeleteIconButton label={`Xóa quốc gia của chặng ${item.route}`} onClick={() => void deleteRouteCountry(item.route)} />
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </section>
  );
}
