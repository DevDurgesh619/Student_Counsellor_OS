'use client';

import { useParams } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import { File, Image as ImageIcon, Mic } from 'lucide-react';
import { counsellorApi } from '@/lib/api';
import { formatRelative } from '@/lib/utils';

type Artifact = {
  id: string;
  taskId: string | null;
  uploadedAt: string;
  fileType: string;
  fileSizeBytes: number | null;
  originalFilename: string | null;
  transcriptionText: string | null;
  tags: string[] | null;
};

export default function ArtifactsPage() {
  const params = useParams<{ id: string }>();
  const { data, isLoading } = useQuery({
    queryKey: ['artifacts', params.id],
    queryFn: () =>
      counsellorApi.studentArtifacts(params.id) as Promise<{ data: Artifact[] }>,
  });
  const artifacts = data?.data ?? [];

  return (
    <div className="space-y-3">
      <h2 className="text-lg font-medium">Artifacts</h2>
      {isLoading && <p className="text-sm text-muted-foreground">Loading…</p>}
      {!isLoading && artifacts.length === 0 && (
        <p className="rounded-lg border border-dashed border-border p-6 text-center text-sm text-muted-foreground">
          No artifacts uploaded yet.
        </p>
      )}
      <div className="grid gap-3 sm:grid-cols-2 md:grid-cols-3">
        {artifacts.map((a) => (
          <div key={a.id} className="rounded-lg border border-border bg-card p-3">
            <div className="flex items-center gap-2">
              <ArtifactIcon type={a.fileType} />
              <div className="min-w-0">
                <div className="truncate text-sm font-medium">
                  {a.originalFilename ?? a.id.slice(0, 8)}
                </div>
                <div className="text-xs text-muted-foreground">
                  {formatRelative(a.uploadedAt)} ·{' '}
                  {a.fileSizeBytes ? `${(a.fileSizeBytes / 1024).toFixed(0)} KB` : '—'}
                </div>
              </div>
            </div>
            {a.transcriptionText && (
              <p className="mt-2 line-clamp-3 text-xs text-muted-foreground">
                "{a.transcriptionText}"
              </p>
            )}
            {a.taskId && (
              <p className="mt-2 font-mono text-xs text-muted-foreground">
                task: {a.taskId.slice(0, 8)}…
              </p>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

function ArtifactIcon({ type }: { type: string }) {
  if (type.startsWith('image/')) return <ImageIcon className="h-5 w-5 text-muted-foreground" />;
  if (type.startsWith('audio/')) return <Mic className="h-5 w-5 text-muted-foreground" />;
  return <File className="h-5 w-5 text-muted-foreground" />;
}
