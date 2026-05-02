import type { Metadata } from "next";
import { Providers } from "@/components/Providers";
import "./globals.css";

export const metadata: Metadata = {
  title: "Fission Protocol — yield tokenization on Hedera",
  description:
    "Split yield-bearing tokens (HBARX, SaucerSwap LPs, Bonzo lending) into tradeable Principal and Yield tokens. Live on Hedera Mainnet.",
  metadataBase: new URL("https://fission.example"),
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className="dark">
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="" />
        <link
          rel="stylesheet"
          href="https://fonts.googleapis.com/css2?family=Outfit:wght@300;400;500;600;700&family=JetBrains+Mono:wght@400;500;600&family=Instrument+Serif:ital@0;1&display=swap"
        />
      </head>
      <body className="bg-bg font-sans text-text antialiased">
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
