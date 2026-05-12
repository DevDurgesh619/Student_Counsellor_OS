'use client';

import { useState } from 'react';
import { useParams } from 'next/navigation';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { counsellorApi } from '@/lib/api';
import { formatRelative } from '@/lib/utils';

type ChangeRequest = {
  id: string;
  requestedAt: string;
  proposedChange: string;
  reason: string;
  status: 'pending' | 'approved' | 'rejected' | 'expired';
  counsellorNotes: string | null;
  decidedAt: string | null;
};

export default function RequestsPage() {
  const params = useParams<{ id: string }>();
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
          <PendingCard key={cr.id} cr={cr} onDecide={(d, notes) => decide.mutate({ id: cr.id, decision: d, counsellorNotes: notes })} />
        ))}
      </section>

      <section className="space-y-3">
        <h2 className="text-lg font-medium">History</h2>
        {(history?.data ?? []).map((cr) => (
          <div key={cr.id} className="rounded-lg border border-border bg-card p-3 text-sm">
            <div className="flex items-center justify-between">
              <span className="font-medium">{cr.proposedChange}</span>
              <span className="rounded bg-muted px-2 py-0.5 text-xs">{cr.status}</span>
            </div>
            <p className="mt-1 text-muted-foreground">{cr.reason}</p>
            {cr.counsellorNotes && (
              <p className="mt-1 text-xs italic text-muted-foreground">"{cr.counsellorNotes}"</p>
            )}
            <p className="mt-1 text-xs text-muted-foreground">
              decided {formatRelative(cr.decidedAt)}
            </p>
          </div>
        ))}
      </section>
    </div>
  );
}

function PendingCard({
  cr,
  onDecide,
}: {
  cr: ChangeRequest;
  onDecide: (decision: 'approved' | 'rejected', notes?: string) => void;
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
      <textarea
        value={notes}
        onChange={(e) => setNotes(e.target.value)}
        placeholder="Optional note (required to reject)"
        rows={2}
        className="w-full rounded-md border border-input bg-background px-2 py-1.5 text-sm"
      />
      <div className="flex justify-end gap-2">
        <button
          onClick={() => onDecide('rejected', notes)}
          disabled={!notes.trim()}
          className="rounded-md border border-destructive px-3 py-1.5 text-sm text-destructive hover:bg-destructive hover:text-destructive-foreground disabled:opacity-50"
        >
          Reject
        </button>
        <button
          onClick={() => onDecide('approved', notes || undefined)}
          className="rounded-md bg-primary px-3 py-1.5 text-sm text-primary-foreground hover:opacity-90"
        >
          Approve
        </button>
      </div>
    </div>
  );
}
