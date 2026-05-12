'use client';

import { useList } from '@refinedev/core';

type QueueRow = {
  id: string;
  type: string;
  status: string;
  priority: number;
  created_at: string;
  resolved_at: string | null;
  resolved_by: string | null;
  resolution_notes: string | null;
};

export default function ReviewQueuePage() {
  const { data, isLoading } = useList<QueueRow>({
    resource: 'review_queue',
    sorters: [
      { field: 'status', order: 'asc' },
      { field: 'priority', order: 'asc' },
      { field: 'created_at', order: 'desc' },
    ],
    pagination: { pageSize: 100 },
  });

  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-semibold">Review queue</h1>
      <p className="text-sm text-muted-foreground">
        Layer 1 — kept indefinitely (clarifications.md Q5). Active queue =
        status IN (pending, in_review). Resolved/dismissed rows are part of the
        permanent decision record and are never hard-deleted.
      </p>
      {isLoading && <p className="text-sm text-muted-foreground">Loading…</p>}
      <table className="w-full text-sm">
        <thead className="border-b border-border text-left text-xs uppercase text-muted-foreground">
          <tr>
            <th className="py-2 pr-4">Type</th>
            <th className="py-2 pr-4">Status</th>
            <th className="py-2 pr-4">Priority</th>
            <th className="py-2 pr-4">Created</th>
            <th className="py-2 pr-4">Resolved</th>
          </tr>
        </thead>
        <tbody>
          {data?.data.map((r) => (
            <tr key={r.id} className="border-b border-border">
              <td className="py-2 pr-4">{r.type}</td>
              <td className="py-2 pr-4">
                <span className="rounded bg-muted px-2 py-0.5 text-xs">{r.status}</span>
              </td>
              <td className="py-2 pr-4">{r.priority}</td>
              <td className="py-2 pr-4 text-muted-foreground">
                {new Date(r.created_at).toLocaleString()}
              </td>
              <td className="py-2 pr-4 text-muted-foreground">
                {r.resolved_at ? new Date(r.resolved_at).toLocaleString() : '—'}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
