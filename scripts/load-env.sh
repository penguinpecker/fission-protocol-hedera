#!/usr/bin/env bash
# Source-this script. Loads `.env` from repo root, derives HEDERA_OPERATOR_KEY
# from SEED_PHRASE if needed, exports everything for the calling shell.
#
# USAGE:
#   source scripts/load-env.sh
#   forge script script/Deploy.s.sol --rpc-url $HEDERA_TESTNET_RPC --broadcast ...

set -e

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if [ ! -f "$REPO_ROOT/.env" ]; then
  echo "ERROR: $REPO_ROOT/.env not found — copy .env.example or create it."
  return 1 2>/dev/null || exit 1
fi

# Export everything in .env to the calling shell.
set -a
# shellcheck disable=SC1091
source "$REPO_ROOT/.env"
set +a

# If SEED_PHRASE is set and HEDERA_OPERATOR_KEY is empty, derive the key.
if [ -n "$SEED_PHRASE" ] && [ -z "$HEDERA_OPERATOR_KEY" ]; then
  if [ ! -d "$REPO_ROOT/scripts/node_modules" ]; then
    echo "First run — installing scripts/ deps (one-time, ~5 sec)..."
    (cd "$REPO_ROOT/scripts" && npm install --silent --no-audit --no-fund)
  fi
  echo "Deriving HEDERA_OPERATOR_KEY from SEED_PHRASE at path ${HEDERA_DERIVATION_PATH:-m/44\'/3030\'/0\'/0/0}..."
  export HEDERA_OPERATOR_KEY="$(node "$REPO_ROOT/scripts/derive-key.mjs")"
  if [ -z "$HEDERA_OPERATOR_KEY" ]; then
    echo "ERROR: key derivation failed. Check that SEED_PHRASE is a valid 12/24-word phrase."
    return 1 2>/dev/null || exit 1
  fi
  echo "✓ HEDERA_OPERATOR_KEY derived (${#HEDERA_OPERATOR_KEY} chars)."
fi

if [ -z "$HEDERA_OPERATOR_KEY" ]; then
  echo "ERROR: neither SEED_PHRASE nor HEDERA_OPERATOR_KEY is set in .env."
  return 1 2>/dev/null || exit 1
fi

echo "Loaded env: HEDERA_NETWORK=$HEDERA_NETWORK · HEDERA_OPERATOR_ID=$HEDERA_OPERATOR_ID"
