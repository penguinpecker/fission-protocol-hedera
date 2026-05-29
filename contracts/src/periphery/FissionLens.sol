// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {Initializable} from "@openzeppelin/contracts/proxy/utils/Initializable.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts/proxy/utils/UUPSUpgradeable.sol";

import {MarketMath} from "../libraries/MarketMath.sol";
import {IStandardizedYield} from "../interfaces/IStandardizedYield.sol";

/// @notice Read-only preview of FissionMarket / FissionMarketRewards swap outputs.
///         Mirrors the exact MarketMath path each `swapExact*` function uses,
///         so the frontend can compute `minSyOut` (or `minPtOut`) without
///         relying on its simple-interest approximation that drifts ~1.8% from
///         the Pendle V2 logit curve on the YT side.
///
///         Currently the dApp ships SellYtForm with a 5% buffer + 5% slippage
///         to absorb the model drift. With this lens, the frontend can quote
///         the exact on-chain output and let users submit at tight slippage
///         (e.g. 0.1%) without InsufficientOutput reverts.
///
/// @dev    Not state-changing, never reverts on bad math (returns 0 instead),
///         safe to call from any context including eth_call from any account.
///
///         UUPS-upgradeable: deployed behind an ERC1967Proxy. The pure-math
///         preview functions hold no storage, but the contract still carries the
///         upgrade-authority slot + storage gap so future logic fixes (new curve
///         shapes, additional previews) ship without a redeploy/migration.
interface IMarketLens {
    function getMarketState() external view returns (MarketMath.MarketState memory);
    function sy() external view returns (IStandardizedYield);
}

/// @notice Ed25519-safe balance + accrual surface exposed by FissionRewardsMarket.
///         These reads are contract-tracked (not the HTS facade), so they resolve
///         for long-zero Ed25519 holders whose `balanceOf` on the HTS facade
///         would revert. The standard FissionMarket has freely-transferable PT
///         and does not implement the PT-side AMM accrual machinery.
interface IFissionMarket {
    function ptBalanceOf(address user) external view returns (uint256);
    function ytBalanceOf(address user) external view returns (uint256);
    function ptAmmRewardIndex() external view returns (uint256);
    function ytAmmRewardIndex() external view returns (uint256);
    function userPtAmmIndex(address user) external view returns (uint256);
    function userYtAmmIndex(address user) external view returns (uint256);
    function userAccruedPtAmm(address user) external view returns (uint256);
    function userAccruedYtAmm(address user) external view returns (uint256);
}

contract FissionLens is Initializable, UUPSUpgradeable {
    /// @dev REWARD_SCALE used by FissionRewardsMarket's per-share AMM-fee indices.
    uint256 internal constant REWARD_SCALE = 1e18;

    /// @notice Single upgrade-authority (admin / timelock). Set once at
    ///         `initialize`; the only address allowed to authorize a UUPS upgrade.
    address public upgradeAuthority;

    error ZeroAddress();
    error NotUpgradeAuthority();

    event UpgradeAuthorityUpdated(address indexed prev, address indexed next);

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        // Lock the bare implementation so it can never be initialized / hijacked.
        _disableInitializers();
    }

    /// @notice Proxy initializer. Sets the single upgrade authority.
    /// @param upgradeAuthority_ admin/timelock allowed to authorize upgrades.
    function initialize(address upgradeAuthority_) external initializer {
        if (upgradeAuthority_ == address(0)) revert ZeroAddress();
        upgradeAuthority = upgradeAuthority_;
        emit UpgradeAuthorityUpdated(address(0), upgradeAuthority_);
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

    /// @notice Preview `swapExactYtForSy(ytIn)` output.
    /// @return syOut SY received by the caller (after the implicit YT-burn + PT-burn).
    /// @return syOwed Internal AMM cost (informational; syOut = ytIn - syOwed).
    function previewSwapExactYtForSy(address market, uint256 ytIn)
        external
        view
        returns (uint256 syOut, uint256 syOwed)
    {
        if (ytIn == 0) return (0, 0);
        IMarketLens m = IMarketLens(market);
        MarketMath.MarketState memory ms = m.getMarketState();
        int256 syIndex = int256(m.sy().exchangeRate());
        MarketMath.PreCompute memory pre = MarketMath.getMarketPreCompute(ms, syIndex, block.timestamp);
        (int256 netSy,,,) = MarketMath.executeTradeCore(ms, pre, int256(ytIn), block.timestamp);
        if (netSy >= 0) return (0, 0);
        syOwed = uint256(-netSy);
        if (syOwed >= ytIn) return (0, 0);
        syOut = ytIn - syOwed;
    }

    /// @notice Preview `swapExactPtForSy(ptIn)` output.
    function previewSwapExactPtForSy(address market, uint256 ptIn)
        external
        view
        returns (uint256 syOut)
    {
        if (ptIn == 0) return 0;
        IMarketLens m = IMarketLens(market);
        MarketMath.MarketState memory ms = m.getMarketState();
        int256 syIndex = int256(m.sy().exchangeRate());
        MarketMath.PreCompute memory pre = MarketMath.getMarketPreCompute(ms, syIndex, block.timestamp);
        (int256 netSy,,,) = MarketMath.executeTradeCore(ms, pre, -int256(ptIn), block.timestamp);
        if (netSy <= 0) return 0;
        syOut = uint256(netSy);
    }

    /// @notice Preview `swapExactSyForPt(syIn, ptOut)` cost (ptOut for syIn budget).
    /// @dev    Solves the inverse: caller passes `ptOut`, gets back `syUsed`.
    ///         If `syUsed > syBudget` the frontend should treat the budget as binding.
    function previewSwapExactSyForPt(address market, uint256 ptOut)
        external
        view
        returns (uint256 syUsed)
    {
        if (ptOut == 0) return 0;
        IMarketLens m = IMarketLens(market);
        MarketMath.MarketState memory ms = m.getMarketState();
        int256 syIndex = int256(m.sy().exchangeRate());
        MarketMath.PreCompute memory pre = MarketMath.getMarketPreCompute(ms, syIndex, block.timestamp);
        (int256 netSy,,,) = MarketMath.executeTradeCore(ms, pre, int256(ptOut), block.timestamp);
        if (netSy >= 0) return 0;
        syUsed = uint256(-netSy);
    }

    // ───────────────────── Ed25519-safe holder previews ─────────────────────

    /// @notice PT balance of `user` on a FissionRewardsMarket, read from the
    ///         market's contract-tracked ledger (Ed25519-safe — the HTS facade
    ///         `balanceOf` reverts for long-zero Ed25519 holders).
    function previewPtBalance(address market, address user) external view returns (uint256) {
        return IFissionMarket(market).ptBalanceOf(user);
    }

    /// @notice YT balance of `user` on a FissionRewardsMarket (Ed25519-safe).
    function previewYtBalance(address market, address user) external view returns (uint256) {
        return IFissionMarket(market).ytBalanceOf(user);
    }

    /// @notice Pending (claimable) PT-side AMM rewards for `user`, including the
    ///         unsettled delta since their last settlement. Mirrors the on-chain
    ///         `_settlePtAmm` math: accrued + bal * (globalIndex - userIndex) / 1e18.
    ///         Ed25519-safe: all inputs are contract-tracked storage reads.
    function previewPendingPtAmm(address market, address user) external view returns (uint256) {
        IFissionMarket m = IFissionMarket(market);
        uint256 bal = m.ptBalanceOf(user);
        uint256 g = m.ptAmmRewardIndex();
        uint256 u = m.userPtAmmIndex(user);
        uint256 unsettled = bal > 0 && g > u ? (bal * (g - u)) / REWARD_SCALE : 0;
        return m.userAccruedPtAmm(user) + unsettled;
    }

    /// @notice Pending (claimable) YT-side AMM rewards for `user` — YT mirror of
    ///         {previewPendingPtAmm}. Ed25519-safe.
    function previewPendingYtAmm(address market, address user) external view returns (uint256) {
        IFissionMarket m = IFissionMarket(market);
        uint256 bal = m.ytBalanceOf(user);
        uint256 g = m.ytAmmRewardIndex();
        uint256 u = m.userYtAmmIndex(user);
        uint256 unsettled = bal > 0 && g > u ? (bal * (g - u)) / REWARD_SCALE : 0;
        return m.userAccruedYtAmm(user) + unsettled;
    }

    /// @dev Storage gap for future upgrade-safe variable additions.
    uint256[50] private __gap;
}
