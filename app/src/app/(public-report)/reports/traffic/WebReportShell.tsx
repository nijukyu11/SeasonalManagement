import type { ReactNode } from 'react';

export default function WebReportShell({ children }: { children: ReactNode }) {
  return (
    <main id="traffic-report-root" className="min-h-dvh bg-[#f3f7fa] print:min-h-0 print:bg-white">
      <header className="border-b border-white/10 bg-[#081322] text-white print:border-b-slate-200 print:bg-white print:text-slate-900">
        <div className="mx-auto flex min-h-16 max-w-[1400px] items-center justify-between gap-4 px-5 sm:px-8">
          <a href="/reports/traffic" className="report-focus rounded-sm text-sm font-bold print:text-slate-900">
            AHT · Báo cáo sản lượng
          </a>
          <span className="hidden text-xs text-slate-300 sm:inline print:text-slate-600">Báo cáo công khai</span>
        </div>
      </header>
      {children}
      <footer className="border-t border-slate-200 bg-white print:border-t-slate-200">
        <div className="mx-auto max-w-[1400px] px-5 py-8 text-sm text-slate-600 sm:px-8">
          Ngày khai thác được tính từ 05:00 đến 04:59 theo giờ Việt Nam.
        </div>
      </footer>
    </main>
  );
}
