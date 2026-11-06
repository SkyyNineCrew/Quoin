// SPDX-License-Identifier: MIT
pragma solidity ^0.8.17;

import "@openzeppelin/contracts/token/ERC721/IERC721Receiver.sol";

interface ISoulboundCredential {
    function expiration(uint256 tokenId) external view returns (uint64);
}

/// @notice Test-only receiver.
/// @dev Records the credential expiration observed from inside
///      `onERC721Received`, i.e. while `_safeMint` is still executing, so tests
///      can assert that a credential's state is fully initialised before the
///      recipient gains control.
contract CredentialReceiverProbe is IERC721Receiver {
    ISoulboundCredential public immutable credential;

    bool public observed;
    uint64 public observedExpiration;
    uint256 public observedTokenId;

    constructor(address credential_) {
        credential = ISoulboundCredential(credential_);
    }

    function onERC721Received(
        address,
        address,
        uint256 tokenId,
        bytes calldata
    ) external override returns (bytes4) {
        observed = true;
        observedTokenId = tokenId;
        observedExpiration = credential.expiration(tokenId);
        return IERC721Receiver.onERC721Received.selector;
    }
}
