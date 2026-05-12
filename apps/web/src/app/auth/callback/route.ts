import { NextResponse, type NextRequest } from 'next/server';
import { getServerSupabase } from '@/lib/supabase-server';
import { resolveDestination, type Me } from '@/lib/auth-destination';

const API_BASE = process.env.NEXT_PUBLIC_API_BASE_URL ?? 'http://localhost:8787';

/**
 * Google-OAuth landing endpoint. Runs server-side so the PKCE code exchange
 * happens exactly once per HTTP request (no React strict-mode double-mount,
 * no localStorage timing window). Sets the session cookie via the SDK and
 * 302s the browser to the destination computed from /api/me.
 */
export async function GET(request: NextRequest) {
  const code = request.nextUrl.searchParams.get('code');
  const next = request.nextUrl.searchParams.get('next');
  const errorDesc = request.nextUrl.searchParams.get('error_description');
  const origin = request.nextUrl.origin;

  if (errorDesc) {
    return NextResponse.redirect(
      `${origin}/login?error=${encodeURIComponent(errorDesc)}`,
    );
  }
  if (!code) {
    return NextResponse.redirect(
      `${origin}/login?error=${encodeURIComponent('Missing authorization code')}`,
    );
  }

  const supabase = getServerSupabase();
  const { error: exchErr } = await supabase.auth.exchangeCodeForSession(code);
  if (exchErr) {
    return NextResponse.redirect(
      `${origin}/login?error=${encodeURIComponent(exchErr.message)}`,
    );
  }

  // Read the freshly-set session to obtain a Bearer token for /api/me.
  const { data: sess } = await supabase.auth.getSession();
  if (!sess.session) {
    return NextResponse.redirect(
      `${origin}/login?error=${encodeURIComponent('Session did not persist')}`,
    );
  }

  let me: Me;
  try {
    const res = await fetch(`${API_BASE}/api/me`, {
      headers: { Authorization: `Bearer ${sess.session.access_token}` },
      cache: 'no-store',
    });
    if (!res.ok) throw new Error(`api/me ${res.status}`);
    me = (await res.json()) as Me;
  } catch (e) {
    return NextResponse.redirect(
      `${origin}/login?error=${encodeURIComponent(`api/me failed: ${(e as Error).message}`)}`,
    );
  }

  const dest = resolveDestination(me, '/', next) ?? '/';
  return NextResponse.redirect(`${origin}${dest}`);
}
