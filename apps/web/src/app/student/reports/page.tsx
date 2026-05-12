'use client';

import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { studentApi } from '@/lib/api';

export default function ReportsPage() {
  const { data, isLoading } = useQuery({
    queryKey: ['my-reports'],
    queryFn: studentApi.reports,
  });
  const reports = data?.data ?? [];

  return (
    <div className="space-y-4">
      <header>
        <h1 className="text-2xl font-semibold">Reports</h1>
        <p className="text-sm text-muted-foreground">
          Weekly and monthly recaps from your counsellor.
        </p>
      </header>

      {isLoading && <p className="text-sm text-muted-foreground">Loading…</p>}

      {!isLoading && reports.length === 0 && (
        <p className="rounded-lg border border-dashed border-border bg-card p-8 text-center text-sm text-muted-foreground">
          No reports yet. The first weekly recap will appear here once your counsellor publishes it.
        </p>
      )}

      <ul className="space-y-2">
        {reports.map((r) => {
          const preview = (r.reviewedContent ?? '').slice(0, 200);
          return (
            <li key={r.id}>
              <Link
                href={`/student/reports/${r.id}`}
                className="block rounded-lg border border-border bg-card p-4 hover:bg-muted"
              >
                <div className="text-xs uppercase tracking-wide text-muted-foreground">
                  {r.type.replace('_', ' ')}
                </div>
                <div className="font-medium">
                  {r.periodStart} – {r.periodEnd}
                </div>
                <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">{preview}</p>
              </Link>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
