// SPDX-License-Identifier: GPL-2.0-only
pragma solidity ^0.8.0;

contract Clock {
    function timestamp() public view returns (uint256) {
        return block.timestamp;
    }
}
