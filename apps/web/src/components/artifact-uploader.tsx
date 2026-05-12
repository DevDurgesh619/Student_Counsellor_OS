'use client';

import { useRef, useState } from 'react';
import { studentApi } from '@/lib/api';

export function ArtifactUploader({
  taskId,
  maxBytes,
  onUploaded,
}: {
  taskId?: string;
  maxBytes: number;
  onUploaded?: () => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function handle(file: File) {
    setError(null);
    if (file.size > maxBytes) {
      setError(`Files must be under ${Math.floor(maxBytes / 1024 / 1024)} MB.`);
      return;
    }
    setBusy(true);
    setProgress(0);
    try {
      const sign = await studentApi.getUploadUrl({
        filename: file.name,
        contentType: file.type || 'application/octet-stream',
        sizeBytes: file.size,
      });

      // Upload to Supabase Storage signed URL via PUT.
      await new Promise<void>((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.open('PUT', sign.uploadUrl, true);
        xhr.setRequestHeader('Content-Type', file.type || 'application/octet-stream');
        xhr.upload.onprogress = (ev) => {
          if (ev.lengthComputable) setProgress(Math.round((ev.loaded / ev.total) * 100));
        };
        xhr.onload = () =>
          xhr.status >= 200 && xhr.status < 300
            ? resolve()
            : reject(new Error(`Upload failed: ${xhr.status}`));
        xhr.onerror = () => reject(new Error('Network error during upload'));
        xhr.send(file);
      });

      await studentApi.confirmArtifact({
        taskId,
        fileUrl: sign.storagePath,
        fileType: file.type || 'application/octet-stream',
        fileSizeBytes: file.size,
        originalFilename: file.name,
      });
      onUploaded?.();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
      if (inputRef.current) inputRef.current.value = '';
    }
  }

  return (
    <div className="space-y-2">
      <input
        ref={inputRef}
        type="file"
        accept="image/*,application/pdf,audio/*,video/*"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) handle(f);
        }}
        className="block w-full text-sm file:mr-3 file:rounded-md file:border-0 file:bg-primary file:px-3 file:py-2 file:text-sm file:text-primary-foreground hover:file:opacity-90"
      />
      {busy && (
        <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
          <div className="h-full bg-primary transition-all" style={{ width: `${progress}%` }} />
        </div>
      )}
      {error && <p className="text-xs text-destructive">{error}</p>}
    </div>
  );
}
