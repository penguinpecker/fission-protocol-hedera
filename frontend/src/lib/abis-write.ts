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
  // NOTE: `swapExactYtForSy` is intentionally NOT on the routerAbi — YT is
  // freeze-by-default and cannot be transferred to a Router for proxying.
  // The dApp calls `FissionMarket.swapExactYtForSy(...)` directly via
  // `marketWriteAbi` below.
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
      { name: "usdcMinOut", type: "uint256" },
      { name: "amount0Min", type: "uint256" },
      { name: "amount1Min", type: "uint256" },
      { name: "minShares", type: "uint128" },
      { name: "receiver", type: "address" },
    ],
    outputs: [{ name: "shares", type: "uint256" }],
  },
] as const;

// FissionMegaZap (2026-05-14). Atomic HBAR → PT/YT/LP. Wraps FissionZap +
// ActionRouter v3. msg.value forwarded to FissionZap; +5 HBAR NPM fee
// included on top of the user budget (same as fissionZapAbi).
export const megaZapAbi = [
  {
    type: "function",
    name: "zapHbarToPt",
    stateMutability: "payable",
    inputs: [
      { name: "market", type: "address" },
      { name: "sy", type: "address" },
      { name: "minPtOut", type: "uint256" },
      { name: "receiver", type: "address" },
      { name: "deadline", type: "uint256" },
    ],
    outputs: [{ name: "ptOut", type: "uint256" }],
  },
  {
    type: "function",
    name: "zapHbarToYt",
    stateMutability: "payable",
    inputs: [
      { name: "market", type: "address" },
      { name: "sy", type: "address" },
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
    name: "zapHbarToLp",
    stateMutability: "payable",
    inputs: [
      { name: "market", type: "address" },
      { name: "sy", type: "address" },
      { name: "ptShareBps", type: "uint16" },
      { name: "minLpOut", type: "uint256" },
      { name: "receiver", type: "address" },
      { name: "deadline", type: "uint256" },
    ],
    outputs: [{ name: "lpOut", type: "uint256" }],
  },
] as const;

// FissionUnzap (2026-05-25). Mirror of FissionZap; takes a position token
// (PT or LP) or SY shares and delivers native HBAR. Composes router_v3
// + sy.redeemLiquidity + SaucerSwap V2 USDC→WHBAR + WHBAR.withdraw.
export const fissionUnzapAbi = [
  {
    type: "function",
    name: "sellPtForHbar",
    stateMutability: "nonpayable",
    inputs: [
      { name: "market", type: "address" },
      { name: "ptIn", type: "uint256" },
      { name: "minHbarOut", type: "uint256" },
      { name: "receiver", type: "address" },
      { name: "deadline", type: "uint256" },
    ],
    outputs: [{ name: "hbarOut", type: "uint256" }],
  },
  {
    type: "function",
    name: "unzapSy",
    stateMutability: "nonpayable",
    inputs: [
      { name: "sy", type: "address" },
      { name: "sharesIn", type: "uint256" },
      { name: "minHbarOut", type: "uint256" },
      { name: "receiver", type: "address" },
    ],
    outputs: [{ name: "hbarOut", type: "uint256" }],
  },
  {
    type: "function",
    name: "sellLpForHbar",
    stateMutability: "nonpayable",
    inputs: [
      { name: "market", type: "address" },
      { name: "lpIn", type: "uint256" },
      { name: "minHbarOut", type: "uint256" },
      { name: "receiver", type: "address" },
      { name: "deadline", type: "uint256" },
    ],
    outputs: [{ name: "hbarOut", type: "uint256" }],
  },
] as const;

// FissionGateway v2 (2026-05-26) — unified periphery replacing MegaZap +
// FissionUnzap. Single contract for every HBAR↔PT/YT/LP/SY user action.
// Takes only the market address per function (resolves token addresses
// internally). FIXES the v1 unzapSy dual-address bug by deriving the HTS
// share token from the SY adapter via `shareToken()`.
export const fissionGatewayAbi = [
  {
    type: "function",
    name: "zapHbarToPt",
    stateMutability: "payable",
    inputs: [
      { name: "market", type: "address" },
      { name: "minPtOut", type: "uint256" },
      { name: "deadline", type: "uint256" },
    ],
    outputs: [{ name: "ptOut", type: "uint256" }],
  },
  {
    type: "function",
    name: "zapHbarToYt",
    stateMutability: "payable",
    inputs: [
      { name: "market", type: "address" },
      { name: "minSyOutFromPtSale", type: "uint256" },
      { name: "deadline", type: "uint256" },
    ],
    outputs: [
      { name: "ytOut", type: "uint256" },
      { name: "syRefund", type: "uint256" },
    ],
  },
  {
    type: "function",
    name: "zapHbarToLp",
    stateMutability: "payable",
    inputs: [
      { name: "market", type: "address" },
      { name: "ptShareBps", type: "uint16" },
      { name: "minLpOut", type: "uint256" },
      { name: "deadline", type: "uint256" },
    ],
    outputs: [{ name: "lpOut", type: "uint256" }],
  },
  {
    type: "function",
    name: "zapHbarToSy",
    stateMutability: "payable",
    inputs: [
      { name: "syAdapter", type: "address" },
      { name: "receiver", type: "address" },
    ],
    outputs: [{ name: "shares", type: "uint256" }],
  },
  {
    type: "function",
    name: "sellPtForHbar",
    stateMutability: "nonpayable",
    inputs: [
      { name: "market", type: "address" },
      { name: "ptIn", type: "uint256" },
      { name: "minHbarOut", type: "uint256" },
      { name: "deadline", type: "uint256" },
    ],
    outputs: [{ name: "hbarOut", type: "uint256" }],
  },
  {
    type: "function",
    name: "sellLpForHbar",
    stateMutability: "nonpayable",
    inputs: [
      { name: "market", type: "address" },
      { name: "lpIn", type: "uint256" },
      { name: "minHbarOut", type: "uint256" },
      { name: "deadline", type: "uint256" },
    ],
    outputs: [{ name: "hbarOut", type: "uint256" }],
  },
  {
    type: "function",
    name: "unzapSyForHbar",
    stateMutability: "nonpayable",
    inputs: [
      { name: "syAdapter", type: "address" },
      { name: "sharesIn", type: "uint256" },
      { name: "minHbarOut", type: "uint256" },
    ],
    outputs: [{ name: "hbarOut", type: "uint256" }],
  },
  {
    type: "function",
    name: "sweepAllToHbar",
    stateMutability: "nonpayable",
    inputs: [
      { name: "market", type: "address" },
      { name: "minHbarOut", type: "uint256" },
      { name: "deadline", type: "uint256" },
    ],
    outputs: [{ name: "hbarOut", type: "uint256" }],
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
    name: "swapExactYtForSy",
    stateMutability: "nonpayable",
    inputs: [
      { name: "ytIn", type: "uint256" },
      { name: "minSyOut", type: "uint256" },
      { name: "receiver", type: "address" },
    ],
    outputs: [{ name: "syOut", type: "uint256" }],
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
  {
    // Direct add-liquidity. The ActionRouter has a typing bug
    // (addLiquidityProportional casts the SY contract as IERC20 instead of
    // using sy.shareToken()), so the frontend routes around it by calling
    // market.addLiquidity directly. Same signature, minus the deadline
    // (the market function is single-block atomic with no async risk).
    type: "function",
    name: "addLiquidity",
    stateMutability: "nonpayable",
    inputs: [
      { name: "syIn", type: "uint256" },
      { name: "ptIn", type: "uint256" },
      { name: "minLpOut", type: "uint256" },
      { name: "receiver", type: "address" },
    ],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "removeLiquidity",
    stateMutability: "nonpayable",
    inputs: [
      { name: "lpIn", type: "uint256" },
      { name: "minSyOut", type: "uint256" },
      { name: "minPtOut", type: "uint256" },
      { name: "receiver", type: "address" },
    ],
    outputs: [
      { name: "syOut", type: "uint256" },
      { name: "ptOut", type: "uint256" },
    ],
  },
] as const;

/**
 * FissionPeriphery — 2026-05-27+ clean-slate rebuild. Single user-facing
 * contract. 8 entry points, all deterministic 2-tx (no atomic, no fallbacks).
 *
 * Buy:   zapHbarToSy → buySyForPt / buySyForYt / buySyForLp
 * Sell:  sellPtForSy / sellYtForSy / sellLpForSy → unzapSyToHbar
 *
 * Pre-flight: user must approve PT, LP, SY-share → Periphery (max int64) and
 * call market.setOperator(periphery, true) once for YT-sell support.
 */
export const fissionPeripheryAbi = [
  {
    type: "function",
    name: "zapHbarToSy",
    stateMutability: "payable",
    inputs: [
      { name: "market", type: "address" },
      { name: "receiver", type: "address" },
      { name: "deadline", type: "uint256" },
    ],
    outputs: [{ name: "sharesOut", type: "uint256" }],
  },
  {
    type: "function",
    name: "buySyForPt",
    stateMutability: "nonpayable",
    inputs: [
      { name: "market", type: "address" },
      { name: "syIn", type: "uint256" },
      { name: "minPtOut", type: "uint256" },
      { name: "receiver", type: "address" },
      { name: "deadline", type: "uint256" },
    ],
    outputs: [{ name: "ptOut", type: "uint256" }],
  },
  {
    type: "function",
    name: "buySyForYt",
    stateMutability: "nonpayable",
    inputs: [
      { name: "market", type: "address" },
      { name: "syIn", type: "uint256" },
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
    name: "buySyForLp",
    stateMutability: "nonpayable",
    inputs: [
      { name: "market", type: "address" },
      { name: "syIn", type: "uint256" },
      { name: "ptShareBps", type: "uint16" },
      { name: "minLpOut", type: "uint256" },
      { name: "receiver", type: "address" },
      { name: "deadline", type: "uint256" },
    ],
    outputs: [{ name: "lpOut", type: "uint256" }],
  },
  {
    type: "function",
    name: "sellPtForSy",
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
    name: "sellYtForSy",
    stateMutability: "nonpayable",
    inputs: [
      { name: "market", type: "address" },
      { name: "ytIn", type: "uint256" },
      { name: "minSyOut", type: "uint256" },
      { name: "receiver", type: "address" },
      { name: "deadline", type: "uint256" },
    ],
    outputs: [{ name: "syOut", type: "uint256" }],
  },
  {
    type: "function",
    name: "sellLpForSy",
    stateMutability: "nonpayable",
    inputs: [
      { name: "market", type: "address" },
      { name: "lpIn", type: "uint256" },
      { name: "minSyOut", type: "uint256" },
      { name: "receiver", type: "address" },
      { name: "deadline", type: "uint256" },
    ],
    outputs: [{ name: "syOut", type: "uint256" }],
  },
  {
    type: "function",
    name: "unzapSyToHbar",
    stateMutability: "nonpayable",
    inputs: [
      { name: "syAdapter", type: "address" },
      { name: "sharesIn", type: "uint256" },
      { name: "minHbarOut", type: "uint256" },
      { name: "deadline", type: "uint256" },
    ],
    outputs: [{ name: "hbarOut", type: "uint256" }],
  },
  {
    type: "function",
    name: "quoteUnzapSy",
    stateMutability: "nonpayable",
    inputs: [
      { name: "syAdapter", type: "address" },
      { name: "sharesIn", type: "uint256" },
    ],
    outputs: [
      { name: "hbarOut", type: "uint256" },
      { name: "usdcOut", type: "uint256" },
      { name: "whbarOut", type: "uint256" },
      { name: "ok", type: "bool" },
    ],
  },
] as const;
