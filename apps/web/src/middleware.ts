import { NextResponse, type NextRequest } from 'next/server';

/**
 * Forwards the request pathname as `x-pathname` so server components (the
 * root layout's auth gate) can compute role-aware redirects. Deliberately
 * logic-free — no auth checks here, no cookie writes. Session cookies are
 * set by /auth/callback/route.ts and read by the root layout.
 */
export function middleware(request: NextRequest) {
  const headers = new Headers(request.headers);
  headers.set('x-pathname', request.nextUrl.pathname);
  return NextResponse.next({ request: { headers } });
}

export const config = {
  // Skip Next internals + static files; everything else (including /api/* on
  // the web app itself if we ever add any) flows through.
  matcher: ['/((?!_next/static|_next/image|favicon.ico|.*\\..*).*)'],
};
