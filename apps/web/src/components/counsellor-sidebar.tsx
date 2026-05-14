'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import {
  CheckSquare,
  Inbox,
  LayoutGrid,
  LogOut,
  Settings,
  UserPlus,
  Users,
  X,
} from 'lucide-react';
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

// Capture `/students/<id>/...` — when the counsellor is "in" a student.
// `<id>` matches the first path segment after /students/, which is the
// student id for every route under that layout (today/queue/todos/etc).
function activeStudentIdFromPath(pathname: string): string | null {
  const m = pathname.match(/^\/students\/([^/]+)(?:\/|$)/);
  if (!m) return null;
  const id = m[1]!;
  // The /students grid itself has no id segment; guard against accidental
  // matches like `/students` (no trailing) — handled by the `/` requirement.
  return id;
}

export function CounsellorSidebar() {
  const pathname = usePathname();
  const router = useRouter();
  const activeStudentId = activeStudentIdFromPath(pathname);

  const { data: queue } = useQuery({
    queryKey: ['queue', 'pending'],
    queryFn: () => counsellorApi.queue('pending,in_review'),
    refetchInterval: 60_000,
  });
  const pendingCount = queue?.data.length ?? 0;

  const { data: activeStudent } = useQuery({
    queryKey: ['student', activeStudentId],
    queryFn: () =>
      counsellorApi.student(activeStudentId!) as Promise<{ fullName: string; currentGrade: string }>,
    enabled: Boolean(activeStudentId),
  });

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

      {activeStudentId && (
        <div className="mb-4 rounded-md border border-border bg-background p-3">
          <p className="text-[10px] uppercase tracking-wide text-muted-foreground">Viewing</p>
          <p className="mt-0.5 truncate text-sm font-medium">
            {activeStudent?.fullName ?? 'Loading…'}
          </p>
          {activeStudent && (
            <p className="text-xs text-muted-foreground">{activeStudent.currentGrade}</p>
          )}
          <Link
            href="/students"
            className="mt-2 inline-flex items-center gap-1 text-[11px] text-muted-foreground hover:underline"
          >
            <X className="h-3 w-3" /> All students
          </Link>
        </div>
      )}

      <ul className="space-y-1">
        {NAV.map((item) => {
          // When in student-mode, /queue and /todos should not look "active"
          // — the counsellor is inside the per-student version of those tabs.
          const active = activeStudentId
            ? item.href === '/students' && pathname.startsWith('/students')
            : pathname.startsWith(item.href);
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
