'use client';

import Link from 'next/link';
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { counsellorApi } from '@/lib/api';
import { formatRelative } from '@/lib/utils';

type QueueRow = {
  id: string;
  type: string;
  studentId: string | null;
  referenceId: string;
  priority: number;
  status: string;
  createdAt: string;
  resolvedAt: string | null;
  resolvedBy: string | null;
  resolutionNotes: string | null;
};

const STATUS_FILTERS = [
  { value: 'pending,in_review', label: 'Active' },
  { value: 'resolved,dismissed', label: 'Resolved' },
] as const;

export default function ReviewQueuePage() {
  const [filter, setFilter] = useState<(typeof STATUS_FILTERS)[number]['value']>('pending,in_review');
  const qc = useQueryClient();

  const { data, isLoading } = useQuery({
    queryKey: ['queue', filter],
    queryFn: () => counsellorApi.queue(filter) as Promise<{ data: QueueRow[] }>,
  });

  const resolve = useMutation({
    mutationFn: (input: { id: string; status: 'resolved' | 'dismissed' }) =>
      counsellorApi.resolveQueueItem(input.id, { status: input.status }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['queue'] });
      qc.invalidateQueries({ queryKey: ['students-overview'] });
    },
  });

  const rows = data?.data ?? [];

  return (
    <div className="space-y-4">
      <header className="flex items-baseline justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Review queue</h1>
          <p className="text-sm text-muted-foreground">
            Layer 1, kept indefinitely. Resolved items become the permanent decision record.
          </p>
        </div>
        <div className="flex gap-1 rounded-md border border-border p-0.5">
          {STATUS_FILTERS.map((f) => (
            <button
              key={f.value}
              onClick={() => setFilter(f.value)}
              className={`rounded px-3 py-1 text-sm transition-colors ${
                filter === f.value ? 'bg-primary text-primary-foreground' : 'hover:bg-muted'
              }`}
            >
              {f.label}
            </button>
          ))}
        </div>
      </header>

      {isLoading && <p className="text-sm text-muted-foreground">Loading…</p>}
      {!isLoading && rows.length === 0 && (
        <p className="rounded-lg border border-dashed border-border p-6 text-center text-sm text-muted-foreground">
          {filter === 'pending,in_review'
            ? 'Queue is empty. Nothing needs your attention right now.'
            : 'No resolved items yet.'}
        </p>
      )}

      <ul className="space-y-2">
        {rows.map((r) => (
          <li
            key={r.id}
            className="flex items-start gap-3 rounded-lg border border-border bg-card p-3"
          >
            <PriorityBadge priority={r.priority} />
            <div className="flex-1">
              <div className="flex items-center gap-2">
                <span className="rounded bg-muted px-2 py-0.5 text-xs font-medium">
                  {r.type.replace(/_/g, ' ')}
                </span>
                {/* Spinach meetings have no studentId yet (that's the whole
                    point — counsellor picks one). Show the link always so
                    they can click into the inbox detail to see + assign. */}
                {(r.studentId || r.type === 'unassigned_spinach_meeting') && (
                  <Link
                    href={openHref(r)}
                    className="text-sm underline hover:no-underline"
                  >
                    {openLabel(r)}
                  </Link>
                )}
              </div>
              <p className="mt-1 text-xs text-muted-foreground">
                Created {formatRelative(r.createdAt)} · ref{' '}
                <span className="font-mono">{r.referenceId.slice(0, 8)}…</span>
                {r.resolvedAt && ` · resolved ${formatRelative(r.resolvedAt)}`}
              </p>
              {r.resolutionNotes && (
                <p className="mt-1 text-xs italic text-muted-foreground">"{r.resolutionNotes}"</p>
              )}
            </div>
            {filter === 'pending,in_review' &&
              // Spinach inbox items can't be resolved/dismissed from here —
              // they need a student assignment, which lives on /spinach-inbox/[id].
              // The "Assign meeting" link above is the only meaningful action.
              r.type !== 'unassigned_spinach_meeting' && (
                <div className="flex gap-2">
                  <button
                    onClick={() => resolve.mutate({ id: r.id, status: 'dismissed' })}
                    className="rounded-md border border-border px-2 py-1 text-xs hover:bg-muted"
                  >
                    Dismiss
                  </button>
                  <button
                    onClick={() => resolve.mutate({ id: r.id, status: 'resolved' })}
                    className="rounded-md bg-primary px-2 py-1 text-xs text-primary-foreground hover:opacity-90"
                  >
                    Resolve
                  </button>
                </div>
              )}
          </li>
        ))}
      </ul>
    </div>
  );
}

function openHref(r: QueueRow): string {
  switch (r.type) {
    case 'session_extraction':
    case 'draft_timetable_changes':
    case 'action_item_unassigned':
      // For session-derived items, the referenceId resolves directly to a
      // session detail page (or the extraction id which we let the page
      // handle). For draft_timetable_changes, referenceId IS the sessionId.
      if (r.type === 'draft_timetable_changes') {
        return `/sessions/${r.referenceId}`;
      }
      return r.studentId ? `/students/${r.studentId}/today` : `/sessions/${r.referenceId}`;
    case 'meeting_prep_brief':
      return r.studentId ? `/students/${r.studentId}/brief` : '#';
    case 'profile_draft':
      return `/onboarding/${r.referenceId}`;
    case 'unassigned_spinach_meeting':
      return `/spinach-inbox/${r.referenceId}`;
    default:
      return r.studentId ? `/students/${r.studentId}/today` : '#';
  }
}

function openLabel(r: QueueRow): string {
  switch (r.type) {
    case 'session_extraction':
      return 'Open session';
    case 'draft_timetable_changes':
      return 'Review drafts';
    case 'action_item_unassigned':
      return 'Assign action item';
    case 'meeting_prep_brief':
      return 'Open brief';
    case 'profile_draft':
      return 'Review profile';
    case 'unassigned_spinach_meeting':
      return 'Assign meeting';
    default:
      return 'Open student';
  }
}

function PriorityBadge({ priority }: { priority: number }) {
  const tone = priority <= 3 ? 'bg-destructive text-destructive-foreground' : priority <= 6 ? 'bg-warning text-warning-foreground' : 'bg-muted';
  return (
    <span
      title={`priority ${priority}`}
      className={`mt-0.5 inline-flex h-6 w-6 items-center justify-center rounded-full text-xs ${tone}`}
    >
      {priority}
    </span>
  );
}
