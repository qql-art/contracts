// SPDX-License-Identifier: MIT
pragma solidity ^0.8.8;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import "@openzeppelin/contracts/utils/math/SafeMath.sol";

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
///     (d) Each subsequent drop is for `dropGwei` gwei.
///
/// (3) The price never drops below `reserveGwei` gwei.
///
/// For example, suppose that `dropPeriodSeconds` is 60, `startGwei` is 100e9,
/// `dropGwei` is 0.5e9, `[n1, n2, n3]` is `[10, 15, 20]`, and `[c1, c2, c3]`
/// is [8, 4, 2]`. Then: the price starts at 100 ETH, then drops in 4 ETH
/// increments down to 60 ETH, then drops in 2 ETH increments down to 30 ETH,
/// then drops in 1 ETH increments down to 10 ETH, then drops in 0.5 ETH
/// increments down to the reserve price.
///
/// As a special case, if `startTimestamp == 0`, the auction is considered to
/// not be scheduled yet, and the price is `type(uint256).max` at all times.
struct AuctionSchedule {
    uint40 startTimestamp;
    uint24 dropPeriodSeconds;
    uint48 startGwei;
    uint48 dropGwei;
    uint48 reserveGwei;
    uint8 n1;
    uint8 n2;
    uint8 n3;
    uint8 c1;
    uint8 c2;
    uint8 c3;
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
        (drops, priceGwei) = doDrop(inf, drops, priceGwei, dropGwei);

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
/// A record of each buyer's interactions with the auction contract. The
/// buyer's outstanding rebate can be calculated from this receipt combined
/// with the current (or final) clearing price. Specifically, the clearing
/// value of the buyer's mint passes is `clearingPrice * purchaseCount`, and so
/// if `netPaid` is greater than this value then the buyer is entitled to claim
/// the difference.
struct Receipt {
    /// The total amount that the buyer paid for all mint passes that they
    /// purchased, minus the total amount of rebates claimed so far.
    uint192 netPaid;
    /// The total number of mint passes that the buyer purchased. (This does
    /// not count any mint passes created by `reserve`.)
    uint64 purchaseCount;
}

contract MintPass is ERC721, Ownable {
    using ScheduleMath for AuctionSchedule;

    /// The total number of mint passes that have ever been created. This
    /// counts passes created by both `purchase` and `reserve`, and does not
    /// decrease when passes are burned.
    uint256 created_;
    /// The maximum number of mint passes that may ever be created.
    uint256 immutable maxCreated_;
    /// The current number of mint passes.
    uint256 supply_;

    mapping(address => Receipt) receipts_;
    /// The number of mint passes that have been purchased at auction. This
    /// differs from `created_` in that it does not count mint passes created
    /// for free via `reserve`.
    uint256 purchased_;
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

    ITokenUriDelegate tokenUriDelegate_;

    /// Emitted whenever mint passes are purchased at auction. The `priceEach`
    /// field represents the price at the time of purchase, which may be less
    /// than the amount of Ether deposited with the message call. Mint passes
    /// created with `reserve` do not cause this event to be emitted.
    event MintPassPurchase(
        address indexed buyer,
        uint256 priceEach,
        uint256 count
    );

    /// Emitted whenever a buyer claims a rebate. This may happen more than
    /// once per buyer, since rebates can be claimed incrementally as the
    /// auction goes on. The `claimed` amount may be 0 if the price has not
    /// decreased since the last claim.
    event RebateClaim(address indexed buyer, uint256 claimed);

    /// Emitted when the contract owner withdraws the auction proceeds.
    event ProceedsWithdrawal(uint256 amount);

    constructor(uint256 _maxCreated) ERC721("", "") {
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
        return supply_;
    }

    /// Returns the total number of mint passes ever created.
    function totalCreated() external view returns (uint256) {
        return created_;
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
    function _createMintPasses(address recipient, uint256 count)
        internal
        returns (uint256)
    {
        // Can't return a valid new token ID, and, more importantly, don't want
        // to stomp `endTimestamp_` if the auction is already over.
        if (count == 0) revert("MintPass: count is zero");

        uint256 oldCreated = created_;
        uint256 newCreated = oldCreated + count;
        uint256 _maxCreated = maxCreated_;
        if (newCreated > _maxCreated) revert("MintPass: minted out");
        created_ = newCreated;
        supply_ += count;

        if (newCreated == _maxCreated) endTimestamp_ = block.timestamp;

        uint256 firstTokenId = oldCreated + 1;
        uint256 nextTokenId = firstTokenId;
        for (uint256 i = 0; i < count; i++) {
            _safeMint(recipient, nextTokenId++);
        }
        return firstTokenId;
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
        (bool ok, uint256 priceTotal) = SafeMath.tryMul(priceEach, count);
        if (!ok || msg.value < priceTotal) revert("MintPass: underpaid");

        Receipt memory receipt = receipts_[msg.sender];

        uint256 newNetPaid = receipt.netPaid + msg.value;
        receipt.netPaid = uint192(newNetPaid);
        if (receipt.netPaid != newNetPaid) {
            // Truncation here would require cumulative payments of 2^192 wei,
            // which seems implausible.
            revert();
        }

        uint256 newPurchaseCount = receipt.purchaseCount + count;
        receipt.purchaseCount = uint64(newPurchaseCount);
        if (receipt.purchaseCount != newPurchaseCount) {
            // Truncation here would require purchasing 2^64 passes, which
            // seems implausible, and would likely cause out-of-gas errors in
            // the rest of the call anyway.
            revert();
        }

        receipts_[msg.sender] = receipt;

        purchased_ += count;
        emit MintPassPurchase(msg.sender, priceEach, count);

        return _createMintPasses(msg.sender, count);
    }

    /// Creates one or more mint passes outside of the auction process, at no
    /// cost. Returns the first token ID.
    function reserve(address recipient, uint256 count)
        external
        onlyOwner
        returns (uint256)
    {
        return _createMintPasses(recipient, count);
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
        uint256 clearingCost = currentPrice() * receipt.purchaseCount;
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
        uint256 proceeds = currentPrice() * purchased_;
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
        supply_--;
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
