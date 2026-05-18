'use client';

import { cn } from '@/lib/utils';

type Status =
  | 'draft'
  | 'scheduled'
  | 'rescheduled'
  | 'cancelled'
  | 'completed'
  | 'skipped'
  | 'couldnt_do';

export type CalendarTask = {
  id: string;
  scheduledStart: string;
  scheduledEnd: string;
  subject: string;
  taskTitle: string;
  status: Status;
};

// Color is keyed on a normalized subject (lowercased, trimmed, IB level
// suffixes like " HL"/" SL"/" AB SL" stripped). That way "Math AI HL",
// "math ai hl ", "Math AI SL", and "MATH AI" all hit the same blue.
const SUBJECT_COLOR: Record<string, string> = {
  math: 'bg-blue-500/85 border-blue-600',
  'math ai': 'bg-blue-500/85 border-blue-600',
  'math aa': 'bg-blue-500/85 border-blue-600',
  chemistry: 'bg-emerald-500/85 border-emerald-600',
  biology: 'bg-lime-500/85 border-lime-600',
  physics: 'bg-indigo-500/85 border-indigo-600',
  economics: 'bg-amber-500/85 border-amber-600',
  english: 'bg-rose-500/85 border-rose-600',
  spanish: 'bg-fuchsia-500/85 border-fuchsia-600',
  french: 'bg-fuchsia-500/85 border-fuchsia-600',
  hindi: 'bg-fuchsia-500/85 border-fuchsia-600',
  history: 'bg-orange-500/85 border-orange-600',
  geography: 'bg-teal-500/85 border-teal-600',
  cs: 'bg-violet-500/85 border-violet-600',
  'computer science': 'bg-violet-500/85 border-violet-600',
  tok: 'bg-cyan-500/85 border-cyan-600',
  sleep: 'bg-slate-400/70 border-slate-500',
  meal: 'bg-orange-400/70 border-orange-500',
  free: 'bg-zinc-300/60 border-zinc-400',
  family: 'bg-pink-400/70 border-pink-500',
  other: 'bg-zinc-500/70 border-zinc-600',
};

function normalizeSubject(subject: string): string {
  return subject
    .toLowerCase()
    .replace(/\s+(hl|sl|ab\s*sl|ab\s*hl)\b/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function colorFor(subject: string): string {
  const key = normalizeSubject(subject);
  return SUBJECT_COLOR[key] ?? 'bg-slate-500/80 border-slate-600';
}

type Variant = 'normal' | 'diff-added' | 'diff-removed';

export function TaskBlock({
  task,
  variant = 'normal',
  onClick,
  draggable = false,
}: {
  task: CalendarTask;
  variant?: Variant;
  onClick?: (task: CalendarTask) => void;
  /**
   * When true, the block becomes a native HTML5 drag source carrying its
   * task id in `application/x-task-id`. The grid's empty cells pick this
   * up to fire `onTaskDragDrop`. Only scheduled tasks are draggable —
   * completed/skipped blocks short-circuit to a static button.
   */
  draggable?: boolean;
}) {
  const done = task.status === 'completed';
  const skipped = task.status === 'skipped' || task.status === 'couldnt_do';
  const cancelled = task.status === 'cancelled' || task.status === 'rescheduled';
  const canDrag = draggable && task.status === 'scheduled';

  return (
    <button
      onClick={onClick ? () => onClick(task) : undefined}
      draggable={canDrag}
      onDragStart={
        canDrag
          ? (e) => {
              e.dataTransfer.effectAllowed = 'move';
              e.dataTransfer.setData('application/x-task-id', task.id);
              // Fallback for browsers that ignore custom MIME types in the
              // initial dragenter handler (Safari pre-17).
              e.dataTransfer.setData('text/plain', task.id);
            }
          : undefined
      }
      className={cn(
        // `inset-0` (top/right/bottom/left = 0) makes the block fill its
        // wrapper completely — both the time-band height AND the column
        // width. `m-0.5` (2px margin on all sides) gives sequential
        // blocks like 8–9 / 9–10 a 4px visual gap so they read as
        // distinct cards instead of looking pixel-touching / overlapping.
        'absolute inset-0 m-0.5 overflow-hidden rounded border px-1.5 py-1 text-left text-[11px] leading-tight text-white shadow-sm transition-opacity',
        colorFor(task.subject),
        done && 'opacity-75 ring-1 ring-white/30',
        skipped && 'opacity-50 line-through',
        cancelled && 'opacity-40 line-through',
        variant === 'diff-added' && 'ring-2 ring-emerald-300 ring-offset-1 ring-offset-background',
        variant === 'diff-removed' && 'opacity-50 line-through ring-1 ring-rose-300',
        onClick && 'cursor-pointer hover:brightness-110',
        canDrag && 'cursor-grab active:cursor-grabbing',
      )}
      style={{ /* positioning provided by parent */ }}
    >
      <div className="truncate font-semibold">{task.subject}</div>
      <div className="truncate opacity-90">{task.taskTitle}</div>
      <div className="opacity-80">{formatRange(task.scheduledStart, task.scheduledEnd)}</div>
    </button>
  );
}

function formatRange(startIso: string, endIso: string): string {
  const s = new Date(startIso);
  const e = new Date(endIso);
  return `${formatTime(s)}–${formatTime(e)}`;
}

function formatTime(d: Date): string {
  return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}
