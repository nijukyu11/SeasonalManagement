import type { Metadata } from 'next';
import '../globals.css';
import './report.css';

export const metadata: Metadata = {
  title: 'Báo cáo sản lượng khai thác',
  description: 'Báo cáo công khai sản lượng chuyến bay và hành khách theo dãy ngày liên tục.',
};

export default function PublicReportRootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="vi">
      <body className="report-body">{children}</body>
    </html>
  );
}
