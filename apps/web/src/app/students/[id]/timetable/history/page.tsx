'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft } from 'lucide-react';
import { timetableEditorApi, type ChangeSummary, type TimetableChange } from '@/lib/api';
import { cn } from '@/lib/utils';

/**
 * Timetable history — every `timetable_changes` row for this student,
 * newest first, with a one-click revert on active changes. The data is
 * already on the server (engine writes a row per decision); this page just
 * surfaces it.
 */
export default function TimetableHistoryPage() {
  const params = useParams<{ id: string }>();
  const studentId = params.id;
  const qc = useQueryClient();
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const { data, isLoading, error } = useQuery({
    queryKey: ['timetable-changes', studentId],
    queryFn: () => timetableEditorApi.listChanges(studentId),
  });

  const revert = useMutation({
    mutationFn: (changeId: string) => timetableEditorApi.revert(studentId, changeId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['timetable-changes', studentId] });
      qc.invalidateQueries({ queryKey: ['student-tasks-timetable', studentId] });
    },
  });

  function toggle(id: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  const rows = data?.data ?? [];

  return (
    <div className="space-y-4">
      <header className="flex items-center justify-between">
        <div>
          <Link
            href={`/students/${studentId}/timetable`}
            className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:underline"
          >
            <ArrowLeft className="h-3 w-3" /> Back to timetable
          </Link>
          <h2 className="mt-1 text-lg font-semibold">Timetable history</h2>
          <p className="text-sm text-muted-foreground">
            Every decision that touched this student&apos;s schedule, newest first. Active changes
            can be reverted from here.
          </p>
        </div>
      </header>

      {isLoading && <p className="text-sm text-muted-foreground">Loading…</p>}
      {error && <p className="text-sm text-destructive">Failed: {(error as Error).message}</p>}
      {!isLoading && rows.length === 0 && (
        <p className="rounded-lg border border-dashed border-border p-4 text-sm text-muted-foreground">
          No changes recorded yet.
        </p>
      )}

      <ul className="space-y-2">
        {rows.map((row) => (
          <ChangeRow
            key={row.id}
            studentId={studentId}
            change={row}
            expanded={expanded.has(row.id)}
            onToggle={() => toggle(row.id)}
            onRevert={() => revert.mutate(row.id)}
            reverting={revert.isPending && revert.variables === row.id}
            revertError={
              revert.isError && revert.variables === row.id
                ? (revert.error as Error).message
                : null
            }
          />
        ))}
      </ul>
    </div>
  );
}

function ChangeRow({
  studentId,
  change,
  expanded,
  onToggle,
  onRevert,
  reverting,
  revertError,
}: {
  studentId: string;
  change: TimetableChange;
  expanded: boolean;
  onToggle: () => void;
  onRevert: () => void;
  reverting: boolean;
  revertError: string | null;
}) {
  const { data: summaryData } = useQuery({
    queryKey: ['timetable-change-summary', change.id],
    queryFn: () => timetableEditorApi.summary(studentId, change.id),
    enabled: expanded,
  });

  return (
    <li className="rounded-lg border border-border bg-card p-3 text-sm">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <SourceBadge source={change.source} />
            <StatusBadge status={change.status} />
            <span className="text-xs text-muted-foreground">
              {change.operations.length} op{change.operations.length === 1 ? '' : 's'}
            </span>
          </div>
          <p className="mt-1 text-xs text-muted-foreground">
            {new Date(change.createdAt).toLocaleString('en-US', {
              month: 'short',
              day: 'numeric',
              year: 'numeric',
              hour: 'numeric',
              minute: '2-digit',
            })}
            {change.appliedAt && ` · applied ${formatRelative(change.appliedAt)}`}
            {change.revertedAt && ` · reverted ${formatRelative(change.revertedAt)}`}
          </p>
          {change.rationale && (
            <p className="mt-1 text-xs italic text-muted-foreground">{change.rationale}</p>
          )}
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={onToggle}
            className="rounded-md border border-border px-2 py-1 text-xs hover:bg-muted"
          >
            {expanded ? 'Hide' : 'Show'} diff
          </button>
          {change.status === 'active' && (
            <button
              onClick={onRevert}
              disabled={reverting}
              className="rounded-md border border-destructive px-2 py-1 text-xs text-destructive hover:bg-destructive hover:text-destructive-foreground disabled:opacity-50"
            >
              {reverting ? 'Reverting…' : 'Revert'}
            </button>
          )}
        </div>
      </div>

      {revertError && <p className="mt-2 text-xs text-destructive">{revertError}</p>}

      {expanded && (
        <div className="mt-3 border-t border-border pt-3">
          {!summaryData ? (
            <p className="text-xs text-muted-foreground">Loading diff…</p>
          ) : (
            <DiffBlock summary={summaryData} />
          )}
        </div>
      )}
    </li>
  );
}

function DiffBlock({ summary }: { summary: ChangeSummary }) {
  const empty =
    summary.added.length === 0 &&
    summary.removed.length === 0 &&
    summary.moved.length === 0 &&
    summary.edits.length === 0;
  if (empty) return <p className="text-xs text-muted-foreground">No tasks affected.</p>;
  return (
    <div className="space-y-2 text-xs">
      {summary.added.length > 0 && (
        <Section label={`Added (${summary.added.length})`} tone="success">
          {summary.added.slice(0, 8).map((t) => (
            <Row key={t.id} title={`${t.subject} · ${t.taskTitle}`} when={fmt(t.scheduledStart, t.scheduledEnd)} />
          ))}
          {summary.added.length > 8 && <Muted>…+{summary.added.length - 8} more</Muted>}
        </Section>
      )}
      {summary.removed.length > 0 && (
        <Section label={`Removed (${summary.removed.length})`} tone="destructive">
          {summary.removed.slice(0, 8).map((t) => (
            <Row key={t.id} title={`${t.subject} · ${t.taskTitle}`} when={fmt(t.scheduledStart, t.scheduledEnd)} />
          ))}
          {summary.removed.length > 8 && <Muted>…+{summary.removed.length - 8} more</Muted>}
        </Section>
      )}
      {summary.moved.length > 0 && (
        <Section label={`Moved (${summary.moved.length})`} tone="muted">
          {summary.moved.map((m, i) => (
            <Row
              key={i}
              title={`${m.from.subject} · ${m.from.taskTitle}`}
              when={`${fmt(m.from.scheduledStart, m.from.scheduledEnd)} → ${fmt(m.to.scheduledStart, m.to.scheduledEnd)}`}
            />
          ))}
        </Section>
      )}
      {summary.edits.length > 0 && (
        <Section label={`Edited (${summary.edits.length})`} tone="muted">
          {summary.edits.map((e, i) => (
            <Row
              key={i}
              title={`${e.task.subject} · ${e.task.taskTitle}`}
              when={Object.entries(e.changes)
                .map(([k, v]) => `${k}=${String(v)}`)
                .join(', ')}
            />
          ))}
        </Section>
      )}
    </div>
  );
}

function Section({
  label,
  tone,
  children,
}: {
  label: string;
  tone: 'success' | 'destructive' | 'muted';
  children: React.ReactNode;
}) {
  const toneClass =
    tone === 'success'
      ? 'border-success/40 bg-success/5'
      : tone === 'destructive'
        ? 'border-destructive/40 bg-destructive/5'
        : 'border-border bg-muted/20';
  return (
    <div className={cn('rounded-md border p-2', toneClass)}>
      <p className="mb-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
        {label}
      </p>
      <ul className="space-y-1">{children}</ul>
    </div>
  );
}

function Row({ title, when }: { title: string; when: string }) {
  return (
    <li className="flex flex-wrap items-baseline justify-between gap-2">
      <span className="font-medium">{title}</span>
      <span className="text-[11px] text-muted-foreground">{when}</span>
    </li>
  );
}

function Muted({ children }: { children: React.ReactNode }) {
  return <li className="text-[11px] text-muted-foreground">{children}</li>;
}

function SourceBadge({ source }: { source: string }) {
  const label =
    source === 'meeting_extraction'
      ? 'Meeting'
      : source === 'counsellor_chat'
        ? 'Editor'
        : source === 'counsellor_direct'
          ? 'Direct edit'
          : source === 'change_request'
            ? 'Request'
            : source === 'bootstrap'
              ? 'Bootstrap'
              : source;
  return (
    <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide">
      {label}
    </span>
  );
}

function StatusBadge({ status }: { status: 'draft' | 'active' | 'reverted' }) {
  const tone =
    status === 'active'
      ? 'bg-success/20 text-success-foreground border-success/40'
      : status === 'reverted'
        ? 'bg-destructive/10 text-destructive border-destructive/30'
        : 'bg-muted text-muted-foreground border-border';
  return (
    <span className={cn('rounded border px-1.5 py-0.5 text-[10px] font-medium uppercase', tone)}>
      {status}
    </span>
  );
}

function fmt(startIso: string, endIso: string): string {
  const s = new Date(startIso);
  const e = new Date(endIso);
  const date = s.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  const startT = s.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true });
  const endT = e.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true });
  return `${date} ${startT}–${endT}`;
}

function formatRelative(iso: string): string {
  const d = new Date(iso);
  const diffMs = Date.now() - d.getTime();
  const mins = Math.round(diffMs / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 7) return `${days}d ago`;
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}
