'use client';

import Link from 'next/link';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ChevronRight, CheckCircle2, AlertCircle } from 'lucide-react';
import { counsellorApi, type SpinachInboxRow } from '@/lib/api';
import { formatRelative } from '@/lib/utils';

/**
 * Spinach inbox list — every unassigned meeting + its top suggested
 * student. Drains the backlog: counsellor scans the list, one-clicks
 * "Assign" on the obvious matches, or hits "Auto-assign all high-confidence"
 * to bulk-resolve everything the matcher is sure about.
 */
export default function SpinachInboxPage() {
  const qc = useQueryClient();

  const { data, isLoading } = useQuery({
    queryKey: ['spinach-inbox', 'unassigned'],
    queryFn: () => counsellorApi.spinachInboxList('unassigned'),
  });

  const assign = useMutation({
    mutationFn: (input: { ingestId: string; studentId: string }) =>
      counsellorApi.assignSpinachMeeting(input.ingestId, input.studentId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['spinach-inbox', 'unassigned'] });
      qc.invalidateQueries({ queryKey: ['spinach-recent-activity'] });
      qc.invalidateQueries({ queryKey: ['students-overview'] });
    },
  });

  const bulk = useMutation({
    mutationFn: () => counsellorApi.bulkAutoAssignInbox(),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['spinach-inbox', 'unassigned'] });
      qc.invalidateQueries({ queryKey: ['spinach-recent-activity'] });
      qc.invalidateQueries({ queryKey: ['students-overview'] });
    },
  });

  const rows: SpinachInboxRow[] = data?.data ?? [];
  const highConfidenceCount = rows.filter(
    (r) => (r.suggestions?.[0]?.confidence ?? null) === 'high',
  ).length;

  return (
    <div className="space-y-4">
      <header className="flex flex-wrap items-end justify-between gap-2">
        <div>
          <h1 className="text-2xl font-semibold">Spinach inbox</h1>
          <p className="text-sm text-muted-foreground">
            Meetings Spinach surfaced but couldn&apos;t auto-match to a student.
          </p>
        </div>
        {highConfidenceCount > 0 && (
          <button
            onClick={() => bulk.mutate()}
            disabled={bulk.isPending}
            className="rounded-md bg-primary px-3 py-1.5 text-sm text-primary-foreground hover:opacity-90 disabled:opacity-50"
          >
            {bulk.isPending
              ? 'Working…'
              : `Auto-assign ${highConfidenceCount} high-confidence match${highConfidenceCount === 1 ? '' : 'es'}`}
          </button>
        )}
      </header>

      {bulk.isSuccess && (
        <p className="rounded-md border border-success/40 bg-success/5 px-3 py-2 text-sm text-foreground">
          Assigned {bulk.data?.data?.assigned ?? 0}, left {bulk.data?.data?.skipped ?? 0} for
          manual review.
          {(bulk.data?.data?.errors?.length ?? 0) > 0 &&
            ` (${bulk.data?.data?.errors.length} failed)`}
        </p>
      )}
      {bulk.isError && (
        <p className="text-sm text-destructive">{(bulk.error as Error).message}</p>
      )}

      {isLoading && <p className="text-sm text-muted-foreground">Loading…</p>}
      {!isLoading && rows.length === 0 && (
        <p className="rounded-lg border border-dashed border-border p-4 text-sm text-muted-foreground">
          Inbox is empty — every recent meeting is matched. 🎉
        </p>
      )}

      <ul className="space-y-2">
        {rows.map((r) => {
          const top = r.suggestions?.[0];
          const tone =
            top?.confidence === 'high'
              ? 'border-success/40'
              : top?.confidence === 'medium'
                ? 'border-warning/40'
                : 'border-border';
          const isAssigning =
            assign.isPending && assign.variables?.ingestId === r.id;
          return (
            <li
              key={r.id}
              className={`flex flex-wrap items-start justify-between gap-3 rounded-lg border bg-card p-3 ${tone}`}
            >
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  {top ? (
                    <CheckCircle2 className="h-4 w-4 shrink-0 text-success" />
                  ) : (
                    <AlertCircle className="h-4 w-4 shrink-0 text-muted-foreground" />
                  )}
                  <p className="truncate text-sm font-medium">
                    {r.title ?? '(no title)'}
                  </p>
                </div>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  {r.scheduledAt
                    ? new Date(r.scheduledAt).toLocaleString('en-US', {
                        month: 'short',
                        day: 'numeric',
                        hour: 'numeric',
                        minute: '2-digit',
                      })
                    : 'no scheduled time'}
                  {' · fetched '}
                  {formatRelative(r.fetchedAt)}
                </p>
                {top ? (
                  <p className="mt-1 text-xs">
                    <span className="text-muted-foreground">Suggested:</span>{' '}
                    <span className="font-medium">{top.fullName}</span>{' '}
                    <span className="text-muted-foreground">
                      · {top.confidence} · {top.reason}
                    </span>
                  </p>
                ) : (
                  <p className="mt-1 text-xs text-muted-foreground">
                    No confident match — open to triage manually.
                  </p>
                )}
              </div>
              <div className="flex shrink-0 items-center gap-2">
                {top && (
                  <button
                    onClick={() =>
                      assign.mutate({ ingestId: r.id, studentId: top.studentId })
                    }
                    disabled={isAssigning}
                    className="rounded-md bg-primary px-2.5 py-1 text-xs text-primary-foreground hover:opacity-90 disabled:opacity-50"
                  >
                    {isAssigning ? 'Assigning…' : 'Assign →'}
                  </button>
                )}
                <Link
                  href={`/spinach-inbox/${r.id}`}
                  className="inline-flex items-center gap-0.5 rounded-md border border-border px-2 py-1 text-xs hover:bg-muted"
                >
                  Open <ChevronRight className="h-3 w-3" />
                </Link>
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
