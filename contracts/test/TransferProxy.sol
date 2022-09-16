// SPDX-License-Identifier: MIT
pragma solidity ^0.8.8;

import "@openzeppelin/contracts/token/ERC721/IERC721.sol";

contract TransferProxy {
    function transferFrom(
        IERC721 tokenContract,
        address from,
        address to,
        uint256 tokenId
    ) external {
        if (from != msg.sender) revert("TransferProxy: unauthorized");
        tokenContract.transferFrom(from, to, tokenId);
    }
}
