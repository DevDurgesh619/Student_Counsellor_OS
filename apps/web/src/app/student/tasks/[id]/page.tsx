'use client';

import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ChevronLeft } from 'lucide-react';
import { studentApi } from '@/lib/api';
import { ArtifactUploader } from '@/components/artifact-uploader';

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
          {start.toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })} –{' '}
          {end.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}
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
                  {new Date(a.uploadedAt).toLocaleString()}
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
                    {new Date(c.submittedAt).toLocaleString()}
                  </span>
                </div>
                {c.notesText && <p className="mt-1 text-muted-foreground">{c.notesText}</p>}
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="border-t border-border pt-4">
        {!showChange ? (
          <button
            onClick={() => setShowChange(true)}
            className="text-sm text-primary underline"
          >
            Request change
          </button>
        ) : (
          <ChangeRequestForm
            taskId={id}
            taskTitle={task.taskTitle}
            onClose={() => setShowChange(false)}
          />
        )}
      </section>
    </div>
  );
}

function ChangeRequestForm({
  taskId,
  taskTitle,
  onClose,
}: {
  taskId: string;
  taskTitle: string;
  onClose: () => void;
}) {
  const [proposedChange, setProposedChange] = useState('');
  const [reason, setReason] = useState('');
  const m = useMutation({
    mutationFn: () =>
      studentApi.submitChangeRequest({
        originalTaskId: taskId,
        proposedChange,
        reason,
      }),
    onSuccess: onClose,
  });
  return (
    <div className="space-y-3 rounded-lg border border-border bg-card p-4">
      <h3 className="font-medium">Request change for "{taskTitle}"</h3>
      <input
        value={proposedChange}
        onChange={(e) => setProposedChange(e.target.value)}
        placeholder="What change? (e.g., move to evening)"
        className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
      />
      <textarea
        value={reason}
        onChange={(e) => setReason(e.target.value)}
        placeholder="Why?"
        rows={3}
        className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
      />
      <div className="flex gap-2">
        <button
          disabled={!proposedChange || !reason || m.isPending}
          onClick={() => m.mutate()}
          className="flex-1 rounded-md bg-primary py-2 text-sm text-primary-foreground hover:opacity-90 disabled:opacity-60"
        >
          {m.isPending ? 'Sending…' : 'Send to counsellor'}
        </button>
        <button onClick={onClose} className="rounded-md border border-input px-4 py-2 text-sm">
          Cancel
        </button>
      </div>
      {m.error && <p className="text-sm text-destructive">{(m.error as Error).message}</p>}
    </div>
  );
}
