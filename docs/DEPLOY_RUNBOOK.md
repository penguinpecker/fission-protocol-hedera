# Fission Protocol — Deploy Runbook (UUPS-proxy + freeze-PT architecture)

Authoritative ordered deploy procedure for the **rebuilt** Fission Protocol on
Hedera testnet (chainId **296**) and mainnet (chainId **295**).

This supersedes the older `docs/DEPLOY.md` (which deployed the legacy
`ActionRouter` and non-proxy Factory). What changed in the rebuild:

- **FissionFactory / FissionPeriphery / FissionLens are now UUPS-upgradeable.**
  Each is deployed as `implementation → ERC1967Proxy(impl, initialize-calldata)`;
  consumers use the **proxy** address (stable across upgrades). The bare
  implementations only run `_disableInitializers()` in their constructors and are
  locked.
- **PT is freeze-by-default.** The user-facing routes go through the
  freeze-exempt `FissionPeriphery`, NOT the retired `ActionRouter` (which pulled
  user PT via `transferFrom` and would revert against frozen PT).
- **`market.setPeriphery(peripheryProxy)` MUST be called** (as the market admin)
  before any periphery-routed flow or frontend cutover — otherwise those flows
  silently break.

## Two deploy tools, one logic

| Tool | File | Use |
|---|---|---|
| **SDK (.mjs)** — AUTHORITATIVE | `scripts/deploy-rebuild-proxy.mjs` | The real testnet/mainnet broadcast. Uses the Hedera SDK `ContractCreateFlow` (FileService big-bytecode upload, 15M-gas-cap-aware, HTS value-forwarding, `maxAutoAssoc=-1`). |
| **Forge** — reference + dry-run | `contracts/script/Deploy.s.sol`, `contracts/script/MainnetDeploy.s.sol` | Canonical, readable proxy-deploy + wiring logic; fork / local-EVM dry-run. NOT used to broadcast to Hedera (revm mis-models HTS precompile value-forwarding). |

Both read the **same per-network external-address block** from
`contracts/script/NetworkConfig.sol` (Forge) / the `NETS` map in
`deploy-rebuild-proxy.mjs` (SDK), so the only thing that differs between testnet
and mainnet is that address block.

## Per-network external dependency config

| Field | Mainnet (295) — PINNED, verified | Testnet (296) — **TODO, unverified** |
|---|---|---|
| SaucerSwap V2 SwapRouter | `0x…003c437A` (`0.0.3949434`) | `0x…00159398` (`0.0.1414040`) **TODO** |
| SaucerSwap V2 NPM | `0x…003DDbb9` (`0.0.4053945`) | `0x…0013F618` (`0.0.1308184`) **TODO** |
| WHBAR system contract | `0x…00163B59` (`0.0.1456985`) | `0x…00003aD1` (`0.0.15057`) **TODO** |
| WHBAR HTS token | `0x…00163B5a` (`0.0.1456986`) | `0x…00003aD2` (`0.0.15058`) **TODO** |
| USDC HTS token | `0x…0006f89a` (`0.0.456858`) | `0x…00003316` (`0.0.13078`) **TODO / UNCONFIRMED** |

**Mainnet** values come from `deployments/295.json` (`external`) +
`script/MainnetAddresses.sol`, verified 2026-05-02.

**Testnet** values are research placeholders (SaucerSwap docs "Contract
Deployments" testnet section + Circle USDC docs, 2026-05-29) encoded as Hedera
long-zero EVM addresses. They are **NOT confirmed on-chain**. Notably:

- The testnet WHBAR system contract vs the separate **WhbarHelper**
  (`0.0.5286055`) must be disambiguated — the Periphery wants the wrap/unwrap
  system contract whose token is exactly token-1 (`15057 ↔ 15058`, mirroring the
  mainnet `163B59 ↔ 163B5a` pairing). Verify which one the live flow needs.
- Testnet **USDC** is UNCONFIRMED (sources gave conflicting IDs). A human must
  supply / confirm it via Circle docs + Mirror Node before broadcast.

**Both tools refuse to broadcast against an unverified network** unless
`ALLOW_UNVERIFIED_CONFIG=1` is explicitly set (Forge: env; SDK: env). Verify the
addresses with Mirror Node `GET /api/v1/tokens/{id}` + `GET /api/v1/contracts/{id}`,
update `NetworkConfig.sol` + the `NETS.testnet.external` block, flip `verified`
to `true`, THEN deploy.

## Environment (.env)

```sh
NEW_DEPLOYER_KEY=0x...        # ECDSA deployer (required)
NEW_DEPLOYER_ID=0.0.XXXXXXXX  # optional; auto-resolved via Mirror Node
HEDERA_MAINNET_RPC=https://mainnet.hashio.io/api   # or Validation Cloud / Arkhia in prod
HEDERA_TESTNET_RPC=https://testnet.hashio.io/api

# Governance / roles (default = deployer EVM on a solo deploy)
FACTORY_ADMIN=0x...           # DEFAULT_ADMIN_ROLE + UPGRADER_ROLE on the factory proxy
MARKET_ADMIN=0x...            # ADMIN_ROLE on each market (calls setPeriphery)
MARKET_TREASURY=0x...
SY_ADMIN=0x...
PERIPHERY_OWNER=0x...         # hot ops key (registerMarket / rescue / tuning); default deployer
UPGRADE_AUTHORITY=0x...       # UUPS upgrade authority for periphery+lens; default FACTORY_ADMIN
KEEPER_ADDRESS=0x...          # mainnet only (SY_HBARX postRate)

# Tuning
SY_REVIEW_WINDOW=0            # 0 to bootstrap immediately; 604800 (7d) for prod gov gating
MARKET_EXPIRY=...             # unix seconds; default now+90d
SCALAR_ROOT=5000000000000000000
MARKET_SUFFIX=USDC-WHBAR-YYYY-MM-DD
```

## Deploy ORDER (exact)

Each "brain" = **implementation → ERC1967Proxy(impl, initialize-calldata)**;
everything downstream uses the **proxy** address.

1. **StandardMarketDeployer** (plain helper).
2. **RewardsMarketDeployer** (plain helper).
3. **FissionFactory**: deploy impl, then proxy with
   `initialize(factoryAdmin, marketAdmin, marketTreasury, stdDeployer, rwdDeployer, syReviewWindow)`.
   Grants `DEFAULT_ADMIN_ROLE` + `UPGRADER_ROLE` + `SY_REVIEWER_ROLE` +
   `MARKET_CREATOR_ROLE` to `factoryAdmin`.
4. **FissionLens**: deploy impl, then proxy with `initialize(upgradeAuthority)`.
5. **SaucerSwapLPYieldSource** (SY adapter, plain ctor).
6. `sy.initShareToken{value: ~20 HBAR}` — creates the HTS fSY token + pre-approves the NPM.
7. `factory.proposeSY(sy)` then `factory.confirmSY(sy)`.
   - If `SY_REVIEW_WINDOW > 0`, `confirmSY` + everything after is a **separate
     post-window gov step** (7-day contract-enforced wait).
8. `factory.createRewardsMarket{value: ~30 HBAR}(sy, expiry, scalarRoot, suffix)`
   — decode the `MarketCreated` event for the market + PT/YT/LP addresses.
9. **FissionPeriphery**: deploy impl, then proxy with
   `initialize(whbarContract, whbarToken, usdc, v2Router, v3Npm, peripheryOwner, upgradeAuthority, [market])`.
   (Pre-registers the freshly created market in the init array.)
10. **`market.setPeriphery(peripheryProxy)`** — **as the MARKET ADMIN** (MDS-2).
    If the deployer is the market admin (solo / operator-first), the script does
    this automatically; if `MARKET_ADMIN` is a Safe/ThresholdKey, do it as a
    post-deploy gov action **before** registering / cutover.
11. **Assert read-backs** (the scripts do all of these and revert on mismatch):
    - `factory.SY_REVIEW_WINDOW() == syReviewWindow`
    - `factory.hasRole(DEFAULT_ADMIN_ROLE, factoryAdmin)` and `UPGRADER_ROLE`
    - `periphery.owner() == peripheryOwner`
    - `periphery.upgradeAuthority() != address(0)` (== `upgradeAuthority`)
    - `periphery.marketRegistered(market) == true`
    - `market.periphery() == peripheryProxy`
    - PT was created **WITH a freeze key** (Mirror Node `getTokenInfo`)

### Commands

```sh
# Forge dry-run (NO broadcast — validates proxy + wiring logic on a fork):
cd contracts
forge script script/MainnetDeploy.s.sol --rpc-url $HEDERA_MAINNET_RPC -vvv      # mainnet
forge script script/Deploy.s.sol        --rpc-url $HEDERA_TESTNET_RPC -vvv      # testnet brains
#   testnet additionally needs ALLOW_UNVERIFIED_CONFIG=1 once addresses are set.

# Local logic check (HTS mocked at 0x167), full deploy-order + wiring + asserts:
forge test --match-contract DeployScriptsTest -vv

# SDK dry-run (prints the resolved plan, sends NOTHING):
cd scripts
NETWORK=mainnet node deploy-rebuild-proxy.mjs
NETWORK=testnet ALLOW_UNVERIFIED_CONFIG=1 node deploy-rebuild-proxy.mjs

# SDK broadcast (the real deploy) — only when ready:
NETWORK=mainnet node deploy-rebuild-proxy.mjs --execute
```

## IRREVERSIBLE / one-way steps — double-check before running

- **`sy.initShareToken`** — creates the HTS fSY token (one-shot, costs HBAR).
- **`factory.confirmSY`** — after the review window, whitelists the SY.
- **`createRewardsMarket` / `createMarket`** — mints the HTS **PT / YT / LP**
  tokens (freeze keys baked in at creation; cannot be added later).
- **`factory.renounceRole(DEFAULT_ADMIN_ROLE, …)`** — REVERTS by design (no
  governance brick); admin handoff is **grant-then-revoke**, never renounce.
- **Operator-last handoff** — revoking the deployer EOA from the admin/upgrader
  roles. Do this **only at the very end**, after every read-back + smoke passes.

## Post-deploy verification checklist

- [ ] `deployments/{chainId}.json` lists `factory`, `periphery`, `lens` as the
      **proxy** addresses (plus `*Impl` for verification), the SY adapter, and the
      market + PT.
- [ ] All 7 read-back assertions in step 11 hold (scripts revert otherwise).
- [ ] `market.periphery() == peripheryProxy` (MDS-2 wiring confirmed).
- [ ] PT freeze key present (Mirror Node `GET /api/v1/tokens/{ptId}` →
      `freeze_key.key` non-null); YT freeze key present; **LP has NO freeze key**.
- [ ] Periphery `marketRegistered(market) == true`; SY adapter approvals primed.
- [ ] Seed liquidity initialized on the market (anchor / lnFee / reserve set).
- [ ] Smoke each periphery route (zapHbarToSy, buy PT/YT/LP, sell PT/YT/LP via
      operator, unzapSyToHbar) on the live network.
- [ ] Verify impl **and** proxy on HashScan via Sourcify (chain 295/296).
      `via_ir` output may not match Sourcify recompile for the deployer-pattern /
      embedded-bytecode contracts — fall back to manual HashScan UI for those.
- [ ] Keeper holds `KEEPER_ROLE` on SY_HBARX (mainnet; NOT for the V2 LP SY).
- [ ] Frontend env updated: `NEXT_PUBLIC_FACTORY_ADDRESS`,
      `NEXT_PUBLIC_PERIPHERY_ADDRESS`, `NEXT_PUBLIC_LENS_ADDRESS`
      (the legacy `NEXT_PUBLIC_ROUTER_ADDRESS` is RETIRED).
- [ ] **Operator-last handoff**: deployer EOA revoked from every privileged role;
      the Safe / Hedera ThresholdKey holds `DEFAULT_ADMIN_ROLE` + `UPGRADER_ROLE`
      (factory), `upgradeAuthority` (periphery + lens), and market `ADMIN_ROLE`.

## What can only be validated by a real testnet run

- The **testnet external addresses** (SaucerSwap V2 router/NPM, WHBAR
  contract/token, USDC) — all marked TODO. A human must verify each via Mirror
  Node before flipping `verified=true`.
- **HTS value-forwarding** through `initShareToken` / `setTokens` (the precompile
  child-tx fee behaviour) — only the SDK path exercises this correctly; the
  Forge dry-run mocks the precompile.
- **PT freeze key on real HTS** — the local dry-run asserts it via the mock; the
  authoritative check is Mirror Node `getTokenInfo` after the real
  `createRewardsMarket`.
- **ContractCreateFlow gas sizing** per contract under the 15M cap on live
  consensus (gas values in the SDK script are estimates).
```
