'use client';

import { useState } from 'react';
import { useParams } from 'next/navigation';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { counsellorApi, type GapRow } from '@/lib/api';

const CATEGORIES = ['content', 'skill', 'habit'] as const;
const PRIORITIES = ['low', 'medium', 'high'] as const;

export default function GapsPage() {
  const params = useParams<{ id: string }>();
  const id = params.id;
  const qc = useQueryClient();

  const { data, isLoading } = useQuery({
    queryKey: ['student-gaps', id],
    queryFn: () => counsellorApi.studentGaps(id),
    enabled: Boolean(id),
  });
  const gaps = data?.data ?? [];

  const [showForm, setShowForm] = useState(false);

  const create = useMutation({
    mutationFn: (body: Parameters<typeof counsellorApi.createGap>[1]) =>
      counsellorApi.createGap(id, body),
    onSuccess: () => {
      setShowForm(false);
      qc.invalidateQueries({ queryKey: ['student-gaps', id] });
    },
  });

  const patch = useMutation({
    mutationFn: ({ gapId, body }: { gapId: string; body: Parameters<typeof counsellorApi.patchGap>[1] }) =>
      counsellorApi.patchGap(gapId, body),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['student-gaps', id] }),
  });

  return (
    <div className="space-y-4">
      <header className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-medium">Gap map</h2>
          <p className="text-xs text-muted-foreground">
            Content / skill / habit gaps. Worker 4 reads active gaps when drafting timetable changes.
          </p>
        </div>
        <button
          onClick={() => setShowForm((v) => !v)}
          className="rounded-md bg-primary px-3 py-1.5 text-sm text-primary-foreground hover:opacity-90"
        >
          {showForm ? 'Cancel' : 'Add gap'}
        </button>
      </header>

      {showForm && (
        <NewGapForm
          onSubmit={(body) => create.mutate(body)}
          submitting={create.isPending}
        />
      )}

      {isLoading && <p className="text-sm text-muted-foreground">Loading…</p>}

      {!isLoading && gaps.length === 0 && (
        <p className="rounded-lg border border-dashed border-border p-6 text-center text-sm text-muted-foreground">
          No gaps recorded yet.
        </p>
      )}

      <ul className="space-y-2">
        {gaps.map((g) => (
          <li
            key={g.id}
            className="rounded-lg border border-border bg-card p-3 text-sm"
          >
            <div className="flex items-start justify-between gap-3">
              <div className="flex-1">
                <div className="flex items-center gap-2">
                  <span className="rounded bg-muted px-2 py-0.5 text-xs font-medium">{g.category}</span>
                  {g.subject && (
                    <span className="rounded bg-muted px-2 py-0.5 text-xs">{g.subject}</span>
                  )}
                  <PriorityChip priority={g.priority} />
                  <StatusChip status={g.status} />
                </div>
                <p className="mt-1">{g.description}</p>
                <p className="mt-1 text-xs text-muted-foreground">
                  Identified via {g.identifiedVia.replace('_', ' ')} · added{' '}
                  {new Date(g.createdAt).toLocaleDateString()}
                </p>
              </div>
              <div className="flex gap-1">
                {g.status !== 'addressed' && (
                  <button
                    onClick={() => patch.mutate({ gapId: g.id, body: { status: 'addressed' } })}
                    className="rounded-md border border-border px-2 py-1 text-xs hover:bg-muted"
                  >
                    Mark addressed
                  </button>
                )}
                {g.status !== 'archived' && (
                  <button
                    onClick={() => patch.mutate({ gapId: g.id, body: { status: 'archived' } })}
                    className="rounded-md border border-border px-2 py-1 text-xs hover:bg-muted"
                  >
                    Archive
                  </button>
                )}
              </div>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

function NewGapForm({
  onSubmit,
  submitting,
}: {
  onSubmit: (body: Parameters<typeof counsellorApi.createGap>[1]) => void;
  submitting: boolean;
}) {
  const [category, setCategory] = useState<(typeof CATEGORIES)[number]>('skill');
  const [priority, setPriority] = useState<(typeof PRIORITIES)[number]>('medium');
  const [subject, setSubject] = useState('');
  const [description, setDescription] = useState('');

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (!description.trim()) return;
        onSubmit({
          category,
          priority,
          description: description.trim(),
          subject: subject.trim() || null,
        });
      }}
      className="space-y-3 rounded-lg border border-border bg-muted/30 p-3"
    >
      <div className="flex flex-wrap gap-2">
        <label className="flex items-center gap-1 text-xs">
          Category
          <select
            value={category}
            onChange={(e) => setCategory(e.target.value as (typeof CATEGORIES)[number])}
            className="rounded-md border border-border bg-card px-2 py-1 text-sm"
          >
            {CATEGORIES.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
        </label>
        <label className="flex items-center gap-1 text-xs">
          Priority
          <select
            value={priority}
            onChange={(e) => setPriority(e.target.value as (typeof PRIORITIES)[number])}
            className="rounded-md border border-border bg-card px-2 py-1 text-sm"
          >
            {PRIORITIES.map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </select>
        </label>
        <input
          value={subject}
          onChange={(e) => setSubject(e.target.value)}
          placeholder="Subject (optional)"
          className="rounded-md border border-border bg-card px-2 py-1 text-sm"
        />
      </div>
      <textarea
        value={description}
        onChange={(e) => setDescription(e.target.value)}
        rows={2}
        placeholder="Describe the gap (e.g. 'magnetism — flux concept')"
        className="w-full rounded-md border border-border bg-card px-2 py-1 text-sm"
      />
      <div className="text-right">
        <button
          type="submit"
          disabled={submitting || !description.trim()}
          className="rounded-md bg-primary px-3 py-1.5 text-sm text-primary-foreground hover:opacity-90 disabled:opacity-50"
        >
          Save
        </button>
      </div>
    </form>
  );
}

function PriorityChip({ priority }: { priority: 'low' | 'medium' | 'high' }) {
  const tone =
    priority === 'high'
      ? 'bg-destructive text-destructive-foreground'
      : priority === 'medium'
      ? 'bg-warning text-warning-foreground'
      : 'bg-muted';
  return <span className={`rounded px-1.5 py-0.5 text-[10px] uppercase ${tone}`}>{priority}</span>;
}

function StatusChip({ status }: { status: 'active' | 'addressed' | 'archived' }) {
  const tone =
    status === 'active'
      ? 'bg-primary text-primary-foreground'
      : status === 'addressed'
      ? 'bg-success text-success-foreground'
      : 'bg-muted';
  return <span className={`rounded px-1.5 py-0.5 text-[10px] uppercase ${tone}`}>{status}</span>;
}
