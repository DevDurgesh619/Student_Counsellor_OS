'use client';

import { useMemo, useState } from 'react';
import { useParams, useSearchParams } from 'next/navigation';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { counsellorApi } from '@/lib/api';
import { TaskCreateForm } from '@/components/task-create-form';
import { cn } from '@/lib/utils';

type Task = {
  id: string;
  scheduledStart: string;
  scheduledEnd: string;
  subject: string;
  taskTitle: string;
  status: string;
};

function weekBounds(offset = 0): { start: Date; end: Date; days: Date[] } {
  const now = new Date();
  const day = now.getUTCDay(); // 0 Sun
  const monday = new Date(now);
  monday.setUTCDate(now.getUTCDate() - ((day + 6) % 7) + offset * 7);
  monday.setUTCHours(0, 0, 0, 0);
  const days = Array.from({ length: 7 }, (_, i) => {
    const d = new Date(monday);
    d.setUTCDate(monday.getUTCDate() + i);
    return d;
  });
  const end = new Date(monday);
  end.setUTCDate(monday.getUTCDate() + 7);
  return { start: monday, end, days };
}

export default function WeekPage() {
  const params = useParams<{ id: string }>();
  const searchParams = useSearchParams();
  const initialAction = searchParams.get('action');
  const [showCreate, setShowCreate] = useState(initialAction === 'create');
  const [weekOffset, setWeekOffset] = useState(0);
  const qc = useQueryClient();

  const { start, end, days } = useMemo(() => weekBounds(weekOffset), [weekOffset]);

  const { data, isLoading } = useQuery({
    queryKey: ['student-tasks', params.id, start.toISOString(), end.toISOString()],
    queryFn: () =>
      counsellorApi.studentTasks(params.id, {
        start: start.toISOString(),
        end: end.toISOString(),
      }) as Promise<{ data: Task[] }>,
    refetchInterval: 15_000,
    refetchOnWindowFocus: true,
  });

  const tasks = data?.data ?? [];

  // Group tasks by day
  const tasksByDay = useMemo(() => {
    const map = new Map<string, Task[]>();
    days.forEach((d) => map.set(d.toISOString().slice(0, 10), []));
    for (const t of tasks) {
      const key = new Date(t.scheduledStart).toISOString().slice(0, 10);
      const arr = map.get(key);
      if (arr) arr.push(t);
    }
    return map;
  }, [days, tasks]);

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
            Week of {start.toLocaleDateString()}{' '}
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

      <div className="grid grid-cols-7 gap-2">
        {days.map((d) => {
          const key = d.toISOString().slice(0, 10);
          const dayTasks = tasksByDay.get(key) ?? [];
          const isToday = key === new Date().toISOString().slice(0, 10);
          return (
            <div
              key={key}
              className={cn(
                'min-h-40 rounded-lg border border-border bg-card p-2',
                isToday && 'border-primary',
              )}
            >
              <div className="mb-2 text-xs">
                <div className="font-medium">
                  {d.toLocaleDateString([], { weekday: 'short' })}
                </div>
                <div className="text-muted-foreground">{d.getUTCDate()}</div>
              </div>
              <ul className="space-y-1">
                {dayTasks.map((t) => (
                  <li key={t.id} className="rounded bg-muted px-2 py-1 text-xs">
                    <div className="font-medium">{t.subject}</div>
                    <div className="truncate text-muted-foreground">{t.taskTitle}</div>
                  </li>
                ))}
              </ul>
            </div>
          );
        })}
      </div>
    </div>
  );
}
