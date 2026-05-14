'use client';

import { useEffect, useRef, useState } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { ChevronDown, X } from 'lucide-react';
import { useQuery } from '@tanstack/react-query';
import { counsellorApi } from '@/lib/api';

const RECENT_KEY = 'wgc.recent-students';
const RECENT_MAX = 5;

type RecentEntry = { id: string; name: string; visitedAt: number };

function readRecent(): RecentEntry[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = localStorage.getItem(RECENT_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as RecentEntry[];
    return Array.isArray(parsed) ? parsed.slice(0, RECENT_MAX) : [];
  } catch {
    return [];
  }
}

function writeRecent(entry: RecentEntry): void {
  if (typeof window === 'undefined') return;
  const existing = readRecent().filter((e) => e.id !== entry.id);
  const next = [entry, ...existing].slice(0, RECENT_MAX);
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify(next));
  } catch {
    // localStorage may be disabled (private mode, quota) — ignore.
  }
}

/**
 * Parse `/students/<id>/<rest...>` → { id, trail }.
 * `trail` is whatever comes after the id (e.g. "queue", "today/foo"), used
 * to preserve the active tab when swapping students from the dropdown.
 */
function parseStudentRoute(pathname: string): { id: string; trail: string } | null {
  const m = pathname.match(/^\/students\/([^/]+)(?:\/(.*))?$/);
  if (!m) return null;
  return { id: m[1]!, trail: m[2] ?? 'today' };
}

export function ActiveStudentPill() {
  const pathname = usePathname();
  const router = useRouter();
  const route = parseStudentRoute(pathname);
  const [open, setOpen] = useState(false);
  const [recent, setRecent] = useState<RecentEntry[]>([]);
  const wrapRef = useRef<HTMLDivElement | null>(null);

  const { data: active } = useQuery({
    queryKey: ['student', route?.id ?? null],
    queryFn: () =>
      counsellorApi.student(route!.id) as Promise<{ id: string; fullName: string }>,
    enabled: Boolean(route?.id),
  });

  // Refresh the recent list whenever we mount or the active id changes —
  // and stash the active student in localStorage for next time.
  useEffect(() => {
    setRecent(readRecent());
  }, [route?.id]);

  useEffect(() => {
    if (!route?.id || !active) return;
    writeRecent({ id: active.id, name: active.fullName, visitedAt: Date.now() });
    setRecent(readRecent());
  }, [route?.id, active?.id, active?.fullName]);

  // Close dropdown on outside click.
  useEffect(() => {
    if (!open) return;
    function onClick(e: MouseEvent) {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
    }
    window.addEventListener('click', onClick);
    return () => window.removeEventListener('click', onClick);
  }, [open]);

  if (!route) return null;

  function switchTo(id: string) {
    if (!route) return;
    setOpen(false);
    router.push(`/students/${id}/${route.trail}`);
  }

  function clearActive() {
    router.push('/students');
  }

  const others = recent.filter((e) => e.id !== route.id);

  return (
    <div ref={wrapRef} className="relative inline-flex items-center gap-1">
      <button
        onClick={() => setOpen((v) => !v)}
        className="inline-flex items-center gap-2 rounded-full border border-border bg-card px-3 py-1 text-xs hover:bg-muted"
      >
        <span className="font-medium">{active?.fullName ?? 'Student'}</span>
        <ChevronDown className="h-3 w-3" />
      </button>
      <button
        onClick={clearActive}
        title="Clear active student"
        className="rounded-full border border-border bg-card p-1 hover:bg-muted"
      >
        <X className="h-3 w-3" />
      </button>
      {open && (
        <div className="absolute left-0 top-full z-40 mt-1 w-56 rounded-md border border-border bg-popover p-1 shadow-md">
          <p className="px-2 pt-1 text-[10px] uppercase tracking-wide text-muted-foreground">
            Recent
          </p>
          {others.length === 0 ? (
            <p className="px-2 py-2 text-xs text-muted-foreground">
              No other recent students.
            </p>
          ) : (
            <ul className="py-1">
              {others.map((e) => (
                <li key={e.id}>
                  <button
                    onClick={() => switchTo(e.id)}
                    className="block w-full truncate rounded px-2 py-1 text-left text-xs hover:bg-muted"
                  >
                    {e.name}
                  </button>
                </li>
              ))}
            </ul>
          )}
          <button
            onClick={() => {
              setOpen(false);
              router.push('/students');
            }}
            className="mt-1 block w-full rounded px-2 py-1 text-left text-xs text-muted-foreground hover:bg-muted"
          >
            Browse all students…
          </button>
        </div>
      )}
    </div>
  );
}
