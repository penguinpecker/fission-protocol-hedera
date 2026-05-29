// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {IHederaTokenService} from "../../src/interfaces/IHederaTokenService.sol";
import {HederaResponseCodes} from "../../src/interfaces/IHederaResponseCodes.sol";
import {MockHTSFacadeERC20, IMockHederaForFacade, IMockHederaForRead} from "./MockHTSFacadeERC20.sol";

/// @title  MockHederaTokenService — in-memory simulator for the HTS precompile (`0x167`).
/// @notice Deployed at `0x167` via `vm.etch`. Every IHTS call we use is implemented
///         with faithful semantics. Every token created via `createFungibleToken`
///         also gets a real `MockHTSFacadeERC20` deployed at the new token address,
///         giving tests proper `IERC20(htsToken).balanceOf` / `transfer` / `approve`
///         behavior — same as real Hedera, where HTS tokens expose ERC-20 facades.
contract MockHederaTokenService is IHederaTokenService, IMockHederaForFacade, IMockHederaForRead {
    uint256 internal _nextTokenSeq = 1;

    struct TokenState {
        bool exists;
        string name;
        string symbol;
        uint8 decimals;
        address treasury;
        address supplyKey;
        address freezeKey;
        address wipeKey;
        bool freezeDefault;
        uint256 totalSupply;
        bool isFacade;          // true if this address is a deployed facade we recognize
    }

    mapping(address => TokenState) internal _tokens;
    mapping(address => mapping(address => uint256)) internal _balanceOf;
    mapping(address => mapping(address => bool)) internal _associated;
    mapping(address => mapping(address => bool)) internal _frozen;
    mapping(address => mapping(address => mapping(address => uint256))) internal _allow; // token => owner => spender => amt

    /// @notice Test hook: addresses flagged here cause `balanceOf` to revert (mimics
    ///         the real-Hedera quirk where the HTS ERC-20 facade reverts when the
    ///         queried address is an Ed25519 long-zero EVM representation). The
    ///         actual ledger balance is unaffected — only EVM-side reads break.
    mapping(address => bool) internal _facadeReadBroken;

    /// @notice Test-only — flag `account` as Ed25519-like (HTS facade `balanceOf`
    ///         will revert). Per-account, not per-token, matching the real quirk.
    function __setFacadeReadBroken(address account, bool broken) external {
        _facadeReadBroken[account] = broken;
    }

    error NotAFacade(address caller);

    modifier onlyFacade(address token) {
        if (!_tokens[token].isFacade || msg.sender != token) revert NotAFacade(msg.sender);
        _;
    }

    // ───────────────────── createFungibleToken ─────────────────────

    function createFungibleToken(
        HederaToken memory token,
        int64 initialTotalSupply,
        int32 decimals
    ) external payable override returns (int32 responseCode, address tokenAddress) {
        // Deploy a real facade contract; address(facade) becomes the token address.
        // Real Hedera does the equivalent at the network layer: every HTS token has
        // an EVM-callable ERC-20 facade at its long-zero alias.
        MockHTSFacadeERC20 facade = new MockHTSFacadeERC20(address(this));
        tokenAddress = address(facade);
        _nextTokenSeq++;

        TokenState storage t = _tokens[tokenAddress];
        t.exists = true;
        t.isFacade = true;
        t.name = token.name;
        t.symbol = token.symbol;
        t.decimals = uint8(uint32(decimals));
        t.treasury = token.treasury;
        t.freezeDefault = token.freezeDefault;
        t.totalSupply = uint256(uint64(initialTotalSupply));

        for (uint256 i = 0; i < token.tokenKeys.length; i++) {
            uint256 keyType = token.tokenKeys[i].keyType;
            address holder = token.tokenKeys[i].key.contractId;
            if ((keyType & 4) != 0) t.freezeKey = holder;
            if ((keyType & 8) != 0) t.wipeKey = holder;
            if ((keyType & 16) != 0) t.supplyKey = holder;
        }

        // Treasury auto-associates and starts unfrozen.
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
        returns (int32, int64, int64[] memory)
    {
        TokenState storage t = _tokens[token];
        if (!t.exists) return (HederaResponseCodes.INVALID_TOKEN_ID, 0, new int64[](0));
        if (msg.sender != t.supplyKey) return (HederaResponseCodes.TOKEN_HAS_NO_SUPPLY_KEY, 0, new int64[](0));

        uint256 amt = uint256(uint64(amount));
        t.totalSupply += amt;
        _balanceOf[token][t.treasury] += amt;
        return (HederaResponseCodes.SUCCESS, int64(uint64(t.totalSupply)), new int64[](0));
    }

    function burnToken(address token, int64 amount, int64[] memory)
        external
        override
        returns (int32, int64)
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
        returns (int32)
    {
        TokenState storage t = _tokens[token];
        if (!t.exists) return HederaResponseCodes.INVALID_TOKEN_ID;
        if (t.wipeKey == address(0) || msg.sender != t.wipeKey) {
            return HederaResponseCodes.TOKEN_HAS_NO_WIPE_KEY;
        }
        // Match Hedera mainnet: wipe on a frozen account is rejected (code 165).
        // This is the constraint that forces _burnYt to unfreeze first.
        if (_frozen[token][account]) return HederaResponseCodes.ACCOUNT_FROZEN_FOR_TOKEN;

        uint256 amt = uint256(uint64(amount));
        if (_balanceOf[token][account] < amt) return HederaResponseCodes.INSUFFICIENT_TOKEN_BALANCE;

        _balanceOf[token][account] -= amt;
        t.totalSupply -= amt;
        return HederaResponseCodes.SUCCESS;
    }

    // ───────────────────── transfer ─────────────────────

    function transferToken(address token, address sender, address recipient, int64 amount)
        external
        override
        returns (int32)
    {
        TokenState storage t = _tokens[token];
        if (!t.exists) return HederaResponseCodes.INVALID_TOKEN_ID;

        // Permission check: msg.sender == sender, OR allowance(sender → msg.sender) >= amount.
        uint256 amt = uint256(uint64(amount));
        if (msg.sender != sender) {
            uint256 al = _allow[token][sender][msg.sender];
            if (al < amt) return HederaResponseCodes.INSUFFICIENT_TOKEN_BALANCE;
            _allow[token][sender][msg.sender] = al - amt;
        }

        // Auto-associate recipient (HIP-904 simulation).
        if (!_associated[token][recipient]) {
            _associated[token][recipient] = true;
            _frozen[token][recipient] = t.freezeDefault;
        }

        if (_frozen[token][sender]) return HederaResponseCodes.ACCOUNT_FROZEN_FOR_TOKEN;
        if (_frozen[token][recipient]) return HederaResponseCodes.ACCOUNT_FROZEN_FOR_TOKEN;
        if (_balanceOf[token][sender] < amt) return HederaResponseCodes.INSUFFICIENT_TOKEN_BALANCE;

        _balanceOf[token][sender] -= amt;
        _balanceOf[token][recipient] += amt;
        return HederaResponseCodes.SUCCESS;
    }

    // ───────────────────── allowance ─────────────────────

    function approve(address token, address spender, uint256 amount) external override returns (int32) {
        TokenState storage t = _tokens[token];
        if (!t.exists) return HederaResponseCodes.INVALID_TOKEN_ID;
        _allow[token][msg.sender][spender] = amount;
        return HederaResponseCodes.SUCCESS;
    }

    function allowance(address token, address owner, address spender)
        external
        view
        override
        returns (int32, uint256)
    {
        if (!_tokens[token].exists) return (HederaResponseCodes.INVALID_TOKEN_ID, 0);
        return (HederaResponseCodes.SUCCESS, _allow[token][owner][spender]);
    }

    function transferFrom(address token, address from, address to, uint256 amount)
        external
        override
        returns (int32)
    {
        TokenState storage t = _tokens[token];
        if (!t.exists) return HederaResponseCodes.INVALID_TOKEN_ID;

        uint256 al = _allow[token][from][msg.sender];
        if (al < amount) return HederaResponseCodes.INSUFFICIENT_TOKEN_BALANCE;
        _allow[token][from][msg.sender] = al - amount;

        if (!_associated[token][to]) {
            _associated[token][to] = true;
            _frozen[token][to] = t.freezeDefault;
        }
        if (_frozen[token][from]) return HederaResponseCodes.ACCOUNT_FROZEN_FOR_TOKEN;
        if (_frozen[token][to]) return HederaResponseCodes.ACCOUNT_FROZEN_FOR_TOKEN;
        if (_balanceOf[token][from] < amount) return HederaResponseCodes.INSUFFICIENT_TOKEN_BALANCE;

        _balanceOf[token][from] -= amount;
        _balanceOf[token][to] += amount;
        return HederaResponseCodes.SUCCESS;
    }

    // ───────────────────── association ─────────────────────

    function associateToken(address account, address token) external override returns (int32) {
        TokenState storage t = _tokens[token];
        // For unknown tokens (e.g. MockERC20s that the test never created via HTS),
        // treat as a no-op success — production Hedera HTS handles these differently
        // (real associations succeed for any HTS token), but the mock's responsibility
        // is just to not block contract logic that calls associate on its underlyings.
        if (!t.exists) {
            _associated[token][account] = true;
            return HederaResponseCodes.SUCCESS;
        }
        _associated[token][account] = true;
        _frozen[token][account] = t.freezeDefault;
        return HederaResponseCodes.SUCCESS;
    }

    // ───────────────────── freeze / unfreeze ─────────────────────

    function freezeToken(address token, address account) external override returns (int32) {
        TokenState storage t = _tokens[token];
        if (!t.exists) return HederaResponseCodes.INVALID_TOKEN_ID;
        if (t.freezeKey == address(0) || msg.sender != t.freezeKey) {
            return HederaResponseCodes.TOKEN_HAS_NO_FREEZE_KEY;
        }
        // Match Hedera mainnet: freezing an already-frozen account is rejected.
        // Surfaces mutations that double-freeze (e.g. always taking the
        // refreeze branch in _burnYt when balance is 0).
        if (_frozen[token][account]) return HederaResponseCodes.ACCOUNT_FROZEN_FOR_TOKEN;
        _frozen[token][account] = true;
        return HederaResponseCodes.SUCCESS;
    }

    function unfreezeToken(address token, address account) external override returns (int32) {
        TokenState storage t = _tokens[token];
        if (!t.exists) return HederaResponseCodes.INVALID_TOKEN_ID;
        if (t.freezeKey == address(0) || msg.sender != t.freezeKey) {
            return HederaResponseCodes.TOKEN_HAS_NO_FREEZE_KEY;
        }
        // Match Hedera mainnet: unfreezing a not-frozen account is rejected
        // (response code 197 = ACCOUNT_NOT_FROZEN_FOR_TOKEN).
        // Surfaces mutations that always-unfreeze (e.g. `if (true) unfreeze`
        // in _burnYt where wasFrozen is sometimes false).
        if (!_frozen[token][account]) return int32(197); // ACCOUNT_NOT_FROZEN_FOR_TOKEN
        _frozen[token][account] = false;
        return HederaResponseCodes.SUCCESS;
    }

    // ───────────────────── facade-write surface ─────────────────────

    function facadeTransfer(address token, address from, address to, uint256 amount)
        external
        override
        onlyFacade(token)
    {
        // Re-emulate the permission semantics: facade-caller is `from`.
        if (!_associated[token][to]) {
            _associated[token][to] = true;
            _frozen[token][to] = _tokens[token].freezeDefault;
        }
        require(!_frozen[token][from], "FROZEN_FROM");
        require(!_frozen[token][to], "FROZEN_TO");
        require(_balanceOf[token][from] >= amount, "BAL");
        _balanceOf[token][from] -= amount;
        _balanceOf[token][to] += amount;
    }

    function facadeTransferFrom(address token, address spender, address from, address to, uint256 amount)
        external
        override
        onlyFacade(token)
    {
        uint256 al = _allow[token][from][spender];
        require(al >= amount, "ALLOW");
        _allow[token][from][spender] = al - amount;

        if (!_associated[token][to]) {
            _associated[token][to] = true;
            _frozen[token][to] = _tokens[token].freezeDefault;
        }
        require(!_frozen[token][from], "FROZEN_FROM");
        require(!_frozen[token][to], "FROZEN_TO");
        require(_balanceOf[token][from] >= amount, "BAL");
        _balanceOf[token][from] -= amount;
        _balanceOf[token][to] += amount;
    }

    function facadeApprove(address token, address owner, address spender, uint256 amount)
        external
        override
        onlyFacade(token)
    {
        _allow[token][owner][spender] = amount;
    }

    // ───────────────────── view surface (for facade + tests) ─────────────────────

    function balanceOf(address token, address account) external view override returns (uint256) {
        // Mirror Hedera's HTS-facade quirk: when the queried EVM address is the
        // long-zero rep of an Ed25519 HAPI account, the facade reverts. Tests use
        // `__setFacadeReadBroken(account, true)` to opt an address into this mode.
        if (_facadeReadBroken[account]) revert("HTS_FACADE_ED25519");
        return _balanceOf[token][account];
    }

    function totalSupply(address token) external view override returns (uint256) {
        return _tokens[token].totalSupply;
    }

    function isFrozen(address token, address account) external view override returns (bool) {
        return _frozen[token][account];
    }

    function isAssociated(address token, address account) external view override returns (bool) {
        return _associated[token][account];
    }

    function decimalsOf(address token) external view override returns (uint8) {
        return _tokens[token].decimals;
    }

    function nameOf(address token) external view override returns (string memory) {
        return _tokens[token].name;
    }

    function symbolOf(address token) external view override returns (string memory) {
        return _tokens[token].symbol;
    }

    function allowanceOf(address token, address owner, address spender) external view override returns (uint256) {
        return _allow[token][owner][spender];
    }

    function supplyKey(address token) external view returns (address) {
        return _tokens[token].supplyKey;
    }

    /// @notice Test helper — the freeze-key holder a token was created with
    ///         (address(0) if it was created without a freeze key). Lets deploy
    ///         dry-runs assert PT is freeze-by-default-capable without minting.
    function freezeKey(address token) external view returns (address) {
        return _tokens[token].freezeKey;
    }

    function decimals(address token) external view returns (uint8) {
        return _tokens[token].decimals;
    }
}
