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
};

export default config;
