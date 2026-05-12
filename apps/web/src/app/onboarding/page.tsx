'use client';

import Link from 'next/link';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { onboardingApi, type ProfileDraft } from '@/lib/api';

/**
 * Onboarding inbox — every pending or in-review student lands here. The
 * counsellor either opens a draft to review the AI-extracted profile and
 * approve, or "Ignores" a draft from a stranger who signed up but isn't
 * meant to be in the system.
 */
export default function OnboardingPage() {
  const qc = useQueryClient();
  const { data, isLoading } = useQuery({
    queryKey: ['profile-drafts'],
    queryFn: () => onboardingApi.drafts(),
  });

  const ignore = useMutation({
    mutationFn: (studentId: string) => onboardingApi.ignoreStudent(studentId),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['profile-drafts'] }),
  });

  const drafts = data?.data ?? [];

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-semibold">Onboarding</h1>
        <p className="text-sm text-muted-foreground">
          Students who signed in with Google land here. Review their submitted form, then approve or ignore.
        </p>
      </header>

      {isLoading && <p className="text-sm text-muted-foreground">Loading…</p>}
      {!isLoading && drafts.length === 0 && (
        <p className="rounded-lg border border-dashed border-border p-6 text-center text-sm text-muted-foreground">
          Nothing waiting. New students will appear here after they sign in and submit the form.
        </p>
      )}

      <ul className="space-y-2">
        {drafts.map((d) => (
          <li key={d.id} className="rounded-lg border border-border bg-card p-3">
            <div className="flex items-center justify-between gap-3">
              <Link href={`/onboarding/${d.id}`} className="flex-1 hover:underline">
                <div className="font-medium">
                  {studentName(d) ?? '(unnamed — form not submitted)'}
                </div>
                <div className="text-xs text-muted-foreground">
                  Created {new Date(d.createdAt).toLocaleString()}
                </div>
              </Link>
              <StatusBadge status={d.status} />
              {d.studentId && d.status !== 'approved' && (
                <button
                  onClick={() => {
                    if (confirm('Archive this student? They lose dashboard access on next sign-in.')) {
                      ignore.mutate(d.studentId!);
                    }
                  }}
                  disabled={ignore.isPending}
                  className="rounded-md border border-border px-2 py-1 text-xs hover:bg-muted disabled:opacity-50"
                >
                  Ignore
                </button>
              )}
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

function studentName(d: ProfileDraft): string | null {
  if (d.profile && typeof d.profile['name'] === 'string') return d.profile['name'] as string;
  const fr = d.formResponses?.['basic_info'] as { full_name?: string } | undefined;
  if (fr?.full_name) return fr.full_name;
  return null;
}

function StatusBadge({ status }: { status: ProfileDraft['status'] }) {
  const tone =
    status === 'approved'
      ? 'bg-success text-success-foreground'
      : status === 'rejected'
        ? 'bg-destructive text-destructive-foreground'
        : status === 'pending_review'
          ? 'bg-warning text-warning-foreground'
          : 'bg-muted text-muted-foreground';
  return (
    <span className={`rounded-full px-2 py-0.5 text-[10px] uppercase ${tone}`}>
      {status.replace('_', ' ')}
    </span>
  );
}
