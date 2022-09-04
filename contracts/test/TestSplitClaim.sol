// SPDX-License-Identifier: MIT
pragma solidity ^0.8.8;

import "../Shardwallet.sol";

contract TestSplitClaim is Shardwallet {
    function splitClaimBatch(uint256 amount, uint24[] memory shareMicros)
        external
        pure
        returns (uint256[] memory)
    {
        uint256[] memory result = new uint256[](shareMicros.length);
        for (uint256 i = 0; i < shareMicros.length; i++) {
            result[i] = splitClaim(amount, shareMicros, i);
        }
        return result;
    }
}
