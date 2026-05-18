'use client';

import { useMemo, useState } from 'react';
import { useParams, useSearchParams } from 'next/navigation';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { counsellorApi } from '@/lib/api';
import { TaskCreateForm } from '@/components/task-create-form';
import { WeekGrid } from '@/components/calendar/week-grid';
import { TaskActionDialog } from '@/components/calendar/task-action-dialog';
import type { CalendarTask } from '@/components/calendar/task-block';

type ApiTask = {
  id: string;
  scheduledStart: string;
  scheduledEnd: string;
  subject: string;
  taskTitle: string;
  status: string;
  supersededAt?: string | null;
};

/**
 * Stable, locale-independent date format. Avoids the SSR/CSR hydration
 * mismatch you get from `toLocaleDateString()` with no locale — Node defaults
 * to en-US (MM/DD/YYYY) while the browser uses the user's locale (DD/MM/YYYY
 * in en-GB / en-IN / etc.), so the server-rendered HTML doesn't match what
 * React renders client-side.
 */
function formatWeekStart(d: Date): string {
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function weekBounds(offset = 0): { start: Date; end: Date } {
  const now = new Date();
  const day = now.getDay(); // 0 Sun
  const monday = new Date(now);
  monday.setDate(now.getDate() - ((day + 6) % 7) + offset * 7);
  monday.setHours(0, 0, 0, 0);
  const end = new Date(monday);
  end.setDate(monday.getDate() + 7);
  return { start: monday, end };
}

export default function WeekPage() {
  const params = useParams<{ id: string }>();
  const searchParams = useSearchParams();
  const initialAction = searchParams.get('action');
  const [showCreate, setShowCreate] = useState(initialAction === 'create');
  const [weekOffset, setWeekOffset] = useState(0);
  const [activeTask, setActiveTask] = useState<CalendarTask | null>(null);
  const qc = useQueryClient();

  const { start, end } = useMemo(() => weekBounds(weekOffset), [weekOffset]);

  const { data, isLoading } = useQuery({
    queryKey: ['student-tasks', params.id, start.toISOString(), end.toISOString()],
    queryFn: () =>
      counsellorApi.studentTasks(params.id, {
        start: start.toISOString(),
        end: end.toISOString(),
      }) as Promise<{ data: ApiTask[] }>,
    refetchInterval: 15_000,
    refetchOnWindowFocus: true,
  });

  // Active-schedule filter — supersededAt-marked rows are historical, and
  // cancelled/rescheduled rows are off the schedule too (see /timetable/page
  // for the full rationale).
  const tasks: CalendarTask[] = useMemo(() => {
    const rows = data?.data ?? [];
    return rows
      .filter((t) => !t.supersededAt && t.status !== 'cancelled' && t.status !== 'rescheduled')
      .map((t) => ({
        id: t.id,
        scheduledStart: t.scheduledStart,
        scheduledEnd: t.scheduledEnd,
        subject: t.subject,
        taskTitle: t.taskTitle,
        status: t.status as CalendarTask['status'],
      }));
  }, [data]);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <button
            onClick={() => setWeekOffset((o) => o - 1)}
            className="rounded-md border border-border px-2 py-1 text-sm hover:bg-muted"
          >
            ←
          </button>
          <span className="text-sm">
            Week of {formatWeekStart(start)}{' '}
            {weekOffset === 0 && <span className="text-muted-foreground">(this week)</span>}
          </span>
          <button
            onClick={() => setWeekOffset((o) => o + 1)}
            className="rounded-md border border-border px-2 py-1 text-sm hover:bg-muted"
          >
            →
          </button>
          {weekOffset !== 0 && (
            <button
              onClick={() => setWeekOffset(0)}
              className="ml-2 text-xs text-muted-foreground underline"
            >
              today
            </button>
          )}
        </div>
        <button
          onClick={() => setShowCreate((v) => !v)}
          className="rounded-md bg-primary px-3 py-1.5 text-sm text-primary-foreground hover:opacity-90"
        >
          {showCreate ? 'Close form' : '+ Add task'}
        </button>
      </div>

      {showCreate && (
        <TaskCreateForm
          studentId={params.id}
          defaultStart={start}
          onCreated={() => {
            setShowCreate(false);
            qc.invalidateQueries({ queryKey: ['student-tasks', params.id] });
          }}
        />
      )}

      {isLoading && <p className="text-sm text-muted-foreground">Loading…</p>}

      <WeekGrid tasks={tasks} weekStart={start} onTaskClick={setActiveTask} />
      <TaskActionDialog
        studentId={params.id}
        task={activeTask}
        onClose={() => setActiveTask(null)}
      />
    </div>
  );
}
