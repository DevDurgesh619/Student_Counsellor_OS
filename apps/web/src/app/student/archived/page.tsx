'use client';

import { getBrowserSupabase } from '@/lib/supabase';

/**
 * Landing page for archived students. The server gate routes any student
 * whose status === 'archived' here. They can read why they're here and
 * sign out, nothing else.
 */
export default function StudentArchivedPage() {
  async function signOut() {
    await getBrowserSupabase().auth.signOut();
    window.location.href = '/login';
  }

  return (
    <div className="mx-auto max-w-md space-y-4 pt-16 text-center">
      <h1 className="text-2xl font-semibold">Account archived</h1>
      <p className="text-sm text-muted-foreground">
        Your counsellor archived this account. If you think that's a mistake,
        please reach out to them directly — they can restore your access.
      </p>
      <button
        onClick={signOut}
        className="rounded-md border border-border px-3 py-1.5 text-sm hover:bg-muted"
      >
        Sign out
      </button>
    </div>
  );
}
