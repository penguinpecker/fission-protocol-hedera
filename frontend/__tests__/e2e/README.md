# Fission E2E browser tests

Playwright + mock EIP-1193 provider. Catches the bug class our Node-only
smoke (`scripts/smoke-e2e-all-routes.mjs`) misses: React errors, hooks
order, wallet picker logic, post-connect state churn.

## Quick start

```bash
cd frontend
npm run test:e2e          # headless, runs against https://www.fissionp.com
npm run test:e2e:headed   # same but you watch in Chromium
```

Override the target environment:

```bash
E2E_BASE_URL=http://localhost:3000 npm run test:e2e     # local dev
E2E_BASE_URL=https://fission-protocol-XYZ-penguinpeckers-projects.vercel.app npm run test:e2e   # preview deploy
```

## What's tested today

| File | Status | What it covers |
|---|---|---|
| `wallet-connect.spec.ts` | ✓ passes 1.6s against prod | EIP-6963 + injected detection, modal open, MetaMask click, account chip render — zero React-fatal errors |
| `routes-smoke.spec.ts` | ✓ passes 38s against prod | Every page (`/`, `/markets`, market overview, PT/YT/LP strategies, `/profile`) renders without React #300 / hooks-order violations |
| `sell-pt.spec.ts` | template — needs local validation | Connect → navigate to PT page → Sell tab → enter amount → click → assert success state. Tests REAL on-chain submission via mock-signed walletClient. |

**These two specs alone would have caught:**
- React #300 from the WalletConnectModal hooks-order regression
- The `instanceof Error` browser quirk (StatusError serialization) — IF the
  test exercised the catch path. Currently it doesn't; needs Phase 2 below.
- Any future modal/picker logic regression that breaks page render

## Architecture

```
__tests__/e2e/
├── playwright.config.ts        # configured at frontend/playwright.config.ts
├── mock-providers/
│   └── evm-mock.ts             # window.ethereum mock script (injected via addInitScript)
├── helpers/
│   ├── signer.ts               # Node-side viem walletClient + operator key loader
│   └── connect.ts              # bootstrapEvm() + error capture
├── wallet-connect.spec.ts
└── routes-smoke.spec.ts
```

**Signing path:**
- The page's mock provider gets `eth_sendTransaction` and `personal_sign` requests
- It delegates to `window.__fissionMockSign(method, params)` — exposed via
  Playwright's `context.exposeFunction`
- The Node-side handler signs with the operator's ECDSA key via
  `viem.privateKeyToAccount` and submits to Hashio
- **Key never crosses into the browser process**

**EIP-6963 announce:** the mock dispatches `eip6963:announceProvider` on
init, so wagmi's multi-injected discovery picks it up alongside any real
MetaMask. The picker's "Detected" badge fires correctly.

## Error filtering

Two-tier error model in `helpers/connect.ts`:

- `REACT_FATAL_PATTERNS` — Minified React errors, max-update-depth, hooks
  violations, hydration mismatches. These ALWAYS fail the test.
- `isExpectedNoise()` — CoinGecko CORS (real prod issue, separate fix),
  SIWE auth 4xx probes, MM lockdown noise, HashPack Protobuf init noise.
  Dropped silently.
- Anything else: either captured (default mode) or warned (strictMode).

Tests use `strictMode: true` for the per-route assertions so cosmetic
console noise doesn't break CI.

## What's NOT yet tested (templates exist; need validation against
   preview deploy)

### 1. Strategy transactions — `sell-pt.spec.ts` is the template

The pattern is established but needs iterative debug against the
preview deploy (where the new `data-testid` attrs exist):

1. `cd frontend && E2E_BASE_URL=https://<preview-url> npm run test:e2e:headed -- sell-pt.spec.ts`
2. Watch the browser. The failure is in one of:
   - WalletGate gating sub-pages (wagmi reconnect timing across navigation)
   - Tab button selector mismatch
   - MoneyInput testid placement
   - Action button state (disabled because of size-limit gate, allowance gate, etc.)
3. Adjust selectors / waits / amounts until green.

Once `sell-pt.spec.ts` passes, the same pattern duplicates for
`sell-yt.spec.ts`, `buy-pt.spec.ts`, etc. ~30 min each.

### Cost when fully wired
~$0.05-0.50 per strategy test in HBAR gas. Mitigation paths:
- Run on a dedicated test wallet with a small budget
- Cap concurrent runs in CI
- Add a `dryRun` mode to `evm-mock.ts` that returns a fake hash without
  forwarding to Hashio (UI-only assertions, no chain state)

### 2. Hedera-mode (HashPack-equivalent) mock

The DAppConnector is imported statically from `@hashgraph/hedera-wallet-
connect`. Replacing it requires either:

- A webpack alias in test mode (intercepts the import)
- A runtime monkey-patch (fragile)
- Building a fake wallet that registers a real WC v2 session

**To add:** the cleanest path is a `next.config.ts` alias under a test
env flag that swaps the DAppConnector for a Node-signing stub. Estimated
~3 hours including the stub's HAPI-protobuf encoding.

### 3. Synpress (real MetaMask extension)

`@synthetixio/synpress` drives the actual MetaMask extension in
Playwright. Catches MetaMask-specific quirks the mock can't (gas
estimation popups, network-switch prompts, real RPC behavior).

**To add:** ~2 hours setup, requires a dedicated test seed phrase
(NEVER reuse production). Run as a separate `test:e2e:real` script that
takes longer and isn't in the default CI run.

### 4. HashPack real-extension automation

No off-the-shelf equivalent of Synpress for HashPack. Would require
writing a custom Playwright extension-installer + popup-driver. Ballpark
1-2 days.

## CI integration (recommended next step)

```yaml
# .github/workflows/e2e.yml (sketch)
name: E2E
on: [pull_request]
jobs:
  e2e:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: '22' }
      - run: cd frontend && npm ci
      - run: cd frontend && npx playwright install --with-deps chromium
      - run: cd frontend && npm run test:e2e
        env:
          HEDERA_OPERATOR_KEY: ${{ secrets.E2E_OPERATOR_KEY }}
          E2E_BASE_URL: https://www.fissionp.com  # or preview URL per branch
```

The `E2E_OPERATOR_KEY` should be a **dedicated test key** with a small
HBAR budget, NOT the deployer key. Keep it separate from production
operator credentials.

## Cost considerations

Current suite (8 tests, render-only): **$0** — never submits transactions.

If/when strategy execution tests get added: ~$0.05-0.50 per test in HBAR
gas. A dry-run mock provider (above) avoids this entirely for CI; keep
the gas-burning version for nightly or manual runs only.

## Known gaps to fix

- CoinGecko price fetch is direct-from-browser → CORS errors in console.
  Should proxy through `/api/price/hbar`. Currently filtered as noise.
- No test for HashPack-mode (Hedera DAppConnector). Phase 2.
- No transaction execution tests. Phase 2 (with dry-run mock).
- No CI hook yet. Add `.github/workflows/e2e.yml` once secret is provisioned.

## Adding a new test

1. Add the test file under `__tests__/e2e/`.
2. Use `bootstrapEvm(context, page, { strictMode: true })` for render-only
   tests, default mode for transactional tests.
3. Target stable selectors: `data-testid` attrs preferred; role-based
   selectors second; text content third (most fragile).
4. Run `npm run test:e2e:headed -- your-spec.spec.ts` to debug visually.
