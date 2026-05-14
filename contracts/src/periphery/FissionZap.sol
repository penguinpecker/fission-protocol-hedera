// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

/// @title FissionZap
/// @notice Single-transaction zap to mint SY shares from native HBAR.
///
///         Without this contract, the user has to: (1) wrap HBAR → WHBAR,
///         (2) swap part of the WHBAR for USDC on SaucerSwap V2, (3) approve
///         USDC to SY, (4) approve WHBAR to SY, (5) call SY.depositLiquidity —
///         five separate transactions. This zap collapses all five into one.
///
///         User flow:
///           sendValue(HBAR) → zapHbarToSy(...) → receive SY shares.
///
///         Internally:
///           1. Wrap (wrapAmount) HBAR → WHBAR via the WHBAR contract's deposit().
///           2. Approve WHBAR to the SaucerSwap V2 router; call exactInputSingle
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

interface ISaucerSwapV2Router {
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
    address public immutable SAUCER_V2_ROUTER; // SwapRouter01 form selector 0x414bf389

    uint24 public constant POOL_FEE = 1500; // 0.15% (WHBAR-USDC tier we use elsewhere)

    error InsufficientValue();

    event Zapped(
        address indexed user,
        address indexed sy,
        uint256 hbarTinybarsIn,
        uint256 usdcDeposited,
        uint256 whbarDeposited,
        uint256 sharesMinted
    );

    /// @dev Reserved for the V3 NPM fee that SY.depositLiquidity forwards
    ///      internally (~5 HBAR is what SaucerSwap V2 NPM charges for
    ///      increaseLiquidity in USD-cents-denominated form). On Hedera EVM
    ///      msg.value is in TINYBARS (1 HBAR = 1e8 tinybars), NOT wei like
    ///      Ethereum. So 5 HBAR = 5e8 tinybars here.
    uint256 internal constant NPM_FEE_TINYBARS = 5 * 1e8;

    constructor(
        address whbarContract,
        address whbarToken,
        address usdcToken,
        address swapRouter
    ) {
        WHBAR_CONTRACT = whbarContract;
        WHBAR = whbarToken;
        USDC = usdcToken;
        SAUCER_V2_ROUTER = swapRouter;
    }

    /// @notice Zap HBAR → SY shares in one transaction.
    /// @dev    User sends N HBAR via msg.value. The contract reserves
    ///         NPM_FEE_TINYBARS for the V3 NPM fee, wraps the rest to
    ///         WHBAR, swaps half to USDC, and deposits both into the SY.
    ///         No wrapAmount/swapAmount params — derived from msg.value
    ///         and on-chain WHBAR balance after wrap.
    ///
    ///         Hedera EVM unit reminder: msg.value is in TINYBARS, not wei.
    ///
    /// @param sy             SY contract to mint shares from.
    /// @param usdcMinOut     Minimum USDC out from the WHBAR→USDC swap.
    /// @param amount0Min     Minimum USDC actually deposited to the SY's V3 NFT.
    /// @param amount1Min     Minimum WHBAR actually deposited.
    /// @param minShares      Minimum SY shares minted; floor at 1 is fine.
    /// @param receiver       Wallet that receives the SY shares (typically msg.sender).
    /// @return shares        SY shares minted.
    function zapHbarToSy(
        address sy,
        uint256 usdcMinOut,
        uint256 amount0Min,
        uint256 amount1Min,
        uint128 minShares,
        address receiver
    ) external payable returns (uint256 shares) {
        if (msg.value <= NPM_FEE_TINYBARS) revert InsufficientValue();

        // Reserve NPM fee out of msg.value, wrap the rest. WHBAR is 8-dec
        // and HBAR/tinybars are also 8-dec on Hedera — 1:1 mapping, so
        // wrapping N tinybars produces N raw WHBAR.
        uint256 wrapAmount = msg.value - NPM_FEE_TINYBARS;
        IWHBAR(WHBAR_CONTRACT).deposit{value: wrapAmount}();

        // Swap half the wrapped WHBAR to USDC via SaucerSwap V2 (0.15% pool).
        uint256 whbarBal = IHTSERC20(WHBAR).balanceOf(address(this));
        uint256 swapAmount = whbarBal / 2;
        IHTSERC20(WHBAR).approve(SAUCER_V2_ROUTER, swapAmount);
        ISaucerSwapV2Router.ExactInputSingleParams memory params = ISaucerSwapV2Router.ExactInputSingleParams({
            tokenIn: WHBAR,
            tokenOut: USDC,
            fee: POOL_FEE,
            recipient: address(this),
            deadline: block.timestamp + 600,
            amountIn: swapAmount,
            amountOutMinimum: usdcMinOut,
            sqrtPriceLimitX96: 0
        });
        ISaucerSwapV2Router(SAUCER_V2_ROUTER).exactInputSingle(params);

        // Deposit USDC + remaining WHBAR into the SY. Forward all remaining
        // contract HBAR — SY pulls what NPM needs and the rest gets swept later.
        uint256 usdcBal = IHTSERC20(USDC).balanceOf(address(this));
        whbarBal = IHTSERC20(WHBAR).balanceOf(address(this));
        IHTSERC20(USDC).approve(sy, usdcBal);
        IHTSERC20(WHBAR).approve(sy, whbarBal);

        shares = ISYDepositLiquidity(sy).depositLiquidity{value: address(this).balance}(
            usdcBal,
            whbarBal,
            amount0Min,
            amount1Min,
            receiver,
            minShares
        );

        emit Zapped(receiver, sy, msg.value, usdcBal, whbarBal, shares);

        // Sweep any dust back to caller.
        uint256 dust0 = IHTSERC20(USDC).balanceOf(address(this));
        uint256 dust1 = IHTSERC20(WHBAR).balanceOf(address(this));
        if (dust0 > 0) IHTSERC20(USDC).transfer(msg.sender, dust0);
        if (dust1 > 0) IHTSERC20(WHBAR).transfer(msg.sender, dust1);

        uint256 hbarLeft = address(this).balance;
        if (hbarLeft > 0) {
            (bool ok, ) = payable(msg.sender).call{value: hbarLeft}("");
            require(ok, "hbar refund failed");
        }
    }

    /// @notice Accept HBAR (the WHBAR contract sends some back during deposit).
    receive() external payable {}
}
