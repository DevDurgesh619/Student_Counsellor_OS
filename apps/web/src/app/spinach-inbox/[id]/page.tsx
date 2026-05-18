'use client';

import { useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { useMutation, useQuery } from '@tanstack/react-query';
import { counsellorApi, type StudentOverview } from '@/lib/api';

export default function SpinachInboxDetailPage() {
  const params = useParams<{ id: string }>();
  const id = params.id;
  const router = useRouter();

  const { data: inboxData, isLoading } = useQuery({
    queryKey: ['spinach-inbox', id],
    queryFn: () => counsellorApi.spinachInboxOne(id),
    enabled: Boolean(id),
  });
  const { data: studentsData } = useQuery({
    queryKey: ['students-overview'],
    queryFn: () => counsellorApi.studentsOverview() as Promise<{ data: StudentOverview[] }>,
  });

  const [studentId, setStudentId] = useState<string>('');

  const assign = useMutation({
    mutationFn: (sid: string) => counsellorApi.assignSpinachMeeting(id, sid),
    onSuccess: (res) => {
      const sid = res?.data?.sessionId;
      if (sid) router.replace(`/sessions/${sid}`);
      else router.replace('/queue');
    },
  });

  const ignore = useMutation({
    mutationFn: () => counsellorApi.ignoreSpinachMeeting(id),
    onSuccess: () => router.replace('/queue'),
  });

  if (isLoading) return <p className="text-sm text-muted-foreground">Loading…</p>;
  const inbox = inboxData?.data;
  if (!inbox) return <p className="text-sm text-destructive">Not found.</p>;

  const transcriptPreview = pickStringFromRaw(inbox.raw, [
    'transcript',
    'transcript_text',
    'full_transcript',
  ])?.slice(0, 800);
  const summaryPreview = pickStringFromRaw(inbox.raw, ['summary', 'summary_text', 'ai_summary']);

  return (
    <div className="space-y-4">
      <header className="space-y-1">
        <h1 className="text-2xl font-semibold">Unassigned meeting</h1>
        <p className="text-sm text-muted-foreground">
          From Spinach · fetched {new Date(inbox.fetchedAt).toLocaleString()}
        </p>
      </header>

      <section className="space-y-2 rounded-lg border border-border bg-card p-4 text-sm">
        <h2 className="font-medium">{inbox.title ?? '(no title)'}</h2>
        {inbox.scheduledAt && (
          <p className="text-xs text-muted-foreground">
            Scheduled {new Date(inbox.scheduledAt).toLocaleString()}
          </p>
        )}
        {inbox.attendees.length > 0 ? (
          <ul className="text-xs">
            {inbox.attendees.map((a, i) => (
              <li key={i}>
                {a.name ?? '(no name)'} {a.email ? <span className="text-muted-foreground">— {a.email}</span> : null}
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-xs italic text-muted-foreground">No attendee info.</p>
        )}
      </section>

      {summaryPreview && (
        <section className="rounded-lg border border-border bg-card p-4 text-sm">
          <h3 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Summary
          </h3>
          <p className="mt-1 whitespace-pre-wrap">{summaryPreview}</p>
        </section>
      )}

      {transcriptPreview && (
        <section className="rounded-lg border border-border bg-card p-4 text-sm">
          <h3 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Transcript (first 800 chars)
          </h3>
          <p className="mt-1 whitespace-pre-wrap font-mono text-xs">{transcriptPreview}…</p>
        </section>
      )}

      {(inbox.suggestions?.length ?? 0) > 0 && (
        <section className="space-y-2 rounded-lg border border-border bg-card p-4">
          <h3 className="text-sm font-medium">Suggested student</h3>
          <p className="text-xs text-muted-foreground">
            Based on attendee emails + meeting title. Click to assign immediately.
          </p>
          <ul className="space-y-1.5">
            {inbox.suggestions!.map((s) => {
              const tone =
                s.confidence === 'high'
                  ? 'border-success/50 bg-success/5'
                  : s.confidence === 'medium'
                    ? 'border-warning/50 bg-warning/5'
                    : 'border-border bg-muted/30';
              return (
                <li
                  key={s.studentId}
                  className={`flex items-center justify-between gap-2 rounded-md border ${tone} px-3 py-1.5 text-sm`}
                >
                  <div>
                    <p className="font-medium">{s.fullName}</p>
                    <p className="text-xs text-muted-foreground">
                      {s.confidence} confidence · {s.reason}
                    </p>
                  </div>
                  <button
                    onClick={() => assign.mutate(s.studentId)}
                    disabled={assign.isPending}
                    className="rounded-md bg-primary px-3 py-1 text-xs text-primary-foreground hover:opacity-90 disabled:opacity-50"
                  >
                    {assign.isPending && assign.variables === s.studentId
                      ? 'Assigning…'
                      : 'Assign →'}
                  </button>
                </li>
              );
            })}
          </ul>
        </section>
      )}

      <section className="space-y-2 rounded-lg border border-border bg-card p-4">
        <h3 className="text-sm font-medium">Or pick a different student</h3>
        <select
          value={studentId}
          onChange={(e) => setStudentId(e.target.value)}
          className="w-full max-w-sm rounded-md border border-input bg-background px-2 py-1.5 text-sm"
        >
          <option value="">— pick a student —</option>
          {(studentsData?.data ?? []).map((s) => (
            <option key={s.studentId} value={s.studentId}>
              {s.name} (grade {s.grade})
            </option>
          ))}
        </select>
        <div className="flex flex-wrap gap-2">
          <button
            disabled={!studentId || assign.isPending}
            onClick={() => assign.mutate(studentId)}
            className="rounded-md bg-primary px-3 py-1.5 text-sm text-primary-foreground hover:opacity-90 disabled:opacity-50"
          >
            {assign.isPending ? 'Assigning…' : 'Assign + run pipeline'}
          </button>
          <button
            disabled={ignore.isPending}
            onClick={() => ignore.mutate()}
            className="rounded-md border border-border px-3 py-1.5 text-sm hover:bg-muted disabled:opacity-50"
          >
            Ignore
          </button>
        </div>
        {assign.isError && (
          <p className="text-xs text-destructive">{(assign.error as Error).message}</p>
        )}
      </section>
    </div>
  );
}

function pickStringFromRaw(
  raw: Record<string, unknown> | null,
  keys: string[],
): string | undefined {
  if (!raw) return undefined;
  for (const k of keys) {
    const v = raw[k];
    if (typeof v === 'string' && v.length > 0) return v;
  }
  return undefined;
}
