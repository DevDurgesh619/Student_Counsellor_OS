'use client';

import { useMemo } from 'react';
import { WeekGrid } from './week-grid';
import type { CalendarTask } from './task-block';

/**
 * Side-by-side before/after view for a `timetable_changes` summary.
 * Caller computes the active-schedule snapshot for each side; we just
 * highlight added/removed/moved tasks.
 */
export function DiffGrid({
  before,
  after,
  weekStart,
  addedIds,
  removedIds,
}: {
  before: CalendarTask[];
  after: CalendarTask[];
  weekStart: Date;
  addedIds: string[];
  removedIds: string[];
}) {
  const addedSet = useMemo(() => new Set(addedIds), [addedIds]);
  const removedSet = useMemo(() => new Set(removedIds), [removedIds]);

  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
      <div>
        <h3 className="mb-2 text-sm font-semibold text-muted-foreground">Before</h3>
        <WeekGrid
          tasks={before}
          weekStart={weekStart}
          diff={{ addedIds: new Set<string>(), removedIds: removedSet }}
        />
      </div>
      <div>
        <h3 className="mb-2 text-sm font-semibold text-muted-foreground">After</h3>
        <WeekGrid
          tasks={after}
          weekStart={weekStart}
          diff={{ addedIds: addedSet, removedIds: new Set<string>() }}
        />
      </div>
    </div>
  );
}
