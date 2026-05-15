'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { format } from 'date-fns';
import { ChevronDown, ChevronRight, Trash2 } from 'lucide-react';
import { counsellorApi, type CounsellorTodoRow } from '@/lib/api';
import { formatRelative } from '@/lib/utils';

// Meeting-count presets. `null` = no filter (all todos). 1 = latest meeting
// only. The custom input can set any positive integer.
const MEETING_PRESETS: { value: number | null; label: string }[] = [
  { value: null, label: 'All' },
  { value: 1, label: 'Latest' },
  { value: 2, label: 'Last 2' },
  { value: 3, label: 'Last 3' },
];

export function TodosView({ studentId }: { studentId?: string }) {
  const qc = useQueryClient();
  // Meeting filter — a stable integer (or null), so the query key never
  // churns between renders. Only meaningful in student scope.
  const [meetingFilter, setMeetingFilter] = useState<number | null>(null);
  const [showCompleted, setShowCompleted] = useState(true);
  const [showArchived, setShowArchived] = useState(false);

  const lastSessions = studentId ? meetingFilter ?? undefined : undefined;

  // Active list — pending + completed, optionally narrowed to the last N meetings.
  const { data, isLoading } = useQuery({
    queryKey: ['counsellor-todos', studentId ?? null, lastSessions ?? 'all'],
    queryFn: () =>
      counsellorApi.todos({ studentId, status: 'pending,completed', lastSessions }),
    refetchInterval: 30_000,
  });

  // Archived list — lazy, only fetched when the section is expanded.
  const { data: archivedData } = useQuery({
    queryKey: ['counsellor-todos-archived', studentId ?? null],
    queryFn: () => counsellorApi.todos({ studentId, status: 'archived' }),
    enabled: showArchived,
  });

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ['counsellor-todos'] });
    qc.invalidateQueries({ queryKey: ['counsellor-todos-archived'] });
  };

  const patch = useMutation({
    mutationFn: ({ id, status }: { id: string; status: 'pending' | 'completed' | 'archived' }) =>
      counsellorApi.patchTodo(id, { status }),
    onSuccess: invalidate,
  });
  const del = useMutation({
    mutationFn: (id: string) => counsellorApi.deleteTodo(id),
    onSuccess: invalidate,
  });
  const bulkArchive = useMutation({
    mutationFn: () => counsellorApi.bulkArchiveTodos({ studentId }),
    onSuccess: invalidate,
  });

  const todos = data?.data ?? [];
  const pending = todos.filter((t) => t.status === 'pending');
  const completed = todos.filter((t) => t.status === 'completed');
  const archived = archivedData?.data ?? [];

  function onDelete(id: string) {
    if (window.confirm("Delete this todo? This can't be undone.")) {
      del.mutate(id);
    }
  }

  function onClearCompleted() {
    if (completed.length === 0) return;
    if (
      window.confirm(
        `Clear all ${completed.length} completed todo${completed.length === 1 ? '' : 's'}? ` +
          'They move to Archived and drop out of this list.',
      )
    ) {
      bulkArchive.mutate();
    }
  }

  return (
    <div className="space-y-4">
      <header>
        <h1 className="text-2xl font-semibold">
          {studentId ? 'Todos for this student' : 'Counsellor todos'}
        </h1>
        <p className="text-sm text-muted-foreground">
          {studentId
            ? 'Action items the system pulled out of this student’s sessions for you to follow up on.'
            : 'Action items from session transcripts that the counsellor (you) owns.'}
        </p>
      </header>

      {/* Meeting filter — student scope only. "All" shows every todo; the
          presets / custom box narrow to todos sourced from the last N
          sessions. meetingFilter is a plain integer, so the query key stays
          stable across renders (no refetch loop). */}
      {studentId && (
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex gap-1 rounded-md border border-border p-0.5">
            {MEETING_PRESETS.map((p) => (
              <button
                key={p.label}
                onClick={() => setMeetingFilter(p.value)}
                className={`rounded px-3 py-1 text-xs transition-colors ${
                  meetingFilter === p.value
                    ? 'bg-primary text-primary-foreground'
                    : 'hover:bg-muted'
                }`}
              >
                {p.label}
              </button>
            ))}
          </div>
          <label className="flex items-center gap-1 text-xs text-muted-foreground">
            or last
            <input
              type="number"
              min={1}
              max={50}
              value={meetingFilter ?? ''}
              onChange={(e) => {
                const n = parseInt(e.target.value, 10);
                setMeetingFilter(Number.isNaN(n) || n < 1 ? null : Math.min(n, 50));
              }}
              placeholder="N"
              className="w-14 rounded-md border border-input bg-background px-2 py-1 text-foreground"
            />
            meetings
          </label>
        </div>
      )}

      {isLoading && <p className="text-sm text-muted-foreground">Loading…</p>}

      {!isLoading && pending.length === 0 && completed.length === 0 && (
        <p className="rounded-lg border border-dashed border-border p-6 text-center text-sm text-muted-foreground">
          {meetingFilter
            ? 'No todos from those meetings. Widen the filter or pick "All".'
            : 'No todos yet.'}
        </p>
      )}

      {/* Pending */}
      {pending.length > 0 && (
        <section className="space-y-2">
          <h2 className="text-sm font-medium text-muted-foreground">
            Pending ({pending.length})
          </h2>
          <ul className="space-y-1">
            {pending.map((t) => (
              <TodoItem
                key={t.id}
                todo={t}
                showStudentLink={!studentId}
                onCheck={(checked) =>
                  patch.mutate({ id: t.id, status: checked ? 'completed' : 'pending' })
                }
                onDelete={() => onDelete(t.id)}
              />
            ))}
          </ul>
        </section>
      )}

      {/* Completed — collapsible staging area before archive */}
      {completed.length > 0 && (
        <section className="rounded-lg border border-border">
          <div className="flex items-center justify-between px-4 py-2.5">
            <button
              onClick={() => setShowCompleted((v) => !v)}
              className="flex items-center gap-1.5 text-sm font-medium text-muted-foreground hover:text-foreground"
            >
              {showCompleted ? (
                <ChevronDown className="h-4 w-4" />
              ) : (
                <ChevronRight className="h-4 w-4" />
              )}
              Completed ({completed.length})
            </button>
            <button
              onClick={onClearCompleted}
              disabled={bulkArchive.isPending}
              className="rounded-md border border-border px-2 py-1 text-xs hover:bg-muted disabled:opacity-50"
            >
              {bulkArchive.isPending ? 'Clearing…' : 'Clear all completed'}
            </button>
          </div>
          {showCompleted && (
            <ul className="space-y-1 border-t border-border p-2">
              {completed.map((t) => (
                <TodoItem
                  key={t.id}
                  todo={t}
                  showStudentLink={!studentId}
                  onCheck={(checked) =>
                    patch.mutate({ id: t.id, status: checked ? 'completed' : 'pending' })
                  }
                  onDelete={() => onDelete(t.id)}
                />
              ))}
            </ul>
          )}
        </section>
      )}

      {/* Archived — lazy, collapsed by default */}
      <section className="rounded-lg border border-border">
        <button
          onClick={() => setShowArchived((v) => !v)}
          className="flex w-full items-center justify-between px-4 py-2.5 text-left hover:bg-muted/30"
        >
          <span className="flex items-center gap-1.5 text-sm font-medium text-muted-foreground">
            {showArchived ? (
              <ChevronDown className="h-4 w-4" />
            ) : (
              <ChevronRight className="h-4 w-4" />
            )}
            Archived{archived.length > 0 ? ` (${archived.length})` : ''}
          </span>
        </button>
        {showArchived && (
          <div className="border-t border-border p-2">
            {archived.length === 0 ? (
              <p className="px-2 py-3 text-xs text-muted-foreground">
                Nothing archived yet. Cleared-out completed todos land here.
              </p>
            ) : (
              <ul className="space-y-1">
                {archived.map((t) => (
                  <TodoItem
                    key={t.id}
                    todo={t}
                    showStudentLink={!studentId}
                    archivedRow
                    onDelete={() => onDelete(t.id)}
                  />
                ))}
              </ul>
            )}
          </div>
        )}
      </section>
    </div>
  );
}

function TodoItem({
  todo,
  showStudentLink,
  archivedRow = false,
  onCheck,
  onDelete,
}: {
  todo: CounsellorTodoRow;
  showStudentLink: boolean;
  archivedRow?: boolean;
  onCheck?: (checked: boolean) => void;
  onDelete: () => void;
}) {
  const done = todo.status === 'completed' || todo.status === 'archived';
  return (
    <li className="flex items-start gap-3 rounded-md border border-border bg-card p-3 text-sm">
      {/* Archived rows are read-only — no checkbox, just the record. */}
      {!archivedRow && onCheck ? (
        <input
          type="checkbox"
          checked={todo.status === 'completed'}
          onChange={(e) => onCheck(e.target.checked)}
          className="mt-1"
        />
      ) : (
        <span className="mt-1 text-xs text-muted-foreground">✓</span>
      )}
      <div className="flex-1">
        <p className={done ? 'text-muted-foreground line-through' : ''}>{todo.description}</p>
        <p className="mt-1 text-xs text-muted-foreground">
          Added {formatRelative(todo.createdAt)}
          {todo.dueDate && <> · due {format(new Date(todo.dueDate), 'MMM d')}</>}
          {todo.completedAt && <> · done {formatRelative(todo.completedAt)}</>}
          {showStudentLink && todo.studentId && (
            <>
              {' · '}
              <Link
                href={`/students/${todo.studentId}/today`}
                className="underline hover:no-underline"
              >
                open student
              </Link>
            </>
          )}
        </p>
      </div>
      <button
        onClick={onDelete}
        title="Delete permanently"
        className="rounded-md border border-border p-1.5 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
      >
        <Trash2 className="h-3.5 w-3.5" />
      </button>
    </li>
  );
}
