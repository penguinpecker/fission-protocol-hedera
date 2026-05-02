import Link from "next/link";
import { Nav } from "@/components/Nav";
import { FissionLogo } from "@/components/FissionLogo";

const STRATEGIES = [
  {
    title: "Fixed yield",
    sub: "Buy PT",
    risk: "Low",
    desc: "Lock in guaranteed fixed APY. Buy PT at a discount, redeem 1:1 at maturity.",
  },
  {
    title: "Long yield",
    sub: "Buy YT",
    risk: "High",
    desc: "Leveraged bet on rising rates. Small capital, amplified returns.",
  },
  {
    title: "Split SY",
    sub: "Mint PT + YT",
    risk: "Medium",
    desc: "Deposit SY to mint equal PT + YT. Sell one side or LP with both.",
  },
];

export default function LandingPage() {
  return (
    <main className="min-h-screen">
      <Nav />

      <section className="mx-auto max-w-[1100px] px-10 pb-16 pt-20 text-center">
        <div className="mb-10 inline-block">
          <FissionLogo size={88} color="rgba(255,255,255,0.9)" strokeWidth={3.2} />
        </div>

        <div className="mb-7 inline-flex items-center gap-2 rounded-full border border-border bg-white/[0.03] px-3.5 py-1.5">
          <span className="size-[5px] animate-[pulse_2s_infinite] rounded-full bg-success" />
          <span className="text-xs font-medium tracking-wide text-textSec">Live on Hedera Mainnet</span>
        </div>

        <h1 className="mx-auto max-w-[700px] text-[64px] font-light leading-[1.05] tracking-[-2px]">
          Split yield.{" "}
          <span className="bg-gradient-to-br from-white to-silverDark bg-clip-text font-serif italic text-transparent">
            Trade time.
          </span>
        </h1>

        <p className="mx-auto mt-6 max-w-[500px] text-[17px] font-light leading-relaxed text-textSec">
          Tokenize future yield from SaucerSwap LPs, HBARX staking, and Bonzo lending into tradeable Principal and Yield tokens — Pendle V2 design, Hedera mainnet, audit-grade.
        </p>

        <div className="mt-10 flex justify-center gap-3">
          <Link
            href="/markets"
            className="rounded-xl bg-white px-9 py-[15px] text-[15px] font-semibold text-bg transition hover:opacity-90"
          >
            Explore markets
          </Link>
          <a
            href="https://github.com/penguinpecker/fission-protocol-hedera"
            target="_blank"
            rel="noreferrer"
            className="rounded-xl border border-borderHover px-7 py-[15px] text-[15px] font-medium text-textSec transition hover:bg-white/[0.03]"
          >
            View source
          </a>
        </div>

        <div className="mt-24">
          <div className="mb-14 flex items-center justify-center gap-3">
            <div className="h-px w-10 bg-border" />
            <h2 className="text-xs font-semibold uppercase tracking-[3px] text-textDim">How it works</h2>
            <div className="h-px w-10 bg-border" />
          </div>

          <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
            {STRATEGIES.map((s) => (
              <article
                key={s.title}
                className="rounded-2xl border border-border bg-bgCard p-7 text-left transition hover:border-borderHover"
              >
                <div className="mb-3 flex items-center gap-2.5">
                  <h3 className="text-lg font-semibold">{s.title}</h3>
                  <span className="rounded bg-white/[0.04] px-2 py-0.5 font-mono text-[10px] font-semibold uppercase tracking-wide text-textSec">
                    {s.risk}
                  </span>
                </div>
                <div className="mb-3 font-mono text-xs text-textDim">{s.sub}</div>
                <p className="text-sm font-light leading-relaxed text-textSec">{s.desc}</p>
              </article>
            ))}
          </div>
        </div>

        <footer className="mt-24 border-t border-border pt-12 pb-16">
          <div className="flex items-center justify-center gap-2 text-xs text-textDim">
            <FissionLogo size={14} color="#52525b" />
            <span>Fission Protocol · Pendle V2-faithful · audit-ready in Q3 2026</span>
          </div>
        </footer>
      </section>
    </main>
  );
}
