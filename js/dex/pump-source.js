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
  // balanceOf is the public mapping on the contract, and the coin page reads it
  // for "You hold". It was missing from this list, so ethers had no such method:
  // the read threw and the whole Promise.all in refresh() died — taking the
  // price, market cap and graduation bar with it, because they shared one read.
  'function balanceOf(address owner) view returns (uint256)',
  'function graduated() view returns (bool)',
  'function buy(uint256 minTokensOut) payable returns (uint256)',
  'function sell(uint256 tokensIn, uint256 minEthOut) returns (uint256)',
  'function claimFees() returns (uint256)',
  'function withdraw() returns (uint256)',
  'function totalFeesCreator() view returns (uint256)',
  'function getPrice() view returns (uint256)',
  'event Bought(address indexed buyer, uint256 ethIn, uint256 tokensOut, uint256 fee)',
  'event Sold(address indexed seller, uint256 tokensIn, uint256 ethOut, uint256 fee)',
  'event Graduated(uint256 realEthReserve)',
  'event FeesClaimed(address indexed creator, uint256 amount)',
  'event Withdrawn(address indexed creator, uint256 amount)',
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
    // MUST match curve.js GRADUATION_ETH, or the progress bar the UI draws and
    // the threshold the chain enforces disagree (it did: 0.015 here vs 2 ETH
    // there, so the token graduated long before the UI said it would).
    uint256 public constant GRADUATION_ETH = 2 ether;

    // Where the protocol's share of every trade goes. Immutable so it cannot be
    // redirected after deploy; falls back to the creator (they then hold both
    // shares) if the deployer left it unset.
    address public immutable protocolWallet;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Bought(address indexed buyer, uint256 ethIn, uint256 tokensOut, uint256 fee);
    event Sold(address indexed seller, uint256 tokensIn, uint256 ethOut, uint256 fee);
    event Graduated(uint256 realEthReserve);
    event FeesClaimed(address indexed creator, uint256 amount);
    event Withdrawn(address indexed creator, uint256 amount);

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
        protocolWallet = msg.sender;
    }

    function totalSupply() public view returns (uint256) { return virtualTokens; }

    function getPrice() public view returns (uint256) {
        // wei of ETH per one whole token, scaled by 1e18 for display math
        return (virtualEth * 1e18) / virtualTokens;
    }

    // On a buy the recipient starts at zero, so the tokens are MINTED into
    // their balance, never transferred out of it. The old helper required
    // balanceOf[to] >= amt, which made every single buy() revert with "balance"
    // — the curve was untestable because it could never be bought. (Found by
    // tests/dex-pump-e2e.mjs: deploy succeeded, the first buy reverted.)
    function _mintTo(address to, uint256 amt) internal {
        balanceOf[to] += amt;
        emit Transfer(address(0), to, amt);
    }

    mapping(address => uint256) public balanceOf;

    // minTokensOut is the buyer's floor, and it is ENFORCED HERE, on chain.
    //
    // The screen quotes a price, the user signs, and the transaction sits in the
    // mempool where anyone can move the curve before it mines. A quote that is
    // only advisory is a price the user cannot rely on: the old buy() took no
    // argument, so the app computed a 1% slippage floor, displayed it, and then
    // never passed it — a protection that existed only on screen. require() is
    // the only thing that makes it real; if the curve moved too far the trade
    // reverts and the user keeps their ETH instead of silently receiving less.
    function buy(uint256 minTokensOut) external payable returns (uint256 tokensOut) {
        require(!graduated, "graduated");
        require(msg.value > 0, "zero");
        uint256 fee = (msg.value * FEE_BPS) / 10000;
        uint256 net = msg.value - fee;
        realEthReserve += msg.value;
        // floor the OUTPUT so the rounding dust stays in the pool (k only grows)
        tokensOut = (virtualTokens * net) / (virtualEth + net);
        require(tokensOut > 0, "dust");
        // The floor is checked BEFORE any state moves, so a failed slippage
        // leaves the curve exactly as it was and costs the buyer only gas.
        require(tokensOut >= minTokensOut, "slippage");
        virtualEth += net;
        virtualTokens -= tokensOut;
        // Split the fee into the two buckets that can actually leave the
        // contract. The protocol's share is paid OUT to the protocol wallet
        // every buy; the creator's share accrues to totalFeesCreator for an
        // explicit claimFees() — before, both sat here forever and the
        // creator's revenue was unreachable.
        uint256 creatorFee = (fee * CREATOR_FEE_BPS) / FEE_BPS;
        totalFeesCreator += creatorFee;
        uint256 protocolFee = fee - creatorFee;
        realEthReserve -= protocolFee;
        if (protocolFee > 0) {
            (bool ok, ) = payable(protocolWallet).call{value: protocolFee}("");
            require(ok, "protocol");
        }
        _mintTo(msg.sender, tokensOut);
        if (realEthReserve >= GRADUATION_ETH) {
            graduated = true;
            emit Graduated(realEthReserve);
        }
        emit Bought(msg.sender, msg.value, tokensOut, fee);
    }

    // minEthOut is the seller's floor, enforced for the same reason buy() has
    // one: between the quote and the mining the curve can move against you.
    function sell(uint256 tokensIn, uint256 minEthOut) external returns (uint256 ethOut) {
        require(!graduated, "graduated");
        require(tokensIn > 0, "zero");
        require(balanceOf[msg.sender] >= tokensIn, "balance");
        uint256 netTokens = tokensIn;
        ethOut = (virtualEth * netTokens) / (virtualTokens + netTokens);
        uint256 fee = (ethOut * FEE_BPS) / 10000;
        ethOut -= fee;
        require(ethOut > 0, "dust");
        require(ethOut >= minEthOut, "slippage");
        virtualTokens += netTokens;
        virtualEth -= ethOut;
        uint256 creatorFee = (fee * CREATOR_FEE_BPS) / FEE_BPS;
        totalFeesCreator += creatorFee;
        uint256 protocolFee = fee - creatorFee;
        // The reserve must fall by exactly what LEFT the contract, which on a
        // sell is the payout AND the protocol's share. It used to fall by the
        // payout alone, so realEthReserve crept ABOVE the ETH actually held —
        // one protocol-fee per sell. That is not a cosmetic number: claimFees
        // subtracts the accrued fee from this same reserve, so once the drift
        // passed the real balance that subtraction underflowed, claimFees
        // reverted, and the creator could never withdraw their revenue again.
        // buy() already subtracted its protocol share; this makes sell symmetric.
        realEthReserve -= ethOut + protocolFee;
        if (protocolFee > 0) {
            (bool ok, ) = payable(protocolWallet).call{value: protocolFee}("");
            require(ok, "protocol");
        }
        balanceOf[msg.sender] -= tokensIn;
        (bool ok, ) = payable(msg.sender).call{value: ethOut}("");
        require(ok, "send");
        emit Sold(msg.sender, tokensIn, ethOut, fee);
    }

    // Creator pulls the fees that accrued to it. Before this existed the
    // creator's cut was counted but unreachable — money locked in the contract
    // forever (user: the Dex had to be "lengkap dan matang").
    function claimFees() external returns (uint256) {
        require(msg.sender == creator, "creator");
        uint256 amount = totalFeesCreator;
        require(amount > 0, "none");
        totalFeesCreator = 0;
        realEthReserve -= amount;
        (bool ok, ) = payable(msg.sender).call{value: amount}("");
        require(ok, "send");
        emit FeesClaimed(msg.sender, amount);
        return amount;
    }

    // The ETH the curve holds that belongs to no virtual reserve (the real
    // backing). Graduation is a signal, not a trapdoor: the holder decides when
    // to move it to a Uniswap V2 pool instead of the curve freezing forever.
    function withdraw() external returns (uint256) {
        require(msg.sender == creator, "creator");
        require(graduated, "not graduated");
        uint256 amount = address(this).balance;
        require(amount > 0, "none");
        realEthReserve = 0;
        (bool ok, ) = payable(msg.sender).call{value: amount}("");
        require(ok, "send");
        emit Withdrawn(msg.sender, amount);
        return amount;
    }

    receive() external payable { revert("use buy"); }
}
`;
