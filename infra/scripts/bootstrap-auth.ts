/**
 * Create Supabase Auth users for the seeded counsellors so dev login works
 * even when `auth.email.enable_signup = false`.
 *
 * Run via: pnpm dev:bootstrap-auth
 *
 * Idempotent: skips emails that already exist as auth users.
 */
import { createClient } from '@supabase/supabase-js';
import WebSocket from 'ws';

// supabase-js >=2.50 instantiates a Realtime client even when unused; on
// Node <22 there's no native WebSocket, so polyfill here for the bootstrap
// CLI script.
(globalThis as unknown as { WebSocket?: unknown }).WebSocket ??= WebSocket;

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
  console.error('NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set');
  process.exit(1);
}

// Mirrors the seed in packages/db/src/seed.ts.
const COUNSELLORS_TO_BOOTSTRAP = ['anubhav@wgc.in'];

async function main() {
  const supabase = createClient(SUPABASE_URL!, SERVICE_ROLE_KEY!, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  // List existing users (service role required).
  const { data: existing, error: listErr } = await supabase.auth.admin.listUsers();
  if (listErr) {
    console.error('Failed to list users:', listErr.message);
    process.exit(1);
  }
  const existingEmails = new Set(existing.users.map((u) => u.email?.toLowerCase()));

  for (const email of COUNSELLORS_TO_BOOTSTRAP) {
    if (existingEmails.has(email.toLowerCase())) {
      console.log(`  = ${email} already exists in auth`);
      continue;
    }
    const { error } = await supabase.auth.admin.createUser({
      email,
      email_confirm: true, // skip the confirm-email step in dev
    });
    if (error) {
      console.error(`  ✗ Failed to create ${email}: ${error.message}`);
    } else {
      console.log(`  + auth user created for ${email}`);
    }
  }

  console.log('Done. Now visit http://localhost:3001/login and request a magic link.');
}

main().catch((err) => {
  console.error('Bootstrap failed:', err);
  process.exit(1);
});
