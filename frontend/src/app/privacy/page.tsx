import { Nav } from "@/components/Nav";
import { Footer } from "@/components/Footer";
import { LegalShell, H1, H2, P, UL } from "@/components/Legal";

export const metadata = {
  title: "Privacy · Fission Protocol",
  description: "What Fission Protocol stores, why, and what it does not.",
};

export default function PrivacyPage() {
  return (
    <main className="min-h-screen">
      <Nav />
      <LegalShell>
        <H1>Privacy</H1>
        <P>
          Fission is a non-custodial DeFi protocol. The minimal information we store is what the application strictly needs to function. We do not run analytics SDKs, advertising pixels, or session-replay tools.
        </P>

        <H2>What is stored on-chain</H2>
        <P>
          Every transaction you sign is publicly visible on Hedera mainnet. Your wallet address, the contracts you interact with, the amounts traded, and timestamps are part of the public chain record. This is true for every blockchain protocol and is outside our control.
        </P>

        <H2>What we store off-chain</H2>
        <UL>
          <li>
            <strong>Sign-In with Ethereum (SIWE) sessions.</strong> When you sign in to view watchlists or edit your profile, we store an HS256-signed JWT in an HttpOnly cookie. The JWT carries your lowercased EVM address and a sign-in timestamp. Cookie TTL is 7 days.
          </li>
          <li>
            <strong>SIWE nonces.</strong> Single-use nonces are stored server-side for up to 5 minutes to prevent replay during sign-in. They are deleted after consumption.
          </li>
          <li>
            <strong>User profile (optional).</strong> If you set a display name, avatar URL, or X/Twitter handle on the profile page, those values are stored in our Supabase database keyed by your wallet address.
          </li>
          <li>
            <strong>Watchlists (optional).</strong> If you star markets, the favourites list is stored keyed by your wallet address.
          </li>
          <li>
            <strong>Markets cache.</strong> A read-only mirror of on-chain market state, refreshed by a public cron. Contains no user-specific data.
          </li>
        </UL>

        <H2>What we do NOT store</H2>
        <UL>
          <li>Email addresses, real names, government IDs, or KYC data.</li>
          <li>IP addresses or geolocation data, beyond what your hosting CDN logs for abuse-mitigation purposes.</li>
          <li>Cookies for advertising, profiling, or third-party analytics.</li>
          <li>Browser fingerprints or session-replay recordings.</li>
        </UL>

        <H2>Hosting and third parties</H2>
        <UL>
          <li><strong>Vercel</strong> hosts the frontend and may log standard request metadata for security and abuse prevention.</li>
          <li><strong>Supabase</strong> hosts the user/watchlist/markets-cache database. Service-role keys are used server-side only; the browser never receives the service-role key.</li>
          <li><strong>Reown / WalletConnect</strong> brokers the wallet connection. Your wallet provider determines what it shares with them; check their privacy policy.</li>
          <li><strong>Hashio JSON-RPC</strong> (Hedera) is queried for chain reads. Standard RPC request logging may apply.</li>
        </UL>

        <H2>Deletion</H2>
        <P>
          You can delete your off-chain profile at any time via the profile page (DELETE /api/profile). On-chain transactions are permanent and cannot be deleted by us or by you — this is inherent to public blockchains.
        </P>

        <H2>Changes</H2>
        <P>
          If we change what we store, the change ships in a public commit and the updated policy lives at this URL. There is no notification — you are responsible for re-reading if you care about updates.
        </P>
      </LegalShell>
      <Footer />
    </main>
  );
}
