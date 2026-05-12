#!/usr/bin/env bash
# Smoke test for Phase 1 — exercises the no-auth endpoints + verifies the API
# is up. Real auth-gated endpoints need a Supabase session token; that's
# covered by the (future) Vitest integration suite.
#
# Usage:  ./infra/scripts/smoke-test.sh [API_URL]
set -euo pipefail
API_URL="${1:-http://localhost:8787}"

echo "→ GET ${API_URL}/health"
curl -fsS "${API_URL}/health" | tee /dev/null
echo

echo "→ GET ${API_URL}/auth/health"
curl -fsS "${API_URL}/auth/health" | tee /dev/null
echo

echo "→ GET ${API_URL}/api/me  (expect 401: missing Bearer)"
http_status=$(curl -s -o /tmp/wgc-smoke.json -w "%{http_code}" "${API_URL}/api/me")
echo "  status: ${http_status}"
cat /tmp/wgc-smoke.json
echo
if [ "${http_status}" != "401" ]; then
  echo "FAIL: expected 401 from /api/me without auth, got ${http_status}"
  exit 1
fi

echo "Smoke test passed ✓"
