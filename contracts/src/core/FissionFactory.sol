// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {AccessControlDefaultAdminRules} from
    "@openzeppelin/contracts/access/extensions/AccessControlDefaultAdminRules.sol";

import {FissionMarket} from "./FissionMarket.sol";
import {FissionRewardsMarket} from "./FissionRewardsMarket.sol";
import {StandardMarketDeployer} from "./StandardMarketDeployer.sol";
import {RewardsMarketDeployer} from "./RewardsMarketDeployer.sol";
import {IStandardizedYield} from "../interfaces/IStandardizedYield.sol";

/// @title  FissionFactory — deploys per-maturity Markets with whitelisted SY tokens.
/// @notice The Penpie defence: arbitrary SY tokens cannot become market underlyings.
///         Adding an SY is a TWO-step process with a public review window:
///             1. SY_REVIEWER_ROLE calls `proposeSY(addr)` — emits an event the
///                community can review.
///             2. ADMIN_ROLE calls `confirmSY(addr)` after `SY_REVIEW_WINDOW`.
///         Only after confirmation can `createMarket` / `createRewardsMarket` succeed
///         for that SY. The window is a hard contract requirement; admins cannot bypass.
///
///         Markets are NOT initialized by the factory — `createRewardsMarket` deploys
///         Market+PT+YT+LP and wires them up, but the protocol's admin is responsible
///         for `market.initialize(...)` with its own seed capital. Keeps factory custody-free.
contract FissionFactory is AccessControlDefaultAdminRules {
    bytes32 public constant SY_REVIEWER_ROLE = keccak256("SY_REVIEWER_ROLE");
    bytes32 public constant MARKET_CREATOR_ROLE = keccak256("MARKET_CREATOR_ROLE");

    /// @notice Discriminator emitted with MarketCreated so the indexer / lens can
    ///         dispatch on market shape without re-reading the market itself.
    uint8 public constant MARKET_TYPE_STANDARD = 0;
    uint8 public constant MARKET_TYPE_REWARDS = 1;

    uint256 public immutable SY_REVIEW_WINDOW;

    uint256 public constant MIN_MARKET_DURATION = 7 days;

    address public marketAdmin;
    address public marketTreasury;

    StandardMarketDeployer public immutable standardDeployer;
    RewardsMarketDeployer public immutable rewardsDeployer;

    struct PendingSY {
        uint64 proposedAt;
    }

    mapping(address => bool) public whitelistedSY;
    mapping(address => PendingSY) public pendingSY;

    address[] public markets;

    event SYProposed(address indexed sy, address indexed proposer, uint256 confirmAfter);
    event SYConfirmed(address indexed sy);
    event SYRevoked(address indexed sy);
    /// @dev marketType: 0=Standard (yield-bearing), 1=Rewards (constant-rate, reward-tokens).
    event MarketCreated(
        uint256 indexed marketId,
        address indexed market,
        address indexed sy,
        address pt,
        address yt,
        address lp,
        uint256 expiry,
        int256 scalarRoot,
        uint8 marketType
    );
    event MarketAdminUpdated(address indexed prev, address indexed next);
    event MarketTreasuryUpdated(address indexed prev, address indexed next);

    error SYNotProposed();
    error SYReviewPending(uint256 confirmAfter);
    error SYAlreadyWhitelisted();
    error SYNotWhitelisted();
    error ZeroAddress();
    error MarketDurationTooShort(uint256 given, uint256 minimum);

    constructor(
        address admin_,
        address marketAdmin_,
        address marketTreasury_,
        StandardMarketDeployer standardDeployer_,
        RewardsMarketDeployer rewardsDeployer_,
        uint256 syReviewWindow_
    ) AccessControlDefaultAdminRules(0, admin_) {
        if (
            admin_ == address(0) || marketAdmin_ == address(0) || marketTreasury_ == address(0)
                || address(standardDeployer_) == address(0) || address(rewardsDeployer_) == address(0)
        ) {
            revert ZeroAddress();
        }
        SY_REVIEW_WINDOW = syReviewWindow_;
        marketAdmin = marketAdmin_;
        marketTreasury = marketTreasury_;
        standardDeployer = standardDeployer_;
        rewardsDeployer = rewardsDeployer_;
        _grantRole(SY_REVIEWER_ROLE, admin_);
        _grantRole(MARKET_CREATOR_ROLE, admin_);
    }

    // ───────────────────── governance ─────────────────────

    function setMarketAdmin(address newAdmin) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (newAdmin == address(0)) revert ZeroAddress();
        emit MarketAdminUpdated(marketAdmin, newAdmin);
        marketAdmin = newAdmin;
    }

    function setMarketTreasury(address newTreasury) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (newTreasury == address(0)) revert ZeroAddress();
        emit MarketTreasuryUpdated(marketTreasury, newTreasury);
        marketTreasury = newTreasury;
    }

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

    function createMarket(address sy, uint256 expiry, int256 scalarRoot, string calldata suffix)
        external
        payable
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

        FissionMarket m = standardDeployer.deploy(
            sy,
            expiry,
            scalarRoot,
            marketAdmin,
            marketTreasury,
            dec,
            address(this)
        );

        markets.push(address(m));
        marketAddr = address(m);

        m.setTokens{value: msg.value}(
            string.concat("Fission PT-", suffix),
            string.concat("fPT-", suffix),
            string.concat("Fission YT-", suffix),
            string.concat("fYT-", suffix),
            string.concat("Fission LP-", suffix),
            string.concat("fLP-", suffix)
        );

        emit MarketCreated(
            marketId, marketAddr, sy, m.pt(), m.yt(), m.lp(),
            expiry, scalarRoot, MARKET_TYPE_STANDARD
        );
    }

    /// @notice Deploy a `FissionRewardsMarket` Market + PT + YT + LP for a reward-bearing SY
    ///         (e.g. SaucerSwapLPYieldSource). Same gating as `createMarket`.
    function createRewardsMarket(address sy, uint256 expiry, int256 scalarRoot, string calldata suffix)
        external
        payable
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

        FissionRewardsMarket m = rewardsDeployer.deploy(
            sy,
            expiry,
            scalarRoot,
            marketAdmin,
            marketTreasury,
            dec,
            address(this)
        );

        markets.push(address(m));
        marketAddr = address(m);

        m.setTokens{value: msg.value}(
            string.concat("Fission PT-", suffix),
            string.concat("fPT-", suffix),
            string.concat("Fission YT-", suffix),
            string.concat("fYT-", suffix),
            string.concat("Fission LP-", suffix),
            string.concat("fLP-", suffix)
        );

        emit MarketCreated(
            marketId, marketAddr, sy, m.pt(), m.yt(), m.lp(),
            expiry, scalarRoot, MARKET_TYPE_REWARDS
        );
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
