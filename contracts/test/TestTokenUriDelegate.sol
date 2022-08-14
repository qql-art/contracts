// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import "@openzeppelin/contracts/utils/Strings.sol";

import "../ITokenUriDelegate.sol";

contract TestTokenUriDelegate is ITokenUriDelegate {
    function tokenURI(uint256 tokenId) external view returns (string memory) {
        string memory sTokenContract = Strings.toHexString(
            uint256(uint160(msg.sender)),
            20
        );
        string memory sTokenId = Strings.toString(tokenId);
        return
            string(
                bytes.concat(
                    "data:text/plain,",
                    bytes(sTokenContract), // includes "0x" prefix
                    "%20%23", // space, number sign
                    bytes(sTokenId)
                )
            );
    }
}
