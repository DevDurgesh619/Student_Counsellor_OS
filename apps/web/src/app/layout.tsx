import type { Metadata } from 'next';
import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import './globals.css';
import { Providers } from '@/components/providers';
import { ConditionalShell } from '@/components/conditional-shell';
import { getServerSupabase } from '@/lib/supabase-server';
import { resolveDestination, type Me } from '@/lib/auth-destination';

export const metadata: Metadata = {
  title: 'WGC',
  description: 'WGC Platform',
};

const API_BASE = process.env.NEXT_PUBLIC_API_BASE_URL ?? 'http://localhost:8787';

function isPublicPath(pathname: string): boolean {
  return pathname.startsWith('/login') || pathname.startsWith('/auth/callback');
}

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const pathname = headers().get('x-pathname') ?? '/';

  if (isPublicPath(pathname)) {
    return (
      <html lang="en">
        <body>
          <Providers>{children}</Providers>
        </body>
      </html>
    );
  }

  const supabase = getServerSupabase();
  const {
    data: { session },
  } = await supabase.auth.getSession();
  if (!session) {
    redirect(`/login?next=${encodeURIComponent(pathname)}`);
  }

  let me: Me;
  try {
    const res = await fetch(`${API_BASE}/api/me`, {
      headers: { Authorization: `Bearer ${session.access_token}` },
      cache: 'no-store',
    });
    if (res.status === 401 || res.status === 403) {
      redirect(`/login?next=${encodeURIComponent(pathname)}`);
    }
    if (!res.ok) throw new Error(`api/me ${res.status}`);
    me = (await res.json()) as Me;
  } catch (e) {
    // Network/API failure — push the user to login rather than render
    // an unguarded page. They'll retry from there.
    redirect(`/login?next=${encodeURIComponent(pathname)}`);
  }

  const target = resolveDestination(me, pathname, null);
  if (target) redirect(target);

  return (
    <html lang="en">
      <body>
        <Providers>
          <ConditionalShell>{children}</ConditionalShell>
        </Providers>
      </body>
    </html>
  );
}
