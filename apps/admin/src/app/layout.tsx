import type { Metadata } from 'next';
import './globals.css';
import { RefineShell } from '@/components/refine-shell';
import { ConditionalSidebar } from '@/components/conditional-sidebar';
import { AuthGate } from '@/components/auth-gate';

export const metadata: Metadata = {
  title: 'WGC Admin',
  description: 'Internal admin for the WGC Platform',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <RefineShell>
          <AuthGate>
            <div className="flex min-h-screen">
              <ConditionalSidebar />
              <main className="flex-1 p-6">{children}</main>
            </div>
          </AuthGate>
        </RefineShell>
      </body>
    </html>
  );
}
