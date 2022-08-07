// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import "@openzeppelin/contracts/utils/Strings.sol";

import "../ITokenUriDelegate.sol";

interface ShareMicrosAccessor {
    function getShareMicros(uint256 shardId) external view returns (uint24);
}

contract TestTokenUriDelegate is ITokenUriDelegate {
    function tokenURI(uint256 tokenId) external view returns (string memory) {
        uint24 shareMicros = ShareMicrosAccessor(msg.sender).getShareMicros(
            tokenId
        );
        return
            string(
                bytes.concat(
                    "data:application/json,",
                    "%7b%22description%22%3a%22Shard%20%23",
                    bytes(Strings.toString(tokenId)),
                    "%2c%20share%20",
                    bytes(Strings.toString(uint256(shareMicros))),
                    "%20micros%22%7d"
                )
            );
    }
}
