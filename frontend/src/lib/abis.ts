/**
 * Minimal ABIs hand-written from the contracts in /contracts/src. We use only the
 * bits the frontend reads/writes; full ABIs live in `/contracts/out` after a
 * `forge build` and can be wagmi-typegen'd later.
 */

export const factoryAbi = [
  {
    type: "function",
    name: "marketCount",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "markets",
    stateMutability: "view",
    inputs: [{ name: "i", type: "uint256" }],
    outputs: [{ name: "", type: "address" }],
  },
  {
    type: "function",
    name: "getMarkets",
    stateMutability: "view",
    inputs: [
      { name: "offset", type: "uint256" },
      { name: "limit", type: "uint256" },
    ],
    outputs: [{ name: "", type: "address[]" }],
  },
  {
    type: "function",
    name: "whitelistedSY",
    stateMutability: "view",
    inputs: [{ name: "sy", type: "address" }],
    outputs: [{ name: "", type: "bool" }],
  },
  // UUPS proxy surface — the factory is deployed behind an ERC1967 proxy
  // (2026-05-29 UUPS-proxy + freeze-PT rebuild).
  { type: "function", name: "proxiableUUID", stateMutability: "view", inputs: [], outputs: [{ type: "bytes32" }] },
  { type: "function", name: "UPGRADE_INTERFACE_VERSION", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
  {
    type: "function",
    name: "upgradeToAndCall",
    stateMutability: "payable",
    inputs: [{ name: "newImplementation", type: "address" }, { name: "data", type: "bytes" }],
    outputs: [],
  },
] as const;

// Post-HTS-migration: PT, YT, and LP are HTS-native fungible tokens. Market is no
// longer the LP token itself — `market.lp()` returns the HTS LP address. ERC-20
// reads (name/symbol/decimals/balanceOf/totalSupply) on PT/YT/LP go through their
// HTS facades — use `erc20Abi` against the address from `pt()` / `yt()` / `lp()`.
export const marketAbi = [
  { type: "function", name: "sy", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { type: "function", name: "pt", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { type: "function", name: "yt", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { type: "function", name: "lp", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { type: "function", name: "ptAddr", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { type: "function", name: "ytAddr", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { type: "function", name: "expiry", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "scalarRoot", stateMutability: "view", inputs: [], outputs: [{ type: "int256" }] },
  { type: "function", name: "totalSy", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "totalPt", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  {
    type: "function",
    name: "lastLnImpliedRate",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "int256" }],
  },
  {
    type: "function",
    name: "assetDecimals",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint8" }],
  },
  {
    type: "function",
    name: "globalIndex",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "previewYield",
    stateMutability: "view",
    inputs: [{ name: "user", type: "address" }],
    outputs: [{ type: "uint256" }],
  },
  // FissionRewardsMarket V3-LP SY-yield stream: (usdc 6dec, whbar 8dec).
  // `previewYield` reverts on the deployed rewards market — this is the live,
  // non-zero unclaimed-rewards read. Verified on-chain 2026-05-29:
  // previewRewards(deployer) → (usdc, whbar) non-zero.
  {
    type: "function",
    name: "previewRewards",
    stateMutability: "view",
    inputs: [{ name: "user", type: "address" }],
    outputs: [
      { name: "usdc", type: "uint256" },
      { name: "whbar", type: "uint256" },
    ],
  },
  {
    type: "function",
    name: "userOwed",
    stateMutability: "view",
    inputs: [{ name: "u", type: "address" }],
    outputs: [{ type: "uint256" }],
  },
] as const;

// FissionLens — exact swap-output previews. Replaces the frontend's
// simple-interest `1 - ptRate` model which drifts ~1.8% high on the YT side
// (PT side fine because PT trades near 1). Without the lens, SellYtForm needs
// 5%+ slippage to avoid InsufficientOutput reverts.
export const lensAbi = [
  {
    type: "function",
    name: "previewBuyYt",
    stateMutability: "view",
    inputs: [
      { name: "market", type: "address" },
      { name: "syBudget", type: "uint256" },
      { name: "maxTradeBps", type: "uint16" },
    ],
    outputs: [
      { name: "ytOut", type: "uint256" },
      { name: "netCost", type: "uint256" },
    ],
  },
  {
    type: "function",
    name: "previewSwapExactYtForSy",
    stateMutability: "view",
    inputs: [
      { name: "market", type: "address" },
      { name: "ytIn", type: "uint256" },
    ],
    outputs: [
      { name: "syOut", type: "uint256" },
      { name: "syOwed", type: "uint256" },
    ],
  },
  {
    type: "function",
    name: "previewSwapExactPtForSy",
    stateMutability: "view",
    inputs: [
      { name: "market", type: "address" },
      { name: "ptIn", type: "uint256" },
    ],
    outputs: [{ name: "syOut", type: "uint256" }],
  },
  {
    type: "function",
    name: "previewSwapExactSyForPt",
    stateMutability: "view",
    inputs: [
      { name: "market", type: "address" },
      { name: "ptOut", type: "uint256" },
    ],
    outputs: [{ name: "syUsed", type: "uint256" }],
  },
  // ── 2026-05-29 UUPS-proxy + freeze-PT rebuild additions ──
  // Contract-tracked balances (HTS facade balanceOf reverts for Ed25519 long-
  // zero addresses, so the Lens proxies the market's internal ledger) + the
  // pending AMM-fee accrual previews (99% of swap fees → PT+YT holders).
  {
    type: "function",
    name: "previewPtBalance",
    stateMutability: "view",
    inputs: [
      { name: "market", type: "address" },
      { name: "user", type: "address" },
    ],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "previewYtBalance",
    stateMutability: "view",
    inputs: [
      { name: "market", type: "address" },
      { name: "user", type: "address" },
    ],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "previewPendingPtAmm",
    stateMutability: "view",
    inputs: [
      { name: "market", type: "address" },
      { name: "user", type: "address" },
    ],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "previewPendingYtAmm",
    stateMutability: "view",
    inputs: [
      { name: "market", type: "address" },
      { name: "user", type: "address" },
    ],
    outputs: [{ type: "uint256" }],
  },
  // UUPS proxy surface (Lens is deployed behind an ERC1967 proxy).
  { type: "function", name: "proxiableUUID", stateMutability: "view", inputs: [], outputs: [{ type: "bytes32" }] },
  { type: "function", name: "UPGRADE_INTERFACE_VERSION", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
  {
    type: "function",
    name: "upgradeToAndCall",
    stateMutability: "payable",
    inputs: [{ name: "newImplementation", type: "address" }, { name: "data", type: "bytes" }],
    outputs: [],
  },
] as const;

export const erc20Abi = [
  { type: "function", name: "name", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
  { type: "function", name: "symbol", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
  { type: "function", name: "decimals", stateMutability: "view", inputs: [], outputs: [{ type: "uint8" }] },
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [{ name: "a", type: "address" }],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "totalSupply",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint256" }],
  },
] as const;

// Post-HTS-migration: the SY contract is NOT itself an ERC-20. The share token is a
// separate HTS-native fungible at `sy.shareToken()` — call `IERC20(sy.shareToken())`
// for ERC-20 reads (balanceOf / totalSupply / transfer / approve). Same pattern as
// market.pt() / market.yt() / market.lp().
export const syAbi = [
  {
    type: "function",
    name: "shareToken",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "address" }],
  },
  {
    type: "function",
    name: "exchangeRate",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "decimals",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint8" }],
  },
  {
    type: "function",
    name: "assetInfo",
    stateMutability: "view",
    inputs: [],
    outputs: [
      { name: "assetType", type: "uint8" },
      { name: "assetAddress", type: "address" },
      { name: "assetDecimals", type: "uint8" },
    ],
  },
  {
    type: "function",
    name: "yieldToken",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "address" }],
  },
  {
    type: "function",
    name: "getRewardTokens",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "address[]" }],
  },
  {
    type: "function",
    name: "previewDeposit",
    stateMutability: "view",
    inputs: [
      { name: "tokenIn", type: "address" },
      { name: "amountIn", type: "uint256" },
    ],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "previewRedeem",
    stateMutability: "view",
    inputs: [
      { name: "tokenOut", type: "address" },
      { name: "shares", type: "uint256" },
    ],
    outputs: [{ type: "uint256" }],
  },
] as const;
