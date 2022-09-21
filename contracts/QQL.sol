// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/token/ERC721/extensions/ERC721Enumerable.sol";

import "./ERC721TokenUriDelegate.sol";
import "./ERC721OperatorFilter.sol";
import "./MintPass.sol";

contract QQL is
    Ownable,
    ERC721OperatorFilter,
    ERC721TokenUriDelegate,
    ERC721Enumerable
{
    MintPass immutable pass_;
    uint256 nextTokenId_ = 1;
    mapping(uint256 => bytes32) tokenSeed_;
    mapping(bytes32 => uint256) seedToTokenId_;
    mapping(uint256 => string) scriptPieces_;

    /// An artist may permit an external operator (say, a DAO that holds lots
    /// of mint passes) to mint a single seed or any seed on their behalf.
    mapping(bytes32 => address) seedApprovals_;
    mapping(address => mapping(address => bool)) minterApprovals_;

    mapping(uint256 => address payable) tokenRoyaltyRecipient_;
    address payable projectRoyaltyRecipient_;
    uint256 constant PROJECT_ROYALTY_BPS = 500; // 5%
    uint256 constant TOKEN_ROYALTY_BPS = 200; // 2%
    uint256 immutable unlockTimestamp_;
    uint256 immutable maxPremintPassId_;

    event MintApproval(address indexed minter, bytes32 indexed seed);
    event MintApprovalForAll(
        address indexed artist,
        address indexed minter,
        bool approved
    );

    event TokenRoyaltyRecipientChange(
        uint256 indexed tokenId,
        address indexed newRecipient
    );

    event ProjectRoyaltyRecipientChange(address indexed newRecipient);

    constructor(
        MintPass pass,
        uint256 maxPremintPassId,
        uint256 unlockTimestamp
    ) ERC721("", "") {
        pass_ = pass;
        maxPremintPassId_ = maxPremintPassId;
        unlockTimestamp_ = unlockTimestamp;
    }

    function name() public pure override returns (string memory) {
        return "QQL";
    }

    function symbol() public pure override returns (string memory) {
        return "QQL";
    }

    function setScriptPiece(uint256 id, string memory data) external onlyOwner {
        if (bytes(scriptPieces_[id]).length != 0)
            revert("QQL: script pieces are immutable");

        scriptPieces_[id] = data;
    }

    function scriptPiece(uint256 id) external view returns (string memory) {
        return scriptPieces_[id];
    }

    function approveMinter(address minter, bytes32 seed) external {
        if (bytes20(msg.sender) != bytes20(seed))
            revert("QQL: artist does not match seed");
        emit MintApproval(minter, seed);
        seedApprovals_[seed] = minter;
    }

    function approveMinterForAll(address minter, bool approved) external {
        address artist = msg.sender;
        minterApprovals_[artist][minter] = approved;
        emit MintApprovalForAll(msg.sender, minter, approved);
    }

    function getApprovedMinter(bytes32 seed) external view returns (address) {
        return seedApprovals_[seed];
    }

    function isApprovedMinterForAll(address artist, address minter)
        external
        view
        returns (bool)
    {
        return minterApprovals_[artist][minter];
    }

    function _consumeMintApproval(address minter, bytes32 seed)
        internal
        returns (bool)
    {
        address artist = address(bytes20(seed));
        if (artist == minter) return true;
        if (seedApprovals_[seed] == minter) {
            // We're actually minting this, so we can consume the approval
            // record to get a gas refund because the seed can't be used again.
            seedApprovals_[seed] = address(0);
            emit MintApproval(address(0), seed);
            return true;
        }
        if (minterApprovals_[artist][minter]) return true;
        return false;
    }

    function mintTo(uint256 mintPassId, bytes32 seed)
        external
        returns (uint256)
    {
        return _mint(mintPassId, seed, address(bytes20(seed)));
    }

    function mint(uint256 mintPassId, bytes32 seed) external returns (uint256) {
        if (!_consumeMintApproval(msg.sender, seed))
            revert("QQL: minter does not match seed");
        return _mint(mintPassId, seed, msg.sender);
    }

    function _mint(
        uint256 mintPassId,
        bytes32 seed,
        address recipient
    ) internal returns (uint256) {
        if (!pass_.isApprovedOrOwner(msg.sender, mintPassId))
            revert("QQL: not pass owner or approved");
        if (seedToTokenId_[seed] != 0) revert("QQL: seed already used");
        if (
            block.timestamp < unlockTimestamp_ && mintPassId > maxPremintPassId_
        ) revert("QQL: mint pass not yet unlocked");

        uint256 tokenId = nextTokenId_++;
        tokenSeed_[tokenId] = seed;
        seedToTokenId_[seed] = tokenId;
        // Royalty recipient is always the original artist, which may be
        // distinct from the minter (`msg.sender`).
        tokenRoyaltyRecipient_[tokenId] = payable(address(bytes20(seed)));
        pass_.burn(mintPassId);
        _safeMint(recipient, tokenId);
        return tokenId;
    }

    function setProjectRoyaltyRecipient(address payable recipient)
        public
        onlyOwner
    {
        projectRoyaltyRecipient_ = recipient;
        emit ProjectRoyaltyRecipientChange(recipient);
    }

    function projectRoyaltyRecipient() external view returns (address payable) {
        return projectRoyaltyRecipient_;
    }

    function tokenRoyaltyRecipient(uint256 tokenId)
        external
        view
        returns (address)
    {
        return tokenRoyaltyRecipient_[tokenId];
    }

    function parametricArtist(uint256 tokenId) external view returns (address) {
        bytes32 seed = tokenSeed_[tokenId];
        if (seed == bytes32(0)) revert("QQL: token does not exist");
        return address(bytes20(seed));
    }

    function changeTokenRoyaltyRecipient(
        uint256 tokenId,
        address payable newRecipient
    ) external {
        if (tokenRoyaltyRecipient_[tokenId] != msg.sender) {
            revert("QQL: unauthorized");
        }
        if (newRecipient == address(0)) {
            revert("QQL: Can't set zero address as token royalty recipient");
        }
        emit TokenRoyaltyRecipientChange(tokenId, newRecipient);
        tokenRoyaltyRecipient_[tokenId] = newRecipient;
    }

    function getRoyalties(uint256 tokenId)
        external
        view
        returns (address payable[] memory recipients, uint256[] memory bps)
    {
        recipients = new address payable[](2);
        bps = new uint256[](2);
        recipients[0] = projectRoyaltyRecipient_;
        recipients[1] = tokenRoyaltyRecipient_[tokenId];
        if (recipients[1] == address(0)) {
            revert("QQL: royalty for nonexistent token");
        }
        bps[0] = PROJECT_ROYALTY_BPS;
        bps[1] = TOKEN_ROYALTY_BPS;
    }

    /// Returns the seed associated with the given QQL token. Returns
    /// `bytes32(0)` if and only if the token does not exist.
    function tokenSeed(uint256 tokenId) external view returns (bytes32) {
        return tokenSeed_[tokenId];
    }

    /// Returns the tokenId associated with the given seed. Returns 0 if
    /// and only if no token was ever minted with that seed.
    function seedToTokenId(bytes32 seed) external view returns (uint256) {
        return seedToTokenId_[seed];
    }

    function supportsInterface(bytes4 interfaceId)
        public
        view
        virtual
        override(ERC721Enumerable, ERC721)
        returns (bool)
    {
        return super.supportsInterface(interfaceId);
    }

    function _beforeTokenTransfer(
        address from,
        address to,
        uint256 tokenId
    )
        internal
        virtual
        override(ERC721, ERC721Enumerable, ERC721OperatorFilter)
    {
        super._beforeTokenTransfer(from, to, tokenId);
    }

    function tokenURI(uint256 tokenId)
        public
        view
        virtual
        override(ERC721TokenUriDelegate, ERC721)
        returns (string memory)
    {
        return super.tokenURI(tokenId);
    }
}
