'use client';

import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { format } from 'date-fns';
import { studentApi, type StudentTask } from '@/lib/api';
import { WeekGrid } from '@/components/calendar/week-grid';
import type { CalendarTask } from '@/components/calendar/task-block';
import { RequestTaskChangeDialog } from '@/components/student/request-task-change-dialog';

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

  // Active-schedule predicate (mirrors counsellor view + engine): hide
  // superseded + cancelled/rescheduled tasks. Without this filter, a task
  // the counsellor moved would render twice — once at the old slot
  // (rescheduled) and once at the new (scheduled).
  const tasks: Array<CalendarTask & { _src: StudentTask }> = useMemo(() => {
    const rows = data?.data ?? [];
    return rows
      .filter(
        (t) =>
          !t.supersededAt && t.status !== 'cancelled' && t.status !== 'rescheduled',
      )
      .map((t) => ({
        id: t.id,
        scheduledStart: t.scheduledStart,
        scheduledEnd: t.scheduledEnd,
        subject: t.subject,
        taskTitle: t.taskTitle,
        status: t.status as CalendarTask['status'],
        _src: t,
      }));
  }, [data]);

  const [activeTask, setActiveTask] = useState<StudentTask | null>(null);
  const [prefillSlot, setPrefillSlot] = useState<{ start: Date; end: Date } | null>(null);
  // Brief collision notice when a drop lands on an occupied slot. Cleared
  // automatically after 3s so it doesn't linger after the next interaction.
  const [collision, setCollision] = useState<string | null>(null);

  function handleDragDrop(taskId: string, slotStart: Date) {
    const t = tasks.find((x) => x.id === taskId);
    if (!t) return;
    const src = t._src;
    // Drop is always on an empty cell (week-grid enforces via onDragOver
    // ignoring occupied slots) — but the slot-occupancy check there only
    // covers the 30-min cell itself. If the dragged task is longer, the
    // *trailing* half-hours might still collide with adjacent tasks. We
    // re-check the full proposed window here.
    const durationMs =
      new Date(src.scheduledEnd).getTime() - new Date(src.scheduledStart).getTime();
    const proposedEnd = new Date(slotStart.getTime() + durationMs);
    const overlaps = tasks.some((x) => {
      if (x.id === taskId) return false;
      const xs = new Date(x.scheduledStart).getTime();
      const xe = new Date(x.scheduledEnd).getTime();
      return xs < proposedEnd.getTime() && xe > slotStart.getTime();
    });
    if (overlaps) {
      setCollision('That slot would overlap another task — pick an empty one.');
      window.setTimeout(() => setCollision(null), 3000);
      return;
    }
    setPrefillSlot({ start: slotStart, end: proposedEnd });
    setActiveTask(src);
  }

  return (
    <div className="space-y-4">
      <header className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Week</h1>
          <p className="text-sm text-muted-foreground">
            {format(days[0]!, 'MMM d')} – {format(days[6]!, 'MMM d')} · click a block for details ·
            drag to propose a new slot
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
      {collision && (
        <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {collision}
        </div>
      )}

      <WeekGrid
        tasks={tasks}
        weekStart={anchor}
        draggableTasks
        onTaskDragDrop={handleDragDrop}
        onTaskClick={(t) => {
          const src = (t as CalendarTask & { _src?: StudentTask })._src;
          if (src) {
            setPrefillSlot(null);
            setActiveTask(src);
          }
        }}
      />

      <RequestTaskChangeDialog
        task={activeTask}
        prefillSlot={prefillSlot}
        onClose={() => {
          setActiveTask(null);
          setPrefillSlot(null);
        }}
      />
    </div>
  );
}
