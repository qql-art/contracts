// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "./Ticket.sol";

struct TokenData {
    address minter;
    string data;
}

contract QQL is ERC721, Ownable {
    Ticket private ticket;
    string private baseURI;
    mapping(uint256 => TokenData) public tokenData;
    mapping(uint256 => string) public scriptPieces;

    constructor(Ticket _ticket) ERC721("QQL", "QQL") {
        ticket = _ticket;
    }

    function setBaseURI(string memory baseURI_) external onlyOwner {
        baseURI = baseURI_;
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

    modifier onlyTicketOwnerOrApproved(uint256 tokenId) {
        bool ownerOrApproved = false;
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
        _;
    }

    function mint(uint256 tokenId, string memory data)
        external
        onlyTicketOwnerOrApproved(tokenId)
    {
        ticket.burn(tokenId);
        _safeMint(msg.sender, tokenId);
        tokenData[tokenId] = TokenData({minter: msg.sender, data: data});
    }
}
