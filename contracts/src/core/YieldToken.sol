// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @title  YieldToken (YT) — claim on all variable yield from 1 SY between now and expiry.
/// @notice At expiry YT becomes inert (further yield routes to treasury per protocol policy).
///         The yield accrual machinery lives in `FissionMarket`; this contract is a thin
///         ERC-20 mint/burn surface gated to the market.
/// @dev    Like PT, YT is fixed at 18 decimals to align with MarketMath's internal unit.
///         Transfers are always permitted — pausing them would strand users on
///         secondary markets. Only mint/burn are role-gated.
///
///         The Market hooks `_update` so that yield is credited to the *previous* holder
///         on every transfer and re-anchored to the *new* holder. Without this hook,
///         YT transfers would drop accrued-but-unclaimed yield. The override is set up
///         in the Market via a callback registered at deployment time; here we expose
///         a pre-transfer notification hook the Market can register against if needed.
contract YieldToken is ERC20 {
    /// @notice The SY this YT corresponds to.
    address public immutable sy;

    /// @notice Block timestamp at which YT becomes inert (no further yield credited).
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

    function decimals() public pure override returns (uint8) {
        return 18;
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

    /// @notice Hook called on every transfer (including mint/burn). The Market overrides
    ///         this in its own deployment by registering a callback at the YT level — for
    ///         Phase 3 we expose the structure but the accrual logic itself lands in the
    ///         Market (Phase 4) where it has access to the global yield index.
    /// @dev    Override `_update` from OZ ERC20 to add the hook. We emit a YTTransfer
    ///         event here so an indexer (or the Market via a `vm.recordLogs`-style read)
    ///         can rebuild user yield deltas without the Market having to be in the call
    ///         path of every transfer. The Market still pulls the *current* user balance
    ///         lazily on `claimYield` / `_accrue`.
    function _update(address from, address to, uint256 value) internal override {
        super._update(from, to, value);
        emit YTTransfer(from, to, value);
    }

    event YTTransfer(address indexed from, address indexed to, uint256 value);
}
