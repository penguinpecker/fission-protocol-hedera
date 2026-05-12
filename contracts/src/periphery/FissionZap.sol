// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

/// @title FissionZap
/// @notice Single-transaction zap to mint SY shares from native HBAR.
///
///         Without this contract, the user has to: (1) wrap HBAR → WHBAR,
///         (2) swap part of the WHBAR for USDC on SaucerSwap V3, (3) approve
///         USDC to SY, (4) approve WHBAR to SY, (5) call SY.depositLiquidity —
///         five separate transactions. This zap collapses all five into one.
///
///         User flow:
///           sendValue(HBAR) → zapHbarToSy(...) → receive SY shares.
///
///         Internally:
///           1. Wrap (wrapAmount) HBAR → WHBAR via the WHBAR contract's deposit().
///           2. Approve WHBAR to the SaucerSwap V3 router; call exactInputSingle
///              to swap (swapAmount) WHBAR → USDC.
///           3. Approve the resulting USDC + remaining WHBAR to the SY adapter.
///           4. Call SY.depositLiquidity() forwarding (msg.value - wrapAmount)
///              HBAR for the V3 NPM fee.
///           5. The SY itself sends shares directly to `receiver` — we never
///              custody them.
///
///         The contract holds no funds across calls; everything either goes
///         out the door in the same tx or is in transit to the receiver. Any
///         dust left at the end is swept to msg.sender.
///
///         This contract is permissionless — no admin role. The only governed
///         parameters live on the SY itself (which sits behind the Timelock).
///         Adding/removing swap paths or routers requires a new zap deploy.

interface IWHBAR {
    function deposit() external payable;
}

interface ISaucerSwapV3Router {
    struct ExactInputSingleParams {
        address tokenIn;
        address tokenOut;
        uint24 fee;
        address recipient;
        uint256 deadline;
        uint256 amountIn;
        uint256 amountOutMinimum;
        uint160 sqrtPriceLimitX96;
    }
    function exactInputSingle(ExactInputSingleParams calldata params)
        external
        payable
        returns (uint256 amountOut);
}

interface ISYDepositLiquidity {
    function depositLiquidity(
        uint256 amount0Desired,
        uint256 amount1Desired,
        uint256 amount0Min,
        uint256 amount1Min,
        address receiver,
        uint128 minShares
    ) external payable returns (uint256 shares);

    function token0() external view returns (address);
    function token1() external view returns (address);
}

interface IHTSERC20 {
    function approve(address spender, uint256 amount) external returns (bool);
    function balanceOf(address owner) external view returns (uint256);
    function transfer(address to, uint256 amount) external returns (bool);
}

contract FissionZap {
    // Pinned addresses (Hedera mainnet). If SaucerSwap migrates routers or the
    // WHBAR-USDC fee tier changes, deploy a new zap rather than upgrading.
    address public immutable WHBAR_CONTRACT;   // wraps HBAR → WHBAR
    address public immutable WHBAR;            // HTS token address
    address public immutable USDC;             // HTS token address
    address public immutable SAUCER_V3_ROUTER; // SwapRouter01 form selector 0x414bf389

    uint24 public constant POOL_FEE = 1500; // 0.15% (WHBAR-USDC tier we use elsewhere)

    error InsufficientValue();
    error SwapAmountTooLarge();
    error SyShareMismatch();

    event Zapped(
        address indexed user,
        address indexed sy,
        uint256 hbarIn,
        uint256 usdcDeposited,
        uint256 whbarDeposited,
        uint256 sharesMinted
    );

    constructor(
        address whbarContract,
        address whbarToken,
        address usdcToken,
        address swapRouter
    ) {
        WHBAR_CONTRACT = whbarContract;
        WHBAR = whbarToken;
        USDC = usdcToken;
        SAUCER_V3_ROUTER = swapRouter;
    }

    /// @notice Zap HBAR → SY shares in one transaction.
    /// @param sy             SY contract to mint shares from.
    /// @param wrapAmount     HBAR (in wei) to wrap to WHBAR. The rest of
    ///                       msg.value covers the V3 NPM fee (SY.depositLiquidity
    ///                       requires ~5 HBAR). 1 HBAR = 1e18 wei on Hedera EVM.
    /// @param swapAmount     WHBAR (in 8-decimal raw) to swap to USDC.
    /// @param usdcMinOut     Minimum USDC out from the swap (slippage floor).
    /// @param amount0Min     Minimum USDC actually deposited to the SY's V3 NFT.
    /// @param amount1Min     Minimum WHBAR actually deposited.
    /// @param minShares      Minimum SY shares minted; floor at 1 is fine.
    /// @param receiver       Wallet that receives the SY shares (typically msg.sender).
    /// @return shares        SY shares minted.
    function zapHbarToSy(
        address sy,
        uint256 wrapAmount,
        uint256 swapAmount,
        uint256 usdcMinOut,
        uint256 amount0Min,
        uint256 amount1Min,
        uint128 minShares,
        address receiver
    ) external payable returns (uint256 shares) {
        if (msg.value < wrapAmount) revert InsufficientValue();
        if (swapAmount > _hbarToWhbarRaw(wrapAmount)) revert SwapAmountTooLarge();

        // 1. Wrap HBAR → WHBAR. The WHBAR contract sees address(this) as the holder.
        IWHBAR(WHBAR_CONTRACT).deposit{value: wrapAmount}();

        // 2. Swap part of the WHBAR → USDC via SaucerSwap V3 (0.15% pool).
        IHTSERC20(WHBAR).approve(SAUCER_V3_ROUTER, swapAmount);
        ISaucerSwapV3Router.ExactInputSingleParams memory params = ISaucerSwapV3Router.ExactInputSingleParams({
            tokenIn: WHBAR,
            tokenOut: USDC,
            fee: POOL_FEE,
            recipient: address(this),
            deadline: block.timestamp + 600,
            amountIn: swapAmount,
            amountOutMinimum: usdcMinOut,
            sqrtPriceLimitX96: 0
        });
        ISaucerSwapV3Router(SAUCER_V3_ROUTER).exactInputSingle(params);

        // 3. Deposit USDC + remaining WHBAR into the SY.
        uint256 usdcBal = IHTSERC20(USDC).balanceOf(address(this));
        uint256 whbarBal = IHTSERC20(WHBAR).balanceOf(address(this));
        IHTSERC20(USDC).approve(sy, usdcBal);
        IHTSERC20(WHBAR).approve(sy, whbarBal);

        // SY.depositLiquidity is payable — forward leftover HBAR for the NPM fee.
        uint256 npmHbar = address(this).balance;
        shares = ISYDepositLiquidity(sy).depositLiquidity{value: npmHbar}(
            usdcBal,
            whbarBal,
            amount0Min,
            amount1Min,
            receiver,
            minShares
        );

        emit Zapped(receiver, sy, msg.value, usdcBal, whbarBal, shares);

        // Sweep any dust (some swap router implementations leave WHBAR behind on
        // partial fills; SY may not consume the full balance either).
        uint256 dust0 = IHTSERC20(USDC).balanceOf(address(this));
        uint256 dust1 = IHTSERC20(WHBAR).balanceOf(address(this));
        if (dust0 > 0) IHTSERC20(USDC).transfer(msg.sender, dust0);
        if (dust1 > 0) IHTSERC20(WHBAR).transfer(msg.sender, dust1);

        // Refund any HBAR the SY didn't actually consume.
        uint256 hbarLeft = address(this).balance;
        if (hbarLeft > 0) {
            (bool ok, ) = payable(msg.sender).call{value: hbarLeft}("");
            require(ok, "hbar refund failed");
        }
    }

    /// @dev HBAR is 18-dec on the EVM side but WHBAR is 8-dec. 1 HBAR (1e18 wei)
    ///      maps to 1 WHBAR raw (1e8 units). Divide accordingly when validating
    ///      that the swap amount doesn't exceed wrapped balance.
    function _hbarToWhbarRaw(uint256 hbarWei) internal pure returns (uint256) {
        return hbarWei / 1e10;
    }

    /// @notice Accept HBAR (the WHBAR contract sends some back during deposit).
    receive() external payable {}
}
