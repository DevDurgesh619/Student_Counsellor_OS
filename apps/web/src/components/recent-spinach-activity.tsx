'use client';

import Link from 'next/link';
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ChevronDown, ChevronUp, RefreshCcw, CheckCircle2, AlertCircle } from 'lucide-react';
import { counsellorApi } from '@/lib/api';
import { cn, formatRelative } from '@/lib/utils';

/**
 * Counsellor home panel. Surfaces the Spinach pipeline's recent moves so a
 * silent auto-match (e.g. today's Hetvika meeting flowing through and
 * landing on her sessions tab) reads as obviously-working instead of
 * obviously-broken. Refreshes every 60s while the page is open.
 */
export function RecentSpinachActivity() {
  const qc = useQueryClient();
  const [open, setOpen] = useState(true);

  const { data, isLoading } = useQuery({
    queryKey: ['spinach-recent-activity'],
    queryFn: counsellorApi.recentSpinachActivity,
    refetchInterval: 60_000,
  });

  const sync = useMutation({
    mutationFn: () => counsellorApi.pollSpinachNow(),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['spinach-recent-activity'] });
      qc.invalidateQueries({ queryKey: ['students-overview'] });
    },
  });

  const items = data?.items ?? [];
  const unassignedCount = items.filter((i) => i.status === 'unassigned').length;
  const matchedCount = items.filter((i) => i.status === 'linked').length;

  return (
    <section className="rounded-lg border border-border bg-card">
      <header className="flex flex-wrap items-center justify-between gap-2 px-4 py-3">
        <div className="flex items-center gap-3">
          <button
            onClick={() => setOpen((o) => !o)}
            className="inline-flex items-center gap-1 text-sm font-medium hover:underline"
            aria-expanded={open}
          >
            {open ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
            Spinach activity
          </button>
          <span className="text-xs text-muted-foreground">
            Last sync:{' '}
            {data?.lastSyncedAt
              ? formatRelative(data.lastSyncedAt)
              : 'never'}
          </span>
          {data?.nextScheduledSession && (
            <span className="text-xs text-muted-foreground">
              · Next session:{' '}
              <Link
                href={`/students/${data.nextScheduledSession.studentId}/sessions`}
                className="underline hover:no-underline"
              >
                {data.nextScheduledSession.studentName}
              </Link>{' '}
              {formatSessionTime(data.nextScheduledSession.scheduledAt)}
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          {unassignedCount > 0 && (
            <Link
              href="/spinach-inbox"
              className="rounded-md border border-warning/40 bg-warning/10 px-2 py-1 text-xs text-foreground hover:bg-warning/20"
            >
              {unassignedCount} need review →
            </Link>
          )}
          <button
            onClick={() => sync.mutate()}
            disabled={sync.isPending}
            className="inline-flex items-center gap-1 rounded-md border border-border px-2 py-1 text-xs hover:bg-muted disabled:opacity-50"
          >
            <RefreshCcw
              className={cn('h-3 w-3', sync.isPending && 'animate-spin')}
            />
            {sync.isPending ? 'Syncing…' : 'Sync now'}
          </button>
        </div>
      </header>

      {open && (
        <div className="border-t border-border px-4 py-3">
          {isLoading && (
            <p className="text-xs text-muted-foreground">Loading…</p>
          )}
          {!isLoading && items.length === 0 && (
            <p className="text-xs text-muted-foreground">
              No Spinach activity in the last 7 days.
            </p>
          )}
          {sync.isError && (
            <p className="mb-2 text-xs text-destructive">
              Sync failed: {(sync.error as Error).message}
            </p>
          )}
          {sync.isSuccess && (
            <p className="mb-2 text-xs text-success">
              Sync complete: fetched {sync.data?.data?.meetingsFetched ?? 0} meetings, created{' '}
              {sync.data?.data?.sessionsCreated ?? 0} sessions, {sync.data?.data?.unassigned ?? 0}{' '}
              need review.
            </p>
          )}
          <ul className="space-y-1.5 text-sm">
            {items.map((it) => (
              <li
                key={it.ingestId}
                className="flex items-start justify-between gap-2 border-b border-border/40 pb-1.5 last:border-b-0 last:pb-0"
              >
                <div className="flex min-w-0 items-start gap-2">
                  {it.status === 'linked' ? (
                    <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0 text-success" />
                  ) : (
                    <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-warning" />
                  )}
                  <div className="min-w-0">
                    <p className="truncate font-medium">
                      {it.title ?? '(untitled meeting)'}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {it.student ? (
                        <Link
                          href={`/students/${it.student.id}/sessions`}
                          className="underline hover:no-underline"
                        >
                          {it.student.fullName ?? '(unnamed student)'}
                        </Link>
                      ) : (
                        <span>Unassigned</span>
                      )}
                      {' · '}
                      {formatRelative(it.fetchedAt)}
                    </p>
                  </div>
                </div>
                {it.status === 'unassigned' && (
                  <Link
                    href={`/spinach-inbox/${it.ingestId}`}
                    className="shrink-0 rounded-md border border-border px-2 py-0.5 text-xs hover:bg-muted"
                  >
                    Assign
                  </Link>
                )}
              </li>
            ))}
          </ul>
          {(matchedCount > 0 || unassignedCount > 0) && (
            <p className="mt-2 text-[11px] text-muted-foreground">
              {matchedCount} matched · {unassignedCount} unassigned in this view
            </p>
          )}
        </div>
      )}
    </section>
  );
}

function formatSessionTime(iso: string): string {
  return new Date(iso).toLocaleString('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  });
}
