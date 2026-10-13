// Bear Tool — js/dex/pump-source.js
//
// The launchpad token contract: a self-contained ERC-20 that trades on its OWN
// bonding curve (constant product over two virtual reserves), exactly the pump.fun
// shape. Kept inside js/dex/ because it exists only for the launchpad.
//
// Mechanics (all on-chain, no off-chain trust):
//  - A virtual reserve pair (VIRTUAL_ETH / VIRTUAL_TOKENS) sets the opening
//    price so early buys don't blow up the first trade.
//  - buy() pays native ETH, gets tokens along the curve; sell() does the reverse.
//  - A 1.25% fee splits 0.30% creator / 0.95% protocol (matches curve.js).
//  - When the REAL ETH reserve crosses GRADUATION_ETH the token "graduates":
//    curve trading shuts and the creator is told to move liquidity to the Dex.
//  - The image is stored as metadata (data URI) so the token has a face, the
//    way a launchpad coin is expected to.
//
// The contract is compiled in the browser by the same solc pipeline deploy.js
// uses (js/solc.js); nothing is deployed until the user signs.

export const PUMP_ABI = [
  'function name() view returns (string)',
  'function symbol() view returns (string)',
  'function decimals() view returns (uint8)',
  'function image() view returns (string)',
  'function description() view returns (string)',
  'function creator() view returns (address)',
  'function virtualEth() view returns (uint256)',
  'function virtualTokens() view returns (uint256)',
  'function realEthReserve() view returns (uint256)',
  'function graduated() view returns (bool)',
  'function buy() payable returns (uint256)',
  'function sell(uint256 tokensIn) returns (uint256)',
  'function getPrice() view returns (uint256)',
  'event Bought(address indexed buyer, uint256 ethIn, uint256 tokensOut, uint256 fee)',
  'event Sold(address indexed seller, uint256 tokensIn, uint256 ethOut, uint256 fee)',
  'event Graduated(uint256 realEthReserve)',
];

export const GRADUATION_ETH_WEI = 15_000_000_000_000_000n; // 0.015 ETH

// Constructor args are appended by the deploy step; this string is the whole
// program. Written for solc 0.8.x, no external imports, no OpenZeppelin —
// it must compile standalone in the browser from one source string.
export const PUMP_TOKEN_SOURCE = `// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

contract PumpToken {
    string public name;
    string public symbol;
    string public image;
    string public description;
    address public immutable creator;
    uint8 public constant decimals = 18;

    uint256 public virtualEth;
    uint256 public virtualTokens;
    uint256 public realEthReserve;
    bool public graduated;
    uint256 public totalFeesCreator;

    uint256 public constant FEE_BPS = 125;        // 1.25%
    uint256 public constant CREATOR_FEE_BPS = 30;  // 0.30%
    uint256 public constant GRADUATION_ETH = 0.015 ether;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Bought(address indexed buyer, uint256 ethIn, uint256 tokensOut, uint256 fee);
    event Sold(address indexed seller, uint256 tokensIn, uint256 ethOut, uint256 fee);
    event Graduated(uint256 realEthReserve);

    constructor(string memory _name, string memory _symbol, string memory _description,
                string memory _image, uint256 _virtualEth, uint256 _virtualTokens) {
        require(bytes(_name).length > 0 && bytes(_name).length <= 32, "name");
        require(bytes(_symbol).length > 0 && bytes(_symbol).length <= 12, "symbol");
        name = _name;
        symbol = _symbol;
        description = _description;
        image = _image;
        creator = msg.sender;
        virtualEth = _virtualEth;
        virtualTokens = _virtualTokens;
    }

    function totalSupply() public view returns (uint256) { return virtualTokens; }

    function getPrice() public view returns (uint256) {
        // wei of ETH per one whole token, scaled by 1e18 for display math
        return (virtualEth * 1e18) / virtualTokens;
    }

    function _transferOut(address to, uint256 amt) internal {
        require(balanceOf[to] >= amt, "balance");
        balanceOf[to] -= amt;
        balanceOf[address(this)] += amt;
        emit Transfer(address(this), to, amt);
    }

    mapping(address => uint256) public balanceOf;

    function buy() external payable returns (uint256 tokensOut) {
        require(!graduated, "graduated");
        require(msg.value > 0, "zero");
        uint256 fee = (msg.value * FEE_BPS) / 10000;
        uint256 net = msg.value - fee;
        realEthReserve += msg.value;
        // floor the OUTPUT so the rounding dust stays in the pool (k only grows)
        tokensOut = (virtualTokens * net) / (virtualEth + net);
        require(tokensOut > 0, "dust");
        virtualEth += net;
        virtualTokens -= tokensOut;
        totalFeesCreator += (fee * CREATOR_FEE_BPS) / FEE_BPS;
        _transferOut(msg.sender, tokensOut);
        if (realEthReserve >= GRADUATION_ETH) {
            graduated = true;
            emit Graduated(realEthReserve);
        }
        emit Bought(msg.sender, msg.value, tokensOut, fee);
    }

    function sell(uint256 tokensIn) external returns (uint256 ethOut) {
        require(!graduated, "graduated");
        require(tokensIn > 0, "zero");
        require(balanceOf[msg.sender] >= tokensIn, "balance");
        uint256 netTokens = tokensIn;
        ethOut = (virtualEth * netTokens) / (virtualTokens + netTokens);
        uint256 fee = (ethOut * FEE_BPS) / 10000;
        ethOut -= fee;
        require(ethOut > 0, "dust");
        virtualTokens += netTokens;
        virtualEth -= ethOut;
        totalFeesCreator += (fee * CREATOR_FEE_BPS) / FEE_BPS;
        balanceOf[msg.sender] -= tokensIn;
        realEthReserve -= ethOut;
        (bool ok, ) = payable(msg.sender).call{value: ethOut}("");
        require(ok, "send");
        emit Sold(msg.sender, tokensIn, ethOut, fee);
    }

    receive() external payable { revert("use buy"); }
}
`;
