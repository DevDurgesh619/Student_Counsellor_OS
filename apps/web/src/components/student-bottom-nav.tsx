'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import { Calendar, FileText, Home, Inbox, Settings as SettingsIcon, LogOut } from 'lucide-react';
import { cn } from '@/lib/utils';
import { meApi } from '@/lib/api';
import { getBrowserSupabase } from '@/lib/supabase';

const ITEMS = [
  { href: '/student/today', label: 'Today', icon: Home },
  { href: '/student/week', label: 'Week', icon: Calendar },
  { href: '/student/requests', label: 'Requests', icon: Inbox },
  { href: '/student/reports', label: 'Reports', icon: FileText },
  { href: '/student/settings', label: 'Settings', icon: SettingsIcon },
];

export function StudentBottomNav() {
  const pathname = usePathname();
  const router = useRouter();
  const { data: me } = useQuery({ queryKey: ['me'], queryFn: meApi.me });
  const fullName =
    typeof me?.profile?.fullName === 'string' ? (me.profile.fullName as string) : null;
  const firstName = fullName?.split(' ')[0] ?? null;

  async function logout() {
    try {
      await getBrowserSupabase().auth.signOut();
    } catch {
      // best-effort
    }
    router.replace('/login');
  }

  return (
    <>
      {/* Mobile: bottom nav */}
      <nav className="fixed bottom-0 inset-x-0 z-30 flex border-t border-border bg-background md:hidden">
        {ITEMS.slice(0, 5).map((item) => {
          const active = pathname.startsWith(item.href);
          return (
            <Link
              key={item.href}
              href={item.href}
              className={cn(
                'flex-1 flex flex-col items-center justify-center gap-0.5 py-2 text-xs',
                active ? 'text-primary' : 'text-muted-foreground',
              )}
            >
              <item.icon className="h-5 w-5" />
              <span>{item.label}</span>
            </Link>
          );
        })}
      </nav>

      {/* Tablet/desktop: side rail */}
      <aside className="hidden md:flex md:order-first md:w-56 md:shrink-0 md:flex-col md:border-r md:border-border md:bg-muted/30 md:p-4">
        <div className="mb-6">
          <Link href="/student/today" className="block font-semibold">
            {firstName ?? 'Student'}
          </Link>
          <p className="mt-0.5 text-xs text-muted-foreground">WGC student app</p>
        </div>
        <ul className="space-y-1">
          {ITEMS.map((item) => {
            const active = pathname.startsWith(item.href);
            return (
              <li key={item.href}>
                <Link
                  href={item.href}
                  className={cn(
                    'flex items-center gap-2 rounded-md px-3 py-2 text-sm transition-colors',
                    active ? 'bg-primary text-primary-foreground' : 'hover:bg-muted',
                  )}
                >
                  <item.icon className="h-4 w-4" />
                  {item.label}
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
      </aside>
    </>
  );
}
