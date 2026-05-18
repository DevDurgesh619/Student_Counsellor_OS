'use client';

import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { timetableEditorApi } from '@/lib/api';

/**
 * Compact diff renderer for a proposed `timetable_changes` row.
 *
 * The chat bubble is too narrow to hold a real calendar grid (~37px per
 * day column inside a 360px right rail). So we render a structured text
 * summary instead: state badge + counts + a short list per category.
 */
export function ChangeDiff({
  studentId,
  changeId,
}: {
  studentId: string;
  changeId: string;
}) {
  const { data, isLoading, error } = useQuery({
    queryKey: ['timetable-change-summary', changeId],
    queryFn: () => timetableEditorApi.summary(studentId, changeId),
  });
  const change = data?.change;

  const grouped = useMemo(() => {
    if (!data) return null;
    return {
      addedBySig: groupBySignature(data.added),
      removedBySig: groupBySignature(data.removed),
      moved: data.moved,
      edits: data.edits ?? [],
    };
  }, [data]);

  if (isLoading) return <p className="text-xs text-muted-foreground">Loading diff…</p>;
  if (error) return <p className="text-xs text-rose-500">Failed to load diff.</p>;
  if (!data || !grouped) return null;

  const nothing =
    grouped.addedBySig.length === 0 &&
    grouped.removedBySig.length === 0 &&
    grouped.moved.length === 0 &&
    grouped.edits.length === 0;

  return (
    <div className="space-y-2 text-xs">
      {change && <StateBadge status={change.status} />}

      {nothing && (
        <p className="text-muted-foreground">
          No visible task additions, removals, or moves (e.g. an in-place label edit).
        </p>
      )}

      {grouped.addedBySig.length > 0 && (
        <Section title="Added" tone="add">
          {grouped.addedBySig.map((g) => (
            <li key={g.key}>
              <span className="font-medium">{g.subject}</span> · {g.taskTitle}
              <div className="text-muted-foreground">
                {g.count === 1
                  ? `${formatDate(g.firstStart)} at ${formatTime(g.firstStart)}–${formatTime(g.firstEnd)}`
                  : `${g.count}× — ${formatDate(g.firstStart)} → ${formatDate(g.lastStart)} (${formatTime(g.firstStart)}–${formatTime(g.firstEnd)})`}
              </div>
            </li>
          ))}
        </Section>
      )}

      {grouped.removedBySig.length > 0 && (
        <Section title="Removed" tone="remove">
          {grouped.removedBySig.map((g) => (
            <li key={g.key}>
              <span className="font-medium line-through">{g.subject}</span> · {g.taskTitle}
              <div className="text-muted-foreground">
                {g.count === 1
                  ? `${formatDate(g.firstStart)} at ${formatTime(g.firstStart)}`
                  : `${g.count}× — ${formatDate(g.firstStart)} → ${formatDate(g.lastStart)}`}
              </div>
            </li>
          ))}
        </Section>
      )}

      {grouped.moved.length > 0 && (
        <Section title="Moved" tone="move">
          {grouped.moved.map((m, i) => (
            <li key={`${m.from.id}-${i}`}>
              <span className="font-medium">{m.from.subject}</span> · {m.from.taskTitle}
              <div className="text-muted-foreground">
                {formatDate(m.from.scheduledStart)} {formatTime(m.from.scheduledStart)} →{' '}
                {formatDate(m.to.scheduledStart)} {formatTime(m.to.scheduledStart)}
              </div>
            </li>
          ))}
        </Section>
      )}

      {grouped.edits.length > 0 && (
        <Section title="Edited" tone="move">
          {grouped.edits.map((e, i) => (
            <li key={`${e.task.id}-${i}`}>
              <span className="font-medium">{e.task.subject}</span> · {e.task.taskTitle}
              <div className="text-muted-foreground">
                {formatDate(e.task.scheduledStart)} · {describeChanges(e.changes)}
              </div>
            </li>
          ))}
        </Section>
      )}
    </div>
  );
}

function describeChanges(changes: Record<string, unknown>): string {
  const parts: string[] = [];
  for (const [k, v] of Object.entries(changes)) {
    if (v === undefined) continue;
    parts.push(`${k} → ${v === null ? 'null' : String(v)}`);
  }
  return parts.join(', ') || 'no change';
}

function StateBadge({ status }: { status: 'draft' | 'active' | 'reverted' }) {
  const label =
    status === 'active'
      ? 'Applied'
      : status === 'reverted'
        ? 'Reverted'
        : 'Draft — review and apply';
  const tone =
    status === 'active'
      ? 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-400'
      : status === 'reverted'
        ? 'bg-rose-500/15 text-rose-700 dark:text-rose-400'
        : 'bg-slate-500/15 text-slate-700 dark:text-slate-400';
  return (
    <span
      className={`inline-block rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${tone}`}
    >
      {label}
    </span>
  );
}

function Section({
  title,
  tone,
  children,
}: {
  title: string;
  tone: 'add' | 'remove' | 'move';
  children: React.ReactNode;
}) {
  const dot =
    tone === 'add' ? 'bg-emerald-500' : tone === 'remove' ? 'bg-rose-500' : 'bg-amber-500';
  return (
    <div>
      <h5 className="mb-1 flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
        <span className={`inline-block h-1.5 w-1.5 rounded-full ${dot}`} />
        {title}
      </h5>
      <ul className="space-y-1 pl-3">{children}</ul>
    </div>
  );
}

type Grouped = {
  key: string;
  subject: string;
  taskTitle: string;
  count: number;
  firstStart: string;
  firstEnd: string;
  lastStart: string;
};

/**
 * Collapse a set of tasks with the same subject + title + time-of-day into a
 * single "N occurrences from A to B" row. Keeps the diff readable for
 * recurrences that span 9+ blocks.
 */
function groupBySignature(
  rows: Array<{
    id: string;
    scheduledStart: string;
    scheduledEnd: string;
    subject: string;
    taskTitle: string;
  }>,
): Grouped[] {
  const sorted = [...rows].sort(
    (a, b) => new Date(a.scheduledStart).getTime() - new Date(b.scheduledStart).getTime(),
  );
  const byKey = new Map<string, Grouped>();
  for (const r of sorted) {
    const start = new Date(r.scheduledStart);
    const hhmm = `${start.getHours()}:${start.getMinutes()}`;
    const key = `${r.subject}|${r.taskTitle}|${hhmm}`;
    const existing = byKey.get(key);
    if (existing) {
      existing.count += 1;
      existing.lastStart = r.scheduledStart;
    } else {
      byKey.set(key, {
        key,
        subject: r.subject,
        taskTitle: r.taskTitle,
        count: 1,
        firstStart: r.scheduledStart,
        firstEnd: r.scheduledEnd,
        lastStart: r.scheduledStart,
      });
    }
  }
  return Array.from(byKey.values());
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString([], { month: 'short', day: 'numeric' });
}

function formatTime(iso: string): string {
  return new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}
