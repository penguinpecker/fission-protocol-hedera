// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";

import {IFissionMarketCommon} from "../interfaces/IFissionMarketCommon.sol";
import {IStandardizedYield} from "../interfaces/IStandardizedYield.sol";
import {HtsHelpers} from "../libraries/HtsHelpers.sol";

/// @title  FissionPeriphery — single user-facing contract for Fission Protocol.
/// @notice Consolidates the prior FissionZap + MegaZap + Unzap + Gateway +
///         ActionRouter into one contract. Deterministic 2-tx flow for every
///         Buy and Sell operation — there is no atomic 1-tx variant and no
///         fallback path. Each leg targets ≤30 child records (half of
///         Hedera's 50-child consensus cap) so the design holds regardless
///         of downstream gas / precompile changes.
///
///         Buy path:
///           Tx 1: zapHbarToSy(market, receiver, deadline)
///           Tx 2: buySyForPt / buySyForYt / buySyForLp (using SY received in tx1)
///
///         Sell path:
///           Tx 1: sellPtForSy / sellYtForSy / sellLpForSy (delivers SY to user)
///           Tx 2: unzapSyToHbar (using SY received in tx1)
///
///         User one-time setup per market (handled by the frontend):
///           - approve SY share, PT, LP to this Periphery (int64.max).
///           - market.setOperator(periphery, true) for YT-sell support.
///
///         Periphery one-time setup per market (admin):
///           - registerMarket(market) — pre-approves SY-share / PT / LP from
///             Periphery → Market at int64.max, so curve operations cost 0
///             approval child records.
///
/// @dev    All HTS tokens stay HTS-native. Periphery never wraps tokens into
///         ERC-20 storage. HBAR ↔ HTS conversion happens via the WHBAR contract
///         and the SaucerSwap V2 SwapRouter; MetaMask users interact through
///         Hashio's EVM facade transparently.
interface IWHBAR {
    function deposit() external payable;
    function withdraw(uint256 amount) external;
}

interface ISaucerSwapV2Router {
    struct ExactInputSingleParams {
        address tokenIn;
        address tokenOut;
        uint24 fee;
        address recipient;
        uint256 deadline;
        uint256 amountIn;
        uint256 amountOutMinimum;
        uint160 sqrtPriceLimitX96;
    }
    function exactInputSingle(ExactInputSingleParams calldata params)
        external
        payable
        returns (uint256 amountOut);
}

interface ISYLiquidity {
    function shareToken() external view returns (address);
    function token0() external view returns (address);
    function token1() external view returns (address);
    function depositLiquidity(
        uint256 amount0Desired,
        uint256 amount1Desired,
        uint256 amount0Min,
        uint256 amount1Min,
        address receiver,
        uint128 minLiquidity
    ) external payable returns (uint128 liquidity);
    function redeemLiquidity(uint256 shares, uint256 amount0Min, uint256 amount1Min, address receiver)
        external
        returns (uint256 amount0, uint256 amount1);
}

interface IFissionMarketExt {
    function pt() external view returns (address);
    function yt() external view returns (address);
    function sy() external view returns (IStandardizedYield);
    function lp() external view returns (address);
    function totalPt() external view returns (uint256);
    function totalSy() external view returns (uint256);

    function splitTo(uint256 amount, address ptReceiver, address ytReceiver) external returns (uint256);
    function swapExactSyForPt(uint256 syInMax, uint256 ptOut, address receiver) external returns (uint256);
    function swapExactPtForSy(uint256 ptIn, uint256 minSyOut, address receiver) external returns (uint256);
    function swapExactYtForSyFor(address owner, uint256 ytIn, uint256 minSyOut, address receiver) external returns (uint256);
    function addLiquidity(uint256 syIn, uint256 ptIn, uint256 minLpOut, address receiver) external returns (uint256);
    function removeLiquidity(uint256 lpIn, uint256 minSyOut, uint256 minPtOut, address receiver) external returns (uint256, uint256);
}

contract FissionPeriphery is ReentrancyGuardTransient {
    using SafeERC20 for IERC20;

    // ───────────────────── immutables ─────────────────────

    address public immutable WHBAR_CONTRACT;
    address public immutable WHBAR;
    address public immutable USDC;
    address public immutable V2_ROUTER;
    address public immutable V3_NPM;

    uint24 public constant POOL_FEE = 1500; // 0.15% SaucerSwap V2 tier

    /// @dev HTS allowance ceiling — int64.max. Approving uint256.max reverts on HTS.
    uint256 public constant MAX_HTS_APPROVE = uint256(uint64(type(int64).max));

    // ───────────────────── owner / ops ─────────────────────

    address public owner;
    address public pendingOwner;

    /// @notice Max trade size as basis points of pool depth (5% default). Owner-settable.
    ///         Defense-in-depth against single-trade pool bricking. Applied to every
    ///         AMM-touching entry point.
    uint16 public maxTradeBps = 500;

    /// @notice V3 NPM mint fee budget in tinybars (default 5 HBAR). Owner-settable
    ///         because SaucerSwap V2 doesn't expose a queryable mintFee() and the
    ///         actual fee can drift with the Hedera exchange rate. Tune without
    ///         redeploy.
    uint256 public v3NpmFeeBudget = 5 * 1e8;

    /// @notice Registered markets — bookkeeping for the indexer and the approval cache.
    ///         registerMarket() pre-approves SY-share / PT / LP → market at int64.max.
    mapping(address => bool) public marketRegistered;

    // ───────────────────── errors ─────────────────────

    error AmountZero();
    error ZeroAddress();
    error DeadlineExpired();
    error NotOwner();
    error InsufficientShares(uint256 actual, uint256 min);
    error InsufficientPtOut(uint256 actual, uint256 min);
    error InsufficientYtOut(uint256 actual, uint256 min);
    error InsufficientLpOut(uint256 actual, uint256 min);
    error InsufficientSyOut(uint256 actual, uint256 min);
    error InsufficientHbarOut(uint256 actual, uint256 min);
    error UnexpectedSyTokens(address t0, address t1);
    error HbarTransferFailed();
    error MarketNotRegistered(address market);
    error TradeExceedsCap(uint256 attempted, uint256 cap);
    error InvalidCap(uint16 bps);
    error InvalidShareBps(uint16 bps);
    error InvalidFeeBudget(uint256 amount);

    // ───────────────────── events ─────────────────────

    event MarketRegistered(address indexed market, address indexed sy, address pt, address yt, address lp);
    event MaxTradeBpsUpdated(uint16 prev, uint16 next);
    event V3NpmFeeBudgetUpdated(uint256 prev, uint256 next);
    event OwnershipTransferStarted(address indexed prev, address indexed next);
    event OwnershipTransferred(address indexed prev, address indexed next);
    event TokenRescued(address indexed token, address indexed to, uint256 amount);
    event HbarRescued(address indexed to, uint256 amount);

    /// @notice Unified action event for the cron-indexer.
    /// @dev    kind ∈ {0=zapHbarToSy, 1=buySyForPt, 2=buySyForYt, 3=buySyForLp,
    ///                 4=sellPtForSy, 5=sellYtForSy, 6=sellLpForSy, 7=unzapSyToHbar}
    event PeripheryAction(
        uint8 indexed kind,
        address indexed market,
        address indexed user,
        uint256 amountIn,
        uint256 amountOut,
        uint256 secondaryOut
    );

    // ───────────────────── modifiers ─────────────────────

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    modifier checkDeadline(uint256 deadline) {
        if (deadline != 0 && block.timestamp > deadline) revert DeadlineExpired();
        _;
    }

    // ───────────────────── construction ─────────────────────

    /// @param markets List of markets to pre-register and pre-approve at construction.
    ///                Pass empty array for staged deploys; call registerMarket() later.
    constructor(
        address whbarContract,
        address whbarToken,
        address usdcToken,
        address v2Router,
        address v3Npm,
        address[] memory markets
    ) {
        if (
            whbarContract == address(0) || whbarToken == address(0) || usdcToken == address(0)
                || v2Router == address(0) || v3Npm == address(0)
        ) {
            revert ZeroAddress();
        }
        WHBAR_CONTRACT = whbarContract;
        WHBAR = whbarToken;
        USDC = usdcToken;
        V2_ROUTER = v2Router;
        V3_NPM = v3Npm;
        owner = msg.sender;

        // Associate USDC + WHBAR so the contract can hold them transiently
        // during the swap leg of zapHbarToSy / unzapSyToHbar.
        HtsHelpers.associateIfNeeded(address(this), usdcToken);
        HtsHelpers.associateIfNeeded(address(this), whbarToken);

        for (uint256 i = 0; i < markets.length; i++) {
            _registerMarket(markets[i]);
        }
    }

    // ───────────────────── admin ─────────────────────

    function registerMarket(address market) external onlyOwner {
        _registerMarket(market);
    }

    function _registerMarket(address market) internal {
        if (market == address(0)) revert ZeroAddress();
        if (marketRegistered[market]) return;

        IFissionMarketExt m = IFissionMarketExt(market);
        address syAdapter = address(m.sy());
        address shareToken = ISYLiquidity(syAdapter).shareToken();
        address pt = m.pt();
        address lp = m.lp();

        // Associate the per-market tokens so the contract can custody them
        // briefly during curve trades (sellLpForSy holds PT + SY mid-swap).
        HtsHelpers.associateIfNeeded(address(this), shareToken);
        HtsHelpers.associateIfNeeded(address(this), pt);
        HtsHelpers.associateIfNeeded(address(this), lp);

        // Pre-approve curve-side spending so swap/addLiquidity/removeLiquidity
        // never burn child records on runtime approvals.
        IERC20(shareToken).forceApprove(market, MAX_HTS_APPROVE);
        IERC20(pt).forceApprove(market, MAX_HTS_APPROVE);
        IERC20(lp).forceApprove(market, MAX_HTS_APPROVE);

        // Pre-approve SY adapter to pull USDC + WHBAR for depositLiquidity.
        IERC20(USDC).forceApprove(syAdapter, MAX_HTS_APPROVE);
        IERC20(WHBAR).forceApprove(syAdapter, MAX_HTS_APPROVE);

        marketRegistered[market] = true;
        emit MarketRegistered(market, syAdapter, pt, m.yt(), lp);
    }

    function setMaxTradeBps(uint16 bps) external onlyOwner {
        if (bps == 0 || bps > 10000) revert InvalidCap(bps);
        emit MaxTradeBpsUpdated(maxTradeBps, bps);
        maxTradeBps = bps;
    }

    /// @notice Tune the V3 NPM mint-fee budget (tinybars). Default 5 HBAR.
    function setV3NpmFeeBudget(uint256 tinybars) external onlyOwner {
        if (tinybars == 0 || tinybars > 50 * 1e8) revert InvalidFeeBudget(tinybars);
        emit V3NpmFeeBudgetUpdated(v3NpmFeeBudget, tinybars);
        v3NpmFeeBudget = tinybars;
    }

    function transferOwnership(address newOwner) external onlyOwner {
        if (newOwner == address(0)) revert ZeroAddress();
        pendingOwner = newOwner;
        emit OwnershipTransferStarted(owner, newOwner);
    }

    function acceptOwnership() external {
        if (msg.sender != pendingOwner) revert NotOwner();
        address prev = owner;
        owner = pendingOwner;
        pendingOwner = address(0);
        emit OwnershipTransferred(prev, owner);
    }

    function rescueToken(address token, address to, uint256 amount) external onlyOwner {
        if (to == address(0)) revert ZeroAddress();
        IERC20(token).safeTransfer(to, amount);
        emit TokenRescued(token, to, amount);
    }

    function rescueHbar(address to, uint256 amount) external onlyOwner {
        if (to == address(0)) revert ZeroAddress();
        (bool ok, ) = payable(to).call{value: amount}("");
        if (!ok) revert HbarTransferFailed();
        emit HbarRescued(to, amount);
    }

    // ───────────────────── helpers ─────────────────────

    function _checkSize(uint256 tradeAmount, uint256 referenceTotal) internal view {
        if (referenceTotal == 0) return; // empty pool (seed-time)
        uint256 cap = (referenceTotal * maxTradeBps) / 10000;
        if (tradeAmount > cap) revert TradeExceedsCap(tradeAmount, cap);
    }

    function _ensureApproval(address token, address spender) internal {
        if (IERC20(token).allowance(address(this), spender) < MAX_HTS_APPROVE) {
            IERC20(token).forceApprove(spender, MAX_HTS_APPROVE);
        }
    }

    // ───────────────────── Tx 1: HBAR → SY ─────────────────────

    /// @notice Tx 1 of the Buy flow. Wraps HBAR → WHBAR, swaps half WHBAR → USDC
    ///         on SaucerSwap V2, and deposits both into the market's SY adapter.
    ///         SY shares are delivered directly to `receiver` (the user).
    /// @dev    The frontend reads the user's SY-share balance delta after this tx
    ///         lands and passes it as `syIn` to the next buy leg.
    function zapHbarToSy(address market, address receiver, uint256 deadline)
        external
        payable
        nonReentrant
        checkDeadline(deadline)
        returns (uint256 sharesOut)
    {
        if (msg.value == 0) revert AmountZero();
        if (receiver == address(0)) revert ZeroAddress();
        if (!marketRegistered[market]) revert MarketNotRegistered(market);

        address syAdapter = address(IFissionMarketExt(market).sy());
        address shareToken = ISYLiquidity(syAdapter).shareToken();

        // Reserve v3NpmFeeBudget tinybars for the NPM mint fee. The adapter
        // forwards the contract's HBAR balance; NPM consumes what it needs.
        if (msg.value <= v3NpmFeeBudget) revert AmountZero();
        uint256 wrapAmount = msg.value - v3NpmFeeBudget;
        IWHBAR(WHBAR_CONTRACT).deposit{value: wrapAmount}();

        // Swap half the wrapped WHBAR → USDC via V2.
        uint256 whbarBal = IERC20(WHBAR).balanceOf(address(this));
        uint256 swapAmount = whbarBal / 2;
        _ensureApproval(WHBAR, V2_ROUTER);
        ISaucerSwapV2Router(V2_ROUTER).exactInputSingle(
            ISaucerSwapV2Router.ExactInputSingleParams({
                tokenIn: WHBAR,
                tokenOut: USDC,
                fee: POOL_FEE,
                recipient: address(this),
                deadline: block.timestamp,
                amountIn: swapAmount,
                amountOutMinimum: 0,
                sqrtPriceLimitX96: 0
            })
        );

        // Deposit USDC + remaining WHBAR into SY adapter. Pre-approved at registerMarket.
        uint256 usdcBal = IERC20(USDC).balanceOf(address(this));
        whbarBal = IERC20(WHBAR).balanceOf(address(this));
        uint128 liquidity = ISYLiquidity(syAdapter).depositLiquidity{value: address(this).balance}(
            usdcBal,
            whbarBal,
            0,
            0,
            receiver,
            1
        );
        sharesOut = uint256(liquidity);
        if (sharesOut == 0) revert InsufficientShares(0, 1);

        // Refund dust tokens + leftover HBAR.
        _refundDust(USDC, WHBAR, shareToken);

        emit PeripheryAction(0, market, receiver, msg.value, sharesOut, 0);
    }

    // ───────────────────── Tx 2: SY → PT / YT / LP ─────────────────────

    /// @notice Tx 2 of the Buy-PT flow. Pulls `syIn` SY shares from msg.sender,
    ///         swaps via the market for at least `minPtOut` PT, delivered to `receiver`.
    function buySyForPt(address market, uint256 syIn, uint256 minPtOut, address receiver, uint256 deadline)
        external
        nonReentrant
        checkDeadline(deadline)
        returns (uint256 ptOut)
    {
        if (syIn == 0 || minPtOut == 0) revert AmountZero();
        if (receiver == address(0)) revert ZeroAddress();
        if (!marketRegistered[market]) revert MarketNotRegistered(market);

        IFissionMarketExt m = IFissionMarketExt(market);
        address shareToken = ISYLiquidity(address(m.sy())).shareToken();

        _checkSize(syIn, m.totalPt() + m.totalSy());

        IERC20(shareToken).safeTransferFrom(msg.sender, address(this), syIn);

        uint256 syUsed = m.swapExactSyForPt(syIn, minPtOut, receiver);
        ptOut = minPtOut;

        // Refund any unused SY (the curve consumed less than syIn).
        if (syUsed < syIn) {
            IERC20(shareToken).safeTransfer(msg.sender, syIn - syUsed);
        }

        emit PeripheryAction(1, market, msg.sender, syIn, ptOut, 0);
    }

    /// @notice Tx 2 of the Buy-YT flow. SY → split into PT+YT, then sells the PT
    ///         for SY (refunded to receiver). YT (and SY refund) go to `receiver`.
    function buySyForYt(
        address market,
        uint256 syIn,
        uint256 minSyOutFromPtSale,
        address receiver,
        uint256 deadline
    )
        external
        nonReentrant
        checkDeadline(deadline)
        returns (uint256 ytOut, uint256 syRefund)
    {
        if (syIn == 0) revert AmountZero();
        if (receiver == address(0)) revert ZeroAddress();
        if (!marketRegistered[market]) revert MarketNotRegistered(market);

        IFissionMarketExt m = IFissionMarketExt(market);
        address shareToken = ISYLiquidity(address(m.sy())).shareToken();

        _checkSize(syIn, m.totalPt() + m.totalSy());

        IERC20(shareToken).safeTransferFrom(msg.sender, address(this), syIn);

        // Split: PT to this contract (for resale), YT to receiver (frozen there).
        m.splitTo(syIn, address(this), receiver);
        ytOut = syIn;

        // Sell the PT half for SY → receiver.
        syRefund = m.swapExactPtForSy(syIn, minSyOutFromPtSale, receiver);

        emit PeripheryAction(2, market, receiver, syIn, ytOut, syRefund);
    }

    /// @notice Tx 2 of the Buy-LP flow. Splits SY into (syForLp, syForPt), swaps
    ///         syForPt → PT, then adds (syForLp, PT) as proportional liquidity.
    function buySyForLp(
        address market,
        uint256 syIn,
        uint16 ptShareBps,
        uint256 minLpOut,
        address receiver,
        uint256 deadline
    )
        external
        nonReentrant
        checkDeadline(deadline)
        returns (uint256 lpOut)
    {
        if (syIn == 0 || minLpOut == 0) revert AmountZero();
        if (ptShareBps == 0 || ptShareBps >= 10000) revert InvalidShareBps(ptShareBps);
        if (receiver == address(0)) revert ZeroAddress();
        if (!marketRegistered[market]) revert MarketNotRegistered(market);

        IFissionMarketExt m = IFissionMarketExt(market);
        address shareToken = ISYLiquidity(address(m.sy())).shareToken();
        address pt = m.pt();

        _checkSize(syIn, m.totalPt() + m.totalSy());

        IERC20(shareToken).safeTransferFrom(msg.sender, address(this), syIn);

        // Split budget: swap `syForPt` → PT, keep `syForLp` for addLiquidity.
        uint256 syForPt = (syIn * ptShareBps) / 10000;
        uint256 syForLp = syIn - syForPt;

        // Swap SY → PT (curve gives exact PT for syForPt SY).
        m.swapExactSyForPt(syForPt, 1, address(this));
        uint256 ptAcquired = IERC20(pt).balanceOf(address(this));

        lpOut = m.addLiquidity(syForLp, ptAcquired, minLpOut, receiver);
        if (lpOut < minLpOut) revert InsufficientLpOut(lpOut, minLpOut);

        // Refund any dust (SY or PT) to msg.sender.
        uint256 syLeft = IERC20(shareToken).balanceOf(address(this));
        if (syLeft > 0) IERC20(shareToken).safeTransfer(msg.sender, syLeft);
        uint256 ptLeft = IERC20(pt).balanceOf(address(this));
        if (ptLeft > 0) IERC20(pt).safeTransfer(msg.sender, ptLeft);

        emit PeripheryAction(3, market, receiver, syIn, lpOut, 0);
    }

    // ───────────────────── Tx 1: PT / YT / LP → SY ─────────────────────

    /// @notice Tx 1 of the Sell-PT flow. Pulls PT from user, swaps for SY → receiver.
    function sellPtForSy(address market, uint256 ptIn, uint256 minSyOut, address receiver, uint256 deadline)
        external
        nonReentrant
        checkDeadline(deadline)
        returns (uint256 syOut)
    {
        if (ptIn == 0) revert AmountZero();
        if (receiver == address(0)) revert ZeroAddress();
        if (!marketRegistered[market]) revert MarketNotRegistered(market);

        IFissionMarketExt m = IFissionMarketExt(market);
        address pt = m.pt();

        _checkSize(ptIn, m.totalPt());

        IERC20(pt).safeTransferFrom(msg.sender, address(this), ptIn);
        syOut = m.swapExactPtForSy(ptIn, minSyOut, receiver);

        emit PeripheryAction(4, market, msg.sender, ptIn, syOut, 0);
    }

    /// @notice Tx 1 of the Sell-YT flow. Calls market.swapExactYtForSyFor — user
    ///         must have previously called market.setOperator(periphery, true).
    function sellYtForSy(address market, uint256 ytIn, uint256 minSyOut, address receiver, uint256 deadline)
        external
        nonReentrant
        checkDeadline(deadline)
        returns (uint256 syOut)
    {
        if (ytIn == 0) revert AmountZero();
        if (receiver == address(0)) revert ZeroAddress();
        if (!marketRegistered[market]) revert MarketNotRegistered(market);

        IFissionMarketExt m = IFissionMarketExt(market);
        _checkSize(ytIn, m.totalPt());

        syOut = m.swapExactYtForSyFor(msg.sender, ytIn, minSyOut, receiver);

        emit PeripheryAction(5, market, msg.sender, ytIn, syOut, 0);
    }

    /// @notice Tx 1 of the Sell-LP flow. Burns LP, swaps the PT side to SY,
    ///         delivers all SY to `receiver`.
    function sellLpForSy(address market, uint256 lpIn, uint256 minSyOut, address receiver, uint256 deadline)
        external
        nonReentrant
        checkDeadline(deadline)
        returns (uint256 syOut)
    {
        if (lpIn == 0) revert AmountZero();
        if (receiver == address(0)) revert ZeroAddress();
        if (!marketRegistered[market]) revert MarketNotRegistered(market);

        IFissionMarketExt m = IFissionMarketExt(market);
        address lp = m.lp();
        address pt = m.pt();

        _checkSize(lpIn, IERC20(lp).totalSupply());

        IERC20(lp).safeTransferFrom(msg.sender, address(this), lpIn);
        (uint256 syFromLp, uint256 ptFromLp) = m.removeLiquidity(lpIn, 1, 1, address(this));

        syOut = syFromLp;
        if (ptFromLp > 0) {
            syOut += m.swapExactPtForSy(ptFromLp, 1, address(this));
        }
        if (syOut < minSyOut) revert InsufficientSyOut(syOut, minSyOut);

        address shareToken = ISYLiquidity(address(m.sy())).shareToken();
        IERC20(shareToken).safeTransfer(receiver, syOut);

        emit PeripheryAction(6, market, msg.sender, lpIn, syOut, 0);
    }

    // ───────────────────── Tx 2: SY → HBAR ─────────────────────

    /// @notice Tx 2 of the Sell flow. Pulls SY shares from user, redeems via the
    ///         adapter, swaps USDC → WHBAR, unwraps to HBAR → msg.sender.
    function unzapSyToHbar(address syAdapter, uint256 sharesIn, uint256 minHbarOut, uint256 deadline)
        external
        nonReentrant
        checkDeadline(deadline)
        returns (uint256 hbarOut)
    {
        if (sharesIn == 0) revert AmountZero();
        if (syAdapter == address(0)) revert ZeroAddress();

        address shareToken = ISYLiquidity(syAdapter).shareToken();
        if (shareToken == address(0)) revert ZeroAddress();

        IERC20(shareToken).safeTransferFrom(msg.sender, address(this), sharesIn);

        (uint256 usdcOut, uint256 whbarOut, uint256 hbarTotal) = _redeemSyToHbar(syAdapter, sharesIn);
        if (hbarTotal < minHbarOut) revert InsufficientHbarOut(hbarTotal, minHbarOut);
        (bool ok, ) = payable(msg.sender).call{value: hbarTotal}("");
        if (!ok) revert HbarTransferFailed();

        hbarOut = hbarTotal;
        emit PeripheryAction(7, syAdapter, msg.sender, sharesIn, hbarOut, 0);
        usdcOut; whbarOut; // silence unused
        if (block.timestamp > deadline && deadline != 0) revert DeadlineExpired();
    }

    /// @dev SY → USDC + WHBAR → all-WHBAR → HBAR pipeline shared by sells.
    function _redeemSyToHbar(address syAdapter, uint256 sharesIn)
        internal
        returns (uint256 usdcRedeemed, uint256 whbarRedeemed, uint256 hbarTotal)
    {
        address t0 = ISYLiquidity(syAdapter).token0();
        address t1 = ISYLiquidity(syAdapter).token1();
        bool standardOrder = (t0 == USDC && t1 == WHBAR);
        bool swappedOrder = (t0 == WHBAR && t1 == USDC);
        if (!standardOrder && !swappedOrder) revert UnexpectedSyTokens(t0, t1);

        (uint256 amount0, uint256 amount1) =
            ISYLiquidity(syAdapter).redeemLiquidity(sharesIn, 0, 0, address(this));
        (usdcRedeemed, whbarRedeemed) = standardOrder ? (amount0, amount1) : (amount1, amount0);

        if (usdcRedeemed > 0) {
            _ensureApproval(USDC, V2_ROUTER);
            uint256 whbarFromSwap = ISaucerSwapV2Router(V2_ROUTER).exactInputSingle(
                ISaucerSwapV2Router.ExactInputSingleParams({
                    tokenIn: USDC,
                    tokenOut: WHBAR,
                    fee: POOL_FEE,
                    recipient: address(this),
                    deadline: block.timestamp,
                    amountIn: usdcRedeemed,
                    amountOutMinimum: 0,
                    sqrtPriceLimitX96: 0
                })
            );
            whbarRedeemed += whbarFromSwap;
        }

        if (whbarRedeemed > 0) {
            _ensureApproval(WHBAR, WHBAR_CONTRACT);
            IWHBAR(WHBAR_CONTRACT).withdraw(whbarRedeemed);
        }

        hbarTotal = address(this).balance;
    }

    function _refundDust(address tA, address tB, address tC) internal {
        uint256 a = IERC20(tA).balanceOf(address(this));
        if (a > 0) IERC20(tA).safeTransfer(msg.sender, a);
        uint256 b = IERC20(tB).balanceOf(address(this));
        if (b > 0) IERC20(tB).safeTransfer(msg.sender, b);
        uint256 c = IERC20(tC).balanceOf(address(this));
        if (c > 0) IERC20(tC).safeTransfer(msg.sender, c);
        uint256 hbarLeft = address(this).balance;
        if (hbarLeft > 0) {
            (bool ok, ) = payable(msg.sender).call{value: hbarLeft}("");
            if (!ok) revert HbarTransferFailed();
        }
    }

    // ───────────────────── view quoters (eth_call simulate) ─────────────────────

    /// @notice Simulate `unzapSyToHbar` end-to-end via eth_call. Frontend uses this
    ///         to size `minHbarOut` against the live V2 USDC/WHBAR pool state.
    /// @dev    Non-view but designed for eth_call invocation (state changes get
    ///         discarded by the RPC). Returns ok=false on any internal revert
    ///         (e.g. unsupported SY shape) so callers don't have to wrap their own
    ///         try/catch.
    function quoteUnzapSy(address syAdapter, uint256 sharesIn)
        external
        returns (uint256 hbarOut, uint256 usdcOut, uint256 whbarOut, bool ok)
    {
        if (sharesIn == 0 || syAdapter == address(0)) return (0, 0, 0, false);
        try this._redeemSyToHbarExternal(syAdapter, sharesIn) returns (uint256 u, uint256 w, uint256 h) {
            usdcOut = u; whbarOut = w; hbarOut = h; ok = true;
        } catch {
            ok = false;
        }
    }

    /// @dev External wrapper around `_redeemSyToHbar` so quoteUnzapSy can try/catch it.
    function _redeemSyToHbarExternal(address syAdapter, uint256 sharesIn)
        external
        returns (uint256 usdcOut, uint256 whbarOut, uint256 hbarOut)
    {
        if (msg.sender != address(this)) revert NotOwner();
        return _redeemSyToHbar(syAdapter, sharesIn);
    }

    // ───────────────────── receive ─────────────────────

    /// @dev Accept HBAR from the WHBAR contract (withdraw) and from the SY adapter
    ///      (V3 NPM mint-fee refund pattern).
    receive() external payable {}
}
