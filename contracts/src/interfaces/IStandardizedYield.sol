// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// @title  IStandardizedYield — ERC-5115 + Pendle V2 superset
/// @notice Strict superset of EIP-5115. Pendle's PT/YT contracts depend on
///         the extensions (`assetInfo`, reward indexes, isValidTokenIn/Out),
///         so we implement the full interface even if downstream consumers
///         only need the base. References:
///           - https://eips.ethereum.org/EIPS/eip-5115
///           - https://github.com/pendle-finance/pendle-core-v2-public/blob/main/contracts/interfaces/IStandardizedYield.sol
/// @dev    SY metadata (decimals/symbol/name) reflects the *underlying asset*,
///         NOT the share. This is mandated by EIP-5115.
interface IStandardizedYield is IERC20 {
    /// @notice TOKEN  = the asset is an ordinary ERC-20 with a market price (e.g. HBARX).
    ///         LIQUIDITY = the asset is an LP / pool position whose price has no direct
    ///         market quote (e.g. SaucerSwap V1 LP token). Downstream pricing must use
    ///         a custom oracle, not `assetAddress`.
    enum AssetType { TOKEN, LIQUIDITY }

    // ───────────────────── core deposit/redeem ─────────────────────

    /// @notice Wrap `amountIn` of `tokenIn` and credit shares to `receiver`.
    /// @dev    `tokenIn` MAY be the underlying yield-bearing token, or any token in
    ///         `getTokensIn()`. When wrapping requires a swap, the SY may charge a
    ///         spread; `previewDeposit` returns the user's exact share output.
    function deposit(address receiver, address tokenIn, uint256 amountIn, uint256 minSharesOut)
        external
        payable
        returns (uint256 sharesOut);

    /// @notice Burn `shares` from `msg.sender` and pay out `tokenOut` to `receiver`.
    function redeem(
        address receiver,
        uint256 shares,
        address tokenOut,
        uint256 minTokenOut,
        bool burnFromInternalBalance
    ) external returns (uint256 amountTokenOut);

    // ───────────────────── pricing ────────────────────────────────

    /// @notice 1e18-scaled asset-per-share rate. SHOULD be monotonically non-decreasing
    ///         under normal operation, but real-world LST rates can drop (slashing).
    ///         Adapters that wrap such assets must handle the down-tick path explicitly.
    function exchangeRate() external view returns (uint256 res);

    function previewDeposit(address tokenIn, uint256 amountIn) external view returns (uint256 sharesOut);
    function previewRedeem(address tokenOut, uint256 shares) external view returns (uint256 amountTokenOut);

    function getTokensIn() external view returns (address[] memory);
    function getTokensOut() external view returns (address[] memory);
    function isValidTokenIn(address token) external view returns (bool);
    function isValidTokenOut(address token) external view returns (bool);

    /// @notice Underlying asset descriptor. CRITICAL for downstream PT/YT pricing —
    ///         consumers must check `assetType` before assuming `assetAddress` has a
    ///         market price feed.
    function assetInfo() external view returns (AssetType assetType, address assetAddress, uint8 assetDecimals);

    function yieldToken() external view returns (address);

    // ───────────────────── rewards ────────────────────────────────
    /// @notice Reward tokens distributed to SY holders proportional to their share.
    ///         May be empty (e.g. pure rate-based LSTs that bake rewards into rate).
    function getRewardTokens() external view returns (address[] memory);
    function claimRewards(address user) external returns (uint256[] memory rewardAmounts);
    function accruedRewards(address user) external view returns (uint256[] memory rewardAmounts);
    function rewardIndexesCurrent() external returns (uint256[] memory);
    function rewardIndexesStored() external view returns (uint256[] memory);

    // ───────────────────── events ─────────────────────────────────

    event Deposit(
        address indexed caller,
        address indexed receiver,
        address indexed tokenIn,
        uint256 amountIn,
        uint256 amountSharesOut
    );
    event Redeem(
        address indexed caller,
        address indexed receiver,
        address indexed tokenOut,
        uint256 amountSharesToRedeem,
        uint256 amountTokenOut
    );
    event ClaimRewards(address indexed user, address[] rewardTokens, uint256[] rewardAmounts);
    event ExchangeRateUpdated(uint256 oldRate, uint256 newRate);
}
