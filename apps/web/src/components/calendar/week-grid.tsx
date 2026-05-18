'use client';

import { useMemo } from 'react';
import { TaskBlock, type CalendarTask } from './task-block';
import { cn } from '@/lib/utils';

const DAY_START_HOUR = 6;
const DAY_END_HOUR = 24; // midnight (exclusive — last visible row is 23:30)
const ROWS_PER_HOUR = 2; // 30-min granularity
const ROW_HEIGHT_PX = 24;
const TOTAL_ROWS = (DAY_END_HOUR - DAY_START_HOUR) * ROWS_PER_HOUR;

type LayoutTask = CalendarTask & { _dayKey: string; _col: number; _cols: number };

/**
 * Google-Calendar-style week view. Pure presentation — caller passes tasks
 * plus the week's monday. Tasks are positioned absolutely inside per-day
 * columns; overlaps split column width evenly (greedy assignment).
 */
export function WeekGrid({
  tasks,
  weekStart,
  onTaskClick,
  onSlotClick,
  diff,
  draggableTasks = false,
  onTaskDragDrop,
}: {
  tasks: CalendarTask[];
  weekStart: Date;
  onTaskClick?: (t: CalendarTask) => void;
  onSlotClick?: (slotStart: Date) => void;
  diff?: { addedIds: Set<string>; removedIds: Set<string> };
  /** Enables drag affordances on each task block. */
  draggableTasks?: boolean;
  /**
   * Fires when a task is dropped onto an empty 30-min cell. Parent decides
   * what to do (typically: open a confirm/request dialog pre-filled with
   * the source task + target slot).
   */
  onTaskDragDrop?: (taskId: string, slotStart: Date) => void;
}) {
  const days = useMemo(() => {
    return Array.from({ length: 7 }, (_, i) => {
      const d = new Date(weekStart);
      d.setDate(weekStart.getDate() + i);
      d.setHours(0, 0, 0, 0);
      return d;
    });
  }, [weekStart]);

  // Tasks that start before the visible 6am or after the visible 11pm
  // would otherwise be clipped (or pushed off-canvas) silently. Pull them
  // out so we can surface them in a header strip below the grid.
  const { inWindow, outOfWindow } = useMemo(() => {
    const inside: typeof tasks = [];
    const outside: typeof tasks = [];
    for (const t of tasks) {
      const startHour = new Date(t.scheduledStart).getHours();
      const endHour = new Date(t.scheduledEnd).getHours();
      if (startHour < DAY_START_HOUR || startHour >= DAY_END_HOUR) {
        outside.push(t);
      } else if (endHour > DAY_END_HOUR && new Date(t.scheduledEnd).getMinutes() > 0) {
        // Starts in window but ends past — keep it in but clip visually.
        inside.push(t);
      } else {
        inside.push(t);
      }
    }
    return { inWindow: inside, outOfWindow: outside };
  }, [tasks]);

  // Build per-day buckets and run greedy column packing for overlaps.
  const laidOut: LayoutTask[] = useMemo(() => packTasks(inWindow, days), [inWindow, days]);

  return (
    <div className="rounded-lg border border-border bg-card text-xs">
      {/* Out-of-window strip — surfaces overnight / very-early tasks that
          would otherwise be invisible (Sleep at 23:00, late-night cram at
          midnight, breakfast meal at 5:30am). Without this they're in the
          data but visually missing from the grid. */}
      {outOfWindow.length > 0 && (
        <div className="border-b border-border bg-muted/30 px-3 py-2 text-[11px]">
          <span className="mr-2 font-medium text-muted-foreground">
            Outside {DAY_START_HOUR}am–
            {DAY_END_HOUR >= 24 ? '12am' : `${DAY_END_HOUR - 12}pm`}:
          </span>
          {outOfWindow.map((t, i) => (
            <span key={t.id} className="mr-2">
              {i > 0 && <span className="mr-2 text-muted-foreground">·</span>}
              <span className="font-medium">{t.subject}</span>{' '}
              <span className="text-muted-foreground">
                {new Date(t.scheduledStart).toLocaleString([], {
                  weekday: 'short',
                  hour: 'numeric',
                  minute: '2-digit',
                })}
              </span>
            </span>
          ))}
        </div>
      )}

      {/* Header row */}
      <div className="grid grid-cols-[60px_repeat(7,1fr)] border-b border-border">
        <div />
        {days.map((d) => {
          const isToday = sameDate(d, new Date());
          return (
            <div
              key={d.toISOString()}
              className={cn(
                'border-l border-border px-2 py-2 text-center',
                isToday && 'bg-primary/5',
              )}
            >
              <div className="text-[10px] uppercase tracking-wide text-muted-foreground">
                {d.toLocaleDateString([], { weekday: 'short' })}
              </div>
              <div
                className={cn(
                  'mt-0.5 text-base font-semibold',
                  isToday ? 'text-primary' : 'text-foreground',
                )}
              >
                {d.getDate()}
              </div>
            </div>
          );
        })}
      </div>

      {/* Body grid: time gutter + 7 day columns */}
      <div className="relative grid grid-cols-[60px_repeat(7,1fr)]">
        {/* Time gutter */}
        <div className="border-r border-border">
          {Array.from({ length: DAY_END_HOUR - DAY_START_HOUR }, (_, i) => {
            const hour = DAY_START_HOUR + i;
            return (
              <div
                key={hour}
                style={{ height: ROWS_PER_HOUR * ROW_HEIGHT_PX }}
                className="relative text-[10px] text-muted-foreground"
              >
                <span className="absolute -top-1.5 right-1.5">{formatHour(hour)}</span>
              </div>
            );
          })}
        </div>

        {/* Day columns */}
        {days.map((d) => {
          const dayKey = ymd(d);
          const dayTasks = laidOut.filter((t) => t._dayKey === dayKey);
          return (
            <div
              key={dayKey}
              className="relative border-l border-border"
              style={{ height: TOTAL_ROWS * ROW_HEIGHT_PX }}
            >
              {/* Half-hour grid lines */}
              {Array.from({ length: TOTAL_ROWS }, (_, i) => {
                const slotStart = rowToDate(d, i);
                return (
                  <div
                    key={i}
                    onClick={onSlotClick ? () => onSlotClick(slotStart) : undefined}
                    onDragOver={
                      onTaskDragDrop
                        ? (e) => {
                            // Must preventDefault for drop to fire. Only
                            // signal "valid drop target" when the cell is
                            // truly empty — overlapping a task row would
                            // mean "drop onto occupied", which the plan
                            // forbids (collision warning only).
                            if (!isSlotOccupied(slotStart, dayTasks)) {
                              e.preventDefault();
                              e.dataTransfer.dropEffect = 'move';
                            }
                          }
                        : undefined
                    }
                    onDrop={
                      onTaskDragDrop
                        ? (e) => {
                            e.preventDefault();
                            const id =
                              e.dataTransfer.getData('application/x-task-id') ||
                              e.dataTransfer.getData('text/plain');
                            if (id) onTaskDragDrop(id, slotStart);
                          }
                        : undefined
                    }
                    className={cn(
                      'border-b border-border/40',
                      i % 2 === 1 && 'border-b-border/70',
                      onSlotClick && 'cursor-pointer hover:bg-muted/40',
                    )}
                    style={{ height: ROW_HEIGHT_PX }}
                  />
                );
              })}
              {/* Tasks */}
              {dayTasks.map((t) => {
                const top = minutesFromDayStart(t.scheduledStart) * (ROW_HEIGHT_PX / 30);
                const height = Math.max(
                  ROW_HEIGHT_PX * 0.8,
                  durationMinutes(t.scheduledStart, t.scheduledEnd) * (ROW_HEIGHT_PX / 30),
                );
                const widthPct = 100 / t._cols;
                const leftPct = widthPct * t._col;
                const variant =
                  diff?.addedIds.has(t.id)
                    ? 'diff-added'
                    : diff?.removedIds.has(t.id)
                      ? 'diff-removed'
                      : 'normal';
                return (
                  <div
                    key={t.id}
                    style={{
                      position: 'absolute',
                      top,
                      height,
                      left: `${leftPct}%`,
                      width: `${widthPct}%`,
                    }}
                  >
                    <TaskBlock
                      task={t}
                      variant={variant}
                      onClick={onTaskClick}
                      draggable={draggableTasks}
                    />
                  </div>
                );
              })}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function packTasks(tasks: CalendarTask[], days: Date[]): LayoutTask[] {
  const out: LayoutTask[] = [];
  const dayKeys = days.map(ymd);
  for (const dayKey of dayKeys) {
    const inDay = tasks
      .filter((t) => ymd(new Date(t.scheduledStart)) === dayKey)
      .sort(
        (a, b) =>
          new Date(a.scheduledStart).getTime() - new Date(b.scheduledStart).getTime(),
      );
    if (inDay.length === 0) continue;

    // Greedy column assignment: for each task, find first column where the
    // previous occupant has already ended. Track concurrent group size so
    // every task in an overlap cluster shares the same `_cols` value.
    type Slot = { endsAt: number; col: number };
    const slots: Slot[] = [];
    const colByTaskId = new Map<string, number>();
    const clusterStartByTaskId = new Map<string, number>();
    let clusterIdx = 0;
    let lastClusterEnd = -1;
    let currentClusterCols = 0;
    const clusterColsForIdx = new Map<number, number>();

    for (const t of inDay) {
      const start = new Date(t.scheduledStart).getTime();
      const end = new Date(t.scheduledEnd).getTime();

      // New cluster if this task starts after every prior task ended.
      if (start >= lastClusterEnd) {
        clusterIdx += 1;
        slots.length = 0;
        currentClusterCols = 0;
      }
      lastClusterEnd = Math.max(lastClusterEnd, end);

      // Find first free column
      let col = slots.findIndex((s) => s.endsAt <= start);
      if (col === -1) {
        col = slots.length;
        slots.push({ endsAt: end, col });
      } else {
        slots[col] = { endsAt: end, col };
      }
      colByTaskId.set(t.id, col);
      clusterStartByTaskId.set(t.id, clusterIdx);
      currentClusterCols = Math.max(currentClusterCols, col + 1);
      clusterColsForIdx.set(clusterIdx, currentClusterCols);
    }

    for (const t of inDay) {
      const cluster = clusterStartByTaskId.get(t.id)!;
      out.push({
        ...t,
        _dayKey: dayKey,
        _col: colByTaskId.get(t.id)!,
        _cols: clusterColsForIdx.get(cluster)!,
      });
    }
  }
  return out;
}

function minutesFromDayStart(iso: string): number {
  const d = new Date(iso);
  return (d.getHours() - DAY_START_HOUR) * 60 + d.getMinutes();
}

function durationMinutes(startIso: string, endIso: string): number {
  return (new Date(endIso).getTime() - new Date(startIso).getTime()) / 60000;
}

function ymd(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${dd}`;
}

function sameDate(a: Date, b: Date): boolean {
  return ymd(a) === ymd(b);
}

/**
 * Drag-drop collision check. A slot is "occupied" if any of the day's
 * already-laid-out tasks straddles the 30-minute window starting at
 * `slotStart`. The dragged task itself is allowed to overlap with its own
 * current position (otherwise dropping it back where it started would
 * always read as occupied).
 */
function isSlotOccupied(slotStart: Date, dayTasks: LayoutTask[]): boolean {
  const slotEnd = new Date(slotStart.getTime() + 30 * 60 * 1000);
  for (const t of dayTasks) {
    const ts = new Date(t.scheduledStart).getTime();
    const te = new Date(t.scheduledEnd).getTime();
    if (ts < slotEnd.getTime() && te > slotStart.getTime()) return true;
  }
  return false;
}

function rowToDate(dayStart: Date, rowIndex: number): Date {
  const out = new Date(dayStart);
  const minutes = DAY_START_HOUR * 60 + rowIndex * (60 / ROWS_PER_HOUR);
  out.setHours(0, 0, 0, 0);
  out.setMinutes(minutes);
  return out;
}

function formatHour(h: number): string {
  const period = h >= 12 ? 'PM' : 'AM';
  const hh = h % 12 === 0 ? 12 : h % 12;
  return `${hh} ${period}`;
}
