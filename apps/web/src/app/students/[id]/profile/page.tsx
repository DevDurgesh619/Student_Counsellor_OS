'use client';

import { useParams } from 'next/navigation';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { calendarApi, counsellorApi } from '@/lib/api';

type StudentProfile = {
  id: string;
  fullName: string;
  phone: string;
  email: string | null;
  parentContacts: Array<{
    name: string;
    phone?: string;
    email?: string;
    relationship: string;
  }>;
  currentGrade: string;
  school: string | null;
  currentContextTag: string;
  timezone: string;
  languagePreferences: { primary: string; secondary?: string[] } | null;
  programStartDate: string;
  status: string;
};

export default function StudentProfilePage() {
  const params = useParams<{ id: string }>();
  const { data, isLoading } = useQuery({
    queryKey: ['student', params.id],
    queryFn: () => counsellorApi.student(params.id) as Promise<StudentProfile>,
  });

  if (isLoading) return <p className="text-sm text-muted-foreground">Loading…</p>;
  if (!data) return null;

  return (
    <div className="space-y-6">
      <h2 className="text-lg font-medium">Profile</h2>
      <p className="text-xs text-muted-foreground">
        Read-only view. Edits land in the admin app for now (Phase 9 unifies edit UX).
      </p>

      <dl className="grid grid-cols-2 gap-4 text-sm">
        <Row label="Name" value={data.fullName} />
        <Row label="Grade" value={data.currentGrade} />
        <Row label="School" value={data.school ?? '—'} />
        <Row label="Status" value={data.status} />
        <Row label="Phone" value={data.phone} />
        <Row label="Email" value={data.email ?? '—'} />
        <Row label="Timezone" value={data.timezone} />
        <Row label="Context" value={data.currentContextTag} />
        <Row label="Program start" value={new Date(data.programStartDate).toLocaleDateString()} />
        <Row
          label="Languages"
          value={
            data.languagePreferences
              ? [data.languagePreferences.primary, ...(data.languagePreferences.secondary ?? [])].join(
                  ', ',
                )
              : '—'
          }
        />
      </dl>

      <CalendarSection studentId={params.id} />

      <section>
        <h3 className="text-sm font-medium uppercase tracking-wide text-muted-foreground">
          Parent contacts
        </h3>
        <ul className="mt-2 space-y-1 text-sm">
          {data.parentContacts.length === 0 && <li className="text-muted-foreground">—</li>}
          {data.parentContacts.map((p, i) => (
            <li key={i}>
              <span className="font-medium">{p.name}</span>
              <span className="text-muted-foreground"> · {p.relationship}</span>
              {p.phone && <span> · {p.phone}</span>}
              {p.email && <span> · {p.email}</span>}
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}

function CalendarSection({ studentId }: { studentId: string }) {
  const qc = useQueryClient();
  const { data: health } = useQuery({
    queryKey: ['calendar-health', studentId],
    queryFn: () => calendarApi.health(studentId),
    refetchInterval: 60_000,
  });

  const setupUrl = useMutation({
    mutationFn: () => calendarApi.setupUrl(studentId),
    onSuccess: (res) => {
      window.open(res.url, '_blank', 'noopener');
    },
  });
  const resync = useMutation({
    mutationFn: () => calendarApi.resync(studentId),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['calendar-health', studentId] }),
  });

  const tone =
    health?.status === 'healthy'
      ? 'bg-success text-success-foreground'
      : health?.status === 'degraded'
        ? 'bg-warning text-warning-foreground'
        : health?.status === 'failing' || health?.status === 'auth_required'
          ? 'bg-destructive text-destructive-foreground'
          : 'bg-muted text-muted-foreground';

  return (
    <section className="space-y-3 rounded-lg border border-border bg-card p-4">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-medium uppercase tracking-wide text-muted-foreground">
          Google Calendar sync
        </h3>
        {health && (
          <span className={`rounded-full px-2 py-0.5 text-[10px] uppercase ${tone}`}>
            {health.status}
          </span>
        )}
      </div>
      {health && (
        <dl className="grid grid-cols-2 gap-2 text-xs">
          <div>
            <dt className="text-muted-foreground">Last sync</dt>
            <dd>{health.lastSyncAt ? new Date(health.lastSyncAt).toLocaleString() : '—'}</dd>
          </div>
          <div>
            <dt className="text-muted-foreground">Errors (24h)</dt>
            <dd>{health.errorsLast24h}</dd>
          </div>
          {health.tokenExpiringInDays !== null && (
            <div>
              <dt className="text-muted-foreground">Token expires in</dt>
              <dd>{health.tokenExpiringInDays} days</dd>
            </div>
          )}
        </dl>
      )}
      <div className="flex gap-2">
        <button
          onClick={() => setupUrl.mutate()}
          disabled={setupUrl.isPending}
          className="rounded-md border border-input px-3 py-1.5 text-xs hover:bg-muted disabled:opacity-60"
        >
          {health?.status === 'not_setup' ? 'Set up calendar' : 'Re-authenticate'}
        </button>
        {health?.status !== 'not_setup' && (
          <button
            onClick={() => resync.mutate()}
            disabled={resync.isPending}
            className="rounded-md border border-input px-3 py-1.5 text-xs hover:bg-muted disabled:opacity-60"
          >
            {resync.isPending ? 'Queueing…' : 'Force resync'}
          </button>
        )}
      </div>
      {(setupUrl.error || resync.error) && (
        <p className="text-xs text-destructive">
          {((setupUrl.error || resync.error) as Error).message}
        </p>
      )}
      <p className="text-[11px] text-muted-foreground">
        The student opens the link to grant Google access. Tasks then sync to a "WGC – Study"
        calendar in their account.
      </p>
    </section>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-xs uppercase tracking-wide text-muted-foreground">{label}</dt>
      <dd className="mt-1">{value}</dd>
    </div>
  );
}
