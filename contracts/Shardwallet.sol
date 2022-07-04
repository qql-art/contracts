// SPDX-License-Identifier: Unlicense
pragma solidity ^0.8.8;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC721/ERC721.sol";

/// @dev
/// An `OptionalUint` is either absent (the default, uninitialized value) or a
/// `uint256` from `0` through `type(uint256).max - 1`, inclusive. Note that an
/// `OptionalUint` cannot represent the max value of a `uint256`.
type OptionalUint is uint256;

/// @dev
/// Operations on `OptionalUint` values.
///
/// This library uses the terms `encode` and decode rather than the more
/// standard `wrap` and `unwrap` to avoid confusion with the built-in methods
/// on the `OptionalUint` user-defined value type.
library OptionalUints {
    OptionalUint internal constant NONE = OptionalUint.wrap(0);

    /// @dev Tests whether the given `OptionalUint` is present. If it is, call
    /// `decode` to get its value.
    function isPresent(OptionalUint ox) internal pure returns (bool) {
        return OptionalUint.unwrap(ox) != 0;
    }

    /// @dev Encodes a `uint256` as an `OptionalUint` that is present with the
    /// given value, which must be at most `type(uint256).max - 1`. It always
    /// holds that `OptionalUints.encode(x).decode() == x`.
    function encode(uint256 x) internal pure returns (OptionalUint) {
        return OptionalUint.wrap(x + 1);
    }

    /// @dev Decodes a `uint256` that is known to be present. If `ox` is not
    /// actually present, execution reverts. See `isPresent`.
    function decode(OptionalUint ox) internal pure returns (uint256 x) {
        return OptionalUint.unwrap(ox) - 1;
    }
}

struct ForgingData {
    uint256[] parents;
    uint256[] childrenSharesMicros;
}

struct SplitRequest {
    uint256 shareMicros;
    address recipient;
}

contract Shardwallet is ERC721 {
    using OptionalUints for OptionalUint;

    uint256 internal constant ONE_MILLION = 1000000;

    uint256 nextTokenId_;
    mapping(uint256 => uint256) shareMicros_;
    mapping(uint256 => uint256) firstSibling_;
    mapping(uint256 => ForgingData) forging_; // keyed by ID of first child
    mapping(IERC20 => mapping(uint256 => OptionalUint)) claimRecord_;

    mapping(IERC20 => uint256) distributed_;

    event Reforging(
        uint256[] parents,
        uint256 firstChildId,
        uint256[] childrenSharesMicros
    );

    event Claim(
        uint256 indexed tokenId,
        IERC20 indexed currency,
        uint256 amount
    );

    constructor() ERC721("", "") {
        nextTokenId_ = 2;
        shareMicros_[1] = ONE_MILLION;
        // (The genesis token doesn't have a `firstSibling_` or `forging_`.)
        _safeMint(msg.sender, 1);
    }

    receive() external payable {}

    function name() public pure override returns (string memory) {
        return "Shardwallet";
    }

    function symbol() public pure override returns (string memory) {
        return "SHARD";
    }

    function reforge(uint256[] memory parents, SplitRequest[] memory splits)
        public
    {
        if (parents.length == 0) {
            // Don't allow arbitrary callers to mint zero-share tokens.
            revert("Shardwallet: no parents");
        }
        uint256 firstChildId = nextTokenId_;
        nextTokenId_ = firstChildId + splits.length;

        uint256 totalShareMicros = 0;
        for (uint256 i = 0; i < parents.length; i++) {
            uint256 parent = parents[i];
            if (!_isApprovedOrOwner(msg.sender, parent)) {
                revert("Shardwallet: unauthorized");
            }
            _burn(parent);
            totalShareMicros += shareMicros_[parent];
        }

        uint256[] memory childrenSharesMicros = new uint256[](splits.length);
        uint256 nextTokenId = firstChildId;
        for (uint256 i = 0; i < splits.length; i++) {
            uint256 micros = splits[i].shareMicros;
            if (micros == 0) {
                revert("Shardwallet: null share");
            }
            if (micros > totalShareMicros) {
                revert("Shardwallet: share too large");
            }
            totalShareMicros -= micros;
            childrenSharesMicros[i] = micros;
            uint256 child = nextTokenId++;
            shareMicros_[child] = micros;
            firstSibling_[child] = firstChildId;
        }
        if (totalShareMicros != 0) {
            revert("Shardwallet: share too small");
        }

        forging_[firstChildId] = ForgingData({
            parents: parents,
            childrenSharesMicros: childrenSharesMicros
        });
        emit Reforging({
            parents: parents,
            firstChildId: firstChildId,
            childrenSharesMicros: childrenSharesMicros
        });

        nextTokenId = firstChildId;
        for (uint256 i = 0; i < splits.length; i++) {
            _safeMint(splits[i].recipient, nextTokenId++);
        }
    }

    function split(uint256 tokenId, SplitRequest[] memory splits) external {
        uint256[] memory parents = new uint256[](1);
        parents[0] = tokenId;
        reforge(parents, splits);
    }

    function merge(uint256[] memory parents) external {
        uint256 shareMicros = 0;
        for (uint256 i = 0; i < parents.length; i++) {
            shareMicros += shareMicros_[parents[i]];
        }
        SplitRequest[] memory splits = new SplitRequest[](1);
        splits[0].recipient = msg.sender;
        splits[0].shareMicros = shareMicros;
        reforge(parents, splits);
    }

    /**
     * Returns the portion of `amount` that should be allocated to the child at
     * `childIndex` among `shares`. When computed for each `childIndex` from
     * `0` through `shares.length - 1`, the results sum to `amount` and are
     * distributed according to `shares` to within 0.5 ulp.
     */
    function splitClaim(
        uint256 amount,
        uint256[] memory shareMicros,
        uint256 childIndex
    ) internal pure returns (uint256) {
        uint256 n = shareMicros.length;
        uint256 totalShare = 0;
        for (uint256 i = 0; i < shareMicros.length; i++) {
            totalShare += shareMicros[i];
        }

        uint256 mainClaimMicros = amount * shareMicros[childIndex];
        uint256 result = mainClaimMicros / totalShare;
        uint256 mainLoss = mainClaimMicros - (result * totalShare);
        if (mainLoss == 0) return result;

        uint256 totalLoss = mainLoss;
        uint256 numOutranking = 0;
        for (uint256 i = 0; i < n; i++) {
            if (i == childIndex) continue;
            uint256 thisClaimMicros = amount * shareMicros[i];
            uint256 thisClaim = thisClaimMicros / totalShare;
            uint256 thisLoss = thisClaimMicros - (thisClaim * totalShare);
            totalLoss += thisLoss;
            if (
                thisLoss > mainLoss || (thisLoss == mainLoss && i > childIndex)
            ) {
                numOutranking++;
            }
        }

        uint256 dust = totalLoss / totalShare; // should be exact
        if (dust * totalShare != totalLoss) revert("Shardwallet: inexact dust");
        if (numOutranking < dust) result++;
        return result;
    }

    function computeClaimed(uint256 tokenId, IERC20 currency)
        public
        returns (uint256)
    {
        {
            OptionalUint cr = claimRecord_[currency][tokenId];
            if (cr.isPresent()) return cr.decode();
        }
        if (tokenId == 1) {
            // Genesis token: no parents, so no claim to inherit. This token
            // can't quite use the normal logic because it has no parents and
            // no forging data, so we special-case it here, and don't bother
            // storing the result.
            return 0;
        }
        if (shareMicros_[tokenId] == 0) {
            // No claim, but do not store, as this token could later be created
            // as a child of a token that *has* claimed.
            return 0;
        }

        uint256 firstSibling = firstSibling_[tokenId];
        ForgingData memory forging = forging_[firstSibling];
        if (tokenId < firstSibling) {
            revert("Shardwallet: child too low");
        }
        uint256 childIndex = tokenId - firstSibling;
        if (childIndex >= forging.childrenSharesMicros.length) {
            revert("Shardwallet: child too high");
        }

        uint256 parentsClaimed = 0;
        for (uint256 i = 0; i < forging.parents.length; i++) {
            uint256 parent = forging.parents[i];
            // Note: potential optimization here if the parent was burned
            // before we first distributed this currency, in which case we can
            // prune the whole tree. But that requires storing more state, so
            // not obvious under which conditions it's a win.
            parentsClaimed += computeClaimed(parent, currency);
        }
        uint256 claimed = splitClaim(
            parentsClaimed,
            forging.childrenSharesMicros,
            childIndex
        );
        claimRecord_[currency][tokenId] = OptionalUints.encode(claimed);
        return claimed;
    }

    function _claimSingleCurrencyTo(
        uint256 tokenId,
        IERC20 currency,
        address payable recipient
    ) internal {
        if (!_isApprovedOrOwner(msg.sender, tokenId)) {
            revert("Shardwallet: unauthorized");
        }
        uint256 shareMicros = shareMicros_[tokenId];

        uint256 balance;
        if (address(currency) == address(0)) {
            balance = address(this).balance;
        } else {
            balance = currency.balanceOf(address(this));
        }
        uint256 distributed = distributed_[currency];
        uint256 received = balance + distributed;

        uint256 entitlement = (received * shareMicros) / ONE_MILLION;
        uint256 priorClaim = computeClaimed(tokenId, currency);
        uint256 amount = 0;
        // `priorClaim` can exceed `entitlement` by up to 1 unit in the
        // aftermath of a split that cannot be wholly divided. (E.g., consider
        // a shard that claims 1 unit of currency and then splits.)
        //
        // `priorClaim` can also exceed `entitlement` if the amount of currency
        // has decreased due to an external actor: e.g., if the currency is an
        // ERC-20 whose admin can unilaterally transfer tokens.
        if (entitlement > priorClaim) {
            amount = entitlement - priorClaim;
            // If balance has decreased due to an external actor, give what we
            // can.
            if (amount > balance) amount = balance;
        }
        emit Claim({tokenId: tokenId, currency: currency, amount: amount});
        if (amount == 0) return;

        uint256 newClaim = priorClaim + amount;
        claimRecord_[currency][tokenId] = OptionalUints.encode(newClaim);
        distributed_[currency] = distributed + amount;
        if (address(currency) == address(0)) {
            recipient.transfer(amount);
        } else {
            if (!currency.transfer(recipient, amount)) {
                revert("Shardwallet: transfer failed");
            }
        }
    }

    function claimTo(
        uint256 tokenId,
        IERC20[] calldata currencies,
        address payable recipient
    ) public {
        for (uint256 i = 0; i < currencies.length; i++) {
            _claimSingleCurrencyTo(tokenId, currencies[i], recipient);
        }
    }

    function claim(uint256 tokenId, IERC20[] calldata currencies) external {
        claimTo(tokenId, currencies, payable(msg.sender));
    }

    function getShareMicros(uint256 tokenId) external view returns (uint256) {
        return shareMicros_[tokenId];
    }
}
