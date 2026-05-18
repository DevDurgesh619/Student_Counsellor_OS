'use client';

import { useParams } from 'next/navigation';
import Link from 'next/link';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { counsellorApi, ApiError } from '@/lib/api';

const VALIDATION_MARKER = '⚠️ Validation failed';

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
  const { data: pendingData } = useQuery({
    queryKey: ['session-pending-change', sessionId],
    queryFn: () => counsellorApi.sessionPendingChange(sessionId),
    enabled: Boolean(sessionId),
  });

  const pending = pendingData?.data ?? null;

  const decide = useMutation({
    mutationFn: (decision: 'approve' | 'reject') =>
      counsellorApi.decidePendingChange(sessionId, decision),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['session-pending-change', sessionId] });
      qc.invalidateQueries({ queryKey: ['queue'] });
      qc.invalidateQueries({ queryKey: ['student-tasks-timetable'] });
    },
  });

  const runPipeline = useMutation({
    mutationFn: () => counsellorApi.runSessionPipeline(sessionId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['session-extraction', sessionId] });
      qc.invalidateQueries({ queryKey: ['session-pending-change', sessionId] });
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
            {new Date(sessionRow.scheduledAt).toLocaleString('en-US')} · status{' '}
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
          <h2 className="text-sm font-medium">Proposed timetable change</h2>
          {pending && (
            <div className="flex items-center gap-2">
              <button
                disabled={decide.isPending}
                onClick={() => decide.mutate('reject')}
                className="rounded-md border border-destructive px-3 py-1 text-xs text-destructive hover:bg-destructive hover:text-destructive-foreground disabled:opacity-50"
              >
                Reject
              </button>
              {(() => {
                const blocked =
                  pending.change.rationale?.startsWith(VALIDATION_MARKER) ?? false;
                return (
                  <button
                    disabled={decide.isPending || blocked}
                    onClick={() => decide.mutate('approve')}
                    title={
                      blocked
                        ? 'Fix the schedule (or re-run the pipeline) before applying — see validation errors above.'
                        : undefined
                    }
                    className="rounded-md bg-primary px-3 py-1 text-xs text-primary-foreground hover:opacity-90 disabled:opacity-50"
                  >
                    {decide.isPending ? 'Working…' : 'Approve & apply'}
                  </button>
                );
              })()}
            </div>
          )}
        </div>
        {!pending ? (
          <p className="mt-2 text-sm text-muted-foreground">
            No proposed changes from this session.
          </p>
        ) : (
          <PendingChangeBlock pending={pending} error={decide.error as Error | null} />
        )}
      </section>
    </div>
  );
}

function PendingChangeBlock({
  pending,
  error,
}: {
  pending: NonNullable<ReturnType<typeof useQuery>['data']> extends infer T ? T : never;
  error: Error | null;
}) {
  // `pending` is typed loosely above because we narrow via the prop site;
  // cast to the concrete shape for rendering.
  const p = pending as unknown as import('@/lib/api').PendingChangeResponse;
  const { summary, change } = p;
  const validationFailed = change.rationale?.startsWith(VALIDATION_MARKER) ?? false;
  return (
    <div className="mt-2 space-y-3 text-sm">
      {change.rationale && (
        <pre
          className={
            validationFailed
              ? 'whitespace-pre-wrap rounded-md border border-destructive/50 bg-destructive/5 px-3 py-2 text-xs text-destructive'
              : 'whitespace-pre-wrap rounded-md border border-dashed border-border bg-muted/30 px-3 py-2 text-xs text-muted-foreground'
          }
        >
          {change.rationale}
        </pre>
      )}
      {summary.added.length > 0 && (
        <DiffSection label="Add" tone="success">
          {summary.added.map((t, i) => (
            <DiffRow key={`a${i}`} title={`${t.subject} · ${t.taskTitle}`} when={formatRange(t.scheduledStart, t.scheduledEnd)} />
          ))}
        </DiffSection>
      )}
      {summary.removed.length > 0 && (
        <DiffSection label="Cancel" tone="destructive">
          {summary.removed.map((t, i) => (
            <DiffRow key={`r${i}`} title={`${t.subject} · ${t.taskTitle}`} when={formatRange(t.scheduledStart, t.scheduledEnd)} />
          ))}
        </DiffSection>
      )}
      {summary.moved.length > 0 && (
        <DiffSection label="Move" tone="muted">
          {summary.moved.map((m, i) => (
            <DiffRow
              key={`m${i}`}
              title={`${m.from.subject} · ${m.from.taskTitle}`}
              when={`${formatRange(m.from.scheduledStart, m.from.scheduledEnd)} → ${formatRange(m.to.scheduledStart, m.to.scheduledEnd)}`}
            />
          ))}
        </DiffSection>
      )}
      {summary.edits.length > 0 && (
        <DiffSection label="Edit" tone="muted">
          {summary.edits.map((e, i) => (
            <DiffRow
              key={`e${i}`}
              title={`${e.task.subject} · ${e.task.taskTitle}`}
              when={Object.entries(e.changes)
                .map(([k, v]) => `${k}=${String(v)}`)
                .join(', ')}
            />
          ))}
        </DiffSection>
      )}
      {summary.added.length === 0 &&
        summary.removed.length === 0 &&
        summary.moved.length === 0 &&
        summary.edits.length === 0 && (
          <p className="text-xs text-muted-foreground">
            The worker produced no operations — only warnings (see rationale above).
          </p>
        )}
      {error && (
        <div className="rounded-md border border-destructive/50 bg-destructive/5 px-3 py-2 text-xs text-destructive">
          <p className="font-medium">{error.message}</p>
          {error instanceof ApiError &&
            Array.isArray((error.details as { errors?: string[] } | undefined)?.errors) && (
              <ul className="mt-1 ml-4 list-disc">
                {((error.details as { errors: string[] }).errors).map((e, i) => (
                  <li key={i}>{e}</li>
                ))}
              </ul>
            )}
        </div>
      )}
    </div>
  );
}

function DiffSection({
  label,
  tone,
  children,
}: {
  label: string;
  tone: 'success' | 'destructive' | 'muted';
  children: React.ReactNode;
}) {
  const toneClass =
    tone === 'success'
      ? 'border-success/40 bg-success/5'
      : tone === 'destructive'
        ? 'border-destructive/40 bg-destructive/5'
        : 'border-border bg-muted/20';
  return (
    <div className={`rounded-md border ${toneClass} p-2`}>
      <p className="mb-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
        {label}
      </p>
      <ul className="space-y-1">{children}</ul>
    </div>
  );
}

function DiffRow({ title, when }: { title: string; when: string }) {
  return (
    <li className="flex flex-wrap items-baseline justify-between gap-2 text-sm">
      <span className="font-medium">{title}</span>
      <span className="text-xs text-muted-foreground">{when}</span>
    </li>
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

function formatRange(startIso: string, endIso: string): string {
  const s = new Date(startIso);
  const e = new Date(endIso);
  const date = s.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
  const startT = s.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true });
  const endT = e.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true });
  return `${date} · ${startT} – ${endT}`;
}
