'use client';

import { useState } from 'react';
import { useParams } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { format } from 'date-fns';
import { counsellorApi } from '@/lib/api';

export default function StudentHistoryPage() {
  const { id } = useParams<{ id: string }>();
  const { data, isLoading } = useQuery({
    queryKey: ['student-history', id],
    queryFn: () => counsellorApi.studentHistorySummary(id),
    enabled: Boolean(id),
  });
  const [openVersions, setOpenVersions] = useState(false);

  if (isLoading) {
    return <p className="text-sm text-muted-foreground">Loading rolling history…</p>;
  }

  const current = data?.current;
  const versions = data?.versions ?? [];

  if (!current) {
    return (
      <div className="space-y-2">
        <h2 className="text-lg font-medium">Rolling history</h2>
        <p className="rounded-lg border border-dashed border-border p-6 text-center text-sm text-muted-foreground">
          No rolling summary yet. One is built automatically the first time a Spinach meeting is
          ingested for this student (skipped only when extraction confidence is "none"). Import
          history from her profile page to seed it.
        </p>
      </div>
    );
  }

  // Older versions exclude the current one so the dropdown isn't redundant.
  const olderVersions = versions.filter((v) => v.version !== current.currentVersion);
  const concerns = (current.openConcerns ?? []).filter(
    (c): c is string => typeof c === 'string',
  );

  return (
    <div className="space-y-6">
      <header className="space-y-1">
        <div className="flex items-baseline justify-between">
          <h2 className="text-lg font-medium">Rolling history</h2>
          <span className="text-xs text-muted-foreground">
            version {current.currentVersion} · {format(new Date(current.generatedAt), 'MMM d, yyyy h:mm a')}
          </span>
        </div>
        <p className="text-xs text-muted-foreground">
          The long-term memory of this student. Regenerated after every meeting ingest. Fed
          into every future LLM call (Pass A/B briefs, reports) as baseline context.
          Built from {current.basedOnSessionIds.length} session{current.basedOnSessionIds.length === 1 ? '' : 's'} so far.
        </p>
        {current.lastUpdatedFocus && (
          <p className="rounded-md border border-border bg-muted/30 px-3 py-2 text-xs">
            <span className="font-medium text-muted-foreground">Last update focus: </span>
            {current.lastUpdatedFocus}
          </p>
        )}
      </header>

      <section className="rounded-lg border border-border bg-card p-4">
        <h3 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          Summary
        </h3>
        <div className="mt-2 whitespace-pre-wrap text-sm leading-relaxed">
          {current.content}
        </div>
      </section>

      {concerns.length > 0 && (
        <section className="rounded-lg border border-warning/30 bg-warning/5 p-4">
          <h3 className="text-xs font-medium uppercase tracking-wide text-warning">
            Open concerns
          </h3>
          <ul className="mt-2 space-y-1 text-sm">
            {concerns.map((c, i) => (
              <li key={i} className="flex gap-2">
                <span className="text-muted-foreground">·</span>
                <span>{c}</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {olderVersions.length > 0 && (
        <section className="rounded-lg border border-border">
          <button
            onClick={() => setOpenVersions((v) => !v)}
            className="flex w-full items-center justify-between px-4 py-3 text-left hover:bg-muted/30"
          >
            <span className="text-sm font-medium">
              Previous versions ({olderVersions.length})
            </span>
            {openVersions ? (
              <ChevronDown className="h-4 w-4 text-muted-foreground" />
            ) : (
              <ChevronRight className="h-4 w-4 text-muted-foreground" />
            )}
          </button>
          {openVersions && (
            <ul className="divide-y divide-border border-t border-border">
              {olderVersions.map((v) => (
                <li key={v.id} className="space-y-2 px-4 py-3">
                  <div className="flex items-baseline justify-between">
                    <span className="text-xs font-medium">v{v.version}</span>
                    <span className="text-[11px] text-muted-foreground">
                      {format(new Date(v.generatedAt), 'MMM d, h:mm a')} · {v.basedOnSessionIds.length} sessions
                    </span>
                  </div>
                  {v.lastUpdatedFocus && (
                    <p className="text-[11px] italic text-muted-foreground">
                      {v.lastUpdatedFocus}
                    </p>
                  )}
                  <details>
                    <summary className="cursor-pointer text-xs text-muted-foreground hover:underline">
                      Show content
                    </summary>
                    <div className="mt-2 whitespace-pre-wrap rounded-md bg-muted/30 p-3 text-xs leading-relaxed">
                      {v.content}
                    </div>
                  </details>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}
    </div>
  );
}
