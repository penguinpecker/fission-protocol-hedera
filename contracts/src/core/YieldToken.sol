// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IFissionMarket} from "../interfaces/IFissionMarket.sol";

/// @title  YieldToken (YT) — claim on all variable yield from 1 SY between now and expiry.
/// @notice The Market is in the call path of every YT balance change via the
///         `onYTBalanceChange` callback in `_update`. The Market settles accrued yield
///         for both `from` and `to` against their *previous* balances BEFORE the transfer
///         updates the balances. After expiry the callback still fires; the Market
///         freezes accrual at expiry and routes any post-expiry surplus to treasury.
/// @dev    Like PT, YT is fixed at 18 decimals to align with MarketMath's internal unit.
///         Transfers are always permitted — pausing would strand users on secondary
///         markets. Only mint/burn are role-gated to the Market.
contract YieldToken is ERC20 {
    /// @notice The SY this YT corresponds to.
    address public immutable sy;

    /// @notice Block timestamp at which YT becomes inert (no further yield credited).
    uint256 public immutable expiry;

    /// @notice Sole minter and burner; also the receiver of the `onYTBalanceChange`
    ///         settlement callback on every transfer. Immutable.
    address public immutable market;

    /// @notice Decimals — matches the SY/asset; supplied by the factory at construction.
    uint8 private immutable _decimals;

    error OnlyMarket();
    error ZeroAddress();

    modifier onlyMarket() {
        if (msg.sender != market) revert OnlyMarket();
        _;
    }

    constructor(
        string memory name_,
        string memory symbol_,
        address sy_,
        uint256 expiry_,
        address market_,
        uint8 decimals_
    ) ERC20(name_, symbol_) {
        if (sy_ == address(0) || market_ == address(0)) revert ZeroAddress();
        sy = sy_;
        expiry = expiry_;
        market = market_;
        _decimals = decimals_;
    }

    function decimals() public view override returns (uint8) {
        return _decimals;
    }

    /// @notice True at and after expiry — YT no longer accrues.
    function isExpired() external view returns (bool) {
        return block.timestamp >= expiry;
    }

    function mint(address to, uint256 amount) external onlyMarket {
        _mint(to, amount);
    }

    function burn(address from, uint256 amount) external onlyMarket {
        _burn(from, amount);
    }

    /// @notice Settle yield BEFORE the ERC-20 balance updates so neither party loses
    ///         accrued yield to a transfer. The Market handles `address(0)` (mint/burn).
    /// @dev    Re-entrancy protection lives in the Market (settlement is `nonReentrant`).
    ///         This contract is intentionally a thin pass-through.
    function _update(address from, address to, uint256 value) internal override {
        IFissionMarket(market).onYTBalanceChange(from, to);
        super._update(from, to, value);
    }
}
