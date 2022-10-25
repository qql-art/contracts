// SPDX-License-Identifier: GPL-2.0-only
pragma solidity ^0.8.0;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "../IWeth.sol";

contract TestWeth is ERC20, IWeth {
    bool paused;

    constructor() ERC20("Test ERC20", "T20") {}

    function deposit() external payable override {
        _mint(msg.sender, msg.value);
    }

    function withdraw(uint256 wad) external override {
        _burn(msg.sender, wad);
        payable(msg.sender).transfer(wad);
    }

    function setPaused(bool _paused) public {
        paused = _paused;
    }

    function transfer(address _recipient, uint256 _amount)
        public
        virtual
        override(ERC20, IERC20)
        returns (bool)
    {
        if (paused) return false;
        return ERC20.transfer(_recipient, _amount);
    }

    function transferFrom(
        address _sender,
        address _recipient,
        uint256 _amount
    ) public virtual override(ERC20, IERC20) returns (bool) {
        if (paused) return false;
        return ERC20.transferFrom(_sender, _recipient, _amount);
    }
}
