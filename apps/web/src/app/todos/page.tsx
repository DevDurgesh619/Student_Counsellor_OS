'use client';

import Link from 'next/link';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { counsellorApi } from '@/lib/api';
import { formatRelative } from '@/lib/utils';

export default function TodosPage() {
  const qc = useQueryClient();
  const { data, isLoading } = useQuery({
    queryKey: ['counsellor-todos'],
    queryFn: () => counsellorApi.todos(),
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
        <h1 className="text-2xl font-semibold">Counsellor todos</h1>
        <p className="text-sm text-muted-foreground">
          Action items from session transcripts that the counsellor (you) owns.
        </p>
      </header>

      {isLoading && <p className="text-sm text-muted-foreground">Loading…</p>}

      <Section title="Pending" items={pending} onPatch={patch.mutate} />
      <Section title="Done / cancelled" items={done} onPatch={patch.mutate} />
    </div>
  );
}

function Section({
  title,
  items,
  onPatch,
}: {
  title: string;
  items: ReturnType<typeof useFakeType>;
  onPatch: (input: { id: string; status: 'completed' | 'pending' | 'cancelled' }) => void;
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
                {t.dueDate && <> · due {t.dueDate}</>}
                {t.studentId && (
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

// Helper to share row type with Section without exporting a type.
function useFakeType() {
  // never invoked at runtime — only used for inferring the array element type.
  return [] as unknown as Awaited<ReturnType<typeof counsellorApi.todos>>['data'];
}
