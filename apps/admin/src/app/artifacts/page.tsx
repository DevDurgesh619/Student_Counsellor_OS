'use client';

import { useList } from '@refinedev/core';

type ArtifactRow = {
  id: string;
  student_id: string;
  task_id: string | null;
  uploaded_at: string;
  file_url: string;
  file_type: string;
  file_size_bytes: number | null;
  original_filename: string | null;
};

export default function ArtifactsListPage() {
  const { data, isLoading } = useList<ArtifactRow>({
    resource: 'artifacts',
    sorters: [{ field: 'uploaded_at', order: 'desc' }],
    pagination: { pageSize: 50 },
  });

  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-semibold">Artifacts</h1>
      <p className="text-sm text-muted-foreground">
        Stored at <code>students/&lt;id&gt;/artifacts/&lt;uuid&gt;/&lt;file&gt;</code> in
        Supabase Storage. Use the API for signed download URLs.
      </p>
      {isLoading && <p className="text-sm text-muted-foreground">Loading…</p>}
      <table className="w-full text-sm">
        <thead className="border-b border-border text-left text-xs uppercase text-muted-foreground">
          <tr>
            <th className="py-2 pr-4">Uploaded</th>
            <th className="py-2 pr-4">Filename</th>
            <th className="py-2 pr-4">Type</th>
            <th className="py-2 pr-4">Size</th>
            <th className="py-2 pr-4">Task</th>
          </tr>
        </thead>
        <tbody>
          {data?.data.map((a) => (
            <tr key={a.id} className="border-b border-border">
              <td className="py-2 pr-4">{new Date(a.uploaded_at).toLocaleString()}</td>
              <td className="py-2 pr-4">{a.original_filename ?? a.file_url}</td>
              <td className="py-2 pr-4 text-muted-foreground">{a.file_type}</td>
              <td className="py-2 pr-4 text-muted-foreground">
                {a.file_size_bytes ? `${(a.file_size_bytes / 1024).toFixed(0)} KB` : '—'}
              </td>
              <td className="py-2 pr-4 font-mono text-xs text-muted-foreground">
                {a.task_id ? `${a.task_id.slice(0, 8)}…` : '—'}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
