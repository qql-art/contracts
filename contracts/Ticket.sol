//SPDX-License-Identifier: Unlicense
pragma solidity ^0.8.0;

import "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import "@openzeppelin/contracts/access/Ownable.sol";

contract Ticket is ERC721, Ownable {
    uint256 private minted;
    uint256 private maxSupply;
    uint256[] private prices;
    uint256 private intervalTimeSecs;
    uint256 private auctionStartTimestamp; // seconds since epoch, per block.timestamp
    // Which address is empowered to burn tokens.
    // Intended to be a permission given to the TRNF contract, so it can burn Tickets
    // when it mints TRNFs.
    address private burner;
    string private baseURI;

    constructor(uint256 _maxSupply) ERC721("TRNF Ticket", "TRNF-TIX") {
        require(_maxSupply % 3 == 0, "max supply must be multiple of 3");
        maxSupply = _maxSupply;
    }

    function setBurner(address _burner) external onlyOwner {
        burner = _burner;
    }

    function burn(uint256 tokenId) external {
        require(msg.sender == burner, "only burner address can burn tokens");
        _burn(tokenId);
    }

    function setBaseURI(string memory baseURI_) external onlyOwner {
        baseURI = baseURI_;
    }

    function _baseURI() internal view override returns (string memory) {
        return baseURI;
    }

    function ownerMint(uint256 numToMint, address recipient)
        external
        onlyOwner
    {
        require(numToMint % 3 == 0, "can only ownerMint in batches of 3");
        require((minted + numToMint) <= maxSupply, "too many mints");
        for (uint256 i = 0; i < numToMint; i++) {
            _safeMint(recipient, minted);
            minted++;
        }
    }

    function startAuction(uint256[] memory _prices, uint256 _intervalTimeSecs)
        external
        onlyOwner
    {
        require(_intervalTimeSecs > 0, "need positive interval time");
        require(_prices.length > 0, "need at least one price");
        prices = _prices;
        intervalTimeSecs = _intervalTimeSecs;
        // solhint flags the following line due to its reliance on block time.
        // It's possible that a malicious miner could alter the block time by a
        // few seconds on the Ethereum network, but for our purposes, this is
        // negligible.
        //
        // See the following:
        //     https://stackoverflow.com/questions/71000103/
        //
        // solhint-disable-next-line not-rely-on-time
        auctionStartTimestamp = block.timestamp;
    }

    // Returns current price for the dutch auction, if it is ongoing.
    // If the auction has not started, it will max uint256
    // Will still return a price even after the auction is fully sold out.
    function currentPrice() public view returns (uint256) {
        if (auctionStartTimestamp == 0) {
            return 2**256 - 1;
        }
        // See above comment on solhint flagging reliance on block time.
        // solhint-disable-next-line not-rely-on-time
        uint256 intervalsElapsed = (block.timestamp - auctionStartTimestamp) /
            intervalTimeSecs;
        uint256 lastInterval = prices.length - 1;
        if (intervalsElapsed > lastInterval) {
            intervalsElapsed = lastInterval;
        }
        return prices[intervalsElapsed];
    }

    function mintAtAuction() public payable {
        require(minted <= maxSupply - 3, "minted out");
        uint256 price = currentPrice();
        require(msg.value >= price, "must pay to mint");
        _safeMint(msg.sender, minted++);
        _safeMint(msg.sender, minted++);
        _safeMint(msg.sender, minted++);
    }

    function withdrawFunds(address recipient) external onlyOwner {
        uint256 balance = address(this).balance;
        payable(recipient).transfer(balance);
    }
}
