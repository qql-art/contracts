//SPDX-License-Identifier: Unlicense
pragma solidity ^0.8.0;

import "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "./Ticket.sol";

struct TokenData {
    address minter;
    string data;
}

contract TRNF is ERC721, Ownable {
    Ticket ticket;
    string baseURI;
    mapping(uint256 => TokenData) public tokenData;
    mapping(uint256 => string) public scriptPieces;

    constructor(Ticket _ticket) ERC721("TRNF", "TRNF") {
        ticket = _ticket;
    }

    function setBaseURI(string memory _baseURI) external onlyOwner {
        baseURI = _baseURI;
    }

    function _baseURI() internal view override returns (string memory) {
        return baseURI;
    }

    function setScriptPiece(uint256 id, string memory data) external onlyOwner {
        require(
            bytes(scriptPieces[id]).length == 0,
            "script pieces are immutable once set"
        );
        scriptPieces[id] = data;
    }

    function mint(uint256 tokenId, string memory data) external {
        bool ownerOrApproved;
        address ticketOwner = ticket.ownerOf(tokenId);
        if (ticketOwner == msg.sender) {
            ownerOrApproved = true;
        } else if (ticket.getApproved(tokenId) == msg.sender) {
            ownerOrApproved = true;
        } else if (ticket.isApprovedForAll(ticketOwner, msg.sender)) {
            ownerOrApproved = true;
        }
        require(
            ownerOrApproved,
            "prospective minter is not owner or approved for ticket"
        );
        ticket.burn(tokenId);
        _safeMint(msg.sender, tokenId);
        tokenData[tokenId] = TokenData({minter: msg.sender, data: data});
    }
}
