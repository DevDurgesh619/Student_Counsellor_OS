'use client';

import type { AuthProvider } from '@refinedev/core';

/**
 * apps/admin is deprecated. All authentication happens through apps/web
 * (counsellor + student UI on :3000). This provider returns "not
 * authenticated" so the Refine dashboard never renders; the page
 * components redirect to http://localhost:3000/login.
 *
 * Don't restore magic-link issuance here — it competes with apps/web's
 * properly-handled OAuth callback and breaks role routing.
 */
export const authProvider: AuthProvider = {
  login: async () => ({
    success: false,
    error: {
      name: 'AdminDeprecated',
      message: 'apps/admin is disabled. Sign in at http://localhost:3000/login.',
    },
    redirectTo: '/login',
  }),
  logout: async () => ({ success: true, redirectTo: '/login' }),
  check: async () => ({ authenticated: false, redirectTo: '/login' }),
  getIdentity: async () => null,
  onError: async (error) => ({ error }),
};
