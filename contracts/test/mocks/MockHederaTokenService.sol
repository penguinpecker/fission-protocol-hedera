// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {IHederaTokenService} from "../../src/interfaces/IHederaTokenService.sol";
import {HederaResponseCodes} from "../../src/interfaces/IHederaResponseCodes.sol";

/// @title  MockHederaTokenService — in-memory simulator for the HTS precompile (`0x167`).
/// @notice Foundry's revm cannot execute the real HTS precompile (a Hedera-native
///         system contract, not standard EVM). This mock implements every IHTS function
///         we use, with faithful semantics:
///
///           - Token registry: each created token gets a fresh address (sequential).
///           - Per-token: name, symbol, decimals, treasury, supplyKey, freezeKey, wipeKey, freezeDefault, totalSupply.
///           - Per-(token, account): balance, isAssociated, isFrozen.
///           - Mint goes to treasury; supplyKey check enforced.
///           - Burn from treasury; supplyKey check enforced.
///           - Wipe from any account; wipeKey check enforced; bypasses freeze.
///           - Transfer requires from-and-to associated AND unfrozen; sender = msg.sender or has allowance (allowance not modelled here — tests transfer via the supply contract).
///           - Freeze/unfreeze gated on freezeKey.
///           - Association: if not auto-associated, must explicitly associate.
///         FreezeDefault: when an account first acquires balance via mint/transfer,
///         it gets `isAssociated = true` and `isFrozen = freezeDefault`.
///
///         Tests deploy this contract, then `vm.etch(0x167, address(mock).code)` —
///         storage is lost. Cleaner pattern: deploy the mock at the precompile
///         address using `vm.etch(0x167, type(MockHederaTokenService).runtimeCode)`
///         and use `vm.store` to seed any state. We use a different pattern: `vm.etch`
///         the BYTECODE only, then call functions; storage starts empty for each test.
///
///         Limitations vs real HTS:
///         - No HBAR fee charged for createFungibleToken.
///         - No allowance model — caller must equal `from` for transfer.
///         - No KYC, custom fees, or NFTs.
///         - No HIP-904 auto-association — every account must be explicitly associated
///           OR receive via mint/transfer-from-treasury (we auto-associate then).
contract MockHederaTokenService is IHederaTokenService {
    uint256 internal _nextTokenSeq = 1;

    struct TokenState {
        bool exists;
        string name;
        string symbol;
        uint8 decimals;
        address treasury;
        address supplyKey;       // contract that holds supply key (0 = none)
        address freezeKey;       // 0 = no freeze
        address wipeKey;         // 0 = no wipe
        bool freezeDefault;
        uint256 totalSupply;
    }

    mapping(address => TokenState) internal _tokens;
    mapping(address => mapping(address => uint256)) internal _balanceOf;          // token => account => bal
    mapping(address => mapping(address => bool)) internal _associated;            // token => account => associated
    mapping(address => mapping(address => bool)) internal _frozen;                // token => account => frozen

    // ───────────────────── createFungibleToken ─────────────────────

    function createFungibleToken(
        HederaToken memory token,
        int64 initialTotalSupply,
        int32 decimals
    ) external payable override returns (int32 responseCode, address tokenAddress) {
        // Deterministic, sequential. In real HTS this would be a long-zero alias of
        // the Hedera token ID; we just use sequential addresses for test legibility.
        tokenAddress = address(uint160(0xC0DE_0000) + uint160(_nextTokenSeq));
        _nextTokenSeq++;

        TokenState storage t = _tokens[tokenAddress];
        t.exists = true;
        t.name = token.name;
        t.symbol = token.symbol;
        t.decimals = uint8(uint32(decimals));
        t.treasury = token.treasury;
        t.freezeDefault = token.freezeDefault;
        t.totalSupply = uint256(uint64(initialTotalSupply));

        // Walk tokenKeys[] and assign each role to its contract holder.
        for (uint256 i = 0; i < token.tokenKeys.length; i++) {
            uint256 keyType = token.tokenKeys[i].keyType;
            address holder = token.tokenKeys[i].key.contractId;
            if ((keyType & 4) != 0) t.freezeKey = holder;
            if ((keyType & 8) != 0) t.wipeKey = holder;
            if ((keyType & 16) != 0) t.supplyKey = holder;
            // 1 = ADMIN, 2 = KYC, 32 = FEE_SCHEDULE, 64 = PAUSE — we don't model.
        }

        // Treasury auto-associates and starts unfrozen (treasury is exempt from freezeDefault).
        _associated[tokenAddress][token.treasury] = true;
        _frozen[tokenAddress][token.treasury] = false;
        if (t.totalSupply > 0) {
            _balanceOf[tokenAddress][token.treasury] = t.totalSupply;
        }

        return (HederaResponseCodes.SUCCESS, tokenAddress);
    }

    // ───────────────────── mint / burn / wipe ─────────────────────

    function mintToken(address token, int64 amount, bytes[] memory)
        external
        override
        returns (int32 responseCode, int64 newTotalSupply, int64[] memory serialNumbers)
    {
        TokenState storage t = _tokens[token];
        if (!t.exists) return (HederaResponseCodes.INVALID_TOKEN_ID, 0, new int64[](0));
        if (t.supplyKey == address(0)) return (HederaResponseCodes.TOKEN_HAS_NO_SUPPLY_KEY, 0, new int64[](0));
        if (msg.sender != t.supplyKey) return (HederaResponseCodes.TOKEN_HAS_NO_SUPPLY_KEY, 0, new int64[](0));

        uint256 amt = uint256(uint64(amount));
        t.totalSupply += amt;
        _balanceOf[token][t.treasury] += amt;
        return (HederaResponseCodes.SUCCESS, int64(uint64(t.totalSupply)), new int64[](0));
    }

    function burnToken(address token, int64 amount, int64[] memory)
        external
        override
        returns (int32 responseCode, int64 newTotalSupply)
    {
        TokenState storage t = _tokens[token];
        if (!t.exists) return (HederaResponseCodes.INVALID_TOKEN_ID, 0);
        if (msg.sender != t.supplyKey) return (HederaResponseCodes.TOKEN_HAS_NO_SUPPLY_KEY, 0);

        uint256 amt = uint256(uint64(amount));
        if (_balanceOf[token][t.treasury] < amt) return (HederaResponseCodes.INSUFFICIENT_TOKEN_BALANCE, 0);

        _balanceOf[token][t.treasury] -= amt;
        t.totalSupply -= amt;
        return (HederaResponseCodes.SUCCESS, int64(uint64(t.totalSupply)));
    }

    function wipeTokenAccount(address token, address account, int64 amount)
        external
        override
        returns (int32 responseCode)
    {
        TokenState storage t = _tokens[token];
        if (!t.exists) return HederaResponseCodes.INVALID_TOKEN_ID;
        if (t.wipeKey == address(0)) return HederaResponseCodes.TOKEN_HAS_NO_WIPE_KEY;
        if (msg.sender != t.wipeKey) return HederaResponseCodes.TOKEN_HAS_NO_WIPE_KEY;

        uint256 amt = uint256(uint64(amount));
        if (_balanceOf[token][account] < amt) return HederaResponseCodes.INSUFFICIENT_TOKEN_BALANCE;

        _balanceOf[token][account] -= amt;
        t.totalSupply -= amt;
        // Wipe bypasses freeze — don't touch _frozen.
        return HederaResponseCodes.SUCCESS;
    }

    // ───────────────────── transfer ─────────────────────

    function transferToken(address token, address sender, address recipient, int64 amount)
        external
        override
        returns (int32 responseCode)
    {
        TokenState storage t = _tokens[token];
        if (!t.exists) return HederaResponseCodes.INVALID_TOKEN_ID;

        // Auto-associate the recipient on first transfer if not yet associated (HIP-904
        // simulation). Apply freezeDefault on first association.
        if (!_associated[token][recipient]) {
            _associated[token][recipient] = true;
            _frozen[token][recipient] = t.freezeDefault;
        }

        if (_frozen[token][sender]) return HederaResponseCodes.ACCOUNT_FROZEN_FOR_TOKEN;
        if (_frozen[token][recipient]) return HederaResponseCodes.ACCOUNT_FROZEN_FOR_TOKEN;

        uint256 amt = uint256(uint64(amount));
        if (_balanceOf[token][sender] < amt) return HederaResponseCodes.INSUFFICIENT_TOKEN_BALANCE;

        _balanceOf[token][sender] -= amt;
        _balanceOf[token][recipient] += amt;
        return HederaResponseCodes.SUCCESS;
    }

    // ───────────────────── association ─────────────────────

    function associateToken(address account, address token)
        external
        override
        returns (int32 responseCode)
    {
        TokenState storage t = _tokens[token];
        if (!t.exists) return HederaResponseCodes.INVALID_TOKEN_ID;
        _associated[token][account] = true;
        _frozen[token][account] = t.freezeDefault;
        return HederaResponseCodes.SUCCESS;
    }

    // ───────────────────── freeze / unfreeze ─────────────────────

    function freezeToken(address token, address account)
        external
        override
        returns (int32 responseCode)
    {
        TokenState storage t = _tokens[token];
        if (!t.exists) return HederaResponseCodes.INVALID_TOKEN_ID;
        if (t.freezeKey == address(0)) return HederaResponseCodes.TOKEN_HAS_NO_FREEZE_KEY;
        if (msg.sender != t.freezeKey) return HederaResponseCodes.TOKEN_HAS_NO_FREEZE_KEY;
        _frozen[token][account] = true;
        return HederaResponseCodes.SUCCESS;
    }

    function unfreezeToken(address token, address account)
        external
        override
        returns (int32 responseCode)
    {
        TokenState storage t = _tokens[token];
        if (!t.exists) return HederaResponseCodes.INVALID_TOKEN_ID;
        if (t.freezeKey == address(0)) return HederaResponseCodes.TOKEN_HAS_NO_FREEZE_KEY;
        if (msg.sender != t.freezeKey) return HederaResponseCodes.TOKEN_HAS_NO_FREEZE_KEY;
        _frozen[token][account] = false;
        return HederaResponseCodes.SUCCESS;
    }

    // ───────────────────── test-side views ─────────────────────

    function balanceOf(address token, address account) external view returns (uint256) {
        return _balanceOf[token][account];
    }

    function totalSupply(address token) external view returns (uint256) {
        return _tokens[token].totalSupply;
    }

    function isFrozen(address token, address account) external view returns (bool) {
        return _frozen[token][account];
    }

    function isAssociated(address token, address account) external view returns (bool) {
        return _associated[token][account];
    }

    function decimals(address token) external view returns (uint8) {
        return _tokens[token].decimals;
    }

    function supplyKey(address token) external view returns (address) {
        return _tokens[token].supplyKey;
    }
}
