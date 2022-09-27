// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

contract InefficientSmartWallet {
    address owner_;
    uint256 deposits_;

    constructor() {
        owner_ = msg.sender;
    }

    receive() external payable {
        deposits_++;
        for (uint256 i = 0; i < 256; i++) {} // burn a bit more gas, for fun
    }

    function withdraw() external payable {
        if (msg.sender != owner_)
            revert("InefficientSmartWallet: unauthorized");
        payable(msg.sender).transfer(address(this).balance);
    }

    function deposits() external view returns (uint256) {
        return deposits_;
    }
}
