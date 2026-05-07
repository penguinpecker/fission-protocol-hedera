// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {HtsHelpers} from "../../src/libraries/HtsHelpers.sol";
import {IHederaTokenService} from "../../src/interfaces/IHederaTokenService.sol";
import {HederaResponseCodes} from "../../src/interfaces/IHederaResponseCodes.sol";
import {MockHederaTokenService} from "../mocks/MockHederaTokenService.sol";

/// @dev External wrapper so vm.expectRevert can catch reverts from library calls
///      cleanly (library internals inline into the caller, breaking depth-strict
///      expectRevert; calling through this contract makes the revert external).
contract HtsLibCaller {
    function mint(address t, uint256 amt) external returns (uint256) {
        return HtsHelpers.mintToTreasury(t, amt);
    }
    function transfer(address t, address from, address to, uint256 amt) external {
        HtsHelpers.transfer(t, from, to, amt);
    }
    function freeze(address t, address acc) external {
        HtsHelpers.freeze(t, acc);
    }
}

/// @notice Smoke test for the HTS foundation: mock at 0x167, library wraps with
///         revert-on-failure, every code path round-trips correctly.
contract HtsHelpersTest is Test {
    address constant PRECOMPILE = address(0x167);
    address constant TREASURY = address(0xBEEF);
    address constant ALICE = address(0xA11CE);
    address constant BOB = address(0xB0B);

    function setUp() public {
        // Install the mock at the canonical precompile address. revm sees the same
        // bytecode the real Hedera precompile would expose to a Solidity caller.
        bytes memory mockCode = type(MockHederaTokenService).runtimeCode;
        vm.etch(PRECOMPILE, mockCode);
    }

    function _deployToken(bool freezeDefault, bool withWipe, address keyHolder)
        internal
        returns (address htsToken)
    {
        // Build keys: SUPPLY (16) + FREEZE (4) + optionally WIPE (8), all → keyHolder.
        uint256 mask = 16 | 4 | (withWipe ? 8 : 0);
        IHederaTokenService.TokenKey[] memory keys = new IHederaTokenService.TokenKey[](1);
        keys[0] = HtsHelpers.makeKey(mask, keyHolder);

        IHederaTokenService.HederaToken memory spec = IHederaTokenService.HederaToken({
            name: "Test Token",
            symbol: "TEST",
            treasury: keyHolder, // treasury == this contract (the supply contract)
            memo: "",
            tokenSupplyType: false,
            maxSupply: 0,
            freezeDefault: freezeDefault,
            tokenKeys: keys,
            expiry: IHederaTokenService.Expiry({second: 0, autoRenewAccount: keyHolder, autoRenewPeriod: 7776000})
        });

        htsToken = HtsHelpers.createFungible(spec, 8, 0);
    }

    function test_create_returnsToken() public {
        address t = _deployToken(false, false, address(this));
        assertGt(uint160(t), 0);
        // Test contract is the supply key holder per `_deployToken`.
        assertEq(MockHederaTokenService(PRECOMPILE).supplyKey(t), address(this));
    }

    function test_mintToTreasury_increasesSupply() public {
        address t = _deployToken(false, false, address(this));
        HtsHelpers.mintToTreasury(t, 1_000e8);
        assertEq(MockHederaTokenService(PRECOMPILE).totalSupply(t), 1_000e8);
        assertEq(MockHederaTokenService(PRECOMPILE).balanceOf(t, address(this)), 1_000e8);
    }

    function test_burnFromTreasury_decreasesSupply() public {
        address t = _deployToken(false, false, address(this));
        HtsHelpers.mintToTreasury(t, 1_000e8);
        HtsHelpers.burnFromTreasury(t, 400e8);
        assertEq(MockHederaTokenService(PRECOMPILE).totalSupply(t), 600e8);
    }

    function test_transfer_unfrozenAccountsSucceed() public {
        address t = _deployToken(false, false, address(this));
        HtsHelpers.mintToTreasury(t, 1_000e8);
        // Treasury → ALICE: ALICE auto-associates on first receive (mock behaviour).
        HtsHelpers.transfer(t, address(this), ALICE, 100e8);
        assertEq(MockHederaTokenService(PRECOMPILE).balanceOf(t, ALICE), 100e8);
    }

    function test_transferFromTreasury_freezeDefaultBlocksReceiver() public {
        // freezeDefault=true means ALICE is auto-frozen on first receive → mock returns ACCOUNT_FROZEN_FOR_TOKEN.
        address t = _deployToken(true, true, address(this));
        HtsHelpers.mintToTreasury(t, 1_000e8);
        // Direct precompile call to inspect the response code without library revert wrapping.
        (bool ok, bytes memory data) = address(0x167).call(
            abi.encodeWithSignature("transferToken(address,address,address,int64)", t, address(this), ALICE, int64(100e8))
        );
        assertTrue(ok); // call itself succeeds; we inspect the returned code
        int32 code = abi.decode(data, (int32));
        assertEq(code, HederaResponseCodes.ACCOUNT_FROZEN_FOR_TOKEN);
    }

    /// @notice Wipe on Hedera mainnet REJECTS frozen accounts with code 165.
    ///         Replaces an earlier test_wipe_bypassesFreeze that asserted the
    ///         opposite — incorrect about real Hedera behavior. The
    ///         FissionMarket._burnYt unfreeze→wipe→refreeze sequence exists
    ///         specifically because of this constraint.
    function test_wipe_rejectsFrozen() public {
        address t = _deployToken(true, true, address(this));
        HtsHelpers.mintToTreasury(t, 1_000e8);
        HtsHelpers.associate(ALICE, t);
        // _deployToken(freezeDefault=true) means ALICE is frozen post-associate.
        assertTrue(MockHederaTokenService(PRECOMPILE).isFrozen(t, ALICE));

        // Library calls are JUMP, not external CALL — vm.expectRevert won't
        // intercept the internal _check revert. Wrap via this.wipeExt.
        vm.expectRevert(abi.encodeWithSelector(HtsHelpers.HtsCallFailed.selector, int32(165)));
        this.wipeExt(t, ALICE, 200e8);
    }

    function wipeExt(address token, address account, uint256 amount) external {
        HtsHelpers.wipeFrom(token, account, amount);
    }

    function test_wipe_succeedsWhenUnfrozen() public {
        address t = _deployToken(true, true, address(this));
        HtsHelpers.mintToTreasury(t, 1_000e8);
        HtsHelpers.associate(ALICE, t);
        HtsHelpers.unfreeze(t, ALICE);
        HtsHelpers.transfer(t, address(this), ALICE, 200e8);
        // Post-transfer ALICE remains unfrozen — wipe succeeds.
        HtsHelpers.wipeFrom(t, ALICE, 200e8);
        assertEq(MockHederaTokenService(PRECOMPILE).balanceOf(t, ALICE), 0);
        assertEq(MockHederaTokenService(PRECOMPILE).totalSupply(t), 800e8);
    }

    function test_amountOverflow_revertsBeforePrecompile() public {
        address t = _deployToken(false, false, address(this));
        uint256 over = uint256(uint64(type(int64).max)) + 1;
        HtsLibCaller caller = new HtsLibCaller();
        // Caller doesn't have supplyKey, but the overflow check fires first inside _toInt64.
        vm.expectRevert(abi.encodeWithSelector(HtsHelpers.AmountOverflowsInt64.selector, over));
        caller.mint(t, over);
    }

    function test_mintWithoutSupplyKey_returnsWrongKeyCode() public {
        // Deploy with this contract as supply key.
        address t = _deployToken(false, false, address(this));
        // Direct precompile call as ALICE (no rights) — returns the response code.
        vm.prank(ALICE);
        (bool ok, bytes memory data) = address(0x167).call(
            abi.encodeWithSignature("mintToken(address,int64,bytes[])", t, int64(100e8), new bytes[](0))
        );
        assertTrue(ok);
        (int32 code, , ) = abi.decode(data, (int32, int64, int64[]));
        assertEq(code, HederaResponseCodes.TOKEN_HAS_NO_SUPPLY_KEY);
    }

    /// @notice The MockHTSFacadeERC20 deployed at the new htsToken address must
    ///         expose proper IERC20 reads + writes that route to the precompile.
    ///         This is the surface SY/PT/YT/LP-on-HTS will rely on.
    function test_facadeERC20_balanceOfAndTransfer() public {
        address t = _deployToken(false, false, address(this));
        HtsHelpers.mintToTreasury(t, 1_000e8);

        // ERC-20 view facade reads through to mock state.
        assertEq(IERC20(t).totalSupply(), 1_000e8);
        assertEq(IERC20(t).balanceOf(address(this)), 1_000e8);
        // Treasury → ALICE via facade transfer (as msg.sender = this contract).
        IERC20(t).transfer(ALICE, 100e8);
        assertEq(IERC20(t).balanceOf(ALICE), 100e8);
        assertEq(IERC20(t).balanceOf(address(this)), 900e8);
    }

    /// @notice Approve + transferFrom over the facade — used by Market.split-style flows.
    function test_facadeERC20_approveAndTransferFrom() public {
        address t = _deployToken(false, false, address(this));
        HtsHelpers.mintToTreasury(t, 1_000e8);
        IERC20(t).transfer(ALICE, 500e8);

        // ALICE approves BOB to pull 200e8.
        vm.prank(ALICE);
        IERC20(t).approve(BOB, 200e8);
        assertEq(IERC20(t).allowance(ALICE, BOB), 200e8);

        // BOB pulls 150e8 from ALICE → himself.
        vm.prank(BOB);
        IERC20(t).transferFrom(ALICE, BOB, 150e8);
        assertEq(IERC20(t).balanceOf(BOB), 150e8);
        assertEq(IERC20(t).balanceOf(ALICE), 350e8);
        assertEq(IERC20(t).allowance(ALICE, BOB), 50e8);
    }

    function test_freezeWithoutKey_returnsCode() public {
        // Deploy with NO freeze key (use mask=16 supply only).
        IHederaTokenService.TokenKey[] memory keys = new IHederaTokenService.TokenKey[](1);
        keys[0] = HtsHelpers.makeKey(16, address(this));
        IHederaTokenService.HederaToken memory spec = IHederaTokenService.HederaToken({
            name: "X", symbol: "X", treasury: address(this), memo: "",
            tokenSupplyType: false, maxSupply: 0, freezeDefault: false,
            tokenKeys: keys,
            expiry: IHederaTokenService.Expiry({second: 0, autoRenewAccount: address(this), autoRenewPeriod: 7776000})
        });
        address t = HtsHelpers.createFungible(spec, 8, 0);

        (bool ok, bytes memory data) = address(0x167).call(
            abi.encodeWithSignature("freezeToken(address,address)", t, ALICE)
        );
        assertTrue(ok);
        int32 code = abi.decode(data, (int32));
        assertEq(code, HederaResponseCodes.TOKEN_HAS_NO_FREEZE_KEY);
    }
}
