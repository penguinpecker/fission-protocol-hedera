// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IHederaTokenService} from "../../src/interfaces/IHederaTokenService.sol";

/// @notice Mock ERC-20 facade that delegates to MockHederaTokenService. Real Hedera
///         HTS tokens have this exact behavior baked into the network — calling
///         `IERC20(htsToken).balanceOf(user)` routes to the precompile. This contract
///         emulates that behavior for Foundry tests.
///
///         Deployed by MockHederaTokenService.createFungibleToken at the per-token
///         address. Forwards reads + transfers to the precompile (which is the mock
///         itself). The mock acts as both the precompile (state owner) and the deployer.
interface IMockHederaForRead {
    function balanceOf(address token, address account) external view returns (uint256);
    function totalSupply(address token) external view returns (uint256);
    function isFrozen(address token, address account) external view returns (bool);
    function isAssociated(address token, address account) external view returns (bool);
    function decimalsOf(address token) external view returns (uint8);
    function nameOf(address token) external view returns (string memory);
    function symbolOf(address token) external view returns (string memory);
    function allowanceOf(address token, address owner, address spender) external view returns (uint256);
}

contract MockHTSFacadeERC20 is IERC20 {
    /// @notice Address of the MockHederaTokenService that owns this token's state.
    ///         At runtime this is `address(0x167)` because the mock lives at the
    ///         precompile slot.
    address public immutable hts;

    constructor(address hts_) {
        hts = hts_;
    }

    // ───────────────────── ERC-20 reads ─────────────────────

    function name() external view returns (string memory) {
        return IMockHederaForRead(hts).nameOf(address(this));
    }

    function symbol() external view returns (string memory) {
        return IMockHederaForRead(hts).symbolOf(address(this));
    }

    function decimals() external view returns (uint8) {
        return IMockHederaForRead(hts).decimalsOf(address(this));
    }

    function totalSupply() external view returns (uint256) {
        return IMockHederaForRead(hts).totalSupply(address(this));
    }

    function balanceOf(address account) external view returns (uint256) {
        return IMockHederaForRead(hts).balanceOf(address(this), account);
    }

    function allowance(address owner, address spender) external view returns (uint256) {
        return IMockHederaForRead(hts).allowanceOf(address(this), owner, spender);
    }

    // ───────────────────── ERC-20 writes ─────────────────────

    /// @notice Routes to the precompile's `transferToken`, which checks msg.sender
    ///         is sender OR has allowance. Here msg.sender to the precompile is
    ///         this facade contract — but the EFFECTIVE caller (the user/contract
    ///         that called this facade's `transfer`) wants to be the sender.
    /// @dev    Real Hedera resolves this via tx.origin or sender frames; for tests
    ///         we forward the original caller via `transferFrom(token, msg.sender, to, amount)`
    ///         which uses allowance — but msg.sender is this facade. So we must:
    ///         either (a) rely on facade-level allowances which is how real HTS does it,
    ///         OR (b) skip facade and have callers go straight to precompile. We go with (a):
    ///         the facade calls precompile's transferToken with sender = msg.sender of
    ///         the facade call. Since transferToken requires "msg.sender = sender OR allowance",
    ///         and msg.sender to precompile is the facade (NOT the user), we'd need facade to
    ///         have allowance from user. That's awkward. Instead we use a different trick:
    ///         the precompile's `_transferAsFacade(token, originalSender, to, amount)` which
    ///         the mock special-cases when called by a registered facade. Cleaner.
    function transfer(address to, uint256 amount) external returns (bool) {
        // Identify ourselves as a facade; the mock will trust us to assert the original sender.
        IMockHederaForFacade(hts).facadeTransfer(address(this), msg.sender, to, amount);
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        // Spend allowance from `from` to msg.sender (the actual spender), then move tokens.
        IMockHederaForFacade(hts).facadeTransferFrom(address(this), msg.sender, from, to, amount);
        return true;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        // Set allowance: token holder = msg.sender, spender = spender.
        IMockHederaForFacade(hts).facadeApprove(address(this), msg.sender, spender, amount);
        return true;
    }
}

/// @notice Privileged-write surface the facade uses to forward ERC-20 calls into the mock.
///         Only the facade contracts created by the mock should invoke these.
interface IMockHederaForFacade {
    function facadeTransfer(address token, address from, address to, uint256 amount) external;
    function facadeTransferFrom(address token, address spender, address from, address to, uint256 amount) external;
    function facadeApprove(address token, address owner, address spender, uint256 amount) external;
}
