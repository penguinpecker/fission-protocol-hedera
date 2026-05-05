# Deploy + Verify Runbook (post-HTS-migration)

End-to-end: testnet deploy, full happy-path test on real HTS, HashScan verification, frontend wire-up.

---

## 0. Prerequisites

- Hedera testnet account with ≥ 50 HBAR (faucet at https://portal.hedera.com).
- ECDSA EVM private key exported from HashPack (Settings → Export Key → ECDSA, **NOT** ED25519 — Hedera EVM signers must be secp256k1).
- Foundry installed (`foundryup`).
- Hardhat installed in `contracts/` (`npm install` from contracts dir, used only for verification — Foundry handles deploys).

```bash
cd contracts && npm install   # installs hardhat-toolbox-viem for HashScan verify
```

---

## 1. Fill in `.env`

The repo root `.env` is git-ignored. Edit it directly:

```bash
HEDERA_NETWORK=testnet
HEDERA_OPERATOR_ID=0.0.YOUR_ACCOUNT_ID
HEDERA_OPERATOR_KEY=0xYOUR_ECDSA_PRIVATE_KEY

# Governance — for testnet you can leave as your operator EOA (not a Safe).
# For mainnet these MUST be contracts (Safe + Timelock); MainnetDeploy enforces.
FACTORY_ADMIN=0xYOUR_OPERATOR_EVM_ADDRESS
MARKET_ADMIN=0xYOUR_OPERATOR_EVM_ADDRESS
MARKET_TREASURY=0xYOUR_OPERATOR_EVM_ADDRESS
SY_ADMIN=0xYOUR_OPERATOR_EVM_ADDRESS

# Keeper — separate hot wallet
KEEPER_ADDRESS=0xKEEPER_EVM_ADDRESS
KEEPER_PRIVATE_KEY=0xKEEPER_ECDSA_KEY
```

Source it:
```bash
set -a && source .env && set +a
```

---

## 2. Pre-flight checks

```bash
cd contracts
forge script script/PreFlight.s.sol --rpc-url $HEDERA_TESTNET_RPC
```

This ABI-pings every pinned mainnet address (Stader oracle, SaucerSwap V2 NPM, V2 pool). On testnet most pings will fail because the addresses are mainnet-only — that's fine; the script logs which are missing. It serves as a sanity check on RPC connectivity.

---

## 3. Deploy

### Testnet

```bash
forge script script/Deploy.s.sol \
  --rpc-url $HEDERA_TESTNET_RPC \
  --broadcast \
  --slow \
  --gas-price 410000000000 \
  --private-key $HEDERA_OPERATOR_KEY
```

Flags:
- `--broadcast` actually sends the txs (without it, dry-run only).
- `--slow` waits for each tx to confirm before sending the next — required because Hedera's hashio RPC sometimes returns stale nonces under back-to-back sends.
- `--gas-price 410000000000` = 410 gwei. Hedera's effective gas price floor is ~410 gwei in HBAR-equivalent.

The script prints the deployed addresses:
```
== Logs ==
  factory deployed at 0x...
  router  deployed at 0x...
  sy_hbarx (testnet stub) at 0x...   // if applicable
  ...
```

**Cost estimate (testnet):**
| Operation | HBAR |
|---|---|
| Factory deploy | ~0.5 |
| Router deploy | ~0.3 |
| SY adapter deploy | ~0.5 + ~1 (createFungible for share token) |
| Each `factory.createMarket` | ~3 (3× HTS createFungible: PT, YT, LP) |
| **Total for v1 lineup (HBARX + V2-LP, 1 market each)** | **~10 HBAR** |

### Mainnet

```bash
forge script script/MainnetDeploy.s.sol \
  --rpc-url $HEDERA_MAINNET_RPC \
  --broadcast \
  --slow \
  --gas-price 410000000000 \
  --private-key $HEDERA_OPERATOR_KEY
```

Mainnet refuses to broadcast unless every privileged role address is a CONTRACT (Safe / Timelock). Provision those at https://multisig.hedera.foundation BEFORE running.

---

## 4. Verify on HashScan (Sourcify)

Hedera's HashScan uses [Sourcify](https://sourcify.dev) for contract verification. Two paths:

### Path A: hardhat-verify (recommended, scriptable)

```bash
cd contracts

# In hardhat.config.ts the network "hederaTestnet" is configured to use Sourcify.
npx hardhat verify --network hederaTestnet \
  $FACTORY_ADDRESS \
  "$FACTORY_ADMIN" "$MARKET_ADMIN" "$MARKET_TREASURY"

npx hardhat verify --network hederaTestnet $ROUTER_ADDRESS

npx hardhat verify --network hederaTestnet $SY_HBARX_ADDRESS \
  "0xHBARX_TESTNET_ADDR" "0xSTADER_ORACLE_ADDR" "$SY_ADMIN" "0"

# For per-market PT/YT/LP HTS tokens — they're HTS-native, NOT contract-verified.
# HashScan shows them as "Token" entries (not "Contract"), so there's no source
# to verify. Their metadata (name, symbol, decimals, treasury, keys) is on-chain
# and rendered by HashScan automatically from the HTS state.
```

### Path B: Sourcify direct upload

If `hardhat verify` fails (mismatched compiler settings, etc.), upload manually:

1. Go to https://sourcify.dev
2. Drop the contract's `out/<Name>.sol/<Name>.json` file (Foundry build output)
3. Drop ALL `src/**/*.sol` source files
4. Enter the deployed address + chain ID (296 for testnet, 295 for mainnet)
5. Sourcify checks the bytecode match and stores metadata.

HashScan auto-picks-up Sourcify-verified contracts within a few minutes.

### What gets verified

| Contract | Source-verifiable? |
|---|---|
| FissionFactory | ✅ |
| FissionMarket | ✅ |
| FissionMarketRewards | ✅ |
| ActionRouter | ✅ |
| SY_HBARX | ✅ |
| SY_SaucerSwapV2LP | ✅ |
| PT/YT/LP HTS tokens | n/a — HTS tokens, no source code; HashScan reads metadata from network state |
| SY share HTS tokens | n/a — same |

---

## 5. Sanity-check the deploy

After deploy + verify:

```bash
# Cast quick reads against the factory to confirm wiring.
cast call $FACTORY_ADDRESS "marketCount()(uint256)" --rpc-url $HEDERA_TESTNET_RPC
cast call $FACTORY_ADDRESS "marketAdmin()(address)" --rpc-url $HEDERA_TESTNET_RPC
```

For each market created post-deploy:
```bash
cast call $MARKET_ADDRESS "sy()(address)" --rpc-url $HEDERA_TESTNET_RPC
cast call $MARKET_ADDRESS "pt()(address)" --rpc-url $HEDERA_TESTNET_RPC  # HTS token
cast call $MARKET_ADDRESS "yt()(address)" --rpc-url $HEDERA_TESTNET_RPC  # HTS token (frozen)
cast call $MARKET_ADDRESS "lp()(address)" --rpc-url $HEDERA_TESTNET_RPC  # HTS token
cast call $MARKET_ADDRESS "expiry()(uint256)" --rpc-url $HEDERA_TESTNET_RPC
```

Then on HashScan: search for the PT/YT/LP token addresses — they should appear as **HTS Token** entries with the expected names ("Fission PT-HBARX", "fPT-HBARX" symbol, etc.) and treasury = market address.

---

## 6. Full happy-path E2E test (testnet)

This validates the entire HTS pipeline against real Hedera precompile (the mock has been our test surface; this is the first run on real HTS).

```bash
# A) Whitelist your test SY (skipping the 7d window via factory's grant role isn't
#    possible — for testnet, deploy the factory with no SY review window OR use
#    the Deploy.s.sol script which sets review window to 0 in dev profile).

# B) Create a market.
cast send $FACTORY_ADDRESS \
  "createMarket(address,uint256,int256,string)(uint256,address)" \
  $SY_HBARX_ADDRESS $((`date +%s` + 7776000)) 75000000000000000000 "TEST" \
  --value 3ether \
  --private-key $HEDERA_OPERATOR_KEY \
  --rpc-url $HEDERA_TESTNET_RPC

# Reads market id 0.
MARKET_0=$(cast call $FACTORY_ADDRESS "markets(uint256)(address)" 0 --rpc-url $HEDERA_TESTNET_RPC)

# C) Initialize with seed liquidity (admin must hold SY shares — get them via sy.deposit first).
# ... see MAINNET_DEPLOY.md for the seed flow.

# D) Test split → swap → merge happy path.
# E) Verify HashPack shows the PT/YT/LP tokens after associating.
```

**HashPack association test:**
1. Open HashPack → your testnet account → "Tokens" tab
2. Click "Associate" → paste the PT token address (e.g. `0x...PT_TOKEN`)
3. Repeat for YT and LP
4. Run a `market.split()` from your account
5. Tokens should appear in HashPack with the correct names ("Fission PT-HBARX" etc.)

If YT shows up frozen ✅ — that's the AMM-only design working. Trying to send YT → some other account from HashPack should fail with "ACCOUNT_FROZEN_FOR_TOKEN".

---

## 7. Frontend wire-up

After deploy, populate `frontend/.env.local`:

```bash
NEXT_PUBLIC_HEDERA_NETWORK=testnet
NEXT_PUBLIC_RPC_URL=https://testnet.hashio.io/api
NEXT_PUBLIC_MIRROR_NODE_URL=https://testnet.mirrornode.hedera.com
NEXT_PUBLIC_FACTORY_ADDRESS=0x...FROM_DEPLOY...
NEXT_PUBLIC_ROUTER_ADDRESS=0x...FROM_DEPLOY...
NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID=  # optional: free at cloud.reown.com
```

Run:
```bash
cd frontend
npm run dev
```

The `/markets` page reads `NEXT_PUBLIC_FACTORY_ADDRESS` and lists markets. Click into one to see the trade UI. Connect HashPack/Blade in EVM mode (or MetaMask configured for Hedera testnet, chain ID 296, RPC `https://testnet.hashio.io/api`).

---

## 8. Troubleshooting

| Symptom | Likely cause |
|---|---|
| `INSUFFICIENT_PAYER_BALANCE` on createMarket | Operator out of HBAR (each market = 3 HBAR for createFungible × 3 tokens). Top up. |
| `TOKEN_HAS_NO_FREEZE_KEY` on YT mint | Market wasn't given the freeze key. Check setTokens output — should show `keys[1] = makeKey(4, marketAddr)` for YT. |
| `ACCOUNT_FROZEN_FOR_TOKEN` on YT transfer | **Expected.** YT is frozen by design. Use `market.split` / `market.merge` to mint/burn YT, never raw transfer. |
| `ACCOUNT_FROZEN_FOR_TOKEN` on YT mint | Recipient was previously a YT holder, now frozen. `_mintYt` should auto-unfreeze; if it doesn't, check `_ytFrozen[recipient]` — should be true for repeat mints. |
| HashScan shows "Unverified" after `hardhat verify` | Check Sourcify status: https://sourcify.dev/api/v1/files/contracts/full_match/296/$ADDRESS/sources.json — wait 5 min, retry. |
| HashPack doesn't show PT/YT/LP balance | User must `Associate` the token in HashPack first (one-time per token, ~$0.05). |
| Frontend `useMarketDetails` returns undefined | `NEXT_PUBLIC_FACTORY_ADDRESS` not set or wrong network. Check browser console + RPC URL. |

---

## 9. Mainnet checklist (before broadcasting `MainnetDeploy.s.sol`)

- [ ] Safe (2-of-2) deployed at https://multisig.hedera.foundation, address pinned to `FACTORY_ADMIN`.
- [ ] OZ TimelockController (48h delay) deployed, controlled by Safe, address pinned to `MARKET_ADMIN`.
- [ ] Operator EOA holds ≥ 20 HBAR for the deploy + initial market creates.
- [ ] All four privileged-role env vars (FACTORY_ADMIN, MARKET_ADMIN, MARKET_TREASURY, SY_ADMIN) point at contracts (not EOAs). MainnetDeploy refuses to broadcast otherwise.
- [ ] External audit reports filed in `audits/external/` (HashEx, ChainSecurity at minimum).
- [ ] Stader exchange-rate ABI re-verified on the day of deploy (hits Stader's mainnet contract — fork test in `test/fork/SY_HBARX.fork.t.sol`).
- [ ] HashPack release notes mention the new HTS token IDs so users know what to associate.
- [ ] Frontend `NEXT_PUBLIC_*` switched to mainnet RPC + factory address; redeploy Vercel/Netlify.
- [ ] Keeper service running with mainnet config; `/health` returning 200.
- [ ] Bug bounty (Immunefi) live with mainnet contracts in scope.
