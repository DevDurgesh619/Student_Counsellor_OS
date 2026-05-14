'use client';

import Link from 'next/link';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { format } from 'date-fns';
import { counsellorApi } from '@/lib/api';
import { formatRelative } from '@/lib/utils';

export function TodosView({ studentId }: { studentId?: string }) {
  const qc = useQueryClient();
  const { data, isLoading } = useQuery({
    queryKey: ['counsellor-todos', studentId ?? null],
    queryFn: () => counsellorApi.todos(studentId),
    refetchInterval: 30_000,
  });
  const patch = useMutation({
    mutationFn: ({ id, status }: { id: string; status: 'completed' | 'pending' | 'cancelled' }) =>
      counsellorApi.patchTodo(id, { status }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['counsellor-todos'] }),
  });

  const todos = data?.data ?? [];
  const pending = todos.filter((t) => t.status === 'pending');
  const done = todos.filter((t) => t.status !== 'pending');

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

      {isLoading && <p className="text-sm text-muted-foreground">Loading…</p>}

      <Section title="Pending" items={pending} onPatch={patch.mutate} showStudentLink={!studentId} />
      <Section title="Done / cancelled" items={done} onPatch={patch.mutate} showStudentLink={!studentId} />
    </div>
  );
}

type TodoRow = Awaited<ReturnType<typeof counsellorApi.todos>>['data'][number];

function Section({
  title,
  items,
  onPatch,
  showStudentLink,
}: {
  title: string;
  items: TodoRow[];
  onPatch: (input: { id: string; status: 'completed' | 'pending' | 'cancelled' }) => void;
  showStudentLink: boolean;
}) {
  if (items.length === 0) return null;
  return (
    <section className="space-y-2">
      <h2 className="text-sm font-medium text-muted-foreground">{title}</h2>
      <ul className="space-y-1">
        {items.map((t) => (
          <li
            key={t.id}
            className="flex items-start gap-3 rounded-md border border-border bg-card p-3 text-sm"
          >
            <input
              type="checkbox"
              checked={t.status === 'completed'}
              onChange={(e) =>
                onPatch({ id: t.id, status: e.target.checked ? 'completed' : 'pending' })
              }
              className="mt-1"
            />
            <div className="flex-1">
              <p className={t.status === 'completed' ? 'line-through text-muted-foreground' : ''}>
                {t.description}
              </p>
              <p className="mt-1 text-xs text-muted-foreground">
                Added {formatRelative(t.createdAt)}
                {t.dueDate && <> · due {format(new Date(t.dueDate), 'MMM d')}</>}
                {showStudentLink && t.studentId && (
                  <>
                    {' · '}
                    <Link
                      href={`/students/${t.studentId}/today`}
                      className="underline hover:no-underline"
                    >
                      open student
                    </Link>
                  </>
                )}
              </p>
            </div>
            {t.status === 'pending' && (
              <button
                onClick={() => onPatch({ id: t.id, status: 'cancelled' })}
                className="rounded-md border border-border px-2 py-1 text-xs hover:bg-muted"
              >
                Cancel
              </button>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
