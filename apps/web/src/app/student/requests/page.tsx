'use client';

import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { format } from 'date-fns';
import { studentApi } from '@/lib/api';

export default function RequestsPage() {
  const qc = useQueryClient();
  const { data, isLoading } = useQuery({
    queryKey: ['my-change-requests'],
    queryFn: studentApi.changeRequests,
  });
  const requests = data?.data ?? [];

  const [proposedChange, setProposedChange] = useState('');
  const [reason, setReason] = useState('');
  const [pattern, setPattern] = useState('');
  const [justSent, setJustSent] = useState(false);
  const m = useMutation({
    mutationFn: () =>
      studentApi.submitChangeRequest({
        proposedChange,
        reason,
        patternDescription: pattern || undefined,
      }),
    onSuccess: async () => {
      setProposedChange('');
      setReason('');
      setPattern('');
      setJustSent(true);
      await qc.invalidateQueries({ queryKey: ['my-change-requests'] });
    },
  });
  useEffect(() => {
    if (!justSent) return;
    const t = setTimeout(() => setJustSent(false), 3000);
    return () => clearTimeout(t);
  }, [justSent]);

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-semibold">My requests</h1>
        <p className="text-sm text-muted-foreground">
          General requests — for anything not tied to a specific task. To change a specific task,
          click it on your week.
        </p>
      </header>

      <section className="space-y-3 rounded-lg border border-border bg-card p-4">
        <h2 className="font-medium">New request</h2>
        <input
          value={pattern}
          onChange={(e) => setPattern(e.target.value)}
          placeholder="Pattern (e.g., 'Math sessions') — optional"
          className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
        />
        <input
          value={proposedChange}
          onChange={(e) => setProposedChange(e.target.value)}
          placeholder="What change?"
          className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
        />
        <textarea
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder="Why?"
          rows={3}
          className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
        />
        <button
          disabled={!proposedChange || !reason || m.isPending}
          onClick={() => m.mutate()}
          className="w-full rounded-md bg-primary py-2 text-sm text-primary-foreground hover:opacity-90 disabled:opacity-60"
        >
          {m.isPending ? 'Sending…' : 'Send request'}
        </button>
        {m.error && <p className="text-xs text-destructive">{(m.error as Error).message}</p>}
        {justSent && <p className="text-xs text-success">Sent — your counsellor will see this.</p>}
      </section>

      <section className="space-y-2">
        <h2 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">History</h2>
        {isLoading && <p className="text-sm text-muted-foreground">Loading…</p>}
        {!isLoading && requests.length === 0 && (
          <p className="text-sm text-muted-foreground">No requests yet.</p>
        )}
        <ul className="space-y-2">
          {requests.map((r) => (
            <li key={r.id} className="rounded-lg border border-border bg-card p-3 text-sm">
              <div className="flex items-start justify-between gap-2">
                <div>
                  <div className="font-medium">{r.proposedChange}</div>
                  <div className="text-xs text-muted-foreground">{r.reason}</div>
                </div>
                <StatusBadge status={r.status} />
              </div>
              <div className="mt-2 text-[11px] text-muted-foreground">
                {format(new Date(r.requestedAt), 'MMM d, h:mm a')}
                {r.decidedAt && ` · decided ${format(new Date(r.decidedAt), 'MMM d')}`}
              </div>
              {r.counsellorNotes && (
                <p className="mt-2 rounded-md bg-muted p-2 text-xs">{r.counsellorNotes}</p>
              )}
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}

function StatusBadge({ status }: { status: string }) {
  const tone =
    status === 'approved'
      ? 'bg-success text-success-foreground'
      : status === 'rejected'
        ? 'bg-destructive text-destructive-foreground'
        : 'bg-muted text-muted-foreground';
  return (
    <span className={`rounded-full px-2 py-0.5 text-[10px] uppercase ${tone}`}>{status}</span>
  );
}
