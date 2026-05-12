'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import { CheckSquare, Inbox, LayoutGrid, LogOut, Settings, UserPlus, Users } from 'lucide-react';
import { cn } from '@/lib/utils';
import { counsellorApi } from '@/lib/api';
import { getBrowserSupabase } from '@/lib/supabase';

const NAV: Array<{ href: string; label: string; icon: React.ComponentType<{ className?: string }> }> = [
  { href: '/students', label: 'Students', icon: Users },
  { href: '/onboarding', label: 'Onboarding', icon: UserPlus },
  { href: '/queue', label: 'Review queue', icon: Inbox },
  { href: '/todos', label: 'My todos', icon: CheckSquare },
  { href: '/settings', label: 'Settings', icon: Settings },
];

export function CounsellorSidebar() {
  const pathname = usePathname();
  const router = useRouter();

  const { data: queue } = useQuery({
    queryKey: ['queue', 'pending'],
    queryFn: () => counsellorApi.queue('pending,in_review'),
    refetchInterval: 60_000,
  });
  const pendingCount = queue?.data.length ?? 0;

  async function logout() {
    await getBrowserSupabase().auth.signOut();
    router.replace('/login');
  }

  return (
    <nav className="flex w-60 shrink-0 flex-col border-r border-border bg-muted/30 p-4">
      <div className="mb-6">
        <Link href="/students" className="flex items-center gap-2 font-semibold">
          <LayoutGrid className="h-5 w-5" /> WGC Counsellor
        </Link>
        <p className="mt-1 text-xs text-muted-foreground">Operating console</p>
      </div>
      <ul className="space-y-1">
        {NAV.map((item) => {
          const active = pathname.startsWith(item.href);
          return (
            <li key={item.href}>
              <Link
                href={item.href}
                className={cn(
                  'flex items-center justify-between rounded-md px-3 py-2 text-sm transition-colors',
                  active ? 'bg-primary text-primary-foreground' : 'hover:bg-muted',
                )}
              >
                <span className="flex items-center gap-2">
                  <item.icon className="h-4 w-4" /> {item.label}
                </span>
                {item.href === '/queue' && pendingCount > 0 && (
                  <span className="rounded-full bg-destructive px-2 text-xs text-destructive-foreground">
                    {pendingCount}
                  </span>
                )}
              </Link>
            </li>
          );
        })}
      </ul>
      <div className="mt-auto border-t border-border pt-4">
        <button
          onClick={logout}
          className="flex w-full items-center gap-2 rounded-md px-3 py-2 text-sm text-muted-foreground hover:bg-muted"
        >
          <LogOut className="h-4 w-4" /> Sign out
        </button>
      </div>
    </nav>
  );
}
