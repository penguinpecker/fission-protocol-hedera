import { Nav } from "@/components/Nav";
import { Footer } from "@/components/Footer";
import { LegalShell, H1, H2, P, UL } from "@/components/Legal";

export const metadata = {
  title: "Risks · Fission Protocol",
  description: "Material risks of using Fission Protocol on Hedera.",
};

export default function RisksPage() {
  return (
    <main className="min-h-screen">
      <Nav />
      <LegalShell>
        <H1>Risks</H1>
        <P>
          Fission Protocol is non-custodial and on-chain. Funds in PT, YT, LP, and SY positions belong to the wallet that signed the transaction; nobody at Fission can recover them. Before you trade, understand the following risks.
        </P>

        <H2>Smart contract risk</H2>
        <P>
          The contracts have undergone two internal audit passes (24 + 9 findings, all H/M closed) and 269 unit + invariant tests with 0 reverts across 256K random calls per invariant. They have NOT yet completed a paid third-party audit. Bugs can cause partial or total loss of funds in any position.
        </P>

        <H2>Variable-yield risk (YT)</H2>
        <UL>
          <li>YT is a leveraged claim on SaucerSwap V2 swap fees. If V3 trading volume is lower than the implied rate priced into the market, YT buyers realize losses up to (but not exceeding) their entry capital.</li>
          <li>YT remains a perpetual fee claim post-expiry — it does not become worthless — but it is not guaranteed to recover entry cost.</li>
          <li>Effective leverage on V3 yield ≈ 1 / implied-rate. At 1.5% implied, a 1% miss on realized fees translates to a ~67% mark-to-market move.</li>
        </UL>

        <H2>Principal risk (PT)</H2>
        <UL>
          <li>PT redemption (1 PT → 1 SY at maturity) is contractually unconditional. Your principal in SY-units is on-chain and reserved for the lifetime of the market.</li>
          <li>The SY itself is a SaucerSwap V2 LP NFT wrapper. Its USD-equivalent value moves with WHBAR/USDC pool composition (impermanent-loss-style risk). PT does not protect against price moves of the underlying tokens.</li>
        </UL>

        <H2>LP risk</H2>
        <UL>
          <li>LP positions earn 99% of Fission AMM swap fees. If trading volume is zero, LPs earn nothing.</li>
          <li>Pre-expiry LP exit is via <code>removeLiquidity</code> — return is proportional SY + PT. Post-expiry exit auto-redeems the PT share for SY.</li>
          <li>LP positions are exposed to PT/SY divergence (Pendle V2 analogue of impermanent loss).</li>
        </UL>

        <H2>Platform risks</H2>
        <UL>
          <li><strong>Hedera network</strong>: HTS quirks (token-association requirements, throttling), HIP changes, network outages.</li>
          <li><strong>SaucerSwap V2</strong>: the SY's underlying NFT depends on SaucerSwap. An exploit, deprecation, or pool migration in SaucerSwap impacts our SY.</li>
          <li><strong>Hashio / RPC</strong>: the public RPC endpoint is not under our control. Production RPC for write operations may degrade independently of the protocol.</li>
        </UL>

        <H2>Governance risk</H2>
        <UL>
          <li>Until multisig handoff completes, the deployer EOA holds DEFAULT_ADMIN_ROLE on the Factory, Market, and SY adapter. The deployer can pause the protocol and update fee parameters within contract-enforced caps.</li>
          <li>After handoff, all admin actions are gated by a 2-of-2 Hedera ThresholdKey (operator + cosigner) wrapped behind a 48-hour OZ TimelockController. Emergency pause remains a single-signer step on a separate role.</li>
          <li>The Timelock cannot be removed; all admin-role transfers and parameter changes are publicly visible on-chain.</li>
        </UL>

        <H2>Market risks</H2>
        <UL>
          <li>Low TVL means YT yield is volume-bound. Realized fees scale linearly with the SY's NFT depth in the V3 pool.</li>
          <li>Low LP depth means trades above ~$1k can move the AMM curve materially. Use slippage protection.</li>
          <li>Implied APY shown on the UI is the AMM&apos;s current state, not a forecast. Actual realized yield can diverge.</li>
        </UL>

        <H2>What Fission does NOT do</H2>
        <UL>
          <li>We do not custody funds. There is no centralized treasury holding user assets.</li>
          <li>We do not insure positions. There is no compensation fund for smart-contract failure or governance misuse.</li>
          <li>We do not provide investment advice. UI copy is informational; allocation decisions are yours alone.</li>
        </UL>
      </LegalShell>
      <Footer />
    </main>
  );
}
