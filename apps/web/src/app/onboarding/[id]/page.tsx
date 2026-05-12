'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ChevronLeft } from 'lucide-react';
import { onboardingApi } from '@/lib/api';

export default function ProfileDraftReviewPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const qc = useQueryClient();

  const { data: draft, isLoading } = useQuery({
    queryKey: ['profile-draft', id],
    queryFn: () => onboardingApi.draft(id),
  });

  const [editJson, setEditJson] = useState('');
  const [parseErr, setParseErr] = useState<string | null>(null);
  const [regenNotes, setRegenNotes] = useState('');

  useEffect(() => {
    if (draft?.profile) setEditJson(JSON.stringify(draft.profile, null, 2));
  }, [draft?.profile]);

  const save = useMutation({
    mutationFn: (p: Record<string, unknown>) => onboardingApi.edit(id, p),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['profile-draft', id] }),
  });
  const approve = useMutation({
    mutationFn: () => onboardingApi.approve(id),
    onSuccess: async (res) => {
      await qc.invalidateQueries({ queryKey: ['profile-draft', id] });
      if (res.studentId) router.replace(`/students/${res.studentId}/profile`);
    },
  });
  const regenerate = useMutation({
    mutationFn: () => onboardingApi.regenerate(id, regenNotes),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['profile-draft', id] }),
  });
  const reject = useMutation({
    mutationFn: () => onboardingApi.reject(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['profile-draft', id] }),
  });
  const ignore = useMutation({
    mutationFn: () =>
      draft?.studentId
        ? onboardingApi.ignoreStudent(draft.studentId)
        : Promise.reject(new Error('no student id')),
    onSuccess: () => router.replace('/onboarding'),
  });

  if (isLoading || !draft) return <p className="text-sm text-muted-foreground">Loading…</p>;

  if (draft.status === 'awaiting_form') {
    return (
      <div className="space-y-4 max-w-2xl">
        <Link
          href="/onboarding"
          className="inline-flex items-center gap-1 text-sm text-muted-foreground"
        >
          <ChevronLeft className="h-4 w-4" /> All drafts
        </Link>
        <h1 className="text-xl font-semibold">Awaiting student response</h1>
        <p className="text-sm text-muted-foreground">
          This student signed in with Google but hasn't submitted the onboarding form yet.
          Their form is at /student/onboarding while signed in as themselves.
        </p>
        {draft.studentId && (
          <button
            onClick={() => ignore.mutate()}
            disabled={ignore.isPending}
            className="rounded-md border border-destructive px-3 py-1.5 text-xs text-destructive hover:bg-destructive/10 disabled:opacity-60"
          >
            Archive this student
          </button>
        )}
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <Link
        href="/onboarding"
        className="inline-flex items-center gap-1 text-sm text-muted-foreground"
      >
        <ChevronLeft className="h-4 w-4" /> All drafts
      </Link>
      <header className="flex items-end justify-between">
        <h1 className="text-2xl font-semibold">Review profile</h1>
        <span className="rounded-full bg-muted px-3 py-1 text-xs uppercase">{draft.status}</span>
      </header>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <section className="space-y-2">
          <h2 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Form responses
          </h2>
          <pre className="max-h-[60vh] overflow-auto rounded-md border border-border bg-muted/30 p-3 text-[11px]">
            {JSON.stringify(draft.formResponses, null, 2)}
          </pre>
          <FlagsList flags={draft.flagsForCounsellor} />
        </section>

        <section className="space-y-2">
          <div className="flex items-center justify-between">
            <h2 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              AI-extracted profile (editable JSON)
            </h2>
            <button
              onClick={() => {
                try {
                  const parsed = JSON.parse(editJson);
                  save.mutate(parsed);
                  setParseErr(null);
                } catch (e) {
                  setParseErr((e as Error).message);
                }
              }}
              disabled={save.isPending}
              className="rounded-md border border-input px-2 py-0.5 text-xs hover:bg-muted disabled:opacity-60"
            >
              {save.isPending ? 'Saving…' : 'Save edits'}
            </button>
          </div>
          <textarea
            value={editJson}
            onChange={(e) => setEditJson(e.target.value)}
            rows={28}
            className="w-full rounded-md border border-input bg-background p-3 font-mono text-[11px]"
          />
          {parseErr && <p className="text-xs text-destructive">JSON parse: {parseErr}</p>}
        </section>
      </div>

      {draft.status !== 'approved' && draft.status !== 'rejected' && (
        <section className="space-y-3 rounded-lg border border-border bg-card p-4">
          <div className="flex flex-wrap gap-2">
            <button
              onClick={() => approve.mutate()}
              disabled={approve.isPending || !draft.profile}
              className="rounded-md bg-success px-4 py-2 text-sm text-success-foreground hover:opacity-90 disabled:opacity-60"
            >
              {approve.isPending ? 'Activating student…' : 'Approve & activate'}
            </button>
            <button
              onClick={() => reject.mutate()}
              disabled={reject.isPending}
              className="rounded-md border border-destructive px-4 py-2 text-sm text-destructive hover:bg-destructive/10 disabled:opacity-60"
            >
              Reject
            </button>
            {draft.studentId && (
              <button
                onClick={() => {
                  if (confirm('Archive this student? They lose dashboard access on next sign-in.')) {
                    ignore.mutate();
                  }
                }}
                disabled={ignore.isPending}
                className="ml-auto rounded-md border border-border px-3 py-1.5 text-xs hover:bg-muted disabled:opacity-50"
              >
                Ignore (archive)
              </button>
            )}
          </div>
          <details className="text-sm">
            <summary className="cursor-pointer text-xs text-muted-foreground">
              Regenerate with corrections
            </summary>
            <textarea
              value={regenNotes}
              onChange={(e) => setRegenNotes(e.target.value)}
              placeholder="What to fix? (e.g. 'Math marks should be /80 not /100')"
              rows={3}
              className="mt-2 w-full rounded-md border border-input bg-background p-2 text-sm"
            />
            <button
              onClick={() => regenerate.mutate()}
              disabled={regenerate.isPending}
              className="mt-2 rounded-md border border-input px-3 py-1.5 text-xs hover:bg-muted disabled:opacity-60"
            >
              {regenerate.isPending ? 'Regenerating…' : 'Regenerate'}
            </button>
          </details>
        </section>
      )}

      {draft.status === 'approved' && draft.studentId && (
        <div className="flex justify-end">
          <button
            onClick={() => router.push(`/students/${draft.studentId}/profile`)}
            className="rounded-md bg-primary px-3 py-1.5 text-sm text-primary-foreground"
          >
            Go to student
          </button>
        </div>
      )}

      {(approve.error || regenerate.error || reject.error || save.error || ignore.error) && (
        <p className="text-sm text-destructive">
          {((approve.error || regenerate.error || reject.error || save.error || ignore.error) as Error).message}
        </p>
      )}
    </div>
  );
}

function FlagsList({ flags }: { flags: unknown[] }) {
  if (!flags?.length) return null;
  return (
    <div className="rounded-md border border-warning/30 bg-warning/10 p-3">
      <div className="text-xs font-medium uppercase">AI flags</div>
      <ul className="mt-1 space-y-1 text-xs">
        {flags.map((f, i) => {
          const flag = f as { field?: string; code?: string; note?: string };
          return (
            <li key={i}>
              <span className="font-mono text-[10px]">{flag.field}</span>{' '}
              <span className="rounded bg-warning/40 px-1 text-[10px]">{flag.code}</span>{' '}
              {flag.note}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
