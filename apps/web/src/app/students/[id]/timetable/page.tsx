'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { useParams, useSearchParams } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import { counsellorApi } from '@/lib/api';
import { WeekGrid } from '@/components/calendar/week-grid';
import { EditorChat } from '@/components/calendar/editor-chat';
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

// Stable date label — see week/page.tsx for the SSR/CSR hydration story.
function formatWeekStart(d: Date): string {
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function mondayOf(d: Date): Date {
  const day = d.getDay();
  const monday = new Date(d);
  monday.setDate(d.getDate() - ((day + 6) % 7));
  monday.setHours(0, 0, 0, 0);
  return monday;
}

function weekBounds(offset: number): { start: Date; end: Date } {
  const start = mondayOf(new Date());
  start.setDate(start.getDate() + offset * 7);
  const end = new Date(start);
  end.setDate(start.getDate() + 7);
  return { start, end };
}

export default function TimetablePage() {
  const params = useParams<{ id: string }>();
  const searchParams = useSearchParams();
  // `?conv=<id>` is set when the counsellor clicks "Approve & open in editor"
  // on a change request — opens that specific conversation on mount.
  const initialConversationId = searchParams.get('conv') ?? undefined;
  const [weekOffset, setWeekOffset] = useState(0);
  const [activeTask, setActiveTask] = useState<CalendarTask | null>(null);
  const { start, end } = useMemo(() => weekBounds(weekOffset), [weekOffset]);

  const { data, isLoading } = useQuery({
    queryKey: ['student-tasks-timetable', params.id, start.toISOString(), end.toISOString()],
    queryFn: () =>
      counsellorApi.studentTasks(params.id, {
        start: start.toISOString(),
        end: end.toISOString(),
      }) as Promise<{ data: ApiTask[] }>,
    // Background refresh is fine *unless* a mutation is in flight — a
    // refetch that lands between the click and the cache invalidation
    // briefly paints stale state and flashes the wrong UI. The mutating
    // components are in the EditorChat / TaskActionDialog subtree; they
    // call invalidateQueries themselves on success, so polling here is
    // just safety. Pause it whenever ANY task or summary mutation is in
    // flight by checking the global fetching state.
    refetchInterval: (query) =>
      query.state.fetchStatus === 'fetching' ? false : 15_000,
    refetchOnWindowFocus: false,
  });

  const tasks: CalendarTask[] = useMemo(() => {
    const rows = data?.data ?? [];
    // Active-schedule predicate (mirrors the engine):
    //   superseded_at IS NULL AND status NOT IN ('cancelled','rescheduled')
    // Filtering on supersededAt alone wasn't enough — after a revert, the
    // tasks the change *created* are status='cancelled' but never get
    // supersededAt set, so they would otherwise keep rendering with
    // strikethrough on the grid.
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
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-[1fr_360px]">
      <div className="space-y-4">
        <header className="flex items-center justify-between">
          <div>
            <h2 className="text-lg font-semibold">Timetable</h2>
            <p className="text-sm text-muted-foreground">
              Versioned weekly schedule. Use the editor to propose changes.{' '}
              <Link
                href={`/students/${params.id}/timetable/history`}
                className="text-primary underline hover:no-underline"
              >
                History →
              </Link>
            </p>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => setWeekOffset((o) => o - 1)}
              className="rounded-md border border-border px-2 py-1 text-sm hover:bg-muted"
            >
              ←
            </button>
            <span className="text-sm">Week of {formatWeekStart(start)}</span>
            <button
              onClick={() => setWeekOffset((o) => o + 1)}
              className="rounded-md border border-border px-2 py-1 text-sm hover:bg-muted"
            >
              →
            </button>
            {weekOffset !== 0 && (
              <button
                onClick={() => setWeekOffset(0)}
                className="ml-1 text-xs text-muted-foreground underline"
              >
                today
              </button>
            )}
          </div>
        </header>

        {isLoading && <p className="text-sm text-muted-foreground">Loading…</p>}
        <WeekGrid tasks={tasks} weekStart={start} onTaskClick={setActiveTask} />
        <TaskActionDialog
          studentId={params.id}
          task={activeTask}
          onClose={() => setActiveTask(null)}
        />
      </div>

      <EditorChat
        studentId={params.id}
        initialConversationId={initialConversationId}
        onApplied={(earliest) => {
          if (!earliest) return;
          // Compute the week-offset that contains `earliest` and jump there.
          const now = new Date();
          const mondayOfNow = mondayOf(now);
          const mondayOfTarget = mondayOf(earliest);
          const weeksDiff = Math.round(
            (mondayOfTarget.getTime() - mondayOfNow.getTime()) / (7 * 24 * 60 * 60 * 1000),
          );
          if (weeksDiff !== weekOffset) setWeekOffset(weeksDiff);
        }}
      />
    </div>
  );
}
