// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;
contract Faucet {
    uint256 public drip = 1000 gwei;   // per drip; 1 gwei = 1 sat here (a bare 1000 would be 1000 wei, a millionth of a sat)
    uint256 public interval = 600;     // seconds between drips per address
    mapping(address => uint256) public last;
    event Drip(address indexed to, uint256 amount);
    receive() external payable {}      // anyone can top it up by sending value
    function ask() external {
        require(block.timestamp >= last[msg.sender] + interval, "wait");
        require(address(this).balance >= drip, "dry");
        last[msg.sender] = block.timestamp;
        payable(msg.sender).transfer(drip);
        emit Drip(msg.sender, drip);
    }
}
