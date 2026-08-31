import type { Metadata } from 'next';
import { Suspense } from 'react';
import AnnualPassengerKpiDashboard from './AnnualPassengerKpiDashboard';

export const metadata: Metadata = {
  title: 'KPI sản lượng khách năm',
  description: 'Dashboard công khai theo dõi tiến độ KPI sản lượng khách năm.',
};

export default function AnnualPassengerKpiDashboardPage() {
  return (
    <Suspense fallback={<div className="min-h-dvh bg-slate-950" role="status" aria-label="Đang tải dashboard" />}>
      <AnnualPassengerKpiDashboard />
    </Suspense>
  );
}
