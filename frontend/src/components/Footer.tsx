import Link from "next/link";
import { FissionLogo } from "./FissionLogo";

const NAV = [
  {
    heading: "Protocol",
    links: [
      { href: "/markets", label: "Markets" },
      { href: "https://github.com/penguinpecker/fission-protocol-hedera", label: "Source", external: true },
      {
        href: "https://github.com/penguinpecker/fission-protocol-hedera/blob/main/docs/ECONOMICS.md",
        label: "Economics",
        external: true,
      },
      {
        href: "https://github.com/penguinpecker/fission-protocol-hedera/tree/main/audits",
        label: "Audits",
        external: true,
      },
    ],
  },
  {
    heading: "Legal",
    links: [
      { href: "/risks", label: "Risks" },
      { href: "/terms", label: "Terms of use" },
      { href: "/privacy", label: "Privacy" },
    ],
  },
  {
    heading: "Network",
    links: [
      // Ed25519-fixed redeploy 2026-05-22 — pointers updated to current addresses.
      { href: "https://hashscan.io/mainnet/contract/0x36ed8f34c9bfc0004f107153b1a16099f8910b58", label: "Market 0", external: true },
      { href: "https://hashscan.io/mainnet/contract/0x0000000000000000000000000000000000a00b4e", label: "Factory", external: true },
      { href: "https://hashscan.io/mainnet/contract/0x00000000000000000000000000000000009fd993", label: "Router (v3)", external: true },
      { href: "https://hashscan.io/mainnet/contract/0x00000000000000000000000000000000009fd984", label: "Zap", external: true },
      // MegaZap link intentionally omitted — contract is disabled in prod
      // (see README "Future work / MegaZap v2"). Restore when v2 redeploys.
      { href: "https://hashscan.io/mainnet/contract/0x00000000000000000000000000000000009fb089", label: "SY adapter", external: true },
    ],
  },
];

export function Footer() {
  return (
    <footer className="border-t border-border bg-bg">
      <div className="mx-auto max-w-[1440px] px-4 py-12 sm:px-6 sm:py-16 md:px-7">
        <div className="grid gap-8 sm:grid-cols-2 sm:gap-10 md:grid-cols-[1.4fr_1fr_1fr_1fr]">
          <div>
            <Link href="/" className="inline-flex items-center gap-2.5">
              <FissionLogo size={26} />
              <span className="text-[17px] font-semibold tracking-tight text-text">Fission</span>
            </Link>
            <p className="mt-4 max-w-[280px] text-[13px] leading-relaxed text-textSec">
              Tokenize the Yield. Fixed-rate and perpetual yield markets on Hedera.
            </p>
          </div>

          {NAV.map((col) => (
            <div key={col.heading}>
              <div className="mb-4 font-mono text-[10px] font-semibold uppercase tracking-[2px] text-textDim">
                {col.heading}
              </div>
              <ul className="space-y-2.5">
                {col.links.map((l) => (
                  <li key={l.label}>
                    {"external" in l && l.external ? (
                      <a
                        href={l.href}
                        target="_blank"
                        rel="noreferrer"
                        className="text-[13px] text-textSec transition hover:text-text"
                      >
                        {l.label}
                      </a>
                    ) : (
                      <Link href={l.href} className="text-[13px] text-textSec transition hover:text-text">
                        {l.label}
                      </Link>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>

        <div className="mt-12 flex flex-col items-start justify-between gap-4 border-t border-border pt-8 text-[12px] text-textDim sm:items-center md:flex-row md:mt-14">
          <span>Fission Protocol · Hedera mainnet · chain 295</span>
          <span>
            Not investment advice. Smart contracts can lose funds. Read{" "}
            <Link href="/risks" className="underline underline-offset-4 hover:text-text">
              the risks
            </Link>{" "}
            before trading.
          </span>
        </div>
      </div>
    </footer>
  );
}
