'use client';

import Link from 'next/link';
import { useParams, usePathname } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import { ArrowLeft } from 'lucide-react';
import { counsellorApi } from '@/lib/api';
import { cn } from '@/lib/utils';

const TABS = [
  { slug: 'today', label: 'Today' },
  { slug: 'week', label: 'Week' },
  { slug: 'timetable', label: 'Timetable' },
  { slug: 'queue', label: 'Queue' },
  { slug: 'todos', label: 'Todos' },
  { slug: 'artifacts', label: 'Artifacts' },
  { slug: 'requests', label: 'Requests' },
  { slug: 'sessions', label: 'Sessions' },
  { slug: 'brief', label: 'Brief' },
  { slug: 'history', label: 'History' },
  { slug: 'gaps', label: 'Gaps' },
  { slug: 'profile', label: 'Profile' },
  { slug: 'ask-ai', label: 'Ask AI' },
  { slug: 'conversations', label: 'Conversations' },
] as const;

export default function StudentLayout({ children }: { children: React.ReactNode }) {
  const params = useParams<{ id: string }>();
  const pathname = usePathname();
  const id = params.id;

  const { data: student } = useQuery({
    queryKey: ['student', id],
    queryFn: () => counsellorApi.student(id) as Promise<{ fullName: string; currentGrade: string }>,
    enabled: Boolean(id),
  });

  return (
    <div className="space-y-4">
      <header className="space-y-2">
        <Link
          href="/students"
          className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:underline"
        >
          <ArrowLeft className="h-3 w-3" /> All students
        </Link>
        <div>
          <h1 className="text-2xl font-semibold">
            {student?.fullName ?? 'Loading…'}
          </h1>
          {student && (
            <p className="text-sm text-muted-foreground">{student.currentGrade}</p>
          )}
        </div>
      </header>

      <nav className="flex gap-1 overflow-x-auto border-b border-border">
        {TABS.map((tab) => {
          const href = `/students/${id}/${tab.slug}`;
          const active = pathname === href || pathname.startsWith(href + '/');
          return (
            <Link
              key={tab.slug}
              href={href}
              className={cn(
                'border-b-2 px-3 py-2 text-sm transition-colors',
                active
                  ? 'border-primary text-foreground'
                  : 'border-transparent text-muted-foreground hover:text-foreground',
              )}
            >
              {tab.label}
            </Link>
          );
        })}
      </nav>

      <section>{children}</section>
    </div>
  );
}
