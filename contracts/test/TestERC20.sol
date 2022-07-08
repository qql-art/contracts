// SPDX-License-Identifier: Unlicense
pragma solidity ^0.8.0;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";

contract TestERC20 is ERC20 {
    bool reverting_;
    bool silentlyFailing_;

    constructor() ERC20("Test", "TEST") {}

    function setReverting(bool reverting) external {
        reverting_ = reverting;
    }

    function setSilentlyFailing(bool silentlyFailing) external {
        silentlyFailing_ = silentlyFailing;
    }

    function mint(address account, uint256 amount) external {
        _mint(account, amount);
    }

    function burn(address account, uint256 amount) external {
        _burn(account, amount);
    }

    function transfer(address to, uint256 amount)
        public
        virtual
        override
        returns (bool)
    {
        if (reverting_) revert("TestERC20: revert!");
        if (silentlyFailing_) return false;
        return super.transfer(to, amount);
    }

    function transferFrom(
        address from,
        address to,
        uint256 amount
    ) public virtual override returns (bool) {
        if (reverting_) revert("TestERC20: revert!");
        if (silentlyFailing_) return false;
        return super.transferFrom(from, to, amount);
    }
}
