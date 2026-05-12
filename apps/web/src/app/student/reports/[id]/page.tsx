'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import { ChevronLeft } from 'lucide-react';
import { studentApi } from '@/lib/api';

export default function ReportDetailPage() {
  const { id } = useParams<{ id: string }>();
  const { data, isLoading, error } = useQuery({
    queryKey: ['my-report', id],
    queryFn: () => studentApi.report(id),
  });

  if (isLoading) return <p className="text-sm text-muted-foreground">Loading…</p>;
  if (error) return <p className="text-sm text-destructive">{(error as Error).message}</p>;
  if (!data) return null;

  const report = data as unknown as {
    type: string;
    periodStart: string;
    periodEnd: string;
    reviewedContent: string | null;
  };

  return (
    <div className="space-y-4">
      <Link
        href="/student/reports"
        className="inline-flex items-center gap-1 text-sm text-muted-foreground"
      >
        <ChevronLeft className="h-4 w-4" /> Back
      </Link>
      <header>
        <div className="text-xs uppercase tracking-wide text-muted-foreground">
          {report.type.replace('_', ' ')}
        </div>
        <h1 className="text-2xl font-semibold">
          {report.periodStart} – {report.periodEnd}
        </h1>
      </header>
      <article className="prose prose-sm max-w-none whitespace-pre-wrap rounded-lg border border-border bg-card p-4">
        {report.reviewedContent ?? '(empty)'}
      </article>
    </div>
  );
}
