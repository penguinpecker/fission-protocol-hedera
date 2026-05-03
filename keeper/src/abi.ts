/**
 * ABIs the keeper needs. Hand-written subset of /contracts/src — kept inline so the
 * keeper has no build-time dependency on the contracts artefacts.
 */

export const syReadAbi = [
  {
    type: "function",
    name: "exchangeRate",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint256" }],
  },
  { type: "function", name: "count", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "paused", stateMutability: "view", inputs: [], outputs: [{ type: "bool" }] },
] as const;

export const syWriteAbi = [
  {
    type: "function",
    name: "postRate",
    stateMutability: "nonpayable",
    inputs: [{ name: "newRate", type: "uint256" }],
    outputs: [],
  },
] as const;

export const staderAbi = [
  {
    type: "function",
    name: "getExchangeRate",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint256" }],
  },
] as const;

