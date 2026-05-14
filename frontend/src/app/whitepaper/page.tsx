import Link from "next/link";
import { Nav } from "@/components/Nav";
import { Footer } from "@/components/Footer";

/**
 * Whitepaper page — high-level, casual explainer for the protocol.
 * No deep math, no contract source dives. Just: what is Fission, what
 * are the strategies, how does the underlying yield source work, why
 * does this exist. Pendle-style economics in plain English.
 *
 * Linked from the Nav (replacing the old Docs + Audits external links)
 * and from the landing-hero CTA.
 */
export default function WhitepaperPage() {
  return (
    <main className="min-h-screen text-text">
      <Nav />
      <article className="mx-auto max-w-[820px] px-5 py-12 sm:px-7 sm:py-16">
        {/* — Header — */}
        <header className="mb-12">
          <div className="mb-4 inline-flex items-center gap-2 rounded-full border border-border bg-white/[0.03] px-2.5 py-1 font-mono text-[10px] uppercase tracking-[2px] text-textDim">
            <span className="size-[5px] rounded-full bg-success" />
            Whitepaper · v1
          </div>
          <h1 className="text-[40px] font-light leading-[1.05] tracking-[-1px] sm:text-[52px]">
            Fission Protocol —{" "}
            <span className="font-serif italic">in plain English</span>
          </h1>
          <p className="mt-5 max-w-[600px] text-[15px] leading-relaxed text-textSec">
            Yield tokenization on Hedera. We split a yield-bearing position into two halves: a fixed-yield half (PT) and a variable-yield half (YT). You pick the half you want.
          </p>
        </header>

        {/* — Sections — */}
        <Section title="What's a yield market?">
          <p>
            Imagine you deposit money into a savings account that earns 5% a year. Two people might want different things out of it:
          </p>
          <ul className="mt-3 list-disc space-y-2 pl-5 text-textSec">
            <li>
              <span className="text-text">The cautious person</span> wants to <em>lock in</em> that 5% today and not worry about it dropping.
            </li>
            <li>
              <span className="text-text">The speculator</span> thinks the rate will jump to 12% — they want to <em>buy the yield</em> and capture the upside.
            </li>
          </ul>
          <p className="mt-3">
            Fission lets both of them trade. We split the savings position into two tokens:
          </p>
          <ul className="mt-3 list-disc space-y-2 pl-5 text-textSec">
            <li>
              <span className="text-text">PT</span> (Principal Token) — gets the locked-in fixed yield.
            </li>
            <li>
              <span className="text-text">YT</span> (Yield Token) — gets whatever yield actually accrues.
            </li>
          </ul>
          <p className="mt-3">
            The cautious person buys PT. The speculator buys YT. Both walk away with the position they wanted.
          </p>
        </Section>

        <Section title="What's the underlying yield?">
          <p>
            Fission&apos;s v1 yield source is a <span className="text-text">SaucerSwap V2 liquidity position</span>. Specifically: WHBAR ↔ USDC, 0.15% fee tier.
          </p>
          <p className="mt-3">
            When traders swap WHBAR for USDC (or vice versa) on SaucerSwap, they pay a 0.15% fee. That fee flows to whoever provides liquidity to the pool. Fission&apos;s smart contract owns one liquidity position inside that pool — so every swap, a tiny slice of the fees lands in the protocol&apos;s account.
          </p>
          <p className="mt-3">
            We wrap that position into a single token we call <span className="text-text">SY</span> (Standardized Yield). Holding 1 SY = holding 1 share of the pool position + 1 share of the fee stream. It&apos;s the raw yield-bearing primitive everything else is built on.
          </p>
          <p className="mt-3 text-[13px] text-textDim">
            We never ask you to think about SY directly. You pay HBAR, we handle the wrap.
          </p>
        </Section>

        <Section title="The three strategies">
          <Strategy
            tag="Fixed yield"
            title="Buy PT — lock in today's rate"
            pitch="Pay 0.98 SY today, redeem 1 SY at maturity. The 0.02 difference is your guaranteed return."
            details={[
              "You buy PT at a discount today (e.g. $0.98 for $1 of future SY).",
              "At maturity (90 days for our first market), 1 PT redeems for 1 SY. Always. Doesn't matter what happened.",
              "Your return is the discount, locked in the moment you buy.",
              "Good if you want predictable yield and don't want to watch the market.",
            ]}
          />
          <Strategy
            tag="Long yield"
            title="Buy YT — leveraged bet on yield"
            pitch="Pay 0.02 SY for 1 YT today. Earn whatever fees the SaucerSwap pool generates while you hold it."
            details={[
              "YT costs whatever the market thinks the future yield is worth — usually a small fraction of an SY.",
              "While you hold YT, you accrue the actual trading fees from SaucerSwap, paid in USDC + WHBAR.",
              "If the pool earns MORE than the market expected → you profit.",
              "If it earns LESS → you can lose your YT investment.",
              "YT doesn't expire — you can keep collecting yield indefinitely after the term.",
              "Good if you have a view that trading volume will go up.",
            ]}
          />
          <Strategy
            tag="Liquidity"
            title="Provide LP — earn from both sides"
            pitch="Deposit SY + PT into our AMM. Earn 99% of the trading fees from people swapping between them."
            details={[
              "Our AMM lets people swap PT↔SY directly (that's how the Buy PT / Buy YT flows work).",
              "LPs provide the liquidity for those swaps and earn 99% of the fee on every trade (the other 1% goes to the protocol treasury).",
              "You hold a mix of PT and SY — your composition shifts as the AMM trades against you.",
              "Good for passive income without picking a directional bet.",
            ]}
          />
        </Section>

        <Section title="How do users make money?">
          <p>
            Three honest answers, one per strategy:
          </p>
          <div className="mt-4 grid gap-3 sm:grid-cols-3">
            <Money
              kind="PT"
              accent="success"
              line="The discount you bought at. Fixed, guaranteed, no surprises."
              example="$100 of PT today → $102 at maturity"
            />
            <Money
              kind="YT"
              accent="warning"
              line="Whatever the pool earns above your YT cost basis."
              example="Up 2x if volume booms, down to 0 if it dies"
            />
            <Money
              kind="LP"
              accent="text"
              line="99% of AMM swap fees, paid in SY (which itself grows from pool fees)."
              example="Steady stream, scales with AMM trading volume"
            />
          </div>
          <p className="mt-4 text-[13px] text-textDim">
            All three positions trade freely on our AMM until maturity. You can exit anytime by selling back to SY.
          </p>
        </Section>

        <Section title="How Fission plugs into SaucerSwap V2">
          <p>
            Hedera&apos;s biggest DEX is SaucerSwap. Their V3 (concentrated-liquidity, Uniswap V3-style) USDC/WHBAR pool has the deepest liquidity on the chain. We use that pool as our yield source.
          </p>
          <p className="mt-3">
            Here&apos;s the chain of ownership, top-down:
          </p>
          <ol className="mt-3 list-decimal space-y-2 pl-5 text-textSec">
            <li>
              <span className="text-text">User</span> holds SY shares (or PT / YT / LP, depending on strategy).
            </li>
            <li>
              <span className="text-text">SY adapter</span> wraps a single SaucerSwap V2 LP NFT. Mints SY shares 1:1 with liquidity added to the NFT.
            </li>
            <li>
              <span className="text-text">SaucerSwap V2 Position NFT</span> sits inside the USDC/WHBAR 0.15% pool. Earns fees on every swap.
            </li>
            <li>
              <span className="text-text">SaucerSwap V2 USDC/WHBAR pool</span> — the actual order book where Hedera traders swap WHBAR for USDC.
            </li>
          </ol>
          <p className="mt-3">
            When you deposit HBAR, our zap contract: wraps half to WHBAR, swaps the other half to USDC on SaucerSwap, deposits both into our V3 LP NFT, and mints you SY. One transaction. The Pendle-style math then lets you trade that SY for PT / YT / LP.
          </p>
          <p className="mt-3">
            The protocol harvests fees from the V3 NFT periodically. Those fees flow to YT holders (their yield) and LP holders (their AMM fees). PT holders don&apos;t earn fees directly — they earn the spread between buy price and the 1-SY redemption.
          </p>
        </Section>

        <Section title="High-level architecture">
          <p>
            Six contracts on Hedera mainnet, plus the AMM math:
          </p>
          <Arch
            rows={[
              ["FissionFactory", "Whitelists yield sources, deploys new markets per maturity date."],
              ["FissionZap", "One-tx HBAR → SY. Handles the WHBAR wrap + USDC swap + V3 deposit."],
              ["SY adapter", "Wraps the underlying yield source (V3 LP NFT). Mints share tokens."],
              ["Market", "The Pendle-V2-style AMM where PT/YT/LP get minted and traded."],
              ["ActionRouter", "Single entry point for swap / mint LP / redeem flows."],
              ["Timelock + Threshold", "2-of-2 keys, 48-hour delay, govern any protocol changes."],
            ]}
          />
          <p className="mt-4">
            Everything is HTS-native — PT, YT, LP, and SY shares are all Hedera HTS tokens. That means they show up in any Hedera wallet, can be transferred over the network natively, and benefit from Hedera&apos;s low transaction fees ($0.0001-ish per call).
          </p>
        </Section>

        <Section title="Risks (the honest list)">
          <ul className="list-disc space-y-2 pl-5 text-textSec">
            <li>
              <span className="text-text">Underlying pool risk.</span> The SaucerSwap pool can lose value as the WHBAR/USDC price drifts (standard LP impermanent-loss exposure). PT protects your nominal SY count but not its USD value.
            </li>
            <li>
              <span className="text-text">Smart-contract risk.</span> Anything can break. We&apos;ve done internal audits and external auditors are queued; the code is open-source. Nothing is risk-free.
            </li>
            <li>
              <span className="text-text">Yield risk for YT.</span> If trading volume on SaucerSwap goes to zero, YT earns nothing and goes to zero value at expiry.
            </li>
            <li>
              <span className="text-text">Liquidity risk.</span> At small market sizes, slippage on the AMM can eat into expected returns. Trade size is capped at 1% of pool depth in the UI to protect against this.
            </li>
          </ul>
          <p className="mt-4 text-[13px] text-textDim">
            Read the full <Link href="/risks" className="underline underline-offset-2 hover:text-text">risks page</Link> before depositing meaningful capital.
          </p>
        </Section>

        <Section title="Governance">
          <p>
            Fission is controlled by a <span className="text-text">2-of-2 Hedera ThresholdKey</span> sitting behind a <span className="text-text">48-hour Timelock</span>. Two independent keys must sign, and any change waits 48 hours before executing — long enough for users to exit if they don&apos;t like what&apos;s being proposed.
          </p>
          <p className="mt-3">
            The protocol has no fee switch, no admin pause on user funds, and no upgrade key on the markets. The threshold + timelock can whitelist new yield sources and deploy new market instances per maturity, but cannot touch existing positions or change the AMM math.
          </p>
        </Section>

        {/* — CTA — */}
        <div className="mt-16 flex flex-wrap items-center gap-3 border-t border-border pt-10">
          <Link
            href="/markets"
            className="rounded-[2px] border border-white bg-white px-5 py-2.5 text-[12px] font-semibold uppercase tracking-[0.14em] text-black transition hover:bg-white/85"
          >
            Open the markets
          </Link>
          <a
            href="https://github.com/penguinpecker/fission-protocol-hedera"
            target="_blank"
            rel="noreferrer"
            className="rounded-[2px] border border-borderHover px-5 py-2.5 text-[12px] font-medium text-textSec transition hover:bg-white/[0.04] hover:text-text"
          >
            Source on GitHub
          </a>
          <a
            href="https://github.com/penguinpecker/fission-protocol-hedera/tree/main/audits"
            target="_blank"
            rel="noreferrer"
            className="rounded-[2px] border border-borderHover px-5 py-2.5 text-[12px] font-medium text-textSec transition hover:bg-white/[0.04] hover:text-text"
          >
            Audits
          </a>
        </div>
      </article>
      <Footer />
    </main>
  );
}

/* ──────────────────────────────── primitives ──────────────────────────────── */

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="mb-14">
      <h2 className="mb-4 text-[22px] font-semibold tracking-tight sm:text-[26px]">
        <span className="font-mono text-[13px] text-textDim">/&#47;&nbsp;</span>
        {title}
      </h2>
      <div className="space-y-2 text-[14.5px] leading-relaxed text-text">
        {children}
      </div>
    </section>
  );
}

function Strategy({
  tag,
  title,
  pitch,
  details,
}: {
  tag: string;
  title: string;
  pitch: string;
  details: string[];
}) {
  return (
    <div className="mt-5 rounded-2xl border border-border bg-bgCard p-5 first:mt-3">
      <div className="mb-2 font-mono text-[10px] uppercase tracking-[2px] text-textDim">
        {tag}
      </div>
      <h3 className="mb-2 text-[18px] font-semibold tracking-tight">{title}</h3>
      <p className="mb-3 text-[14px] leading-relaxed text-textSec">{pitch}</p>
      <ul className="list-disc space-y-1.5 pl-5 text-[13.5px] leading-relaxed text-textSec">
        {details.map((d) => (
          <li key={d}>{d}</li>
        ))}
      </ul>
    </div>
  );
}

function Money({
  kind,
  accent,
  line,
  example,
}: {
  kind: string;
  accent: "success" | "warning" | "text";
  line: string;
  example: string;
}) {
  const tone =
    accent === "success" ? "text-success" : accent === "warning" ? "text-warning" : "text-text";
  return (
    <div className="rounded-2xl border border-border bg-bgCard p-4">
      <div className={`mb-1 font-mono text-[11px] uppercase tracking-[2px] ${tone}`}>
        {kind}
      </div>
      <div className="mb-2 text-[13.5px] leading-relaxed text-text">{line}</div>
      <div className="font-mono text-[11px] text-textDim">{example}</div>
    </div>
  );
}

function Arch({ rows }: { rows: [string, string][] }) {
  return (
    <div className="mt-4 overflow-hidden rounded-2xl border border-border bg-bgCard">
      {rows.map(([name, desc], i) => (
        <div
          key={name}
          className={`grid grid-cols-1 gap-2 px-4 py-3 sm:grid-cols-[180px_1fr] sm:gap-5 ${
            i < rows.length - 1 ? "border-b border-border" : ""
          }`}
        >
          <div className="font-mono text-[12.5px] text-text">{name}</div>
          <div className="text-[13.5px] leading-relaxed text-textSec">{desc}</div>
        </div>
      ))}
    </div>
  );
}
