#!/usr/bin/env bash
#
# check-sizes.sh — MDS-4 size-cliff guard.
#
# Builds the contracts and fails (exit 1) if ANY contract is within MIN_MARGIN
# bytes of the EIP-170 24,576-byte runtime limit, so a future change that
# silently creeps toward the cliff is caught in CI instead of at deploy time.
#
# Two-tier policy:
#   1. HARD limit: any contract whose runtime size exceeds 24,576 fails — always,
#      no exceptions (it is simply undeployable).
#   2. MARGIN warn-as-error: any contract with runtime_margin < MIN_MARGIN (500)
#      fails, EXCEPT contracts in ALLOWLIST. The allowlist exists for contracts
#      that are intrinsically near the limit by design (e.g. a deployer that
#      embeds another contract's full initcode) — for those the only enforceable
#      bound is the hard 24,576 ceiling, which tier 1 already covers.
#
# Run from the contracts/ dir (or anywhere — it cd's to its own location):
#     ./check-sizes.sh
# Requires: forge (Foundry) on PATH, jq.

set -euo pipefail

cd "$(dirname "$0")"

MIN_MARGIN=500
HARD_LIMIT=24576

# Contracts allowed to sit under MIN_MARGIN (still bound by the hard limit).
# RewardsMarketDeployer embeds the entire FissionRewardsMarket initcode, so it is
# permanently close to the ceiling — that is the documented design, and tier-1
# (hard limit) is the meaningful guard for it.
ALLOWLIST=("RewardsMarketDeployer")

is_allowlisted() {
    local name="$1"
    for a in "${ALLOWLIST[@]}"; do
        [[ "$name" == "$a" ]] && return 0
    done
    return 1
}

echo "==> Building with --sizes ..."
# `forge build --sizes --json` interleaves lint diagnostics (JSON-lines tagged
# with "$message_type") with the single sizes object on stdout. Keep only the
# line that is a sizes map: an object whose entries carry `runtime_size`.
SIZES_JSON="$(
    forge build --sizes --json 2>/dev/null \
        | jq -c 'select(type == "object"
                        and (length > 0)
                        and (to_entries[0].value | type == "object" and has("runtime_size")))' \
        | tail -1
)"

if [[ -z "$SIZES_JSON" ]]; then
    echo "FAIL: could not parse sizes JSON from 'forge build --sizes --json'." >&2
    exit 1
fi

fail=0

# Iterate name<TAB>runtime_size<TAB>runtime_margin
while IFS=$'\t' read -r name rsize rmargin; do
    [[ -z "$name" ]] && continue

    # Tier 1: hard EIP-170 ceiling — never bypassable.
    if (( rsize > HARD_LIMIT )); then
        echo "FAIL (over limit): $name runtime=$rsize > $HARD_LIMIT"
        fail=1
        continue
    fi

    # Tier 2: margin guard, with allowlist escape for intrinsic near-limit ones.
    if (( rmargin < MIN_MARGIN )); then
        if is_allowlisted "$name"; then
            echo "WARN (allowlisted near-limit): $name runtime=$rsize margin=$rmargin (< $MIN_MARGIN)"
        else
            echo "FAIL (margin < $MIN_MARGIN): $name runtime=$rsize margin=$rmargin"
            fail=1
        fi
    fi
done < <(echo "$SIZES_JSON" | jq -r 'to_entries[] | "\(.key)\t\(.value.runtime_size)\t\(.value.runtime_margin)"')

if (( fail != 0 )); then
    echo ""
    echo "==> size guard FAILED — a contract is over the limit or within ${MIN_MARGIN}B of it."
    exit 1
fi

echo "==> size guard OK — all contracts under ${HARD_LIMIT}B with >= ${MIN_MARGIN}B margin (allowlisted exceptions noted above)."
