// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @title  PrincipalToken (PT) — claim on 1 SY-asset unit redeemable at maturity.
/// @notice Pre-expiry PT trades at a discount; at expiry `1 PT` redeems for `1e18 / index`
///         SY (where `index` is the SY's exchange rate at redemption time). The redemption
///         math lives in `FissionMarket`; this contract is a thin ERC-20 mint/burn surface
///         gated to the market.
/// @dev    Decimals = 18 regardless of the underlying SY's decimals. PT/YT amounts are
///         denominated in MarketMath's internal 1e18 unit, so keeping them at 18 decimals
///         avoids per-market scaling. The Market is responsible for converting between
///         this 1e18 PT-unit and the SY's native decimals at the deposit/redeem boundary.
///
///         Transfers are always allowed (no pause on PT transfers — pausing trading would
///         strand users on secondary markets like SaucerSwap). Only minting and burning
///         are gated: `MARKET_ROLE` (set once at construction, immutable thereafter).
contract PrincipalToken is ERC20 {
    /// @notice The SY this PT corresponds to.
    address public immutable sy;

    /// @notice Block timestamp at which `redeemPT(amount)` exchanges PT for SY.
    uint256 public immutable expiry;

    /// @notice Sole minter and burner. Set once at construction; immutable.
    address public immutable market;

    error OnlyMarket();
    error ZeroAddress();

    modifier onlyMarket() {
        if (msg.sender != market) revert OnlyMarket();
        _;
    }

    constructor(string memory name_, string memory symbol_, address sy_, uint256 expiry_, address market_)
        ERC20(name_, symbol_)
    {
        if (sy_ == address(0) || market_ == address(0)) revert ZeroAddress();
        sy = sy_;
        expiry = expiry_;
        market = market_;
    }

    /// @notice 18 decimals — protocol invariant; do not override per-market.
    function decimals() public pure override returns (uint8) {
        return 18;
    }

    /// @notice True at and after expiry.
    function isExpired() external view returns (bool) {
        return block.timestamp >= expiry;
    }

    function mint(address to, uint256 amount) external onlyMarket {
        _mint(to, amount);
    }

    function burn(address from, uint256 amount) external onlyMarket {
        _burn(from, amount);
    }
}
