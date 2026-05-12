// Sanity check: encryptJson/decryptJson round-trip against Postgres pgcrypto.
import { decryptJson, encryptJson, isEncrypted } from '@wgc/db';

const original = {
  access_token: 'ya29.fake-access-token',
  refresh_token: '1//0fake-refresh-token',
  scope: 'https://www.googleapis.com/auth/calendar',
  token_type: 'Bearer',
  expiry_date: 1_900_000_000_000,
};

async function main() {
  const enc = await encryptJson(original);
  console.log('encrypted envelope keys:', Object.keys(enc));
  console.log('isEncrypted(enc):', isEncrypted(enc));
  console.log('ciphertext sample:', enc.ciphertext.slice(0, 32) + '…');

  const dec = await decryptJson<typeof original>(enc);
  const ok = JSON.stringify(dec) === JSON.stringify(original);
  console.log('round-trip ok:', ok);
  if (!ok) {
    console.error('expected', original);
    console.error('got', dec);
    process.exit(1);
  }

  const legacy = await decryptJson<typeof original>(original);
  console.log('legacy passthrough ok:', JSON.stringify(legacy) === JSON.stringify(original));
}

main().then(() => process.exit(0)).catch((e) => {
  console.error(e);
  process.exit(1);
});
