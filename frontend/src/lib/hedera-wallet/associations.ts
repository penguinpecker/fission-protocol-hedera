"use client";

/**
 * HTS token-association helpers for the Hedera-native signing path.
 *
 * Why: Hedera HTS tokens require the receiving account to have an
 * association record before any transfer can land. Accounts created
 * before HIP-904 (and many old wallets) have
 * `max_automatic_token_associations: 0`, so they MUST explicitly call
 * `TokenAssociateTransaction` once per token before our contract can
 * deliver shares / dust to them.
 *
 * Production pattern (confirmed against hashgraph/hedera-wallet-connect
 * examples, HashPack docs, and SaucerSwap/Bonzo open-source code):
 *   1. Pre-check user's `max_automatic_token_associations` via Mirror
 *      Node. If -1 (unlimited HIP-904), skip entirely.
 *   2. Otherwise, pull `/accounts/{id}/tokens?token.id=<id>` for each
 *      required token. Anything missing goes into a single
 *      `TokenAssociateTransaction.setTokenIds([...])` — one user prompt,
 *      one HBAR fee, atomic outcome.
 *
 * EVM-aliased and Ed25519 accounts both work via the same path because
 * `DAppSigner.getAccountId()` returns the canonical `0.0.X` form
 * regardless of key type.
 */

const MIRROR_BASE = "https://mainnet-public.mirrornode.hedera.com/api/v1";

/**
 * Convert a long-zero EVM address (`0x000…NUM`) into a Hedera token ID
 * string (`0.0.NUM`). Throws on a non-long-zero address — those don't
 * map cleanly to a token shard (we only deal with HTS-on-EVM and HTS
 * shares are always long-zero).
 */
export function evmAddressToTokenId(evmAddress: `0x${string}`): string {
  const hex = evmAddress.toLowerCase().replace(/^0x/, "");
  if (hex.length !== 40) throw new Error(`bad EVM address: ${evmAddress}`);
  const num = BigInt("0x" + hex);
  // Sanity-check: anything above the EOA boundary (~2^32 in practice) is
  // almost certainly an aliased ECDSA address, not a long-zero, and won't
  // resolve to an HTS token. The current Hedera token range fits in u32+.
  if (num > 0xffffffffffffffffn) throw new Error(`not a long-zero address: ${evmAddress}`);
  return `0.0.${num.toString()}`;
}

interface MirrorAccount {
  account: string;
  max_automatic_token_associations: number;
}

interface MirrorTokensPage {
  tokens: Array<{ token_id: string; balance: number }>;
}

/**
 * Returns the subset of `requiredTokenIds` that the account is NOT
 * currently associated with. An account is considered "covered" if any
 * of these are true for a given token:
 *   - `max_automatic_token_associations === -1` (HIP-904 unlimited)
 *   - The token already appears in `/accounts/{id}/tokens`
 *
 * Network errors are treated as "we can't prove they're associated",
 * which conservatively returns the token in the missing list so the
 * user gets prompted. A spurious associate prompt is far less bad than
 * letting the user submit a tx that will revert with code 184.
 */
export async function getMissingAssociations(
  accountId: string,
  requiredTokenIds: string[],
): Promise<string[]> {
  if (requiredTokenIds.length === 0) return [];

  // 1. Cheap auto-assoc bail-out — if user is HIP-904 unlimited we don't
  //    even need to query per-token.
  try {
    const r = await fetch(`${MIRROR_BASE}/accounts/${accountId}`);
    if (r.ok) {
      const data = (await r.json()) as MirrorAccount;
      if (data.max_automatic_token_associations === -1) return [];
    }
  } catch {
    /* swallow — we'll fall through to per-token check */
  }

  // 2. Per-token check. Mirror Node accepts ?token.id=eq:0.0.NNN, so we
  //    run these in parallel.
  const checks = await Promise.all(
    requiredTokenIds.map(async (tid) => {
      try {
        const r = await fetch(
          `${MIRROR_BASE}/accounts/${accountId}/tokens?token.id=${tid}&limit=1`,
        );
        if (!r.ok) return { tid, associated: false };
        const data = (await r.json()) as MirrorTokensPage;
        return { tid, associated: (data.tokens?.length ?? 0) > 0 };
      } catch {
        return { tid, associated: false };
      }
    }),
  );

  return checks.filter((c) => !c.associated).map((c) => c.tid);
}

/**
 * Builds and submits a single `TokenAssociateTransaction` covering all
 * `tokenIds`. One wallet prompt → atomic outcome.
 *
 * Uses the same `freezeWithSigner` + manual node-IDs pattern as
 * `adapter.ts` writeHedera — keeps the code paths consistent.
 */
export async function associateTokens(
  connector: unknown,
  accountId: string,
  tokenIds: string[],
): Promise<string> {
  if (tokenIds.length === 0) return "";

  const c = connector as null | {
    signers: Array<{ getAccountId(): { toString(): string } }>;
  };
  if (!c?.signers?.length) throw new Error("Hedera connector has no signer");

  const sdk = await import("@hashgraph/sdk");
  const { TokenAssociateTransaction, AccountId, TokenId, Client } = sdk;

  const mainnetClient = Client.forMainnet();
  const nodeIds: InstanceType<typeof AccountId>[] = mainnetClient._network
    ? (mainnetClient._network.getNodeAccountIdsForExecute?.() as InstanceType<typeof AccountId>[]) ?? []
    : [];
  mainnetClient.close();

  // Read the signer LIVE off the (possibly just-refreshed) connector at submit
  // time — never capture it before the SDK import await, so a session that got
  // deleted/re-paired mid-flight is picked up. See adapter.ts writeHedera for
  // the outer self-heal retry that rebuilds the connector on a dead topic.
  const signer = c.signers[0];

  const tx = new TokenAssociateTransaction()
    .setAccountId(AccountId.fromString(accountId))
    .setTokenIds(tokenIds.map((id) => TokenId.fromString(id)));

  if (nodeIds.length > 0) tx.setNodeAccountIds(nodeIds);
  await tx.freezeWithSigner(signer as never);
  const resp = await tx.executeWithSigner(signer as never);
  await resp.getReceiptWithSigner(signer as never);
  return resp.transactionId?.toString() ?? "";
}
