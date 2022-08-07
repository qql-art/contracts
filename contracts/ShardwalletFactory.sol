// SPDX-License-Identifier: MIT
pragma solidity ^0.8.8;

import "./Shardwallet.sol";

contract ShardwalletFactory {
    event ShardwalletCreation(Shardwallet shardwallet, address owner);

    function summon() external returns (Shardwallet) {
        Shardwallet sw = new Shardwallet();
        sw.initialize(msg.sender);
        emit ShardwalletCreation(sw, msg.sender);
        return sw;
    }
}
