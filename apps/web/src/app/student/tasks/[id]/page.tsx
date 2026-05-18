'use client';

import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ChevronLeft } from 'lucide-react';
import { format } from 'date-fns';
import { studentApi } from '@/lib/api';
import { ArtifactUploader } from '@/components/artifact-uploader';
import { RequestTaskChangeDialog } from '@/components/student/request-task-change-dialog';

type Claim = 'done' | 'partial' | 'skipped' | 'couldnt_do';

const MAX_BYTES = 50 * 1024 * 1024;

export default function TaskDetailPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const qc = useQueryClient();

  const { data, isLoading, error } = useQuery({
    queryKey: ['my-task', id],
    queryFn: () => studentApi.task(id),
  });

  const [claim, setClaim] = useState<Claim | null>(null);
  const [notes, setNotes] = useState('');
  const [minutes, setMinutes] = useState<string>('');
  const [showChange, setShowChange] = useState(false);

  const submit = useMutation({
    mutationFn: () =>
      studentApi.submitCompletion(id, {
        statusClaimed: claim!,
        notesText: notes || undefined,
        timeTakenMinutes: minutes ? parseInt(minutes, 10) : undefined,
      }),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ['my-task', id] });
      await qc.invalidateQueries({ queryKey: ['my-tasks'] });
      router.push('/student/today');
    },
  });

  if (isLoading) return <p className="text-sm text-muted-foreground">Loading…</p>;
  if (error) return <p className="text-sm text-destructive">Failed: {(error as Error).message}</p>;
  if (!data) return null;

  const { task, completions, artifacts } = data;
  const start = new Date(task.scheduledStart);
  const end = new Date(task.scheduledEnd);

  return (
    <div className="space-y-6">
      <Link href="/student/today" className="inline-flex items-center gap-1 text-sm text-muted-foreground">
        <ChevronLeft className="h-4 w-4" /> Back
      </Link>

      <header>
        <div className="text-xs uppercase tracking-wide text-muted-foreground">{task.subject}</div>
        <h1 className="text-2xl font-semibold">{task.taskTitle}</h1>
        <p className="text-sm text-muted-foreground">
          {format(start, 'MMM d, h:mm a')} – {format(end, 'h:mm a')}
        </p>
      </header>

      {task.taskDescription && (
        <section className="rounded-lg border border-border bg-card p-4">
          <h2 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Details</h2>
          <p className="mt-1 text-sm whitespace-pre-wrap">{task.taskDescription}</p>
        </section>
      )}

      {task.expectedOutput && (
        <section className="rounded-lg border border-border bg-card p-4">
          <h2 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Expected output</h2>
          <p className="mt-1 text-sm">{task.expectedOutput}</p>
        </section>
      )}

      <section className="space-y-3">
        <h2 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Mark status</h2>
        <div className="grid grid-cols-2 gap-2">
          {(['done', 'partial', 'skipped', 'couldnt_do'] as Claim[]).map((opt) => (
            <button
              key={opt}
              onClick={() => setClaim(opt)}
              className={`rounded-lg border p-3 text-sm capitalize transition-colors ${
                claim === opt
                  ? 'border-primary bg-primary text-primary-foreground'
                  : 'border-border hover:bg-muted'
              }`}
            >
              {opt.replace('_', ' ')}
            </button>
          ))}
        </div>
        <textarea
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          placeholder="Anything to flag? (optional)"
          rows={2}
          className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
        />
        <input
          value={minutes}
          onChange={(e) => setMinutes(e.target.value.replace(/[^0-9]/g, ''))}
          placeholder="Time taken (minutes, optional)"
          inputMode="numeric"
          className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
        />
        <button
          disabled={!claim || submit.isPending}
          onClick={() => submit.mutate()}
          className="w-full rounded-md bg-primary py-3 text-sm font-medium text-primary-foreground hover:opacity-90 disabled:opacity-60"
        >
          {submit.isPending ? 'Submitting…' : 'Submit status'}
        </button>
        {submit.error && (
          <p className="text-sm text-destructive">{(submit.error as Error).message}</p>
        )}
      </section>

      <section className="space-y-3">
        <h2 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          Upload artifact
        </h2>
        <ArtifactUploader
          taskId={id}
          maxBytes={MAX_BYTES}
          onUploaded={() => qc.invalidateQueries({ queryKey: ['my-task', id] })}
        />
        {artifacts.length > 0 && (
          <ul className="mt-2 space-y-1">
            {artifacts.map((a) => (
              <li key={a.id} className="rounded-md border border-border bg-card px-3 py-2 text-xs">
                <div className="font-mono">{a.originalFilename ?? a.fileType}</div>
                <div className="text-muted-foreground">
                  {format(new Date(a.uploadedAt), 'MMM d, h:mm a')}
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      {completions.length > 0 && (
        <section className="space-y-2">
          <h2 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Submission history
          </h2>
          <ul className="space-y-1">
            {completions.map((c) => (
              <li key={c.id} className="rounded-md border border-border bg-card px-3 py-2 text-xs">
                <div className="flex justify-between">
                  <span className="font-medium capitalize">{c.statusClaimed.replace('_', ' ')}</span>
                  <span className="text-muted-foreground">
                    {format(new Date(c.submittedAt), 'MMM d, h:mm a')}
                  </span>
                </div>
                {c.notesText && <p className="mt-1 text-muted-foreground">{c.notesText}</p>}
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="border-t border-border pt-4">
        <button
          onClick={() => setShowChange(true)}
          className="text-sm text-primary underline"
        >
          Request change
        </button>
      </section>

      <RequestTaskChangeDialog
        task={showChange ? task : null}
        onClose={() => setShowChange(false)}
        initialMode="request"
      />
    </div>
  );
}
