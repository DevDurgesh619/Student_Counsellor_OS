'use client';

import { useEffect } from 'react';

const WEB_LOGIN_URL =
  process.env['NEXT_PUBLIC_WEB_BASE_URL']?.replace(/\/$/, '') ?? 'http://localhost:3000';

/**
 * apps/admin is deprecated; all sign-in flows live on apps/web. This page
 * exists only to redirect anyone who lands here (bookmark, stale magic
 * link, etc.) over to the canonical login.
 */
export default function LoginRedirectPage() {
  useEffect(() => {
    window.location.replace(`${WEB_LOGIN_URL}/login`);
  }, []);

  return (
    <div className="mx-auto max-w-md pt-24 px-4 text-center text-sm text-muted-foreground">
      apps/admin is disabled. Redirecting to{' '}
      <a href={`${WEB_LOGIN_URL}/login`} className="underline">
        {WEB_LOGIN_URL}/login
      </a>
      …
    </div>
  );
}
