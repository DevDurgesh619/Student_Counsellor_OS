import { sql } from 'drizzle-orm';
import { loadEnv } from '@wgc/config';
import { db } from './client.js';

/**
 * At-rest encryption of OAuth refresh tokens via Postgres `pgcrypto`.
 *
 * The plaintext is an arbitrary JSON object (the Google OAuth token resource);
 * we serialise → encrypt with `pgp_sym_encrypt(text, key)` → base64-encode the
 * resulting bytea → store as `{ ciphertext: "..." }` inside the existing
 * `jsonb` column. This avoids a schema change and keeps the envelope readable
 * (an unencrypted legacy row has no `ciphertext` key, so decryption can fall
 * back transparently during migration).
 *
 * The encryption key comes from WGC_TOKEN_ENCRYPTION_KEY. The key never leaves
 * Postgres' query plan — it's parameterised, not interpolated.
 */
export type EncryptedEnvelope = { ciphertext: string };

function getKey(): string {
  const env = loadEnv();
  if (!env.WGC_TOKEN_ENCRYPTION_KEY) {
    throw new Error(
      'WGC_TOKEN_ENCRYPTION_KEY is not set; cannot encrypt/decrypt OAuth tokens',
    );
  }
  return env.WGC_TOKEN_ENCRYPTION_KEY;
}

export async function encryptJson<T>(value: T): Promise<EncryptedEnvelope> {
  const key = getKey();
  const plaintext = JSON.stringify(value);
  const rows = (await db.execute(sql`
    SELECT encode(pgp_sym_encrypt(${plaintext}::text, ${key}::text), 'base64') AS ct
  `)) as unknown as { rows: Array<{ ct: string }> };
  const ct = rows.rows[0]?.ct;
  if (!ct) throw new Error('Encryption produced no ciphertext');
  return { ciphertext: ct };
}

export async function decryptJson<T>(envelope: unknown): Promise<T> {
  if (envelope && typeof envelope === 'object' && 'ciphertext' in envelope) {
    const ct = (envelope as EncryptedEnvelope).ciphertext;
    const key = getKey();
    const rows = (await db.execute(sql`
      SELECT pgp_sym_decrypt(decode(${ct}::text, 'base64'), ${key}::text) AS pt
    `)) as unknown as { rows: Array<{ pt: string }> };
    const pt = rows.rows[0]?.pt;
    if (!pt) throw new Error('Decryption returned empty plaintext');
    return JSON.parse(pt) as T;
  }
  // Legacy unencrypted row — accept once, callers re-write it encrypted.
  return envelope as T;
}

export function isEncrypted(value: unknown): boolean {
  return Boolean(value && typeof value === 'object' && 'ciphertext' in (value as object));
}
