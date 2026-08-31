import { Suspense } from 'react';
import TrafficReportClient from './TrafficReportClient';
import WebReportShell from './WebReportShell';

function ReportLoading() {
  return (
    <div className="mx-auto max-w-7xl px-5 py-10 sm:px-8" role="status" aria-live="polite">
      <div className="h-28 animate-pulse rounded-2xl bg-slate-200" />
      <span className="sr-only">Đang tải báo cáo</span>
    </div>
  );
}

export default function TrafficReportPage() {
  return (
    <WebReportShell>
      <Suspense fallback={<ReportLoading />}>
        <TrafficReportClient />
      </Suspense>
    </WebReportShell>
  );
}
