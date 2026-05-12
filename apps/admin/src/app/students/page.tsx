'use client';

import Link from 'next/link';
import { useList } from '@refinedev/core';

type StudentRow = {
  id: string;
  full_name: string;
  current_grade: string;
  school: string | null;
  status: string;
  counsellor_id: string | null;
  created_at: string;
};

export default function StudentsListPage() {
  const { data, isLoading, error } = useList<StudentRow>({
    resource: 'students',
    sorters: [{ field: 'created_at', order: 'desc' }],
    pagination: { pageSize: 50 },
  });

  return (
    <div className="space-y-4">
      <header className="flex items-baseline justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Students</h1>
          <p className="text-sm text-muted-foreground">
            All students. Soft-delete via status = &apos;archived&apos;.
          </p>
        </div>
        <Link
          href="/students/create"
          className="rounded-md bg-primary px-4 py-2 text-sm text-primary-foreground hover:opacity-90"
        >
          + New student
        </Link>
      </header>

      {isLoading && <p className="text-sm text-muted-foreground">Loading…</p>}
      {error && <p className="text-sm text-destructive">Failed to load: {error.message}</p>}

      <table className="w-full text-sm">
        <thead className="border-b border-border text-left text-xs uppercase text-muted-foreground">
          <tr>
            <th className="py-2 pr-4">Name</th>
            <th className="py-2 pr-4">Grade</th>
            <th className="py-2 pr-4">School</th>
            <th className="py-2 pr-4">Status</th>
            <th className="py-2 pr-4">Created</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {data?.data.map((s) => (
            <tr key={s.id} className="border-b border-border">
              <td className="py-2 pr-4 font-medium">{s.full_name}</td>
              <td className="py-2 pr-4">{s.current_grade}</td>
              <td className="py-2 pr-4 text-muted-foreground">{s.school ?? '—'}</td>
              <td className="py-2 pr-4">
                <span className="rounded bg-muted px-2 py-0.5 text-xs">{s.status}</span>
              </td>
              <td className="py-2 pr-4 text-muted-foreground">
                {new Date(s.created_at).toLocaleDateString()}
              </td>
              <td className="py-2 text-right">
                <Link
                  href={`/students/edit/${s.id}`}
                  className="text-sm underline hover:no-underline"
                >
                  Edit
                </Link>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
