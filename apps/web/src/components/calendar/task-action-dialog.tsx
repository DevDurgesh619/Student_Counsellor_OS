'use client';

import { useEffect, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { taskApi } from '@/lib/api';
import type { CalendarTask } from './task-block';

/**
 * Edit/reschedule/delete dialog for a single task. Opens when the
 * counsellor clicks a block on the calendar grid. All three actions route
 * through `taskApi` → /api/tasks/* → applyChange() under the hood, so every
 * edit produces a timetable_changes audit row (source='counsellor_direct').
 *
 * Kept intentionally small: title + subject + start/end + flexibility. For
 * heavier edits (changing a recurrence rule) the counsellor still uses the
 * conversational editor.
 */
export function TaskActionDialog({
  studentId,
  task,
  onClose,
}: {
  studentId: string;
  task: CalendarTask | null;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const [title, setTitle] = useState('');
  const [subject, setSubject] = useState('');
  const [start, setStart] = useState('');
  const [end, setEnd] = useState('');
  const [flexibility, setFlexibility] = useState<'fixed' | 'preferred' | 'flexible'>('preferred');

  // Reset form when the selected task changes.
  useEffect(() => {
    if (!task) return;
    setTitle(task.taskTitle);
    setSubject(task.subject);
    setStart(isoToLocalInput(task.scheduledStart));
    setEnd(isoToLocalInput(task.scheduledEnd));
    setFlexibility('preferred');
  }, [task]);

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ['student-tasks', studentId] });
    qc.invalidateQueries({ queryKey: ['student-tasks-timetable', studentId] });
  };

  const save = useMutation({
    mutationFn: async () => {
      if (!task) return;
      const startIso = localInputToIso(start);
      const endIso = localInputToIso(end);
      const startChanged = startIso !== task.scheduledStart;
      const endChanged = endIso !== task.scheduledEnd;
      const fieldsChanged =
        title !== task.taskTitle || subject !== task.subject || flexibility !== 'preferred';

      if (!startChanged && !endChanged && !fieldsChanged) {
        // Nothing to do — the form is unchanged. Skip the request entirely
        // so we don't churn the audit log with no-op rows.
        return;
      }

      // Order matters: PATCH the existing row FIRST so the new title /
      // subject / flexibility lands, THEN reschedule (which clones the
      // current row into a new one). If we rescheduled first, the clone
      // would carry the OLD title and the subsequent PATCH would target
      // a now-superseded row, silently losing the edit.
      if (fieldsChanged) {
        await taskApi.patch(task.id, { taskTitle: title, subject, flexibility });
      }
      if (startChanged || endChanged) {
        await taskApi.reschedule(task.id, {
          newScheduledStart: startIso,
          newScheduledEnd: endIso,
        });
      }
    },
    onSuccess: () => {
      invalidate();
      onClose();
    },
  });

  const del = useMutation({
    mutationFn: () => taskApi.cancel(task!.id),
    onSuccess: () => {
      invalidate();
      onClose();
    },
  });

  if (!task) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      onClick={onClose}
    >
      <div
        className="w-full max-w-md space-y-3 rounded-lg border border-border bg-card p-4 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="flex items-start justify-between">
          <div>
            <h3 className="text-base font-semibold">Edit task</h3>
            <p className="text-xs text-muted-foreground">
              All changes are recorded in the timetable history with source ={' '}
              <code>counsellor_direct</code>.
            </p>
          </div>
          <button
            onClick={onClose}
            className="rounded p-1 text-muted-foreground hover:bg-muted"
            aria-label="Close"
          >
            ×
          </button>
        </header>

        <div className="space-y-2 text-sm">
          <label className="block">
            <span className="text-xs text-muted-foreground">Title</span>
            <input
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              className="mt-0.5 w-full rounded-md border border-input bg-background px-2 py-1"
            />
          </label>
          <label className="block">
            <span className="text-xs text-muted-foreground">Subject</span>
            <input
              type="text"
              value={subject}
              onChange={(e) => setSubject(e.target.value)}
              className="mt-0.5 w-full rounded-md border border-input bg-background px-2 py-1"
            />
          </label>
          <div className="grid grid-cols-2 gap-2">
            <label className="block">
              <span className="text-xs text-muted-foreground">Start</span>
              <input
                type="datetime-local"
                value={start}
                onChange={(e) => setStart(e.target.value)}
                className="mt-0.5 w-full rounded-md border border-input bg-background px-2 py-1"
              />
            </label>
            <label className="block">
              <span className="text-xs text-muted-foreground">End</span>
              <input
                type="datetime-local"
                value={end}
                onChange={(e) => setEnd(e.target.value)}
                className="mt-0.5 w-full rounded-md border border-input bg-background px-2 py-1"
              />
            </label>
          </div>
          <label className="block">
            <span className="text-xs text-muted-foreground">Flexibility</span>
            <select
              value={flexibility}
              onChange={(e) =>
                setFlexibility(e.target.value as 'fixed' | 'preferred' | 'flexible')
              }
              className="mt-0.5 w-full rounded-md border border-input bg-background px-2 py-1"
            >
              <option value="fixed">Fixed</option>
              <option value="preferred">Preferred</option>
              <option value="flexible">Flexible</option>
            </select>
          </label>
        </div>

        {(save.error || del.error) && (
          <p className="text-xs text-rose-500">
            {(save.error as Error)?.message ?? (del.error as Error)?.message}
          </p>
        )}

        <footer className="flex items-center justify-between gap-2 pt-1">
          <button
            onClick={() => {
              if (
                window.confirm(
                  `Delete "${task.taskTitle}"? This soft-cancels the task and removes it from the calendar.`,
                )
              ) {
                del.mutate();
              }
            }}
            disabled={del.isPending || save.isPending}
            className="rounded-md border border-rose-500/40 px-3 py-1.5 text-xs text-rose-600 hover:bg-rose-500/10 disabled:opacity-50"
          >
            {del.isPending ? 'Deleting…' : 'Delete'}
          </button>
          <div className="flex gap-2">
            <button
              onClick={onClose}
              className="rounded-md border border-border px-3 py-1.5 text-xs hover:bg-muted"
            >
              Cancel
            </button>
            <button
              onClick={() => save.mutate()}
              disabled={save.isPending || del.isPending}
              className="rounded-md bg-primary px-3 py-1.5 text-xs text-primary-foreground hover:opacity-90 disabled:opacity-50"
            >
              {save.isPending ? 'Saving…' : 'Save'}
            </button>
          </div>
        </footer>
      </div>
    </div>
  );
}

/** ISO → `YYYY-MM-DDTHH:MM` for <input type="datetime-local">. */
function isoToLocalInput(iso: string): string {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** datetime-local string → ISO. The input is interpreted in the browser's
 * local timezone — same as what `new Date(local)` produces. */
function localInputToIso(local: string): string {
  return new Date(local).toISOString();
}
