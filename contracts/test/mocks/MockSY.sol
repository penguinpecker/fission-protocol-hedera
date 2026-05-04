// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IStandardizedYield} from "../../src/interfaces/IStandardizedYield.sol";

/// @notice Minimal SY for unit tests. The exchange rate is *settable* — tests use
///         `setExchangeRate` to simulate yield accrual without going through a keeper
///         + TWAP path. NOT for production. Mints shares 1:1 with the underlying for
///         simplicity (so `exchangeRate` is independent of share/asset accounting).
contract MockSY is ERC20, IStandardizedYield {
    using SafeERC20 for IERC20;

    address public immutable underlying;
    uint8 private immutable _decimals;
    uint256 private _exchangeRate = 1e18;

    constructor(address underlying_, uint8 decimals_) ERC20("Mock SY", "mSY") {
        underlying = underlying_;
        _decimals = decimals_;
    }

    function decimals() public view override returns (uint8) {
        return _decimals;
    }

    /// @notice For the mock, the SY contract itself IS the share token (kept as ERC20
    ///         for ease of testing). Production SYs hold an HTS-native share token.
    function shareToken() external view override returns (address) {
        return address(this);
    }

    function setExchangeRate(uint256 r) external {
        _exchangeRate = r;
    }

    function exchangeRate() external view override returns (uint256) {
        return _exchangeRate;
    }

    function deposit(address receiver, address tokenIn, uint256 amountIn, uint256 /*minOut*/ )
        external
        payable
        override
        returns (uint256 sharesOut)
    {
        require(tokenIn == underlying, "bad token");
        IERC20(underlying).safeTransferFrom(msg.sender, address(this), amountIn);
        sharesOut = amountIn; // 1:1 minting; rate is decoupled
        _mint(receiver, sharesOut);
        emit Deposit(msg.sender, receiver, tokenIn, amountIn, sharesOut);
    }

    function redeem(address receiver, uint256 shares, address tokenOut, uint256 /*minOut*/, bool /*burnInternal*/ )
        external
        override
        returns (uint256 amountOut)
    {
        require(tokenOut == underlying, "bad token");
        _burn(msg.sender, shares);
        amountOut = shares;
        IERC20(underlying).safeTransfer(receiver, amountOut);
        emit Redeem(msg.sender, receiver, tokenOut, shares, amountOut);
    }

    function previewDeposit(address, uint256 amountIn) external pure override returns (uint256) {
        return amountIn;
    }

    function previewRedeem(address, uint256 shares) external pure override returns (uint256) {
        return shares;
    }

    function getTokensIn() external view override returns (address[] memory r) {
        r = new address[](1);
        r[0] = underlying;
    }

    function getTokensOut() external view override returns (address[] memory r) {
        r = new address[](1);
        r[0] = underlying;
    }

    function isValidTokenIn(address t) external view override returns (bool) {
        return t == underlying;
    }

    function isValidTokenOut(address t) external view override returns (bool) {
        return t == underlying;
    }

    function assetInfo() external view override returns (AssetType, address, uint8) {
        return (AssetType.TOKEN, underlying, _decimals);
    }

    function yieldToken() external view override returns (address) {
        return underlying;
    }

    function getRewardTokens() external pure override returns (address[] memory) {
        return new address[](0);
    }

    function claimRewards(address) external pure override returns (uint256[] memory) {
        return new uint256[](0);
    }

    function accruedRewards(address) external pure override returns (uint256[] memory) {
        return new uint256[](0);
    }

    function rewardIndexesCurrent() external pure override returns (uint256[] memory) {
        return new uint256[](0);
    }

    function rewardIndexesStored() external pure override returns (uint256[] memory) {
        return new uint256[](0);
    }

    /// @notice Test helper — credit SY shares directly to an address (simulates the
    ///         market's appreciating SY balance without forcing a deposit path).
    function mint(address to, uint256 shares) external {
        _mint(to, shares);
    }
}

/// @notice Minimal ERC-20 underlying for tests.
contract MockERC20 is ERC20 {
    uint8 private immutable _d;

    constructor(string memory name_, string memory symbol_, uint8 decimals_) ERC20(name_, symbol_) {
        _d = decimals_;
    }

    function decimals() public view override returns (uint8) {
        return _d;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}
