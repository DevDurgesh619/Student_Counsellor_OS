'use client';

import { useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { counsellorApi } from '@/lib/api';
import { formatRelative } from '@/lib/utils';

type TargetTask = {
  id: string;
  subject: string;
  taskTitle: string;
  scheduledStart: string;
  scheduledEnd: string;
  status: string;
};

type ChangeRequest = {
  id: string;
  requestedAt: string;
  proposedChange: string;
  reason: string;
  status: 'pending' | 'approved' | 'rejected' | 'expired';
  counsellorNotes: string | null;
  decidedAt: string | null;
  kind: 'general' | 'task_change';
  scope: 'single' | 'recurring' | null;
  proposedStart: string | null;
  proposedEnd: string | null;
  linkedConversationId: string | null;
  linkedChangeId: string | null;
  resolvedAt: string | null;
  targetTask: TargetTask | null;
};

export default function RequestsPage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const qc = useQueryClient();

  const { data: pending, isLoading: loadingPending } = useQuery({
    queryKey: ['change-requests', params.id, 'pending'],
    queryFn: () =>
      counsellorApi.studentChangeRequests(params.id, 'pending') as Promise<{
        data: ChangeRequest[];
      }>,
  });
  const { data: history } = useQuery({
    queryKey: ['change-requests', params.id, 'history'],
    queryFn: () =>
      counsellorApi.studentChangeRequests(params.id, 'approved,rejected,expired') as Promise<{
        data: ChangeRequest[];
      }>,
  });

  const decide = useMutation({
    mutationFn: (input: { id: string; decision: 'approved' | 'rejected'; counsellorNotes?: string }) =>
      counsellorApi.decideChangeRequest(input.id, {
        decision: input.decision,
        counsellorNotes: input.counsellorNotes,
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['change-requests'] });
      qc.invalidateQueries({ queryKey: ['queue'] });
      qc.invalidateQueries({ queryKey: ['students-overview'] });
    },
  });

  const openInEditor = useMutation({
    mutationFn: (id: string) => counsellorApi.openRequestInEditor(id),
    onSuccess: (resp) => {
      qc.invalidateQueries({ queryKey: ['change-requests'] });
      router.push(`/students/${params.id}/timetable?conv=${resp.conversationId}`);
    },
  });

  return (
    <div className="space-y-6">
      <section className="space-y-3">
        <h2 className="text-lg font-medium">Pending</h2>
        {loadingPending && <p className="text-sm text-muted-foreground">Loading…</p>}
        {!loadingPending && (pending?.data.length ?? 0) === 0 && (
          <p className="rounded-lg border border-dashed border-border p-4 text-sm text-muted-foreground">
            No pending requests.
          </p>
        )}
        {pending?.data.map((cr) => (
          <PendingCard
            key={cr.id}
            cr={cr}
            onDecide={(d, notes) => decide.mutate({ id: cr.id, decision: d, counsellorNotes: notes })}
            onOpenInEditor={() => openInEditor.mutate(cr.id)}
            openingInEditor={openInEditor.isPending && openInEditor.variables === cr.id}
            openError={
              openInEditor.isError && openInEditor.variables === cr.id
                ? (openInEditor.error as Error).message
                : null
            }
          />
        ))}
      </section>

      <section className="space-y-3">
        <h2 className="text-lg font-medium">History</h2>
        {(history?.data ?? []).map((cr) => (
          <HistoryCard key={cr.id} cr={cr} studentId={params.id} />
        ))}
      </section>
    </div>
  );
}

function PendingCard({
  cr,
  onDecide,
  onOpenInEditor,
  openingInEditor,
  openError,
}: {
  cr: ChangeRequest;
  onDecide: (decision: 'approved' | 'rejected', notes?: string) => void;
  onOpenInEditor: () => void;
  openingInEditor: boolean;
  openError: string | null;
}) {
  const [notes, setNotes] = useState('');
  return (
    <div className="space-y-3 rounded-lg border border-border bg-card p-4">
      <div>
        <div className="flex items-baseline justify-between">
          <span className="font-medium">{cr.proposedChange}</span>
          <span className="text-xs text-muted-foreground">{formatRelative(cr.requestedAt)}</span>
        </div>
        <p className="mt-1 text-sm text-muted-foreground">{cr.reason}</p>
      </div>

      {cr.kind === 'task_change' && (
        <TaskChangeBlock cr={cr} />
      )}

      <textarea
        value={notes}
        onChange={(e) => setNotes(e.target.value)}
        placeholder="Optional note (required to reject)"
        rows={2}
        className="w-full rounded-md border border-input bg-background px-2 py-1.5 text-sm"
      />
      {openError && (
        <p className="text-xs text-destructive">Editor handoff failed: {openError}</p>
      )}
      <div className="flex flex-wrap justify-end gap-2">
        <button
          onClick={() => onDecide('rejected', notes)}
          disabled={!notes.trim()}
          className="rounded-md border border-destructive px-3 py-1.5 text-sm text-destructive hover:bg-destructive hover:text-destructive-foreground disabled:opacity-50"
        >
          Reject
        </button>
        <button
          onClick={() => onDecide('approved', notes || undefined)}
          className="rounded-md border border-border px-3 py-1.5 text-sm hover:bg-muted"
        >
          Approve
        </button>
        {cr.kind === 'task_change' && (
          <button
            onClick={onOpenInEditor}
            disabled={openingInEditor}
            className="rounded-md bg-primary px-3 py-1.5 text-sm text-primary-foreground hover:opacity-90 disabled:opacity-60"
          >
            {openingInEditor ? 'Opening…' : 'Approve & open in editor →'}
          </button>
        )}
      </div>
    </div>
  );
}

function TaskChangeBlock({ cr }: { cr: ChangeRequest }) {
  const task = cr.targetTask;
  const proposed = cr.proposedStart && cr.proposedEnd
    ? `${formatDateTime(cr.proposedStart)} – ${formatTimeOnly(cr.proposedEnd)}`
    : 'unspecified — counsellor to decide';
  return (
    <div className="rounded-md border border-border bg-muted/30 px-3 py-2 text-sm">
      <div className="font-medium">
        {task ? `${task.subject} · ${task.taskTitle}` : '(linked task not found)'}
      </div>
      {task && (
        <div className="text-xs text-muted-foreground">
          {formatDateTime(task.scheduledStart)} – {formatTimeOnly(task.scheduledEnd)}
        </div>
      )}
      <div className="mt-1 flex flex-wrap gap-3 text-xs">
        <span>
          <span className="text-muted-foreground">Scope:</span>{' '}
          <span className="font-medium">{cr.scope ?? '—'}</span>
        </span>
        <span>
          <span className="text-muted-foreground">Proposed:</span>{' '}
          <span className="font-medium">{proposed}</span>
        </span>
      </div>
    </div>
  );
}

function HistoryCard({ cr, studentId }: { cr: ChangeRequest; studentId: string }) {
  const router = useRouter();
  const resolved = Boolean(cr.resolvedAt);
  const badge = resolved
    ? 'resolved'
    : cr.status;
  return (
    <div className="rounded-lg border border-border bg-card p-3 text-sm">
      <div className="flex items-center justify-between">
        <span className="font-medium">{cr.proposedChange}</span>
        <span className="rounded bg-muted px-2 py-0.5 text-xs">{badge}</span>
      </div>
      <p className="mt-1 text-muted-foreground">{cr.reason}</p>
      {cr.kind === 'task_change' && <TaskChangeBlock cr={cr} />}
      {cr.counsellorNotes && (
        <p className="mt-1 text-xs italic text-muted-foreground">&ldquo;{cr.counsellorNotes}&rdquo;</p>
      )}
      <div className="mt-1 flex items-center justify-between">
        <p className="text-xs text-muted-foreground">decided {formatRelative(cr.decidedAt)}</p>
        {cr.linkedConversationId && (
          <button
            className="text-xs text-primary underline"
            onClick={() =>
              router.push(`/students/${studentId}/timetable?conv=${cr.linkedConversationId}`)
            }
          >
            View conversation →
          </button>
        )}
      </div>
    </div>
  );
}

function formatDateTime(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleString('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  });
}

function formatTimeOnly(iso: string): string {
  return new Date(iso).toLocaleString('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  });
}
