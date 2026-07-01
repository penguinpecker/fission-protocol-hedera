import type { NextConfig } from "next";

// LP-2: Content-Security-Policy — REPORT-ONLY (do NOT enforce).
//
// This policy ships as `Content-Security-Policy-Report-Only` (see the header
// block below). It MUST stay report-only. Enforcing it (attempted 2026-05-30)
// broke the wallet: the Hedera SDK connects DIRECTLY to *.swirldslabs.com
// consensus nodes during a signed tx's receipt/health query, and those calls
// (plus Google Fonts) were blocked under enforcement → the signature prompt
// never appeared and the dApp was unusable.
//
// A browser-console scan only ever exercised the wallet-connect MODAL (HashPack
// connect → WC relay + verify iframe), NOT a real signed tx + receipt query, so
// it reported "clean" and gave a false sense that enforcement was safe. It is
// not. Report-only keeps full violation visibility without blocking any request,
// so the dApp works while we still see anything the policy would flag.
//
// Future maintainer: do NOT switch the header key to `Content-Security-Policy`.
// A clean modal scan is insufficient evidence — only flip to enforce after a
// FULL real-tx test (buy/sell + on-chain receipt query through *.swirldslabs.com)
// reports zero blocked requests, which it currently does not.
//
// connect-src must cover every origin the app talks to at runtime:
//   - 'self'                          : our own API routes
//   - Hashio RPC                      : eth_call / eth_sendRawTransaction
//   - Hedera Mirror Node              : account + tx history reads
//   - WalletConnect relay + verify    : wss relay, verify, web3modal, pulse,
//                                       explorer-api (HashPack / WC v2)
//   - CoinGecko                       : HBAR/USD price
//   - Supabase                        : REST + Realtime (https + wss)
//
// frame-ancestors: framing is intentionally OPEN to ALL origins (frame-ancestors *)
// so any wallet dapp browser / embedder (HashPack, other wallets, native webviews)
// can iframe the app. X-Frame-Options: DENY was likewise removed from vercel.json.
// SECURITY NOTE: this removes clickjacking protection — ANY site can embed this
// signing dApp and attempt overlay/clickjacking attacks. To lock it back down,
// set `frame-ancestors 'self' <trusted-origins>` and re-add an ENFORCED CSP header.
const CSP = [
  "default-src 'self'",
  // Next.js injects inline bootstrap scripts; 'unsafe-inline' is required until
  // a nonce-based setup is wired. 'unsafe-eval' kept for dev/source-map tooling.
  "script-src 'self' 'unsafe-inline' 'unsafe-eval' https://www.googletagmanager.com",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "img-src 'self' data: blob: https:",
  "font-src 'self' data: https://fonts.gstatic.com",
  [
    "connect-src 'self'",
    "https://mainnet.hashio.io",
    "https://mainnet-public.mirrornode.hedera.com",
    // Hedera SDK talks DIRECTLY to consensus nodes for receipt/health queries
    // during a signed tx (gRPC-web). Without these the wallet flow silently
    // fails with no signature prompt. The node set is large + changes, so a
    // wildcard is used (and the policy stays report-only — see below).
    "https://*.swirldslabs.com",
    "https://*.swirlds.com",
    "https://*.hedera.com",
    "https://*.supabase.co wss://*.supabase.co",
    "https://api.coingecko.com",
    // Google Analytics — gtag.js loader + measurement beacons.
    "https://www.googletagmanager.com",
    "https://www.google-analytics.com https://*.google-analytics.com https://*.analytics.google.com",
    "https://*.walletconnect.com wss://*.walletconnect.com",
    "https://*.walletconnect.org wss://*.walletconnect.org",
    "https://*.web3modal.org",
    "https://*.reown.com wss://*.reown.com",
  ].join(" "),
  "frame-src 'self' https://*.walletconnect.com https://*.walletconnect.org https://verify.walletconnect.org",
  "frame-ancestors *",
  "base-uri 'self'",
  "form-action 'self'",
  "object-src 'none'",
].join("; ");

const config: NextConfig = {
  reactStrictMode: true,
  // Allow WalletConnect to talk to its relay; explicit Hedera RPC origins.
  async headers() {
    return [
      {
        source: "/(.*)",
        headers: [
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          // LP-2: REPORT-ONLY. Enforcing it (2026-05-30) broke the wallet: the
          // Hedera SDK connects directly to *.swirldslabs.com consensus nodes
          // during a signed tx's receipt query, and those (plus Google Fonts)
          // were blocked -> no signature prompt. A browser scan only exercised
          // the wallet MODAL, not a real signed tx, so it missed this. Report-only
          // keeps the violation visibility without breaking the dApp; only flip to
          // enforce after a FULL real-tx (buy/sell + receipt) test reports clean.
          { key: "Content-Security-Policy-Report-Only", value: CSP },
        ],
      },
    ];
  },
  webpack: (cfg, { isServer }) => {
    // @hashgraph/hedera-wallet-connect@2.x imports `@hiero-ledger/sdk` — a
    // fork of @hashgraph/sdk. The packages export the same surface; aliasing
    // avoids shipping the SDK twice in the bundle and lets us keep using the
    // upstream package elsewhere.
    cfg.resolve = cfg.resolve ?? {};
    cfg.resolve.alias = {
      ...(cfg.resolve.alias ?? {}),
      "@hiero-ledger/sdk": "@hashgraph/sdk",
    };
    // The library has a wallet-side bundle that imports @reown/walletkit —
    // dApp code never touches it. Stub it out to avoid a "Module not found"
    // when webpack traces the import graph statically (even though our deep
    // imports avoid the wallet path at runtime).
    if (!isServer) {
      cfg.resolve.alias["@reown/walletkit"] = false;
    }
    return cfg;
  },
};

export default config;
