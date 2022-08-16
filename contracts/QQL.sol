// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/token/ERC721/ERC721.sol";

import "./ITokenUriDelegate.sol";
import "./MintPass.sol";

contract QQL is ERC721, Ownable {
    MintPass immutable pass_;
    uint256 nextTokenId_ = 1;
    mapping(uint256 => bytes32) tokenHash_;
    mapping(bytes32 => uint256) tokenHashToId_;
    mapping(uint256 => string) scriptPieces_;
    mapping(uint256 => address payable) tokenRoyaltyRecipient_;
    address payable projectRoyaltyRecipient_;
    ITokenUriDelegate tokenUriDelegate_;

    event TokenRoyaltyRecipientChange(
        uint256 indexed tokenId,
        address indexed newRecipient
    );

    event ProjectRoyaltyRecipientChange(address indexed newRecipient);

    constructor(MintPass pass) ERC721("", "") {
        pass_ = pass;
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

    function mint(uint256 mintPassId, bytes32 hash) external returns (uint256) {
        if (!pass_.isApprovedOrOwner(msg.sender, mintPassId))
            revert("QQL: not pass owner or approved");
        if (bytes20(msg.sender) != bytes20(hash))
            revert("QQL: minter does not match hash");
        if (tokenHashToId_[hash] != 0) revert("QQL: hash already used");

        uint256 tokenId = nextTokenId_++;
        tokenHash_[tokenId] = hash;
        tokenHashToId_[hash] = tokenId;
        tokenRoyaltyRecipient_[tokenId] = payable(msg.sender);
        pass_.burn(mintPassId);
        _safeMint(msg.sender, tokenId);
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
        bps[0] = 500;
        bps[1] = 200;
    }

    /// Returns the hash associated with the given QQL token. Returns
    /// `bytes32(0)` if and only if the token does not exist.
    function tokenHash(uint256 tokenId) external view returns (bytes32) {
        return tokenHash_[tokenId];
    }

    /// Returns the tokenId associated with the given hash. Returns 0 if
    /// and only if no token was ever minted with that hash.
    function tokenHashToId(bytes32 hash) external view returns (uint256) {
        return tokenHashToId_[hash];
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
