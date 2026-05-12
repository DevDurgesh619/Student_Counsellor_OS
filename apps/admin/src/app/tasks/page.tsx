'use client';

import Link from 'next/link';
import { useList } from '@refinedev/core';
import { useState } from 'react';

type StudentRow = { id: string; full_name: string };
type TaskRow = {
  id: string;
  student_id: string;
  scheduled_start: string;
  scheduled_end: string;
  subject: string;
  task_title: string;
  status: string;
};

export default function TasksListPage() {
  const [studentId, setStudentId] = useState<string>('');

  const { data: studentsResp } = useList<StudentRow>({
    resource: 'students',
    pagination: { pageSize: 100 },
  });

  const { data: tasksResp, isLoading } = useList<TaskRow>({
    resource: 'tasks',
    sorters: [{ field: 'scheduled_start', order: 'asc' }],
    pagination: { pageSize: 200 },
    filters: studentId ? [{ field: 'student_id', operator: 'eq', value: studentId }] : [],
    queryOptions: { enabled: Boolean(studentId) },
  });

  return (
    <div className="space-y-4">
      <header className="flex items-baseline justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Tasks</h1>
          <p className="text-sm text-muted-foreground">
            Manual timetable management. Worker 4 (Phase 6) takes over from session 1 onward.
          </p>
        </div>
        <Link
          href={studentId ? `/tasks/create?studentId=${studentId}` : '/tasks/create'}
          className="rounded-md bg-primary px-4 py-2 text-sm text-primary-foreground hover:opacity-90"
        >
          + New task
        </Link>
      </header>

      <div className="rounded-md border border-border bg-muted/30 p-3">
        <label className="block text-xs uppercase tracking-wide text-muted-foreground">
          Student
        </label>
        <select
          value={studentId}
          onChange={(e) => setStudentId(e.target.value)}
          className="mt-1 w-full max-w-xs rounded-md border border-input bg-background px-3 py-2 text-sm"
        >
          <option value="">— select a student —</option>
          {studentsResp?.data.map((s) => (
            <option key={s.id} value={s.id}>
              {s.full_name}
            </option>
          ))}
        </select>
      </div>

      {!studentId && (
        <p className="text-sm text-muted-foreground">Pick a student to view their tasks.</p>
      )}
      {isLoading && <p className="text-sm text-muted-foreground">Loading…</p>}

      {studentId && tasksResp && (
        <table className="w-full text-sm">
          <thead className="border-b border-border text-left text-xs uppercase text-muted-foreground">
            <tr>
              <th className="py-2 pr-4">When</th>
              <th className="py-2 pr-4">Subject</th>
              <th className="py-2 pr-4">Title</th>
              <th className="py-2 pr-4">Status</th>
            </tr>
          </thead>
          <tbody>
            {tasksResp.data.map((t) => (
              <tr key={t.id} className="border-b border-border">
                <td className="py-2 pr-4">{new Date(t.scheduled_start).toLocaleString()}</td>
                <td className="py-2 pr-4">{t.subject}</td>
                <td className="py-2 pr-4 font-medium">{t.task_title}</td>
                <td className="py-2 pr-4">
                  <span className="rounded bg-muted px-2 py-0.5 text-xs">{t.status}</span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
