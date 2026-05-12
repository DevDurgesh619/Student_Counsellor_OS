/**
 * Bootstrap a counsellor row. Run once after migration 0009 wiped the seed
 * data, so /api/me can resolve your Gmail to a counsellor role.
 *
 * Usage:
 *   pnpm tsx infra/scripts/seed-counsellor.ts --email you@gmail.com --name "Anubhav (WGC)"
 *
 * The email must match the Google account you'll sign in with at /login.
 * Case is normalised to lowercase for matching consistency.
 */
import { counsellors, db } from '@wgc/db';
import { eq } from 'drizzle-orm';

function arg(name: string): string | undefined {
  const idx = process.argv.indexOf(`--${name}`);
  if (idx === -1 || idx === process.argv.length - 1) return undefined;
  return process.argv[idx + 1];
}

async function main() {
  const email = arg('email')?.toLowerCase();
  const name = arg('name');
  const phone = arg('phone') ?? null;

  if (!email || !name) {
    console.error('Usage: pnpm tsx infra/scripts/seed-counsellor.ts --email <gmail> --name "<full name>" [--phone <phone>]');
    process.exit(1);
  }

  const existing = (
    await db.select().from(counsellors).where(eq(counsellors.email, email)).limit(1)
  )[0];
  if (existing) {
    console.log(`Counsellor already exists: ${existing.id} (${existing.email})`);
    process.exit(0);
  }

  const inserted = await db
    .insert(counsellors)
    .values({
      fullName: name,
      email,
      phone,
      status: 'active',
    })
    .returning({ id: counsellors.id, email: counsellors.email });
  console.log('Seeded counsellor:', inserted[0]);
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
