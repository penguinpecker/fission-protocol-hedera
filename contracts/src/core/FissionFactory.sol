// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {AccessControlDefaultAdminRules} from
    "@openzeppelin/contracts/access/extensions/AccessControlDefaultAdminRules.sol";

import {FissionMarket} from "./FissionMarket.sol";
import {FissionMarketRewards} from "./FissionMarketRewards.sol";
import {PrincipalToken} from "./PrincipalToken.sol";
import {YieldToken} from "./YieldToken.sol";
import {IStandardizedYield} from "../interfaces/IStandardizedYield.sol";

/// @title  FissionFactory — deploys per-maturity Markets with whitelisted SY tokens.
/// @notice The Penpie defence: arbitrary SY tokens cannot become market underlyings.
///         Adding an SY is a TWO-step process with a 7-day public review window:
///             1. SY_REVIEWER_ROLE calls `proposeSY(addr)` — emits an event the
///                community can review.
///             2. ADMIN_ROLE calls `confirmSY(addr)` after `SY_REVIEW_WINDOW`.
///         Only after confirmation can `createMarket(sy, ...)` succeed for that SY.
///         The 7-day window is a hard contract requirement; admins cannot bypass it.
///
///         Markets are NOT initialized by the factory — `createMarket` deploys
///         Market+PT+YT and wires them up, but the protocol's Safe (admin on the
///         Market) is responsible for `market.initialize(...)` with its own seed
///         capital. This keeps the factory custody-free.
contract FissionFactory is AccessControlDefaultAdminRules {
    bytes32 public constant SY_REVIEWER_ROLE = keccak256("SY_REVIEWER_ROLE");
    bytes32 public constant MARKET_CREATOR_ROLE = keccak256("MARKET_CREATOR_ROLE");

    uint256 public constant SY_REVIEW_WINDOW = 7 days;

    /// @notice Minimum market duration. L-8 audit fix: prevents accidental ultra-short
    ///         markets (e.g., `expiry = block.timestamp + 1`) where `initialize` and a
    ///         user's first deposit would race the expiry boundary in a single block.
    uint256 public constant MIN_MARKET_DURATION = 7 days;

    /// @notice Default admin set on every newly created Market — typically the
    ///         protocol's Safe + TimelockController. Updatable by the factory's
    ///         own admin (also typically the Safe).
    address public marketAdmin;

    /// @notice Default treasury set on every newly created Market. Updatable.
    address public marketTreasury;

    struct PendingSY {
        uint64 proposedAt;
    }

    mapping(address => bool) public whitelistedSY;
    mapping(address => PendingSY) public pendingSY;

    address[] public markets;

    event SYProposed(address indexed sy, address indexed proposer, uint256 confirmAfter);
    event SYConfirmed(address indexed sy);
    event SYRevoked(address indexed sy);
    event MarketCreated(
        uint256 indexed marketId,
        address indexed market,
        address indexed sy,
        address pt,
        address yt,
        uint256 expiry,
        int256 scalarRoot
    );
    event MarketAdminUpdated(address indexed prev, address indexed next);
    event MarketTreasuryUpdated(address indexed prev, address indexed next);

    error SYNotProposed();
    error SYReviewPending(uint256 confirmAfter);
    error SYAlreadyWhitelisted();
    error SYNotWhitelisted();
    error ZeroAddress();
    error MarketDurationTooShort(uint256 given, uint256 minimum);
    error AdminMustBeContract(address admin);

    constructor(address admin_, address marketAdmin_, address marketTreasury_)
        AccessControlDefaultAdminRules(0, admin_)
    {
        if (admin_ == address(0) || marketAdmin_ == address(0) || marketTreasury_ == address(0)) {
            revert ZeroAddress();
        }
        marketAdmin = marketAdmin_;
        marketTreasury = marketTreasury_;
        _grantRole(SY_REVIEWER_ROLE, admin_);
        _grantRole(MARKET_CREATOR_ROLE, admin_);
    }

    // ───────────────────── governance ─────────────────────

    function setMarketAdmin(address newAdmin) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (newAdmin == address(0)) revert ZeroAddress();
        // L-11 audit fix: refuse EOA admin in production. The Safe (a contract) MUST
        // own market admin so single-key compromise can't drain markets.
        if (newAdmin.code.length == 0) revert AdminMustBeContract(newAdmin);
        emit MarketAdminUpdated(marketAdmin, newAdmin);
        marketAdmin = newAdmin;
    }

    function setMarketTreasury(address newTreasury) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (newTreasury == address(0)) revert ZeroAddress();
        emit MarketTreasuryUpdated(marketTreasury, newTreasury);
        marketTreasury = newTreasury;
    }

    /// @notice Revoke an SY from the whitelist. Pre-existing markets continue to
    ///         function — this only blocks NEW market creation.
    function revokeSY(address sy) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (!whitelistedSY[sy]) revert SYNotWhitelisted();
        whitelistedSY[sy] = false;
        emit SYRevoked(sy);
    }

    // ───────────────────── SY whitelist ─────────────────────

    function proposeSY(address sy) external onlyRole(SY_REVIEWER_ROLE) {
        if (sy == address(0)) revert ZeroAddress();
        if (whitelistedSY[sy]) revert SYAlreadyWhitelisted();

        pendingSY[sy] = PendingSY({proposedAt: uint64(block.timestamp)});
        emit SYProposed(sy, msg.sender, block.timestamp + SY_REVIEW_WINDOW);
    }

    function confirmSY(address sy) external onlyRole(DEFAULT_ADMIN_ROLE) {
        PendingSY memory p = pendingSY[sy];
        if (p.proposedAt == 0) revert SYNotProposed();
        uint256 confirmAfter = uint256(p.proposedAt) + SY_REVIEW_WINDOW;
        if (block.timestamp < confirmAfter) revert SYReviewPending(confirmAfter);

        whitelistedSY[sy] = true;
        delete pendingSY[sy];
        emit SYConfirmed(sy);
    }

    // ───────────────────── market creation ─────────────────────

    /// @notice Deploy Market + PT + YT for a whitelisted SY. Does NOT initialize
    ///         liquidity — the market admin must call `market.initialize(...)` separately
    ///         with seed funds.
    function createMarket(address sy, uint256 expiry, int256 scalarRoot, string calldata suffix)
        external
        onlyRole(MARKET_CREATOR_ROLE)
        returns (uint256 marketId, address marketAddr)
    {
        if (!whitelistedSY[sy]) revert SYNotWhitelisted();
        // L-8 audit fix: enforce minimum market duration.
        if (expiry < block.timestamp + MIN_MARKET_DURATION) {
            revert MarketDurationTooShort(expiry, block.timestamp + MIN_MARKET_DURATION);
        }

        marketId = markets.length;
        IStandardizedYield syIface = IStandardizedYield(sy);
        (, , uint8 dec) = syIface.assetInfo();

        FissionMarket m = new FissionMarket(
            sy,
            expiry,
            scalarRoot,
            marketAdmin,
            marketTreasury,
            dec,
            string.concat("Fission LP-", suffix),
            string.concat("fLP-", suffix)
        );

        PrincipalToken pt = new PrincipalToken(
            string.concat("Fission PT-", suffix),
            string.concat("fPT-", suffix),
            sy,
            expiry,
            address(m),
            dec
        );
        YieldToken yt = new YieldToken(
            string.concat("Fission YT-", suffix),
            string.concat("fYT-", suffix),
            sy,
            expiry,
            address(m),
            dec
        );

        // Effects-first: stash the market in our own storage BEFORE the only external
        // call (setTokens). The new market contract is freshly-deployed and can't
        // reasonably reenter the factory, but reordering removes the formal CFR.
        markets.push(address(m));
        marketAddr = address(m);

        m.setTokens(address(pt), address(yt));

        emit MarketCreated(marketId, marketAddr, sy, address(pt), address(yt), expiry, scalarRoot);
    }

    /// @notice Deploy a `FissionMarketRewards` Market + PT + YT for an SY whose yield is
    ///         distributed via reward tokens (e.g. `SY_SaucerSwapV2LP`). Same gating as
    ///         `createMarket` — SY must be whitelisted via the 7-day review window.
    /// @dev    Distinct from `createMarket` because the constructor for
    ///         `FissionMarketRewards` reads `sy.getRewardTokens()` and pins the reward
    ///         token addresses immutable. Calling `createMarket` for a reward-bearing SY
    ///         is permitted but will silently produce a market whose YT yield path never
    ///         fires — the `assetType == LIQUIDITY` SYs should always go through this
    ///         entry point. Frontends and routers should pre-check `sy.assetInfo()`.
    function createRewardsMarket(address sy, uint256 expiry, int256 scalarRoot, string calldata suffix)
        external
        onlyRole(MARKET_CREATOR_ROLE)
        returns (uint256 marketId, address marketAddr)
    {
        if (!whitelistedSY[sy]) revert SYNotWhitelisted();
        if (expiry < block.timestamp + MIN_MARKET_DURATION) {
            revert MarketDurationTooShort(expiry, block.timestamp + MIN_MARKET_DURATION);
        }

        marketId = markets.length;
        IStandardizedYield syIface = IStandardizedYield(sy);
        (, , uint8 dec) = syIface.assetInfo();

        FissionMarketRewards m = new FissionMarketRewards(
            sy,
            expiry,
            scalarRoot,
            marketAdmin,
            marketTreasury,
            dec,
            string.concat("Fission LP-", suffix),
            string.concat("fLP-", suffix)
        );

        PrincipalToken pt = new PrincipalToken(
            string.concat("Fission PT-", suffix),
            string.concat("fPT-", suffix),
            sy,
            expiry,
            address(m),
            dec
        );
        YieldToken yt = new YieldToken(
            string.concat("Fission YT-", suffix),
            string.concat("fYT-", suffix),
            sy,
            expiry,
            address(m),
            dec
        );

        markets.push(address(m));
        marketAddr = address(m);

        m.setTokens(address(pt), address(yt));

        emit MarketCreated(marketId, marketAddr, sy, address(pt), address(yt), expiry, scalarRoot);
    }

    // ───────────────────── views ─────────────────────

    function marketCount() external view returns (uint256) {
        return markets.length;
    }

    function getMarkets(uint256 offset, uint256 limit) external view returns (address[] memory out) {
        uint256 n = markets.length;
        if (offset >= n) return new address[](0);
        uint256 end = offset + limit;
        if (end > n) end = n;
        out = new address[](end - offset);
        for (uint256 i = 0; i < out.length; i++) {
            out[i] = markets[offset + i];
        }
    }
}
