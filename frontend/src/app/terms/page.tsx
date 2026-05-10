import { Nav } from "@/components/Nav";
import { Footer } from "@/components/Footer";
import { LegalShell, H1, H2, P, UL } from "@/components/Legal";

export const metadata = {
  title: "Terms of use · Fission Protocol",
  description: "Terms governing use of the Fission Protocol interface.",
};

export default function TermsPage() {
  return (
    <main className="min-h-screen">
      <Nav />
      <LegalShell>
        <H1>Terms of use</H1>
        <P>
          By accessing this interface or interacting with the Fission Protocol smart contracts, you accept the following terms. If you do not accept them, do not use the protocol.
        </P>

        <H2>What this interface is</H2>
        <P>
          This website is a frontend that helps you sign transactions to interact with public smart contracts on Hedera mainnet. We do not custody your funds, take counterparty positions, or hold balances on your behalf. The contracts execute autonomously regardless of whether this interface is online.
        </P>

        <H2>You are responsible for your wallet</H2>
        <UL>
          <li>You alone hold the keys to your wallet. We cannot recover lost seed phrases, signatures, or transactions.</li>
          <li>You are responsible for the chain, network, and address you sign for. Sending funds to the wrong address or chain is irrecoverable.</li>
          <li>You are responsible for verifying contract addresses before approving transactions.</li>
        </UL>

        <H2>No investment advice</H2>
        <P>
          UI copy, documentation, worked examples, and implied APY values are informational only. Nothing on this site is an offer, recommendation, or solicitation. Past performance does not predict future results. You alone decide whether and how to allocate.
        </P>

        <H2>Eligibility and jurisdictions</H2>
        <P>
          Decentralized derivatives may be restricted in your jurisdiction. You are responsible for ensuring your use complies with local law. Persons subject to OFAC, EU, or UK sanctions may not use this interface.
        </P>

        <H2>No warranty</H2>
        <P>
          The interface and contracts are provided &quot;as is&quot;, without warranty of any kind. We disclaim all express or implied warranties to the maximum extent permitted by law, including merchantability, fitness for purpose, and non-infringement.
        </P>

        <H2>Limitation of liability</H2>
        <P>
          To the maximum extent permitted by law, Fission Protocol contributors are not liable for any direct, indirect, incidental, consequential, or special damages arising from use of this interface or the underlying contracts, including loss of funds from smart-contract bugs, governance actions, or oracle/RPC failures. Risks of using DeFi protocols are inherent and material; see the <a className="underline underline-offset-4 hover:text-text" href="/risks">Risks</a> page.
        </P>

        <H2>Open source</H2>
        <P>
          The contract source and frontend are MIT-licensed and publicly auditable at the project repository. You may run your own copy of this interface or interact with the contracts directly via any RPC.
        </P>

        <H2>Changes</H2>
        <P>
          Terms may be updated. Updated terms ship in a public commit and replace this page. Continued use after a change constitutes acceptance.
        </P>
      </LegalShell>
      <Footer />
    </main>
  );
}
