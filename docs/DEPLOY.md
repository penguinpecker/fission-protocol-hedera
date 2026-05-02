# Deployment runbook

End-to-end deploy of Fission Protocol to Hedera testnet (chainId 296) and mainnet
(295). Foundry is the deploy tool; Hashio works for testnet, but production
mainnet should use Validation Cloud or Arkhia.

## Prerequisites

- Foundry installed (`forge`, `cast`).
- Hedera ECDSA account with HBAR for gas. Get testnet HBAR at
  https://portal.hedera.com.
- Multisig + Timelock addresses provisioned (production only). For testnet the
  deployer EOA can stand in.

## Environment

Copy `.env.example` to `.env` and fill:

```sh
HEDERA_OPERATOR_ID=0.0.XXXXXX
HEDERA_OPERATOR_KEY=0x...

HEDERA_TESTNET_RPC=https://testnet.hashio.io/api
HEDERA_MAINNET_RPC=https://mainnet.hashio.io/api  # use Validation Cloud / Arkhia in prod

# Governance (Safe addresses in production)
FACTORY_ADMIN=0x...
MARKET_ADMIN=0x...
MARKET_TREASURY=0x...

# Adapter wiring
HBARX_ADDRESS=0x00000000000000000000000000000000000cba44   # mainnet HBARX
STADER_ORACLE_ADDRESS=0x...                                # mainnet Stader
SY_ADMIN=$MARKET_ADMIN
KEEPER_ADDRESS=0x...                                       # the keeper EOA
```

## Deploy

```sh
cd contracts

# 1. Factory + Router
forge script script/Deploy.s.sol \
    --rpc-url $HEDERA_TESTNET_RPC \
    --private-key $HEDERA_OPERATOR_KEY \
    --broadcast --slow -vvv

# 2. SY_HBARX adapter
forge script script/DeploySY_HBARX.s.sol \
    --rpc-url $HEDERA_TESTNET_RPC \
    --private-key $HEDERA_OPERATOR_KEY \
    --broadcast --slow -vvv
```

Addresses land in `deployments/{chainId}.json`.

## Wire up the SY whitelist (7-day public review)

1. SY_REVIEWER calls `factory.proposeSY(syAddr)`.
2. Wait 7 days (contract-enforced — no bypass).
3. ADMIN calls `factory.confirmSY(syAddr)`.
4. ADMIN calls `factory.createMarket(syAddr, expiry, scalarRoot, "0")`.
5. ADMIN calls `market.initialize(syIn, ptIn, anchor, lnFeeRoot, reservePct)`
   with the seed liquidity.

## Frontend

Set in the frontend's deployment env (Vercel / Netlify / etc):

```sh
NEXT_PUBLIC_FACTORY_ADDRESS=0x... # from deployments/{chainId}.json
NEXT_PUBLIC_ROUTER_ADDRESS=0x...
NEXT_PUBLIC_RPC_URL=...
```

## Keeper

```sh
docker run -d --restart=always \
  -e KEEPER_PRIVATE_KEY=0x... \
  -e KEEPER_ADAPTER_HBARX_SY=0x... \
  -e KEEPER_ADAPTER_HBARX_STADER=0x... \
  -p 8080:8080 \
  fission-keeper
```

Health: `GET http://host:8080/health`. Metrics: `GET /metrics`.

## Verification (HashScan)

After mainnet deploy:

```sh
# Use forge-verify against Hedera's Sourcify endpoint
forge verify-contract <addr> <Contract> \
    --chain-id 295 \
    --verifier sourcify \
    --verifier-url https://server-verify.hashscan.io
```

## Post-deploy checks

- [ ] Factory `marketAdmin` and `marketTreasury` point at the Safe (not the deployer EOA).
- [ ] Deployer revokes itself from `DEFAULT_ADMIN_ROLE` via `beginDefaultAdminTransfer`.
- [ ] Keeper has `KEEPER_ROLE` on every SY.
- [ ] No EOA holds any privileged role on production contracts.
- [ ] Frontend shows the deployed Factory address; markets list loads.
- [ ] Health endpoint of keeper returns `status: "ok"`.
