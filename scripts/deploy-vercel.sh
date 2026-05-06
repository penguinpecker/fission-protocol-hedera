#!/bin/bash
# One-shot Vercel deploy helper for the Fission frontend.
#
# Prereqs:
#   - vercel CLI installed and logged in (`vercel whoami` works)
#   - frontend/.env.local populated with all 13 env vars
#
# Flow:
#   1. Link the frontend dir to a Vercel project (interactive first run; cached after).
#   2. Sync every var from .env.local to Vercel's `production` + `preview` envs.
#      Server-only vars (no NEXT_PUBLIC_ prefix) are marked as encrypted.
#   3. Run `npm run build` locally to surface any compile error before pushing.
#   4. Deploy preview by default; pass `prod` as the first arg for production.
#
# Usage:
#   bash scripts/deploy-vercel.sh           # preview deploy
#   bash scripts/deploy-vercel.sh prod      # production deploy
#
set -euo pipefail
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO/frontend"

if ! command -v vercel >/dev/null 2>&1; then
  echo "Install Vercel CLI: npm i -g vercel" >&2
  exit 1
fi
if ! vercel whoami >/dev/null 2>&1; then
  echo "Run \`vercel login\` first." >&2
  exit 1
fi
if [ ! -f .env.local ]; then
  echo ".env.local missing — populate it before deploying." >&2
  exit 1
fi

# 1. Link (idempotent — only prompts on first run).
if [ ! -d .vercel ]; then
  echo "==> Linking project (interactive on first run)…"
  vercel link
fi

# 2. Push env vars. Read .env.local once, push each var to all 3 environments.
echo "==> Syncing .env.local → Vercel project envs…"
while IFS='=' read -r key value; do
  [[ -z "$key" || "$key" =~ ^# ]] && continue
  # Strip surrounding quotes if any
  value="${value#\"}"
  value="${value%\"}"
  for env in production preview development; do
    # `vercel env rm` returns non-zero if the var doesn't exist yet — ignore.
    vercel env rm "$key" "$env" -y >/dev/null 2>&1 || true
    printf '%s' "$value" | vercel env add "$key" "$env" >/dev/null
    echo "  ✓ $key → $env"
  done
done < <(grep -E "^[A-Z]" .env.local)

# 3. Local build sanity check.
echo "==> Local build sanity check…"
npm run build

# 4. Deploy.
mode="${1:-preview}"
if [ "$mode" = "prod" ] || [ "$mode" = "production" ]; then
  echo "==> Deploying to PRODUCTION…"
  vercel deploy --prod --yes
else
  echo "==> Deploying preview…"
  vercel deploy --yes
fi
