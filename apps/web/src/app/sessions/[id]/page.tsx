'use client';

import { useState } from 'react';
import { useParams } from 'next/navigation';
import Link from 'next/link';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { counsellorApi, type DraftTaskRow } from '@/lib/api';

export default function SessionDetailPage() {
  const params = useParams<{ id: string }>();
  const sessionId = params.id;
  const qc = useQueryClient();

  const { data: session } = useQuery({
    queryKey: ['session', sessionId],
    queryFn: () => counsellorApi.session(sessionId),
    enabled: Boolean(sessionId),
  });
  const { data: extractionData } = useQuery({
    queryKey: ['session-extraction', sessionId],
    queryFn: () => counsellorApi.sessionExtraction(sessionId),
    enabled: Boolean(sessionId),
  });
  const { data: draftTasksData } = useQuery({
    queryKey: ['session-drafts', sessionId],
    queryFn: () => counsellorApi.sessionDraftTasks(sessionId),
    enabled: Boolean(sessionId),
  });

  const [selected, setSelected] = useState<Set<string>>(new Set());
  const drafts = draftTasksData?.data ?? [];

  const decide = useMutation({
    mutationFn: (action: 'approve' | 'reject') =>
      counsellorApi.bulkDecideDraftTasks({
        decisions: drafts
          .filter((t) => selected.has(t.id))
          .map((t) => ({ taskId: t.id, action })),
      }),
    onSuccess: () => {
      setSelected(new Set());
      qc.invalidateQueries({ queryKey: ['session-drafts', sessionId] });
      qc.invalidateQueries({ queryKey: ['queue'] });
    },
  });

  const runPipeline = useMutation({
    mutationFn: () => counsellorApi.runSessionPipeline(sessionId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['session-extraction', sessionId] });
      qc.invalidateQueries({ queryKey: ['session-drafts', sessionId] });
    },
  });

  const extraction = extractionData?.data ?? null;
  const sessionRow = session?.data ?? null;

  return (
    <div className="space-y-4">
      <header className="space-y-1">
        <h1 className="text-2xl font-semibold">Session detail</h1>
        {sessionRow && (
          <p className="text-sm text-muted-foreground">
            {new Date(sessionRow.scheduledAt).toLocaleString()} · status{' '}
            <span className="font-medium">{sessionRow.status}</span>
            {' · '}
            <Link
              href={`/students/${sessionRow.studentId}/today`}
              className="underline hover:no-underline"
            >
              Open student
            </Link>
          </p>
        )}
        <div>
          <button
            onClick={() => runPipeline.mutate()}
            disabled={runPipeline.isPending}
            className="mt-2 rounded-md border border-border px-3 py-1 text-xs hover:bg-muted disabled:opacity-50"
          >
            {runPipeline.isPending ? 'Re-running…' : 'Re-run pipeline'}
          </button>
          {runPipeline.isError && (
            <p className="mt-1 text-xs text-destructive">
              {(runPipeline.error as Error).message}
            </p>
          )}
        </div>
      </header>

      <section className="rounded-lg border border-border bg-card p-4">
        <h2 className="text-sm font-medium">Structured extraction</h2>
        {!extraction ? (
          <p className="mt-2 text-sm text-muted-foreground">
            No extraction yet. Run the pipeline above (or wait for the Spinach webhook).
          </p>
        ) : (
          <div className="mt-2 space-y-2 text-sm">
            <p className="text-xs text-muted-foreground">
              Confidence: <span className="font-medium">{extraction.confidence}</span>
              {extraction.scheduleChangesDiscussed && (
                <span className="ml-2 rounded bg-primary px-2 py-0.5 text-[10px] uppercase text-primary-foreground">
                  schedule discussed
                </span>
              )}
            </p>
            <ExtractionField label="Topics" items={extraction.topicsDiscussed} />
            <ExtractionField
              label="Action items"
              items={extraction.actionItems.map(
                (a) => `[${a.owner}] ${a.description}${a.due ? ` (due ${a.due})` : ''}`,
              )}
            />
            <ExtractionField
              label="Schedule changes"
              items={extraction.scheduleChanges.map(
                (s) => `${s.type}: ${s.what}${s.when ? ` @ ${s.when}` : ''}`,
              )}
            />
            <ExtractionField
              label="Concerns"
              items={extraction.concernsRaised.map((c) => `[${c.raised_by}] ${c.concern}`)}
            />
            <ExtractionField label="Decisions" items={extraction.decisionsMade} />
            <ExtractionField label="Open questions" items={extraction.openQuestions} />
          </div>
        )}
      </section>

      <section className="rounded-lg border border-border bg-card p-4">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-medium">Draft timetable changes</h2>
          {drafts.length > 0 && (
            <div className="flex items-center gap-2">
              <span className="text-xs text-muted-foreground">
                {selected.size} selected
              </span>
              <button
                disabled={selected.size === 0 || decide.isPending}
                onClick={() => decide.mutate('reject')}
                className="rounded-md border border-border px-2 py-1 text-xs hover:bg-muted disabled:opacity-50"
              >
                Reject
              </button>
              <button
                disabled={selected.size === 0 || decide.isPending}
                onClick={() => decide.mutate('approve')}
                className="rounded-md bg-primary px-2 py-1 text-xs text-primary-foreground hover:opacity-90 disabled:opacity-50"
              >
                Approve
              </button>
            </div>
          )}
        </div>
        {drafts.length === 0 ? (
          <p className="mt-2 text-sm text-muted-foreground">
            No draft tasks for this session.
          </p>
        ) : (
          <ul className="mt-2 space-y-1">
            {drafts.map((t) => (
              <DraftRow
                key={t.id}
                task={t}
                checked={selected.has(t.id)}
                onToggle={() => {
                  setSelected((prev) => {
                    const next = new Set(prev);
                    if (next.has(t.id)) next.delete(t.id);
                    else next.add(t.id);
                    return next;
                  });
                }}
              />
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

function ExtractionField({ label, items }: { label: string; items: string[] }) {
  if (items.length === 0) return null;
  return (
    <div>
      <p className="text-xs font-medium text-muted-foreground">{label}</p>
      <ul className="ml-4 list-disc">
        {items.map((it, i) => (
          <li key={i}>{it}</li>
        ))}
      </ul>
    </div>
  );
}

function DraftRow({
  task,
  checked,
  onToggle,
}: {
  task: DraftTaskRow;
  checked: boolean;
  onToggle: () => void;
}) {
  return (
    <li className="flex items-center gap-3 rounded-md border border-border p-2 text-sm">
      <input type="checkbox" checked={checked} onChange={onToggle} />
      <div className="flex-1">
        <p className="font-medium">{task.taskTitle}</p>
        <p className="text-xs text-muted-foreground">
          {task.subject} ·{' '}
          {new Date(task.scheduledStart).toLocaleString(undefined, {
            month: 'short',
            day: 'numeric',
            hour: 'numeric',
            minute: '2-digit',
          })}{' '}
          –{' '}
          {new Date(task.scheduledEnd).toLocaleTimeString(undefined, {
            hour: 'numeric',
            minute: '2-digit',
          })}
          {' · '}
          flexibility {task.flexibility}
        </p>
        {task.taskDescription && (
          <p className="mt-1 text-xs italic text-muted-foreground">{task.taskDescription}</p>
        )}
      </div>
    </li>
  );
}
