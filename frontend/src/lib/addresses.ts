/**
 * Deployed contract addresses, sourced from build-time env so a deploy can change
 * them without a code change. Addresses default to zero — the UI must guard against
 * "not yet deployed" state and degrade to a "coming soon" message rather than
 * silently 0x0-call.
 */
const ZERO = "0x0000000000000000000000000000000000000000" as const;

export const ADDRESSES = {
  factory: (process.env.NEXT_PUBLIC_FACTORY_ADDRESS ?? ZERO) as `0x${string}`,
  router: (process.env.NEXT_PUBLIC_ROUTER_ADDRESS ?? ZERO) as `0x${string}`,
} as const;

export const isDeployed = (addr: string): boolean =>
  addr.toLowerCase() !== ZERO && /^0x[0-9a-fA-F]{40}$/.test(addr);
