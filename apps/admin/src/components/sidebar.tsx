'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { cn } from '@/lib/utils';
import { RESOURCES } from '@/lib/resources';

export function Sidebar() {
  const pathname = usePathname();
  return (
    <nav className="w-60 shrink-0 border-r border-border bg-muted/30 p-4">
      <div className="mb-6">
        <Link href="/" className="block text-lg font-semibold">
          WGC Admin
        </Link>
        <p className="mt-1 text-xs text-muted-foreground">Internal — Refine + Supabase</p>
      </div>
      <ul className="space-y-1">
        {RESOURCES.map((r) => {
          const href = (r.list as string) ?? `/${r.name}`;
          const active = pathname.startsWith(href);
          return (
            <li key={r.name}>
              <Link
                href={href}
                className={cn(
                  'block rounded-md px-3 py-2 text-sm transition-colors',
                  active ? 'bg-primary text-primary-foreground' : 'hover:bg-muted',
                )}
              >
                {r.meta?.label ?? r.name}
              </Link>
            </li>
          );
        })}
      </ul>
      <div className="mt-8 border-t border-border pt-4 text-xs text-muted-foreground">
        Auth: Supabase Auth.
        <br />
        Data: Supabase REST direct (admin only).
      </div>
    </nav>
  );
}
