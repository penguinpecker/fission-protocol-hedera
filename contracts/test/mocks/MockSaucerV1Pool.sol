// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IUniswapV2Pair} from "../../src/interfaces/IUniswapV2Pair.sol";

/// @notice Minimal SaucerSwap V1 / Uniswap V2 LP token mock for tests. Reserves and
///         totalSupply are settable so tests can simulate fee-driven k growth without
///         routing real swaps.
contract MockSaucerV1Pool is ERC20, IUniswapV2Pair {
    address public override token0;
    address public override token1;
    uint112 private _reserve0;
    uint112 private _reserve1;
    uint32 private _blockTimestampLast;

    constructor(address t0, address t1) ERC20("SaucerSwap LP", "SS-LP") {
        token0 = t0;
        token1 = t1;
    }

    function decimals() public pure override returns (uint8) {
        return 8;
    }

    function setReserves(uint112 r0, uint112 r1) external {
        _reserve0 = r0;
        _reserve1 = r1;
        _blockTimestampLast = uint32(block.timestamp);
    }

    function getReserves() external view override returns (uint112, uint112, uint32) {
        return (_reserve0, _reserve1, _blockTimestampLast);
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function totalSupply() public view override(ERC20, IUniswapV2Pair) returns (uint256) {
        return ERC20.totalSupply();
    }
}
