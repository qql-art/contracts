// SPDX-License-Identifier: MIT
pragma solidity ^0.8.8;

import "./Shardwallet.sol";

contract ShardwalletFactory {
    event ShardwalletCreation(Shardwallet shardwallet, address owner);

    function summon() external returns (Shardwallet) {
        Shardwallet sw = new Shardwallet();
        sw.transferOwnership(msg.sender);
        sw.safeTransferFrom(address(this), msg.sender, 1);
        emit ShardwalletCreation(sw, msg.sender);
        return sw;
    }
}
