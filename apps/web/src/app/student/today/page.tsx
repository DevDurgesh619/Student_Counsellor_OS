'use client';

import Link from 'next/link';
import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { meApi, studentApi, type StudentTask } from '@/lib/api';
import { cn } from '@/lib/utils';

function todayISO() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function fmtTime(iso: string) {
  const d = new Date(iso);
  return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

export default function TodayPage() {
  const date = todayISO();
  const { data, isLoading, error } = useQuery({
    queryKey: ['my-tasks', 'today', date],
    queryFn: () => studentApi.tasks({ date }),
  });
  const { data: me } = useQuery({ queryKey: ['me'], queryFn: meApi.me });

  const tasks = data?.data ?? [];
  const now = useMemo(() => new Date(), []);
  const firstName =
    typeof me?.profile?.fullName === 'string'
      ? (me.profile.fullName as string).split(' ')[0]
      : null;

  return (
    <div className="space-y-4">
      <header>
        <h1 className="text-2xl font-semibold">
          {firstName ? `Hi, ${firstName}` : 'Today'}
        </h1>
        <p className="text-sm text-muted-foreground">
          {new Date().toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' })}
        </p>
      </header>

      {isLoading && <p className="text-sm text-muted-foreground">Loading…</p>}
      {error && <p className="text-sm text-destructive">Failed: {(error as Error).message}</p>}
      {!isLoading && tasks.length === 0 && (
        <p className="text-sm text-muted-foreground">Nothing scheduled today.</p>
      )}

      <ul className="space-y-3">
        {tasks.map((t) => (
          <TaskRow key={t.id} task={t} now={now} />
        ))}
      </ul>
    </div>
  );
}

function TaskRow({ task, now }: { task: StudentTask; now: Date }) {
  const start = new Date(task.scheduledStart);
  const end = new Date(task.scheduledEnd);
  // "Active now" + "Pending" cues only apply to tasks the student hasn't
  // acted on yet. Once status flips out of 'scheduled', show the actual badge.
  const isScheduled = task.status === 'scheduled';
  const active = isScheduled && now >= start && now <= end;
  const past = end < now;
  const needsPrompt = isScheduled && past;

  return (
    <li>
      <Link
        href={`/student/tasks/${task.id}`}
        className={cn(
          'block rounded-lg border bg-card p-4 transition-colors hover:bg-muted',
          active ? 'border-primary shadow-sm' : 'border-border',
        )}
      >
        <div className="flex items-start justify-between gap-2">
          <div>
            <div className="text-xs text-muted-foreground">
              {fmtTime(task.scheduledStart)} – {fmtTime(task.scheduledEnd)}
            </div>
            <div className="font-medium">{task.taskTitle}</div>
            <div className="text-xs text-muted-foreground">{task.subject}</div>
          </div>
          <StatusPill status={task.status} active={active} needsPrompt={needsPrompt} />
        </div>
        {needsPrompt && (
          <p className="mt-2 text-xs text-warning">How did this go?</p>
        )}
      </Link>
    </li>
  );
}

function StatusPill({ status, active, needsPrompt }: { status: string; active: boolean; needsPrompt: boolean }) {
  if (active) return <span className="rounded-full bg-primary px-2 py-0.5 text-[10px] uppercase text-primary-foreground">Active now</span>;
  if (needsPrompt) return <span className="rounded-full bg-warning px-2 py-0.5 text-[10px] uppercase text-warning-foreground">Pending</span>;
  const tone =
    status === 'completed'
      ? 'bg-success text-success-foreground'
      : status === 'skipped' || status === 'couldnt_do'
        ? 'bg-destructive text-destructive-foreground'
        : 'bg-muted text-muted-foreground';
  return <span className={cn('rounded-full px-2 py-0.5 text-[10px] uppercase', tone)}>{status}</span>;
}
