'use client';

import { useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { counsellorApi, type MeetingPrepBriefRow, type SessionRow } from '@/lib/api';

export default function BriefPage() {
  const params = useParams<{ id: string }>();
  const id = params.id;
  const qc = useQueryClient();
  const [draft, setDraft] = useState('');
  const [touched, setTouched] = useState(false);

  const { data, isLoading } = useQuery({
    queryKey: ['upcoming-brief', id],
    queryFn: () =>
      counsellorApi.upcomingBrief(id) as Promise<{
        data: MeetingPrepBriefRow | null;
        session?: SessionRow;
      }>,
    enabled: Boolean(id),
  });

  const brief = data?.data ?? null;
  const session = data?.session ?? null;

  // Seed editor with the most current text whenever the underlying brief
  // changes — but don't clobber unsaved local edits.
  const remoteText =
    brief?.finalContent ?? brief?.passBContent ?? brief?.passAContent ?? '';
  useEffect(() => {
    if (!touched) setDraft(remoteText);
  }, [remoteText, touched]);

  const save = useMutation({
    mutationFn: (markReviewed: boolean) =>
      brief
        ? counsellorApi.patchBrief(brief.id, { finalContent: draft, markReviewed })
        : Promise.reject(new Error('no brief to save')),
    onSuccess: () => {
      setTouched(false);
      qc.invalidateQueries({ queryKey: ['upcoming-brief', id] });
      qc.invalidateQueries({ queryKey: ['queue'] });
    },
  });

  if (isLoading) return <p className="text-sm text-muted-foreground">Loading brief…</p>;
  if (!brief) {
    return (
      <p className="rounded-lg border border-dashed border-border p-6 text-center text-sm text-muted-foreground">
        No prep brief yet. One is generated automatically after each session
        and refreshed 24h before the next.
      </p>
    );
  }

  return (
    <div className="space-y-4">
      <header className="space-y-1">
        <h2 className="text-lg font-medium">Pre-session brief</h2>
        <p className="text-xs text-muted-foreground">
          Status: <span className="font-medium">{brief.status.replace('_', ' ')}</span>
          {session && (
            <>
              {' · '}For session{' '}
              {new Date(session.scheduledAt).toLocaleString(undefined, {
                weekday: 'short',
                month: 'short',
                day: 'numeric',
                hour: 'numeric',
                minute: '2-digit',
              })}
            </>
          )}
          {brief.passBGeneratedAt && (
            <> · Pass B generated {new Date(brief.passBGeneratedAt).toLocaleString()}</>
          )}
        </p>
      </header>

      <textarea
        value={draft}
        onChange={(e) => {
          setDraft(e.target.value);
          setTouched(true);
        }}
        rows={28}
        className="w-full rounded-md border border-border bg-card p-3 font-mono text-sm leading-relaxed"
      />

      <div className="flex items-center justify-end gap-2">
        <button
          disabled={!touched || save.isPending}
          onClick={() => save.mutate(false)}
          className="rounded-md border border-border px-3 py-1.5 text-sm hover:bg-muted disabled:opacity-50"
        >
          Save draft
        </button>
        <button
          disabled={save.isPending}
          onClick={() => save.mutate(true)}
          className="rounded-md bg-primary px-3 py-1.5 text-sm text-primary-foreground hover:opacity-90 disabled:opacity-50"
        >
          Mark reviewed
        </button>
      </div>
    </div>
  );
}
