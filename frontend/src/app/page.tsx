import Link from "next/link";
import { Nav } from "@/components/Nav";
import { Footer } from "@/components/Footer";
import { FissionLogo } from "@/components/FissionLogo";
import { HeroCta } from "@/components/HeroCta";
import { LockIcon, BoltIcon, BranchIcon, ShieldIcon, FlowIcon, ChainIcon } from "@/components/Icons";

const STRATEGIES = [
  {
    id: "pt",
    title: "Buy PT",
    sub: "Fixed yield, no surprises",
    risk: "Low risk",
    riskTone: "text-success",
    Icon: LockIcon,
    summary:
      "Lock in a known APY today. Buy PT at a discount and redeem 1:1 for SY at maturity. Your return is decided at buy time and is paid by YT speculators on the other side of the trade.",
    example: [
      ["Buy", "1 PT for 0.985 SY"],
      ["Hold", "90 days, no action needed"],
      ["At expiry", "redeem → 1 SY"],
      ["Realised", "+1.5% over 90d ≈ 6% APY"],
    ],
    pickIf: "You want a CD-like return on your SaucerSwap V2 LP exposure.",
  },
  {
    id: "yt",
    title: "Buy YT",
    sub: "Leveraged exposure to V3 fees",
    risk: "High risk",
    riskTone: "text-warning",
    Icon: BoltIcon,
    summary:
      "Pay a premium today, claim USDC + WHBAR continuously as the SY's V3 NFT earns fees. YT does NOT expire in our design — it keeps earning forever.",
    example: [
      ["Buy", "$100 of YT @ 1.5% implied"],
      ["Best", "V3 over-performs → +150%"],
      ["Worst", "V3 under-performs → −67%"],
      ["After expiry", "YT keeps earning"],
    ],
    pickIf: "You think SaucerSwap V2 trading volume will exceed expectations.",
  },
  {
    id: "split",
    title: "Split SY",
    sub: "Mint both halves, no fee",
    risk: "Neutral",
    riskTone: "text-textSec",
    Icon: BranchIcon,
    summary:
      "1 SY in, 1 PT + 1 YT out. Pure 1:1 mint with no AMM trade. Sell one side for SY, hedge, or LP both halves into the AMM and earn 99% of swap fees.",
    example: [
      ["Deposit", "1 SY"],
      ["Receive", "1 PT + 1 YT"],
      ["LP play", "earn 99% of AMM fees"],
      ["Hedge play", "sell PT, keep YT"],
    ],
    pickIf: "You're a market maker or want full control over both legs.",
  },
];

const STREAMS = [
  {
    id: "v3",
    title: "Stream B — SaucerSwap V2 swap fees",
    subtitle: "100% to YT holders",
    rate: "0.3% per V3 trade",
    description:
      "When traders swap WHBAR↔USDC on SaucerSwap, the V3 pool charges 0.3%. Our SY's NFT collects its pro-rata share. Every harvest, the fees flow as USDC + WHBAR to YT holders proportional to YT balance — not to LPs, not to the protocol.",
  },
  {
    id: "amm",
    title: "Stream A — Fission AMM swap fees",
    subtitle: "99% to LPs, 1% to treasury",
    rate: "~0.03% per Fission trade",
    description:
      "When traders swap PT↔SY on our AMM, we charge a small logit-curve fee. After our 2026-05-10 update, 99% of that fee compounds back into LP token value. The protocol's only revenue is the 1% treasury cut.",
  },
];

const FAQ = [
  {
    q: "Is this complicated?",
    a: "No. If you want a fixed APY on your SaucerSwap LP exposure, click Buy PT and forget it. The complexity matters only when you're choosing between roles.",
  },
  {
    q: "What if I lose my PT before maturity?",
    a: "PT is an HTS token in your wallet. Standard self-custody — losing access to your wallet means losing access to the position. Not protocol-recoverable.",
  },
  {
    q: "Why does YT not go to zero at expiry?",
    a: "Our SY uses a reward-streaming pattern: exchangeRate stays at 1e18 forever, the V3 NFT keeps earning fees indefinitely. YT remains a perpetual claim on those fees. Standard rate-bearing markets do retire YT at expiry; ours does not.",
  },
  {
    q: "Who controls the protocol?",
    a: "After multisig handoff, all admin-gated functions are owned by a 2-of-2 Hedera ThresholdKey wrapped behind a 48-hour OZ TimelockController. No single signer can touch funds without a 48h public window.",
  },
  {
    q: "Has this been audited?",
    a: "Two internal audit passes complete (24 + 9 findings, all H/M closed). External audit is on the path before the next chain expansion. Read the full audit notes in the repo.",
  },
  {
    q: "How is this different from staking HBARX?",
    a: "Staking HBARX gives you the full variable yield. Splitting separates yield from principal — you can sell the principal half (PT) for cash up front, or buy more yield exposure (YT) without touching principal. Two different products with different risk shapes.",
  },
];

export default function LandingPage() {
  return (
    <main className="min-h-screen overflow-hidden">
      <Nav />

      <Hero />
      <MechanicsSection />
      <StrategiesSection />
      <StreamsSection />
      <SecuritySection />
      <FaqSection />
      <Footer />
    </main>
  );
}

/* ---------------------------------------------------------------- HERO */

function Hero() {
  return (
    <section className="relative overflow-hidden border-b border-border">
      <BgGradient />
      <div className="relative mx-auto flex max-w-[1180px] flex-col items-center px-4 pb-20 pt-14 text-center sm:px-6 sm:pb-24 sm:pt-20">
        <div className="mb-10 animate-[fadeUp_0.6s_ease-out_both] sm:mb-12">
          <AtomVisual />
        </div>

        <h1 className="animate-[fadeUp_0.6s_ease-out_0.2s_both] text-[44px] font-light leading-[1.05] tracking-[-1.5px] sm:text-[68px] sm:tracking-[-2.5px] md:text-[88px]">
          Split yield.{" "}
          <span className="bg-gradient-to-br from-white to-silverDark bg-clip-text font-serif italic text-transparent">
            Trade time.
          </span>
        </h1>

        <p className="mt-6 max-w-[620px] animate-[fadeUp_0.6s_ease-out_0.3s_both] text-[15px] font-light leading-[1.55] text-textSec sm:mt-7 sm:text-[18px]">
          Tokenize the Yield. Split any yield-bearing position into a
          fixed-rate Principal Token and a perpetual Yield Token — HTS-native
          on Hedera, governed by a 2-of-2 ThresholdKey behind a 48-hour Timelock.
        </p>

        <div className="mt-8 flex animate-[fadeUp_0.6s_ease-out_0.4s_both] flex-wrap justify-center gap-3 sm:mt-10">
          <HeroCta />
          <Link
            href="/whitepaper"
            className="rounded-xl border border-borderHover px-6 py-[13px] text-[14px] font-medium text-text transition hover:bg-white/[0.05] sm:px-7 sm:py-[15px] sm:text-[15px]"
          >
            Whitepaper
          </Link>
        </div>

        <ul className="mt-12 grid w-full max-w-[840px] grid-cols-2 gap-px overflow-hidden rounded-2xl border border-border bg-border sm:mt-16 md:grid-cols-4">
          {[
            ["Logit-curve", "AMM"],
            ["HTS-native", "PT / YT / LP"],
            ["99 / 1", "LP / treasury split"],
            ["48h", "timelock window"],
          ].map(([k, v]) => (
            <li key={k} className="bg-bgCard px-5 py-5 text-left">
              <div className="text-[10px] font-semibold uppercase tracking-[2px] text-textDim">{v}</div>
              <div className="mt-1.5 font-mono text-[15px] text-text">{k}</div>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}

function BgGradient() {
  return (
    <>
      <div
        aria-hidden
        className="pointer-events-none absolute -top-40 left-1/2 h-[520px] w-[920px] -translate-x-1/2 rounded-[50%] bg-[radial-gradient(ellipse_at_center,rgba(125,211,252,0.12),transparent_60%)] blur-2xl"
      />
      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-0 top-0 h-px bg-[linear-gradient(90deg,transparent,rgba(255,255,255,0.18),transparent)]"
      />
    </>
  );
}

function AtomVisual() {
  return (
    <div className="relative size-[140px]">
      <FissionLogo size={140} color="rgba(255,255,255,0.95)" strokeWidth={2.6} animate />
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 animate-[pulseGlow_3.5s_ease-in-out_infinite] rounded-full blur-2xl"
        style={{ background: "radial-gradient(circle, rgba(125,211,252,0.28), transparent 60%)" }}
      />
    </div>
  );
}

/* ------------------------------------------------------- MECHANICS */

function MechanicsSection() {
  return (
    <section className="border-b border-border">
      <div className="mx-auto max-w-[1180px] px-4 py-16 sm:px-6 sm:py-24">
        <SectionLabel>The mechanic</SectionLabel>
        <h2 className="mx-auto mb-12 max-w-[760px] text-center text-[28px] font-light leading-[1.1] tracking-[-0.5px] sm:text-[40px] sm:tracking-[-1px]">
          One yield-bearing asset becomes two{" "}
          <span className="font-serif italic">independent products</span>.
        </h2>

        <div className="rounded-3xl border border-border bg-bgCard p-8 md:p-12">
          <SplitDiagram />

          <div className="mt-12 grid gap-8 text-[14px] leading-relaxed text-textSec md:grid-cols-3">
            <div>
              <StepNumber n={1} />
              <h3 className="mb-2 mt-3 text-[15px] font-semibold text-text">Deposit</h3>
              <p>
                Add USDC + WHBAR to the SY adapter. It mints SY shares and adds liquidity to a fixed-range V3 LP NFT. No swap, no slippage at the SY layer.
              </p>
            </div>
            <div>
              <StepNumber n={2} />
              <h3 className="mb-2 mt-3 text-[15px] font-semibold text-text">Split</h3>
              <p>
                1 SY → 1 PT + 1 YT. Both are HTS-native tokens, visible in HashPack and Blade. PT is principal, YT is the future fee stream — separable and tradeable.
              </p>
            </div>
            <div>
              <StepNumber n={3} />
              <h3 className="mb-2 mt-3 text-[15px] font-semibold text-text">Trade or hold</h3>
              <p>
                Sell PT to a fixed-yield buyer for an upfront discount. Sell YT to a yield speculator. Or LP both into the AMM and earn 99% of swap fees.
              </p>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

function SplitDiagram() {
  return (
    <svg viewBox="0 0 720 200" className="mx-auto block w-full max-w-[720px]" fill="none">
      <defs>
        <linearGradient id="line-pt" x1="280" y1="100" x2="540" y2="60">
          <stop offset="0" stopColor="rgba(255,255,255,0.6)" />
          <stop offset="1" stopColor="rgba(134,239,172,0.6)" />
        </linearGradient>
        <linearGradient id="line-yt" x1="280" y1="100" x2="540" y2="140">
          <stop offset="0" stopColor="rgba(255,255,255,0.6)" />
          <stop offset="1" stopColor="rgba(251,191,36,0.6)" />
        </linearGradient>
        <radialGradient id="orb-sy" cx="0.5" cy="0.5" r="0.5">
          <stop offset="0" stopColor="rgba(255,255,255,0.85)" />
          <stop offset="1" stopColor="rgba(255,255,255,0.05)" />
        </radialGradient>
      </defs>

      {/* SY orb */}
      <g transform="translate(180,100)">
        <circle r="36" fill="url(#orb-sy)" />
        <text textAnchor="middle" y="6" className="font-mono fill-bg text-[18px] font-bold">SY</text>
      </g>
      <text x="180" y="172" textAnchor="middle" className="fill-textDim text-[11px] uppercase tracking-[2px]">
        Yield-bearing
      </text>

      {/* PT line + orb */}
      <path d="M 220 90 Q 360 60 500 60" stroke="url(#line-pt)" strokeWidth="1.5" />
      <g transform="translate(540,60)">
        <circle r="32" fill="rgba(134,239,172,0.12)" stroke="rgba(134,239,172,0.5)" strokeWidth="1.5" />
        <text textAnchor="middle" y="5" className="fill-success font-mono text-[15px] font-bold">PT</text>
      </g>
      <text x="588" y="62" className="fill-success text-[12px]">
        Fixed
      </text>

      {/* YT line + orb */}
      <path d="M 220 110 Q 360 140 500 140" stroke="url(#line-yt)" strokeWidth="1.5" />
      <g transform="translate(540,140)">
        <circle r="32" fill="rgba(251,191,36,0.12)" stroke="rgba(251,191,36,0.5)" strokeWidth="1.5" />
        <text textAnchor="middle" y="5" className="fill-warning font-mono text-[15px] font-bold">YT</text>
      </g>
      <text x="588" y="142" className="fill-warning text-[12px]">
        Variable
      </text>

      {/* Equation */}
      <text x="360" y="195" textAnchor="middle" className="fill-textDim font-mono text-[11px]">
        1 SY → 1 PT + 1 YT  ·  exchangeRate ≡ 1e18
      </text>
    </svg>
  );
}

function StepNumber({ n }: { n: number }) {
  return (
    <div className="inline-flex size-7 items-center justify-center rounded-full border border-borderHover bg-white/[0.04] font-mono text-[12px] text-text">
      {String(n).padStart(2, "0")}
    </div>
  );
}

/* ----------------------------------------------------- STRATEGIES */

function StrategiesSection() {
  return (
    <section className="border-b border-border">
      <div className="mx-auto max-w-[1180px] px-4 py-16 sm:px-6 sm:py-24">
        <SectionLabel>Three paths</SectionLabel>
        <h2 className="mx-auto mb-12 max-w-[760px] text-center text-[28px] font-light leading-[1.1] tracking-[-0.5px] sm:text-[40px] sm:tracking-[-1px]">
          Three roles, three different yield shapes.
        </h2>

        <div className="grid gap-5 md:grid-cols-3">
          {STRATEGIES.map((s, i) => (
            <article
              key={s.id}
              className="group relative flex flex-col gap-5 overflow-hidden rounded-2xl border border-border bg-bgCard p-7 transition hover:border-borderHover"
              style={{ animation: `fadeUp 0.5s ease-out ${0.05 * i + 0.1}s both` }}
            >
              <div className="flex items-start justify-between">
                <s.Icon className="size-9 text-text transition group-hover:scale-110" />
                <span
                  className={`rounded-full bg-white/[0.04] px-2 py-0.5 font-mono text-[10px] font-semibold uppercase tracking-[1px] ${s.riskTone}`}
                >
                  {s.risk}
                </span>
              </div>

              <div>
                <h3 className="text-[20px] font-semibold tracking-tight">{s.title}</h3>
                <p className="mt-1 text-[13px] text-textDim">{s.sub}</p>
              </div>

              <p className="text-[13.5px] leading-relaxed text-textSec">{s.summary}</p>

              <dl className="rounded-xl bg-white/[0.025] px-4 py-3 text-[12.5px] leading-relaxed">
                {s.example.map(([k, v]) => (
                  <div key={k} className="flex items-baseline justify-between border-b border-border/40 py-1.5 last:border-0">
                    <dt className="font-mono uppercase tracking-[1px] text-textDim">{k}</dt>
                    <dd className="font-mono text-text">{v}</dd>
                  </div>
                ))}
              </dl>

              <div className="mt-auto flex items-start gap-2 text-[12px] leading-relaxed text-textSec">
                <span className="mt-[5px] inline-block size-1 rounded-full bg-text" />
                <span>{s.pickIf}</span>
              </div>
            </article>
          ))}
        </div>

        <div className="mt-10 text-center">
          <Link
            href="/markets"
            className="inline-flex items-center gap-2 text-[14px] font-medium text-text transition hover:opacity-80"
          >
            Pick a strategy in the markets <span aria-hidden>→</span>
          </Link>
        </div>
      </div>
    </section>
  );
}

/* ----------------------------------------------------- STREAMS */

function StreamsSection() {
  return (
    <section className="border-b border-border">
      <div className="mx-auto max-w-[1180px] px-4 py-16 sm:px-6 sm:py-24">
        <SectionLabel>Where the yield comes from</SectionLabel>
        <h2 className="mx-auto mb-3 max-w-[760px] text-center text-[28px] font-light leading-[1.1] tracking-[-0.5px] sm:text-[40px] sm:tracking-[-1px]">
          Two independent fee streams.
        </h2>
        <p className="mx-auto mb-12 max-w-[640px] text-center text-[14px] text-textSec">
          Don&apos;t confuse them. PT, YT, and LP each earn from different sources.
        </p>

        <div className="grid gap-6 md:grid-cols-2">
          {STREAMS.map((s) => (
            <div key={s.id} className="rounded-2xl border border-border bg-bgCard p-7">
              <div className="mb-5 flex items-center gap-3">
                <FlowIcon className="size-5 text-text" />
                <span className="font-mono text-[11px] uppercase tracking-[1.5px] text-textDim">{s.rate}</span>
              </div>
              <h3 className="text-[20px] font-semibold tracking-tight">{s.title}</h3>
              <p className="mt-1 text-[13px] font-medium text-textSec">{s.subtitle}</p>
              <p className="mt-4 text-[13.5px] leading-relaxed text-textSec">{s.description}</p>
            </div>
          ))}
        </div>

        <div className="mt-8 grid gap-px overflow-hidden rounded-2xl border border-border bg-border md:grid-cols-3">
          <YieldRow role="PT" earnsFrom="Discount at buy → 1:1 SY at maturity" exposed="Fixed at buy time" />
          <YieldRow role="YT" earnsFrom="100% of harvested V3 fees (USDC + WHBAR)" exposed="Variable, never zero" />
          <YieldRow role="LP" earnsFrom="99% of Fission AMM swap fees" exposed="Volume-dependent" />
        </div>
      </div>
    </section>
  );
}

function YieldRow({ role, earnsFrom, exposed }: { role: string; earnsFrom: string; exposed: string }) {
  return (
    <div className="bg-bgCard px-6 py-5">
      <div className="font-mono text-[11px] font-semibold uppercase tracking-[2px] text-textDim">Role</div>
      <div className="mt-1 font-mono text-[18px] font-bold text-text">{role}</div>
      <div className="mt-4 text-[12.5px] text-textSec">{earnsFrom}</div>
      <div className="mt-3 text-[11px] uppercase tracking-[1.5px] text-textDim">{exposed}</div>
    </div>
  );
}

/* ----------------------------------------------------- SECURITY */

function SecuritySection() {
  return (
    <section className="border-b border-border">
      <div className="mx-auto max-w-[1180px] px-4 py-16 sm:px-6 sm:py-24">
        <SectionLabel>Governance &amp; security</SectionLabel>
        <h2 className="mx-auto mb-12 max-w-[760px] text-center text-[28px] font-light leading-[1.1] tracking-[-0.5px] sm:text-[40px] sm:tracking-[-1px]">
          Native to the chain, not bolted on.
        </h2>

        <div className="grid gap-5 md:grid-cols-3">
          <SecurityCard
            Icon={ShieldIcon}
            title="2-of-2 Hedera ThresholdKey"
            body="No EVM Safe — the protocol's admin is a Hedera-native multi-key account. Two signers, mixed-curve (ECDSA + Ed25519). Any privileged call needs both signatures via HashPack."
          />
          <SecurityCard
            Icon={ChainIcon}
            title="48-hour Timelock"
            body="Every privileged tx flows through OZ TimelockController with a 48-hour public delay. Emergency pause is the only single-step path; all parameter changes are reviewable on-chain."
          />
          <SecurityCard
            Icon={LockIcon}
            title="Audit pipeline"
            body="269 unit + invariant tests, 8 invariants × 256K random calls, 0 reverts. Two internal audit passes; all H/M closed. Fork tests against mainnet NPM + Stader oracles."
          />
        </div>

        <div className="mt-10 text-center text-[13px] text-textSec">
          Read the{" "}
          <a className="underline underline-offset-4 hover:text-text" href="https://github.com/penguinpecker/fission-protocol-hedera/blob/main/audits/internal/SECURITY_REVIEW_2026-05-02-pass2.md" target="_blank" rel="noreferrer">
            internal audit pass 2 report
          </a>{" "}
          or the{" "}
          <a className="underline underline-offset-4 hover:text-text" href="https://github.com/penguinpecker/fission-protocol-hedera" target="_blank" rel="noreferrer">
            full source
          </a>.
        </div>
      </div>
    </section>
  );
}

function SecurityCard({ Icon, title, body }: { Icon: typeof ShieldIcon; title: string; body: string }) {
  return (
    <div className="rounded-2xl border border-border bg-bgCard p-7">
      <Icon className="mb-5 size-7 text-text" />
      <h3 className="text-[18px] font-semibold tracking-tight">{title}</h3>
      <p className="mt-3 text-[13.5px] leading-relaxed text-textSec">{body}</p>
    </div>
  );
}

/* --------------------------------------------------------- FAQ */

function FaqSection() {
  return (
    <section className="border-b border-border">
      <div className="mx-auto max-w-[860px] px-4 py-16 sm:px-6 sm:py-24">
        <SectionLabel>FAQ</SectionLabel>
        <h2 className="mb-10 text-center text-[28px] font-light leading-[1.1] tracking-[-0.5px] sm:mb-12 sm:text-[40px] sm:tracking-[-1px]">
          Common questions.
        </h2>

        <div className="space-y-3">
          {FAQ.map((f) => (
            <details
              key={f.q}
              className="group rounded-2xl border border-border bg-bgCard px-6 py-5 transition open:bg-bgElevated"
            >
              <summary className="flex cursor-pointer list-none items-center justify-between gap-4 text-[15px] font-medium text-text">
                <span>{f.q}</span>
                <span aria-hidden className="font-mono text-[18px] text-textDim transition group-open:rotate-45">
                  +
                </span>
              </summary>
              <p className="mt-4 text-[13.5px] leading-relaxed text-textSec">{f.a}</p>
            </details>
          ))}
        </div>
      </div>
    </section>
  );
}

/* ------------------------------------------------------ helpers */

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div className="mb-5 flex items-center justify-center gap-3">
      <span className="h-px w-10 bg-border" />
      <span className="font-mono text-[10px] font-semibold uppercase tracking-[3px] text-textDim">{children}</span>
      <span className="h-px w-10 bg-border" />
    </div>
  );
}
