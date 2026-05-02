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
