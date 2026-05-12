'use client';

import { Authenticated } from '@refinedev/core';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect } from 'react';

const PUBLIC_PREFIXES = ['/login'];

/**
 * Wrap children in Refine's <Authenticated>. On /login routes, render through
 * directly so unauthenticated users can sign in. Everywhere else, redirect
 * to /login when no session is present.
 */
export function AuthGate({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const isPublic = PUBLIC_PREFIXES.some((p) => pathname.startsWith(p));

  if (isPublic) {
    return <>{children}</>;
  }

  return (
    <Authenticated
      key={pathname}
      fallback={<Redirect to="/login" router={router} />}
      loading={<div className="p-6 text-sm text-muted-foreground">Checking session…</div>}
    >
      {children}
    </Authenticated>
  );
}

function Redirect({ to, router }: { to: string; router: ReturnType<typeof useRouter> }) {
  useEffect(() => {
    router.replace(to);
  }, [to, router]);
  return <div className="p-6 text-sm text-muted-foreground">Redirecting to sign-in…</div>;
}
