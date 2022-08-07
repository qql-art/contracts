// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

contract Nonpayable {
    receive() external payable {
        revert("Nonpayable: revert!");
    }
}
