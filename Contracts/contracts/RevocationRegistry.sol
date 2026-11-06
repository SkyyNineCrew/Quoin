// SPDX-License-Identifier: MIT
pragma solidity ^0.8.17;

import "@openzeppelin/contracts/access/Ownable.sol";

/// @notice Optimized on-chain revocation registry for credentials.
/// @dev Uses bitmap packing to store 256 revocation statuses per storage slot.
///      Supports optional per-token revocation expiry (time-based revocation).
///      Revocation records include timestamp and reason for full auditability.
contract RevocationRegistry is Ownable {
    // tokenContract => bucketIndex => bitmap (256 tokens per slot)
    // bucketIndex = tokenId / 256, bit position = tokenId % 256
    mapping(address => mapping(uint256 => uint256)) private _revokedBitmap;

    // tokenContract => tokenId => expiry timestamp (0 = no expiry / permanent)
    mapping(address => mapping(uint256 => uint256)) public revocationExpiry;

    // tokenContract => tokenId => revocation timestamp (0 = not revoked)
    mapping(address => mapping(uint256 => uint256)) public revocationTimestamp;

    // tokenContract => tokenId => revocation reason
    mapping(address => mapping(uint256 => string)) public revocationReason;

    // Cached count of revoked tokens per contract. Kept exactly in sync with
    // the number of set bits in `_revokedBitmap`.
    mapping(address => uint256) public revokedCount;

    event RevocationSet(
        address indexed tokenContract,
        uint256 indexed tokenId,
        bool revoked,
        uint256 expiry
    );
    event RevocationSetWithReason(
        address indexed tokenContract,
        uint256 indexed tokenId,
        bool revoked,
        uint256 expiry,
        uint256 timestamp,
        string reason
    );
    event RevocationBatchSet(
        address indexed tokenContract,
        uint256 indexed fromTokenId,
        uint256 count,
        uint256 expiry
    );
    event RevocationBatchCleared(address indexed tokenContract, uint256 count);

    // ── Single operations ─────────────────────────────────────────────

    /// @dev Set revocation status for a single token (permanent revocation).
    function setRevoked(address tokenContract, uint256 tokenId, bool isTokenRevoked) external onlyOwner {
        _setRevoked(tokenContract, tokenId, isTokenRevoked, 0, "");
    }

    /// @dev Set revocation with a specific reason and timestamp tracking.
    function setRevokedWithReason(
        address tokenContract,
        uint256 tokenId,
        bool isTokenRevoked,
        string memory reason
    ) external onlyOwner {
        _setRevoked(tokenContract, tokenId, isTokenRevoked, 0, reason);
    }

    /// @dev Set revocation with an expiry timestamp.
    ///      Once `expiry` passes the token is automatically considered un-revoked.
    function setRevokedWithExpiry(
        address tokenContract,
        uint256 tokenId,
        bool isTokenRevoked,
        uint256 expiry
    ) external onlyOwner {
        _setRevoked(tokenContract, tokenId, isTokenRevoked, expiry, "");
    }

    /// @dev Set revocation with expiry and reason.
    function setRevokedWithExpiryAndReason(
        address tokenContract,
        uint256 tokenId,
        bool isTokenRevoked,
        uint256 expiry,
        string memory reason
    ) external onlyOwner {
        _setRevoked(tokenContract, tokenId, isTokenRevoked, expiry, reason);
    }

    // ── Batch operations ──────────────────────────────────────────────

    /// @dev Batch set revocation status for multiple tokens (permanent).
    function batchSetRevoked(
        address tokenContract,
        uint256[] calldata tokenIds,
        bool[] calldata isTokenRevoked
    ) external onlyOwner {
        require(tokenIds.length == isTokenRevoked.length, "array length mismatch");
        for (uint256 i = 0; i < tokenIds.length; ) {
            _setRevoked(tokenContract, tokenIds[i], isTokenRevoked[i], 0, "");
            unchecked { ++i; }
        }
    }

    /// @dev Batch set revocation with per-token expiry.
    function batchSetRevokedWithExpiry(
        address tokenContract,
        uint256[] calldata tokenIds,
        bool[] calldata isTokenRevoked,
        uint256[] calldata expiries
    ) external onlyOwner {
        require(tokenIds.length == isTokenRevoked.length, "array length mismatch");
        require(tokenIds.length == expiries.length, "expiry array length mismatch");
        for (uint256 i = 0; i < tokenIds.length; ) {
            _setRevoked(tokenContract, tokenIds[i], isTokenRevoked[i], expiries[i], "");
            unchecked { ++i; }
        }
    }

    /// @dev Batch set revocation for a contiguous range of tokens (permanent).
    function batchSetRevokedInRange(
        address tokenContract,
        uint256 fromTokenId,
        uint256 toTokenId,
        bool isTokenRevoked
    ) external onlyOwner {
        require(fromTokenId <= toTokenId, "invalid range");
        uint256 count = 0;
        for (uint256 i = fromTokenId; i <= toTokenId; ) {
            _setRevoked(tokenContract, i, isTokenRevoked, 0, "");
            unchecked { ++i; ++count; }
        }
        if (isTokenRevoked) {
            emit RevocationBatchSet(tokenContract, fromTokenId, count, 0);
        }
    }

    /// @dev Batch set revocation for a contiguous range with a shared expiry.
    function batchSetRevokedInRangeWithExpiry(
        address tokenContract,
        uint256 fromTokenId,
        uint256 toTokenId,
        bool isTokenRevoked,
        uint256 expiry
    ) external onlyOwner {
        require(fromTokenId <= toTokenId, "invalid range");
        uint256 count = 0;
        for (uint256 i = fromTokenId; i <= toTokenId; ) {
            _setRevoked(tokenContract, i, isTokenRevoked, expiry, "");
            unchecked { ++i; ++count; }
        }
        if (isTokenRevoked) {
            emit RevocationBatchSet(tokenContract, fromTokenId, count, expiry);
        }
    }

    /// @dev Convenience: revoke multiple tokens in one call.
    function batchRevoke(address tokenContract, uint256[] calldata tokenIds) external onlyOwner {
        for (uint256 i = 0; i < tokenIds.length; ) {
            _setRevoked(tokenContract, tokenIds[i], true, 0, "");
            unchecked { ++i; }
        }
    }

    /// @dev Convenience: revoke multiple tokens with a shared reason.
    function batchRevokeWithReason(
        address tokenContract,
        uint256[] calldata tokenIds,
        string memory reason
    ) external onlyOwner {
        for (uint256 i = 0; i < tokenIds.length; ) {
            _setRevoked(tokenContract, tokenIds[i], true, 0, reason);
            unchecked { ++i; }
        }
    }

    /// @dev Convenience: unrevoke multiple tokens in one call.
    function batchUnrevoke(address tokenContract, uint256[] calldata tokenIds) external onlyOwner {
        for (uint256 i = 0; i < tokenIds.length; ) {
            _setRevoked(tokenContract, tokenIds[i], false, 0, "");
            unchecked { ++i; }
        }
    }

    /// @dev Clear all revocation state for a contract (resets bitmap + count).
    function clearAll(address tokenContract) external onlyOwner {
        uint256 count = revokedCount[tokenContract];
        if (count == 0) return;

        // Walk buckets until every set bit has been cleared. Iterating
        // `count` buckets instead would miss sparse token IDs — revoking token
        // 0 and token 5000 sets two bits in buckets 0 and 19 — and resetting
        // the count would then leave the remaining tokens revoked forever.
        uint256 cleared = 0;
        uint256 bucket = 0;
        while (cleared < count) {
            uint256 current = _revokedBitmap[tokenContract][bucket];
            if (current != 0) {
                _revokedBitmap[tokenContract][bucket] = 0;
                cleared += _countBits(current);
            }
            unchecked { ++bucket; }
        }

        revokedCount[tokenContract] = 0;
        emit RevocationBatchCleared(tokenContract, count);
    }

    // ── Query functions ───────────────────────────────────────────────

    /// @dev Check if a single token is revoked.
    ///      Returns false if the revocation has expired.
    function isRevoked(address tokenContract, uint256 tokenId) public view returns (bool) {
        uint256 bucket = tokenId / 256;
        uint256 bit = tokenId % 256;
        bool bitSet = (_revokedBitmap[tokenContract][bucket] >> bit) & 1 == 1;
        if (!bitSet) return false;
        // Check time-based expiry
        uint256 exp = revocationExpiry[tokenContract][tokenId];
        if (exp != 0 && block.timestamp > exp) return false;
        return true;
    }

    /// @dev Batch check revocation status for multiple tokens.
    function batchIsRevoked(
        address tokenContract,
        uint256[] calldata tokenIds
    ) external view returns (bool[] memory results) {
        results = new bool[](tokenIds.length);
        for (uint256 i = 0; i < tokenIds.length; ) {
            results[i] = isRevoked(tokenContract, tokenIds[i]);
            unchecked { ++i; }
        }
    }

    /// @dev Get revoked bitmap for a given token contract and bucket.
    function getRevokedBitmap(address tokenContract, uint256 bucket) external view returns (uint256) {
        return _revokedBitmap[tokenContract][bucket];
    }

    /// @dev Get the full revocation record: (isRevoked, timestamp, reason, expiry).
    function getRevocationRecord(
        address tokenContract,
        uint256 tokenId
    ) external view returns (bool active, uint256 timestamp, string memory reason, uint256 expiry) {
        return (
            isRevoked(tokenContract, tokenId),
            revocationTimestamp[tokenContract][tokenId],
            revocationReason[tokenContract][tokenId],
            revocationExpiry[tokenContract][tokenId]
        );
    }

    // ── Internal ──────────────────────────────────────────────────────

    function _setRevoked(
        address tokenContract,
        uint256 tokenId,
        bool isTokenRevoked,
        uint256 expiry,
        string memory reason
    ) private {
        uint256 bucket = tokenId / 256;
        uint256 bit = tokenId % 256;
        uint256 mask = 1 << bit;
        uint256 current = _revokedBitmap[tokenContract][bucket];
        bool bitSet = (current >> bit) & 1 == 1;

        uint256 storedExpiry = revocationExpiry[tokenContract][tokenId];
        // A bit whose expiry has passed is still set but no longer in force,
        // so it must not be treated as "already revoked": that made it
        // impossible to revoke such a token again. See {isRevoked}.
        bool currentlyRevoked =
            bitSet && !(storedExpiry != 0 && block.timestamp > storedExpiry);

        if (isTokenRevoked) {
            if (currentlyRevoked) return;

            _revokedBitmap[tokenContract][bucket] = current | mask;
            // Only tokens whose bit was clear are newly revoked: re-applying a
            // revocation over an expired one must not inflate the counter.
            if (!bitSet) {
                revokedCount[tokenContract]++;
            }
            revocationExpiry[tokenContract][tokenId] = expiry;
            revocationTimestamp[tokenContract][tokenId] = block.timestamp;
            if (bytes(reason).length > 0) {
                revocationReason[tokenContract][tokenId] = reason;
            }
            emit RevocationSetWithReason(
                tokenContract, tokenId, true, expiry, block.timestamp, reason
            );
        } else {
            if (!bitSet) return;

            _revokedBitmap[tokenContract][bucket] = current & ~mask;
            revokedCount[tokenContract]--;
            delete revocationExpiry[tokenContract][tokenId];
            delete revocationTimestamp[tokenContract][tokenId];
            delete revocationReason[tokenContract][tokenId];
        }
        emit RevocationSet(tokenContract, tokenId, isTokenRevoked, expiry);
    }

    /// @dev Number of set bits in `x` (Brian Kernighan's method).
    function _countBits(uint256 x) private pure returns (uint256 n) {
        while (x != 0) {
            x &= x - 1;
            unchecked { ++n; }
        }
    }
}
