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
      { href: "https://hashscan.io/mainnet/contract/0xfa903b938b3bbb0d2836010e5f45edc95fd08a6d", label: "Market 0", external: true },
      { href: "https://hashscan.io/mainnet/contract/0x00000000000000000000000000000000009fb0b3", label: "Factory", external: true },
      { href: "https://hashscan.io/mainnet/contract/0x00000000000000000000000000000000009fdf89", label: "Router (v3)", external: true },
      { href: "https://hashscan.io/mainnet/contract/0x00000000000000000000000000000000009fd984", label: "Zap", external: true },
      // MegaZap link intentionally omitted — contract is disabled in prod
      // (see README "Future work / MegaZap v2"). Restore when v2 redeploys.
      { href: "https://hashscan.io/mainnet/contract/0x00000000000000000000000000000000009fdf8c", label: "MegaZap", external: true },
      { href: "https://hashscan.io/mainnet/contract/0x00000000000000000000000000000000009fb089", label: "SY adapter", external: true },
    ],
  },
];

export function Footer() {
  return (
    <footer className="border-t border-border bg-bg">
      <div className="mx-auto max-w-[1440px] px-7 py-16">
        <div className="grid gap-10 md:grid-cols-[1.4fr_1fr_1fr_1fr]">
          <div>
            <Link href="/" className="inline-flex items-center gap-2.5">
              <FissionLogo size={26} />
              <span className="text-[17px] font-semibold tracking-tight text-text">Fission</span>
            </Link>
            <p className="mt-4 max-w-[280px] text-[13px] leading-relaxed text-textSec">
              Yield tokenization on Hedera. Pendle V2-faithful math, HTS-native PT/YT, governed by a 2-of-2 ThresholdKey behind a 48-hour Timelock.
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

        <div className="mt-14 flex flex-col items-center justify-between gap-4 border-t border-border pt-8 text-[12px] text-textDim md:flex-row">
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
