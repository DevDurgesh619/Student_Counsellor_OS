'use client';

import Link from 'next/link';
import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { studentApi, type StudentTask } from '@/lib/api';

function isoDay(d: Date) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function startOfWeek(d: Date) {
  const x = new Date(d);
  const day = x.getDay(); // 0=Sun
  const diff = (day === 0 ? -6 : 1) - day; // Monday-start
  x.setDate(x.getDate() + diff);
  x.setHours(0, 0, 0, 0);
  return x;
}

export default function WeekPage() {
  const [anchor, setAnchor] = useState(() => startOfWeek(new Date()));
  const days = useMemo(() => {
    return Array.from({ length: 7 }, (_, i) => {
      const d = new Date(anchor);
      d.setDate(anchor.getDate() + i);
      return d;
    });
  }, [anchor]);
  const startDate = isoDay(days[0]!);
  const endDate = isoDay(days[6]!);

  const { data, isLoading } = useQuery({
    queryKey: ['my-tasks', 'week', startDate, endDate],
    queryFn: () => studentApi.tasks({ startDate, endDate }),
  });
  const tasks = data?.data ?? [];

  const byDay = useMemo(() => {
    const m = new Map<string, StudentTask[]>();
    for (const t of tasks) {
      const key = isoDay(new Date(t.scheduledStart));
      if (!m.has(key)) m.set(key, []);
      m.get(key)!.push(t);
    }
    return m;
  }, [tasks]);

  return (
    <div className="space-y-4">
      <header className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Week</h1>
          <p className="text-sm text-muted-foreground">
            {days[0]!.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} –{' '}
            {days[6]!.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}
          </p>
        </div>
        <div className="flex gap-1">
          <button
            onClick={() => setAnchor((d) => new Date(d.getTime() - 7 * 86_400_000))}
            className="rounded-md border border-input p-2 hover:bg-muted"
            aria-label="Previous week"
          >
            <ChevronLeft className="h-4 w-4" />
          </button>
          <button
            onClick={() => setAnchor(startOfWeek(new Date()))}
            className="rounded-md border border-input px-3 text-sm hover:bg-muted"
          >
            Today
          </button>
          <button
            onClick={() => setAnchor((d) => new Date(d.getTime() + 7 * 86_400_000))}
            className="rounded-md border border-input p-2 hover:bg-muted"
            aria-label="Next week"
          >
            <ChevronRight className="h-4 w-4" />
          </button>
        </div>
      </header>

      {isLoading && <p className="text-sm text-muted-foreground">Loading…</p>}

      <ul className="space-y-2">
        {days.map((d) => {
          const key = isoDay(d);
          const list = byDay.get(key) ?? [];
          const done = list.filter((t) => t.status === 'completed').length;
          const total = list.length;
          const pct = total === 0 ? 0 : Math.round((done / total) * 100);
          return (
            <li key={key}>
              <Link
                href={`/student/today?date=${key}`}
                className="flex items-center justify-between rounded-lg border border-border bg-card p-3 hover:bg-muted"
              >
                <div>
                  <div className="text-xs text-muted-foreground">
                    {d.toLocaleDateString(undefined, { weekday: 'short' })}
                  </div>
                  <div className="font-medium">
                    {d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}
                  </div>
                </div>
                <div className="text-right text-sm">
                  <div className="text-muted-foreground">{total} tasks</div>
                  <div className="font-mono">{pct}% done</div>
                </div>
              </Link>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
