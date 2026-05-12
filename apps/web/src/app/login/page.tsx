'use client';

import { useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { getBrowserSupabase } from '@/lib/supabase';

/**
 * Single sign-in surface for counsellors and students. Google OAuth via
 * Supabase; magic links and email/password are intentionally disabled.
 * Post-auth routing happens on /auth/callback by inspecting the user's
 * /api/me state.
 */
export default function LoginPage() {
  const params = useSearchParams();
  const next = params.get('next') ?? undefined;
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function signInWithGoogle() {
    setSubmitting(true);
    setError(null);
    const supabase = getBrowserSupabase();
    const callback = new URL('/auth/callback', window.location.origin);
    if (next) callback.searchParams.set('next', next);
    const { error: err } = await supabase.auth.signInWithOAuth({
      provider: 'google',
      options: { redirectTo: callback.toString() },
    });
    if (err) {
      setError(err.message);
      setSubmitting(false);
    }
    // On success Supabase redirects the browser; nothing else to do here.
  }

  return (
    <div className="mx-auto max-w-sm pt-24 px-4">
      <h1 className="text-2xl font-semibold">Sign in</h1>
      <p className="mt-1 text-sm text-muted-foreground">
        Use your Google account. Counsellors and students sign in with the same button.
      </p>
      <button
        onClick={signInWithGoogle}
        disabled={submitting}
        className="mt-6 flex w-full items-center justify-center gap-3 rounded-md border border-border bg-card px-4 py-2.5 text-sm font-medium hover:bg-muted disabled:opacity-60"
      >
        <GoogleG />
        {submitting ? 'Redirecting to Google…' : 'Continue with Google'}
      </button>
      {error && (
        <p className="mt-3 text-sm text-destructive">{error}</p>
      )}
      <p className="mt-8 text-xs text-muted-foreground">
        First-time student? Just sign in — your counsellor will see your
        onboarding form and approve you. Until approval, you'll only see the
        form, not the dashboard.
      </p>
    </div>
  );
}

function GoogleG() {
  // Plain inline SVG so we don't pull in @google-cloud/iam icon dep.
  return (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48" className="h-5 w-5">
      <path
        fill="#FFC107"
        d="M43.6 20.5H42V20H24v8h11.3C33.7 32.9 29.3 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.9 1.2 8 3.1l5.7-5.7C34.4 6.1 29.4 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.3-.1-2.3-.4-3.5z"
      />
      <path
        fill="#FF3D00"
        d="M6.3 14.7l6.6 4.8C14.7 16 19 13 24 13c3.1 0 5.9 1.2 8 3.1l5.7-5.7C34.4 7.1 29.4 5 24 5 16.3 5 9.7 9 6.3 14.7z"
      />
      <path
        fill="#4CAF50"
        d="M24 44c5.2 0 10-2 13.6-5.2l-6.3-5.2C29.3 35 26.7 36 24 36c-5.3 0-9.7-3.1-11.3-7.5l-6.5 5C9.5 39.9 16.2 44 24 44z"
      />
      <path
        fill="#1976D2"
        d="M43.6 20.5H42V20H24v8h11.3c-.7 2-2 3.8-3.6 5.2l6.3 5.2C40.4 35.6 44 30.2 44 24c0-1.3-.1-2.3-.4-3.5z"
      />
    </svg>
  );
}
