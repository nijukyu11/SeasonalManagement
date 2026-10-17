import type { Metadata } from 'next';
import AppShell from './components/AppShell';
import '../globals.css';

export const metadata: Metadata = {
  title: 'Lịch mùa bay - Trung tâm điều hành',
  description: 'Quản lý lịch bay theo mùa - Trung tâm điều hành khai thác',
};

export default function DesktopRootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="vi">
      <head>
        <link
          rel="stylesheet"
          href="https://fonts.googleapis.com/css2?family=Material+Symbols+Outlined:opsz,wght,FILL,GRAD@20..48,100..700,0..1,-50..200&display=swap"
        />
      </head>
      <body>
        <AppShell>{children}</AppShell>
      </body>
    </html>
  );
}
