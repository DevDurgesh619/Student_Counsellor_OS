'use client';

import { useList } from '@refinedev/core';

type CounsellorRow = {
  id: string;
  full_name: string;
  email: string;
  status: string;
  timezone: string;
  created_at: string;
};

export default function CounsellorsListPage() {
  const { data, isLoading } = useList<CounsellorRow>({
    resource: 'counsellors',
    sorters: [{ field: 'created_at', order: 'desc' }],
  });

  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-semibold">Counsellors</h1>
      {isLoading && <p className="text-sm text-muted-foreground">Loading…</p>}
      <table className="w-full text-sm">
        <thead className="border-b border-border text-left text-xs uppercase text-muted-foreground">
          <tr>
            <th className="py-2 pr-4">Name</th>
            <th className="py-2 pr-4">Email</th>
            <th className="py-2 pr-4">Timezone</th>
            <th className="py-2 pr-4">Status</th>
          </tr>
        </thead>
        <tbody>
          {data?.data.map((c) => (
            <tr key={c.id} className="border-b border-border">
              <td className="py-2 pr-4 font-medium">{c.full_name}</td>
              <td className="py-2 pr-4">{c.email}</td>
              <td className="py-2 pr-4 text-muted-foreground">{c.timezone}</td>
              <td className="py-2 pr-4">
                <span className="rounded bg-muted px-2 py-0.5 text-xs">{c.status}</span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="text-xs text-muted-foreground">
        Counsellor creation is admin-only; contact engineering to bootstrap a new account
        until Phase 9 ships proper admin role handling.
      </p>
    </div>
  );
}
