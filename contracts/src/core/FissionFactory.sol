// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {Initializable} from "@openzeppelin/contracts/proxy/utils/Initializable.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts/proxy/utils/UUPSUpgradeable.sol";

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
///
///         UUPS-upgradeable: deployed behind an ERC1967Proxy. The
///         `AccessControlDefaultAdminRules` base could not be reused (its
///         upgradeable variant is not vendored, and the non-upgradeable one has a
///         constructor + immutable storage → proxy-unsafe). Governance is instead
///         hardened on top of plain `AccessControl` (UUPS-1):
///           - `renounceRole` reverts for `DEFAULT_ADMIN_ROLE`, so the admin can
///             never be renounced to nobody (no permanent governance brick).
///           - A dedicated `UPGRADER_ROLE` — separate from `DEFAULT_ADMIN_ROLE` —
///             gates `_authorizeUpgrade`, so upgrade authority and admin authority
///             are split (defence-in-depth: an admin takeover does not by itself
///             grant the ability to swap the implementation, and vice versa).
///           - `initialize` reverts on a zero admin (kept from before).
///         The immutables (SY_REVIEW_WINDOW / standardDeployer / rewardsDeployer)
///         move to initializer-set storage.
contract FissionFactory is Initializable, AccessControl, UUPSUpgradeable {
    bytes32 public constant SY_REVIEWER_ROLE = keccak256("SY_REVIEWER_ROLE");
    bytes32 public constant MARKET_CREATOR_ROLE = keccak256("MARKET_CREATOR_ROLE");
    /// @dev UUPS-1: upgrade authority is a dedicated role, distinct from
    ///      DEFAULT_ADMIN_ROLE, so role/upgrade powers are separated.
    bytes32 public constant UPGRADER_ROLE = keccak256("UPGRADER_ROLE");

    /// @notice Discriminator emitted with MarketCreated so the indexer / lens can
    ///         dispatch on market shape without re-reading the market itself.
    uint8 public constant MARKET_TYPE_STANDARD = 0;
    uint8 public constant MARKET_TYPE_REWARDS = 1;

    /// @dev Was `immutable`; moved to initializer-set storage (immutables live in
    ///      implementation bytecode and are invisible behind a delegatecall proxy).
    uint256 public SY_REVIEW_WINDOW;

    uint256 public constant MIN_MARKET_DURATION = 7 days;

    address public marketAdmin;
    address public marketTreasury;

    /// @dev Was `immutable`; moved to initializer-set storage (see SY_REVIEW_WINDOW).
    StandardMarketDeployer public standardDeployer;
    RewardsMarketDeployer public rewardsDeployer;

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
    /// @dev UUPS-1: DEFAULT_ADMIN_ROLE cannot be renounced (would brick governance).
    error CannotRenounceAdmin();

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        // Lock the bare implementation so it can never be initialized / hijacked.
        _disableInitializers();
    }

    /// @notice Proxy initializer (replaces the old constructor). MUST be called
    ///         through the ERC1967Proxy exactly once. `admin_` becomes both the
    ///         DEFAULT_ADMIN_ROLE holder and the UUPS upgrade authority.
    function initialize(
        address admin_,
        address marketAdmin_,
        address marketTreasury_,
        StandardMarketDeployer standardDeployer_,
        RewardsMarketDeployer rewardsDeployer_,
        uint256 syReviewWindow_
    ) external initializer {
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
        // AccessControlDefaultAdminRules used to grant DEFAULT_ADMIN_ROLE to
        // admin_ implicitly; with plain AccessControl we grant it explicitly.
        _grantRole(DEFAULT_ADMIN_ROLE, admin_);
        _grantRole(SY_REVIEWER_ROLE, admin_);
        _grantRole(MARKET_CREATOR_ROLE, admin_);
        // UUPS-1: the deploying admin also bootstraps as the initial upgrader.
        // Governance may later split this off to a separate timelock/multisig and
        // revoke it from the admin to fully decouple the two authorities.
        _grantRole(UPGRADER_ROLE, admin_);
    }

    /// @dev UUPS upgrade gate (UUPS-1) — only an UPGRADER_ROLE holder may swap the
    ///      implementation. Deliberately NOT DEFAULT_ADMIN_ROLE, so upgrade and
    ///      admin authority can be held by different parties.
    function _authorizeUpgrade(address) internal view override onlyRole(UPGRADER_ROLE) {}

    /// @dev UUPS-1: block renouncing the admin role to nobody, which would
    ///      permanently brick governance (and, via the role admin, the ability to
    ///      reassign UPGRADER_ROLE). Other roles may still be renounced normally.
    ///      Admin handoff must go through grant-then-revoke, not renounce-to-void.
    function renounceRole(bytes32 role, address account) public override {
        if (role == DEFAULT_ADMIN_ROLE) revert CannotRenounceAdmin();
        super.renounceRole(role, account);
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

    /// @dev Storage gap for future upgrade-safe variable additions.
    uint256[50] private __gap;
}
