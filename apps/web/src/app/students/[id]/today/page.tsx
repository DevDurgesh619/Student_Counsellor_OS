'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import { counsellorApi } from '@/lib/api';
import { cn } from '@/lib/utils';

type Task = {
  id: string;
  scheduledStart: string;
  scheduledEnd: string;
  subject: string;
  taskTitle: string;
  taskDescription: string | null;
  status: string;
};

function dayBounds(): { start: string; end: string } {
  const now = new Date();
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const end = new Date(start.getTime() + 24 * 60 * 60 * 1000);
  return { start: start.toISOString(), end: end.toISOString() };
}

export default function TodayPage() {
  const params = useParams<{ id: string }>();
  const { start, end } = dayBounds();

  const { data, isLoading, error } = useQuery({
    queryKey: ['student-tasks', params.id, start, end],
    queryFn: () =>
      counsellorApi.studentTasks(params.id, { start, end }) as Promise<{ data: Task[] }>,
    refetchInterval: 15_000,
    refetchOnWindowFocus: true,
  });

  const tasks = data?.data ?? [];

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-medium">Today's tasks</h2>
        <Link
          href={`/students/${params.id}/week?action=create`}
          className="rounded-md bg-primary px-3 py-1.5 text-sm text-primary-foreground hover:opacity-90"
        >
          + Add task
        </Link>
      </div>

      {isLoading && <p className="text-sm text-muted-foreground">Loading…</p>}
      {error && (
        <p className="text-sm text-destructive">Failed to load: {(error as Error).message}</p>
      )}
      {!isLoading && tasks.length === 0 && (
        <div className="rounded-lg border border-dashed border-border p-6 text-center text-sm text-muted-foreground">
          No tasks scheduled today. Click "Add task" to create one.
        </div>
      )}

      <ul className="space-y-2">
        {tasks.map((t) => (
          <li
            key={t.id}
            className="flex items-start gap-3 rounded-lg border border-border bg-card p-3"
          >
            <div className="w-24 shrink-0 text-xs text-muted-foreground">
              {new Date(t.scheduledStart).toLocaleTimeString([], {
                hour: '2-digit',
                minute: '2-digit',
              })}
              <br />
              <span className="opacity-60">
                {new Date(t.scheduledEnd).toLocaleTimeString([], {
                  hour: '2-digit',
                  minute: '2-digit',
                })}
              </span>
            </div>
            <div className="flex-1">
              <div className="flex items-center gap-2">
                <span className="rounded bg-muted px-2 py-0.5 text-xs font-medium">{t.subject}</span>
                <span className="font-medium">{t.taskTitle}</span>
              </div>
              {t.taskDescription && (
                <p className="mt-1 text-sm text-muted-foreground">{t.taskDescription}</p>
              )}
            </div>
            <StatusBadge status={t.status} />
          </li>
        ))}
      </ul>
    </div>
  );
}

function StatusBadge({ status }: { status: string }) {
  const tone =
    status === 'completed'
      ? 'bg-success text-success-foreground'
      : status === 'skipped'
        ? 'bg-warning text-warning-foreground'
        : status === 'couldnt_do' || status === 'cancelled'
          ? 'bg-destructive text-destructive-foreground'
          : 'bg-muted';
  return (
    <span className={cn('rounded-full px-2 py-0.5 text-xs', tone)}>
      {status.replace('_', ' ')}
    </span>
  );
}
