'use client';

import { useEffect } from 'react';

const WEB_BASE =
  process.env['NEXT_PUBLIC_WEB_BASE_URL']?.replace(/\/$/, '') ?? 'http://localhost:3000';

/**
 * apps/admin is deprecated — every operator workflow now lives in apps/web's
 * counsellor UI. Stale bookmarks land here and bounce.
 */
export default function AdminDeprecatedHome() {
  useEffect(() => {
    window.location.replace(`${WEB_BASE}/students`);
  }, []);

  return (
    <div className="mx-auto max-w-lg pt-24 px-4 text-center text-sm">
      <h1 className="text-xl font-semibold">apps/admin is disabled</h1>
      <p className="mt-2 text-muted-foreground">
        All operator workflows moved to the counsellor app. Redirecting to{' '}
        <a href={`${WEB_BASE}/students`} className="underline">
          {WEB_BASE}/students
        </a>
        …
      </p>
    </div>
  );
}
