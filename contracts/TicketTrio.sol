//SPDX-License-Identifier: Unlicense
pragma solidity ^0.8.0;

import "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import "@openzeppelin/contracts/token/ERC721/extensions/ERC721Burnable.sol";
import "@openzeppelin/contracts/access/Ownable.sol";

contract TicketTrio is ERC721, Ownable, ERC721Burnable {
    uint256 maxSupply;
    bool minted;

    constructor(uint256 _maxSupply) ERC721("TRNF Ticket Trio", "TRNF-T3") {
        maxSupply = _maxSupply;
    }

    function mintAll() external onlyOwner {
        require(!minted, "tickets already minted");
        minted = true;
        for (uint256 i = 0; i < maxSupply; i++) {
            _safeMint(msg.sender, i);
        }
    }
}
