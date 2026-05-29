import type { NextConfig } from "next";

// LP-2: Content-Security-Policy — ENFORCED.
//
// Verified clean (zero violations / zero blocked requests) via browser console
// across home / markets / market-detail / profile + the full wallet-connect modal
// flow (HashPack connect → WC relay + verify iframe) on 2026-05-30, then flipped
// from report-only to enforce.
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
// frame-ancestors 'none' is the CSP-level equivalent of X-Frame-Options DENY
// (and supersedes it in modern browsers) — blocks clickjacking via iframes.
const CSP = [
  "default-src 'self'",
  // Next.js injects inline bootstrap scripts; 'unsafe-inline' is required until
  // a nonce-based setup is wired. 'unsafe-eval' kept for dev/source-map tooling.
  "script-src 'self' 'unsafe-inline' 'unsafe-eval'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: https:",
  "font-src 'self' data:",
  [
    "connect-src 'self'",
    "https://mainnet.hashio.io",
    "https://mainnet-public.mirrornode.hedera.com",
    "https://*.supabase.co wss://*.supabase.co",
    "https://api.coingecko.com",
    "https://*.walletconnect.com wss://*.walletconnect.com",
    "https://*.walletconnect.org wss://*.walletconnect.org",
    "https://*.web3modal.org",
    "https://*.reown.com wss://*.reown.com",
  ].join(" "),
  "frame-src 'self' https://*.walletconnect.com https://*.walletconnect.org https://verify.walletconnect.org",
  "frame-ancestors 'none'",
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
          // LP-2: ENFORCED (verified clean via browser console before flipping).
          { key: "Content-Security-Policy", value: CSP },
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
