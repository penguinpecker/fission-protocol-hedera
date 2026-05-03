/**
 * Discriminated union for source-of-truth rate sources. Each kind has its own
 * implementation in `sources/` that takes the params and a viem public client and
 * returns the 1e18-scaled rate the keeper should consider posting.
 */

import type { Address } from "viem";

export type RateSource =
  | { kind: "stader"; staderContract: Address }
  | { kind: "static"; rate: bigint /* test only */ };

export interface AdapterConfig {
  /** Display name for logs and metrics. */
  name: string;
  /** Address of the SY contract to post to. */
  sy: Address;
  /** Source of truth for the rate. */
  source: RateSource;
  /** Min seconds between posts. Should be ≥ MIN_POST_INTERVAL on the SY. */
  minIntervalSec: number;
  /** Soft client-side cap on bps move per post (defence in depth — the contract caps too). */
  maxDeltaBps: number;
  /** Initial post if the SY has no observations yet — can be derived from source on bootstrap. */
  bootstrap: boolean;
}
