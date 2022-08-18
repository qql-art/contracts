// SPDX-License-Identifier: MIT
pragma solidity ^0.8.8;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import "@openzeppelin/contracts/utils/math/SafeMath.sol";

import "./IManifold.sol";
import "./ITokenUriDelegate.sol";

/// @dev
/// Parameters for a piecewise-constant price function with the following
/// shape:
///
/// (1) Prior to `startTimestamp`, the price is `type(uint256).max`.
///
/// (2) At `startTimestamp`, the price jumps to `startGwei` gwei.
///     Every `dropPeriodSeconds` seconds, the price drops as follows:.
///
///     (a) Each of the first `n1` drops is for `c1 * dropGwei` gwei.
///     (b) Each of the next `n2` drops is for `c2 * dropGwei` gwei.
///     (c) Each of the next `n3` drops is for `c3 * dropGwei` gwei.
///     (d) Each subsequent drop is for `c4 * dropGwei` gwei.
///
/// (3) The price never drops below `reserveGwei` gwei.
///
/// For example, suppose that `dropPeriodSeconds` is 60, `startGwei` is 100e9,
/// `dropGwei` is 5e8, `[n1, n2, n3]` is `[10, 15, 20]`, and `[c1, c2, c3, c4]`
/// is [8, 4, 2, 1]`. Then: the price starts at 100 ETH, then drops in 4 ETH
/// increments down to 60 ETH, then drops in 2 ETH increments down to 30 ETH,
/// then drops in 1 ETH increments down to 10 ETH, then drops in 0.5 ETH
/// increments down to the reserve price.
///
/// As a special case, if `startTimestamp == 0`, the auction is considered to
/// not be scheduled yet, and the price is `type(uint256).max` at all times.
struct AuctionSchedule {
    uint40 startTimestamp;
    uint16 dropPeriodSeconds;
    uint48 startGwei;
    uint48 dropGwei;
    uint48 reserveGwei;
    uint8 n1;
    uint8 n2;
    uint8 n3;
    uint8 c1;
    uint8 c2;
    uint8 c3;
    uint8 c4;
}

library ScheduleMath {
    /// @dev The result of this function must be (weakly) monotonically
    /// decreasing. If the reported price were to increase, then users who
    /// bought mint passes at multiple price points might receive a smaller
    /// rebate than they had expected, and the owner might not be able to
    /// withdraw all the proceeds.
    function currentPrice(AuctionSchedule memory s, uint256 timestamp)
        internal
        pure
        returns (uint256)
    {
        if (s.startTimestamp == 0) return type(uint256).max;
        if (timestamp < s.startTimestamp) return type(uint256).max;
        if (s.dropPeriodSeconds == 0) return s.reserveGwei * 1 gwei;

        uint256 secondsElapsed = timestamp - s.startTimestamp;
        uint256 drops = secondsElapsed / s.dropPeriodSeconds;

        uint256 priceGwei = s.startGwei;
        uint256 dropGwei = s.dropGwei;

        uint256 inf = type(uint256).max;
        (drops, priceGwei) = doDrop(s.n1, drops, priceGwei, s.c1 * dropGwei);
        (drops, priceGwei) = doDrop(s.n2, drops, priceGwei, s.c2 * dropGwei);
        (drops, priceGwei) = doDrop(s.n3, drops, priceGwei, s.c3 * dropGwei);
        (drops, priceGwei) = doDrop(inf, drops, priceGwei, s.c4 * dropGwei);

        if (priceGwei < s.reserveGwei) priceGwei = s.reserveGwei;
        return priceGwei * 1 gwei;
    }

    function doDrop(
        uint256 limit,
        uint256 remaining,
        uint256 priceGwei,
        uint256 dropGwei
    ) private pure returns (uint256 _remaining, uint256 _priceGwei) {
        uint256 effectiveDrops = remaining;
        if (effectiveDrops > limit) effectiveDrops = limit;
        (bool ok, uint256 totalDropGwei) = SafeMath.tryMul(
            effectiveDrops,
            dropGwei
        );
        if (!ok || totalDropGwei > priceGwei) totalDropGwei = priceGwei;
        priceGwei -= totalDropGwei;
        return (remaining - effectiveDrops, priceGwei);
    }
}

/// @dev
/// A record of each buyer's interactions with the auction contract.
/// The buyer's outstanding rebate can be calculated from this receipt combined
/// with the current (or final) clearing price. Specifically, the clearing
/// value of the buyer's mint passes is `clearingPrice * numPurchased`.
/// The `netPaid` amount must never be less than the clearing value; if it's
/// greater than the clearing value, then the buyer is entitled to claim the
/// difference.
struct Receipt {
    /// The total amount that the buyer paid for all mint passes that they
    /// purchased, minus the total amount of rebates claimed so far.
    uint192 netPaid;
    /// The total number of mint passes that the buyer purchased. (This does
    /// not count any mint passes created by `reserve`.)
    uint64 numPurchased;
}

/// @dev These fields are grouped because they change at the same time and can
/// be written atomically to save on storage I/O.
struct SupplyStats {
    /// The total number of mint passes that have ever been created. This
    /// counts passes created by both `purchase` and `reserve`, and does not
    /// decrease when passes are burned.
    uint64 created;
    /// The number of mint passes that have been purchased at auction. This
    /// differs from `created_` in that it does not count mint passes created
    /// for free via `reserve`.
    uint64 purchased;
    /// The current number of mint passes (i.e., valid ERC-721 tokens).
    uint64 current;
}

contract MintPass is ERC721, Ownable, IManifold {
    using ScheduleMath for AuctionSchedule;

    /// The maximum number of mint passes that may ever be created.
    uint64 immutable maxCreated_;
    SupplyStats supplyStats_;

    mapping(address => Receipt) receipts_;
    /// Whether `withdrawProceeds` has been called yet.
    bool proceedsWithdrawn_;

    AuctionSchedule schedule_;
    /// The block timestamp at which the auction ended, or 0 if the auction has
    /// not yet ended (i.e., either is still ongoing or has not yet started).
    /// The auction ends when the last mint pass is created, which may be
    /// before or after the price would hit its terminal scheduled value.
    uint256 endTimestamp_;

    /// The address permitted to burn mint passes when minting QQL tokens.
    address burner_;

    address payable projectRoyaltyRecipient_;
    address payable platformRoyaltyRecipient_;
    uint256 constant PROJECT_ROYALTY_BPS = 500; // 5%
    uint256 constant PLATFORM_ROYALTY_BPS = 200; // 2%

    ITokenUriDelegate tokenUriDelegate_;

    /// Emitted whenever mint passes are purchased at auction. The `payment`
    /// field represents the amount of Ether deposited with the message call;
    /// this may be more than the current price of the purchased mint passes,
    /// adding to the buyer's rebate, or it may be less, consuming some of the
    /// rebate.
    ///
    /// Creating mint passes with `reserve` does not emit this event.
    event MintPassPurchase(
        address indexed buyer,
        uint256 payment,
        uint256 count
    );

    /// Emitted whenever a buyer claims a rebate. This may happen more than
    /// once per buyer, since rebates can be claimed incrementally as the
    /// auction goes on. The `claimed` amount may be 0 if there is no new
    /// rebate to claim, which may happen if the price has not decreased since
    /// the last claim.
    event RebateClaim(address indexed buyer, uint256 claimed);

    /// Emitted when the contract owner withdraws the auction proceeds.
    event ProceedsWithdrawal(uint256 amount);

    event ProjectRoyaltyRecipientChanged(address payable recipient);
    event PlatformRoyaltyRecipientChanged(address payable recipient);

    constructor(uint64 _maxCreated) ERC721("", "") {
        maxCreated_ = _maxCreated;
    }

    function name() public pure override returns (string memory) {
        return "QQL Mint Pass";
    }

    function symbol() public pure override returns (string memory) {
        return "QQL:MintPass";
    }

    /// Returns the current number of active mint passes.
    ///
    /// @dev Conforms to EIP-721's `ERC721Enumerable`, though we don't
    /// implement the rest of the functions in that extension.
    function totalSupply() external view returns (uint256) {
        return supplyStats_.current;
    }

    /// Returns the total number of mint passes ever created.
    function totalCreated() external view returns (uint256) {
        return supplyStats_.created;
    }

    /// Returns the maximum number of mint passes that can ever be created
    /// (cumulatively, not just active at one time). That is, `totalCreated()`
    /// will never exceed `maxCreated()`.
    ///
    /// When `totalCreated() == maxCreated()`, the auction is over.
    function maxCreated() external view returns (uint256) {
        return maxCreated_;
    }

    /// Configures the mint pass auction. Can be called multiple times,
    /// including while the auction is active. Reverts if this would cause the
    /// current price to increase or if the auction is already over.
    function updateAuctionSchedule(AuctionSchedule memory schedule)
        external
        onlyOwner
    {
        if (endTimestamp_ != 0) revert("MintPass: auction ended");
        uint256 oldPrice = currentPrice();
        schedule_ = schedule;
        uint256 newPrice = currentPrice();
        if (newPrice > oldPrice) revert("MintPass: price would increase");
    }

    /// Returns the block timestamp at which the auction ended, or 0 if the
    /// auction has not ended yet (including if it hasn't started).
    function endTimestamp() external view returns (uint256) {
        return endTimestamp_;
    }

    /// Creates `count` mint passes owned by `recipient`. The new token IDs
    /// will be allocated sequentially (even if the recipient's ERC-721 receive
    /// hook causes more mint passes to be created in the middle); the return
    /// value is the first token ID.
    ///
    /// If this creates the final mint pass, it also ends the auction by
    /// setting `endTimestamp_`. If this would create more mint passes than the
    /// max supply supports, it reverts.
    function _createMintPasses(
        address recipient,
        uint256 count,
        bool isPurchase
    ) internal returns (uint256) {
        // Can't return a valid new token ID, and, more importantly, don't want
        // to stomp `endTimestamp_` if the auction is already over.
        if (count == 0) revert("MintPass: count is zero");

        SupplyStats memory stats = supplyStats_;
        uint256 oldCreated = stats.created;

        uint256 newCreated = stats.created + count;
        if (newCreated > maxCreated_) revert("MintPass: minted out");

        // Lossless since `newCreated <= maxCreated_ <= type(uint64).max`.
        stats.created = _losslessSum(stats.current, count);
        // Lossless since `current <= created <= type(uint64).max`.
        stats.current = _losslessSum(stats.current, count);
        if (isPurchase) {
            // Lossless since `purchased <= created <= type(uint64).max`.
            stats.purchased = _losslessSum(stats.purchased, count);
        }

        supplyStats_ = stats;
        if (stats.created == maxCreated_) endTimestamp_ = block.timestamp;

        uint256 firstTokenId = oldCreated + 1;
        uint256 nextTokenId = firstTokenId;
        for (uint256 i = 0; i < count; i++) {
            _safeMint(recipient, nextTokenId++);
        }
        return firstTokenId;
    }

    /// @dev Helper for `_createMintPasses`.
    function _losslessSum(uint64 a, uint256 b) internal pure returns (uint64) {
        uint256 sum = a + b;
        uint64 result = uint64(sum);
        assert(result == sum);
        return result;
    }

    /// Purchases `count` mint passes at the current auction price. Reverts if
    /// the auction has not started, if the auction has minted out, or if the
    /// value associated with this message is less than required. Returns the
    /// first token ID.
    function purchase(uint256 count) external payable returns (uint256) {
        uint256 priceEach = currentPrice();
        if (priceEach == type(uint256).max) {
            // Just a nicer error message.
            revert("MintPass: auction not started");
        }

        Receipt memory receipt = receipts_[msg.sender];

        uint256 newNetPaid = receipt.netPaid + msg.value;
        receipt.netPaid = uint192(newNetPaid);
        if (receipt.netPaid != newNetPaid) {
            // Truncation here would require cumulative payments of 2^192 wei,
            // which seems implausible.
            revert("MintPass: too large");
        }

        uint256 newNumPurchased = receipt.numPurchased + count;
        receipt.numPurchased = uint64(newNumPurchased);
        if (receipt.numPurchased != newNumPurchased) {
            // Truncation here would require purchasing 2^64 passes, which
            // would likely cause out-of-gas errors anyway.
            revert("MintPass: too large");
        }

        (bool ok, uint256 priceTotal) = SafeMath.tryMul(
            priceEach,
            receipt.numPurchased
        );
        if (!ok || receipt.netPaid < priceTotal) revert("MintPass: underpaid");

        receipts_[msg.sender] = receipt;

        emit MintPassPurchase(msg.sender, msg.value, count);
        return
            _createMintPasses({
                recipient: msg.sender,
                count: count,
                isPurchase: true
            });
    }

    /// Creates one or more mint passes outside of the auction process, at no
    /// cost. Returns the first token ID.
    function reserve(address recipient, uint256 count)
        external
        onlyOwner
        returns (uint256)
    {
        return
            _createMintPasses({
                recipient: recipient,
                count: count,
                isPurchase: false
            });
    }

    /// Computes the rebate that `buyer` is currently entitled to, and returns
    /// that amount along with the value that should be stored into
    /// `receipts_[buyer]` if they claim it.
    function _computeRebate(address buyer)
        internal
        view
        returns (uint256 rebate, Receipt memory receipt)
    {
        receipt = receipts_[buyer];
        uint256 clearingCost = currentPrice() * receipt.numPurchased;
        rebate = receipt.netPaid - clearingCost;
        // This truncation should be lossless because `clearingCost` is
        // strictly less than the prior value of `receipt.netPaid`.
        receipt.netPaid = uint192(clearingCost);
    }

    /// Gets the amount that `buyer` would currently receive if they called
    /// `claimRebate()`.
    function rebateAmount(address buyer) public view returns (uint256) {
        (uint256 rebate, ) = _computeRebate(buyer);
        return rebate;
    }

    /// Claims a rebate equal to the difference between the total amount that
    /// the buyer paid for all their mint passes and the amount that their mint
    /// passes would have cost at the clearing price. The rebate is sent to the
    /// buyer's address; see `claimTo` if this is inconvenient.
    function claimRebate() external {
        claimRebateTo(payable(msg.sender));
    }

    /// Claims a rebate equal to the difference between the total amount that
    /// the buyer paid for all their mint passes and the amount that their mint
    /// passes would have cost at the clearing price.
    function claimRebateTo(address payable recipient) public {
        (uint256 rebate, Receipt memory receipt) = _computeRebate(msg.sender);
        receipts_[msg.sender] = receipt;
        emit RebateClaim(msg.sender, rebate);
        recipient.transfer(rebate);
    }

    /// Withdraws all the auction proceeds. This values each purchased mint
    /// pass at the final clearing price. It can only be called after the
    /// auction has ended, and it can only be called once.
    function withdrawProceeds(address payable recipient) external onlyOwner {
        if (endTimestamp_ == 0) revert("MintPass: auction not ended");
        if (proceedsWithdrawn_) revert("MintPass: already withdrawn");
        proceedsWithdrawn_ = true;
        uint256 proceeds = currentPrice() * supplyStats_.purchased;
        if (proceeds > address(this).balance) {
            // The auction price shouldn't increase, so this shouldn't happen.
            // In case it does, permit rescuing what we can.
            proceeds = address(this).balance;
        }
        emit ProceedsWithdrawal(proceeds);
        recipient.transfer(proceeds);
    }

    /// Gets the current price of a mint pass (in wei). If the auction has
    /// ended, this returns the final clearing price. If the auction has not
    /// started, this returns `type(uint256).max`.
    function currentPrice() public view returns (uint256) {
        uint256 timestamp = block.timestamp;
        uint256 _endTimestamp = endTimestamp_;
        if (_endTimestamp != 0) timestamp = _endTimestamp;
        return schedule_.currentPrice(timestamp);
    }

    /// Returns the price (in wei) that a mint pass would cost at the given
    /// timestamp, according to the auction schedule and under the (possibly
    /// counterfactual) assumption that the auction does not end before it
    /// reaches the reserve price. That is, unlike `currentPrice()`, the result
    /// of this method does not depend on whether or when the auction has
    /// actually ended.
    function priceAt(uint256 timestamp) external view returns (uint256) {
        return schedule_.currentPrice(timestamp);
    }

    /// Sets the address that's permitted to burn mint passes when minting QQL
    /// tokens.
    function setBurner(address _burner) external onlyOwner {
        burner_ = _burner;
    }

    /// Gets the address that's permitted to burn mint passes when minting QQL
    /// tokens.
    function burner() external view returns (address) {
        return burner_;
    }

    /// Burns a mint pass. Intended to be called when minting a QQL token.
    function burn(uint256 tokenId) external {
        if (msg.sender != burner_) revert("MintPass: unauthorized");
        supplyStats_.current--;
        _burn(tokenId);
    }

    /// Checks whether the given address is approved to operate the given mint
    /// pass. Reverts if the mint pass does not exist.
    ///
    /// This is equivalent to calling and combining the results of `ownerOf`,
    /// `getApproved`, and `isApprovedForAll`, but is cheaper because it
    /// requires fewer message calls.
    function isApprovedOrOwner(address operator, uint256 tokenId)
        external
        view
        returns (bool)
    {
        return _isApprovedOrOwner(operator, tokenId);
    }

    function getRoyalties(
        uint256 /*unusedTokenId */
    )
        external
        view
        returns (address payable[] memory recipients, uint256[] memory bps)
    {
        recipients = new address payable[](2);
        bps = new uint256[](2);
        recipients[0] = projectRoyaltyRecipient_;
        recipients[1] = platformRoyaltyRecipient_;
        bps[0] = PROJECT_ROYALTY_BPS;
        bps[1] = PLATFORM_ROYALTY_BPS;
    }

    function setProjectRoyaltyRecipient(address payable projectRecipient)
        external
        onlyOwner
    {
        projectRoyaltyRecipient_ = projectRecipient;
        emit ProjectRoyaltyRecipientChanged(projectRecipient);
    }

    function projectRoyaltyRecipient() external view returns (address payable) {
        return projectRoyaltyRecipient_;
    }

    function setPlatformRoyaltyRecipient(address payable platformRecipient)
        external
        onlyOwner
    {
        platformRoyaltyRecipient_ = platformRecipient;
        emit PlatformRoyaltyRecipientChanged(platformRecipient);
    }

    function platformRoyaltyRecipient()
        external
        view
        returns (address payable)
    {
        return platformRoyaltyRecipient_;
    }

    function setTokenUriDelegate(ITokenUriDelegate delegate)
        external
        onlyOwner
    {
        tokenUriDelegate_ = delegate;
    }

    function tokenUriDelegate() external view returns (ITokenUriDelegate) {
        return tokenUriDelegate_;
    }

    function tokenURI(uint256 tokenId)
        public
        view
        override
        returns (string memory)
    {
        if (!_exists(tokenId)) revert("ERC721: invalid token ID");
        ITokenUriDelegate delegate = tokenUriDelegate_;
        if (address(delegate) == address(0)) return "";
        return delegate.tokenURI(tokenId);
    }
}
