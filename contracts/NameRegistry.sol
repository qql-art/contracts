// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import "@openzeppelin/contracts/utils/cryptography/SignatureChecker.sol";
import "@openzeppelin/contracts/utils/cryptography/draft-EIP712.sol"; // finalized in upcoming release

import "./QQL.sol";

/// A registry for QQL artists to name their pieces and themselves. To prevent
/// abuse (hate speech, etc.), all names must be approved by the holder of
/// QQL #1 or QQL #2.
contract NameRegistry is EIP712 {
    QQL immutable qql_;

    mapping(address => string) artistName_;
    mapping(uint256 => string) tokenName_;

    /// The address currently authorized to sign approval messages on behalf of
    /// the owner of QQL #n is `controller_[n]`. An owner or approved operator
    /// of QQL #n can change this value by calling `setController`.
    mapping(uint256 => address) controller_;

    /// If `approver` has previously signed a message with EIP-712 struct hash
    /// `structHash`, but wants to retract that approval, they can set
    /// `retracted_[approved][structHash]` to `true`.
    mapping(address => mapping(bytes32 => bool)) retracted_;

    event ArtistName(
        address indexed artist,
        string indexed nameHash,
        string name
    );
    event TokenName(
        uint256 indexed tokenId,
        string indexed nameHash,
        string name
    );

    event NewController(uint256 indexed tokenId, address indexed controller);
    event Retraction(
        address indexed approver,
        bytes32 indexed structHash,
        bool retracted
    );

    constructor(QQL qql) EIP712("NameRegistry", "1") {
        qql_ = qql;
    }

    /// Gets the name associated with the given artist. The result is empty if
    /// the name has never been set.
    function artistName(address artist) external view returns (string memory) {
        return artistName_[artist];
    }

    /// Gets the name associated with the given token. The result is empty if
    /// the name has never been set, including the case where the token does
    /// not exist.
    function tokenName(uint256 tokenId) external view returns (string memory) {
        return tokenName_[tokenId];
    }

    /// Given a QQL token ID, gets the name of the token's parametric artist
    /// and the name of the token itself. Either or both outputs may be the
    /// empty string in case no name is set. Reverts if the token does not
    /// exist.
    function artistAndTokenNames(uint256 tokenId)
        external
        view
        returns (string memory _artistName, string memory _tokenName)
    {
        _artistName = artistName_[qql_.parametricArtist(tokenId)];
        _tokenName = tokenName_[tokenId];
    }

    /// Sets the name associated with the calling artist. The `name` can be
    /// empty to clear an existing name. If `name` is non-empty, then approval
    /// from the controller of either QQL #1 or QQL #2 is required.
    function setArtistName(
        string calldata name,
        uint256 approverTokenId,
        bytes memory signature
    ) external {
        bool nameEmpty = bytes(name).length == 0;
        if (!nameEmpty) {
            bytes32 structHash = artistNameApprovalStructHash(msg.sender, name);
            requireApproval(structHash, approverTokenId, signature);
        }
        artistName_[msg.sender] = name;
        emit ArtistName(msg.sender, name, name);
    }

    /// Sets the name associated with the given token. The caller must be the
    /// original parametric artist for the token. The name for a piece can only
    /// be set once; if the existing name is not empty (unset), this call will
    /// revert. Approval from the controller of either QQL #1 or QQL #2 is
    /// required.
    function setTokenName(
        uint256 tokenId,
        string calldata name,
        uint256 approverTokenId,
        bytes memory signature
    ) external {
        if (bytes(tokenName_[tokenId]).length != 0)
            revert("NameRegistry: already set");
        bytes32 structHash = tokenNameApprovalStructHash(tokenId, name);
        requireApproval(structHash, approverTokenId, signature);
        if (msg.sender != qql_.parametricArtist(tokenId))
            revert("NameRegistry: unauthorized");
        tokenName_[tokenId] = name;
        emit TokenName(tokenId, name, name);
    }

    function setController(uint256 tokenId, address controller) external {
        if (!isApproverToken(tokenId))
            revert("NameRegistry: bad approver token");
        if (!isApprovedOrOwnerForQql(msg.sender, tokenId))
            revert("NameRegistry: unauthorized");
        controller_[tokenId] = controller;
        emit NewController(tokenId, controller);
    }

    function getController(uint256 tokenId) external view returns (address) {
        return controller_[tokenId];
    }

    /// Gets the current controllers of both QQL #1 and QQL #2.
    function getControllers() external view returns (address, address) {
        return (controller_[1], controller_[2]);
    }

    /// Retracts or un-retracts the caller's approval of a message with the
    /// given EIP-712 struct hash. Such a struct hash can be computed via the
    /// `artistNameApprovalStructHash` and `tokenNameApprovalStructHash` helper
    /// functions.
    function setApprovalRetraction(bytes32 structHash, bool retracted)
        external
    {
        retracted_[msg.sender][structHash] = retracted;
        emit Retraction(msg.sender, structHash, retracted);
    }

    function isApprovalRetracted(address approver, bytes32 structHash)
        external
        view
        returns (bool)
    {
        return retracted_[approver][structHash];
    }

    /// Tests whether the given QQL token ID confers name approval privileges
    /// on its bearer.
    function isApproverToken(uint256 tokenId) public pure returns (bool) {
        return tokenId == 1 || tokenId == 2;
    }

    function isApprovedOrOwnerForQql(address operator, uint256 tokenId)
        public
        view
        returns (bool)
    {
        address owner = qql_.ownerOf(tokenId);
        if (operator == owner) return true;
        if (qql_.isApprovedForAll(owner, operator)) return true;
        if (qql_.getApproved(tokenId) == operator) return true;
        return false;
    }

    function requireApproval(
        bytes32 structHash,
        uint256 approverTokenId,
        bytes memory signature
    ) internal view {
        if (!isApproverToken(approverTokenId))
            revert("NameRegistry: bad approver token");
        address approver = controller_[approverTokenId];
        if (retracted_[approver][structHash])
            revert("NameRegistry: approval retracted");
        bytes32 digest = _hashTypedDataV4(structHash);
        if (!SignatureChecker.isValidSignatureNow(approver, digest, signature))
            revert("NameRegistry: invalid signature");
    }

    /// Gets the EIP-712 domain separator associated with this contract.
    /// When prompted to sign any name approval message, the presented domain
    /// separator should match the value returned by this function.
    function domainSeparator() external view returns (bytes32) {
        return _domainSeparatorV4();
    }

    /// Computes the struct hash for an artist name approval message.
    /// When prompted to sign such a message, the presented struct hash should
    /// match the value returned by this function.
    function artistNameApprovalStructHash(address artist, string calldata name)
        public
        pure
        returns (bytes32)
    {
        return
            keccak256(
                abi.encode(
                    keccak256("ArtistNameApproval(address artist,string name)"),
                    artist,
                    keccak256(bytes(name))
                )
            );
    }

    /// Computes the struct hash for a token name approval message.
    /// When prompted to sign such a message, the presented struct hash should
    /// match the value returned by this function.
    function tokenNameApprovalStructHash(uint256 tokenId, string calldata name)
        public
        pure
        returns (bytes32)
    {
        return
            keccak256(
                abi.encode(
                    keccak256("TokenNameApproval(uint256 tokenId,string name)"),
                    tokenId,
                    keccak256(bytes(name))
                )
            );
    }
}
