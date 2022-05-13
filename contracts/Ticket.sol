//SPDX-License-Identifier: Unlicense
pragma solidity ^0.8.0;

import "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import "@openzeppelin/contracts/access/Ownable.sol";

contract Ticket is ERC721, Ownable {
    uint256 minted;
    uint256 maxSupply;
    uint256[] prices;
    uint256 intervalTimeSecs;
    uint256 auctionStartTimestamp; // seconds since epoch, per block.timestamp

    constructor(uint256 _maxSupply) ERC721("TRNF Ticket", "TRNF-TIX") {
        require(_maxSupply % 3 == 0, "max supply must be multiple of 3");
        maxSupply = _maxSupply;
    }

    function premint(uint256 numToMint) external onlyOwner {
        require(numToMint % 3 == 0, "can only premint in batches of 3");
        require(auctionStartTimestamp == 0, "can't premint during auction");
        for (uint256 i = 0; i < numToMint; i++) {
            _safeMint(msg.sender, minted);
            minted++;
        }
        require(minted <= maxSupply, "too many mints");
    }

    function startAuction(uint256[] memory _prices, uint256 _intervalTimeSecs)
        external
        onlyOwner
    {
        require(auctionStartTimestamp == 0, "auction already started");
        require(_intervalTimeSecs > 0, "need positive interval time");
        require(_prices.length > 0, "need at least one price");
        prices = _prices;
        intervalTimeSecs = _intervalTimeSecs;
        auctionStartTimestamp = block.timestamp;
    }

    // Returns current price for the dutch auction, if it is ongoing.
    // If the auction has not started, it will return 0.
    // Will still return a price even after the auction is fully sold out.
    function currentPrice() public view returns (uint256) {
        if (auctionStartTimestamp == 0) {
            return 0;
        }
        uint256 intervalsElapsed = (block.timestamp - auctionStartTimestamp) /
            intervalTimeSecs;
        uint256 lastInterval = prices.length - 1;
        if (intervalsElapsed > lastInterval) {
            intervalsElapsed = lastInterval;
        }
        return prices[intervalsElapsed];
    }

    function mintAtAuction() public payable {
        require(minted < maxSupply - 3, "minted out");
        uint256 price = currentPrice();
        require(msg.value >= price, "must pay to mint");
        _safeMint(msg.sender, minted++);
        _safeMint(msg.sender, minted++);
        _safeMint(msg.sender, minted++);
    }

    function withdrawFunds() external onlyOwner {
        uint256 balance = address(this).balance;
        payable(msg.sender).transfer(balance);
    }
}
