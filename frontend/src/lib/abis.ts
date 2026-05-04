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
  {
    type: "function",
    name: "userOwed",
    stateMutability: "view",
    inputs: [{ name: "u", type: "address" }],
    outputs: [{ type: "uint256" }],
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

export const syAbi = [
  ...erc20Abi,
  {
    type: "function",
    name: "exchangeRate",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint256" }],
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
] as const;
