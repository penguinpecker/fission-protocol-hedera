// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";
import {Initializable} from "@openzeppelin/contracts/proxy/utils/Initializable.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts/proxy/utils/UUPSUpgradeable.sol";

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
    /// @dev Rewards-market-only view. Standard `FissionMarket` lacks it; used by
    ///      the periphery to probe market shape at registration (MDS-3).
    function isOperator(address owner, address operator) external view returns (bool);

    function splitTo(uint256 amount, address ptReceiver, address ytReceiver) external returns (uint256);
    function swapExactSyForPt(uint256 syInMax, uint256 ptOut, address receiver) external returns (uint256);
    function swapExactPtForSy(uint256 ptIn, uint256 minSyOut, address receiver) external returns (uint256);
    function swapExactPtForSyFor(address owner, uint256 ptIn, uint256 minSyOut, address receiver) external returns (uint256);
    function swapExactYtForSyFor(address owner, uint256 ytIn, uint256 minSyOut, address receiver) external returns (uint256);
    function addLiquidity(uint256 syIn, uint256 ptIn, uint256 minLpOut, address receiver) external returns (uint256);
    function addLiquidityFor(address owner, uint256 syIn, uint256 ptIn, uint256 minLpOut, address receiver) external returns (uint256);
    function removeLiquidity(uint256 lpIn, uint256 minSyOut, uint256 minPtOut, address receiver) external returns (uint256, uint256);
}

/// @dev    UUPS-upgradeable: deployed behind an ERC1967Proxy. All five former
///         immutables (WHBAR_CONTRACT / WHBAR / USDC / V2_ROUTER / V3_NPM) moved
///         to initializer-set storage because immutables live in the
///         implementation bytecode and are invisible behind a delegatecall proxy.
///         The market's `setPeriphery` MUST point at the PROXY address (stable
///         across upgrades), never at an implementation.
contract FissionPeriphery is Initializable, ReentrancyGuardTransient, UUPSUpgradeable {
    using SafeERC20 for IERC20;

    // ───────────────────── config (was immutable, now initializer-set) ────────

    address public WHBAR_CONTRACT;
    address public WHBAR;
    address public USDC;
    address public V2_ROUTER;
    address public V3_NPM;

    uint24 public constant POOL_FEE = 1500; // 0.15% SaucerSwap V2 tier

    /// @dev HTS allowance ceiling — int64.max. Approving uint256.max reverts on HTS.
    uint256 public constant MAX_HTS_APPROVE = uint256(uint64(type(int64).max));

    // ───────────────────── owner / ops ─────────────────────

    address public owner;
    address public pendingOwner;

    /// @notice Single upgrade-authority (admin / timelock). Set at `initialize`;
    ///         the only address allowed to authorize a UUPS implementation swap.
    ///         Deliberately separate from `owner` (the hot ops key) so a
    ///         compromised owner cannot push a malicious implementation.
    address public upgradeAuthority;

    /// @notice Max trade size as basis points of pool depth (5% default). Owner-settable.
    ///         Defense-in-depth against single-trade pool bricking. Applied to every
    ///         AMM-touching entry point.
    /// @dev    Default (500) is set in `initialize`, not as an inline initializer —
    ///         inline initializers run in the implementation constructor and are
    ///         invisible to the proxy's storage.
    uint16 public maxTradeBps;

    /// @notice V3 NPM mint fee budget in tinybars (default 5 HBAR). Owner-settable
    ///         because SaucerSwap V2 doesn't expose a queryable mintFee() and the
    ///         actual fee can drift with the Hedera exchange rate. Tune without
    ///         redeploy.
    /// @dev    Default (5 HBAR) is set in `initialize` — see `maxTradeBps` note.
    uint256 public v3NpmFeeBudget;

    /// @notice Registered markets — bookkeeping for the indexer and the approval cache.
    ///         registerMarket() pre-approves SY-share / PT / LP → market at int64.max.
    mapping(address => bool) public marketRegistered;

    /// @notice Tokens the protocol treats as protected (cannot be rescued).
    ///         Populated for USDC + WHBAR at construction and for shareToken /
    ///         PT / LP per market on `_registerMarket`. Fixes X-5: prevents
    ///         the owner from ordering-attacking in-flight user dust.
    mapping(address => bool) public isProtectedToken;

    /// @notice SY adapters reachable through a registered market. Populated in
    ///         `_registerMarket`. `unzapSyToHbar` is gated on this so users
    ///         cannot pass an arbitrary (potentially malicious) adapter that
    ///         could siphon the Periphery's standing token approvals.
    mapping(address => bool) public registeredSyAdapter;

    /// @notice MDS-3: true iff the registered market exposes the operator-mediated
    ///         sell selectors (`swapExactPtForSyFor`/`swapExactYtForSyFor`) — i.e.
    ///         it is a `FissionRewardsMarket`, not a plain `FissionMarket`.
    ///         Probed at registration via the rewards-only `isOperator` view. The
    ///         operator sell paths (`sellPtForSy`/`sellYtForSy`) require this so a
    ///         standard market gives a clear revert instead of a raw selector miss.
    mapping(address => bool) public isRewardsMarket;

    /// @notice YT-LEVERAGE (2026-05-31): working-capital SY the Periphery fronts so
    ///         a leveraged Buy-YT can deploy the user's FULL budget into YT (Pendle
    ///         parity) instead of refunding ~98% as SY. Keyed by SY share token.
    ///         Funded/recovered ONLY via fundSyReserve/withdrawSyReserve (owner).
    ///         Every SY-sweep path treats `balance - syReserve[token]` as the only
    ///         user-owned SY, so the reserve can never be swept to a user, and
    ///         `buySyForYt` asserts the reserve is whole at the end of each call.
    mapping(address => uint256) public syReserve;

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
    error UnregisteredSyAdapter(address syAdapter);
    error ProtectedToken(address token);
    error TradeExceedsCap(uint256 attempted, uint256 cap);
    error InvalidCap(uint16 bps);
    error InvalidShareBps(uint16 bps);
    error InvalidFeeBudget(uint256 amount);
    error NotUpgradeAuthority();
    /// @dev MDS-3: operator sell path invoked on a standard (non-rewards) market.
    error OperatorSellUnsupported(address market);
    /// @dev YT-LEVERAGE: the SY needed to mint the requested ytOut exceeds the
    ///      user's budget + the funded working-capital reserve.
    error InsufficientReserve(uint256 needed, uint256 available);
    /// @dev YT-LEVERAGE: reserve-conservation invariant tripped (would-deplete).
    error ReserveViolated(uint256 balance, uint256 reserve);

    // ───────────────────── events ─────────────────────

    event MarketRegistered(address indexed market, address indexed sy, address pt, address yt, address lp);
    event MaxTradeBpsUpdated(uint16 prev, uint16 next);
    event V3NpmFeeBudgetUpdated(uint256 prev, uint256 next);
    event OwnershipTransferStarted(address indexed prev, address indexed next);
    event OwnershipTransferred(address indexed prev, address indexed next);
    event TokenRescued(address indexed token, address indexed to, uint256 amount);
    event HbarRescued(address indexed to, uint256 amount);
    event UpgradeAuthorityUpdated(address indexed prev, address indexed next);
    event SyReserveFunded(address indexed token, uint256 amount, uint256 newReserve);
    event SyReserveWithdrawn(address indexed token, address indexed to, uint256 amount, uint256 newReserve);

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

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        // Lock the bare implementation so it can never be initialized / hijacked.
        _disableInitializers();
    }

    /// @notice Proxy initializer (replaces the old constructor). MUST be called
    ///         through the ERC1967Proxy (delegatecall context) exactly once.
    /// @param whbarContract WHBAR system contract (wrap/unwrap HBAR).
    /// @param whbarToken    WHBAR HTS token address.
    /// @param usdcToken     USDC HTS token address.
    /// @param v2Router      SaucerSwap V2 SwapRouter.
    /// @param v3Npm         SaucerSwap V2 NonfungiblePositionManager.
    /// @param owner_        Hot ops key (registerMarket / rescue / tuning).
    /// @param upgradeAuthority_ admin/timelock allowed to authorize UUPS upgrades.
    /// @param markets       Markets to pre-register and pre-approve. Pass empty
    ///                      array for staged deploys; call registerMarket() later.
    function initialize(
        address whbarContract,
        address whbarToken,
        address usdcToken,
        address v2Router,
        address v3Npm,
        address owner_,
        address upgradeAuthority_,
        address[] memory markets
    ) external initializer {
        if (
            whbarContract == address(0) || whbarToken == address(0) || usdcToken == address(0)
                || v2Router == address(0) || v3Npm == address(0) || owner_ == address(0)
                || upgradeAuthority_ == address(0)
        ) {
            revert ZeroAddress();
        }
        WHBAR_CONTRACT = whbarContract;
        WHBAR = whbarToken;
        USDC = usdcToken;
        V2_ROUTER = v2Router;
        V3_NPM = v3Npm;
        owner = owner_;
        upgradeAuthority = upgradeAuthority_;
        emit UpgradeAuthorityUpdated(address(0), upgradeAuthority_);

        // Default the runtime-tunable params (former inline initializers, which
        // are skipped behind a proxy because they run in the implementation's
        // constructor context, not the proxy's storage).
        maxTradeBps = 500;
        v3NpmFeeBudget = 5 * 1e8;

        // Associate USDC + WHBAR so the contract can hold them transiently
        // during the swap leg of zapHbarToSy / unzapSyToHbar.
        HtsHelpers.associateIfNeeded(address(this), usdcToken);
        HtsHelpers.associateIfNeeded(address(this), whbarToken);

        // X-5: mark protocol tokens unrescuable. Owner can still rescue stray
        // tokens (foreign airdrops, etc) but never the in-flight USDC/WHBAR.
        isProtectedToken[usdcToken] = true;
        isProtectedToken[whbarToken] = true;

        for (uint256 i = 0; i < markets.length; i++) {
            _registerMarket(markets[i]);
        }
    }

    /// @dev UUPS upgrade gate — only the upgrade authority may swap the impl.
    function _authorizeUpgrade(address) internal view override {
        if (msg.sender != upgradeAuthority) revert NotUpgradeAuthority();
    }

    /// @notice Hand the upgrade authority to a new admin/timelock.
    function setUpgradeAuthority(address newAuthority) external {
        if (msg.sender != upgradeAuthority) revert NotUpgradeAuthority();
        if (newAuthority == address(0)) revert ZeroAddress();
        emit UpgradeAuthorityUpdated(upgradeAuthority, newAuthority);
        upgradeAuthority = newAuthority;
    }

    // ───────────────────── admin ─────────────────────

    function registerMarket(address market) external onlyOwner {
        _registerMarket(market);
    }

    /// @notice Re-prime allowances + associations for an already-registered
    ///         market. Useful as an escape hatch if approvals ever need
    ///         refreshing (e.g. governance migration) — the idempotent
    ///         silent-noop in `_registerMarket` makes re-calling it useless
    ///         after first register.
    /// @dev    Owner-only. Does NOT toggle `marketRegistered` or re-emit
    ///         MarketRegistered (which fires only on first registration).
    function refreshMarketApprovals(address market) external onlyOwner {
        if (market == address(0)) revert ZeroAddress();
        if (!marketRegistered[market]) revert MarketNotRegistered(market);

        IFissionMarketExt m = IFissionMarketExt(market);
        address syAdapter = address(m.sy());
        address shareToken = ISYLiquidity(syAdapter).shareToken();
        address pt = m.pt();
        address lp = m.lp();

        IERC20(shareToken).forceApprove(market, MAX_HTS_APPROVE);
        IERC20(pt).forceApprove(market, MAX_HTS_APPROVE);
        IERC20(lp).forceApprove(market, MAX_HTS_APPROVE);
        IERC20(USDC).forceApprove(syAdapter, MAX_HTS_APPROVE);
        IERC20(WHBAR).forceApprove(syAdapter, MAX_HTS_APPROVE);
    }

    function _registerMarket(address market) internal {
        if (market == address(0)) revert ZeroAddress();
        if (marketRegistered[market]) return;

        IFissionMarketExt m = IFissionMarketExt(market);
        address syAdapter = address(m.sy());
        address shareToken = ISYLiquidity(syAdapter).shareToken();
        address pt = m.pt();
        address yt = m.yt();
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
        registeredSyAdapter[syAdapter] = true;
        // MDS-3: probe whether this is a rewards market (exposes the operator
        // sell selectors) via the rewards-only `isOperator` view. A standard
        // `FissionMarket` lacks the selector and the staticcall fails → flag
        // stays false → the operator sell paths revert with a clear error.
        try m.isOperator(address(this), address(this)) returns (bool) {
            isRewardsMarket[market] = true;
        } catch {}
        // X-5: protect the market's tokens from rescue. YT is included even
        // though current flows route YT directly to the user (never custodied
        // here) — belt-and-suspenders against future flows that buffer YT
        // mid-tx. The flag costs one SSTORE per market init; an external
        // invariant test verifies `IERC20(yt).balanceOf(periphery) == 0`.
        isProtectedToken[shareToken] = true;
        isProtectedToken[pt] = true;
        isProtectedToken[yt] = true;
        isProtectedToken[lp] = true;
        emit MarketRegistered(market, syAdapter, pt, yt, lp);
    }

    function setMaxTradeBps(uint16 bps) external onlyOwner {
        if (bps == 0 || bps > 10000) revert InvalidCap(bps);
        emit MaxTradeBpsUpdated(maxTradeBps, bps);
        maxTradeBps = bps;
    }

    /// @notice Tune the V3 NPM mint-fee budget (tinybars). Default 5 HBAR.
    /// @dev X-6: upper bound raised from 50 to 100 HBAR so an HBAR-price
    ///      collapse doesn't lock out zaps.
    function setV3NpmFeeBudget(uint256 tinybars) external onlyOwner {
        if (tinybars == 0 || tinybars > 100 * 1e8) revert InvalidFeeBudget(tinybars);
        emit V3NpmFeeBudgetUpdated(v3NpmFeeBudget, tinybars);
        v3NpmFeeBudget = tinybars;
    }

    /// @notice YT-LEVERAGE: seed working-capital SY so buySyForYt can front the
    ///         leverage (user deploys their FULL budget into YT, Pendle-parity).
    ///         Pulls `amount` of SY-share `token` from the owner and books it into
    ///         syReserve[token]. The reserve is never swept to users (see _freeSy)
    ///         and is recoverable ONLY here (rescueToken refuses protected SY).
    ///         Unfunded => buySyForYt gracefully degrades to the user fronting the
    ///         full gross (the prior, non-leveraged behavior), so this upgrade is
    ///         safe to ship before any reserve is seeded.
    function fundSyReserve(address token, uint256 amount) external onlyOwner {
        if (token == address(0)) revert ZeroAddress();
        if (amount == 0) revert AmountZero();
        IERC20(token).safeTransferFrom(msg.sender, address(this), amount);
        syReserve[token] += amount;
        emit SyReserveFunded(token, amount, syReserve[token]);
    }

    /// @notice YT-LEVERAGE: recover working-capital SY. Decrements the booked
    ///         reserve then transfers out — bounded by syReserve[token], so it can
    ///         only ever move reserve SY, never user funds sitting mid-flight.
    function withdrawSyReserve(address token, address to, uint256 amount) external onlyOwner {
        if (to == address(0)) revert ZeroAddress();
        if (amount == 0) revert AmountZero();
        uint256 r = syReserve[token];
        if (amount > r) revert InsufficientReserve(amount, r);
        syReserve[token] = r - amount;
        IERC20(token).safeTransfer(to, amount);
        emit SyReserveWithdrawn(token, to, amount, syReserve[token]);
    }

    /// @notice YT-LEVERAGE: recover SY held ABOVE the booked reserve — e.g. dust
    ///         donated directly to the contract (which would otherwise be stranded,
    ///         since shareTokens are protected from rescueToken). Moves only
    ///         un-booked excess (balance − syReserve[token]); the reserve is never
    ///         touched. nonReentrant — cannot interleave with an in-flight buy.
    function sweepExcessSy(address token, address to) external onlyOwner nonReentrant returns (uint256 amount) {
        if (to == address(0)) revert ZeroAddress();
        amount = _freeSy(token);
        if (amount > 0) IERC20(token).safeTransfer(to, amount);
    }

    /// @notice YT-LEVERAGE: user-owned SY = balance − booked reserve. EVERY SY
    ///         refund/sweep routes through this so the working-capital reserve is
    ///         structurally impossible to pay out to a user.
    function _freeSy(address token) internal view returns (uint256) {
        uint256 bal = IERC20(token).balanceOf(address(this));
        uint256 r = syReserve[token];
        return bal > r ? bal - r : 0;
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
        // X-5: refuse to rescue protocol tokens. Closes the owner-ordering
        // attack on in-flight USDC/WHBAR/PT/LP/SY during user zaps.
        if (isProtectedToken[token]) revert ProtectedToken(token);
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

        _checkSize(syIn, m.totalSy());

        IERC20(shareToken).safeTransferFrom(msg.sender, address(this), syIn);

        uint256 syUsed = m.swapExactSyForPt(syIn, minPtOut, receiver);
        ptOut = minPtOut;

        // Refund any unused SY (the curve consumed less than syIn).
        if (syUsed < syIn) {
            IERC20(shareToken).safeTransfer(msg.sender, syIn - syUsed);
        }

        emit PeripheryAction(1, market, msg.sender, syIn, ptOut, 0);
    }

    /// @notice Tx 2 of the Buy-YT flow — LEVERAGED (2026-05-31, Pendle parity).
    ///         Mints `ytOut` PT+YT, delivers the FULL `ytOut` YT to `receiver`, and
    ///         sells the PT back to recover principal — so the user's budget deploys
    ///         entirely into YT instead of ~98% bouncing back as SY (the old
    ///         split-and-refund behavior, which only deployed the ~2% yield slice).
    ///
    ///         The mint needs `ytOut` SY up-front, but the PT-sale proceeds only
    ///         arrive after — so the Periphery FRONTS the gap from its
    ///         working-capital reserve (syReserve[shareToken]) and the PT sale
    ///         replenishes it within the same call. Net cost = ytOut − ptProceeds,
    ///         hard-capped at `maxSyIn`; any unused budget is refunded.
    ///
    ///         SAFETY: minSyFromPt = ytOut − maxSyIn floors the PT sale so net cost
    ///         can never exceed the user's budget (an under-delivering curve reverts
    ///         the swap). The reserve is fronted then repaid in-tx, and the function
    ///         ASSERTS the SY balance ≥ booked reserve at the end — a mispriced sale
    ///         reverts the whole tx rather than denting the reserve. Unfunded reserve
    ///         ⇒ requires maxSyIn ≥ ytOut (user fronts the gross) ⇒ degrades safely
    ///         to the prior non-leveraged path, so shipping before seeding is safe.
    /// @param ytOut   Exact YT to deliver. Frontend sizes it via Lens.previewBuyYt.
    /// @param maxSyIn Max SY the user spends (expected net cost + slippage).
    function buySyForYt(
        address market,
        uint256 ytOut,
        uint256 maxSyIn,
        address receiver,
        uint256 deadline
    )
        external
        nonReentrant
        checkDeadline(deadline)
        returns (uint256 ytDelivered, uint256 syPaid)
    {
        if (ytOut == 0 || maxSyIn == 0) revert AmountZero();
        if (receiver == address(0)) revert ZeroAddress();
        if (!marketRegistered[market]) revert MarketNotRegistered(market);

        IFissionMarketExt m = IFissionMarketExt(market);
        address shareToken = ISYLiquidity(address(m.sy())).shareToken();

        // Cap the PT sale (ytOut PT) at maxTradeBps% of pool depth.
        _checkSize(ytOut, m.totalSy());

        uint256 reserve = syReserve[shareToken];

        // Pull the user's budget. Periphery now holds (reserve + maxSyIn) SY.
        IERC20(shareToken).safeTransferFrom(msg.sender, address(this), maxSyIn);

        // The split mints ytOut PT + ytOut YT, consuming ytOut SY. We must already
        // hold it from (reserve + maxSyIn); otherwise the budget is too small for
        // this much YT at the current reserve level.
        uint256 bal = IERC20(shareToken).balanceOf(address(this));
        if (ytOut > bal) revert InsufficientReserve(ytOut, bal);

        // Mint: PT → this contract (resold below), YT → user (frozen there).
        m.splitTo(ytOut, address(this), receiver);
        ytDelivered = ytOut;

        // Sell the ytOut PT for SY back to THIS contract (replenishes the fronted
        // reserve). Floor the sale so the net cost can never exceed the budget.
        uint256 minSyFromPt = ytOut > maxSyIn ? ytOut - maxSyIn : 0;
        uint256 proceeds = m.swapExactPtForSy(ytOut, minSyFromPt, address(this));

        // AUDIT-FIX (donation griefing): derive the refund from the INTRINSIC net
        // cost (ytOut − proceeds), NOT from the raw balance. The minSyFromPt floor
        // guarantees proceeds ≥ ytOut − maxSyIn ⇒ netCost ≤ maxSyIn, so the
        // subtraction cannot underflow. Deriving the refund from `_freeSy(balance)`
        // would let anyone permanently brick this call by donating SY straight to
        // the contract (inflating the balance past maxSyIn ⇒ underflow). Any such
        // donation now just sits as un-booked excess, recoverable via sweepExcessSy.
        syPaid = ytOut > proceeds ? ytOut - proceeds : 0;
        uint256 refund = maxSyIn - syPaid;
        if (refund > 0) IERC20(shareToken).safeTransfer(receiver, refund);

        // Hard invariant: the working-capital reserve must be whole. Belt over the
        // arithmetic — if anything left the balance below the booked reserve, the
        // entire transaction reverts.
        uint256 endBal = IERC20(shareToken).balanceOf(address(this));
        if (endBal < reserve) revert ReserveViolated(endBal, reserve);

        emit PeripheryAction(2, market, receiver, syPaid, ytDelivered, refund);
    }

    /// @notice Tx 2 of the Buy-LP flow. Splits SY into (syForLp, syForPt), swaps
    ///         syForPt → exact `ptOutFromSwap` PT, then adds (syForLp, PT) as
    ///         proportional liquidity. Frontend pre-computes ptOutFromSwap via
    ///         FissionLens.previewSwapExactSyForPt so the swap leg delivers a
    ///         meaningful PT amount (versus the prior dust-only `ptOut=1` path).
    function buySyForLp(
        address market,
        uint256 syIn,
        uint16 ptShareBps,
        uint256 ptOutFromSwap,
        uint256 minLpOut,
        address receiver,
        uint256 deadline
    )
        external
        nonReentrant
        checkDeadline(deadline)
        returns (uint256 lpOut)
    {
        if (syIn == 0 || minLpOut == 0 || ptOutFromSwap == 0) revert AmountZero();
        if (ptShareBps == 0 || ptShareBps >= 10000) revert InvalidShareBps(ptShareBps);
        if (receiver == address(0)) revert ZeroAddress();
        if (!marketRegistered[market]) revert MarketNotRegistered(market);

        IFissionMarketExt m = IFissionMarketExt(market);
        address shareToken = ISYLiquidity(address(m.sy())).shareToken();
        address pt = m.pt();

        _checkSize(syIn, m.totalSy());

        IERC20(shareToken).safeTransferFrom(msg.sender, address(this), syIn);

        // Budget: swap up to syForPt SY for EXACTLY ptOutFromSwap PT, keep
        // syForLp for the addLiquidity leg. Market.swapExactSyForPt is "give
        // me exactly ptOut PT, taking up to syInMax SY" — caller (us) governs
        // the upper bound via syForPt.
        uint256 syForPt = (syIn * ptShareBps) / 10000;
        uint256 syForLp = syIn - syForPt;

        // X-9: snapshot pre-swap PT balance so we consume ONLY the swap's
        // delta. Without this, any stray PT dust from prior reverts would
        // be silently spent on this user's behalf.
        uint256 ptBefore = IERC20(pt).balanceOf(address(this));
        m.swapExactSyForPt(syForPt, ptOutFromSwap, address(this));
        uint256 ptAcquired = IERC20(pt).balanceOf(address(this)) - ptBefore;

        lpOut = m.addLiquidity(syForLp, ptAcquired, minLpOut, receiver);
        if (lpOut < minLpOut) revert InsufficientLpOut(lpOut, minLpOut);

        // Refund any leftover PT by selling it back through the market for SY.
        // PT is freeze-by-default and can't be handed to the user raw, so the
        // periphery (freeze-exempt, holds the dust unfrozen + pre-approved)
        // sells it via swapExactPtForSy and folds the proceeds into the SY
        // refund below.
        uint256 ptLeft = IERC20(pt).balanceOf(address(this));
        if (ptLeft > 0) m.swapExactPtForSy(ptLeft, 0, address(this));

        // Refund any dust SY to msg.sender (includes PT-resale proceeds above).
        // YT-LEVERAGE: only user-owned SY (balance − booked reserve) is refundable;
        // the working-capital reserve is structurally excluded via _freeSy.
        uint256 syLeft = _freeSy(shareToken);
        if (syLeft > 0) IERC20(shareToken).safeTransfer(msg.sender, syLeft);

        emit PeripheryAction(3, market, receiver, syIn, lpOut, 0);
    }

    // ───────────────────── Tx 1: PT / YT / LP → SY ─────────────────────

    /// @notice Tx 1 of the Sell-PT flow. Calls market.swapExactPtForSyFor — the
    ///         user's PT is freeze-by-default and can't be pulled here, so the
    ///         market wipes it directly. User must have previously called
    ///         market.setOperator(periphery, true).
    function sellPtForSy(address market, uint256 ptIn, uint256 minSyOut, address receiver, uint256 deadline)
        external
        nonReentrant
        checkDeadline(deadline)
        returns (uint256 syOut)
    {
        if (ptIn == 0) revert AmountZero();
        if (receiver == address(0)) revert ZeroAddress();
        if (!marketRegistered[market]) revert MarketNotRegistered(market);
        // MDS-3: operator sell selectors only exist on rewards markets.
        if (!isRewardsMarket[market]) revert OperatorSellUnsupported(market);

        IFissionMarketExt m = IFissionMarketExt(market);

        _checkSize(ptIn, m.totalPt());

        syOut = m.swapExactPtForSyFor(msg.sender, ptIn, minSyOut, receiver);

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
        // MDS-3: operator sell selectors only exist on rewards markets.
        if (!isRewardsMarket[market]) revert OperatorSellUnsupported(market);

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
        // H-4 fix: only registered adapters. Prevents a malicious adapter
        // from siphoning the Periphery's standing USDC/WHBAR approvals.
        if (!registeredSyAdapter[syAdapter]) revert UnregisteredSyAdapter(syAdapter);

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
        // X-8: dead deadline check removed — checkDeadline modifier above
        // already gates entry; this trailing line was post-effect dead code.
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
        // YT-LEVERAGE: _freeSy(token) = balance − syReserve[token]. syReserve is 0
        // for non-SY tokens, so USDC/WHBAR sweep exactly as before; only the SY
        // share token (which carries a working-capital reserve) is shielded.
        uint256 a = _freeSy(tA);
        if (a > 0) IERC20(tA).safeTransfer(msg.sender, a);
        uint256 b = _freeSy(tB);
        if (b > 0) IERC20(tB).safeTransfer(msg.sender, b);
        uint256 c = _freeSy(tC);
        if (c > 0) IERC20(tC).safeTransfer(msg.sender, c);
        uint256 hbarLeft = address(this).balance;
        if (hbarLeft > 0) {
            (bool ok, ) = payable(msg.sender).call{value: hbarLeft}("");
            if (!ok) revert HbarTransferFailed();
        }
    }

    // X-4: quoteUnzapSy + _redeemSyToHbarExternal removed. They were external
    // state-changing functions guarded only by msg.sender==address(this), which
    // is fragile if any future code path leaves SY in the Periphery between
    // txs. Frontends should quote via FissionLens.previewSwapExactPtForSy +
    // off-chain SaucerSwap V2 quoter for accurate minHbarOut sizing.

    // ───────────────────── receive ─────────────────────

    /// @dev Accept HBAR from the WHBAR contract (withdraw) and from the SY adapter
    ///      (V3 NPM mint-fee refund pattern).
    receive() external payable {}

    /// @dev Storage gap for future upgrade-safe variable additions. Reduced from
    ///      50 → 49 when `isRewardsMarket` (MDS-3) was added.
    uint256[48] private __gap;
}
