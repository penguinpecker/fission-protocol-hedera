import type { NextConfig } from "next";

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
