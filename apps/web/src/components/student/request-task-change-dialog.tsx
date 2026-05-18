'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { studentApi, type StudentTask } from '@/lib/api';

/**
 * Per-task change-request dialog. Shown when a student clicks a block on
 * their week calendar. Captures the structured signal the counsellor needs
 * to route this into the timetable editor: scope (single vs recurring) +
 * optional proposed new slot + reason.
 */
export function RequestTaskChangeDialog({
  task,
  onClose,
  /**
   * Where to open: 'details' shows a read-only task summary with a "Request
   * change" button (used from the week calendar); 'request' opens straight
   * into the form (used from the per-task page where the user already sees
   * the details, and from a drag-drop which already picked a slot).
   */
  initialMode = 'details',
  /**
   * Pre-populate the proposed-slot pickers (used by drag-and-drop). The
   * student can still adjust before submitting. Duration defaults to the
   * task's original duration so the drop only sets the start time.
   */
  prefillSlot,
}: {
  task: StudentTask | null;
  onClose: () => void;
  initialMode?: 'details' | 'request';
  prefillSlot?: { start: Date; end: Date } | null;
}) {
  const qc = useQueryClient();
  const hasRecurrence = Boolean(task?.recurrenceGroupId);
  const [mode, setMode] = useState<'details' | 'request'>(initialMode);
  const [scope, setScope] = useState<'single' | 'recurring' | null>(null);
  const [reason, setReason] = useState('');
  const [wantNewSlot, setWantNewSlot] = useState(false);
  const [date, setDate] = useState('');
  const [startTime, setStartTime] = useState('');
  const [endTime, setEndTime] = useState('');

  // Reset state whenever a new task is opened, prefilling the slot pickers
  // to the task's current time so the student doesn't start from zero.
  // If a `prefillSlot` is provided (drag-drop), use that instead and skip
  // straight to the request form (mode='request', wantNewSlot=true).
  useEffect(() => {
    if (!task) return;
    setMode(prefillSlot ? 'request' : initialMode);
    setScope(hasRecurrence ? null : 'single');
    setReason('');
    const useSlot = prefillSlot ?? {
      start: new Date(task.scheduledStart),
      end: new Date(task.scheduledEnd),
    };
    setWantNewSlot(Boolean(prefillSlot));
    setDate(toDateInput(useSlot.start));
    setStartTime(toTimeInput(useSlot.start));
    setEndTime(toTimeInput(useSlot.end));
  }, [task, hasRecurrence, initialMode, prefillSlot]);

  const immutable = task && task.status !== 'scheduled';

  // Pre-flight check: is there already a pending request for this task?
  // The server enforces the rule with a 409 CHANGE_REQUEST_EXISTS, but
  // surfacing it here prevents the bad-UX flow of "fill the form, click
  // submit, get an error toast". Re-queries cheap (TanStack caches it).
  const { data: myRequests } = useQuery({
    queryKey: ['my-change-requests'],
    queryFn: studentApi.changeRequests,
    enabled: Boolean(task),
  });
  const existingPending = useMemo(() => {
    if (!task) return null;
    const rows = myRequests?.data ?? [];
    return (
      rows.find(
        (r) =>
          (r as { status: string }).status === 'pending' &&
          (r as { originalTaskId?: string | null }).originalTaskId === task.id,
      ) ?? null
    );
  }, [task, myRequests]);

  const submit = useMutation({
    mutationFn: async () => {
      if (!task || !scope) return;
      const body: Parameters<typeof studentApi.submitChangeRequest>[0] = {
        kind: 'task_change',
        originalTaskId: task.id,
        scope,
        proposedChange:
          scope === 'recurring'
            ? `Change recurring ${task.subject} (${task.taskTitle})`
            : wantNewSlot
              ? `Move ${task.subject} (${task.taskTitle}) to ${date} ${startTime}`
              : `Change ${task.subject} (${task.taskTitle})`,
        reason: reason.trim(),
      };
      if (scope === 'recurring' && task.recurrenceGroupId) {
        body.targetRecurrenceGroupId = task.recurrenceGroupId;
      }
      if (wantNewSlot && date && startTime && endTime) {
        body.proposedStart = combineDateTimeToIso(date, startTime);
        body.proposedEnd = combineDateTimeToIso(date, endTime);
      }
      await studentApi.submitChangeRequest(body);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['my-change-requests'] });
      onClose();
    },
  });

  const canSubmit = useMemo(() => {
    if (!task || immutable) return false;
    if (existingPending) return false;
    if (!reason.trim()) return false;
    if (!scope) return false;
    if (wantNewSlot) {
      if (!date || !startTime || !endTime) return false;
      if (endTime <= startTime) return false;
    }
    return true;
  }, [task, immutable, existingPending, reason, scope, wantNewSlot, date, startTime, endTime]);

  if (!task) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      onClick={onClose}
    >
      <div
        className="w-full max-w-md space-y-4 rounded-lg border border-border bg-card p-5 shadow-lg"
        onClick={(e) => e.stopPropagation()}
      >
        <header>
          <h3 className="text-base font-semibold">Request a change</h3>
          <p className="mt-1 text-sm text-muted-foreground">
            {task.subject} · {task.taskTitle}
          </p>
          <p className="text-xs text-muted-foreground">
            {formatRange(task.scheduledStart, task.scheduledEnd)}
          </p>
        </header>

        {existingPending && !immutable && (
          <div className="rounded-md border border-warning/50 bg-warning/10 px-3 py-2 text-sm text-foreground">
            <p className="font-medium">You already asked to change this task.</p>
            <p className="mt-1 text-xs text-muted-foreground">
              Wait for your counsellor to decide, or{' '}
              <Link href="/student/requests" className="text-primary underline">
                see your existing request
              </Link>
              .
            </p>
          </div>
        )}

        {immutable ? (
          <p className="rounded-md border border-border bg-muted/40 p-3 text-sm">
            This task can&apos;t be changed anymore — its status is &ldquo;{task.status}&rdquo;.
          </p>
        ) : mode === 'details' ? (
          <>
            {task.taskDescription && (
              <div className="rounded-md border border-border bg-muted/30 p-3 text-sm">
                {task.taskDescription}
              </div>
            )}
            {task.expectedOutput && (
              <div className="text-sm">
                <span className="text-muted-foreground">Expected: </span>
                {task.expectedOutput}
              </div>
            )}
            <dl className="grid grid-cols-2 gap-x-3 gap-y-1 text-xs">
              <dt className="text-muted-foreground">Status</dt>
              <dd className="font-medium">{task.status}</dd>
              <dt className="text-muted-foreground">Flexibility</dt>
              <dd className="font-medium">{task.flexibility}</dd>
              {hasRecurrence && (
                <>
                  <dt className="text-muted-foreground">Recurring</dt>
                  <dd className="font-medium">Yes</dd>
                </>
              )}
            </dl>
          </>
        ) : (
          <>
            {hasRecurrence && (
              <div className="space-y-2">
                <p className="text-sm font-medium">This is part of a recurring series.</p>
                <p className="text-xs text-muted-foreground">
                  What would you like to change?
                </p>
                <div className="flex flex-col gap-1.5">
                  <label className="flex items-center gap-2 text-sm">
                    <input
                      type="radio"
                      name="scope"
                      checked={scope === 'single'}
                      onChange={() => setScope('single')}
                    />
                    Just this one occurrence
                  </label>
                  <label className="flex items-center gap-2 text-sm">
                    <input
                      type="radio"
                      name="scope"
                      checked={scope === 'recurring'}
                      onChange={() => setScope('recurring')}
                    />
                    All recurring instances
                  </label>
                </div>
              </div>
            )}

            <div className="space-y-2">
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={wantNewSlot}
                  onChange={(e) => setWantNewSlot(e.target.checked)}
                />
                Suggest a new slot (optional)
              </label>
              {wantNewSlot && (
                <div className="grid grid-cols-3 gap-2 text-sm">
                  <input
                    type="date"
                    value={date}
                    onChange={(e) => setDate(e.target.value)}
                    className="rounded-md border border-input bg-background px-2 py-1.5"
                  />
                  <input
                    type="time"
                    value={startTime}
                    onChange={(e) => setStartTime(e.target.value)}
                    className="rounded-md border border-input bg-background px-2 py-1.5"
                  />
                  <input
                    type="time"
                    value={endTime}
                    onChange={(e) => setEndTime(e.target.value)}
                    className="rounded-md border border-input bg-background px-2 py-1.5"
                  />
                </div>
              )}
            </div>

            <textarea
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="Why are you asking? (required)"
              rows={3}
              className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
            />

            {submit.error && (
              <p className="text-xs text-destructive">{(submit.error as Error).message}</p>
            )}
          </>
        )}

        <div className="flex justify-end gap-2">
          <button
            onClick={onClose}
            className="rounded-md border border-border px-3 py-1.5 text-sm hover:bg-muted"
          >
            Close
          </button>
          {!immutable && mode === 'details' && (
            <button
              onClick={() => setMode('request')}
              className="rounded-md bg-primary px-3 py-1.5 text-sm text-primary-foreground hover:opacity-90"
            >
              Request change
            </button>
          )}
          {!immutable && mode === 'request' && (
            <button
              disabled={!canSubmit || submit.isPending}
              onClick={() => submit.mutate()}
              className="rounded-md bg-primary px-3 py-1.5 text-sm text-primary-foreground hover:opacity-90 disabled:opacity-60"
            >
              {submit.isPending ? 'Sending…' : 'Send request'}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

function toDateInput(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${dd}`;
}

function toTimeInput(d: Date): string {
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function combineDateTimeToIso(date: string, time: string): string {
  // Build a Date in the browser's local timezone (the student's local time),
  // then convert to UTC ISO for the server. The server stores timestamptz so
  // round-tripping back to the same wall time in the same TZ is safe.
  const [h, m] = time.split(':').map(Number);
  const d = new Date(`${date}T00:00:00`);
  d.setHours(h ?? 0, m ?? 0, 0, 0);
  return d.toISOString();
}

function formatRange(startIso: string, endIso: string): string {
  const s = new Date(startIso);
  const e = new Date(endIso);
  const dateFmt = s.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
  const startFmt = s.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true });
  const endFmt = e.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true });
  return `${dateFmt} · ${startFmt} – ${endFmt}`;
}
