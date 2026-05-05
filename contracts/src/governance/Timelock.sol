// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {TimelockController} from "@openzeppelin/contracts/governance/TimelockController.sol";

/// @title  Timelock — OZ TimelockController shim for Fission governance.
/// @notice The Hedera 2-of-2 ThresholdKey account holds PROPOSER_ROLE +
///         EXECUTOR_ROLE on this Timelock; admin is renounced via the
///         constructor (`admin = address(0)`) so the Timelock self-governs
///         after deploy. DEFAULT_ADMIN_ROLE on every protocol contract is
///         transferred here in Phase C; revokes flow through
///         `schedule + execute` from the threshold account.
contract Timelock is TimelockController {
    constructor(
        uint256 minDelay,
        address[] memory proposers,
        address[] memory executors,
        address admin
    ) TimelockController(minDelay, proposers, executors, admin) {}
}
