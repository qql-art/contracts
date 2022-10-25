// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/token/ERC721/extensions/ERC721Enumerable.sol";
import "@openzeppelin/contracts/utils/structs/EnumerableMap.sol";

import "./MintPass.sol";
import "./QQL.sol";

struct ListingData {
    address lister;
    uint96 price;
}

struct BidData {
    uint16 mintPassId;
    uint96 price;
}

contract SeedMarket is Ownable {
    using EnumerableMap for EnumerableMap.AddressToUintMap;

    QQL immutable qql_;
    MintPass immutable pass_;
    uint256 blessingFee_;

    mapping(bytes32 => bool) blessed_;
    mapping(bytes32 => ListingData) listings_;
    mapping(bytes32 => EnumerableMap.AddressToUintMap) bids_; /* packed `BidData` */

    event BlessingFeeUpdate(uint256 oldFee, uint256 newFee);
    event Blessing(bytes32 indexed seed, address cleric);
    event Listing(bytes32 indexed seed, address indexed lister, uint96 price);
    event Delisting(bytes32 indexed seed);

    constructor(
        QQL _qql,
        MintPass _pass,
        uint256 blessingFee
    ) {
        qql_ = _qql;
        pass_ = _pass;
        blessingFee_ = blessingFee;
        emit BlessingFeeUpdate(0, blessingFee);
    }

    function setBlessingFee(uint256 blessingFee) external onlyOwner {
        emit BlessingFeeUpdate(blessingFee_, blessingFee);
        blessingFee_ = blessingFee;
    }

    function isSeedOperatorOrParametricArtist(address operator, bytes32 seed)
        internal
        view
        returns (bool)
    {
        if (operator == address(bytes20(seed))) return true;
        return qql_.isApprovedOrOwnerForSeed(operator, seed);
    }

    function bless(bytes32 seed) public payable {
        if (!isSeedOperatorOrParametricArtist(msg.sender, seed))
            revert("SeedMarket: unauthorized");
        if (msg.value != blessingFee_) revert("SeedMarket: wrong fee");
        if (blessed_[seed]) revert("SeedMarket: already blessed");
        emit Blessing(seed, msg.sender);
    }

    function blessAndList(bytes32 seed, uint96 price) external payable {
        bless(seed);
        list(seed, price);
    }

    function list(bytes32 seed, uint96 price) public payable {
        if (!qql_.isApprovedOrOwnerForSeed(msg.sender, seed))
            revert("SeedMarket: unauthorized");
        qql_.transferSeed(qql_.ownerOfSeed(seed), address(this), seed);
        listings_[seed] = ListingData({lister: msg.sender, price: price});
        emit Listing(seed, msg.sender, price);
        revert("SeedMarket: not yet implemented");
    }

    function reprice(bytes32 seed, uint96 price) external {
        ListingData memory lst = listings_[seed];
        if (lst.lister != msg.sender) revert("SeedMarket: unauthorized");
        lst.price = price;
        listings_[seed] = lst;
        emit Listing(seed, msg.sender, price);
    }

    function delist(bytes32 seed) external {
        if (listings_[seed].lister != msg.sender)
            revert("SeedMarket: unauthorized");
        delete listings_[seed].lister;
        qql_.transferSeed(address(this), msg.sender, seed);
        emit Delisting(seed);
    }

    function bid(
        bytes32 seed,
        uint96 price,
        uint256 mintPassId
    ) public {
        if (mintPassId != uint16(mintPassId))
            revert("SeedMarket: invalid data");
        BidData memory _bid = BidData({
            mintPassId: uint16(mintPassId),
            price: price
        });
        bids_[seed].set(msg.sender, Bids.pack(_bid));
    }

    function unbid(bytes32 seed) external {
        bid(seed, 0, 0);
    }
}

library Bids {
    function pack(BidData memory bid) internal pure returns (uint256) {
        return (uint256(bid.mintPassId) << 240) | uint256(bid.price);
    }

    function unpack(uint256 packedBid)
        internal
        pure
        returns (BidData memory bid)
    {
        bid.mintPassId = uint16(packedBid >> 240);
        bid.price = uint96(packedBid);
        if (bid.price != uint240(packedBid)) revert("SeedMarket: invalid data");
    }
}
