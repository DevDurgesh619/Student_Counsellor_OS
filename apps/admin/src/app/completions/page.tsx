'use client';

import { useList } from '@refinedev/core';

type CompletionRow = {
  id: string;
  task_id: string;
  submitted_at: string;
  status_claimed: string;
  status_verified: string;
  notes_text: string | null;
};

export default function CompletionsListPage() {
  const { data, isLoading } = useList<CompletionRow>({
    resource: 'completions',
    sorters: [{ field: 'submitted_at', order: 'desc' }],
    pagination: { pageSize: 50 },
  });

  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-semibold">Completions</h1>
      <p className="text-sm text-muted-foreground">
        Latest by submitted_at is authoritative. Multiple completions per task are allowed.
      </p>
      {isLoading && <p className="text-sm text-muted-foreground">Loading…</p>}
      <table className="w-full text-sm">
        <thead className="border-b border-border text-left text-xs uppercase text-muted-foreground">
          <tr>
            <th className="py-2 pr-4">When</th>
            <th className="py-2 pr-4">Task</th>
            <th className="py-2 pr-4">Claimed</th>
            <th className="py-2 pr-4">Verified</th>
            <th className="py-2 pr-4">Notes</th>
          </tr>
        </thead>
        <tbody>
          {data?.data.map((c) => (
            <tr key={c.id} className="border-b border-border">
              <td className="py-2 pr-4">{new Date(c.submitted_at).toLocaleString()}</td>
              <td className="py-2 pr-4 font-mono text-xs text-muted-foreground">
                {c.task_id.slice(0, 8)}…
              </td>
              <td className="py-2 pr-4">{c.status_claimed}</td>
              <td className="py-2 pr-4">{c.status_verified}</td>
              <td className="py-2 pr-4 text-muted-foreground">{c.notes_text ?? '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
