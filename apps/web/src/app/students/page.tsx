'use client';

import Link from 'next/link';
import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Search } from 'lucide-react';
import { counsellorApi, type StudentOverview } from '@/lib/api';
import { cn, formatRelative } from '@/lib/utils';

type SortKey = 'recent' | 'name' | 'pending';

export default function StudentsOverviewPage() {
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState<SortKey>('recent');

  const { data, isLoading, error } = useQuery({
    queryKey: ['students-overview'],
    queryFn: counsellorApi.studentsOverview,
    staleTime: 30_000,
  });

  const students: StudentOverview[] = data?.data ?? [];

  const visible = useMemo(() => {
    const filtered = students.filter((s) =>
      query ? s.name.toLowerCase().includes(query.toLowerCase()) : true,
    );
    const sorted = [...filtered].sort((a, b) => {
      if (sort === 'name') return a.name.localeCompare(b.name);
      if (sort === 'pending') return b.pendingReviewItems - a.pendingReviewItems;
      // 'recent'
      const av = a.lastActivity ? new Date(a.lastActivity).getTime() : 0;
      const bv = b.lastActivity ? new Date(b.lastActivity).getTime() : 0;
      return bv - av;
    });
    return sorted;
  }, [students, query, sort]);

  return (
    <div className="space-y-6">
      <header className="flex items-end justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Students</h1>
          <p className="text-sm text-muted-foreground">
            All students assigned to you. Click a card for the full profile.
          </p>
        </div>
        <div className="flex gap-2">
          <div className="relative">
            <Search className="absolute left-2 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search by name"
              className="rounded-md border border-input bg-background py-2 pl-8 pr-3 text-sm"
            />
          </div>
          <select
            value={sort}
            onChange={(e) => setSort(e.target.value as SortKey)}
            className="rounded-md border border-input bg-background px-3 py-2 text-sm"
          >
            <option value="recent">Sort: recent activity</option>
            <option value="name">Sort: name</option>
            <option value="pending">Sort: pending review items</option>
          </select>
        </div>
      </header>

      {isLoading && <p className="text-sm text-muted-foreground">Loading…</p>}
      {error && (
        <p className="text-sm text-destructive">Failed to load: {(error as Error).message}</p>
      )}

      {visible.length === 0 && !isLoading && (
        <p className="text-sm text-muted-foreground">
          No students assigned to you yet. Use the admin app to add students.
        </p>
      )}

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
        {visible.map((s) => (
          <Link
            key={s.studentId}
            href={`/students/${s.studentId}/today`}
            className="group block rounded-lg border border-border bg-card p-4 transition-colors hover:bg-muted"
          >
            <div className="flex items-start justify-between">
              <div>
                <h3 className="font-medium group-hover:underline">{s.name}</h3>
                <p className="text-xs text-muted-foreground">{s.grade}</p>
              </div>
              <HealthDot health={s.healthIndicator} />
            </div>

            <div className="mt-3 grid grid-cols-4 gap-1 text-center text-xs">
              <Stat label="done" value={s.today.done} tone="success" />
              <Stat label="todo" value={s.today.scheduled} />
              <Stat label="skip" value={s.today.skipped} tone="warning" />
              <Stat label="couldn't" value={s.today.couldntDo} tone="destructive" />
            </div>

            <div className="mt-3 flex items-center justify-between text-xs text-muted-foreground">
              <span>Active {formatRelative(s.lastActivity)}</span>
              {s.pendingReviewItems > 0 && (
                <span className="rounded-full bg-destructive px-2 py-0.5 text-destructive-foreground">
                  {s.pendingReviewItems} review
                </span>
              )}
            </div>
          </Link>
        ))}
      </div>
    </div>
  );
}

function HealthDot({ health }: { health: StudentOverview['healthIndicator'] }) {
  const map: Record<typeof health, string> = {
    green: 'bg-success',
    yellow: 'bg-warning',
    red: 'bg-destructive',
    unknown: 'bg-muted',
  };
  return (
    <span
      title={`Health: ${health}`}
      className={cn('inline-block h-3 w-3 rounded-full', map[health])}
    />
  );
}

function Stat({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone?: 'success' | 'warning' | 'destructive';
}) {
  const toneClass =
    tone === 'success'
      ? 'text-success'
      : tone === 'warning'
        ? 'text-warning'
        : tone === 'destructive'
          ? 'text-destructive'
          : 'text-foreground';
  return (
    <div>
      <div className={cn('font-mono text-base', toneClass)}>{value}</div>
      <div className="text-[10px] uppercase text-muted-foreground">{label}</div>
    </div>
  );
}
