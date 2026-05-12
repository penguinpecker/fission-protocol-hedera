/**
 * ABIs for write functions (separated from `abis.ts` to keep read-only client code
 * lean — write paths only land in the trade view).
 */

export const routerAbi = [
  {
    type: "function",
    name: "depositAndSplit",
    stateMutability: "payable",
    inputs: [
      { name: "market", type: "address" },
      { name: "tokenIn", type: "address" },
      { name: "amountIn", type: "uint256" },
      { name: "minPyOut", type: "uint256" },
      { name: "receiver", type: "address" },
      { name: "deadline", type: "uint256" },
    ],
    outputs: [
      { name: "ptOut", type: "uint256" },
      { name: "ytOut", type: "uint256" },
    ],
  },
  {
    type: "function",
    name: "swapExactSyForPt",
    stateMutability: "nonpayable",
    inputs: [
      { name: "market", type: "address" },
      { name: "syIn", type: "uint256" },
      { name: "ptOut", type: "uint256" },
      { name: "receiver", type: "address" },
      { name: "deadline", type: "uint256" },
    ],
    outputs: [{ name: "syUsed", type: "uint256" }],
  },
  {
    type: "function",
    name: "swapExactPtForSy",
    stateMutability: "nonpayable",
    inputs: [
      { name: "market", type: "address" },
      { name: "ptIn", type: "uint256" },
      { name: "minSyOut", type: "uint256" },
      { name: "receiver", type: "address" },
      { name: "deadline", type: "uint256" },
    ],
    outputs: [{ name: "syOut", type: "uint256" }],
  },
  {
    type: "function",
    name: "buyYT",
    stateMutability: "nonpayable",
    inputs: [
      { name: "market", type: "address" },
      { name: "syBudget", type: "uint256" },
      { name: "minSyOutFromPtSale", type: "uint256" },
      { name: "receiver", type: "address" },
      { name: "deadline", type: "uint256" },
    ],
    outputs: [
      { name: "ytOut", type: "uint256" },
      { name: "syRefund", type: "uint256" },
    ],
  },
  {
    type: "function",
    name: "addLiquidityProportional",
    stateMutability: "nonpayable",
    inputs: [
      { name: "market", type: "address" },
      { name: "syIn", type: "uint256" },
      { name: "ptIn", type: "uint256" },
      { name: "minLpOut", type: "uint256" },
      { name: "receiver", type: "address" },
      { name: "deadline", type: "uint256" },
    ],
    outputs: [{ name: "lpOut", type: "uint256" }],
  },
  {
    type: "function",
    name: "removeLiquidityProportional",
    stateMutability: "nonpayable",
    inputs: [
      { name: "market", type: "address" },
      { name: "lpIn", type: "uint256" },
      { name: "minSyOut", type: "uint256" },
      { name: "minPtOut", type: "uint256" },
      { name: "receiver", type: "address" },
      { name: "deadline", type: "uint256" },
    ],
    outputs: [
      { name: "syOut", type: "uint256" },
      { name: "ptOut", type: "uint256" },
    ],
  },
  {
    type: "function",
    name: "redeemAfterExpiryAndUnwrap",
    stateMutability: "nonpayable",
    inputs: [
      { name: "market", type: "address" },
      { name: "ptIn", type: "uint256" },
      { name: "tokenOut", type: "address" },
      { name: "minTokenOut", type: "uint256" },
      { name: "receiver", type: "address" },
      { name: "deadline", type: "uint256" },
    ],
    outputs: [{ name: "amountOut", type: "uint256" }],
  },
  {
    type: "function",
    name: "unwrapSY",
    stateMutability: "nonpayable",
    inputs: [
      { name: "sy", type: "address" },
      { name: "shares", type: "uint256" },
      { name: "tokenOut", type: "address" },
      { name: "minTokenOut", type: "uint256" },
      { name: "receiver", type: "address" },
      { name: "deadline", type: "uint256" },
    ],
    outputs: [{ name: "amountOut", type: "uint256" }],
  },
] as const;

export const erc20WriteAbi = [
  {
    type: "function",
    name: "approve",
    stateMutability: "nonpayable",
    inputs: [
      { name: "spender", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ type: "bool" }],
  },
  {
    type: "function",
    name: "allowance",
    stateMutability: "view",
    inputs: [
      { name: "owner", type: "address" },
      { name: "spender", type: "address" },
    ],
    outputs: [{ type: "uint256" }],
  },
] as const;

export const fissionZapAbi = [
  {
    type: "function",
    name: "zapHbarToSy",
    stateMutability: "payable",
    inputs: [
      { name: "sy", type: "address" },
      { name: "wrapAmount", type: "uint256" },
      { name: "swapAmount", type: "uint256" },
      { name: "usdcMinOut", type: "uint256" },
      { name: "amount0Min", type: "uint256" },
      { name: "amount1Min", type: "uint256" },
      { name: "minShares", type: "uint128" },
      { name: "receiver", type: "address" },
    ],
    outputs: [{ name: "shares", type: "uint256" }],
  },
] as const;

export const syWriteAbi = [
  {
    type: "function",
    name: "depositLiquidity",
    stateMutability: "payable",
    inputs: [
      { name: "amount0", type: "uint256" }, // USDC
      { name: "amount1", type: "uint256" }, // WHBAR
      { name: "amount0Min", type: "uint256" },
      { name: "amount1Min", type: "uint256" },
      { name: "receiver", type: "address" },
      { name: "minShares", type: "uint128" },
    ],
    outputs: [{ name: "shares", type: "uint256" }],
  },
  {
    type: "function",
    name: "claimRewards",
    stateMutability: "nonpayable",
    inputs: [{ name: "user", type: "address" }],
    outputs: [{ type: "uint256[]" }],
  },
  {
    type: "function",
    name: "harvest",
    stateMutability: "nonpayable",
    inputs: [],
    outputs: [],
  },
] as const;

export const marketWriteAbi = [
  {
    type: "function",
    name: "split",
    stateMutability: "nonpayable",
    inputs: [{ name: "amount", type: "uint256" }],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "merge",
    stateMutability: "nonpayable",
    inputs: [{ name: "amount", type: "uint256" }],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "claimYield",
    stateMutability: "nonpayable",
    inputs: [{ name: "receiver", type: "address" }],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "redeemAfterExpiry",
    stateMutability: "nonpayable",
    inputs: [
      { name: "ptIn", type: "uint256" },
      { name: "ytIn", type: "uint256" },
      { name: "receiver", type: "address" },
    ],
    outputs: [{ type: "uint256" }],
  },
] as const;
