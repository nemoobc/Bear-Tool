// Bear Tool — js/dex/pump-source.js
// The launchpad coin: an ERC-20 that trades on its own bonding curve, quoted in
// one of the Dex's OWN coins.
//
// WHY THE CURVE IS QUOTED IN AN ERC-20, NOT NATIVE ETH
// User order: "coin native eth itu buat gas fee aja only, yang ku kasih 3
// contract erc jadiin coin nativenya". So Sepolia ETH pays gas and nothing else,
// and the curve is denominated in one of the three contracts that were deployed
// as the Dex's coins. This is why buy() has no msg.value and why receive()
// reverts: there is no path by which native ETH can enter this contract, so
// "gas only" is a property of the code rather than a promise in a label.
//
// One quote per curve, chosen at launch. Two quotes would mean two prices for
// the same token — which is not a feature, it is an ambiguity — so the coin
// page shows the quote it trades in and the choice happens on the launch form.
//
// The maths is unchanged from the native-ETH version (see curve.js, which
// imports nothing from here and is the single source for the numbers): same
// constant-product curve, same fee split, same graduation threshold, same
// floor-the-output rule.
export const PUMP_TOKEN_SOURCE = `// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

interface IERC20 {
    // Solidity >=0.5 requires an explicit visibility on interface members; the
    // first draft omitted it and the contract would not compile at all.
    function balanceOf(address owner) external view returns (uint256);
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function allowance(address owner, address spender) external view returns (uint256);
    function approve(address spender, uint256 amount) external returns (bool);
    function decimals() external view returns (uint8);
}

contract PumpToken {
    string public name;
    string public symbol;
    string public image;
    string public description;
    address public immutable creator;
    uint8 public constant decimals = 18;

    // The coin this curve is priced and paid in. Immutable: a curve that could
    // be re-quoted after launch would have had its price change under the people
    // holding it.
    address public immutable quoteToken;
    uint8 public immutable quoteDecimals;

    uint256 public virtualQuote;
    uint256 public virtualTokens;
    uint256 public realQuoteReserve;
    bool public graduated;
    uint256 public totalFeesCreator;

    uint256 public constant FEE_BPS = 125;        // 1.25%
    uint256 public constant CREATOR_FEE_BPS = 30;  // 0.30%
    // MUST match curve.js GRADUATION_QUOTE, or the progress bar the UI draws and
    // the threshold the chain enforces disagree.
    uint256 public constant GRADUATION_QUOTE = 2 ether;

    address public immutable protocolWallet;

    // ERC-20 calls back into the contract (a malicious token can), so every
    // state-changing entry point is guarded. Without it the fee payout and the
    // buy's own transfers could re-enter before the reserves were updated.
    uint256 private _entered = 1;
    modifier nonReentrant() {
        require(_entered == 1, "locked");
        _entered = 2;
        _;
        _entered = 1;
    }

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Launched(address indexed creator, address indexed token, string name, string symbol);
    event Bought(address indexed buyer, uint256 quoteIn, uint256 tokensOut, uint256 fee);
    event Sold(address indexed seller, uint256 tokensIn, uint256 quoteOut, uint256 fee);
    event Graduated(uint256 realQuoteReserve);
    event FeesClaimed(address indexed creator, uint256 amount);
    event Withdrawn(address indexed creator, uint256 amount);
    event LiquidityAdded(address indexed provider, uint256 quoteIn, uint256 shares);
    event LiquidityRemoved(address indexed provider, uint256 quoteOut, uint256 shares);

    constructor(string memory _name, string memory _symbol, string memory _description,
                string memory _image, address _quoteToken,
                uint256 _virtualQuote, uint256 _virtualTokens) {
        require(bytes(_name).length > 0 && bytes(_name).length <= 32, "name");
        require(bytes(_symbol).length > 0 && bytes(_symbol).length <= 12, "symbol");
        // A curve quoted in nothing, or in itself, is not a curve. Both are
        // refused here rather than producing a coin nobody can trade.
        require(_quoteToken != address(0), "quote");
        require(_quoteToken != address(this), "self quote");
        name = _name;
        symbol = _symbol;
        description = _description;
        image = _image;
        creator = msg.sender;
        quoteToken = _quoteToken;
        quoteDecimals = IERC20(_quoteToken).decimals();
        virtualQuote = _virtualQuote;
        virtualTokens = _virtualTokens;
        protocolWallet = msg.sender;
        // One indexed log per coin: what makes the launchpad indexable at all.
        // The image is left out — it is large, and readable from this contract.
        emit Launched(msg.sender, address(this), _name, _symbol);
    }

    mapping(address => uint256) public balanceOf;

    // ── LIQUIDITY ─────────────────────────────────────────────────
    // Adding liquidity here is NOT buying. A buy moves the price curve and mints
    // tokens to you; adding liquidity only DEEPENS the pool's backing — the price
    // does not move and you receive no tokens, you receive a claim on the quote
    // coin the curve holds. That is the difference between being a trader and
    // being a liquidity provider, and conflating them is how a "pool" ends up
    // being a disguised buy that looks like investment.
    //
    // Shares are 1:1 with quote deposited, which is honest for a single-sided
    // pool: one share always means one unit of the quote coin. When more than
    // one provider is in, everyone keeps their exact pro-rata claim, and a
    // provider can always leave with everything they put in plus their share of
    // what trading earned.
    mapping(address => uint256) public lpShares;
    uint256 public totalLpShares;

    function totalSupply() public view returns (uint256) { return virtualTokens; }

    /// Quote the totalLpShares is currently worth: what the pool actually holds,
    /// minus what is owed to nobody (creator fees accrue to the creator and are
    /// withdrawable through claimFees, so they are excluded here).
    function lpValue() public view returns (uint256) {
        return IERC20(quoteToken).balanceOf(address(this)) - totalFeesCreator;
    }

    /// Add backing to the curve without buying any tokens.
    function addLiquidity(uint256 quoteIn) external nonReentrant returns (uint256 shares) {
        require(quoteIn > 0, "zero");
        require(IERC20(quoteToken).allowance(msg.sender, address(this)) >= quoteIn, "approve");
        require(IERC20(quoteToken).transferFrom(msg.sender, address(this), quoteIn), "pull");

        shares = quoteIn;                       // 1:1
        lpShares[msg.sender] += shares;
        totalLpShares += shares;
        realQuoteReserve += quoteIn;
        emit LiquidityAdded(msg.sender, quoteIn, shares);
        return shares;
    }

    /// Take back a share of the pool. Pro-rata against the CURRENT value, so a
    /// provider leaves with their deposit plus their share of the fees the pool
    /// earned while they were in it.
    function removeLiquidity(uint256 shares) external nonReentrant returns (uint256 quoteOut) {
        require(shares > 0, "zero");
        require(lpShares[msg.sender] >= shares, "balance");
        require(totalLpShares > 0, "none");

        // Floor, so rounding can never pay out more than the pool holds and the
        // last withdrawer cannot drain someone else's share to zero.
        quoteOut = (lpValue() * shares) / totalLpShares;
        require(quoteOut > 0, "dust");

        lpShares[msg.sender] -= shares;
        totalLpShares -= shares;
        realQuoteReserve -= quoteOut;
        require(IERC20(quoteToken).transfer(msg.sender, quoteOut), "send");
        emit LiquidityRemoved(msg.sender, quoteOut, shares);
        return quoteOut;
    }

    /// This wallet's position, and what it is worth right now.
    function positionOf(address provider) external view returns (uint256 shares, uint256 value) {
        shares = lpShares[provider];
        value = totalLpShares > 0 ? (lpValue() * shares) / totalLpShares : 0;
    }

    /// Buy with the quote coin. The caller must have approved this contract for
    /// quoteIn first — the UI does that in the same flow, and a purchase that
    /// cannot pull its funds reverts with "approve" instead of failing silently.
    function buy(uint256 quoteIn, uint256 minTokensOut)
        external nonReentrant returns (uint256 tokensOut)
    {
        require(!graduated, "graduated");
        require(quoteIn > 0, "zero");
        require(IERC20(quoteToken).allowance(msg.sender, address(this)) >= quoteIn, "approve");

        uint256 fee = (quoteIn * FEE_BPS) / 10000;
        uint256 net = quoteIn - fee;
        require(IERC20(quoteToken).transferFrom(msg.sender, address(this), quoteIn), "pull");

        realQuoteReserve += quoteIn;
        // floor the OUTPUT so the rounding dust stays in the pool (k only grows)
        tokensOut = (virtualTokens * net) / (virtualQuote + net);
        require(tokensOut > 0, "dust");
        // The floor is checked BEFORE any state moves, so a refused trade leaves
        // the curve exactly as it was and costs the buyer only gas.
        require(tokensOut >= minTokensOut, "slippage");

        virtualQuote += net;
        virtualTokens -= tokensOut;

        // Creator fees accrue here and leave through claimFees(); the protocol
        // share is paid OUT on every trade.
        uint256 creatorFee = (fee * CREATOR_FEE_BPS) / FEE_BPS;
        totalFeesCreator += creatorFee;
        uint256 protocolFee = fee - creatorFee;
        realQuoteReserve -= protocolFee;
        if (protocolFee > 0) {
            require(IERC20(quoteToken).transfer(protocolWallet, protocolFee), "protocol");
        }

        _mintTo(msg.sender, tokensOut);
        if (realQuoteReserve >= GRADUATION_QUOTE) {
            graduated = true;
            emit Graduated(realQuoteReserve);
        }
        emit Bought(msg.sender, quoteIn, tokensOut, fee);
    }

    function sell(uint256 tokensIn, uint256 minQuoteOut)
        external nonReentrant returns (uint256 quoteOut)
    {
        require(!graduated, "graduated");
        require(tokensIn > 0, "zero");
        require(balanceOf[msg.sender] >= tokensIn, "balance");

        quoteOut = (virtualQuote * tokensIn) / (virtualTokens + tokensIn);
        uint256 fee = (quoteOut * FEE_BPS) / 10000;
        quoteOut -= fee;
        require(quoteOut > 0, "dust");
        require(quoteOut >= minQuoteOut, "slippage");

        virtualTokens += tokensIn;
        virtualQuote -= quoteOut;

        uint256 creatorFee = (fee * CREATOR_FEE_BPS) / FEE_BPS;
        totalFeesCreator += creatorFee;
        uint256 protocolFee = fee - creatorFee;
        // The reserve must fall by exactly what LEFT the contract, which on a
        // sell is the payout AND the protocol's share. It used to fall by the
        // payout alone, so realQuoteReserve crept ABOVE the balance actually
        // held — and claimFees() then underflowed and reverted, locking the
        // creator's revenue forever.
        realQuoteReserve -= quoteOut + protocolFee;
        if (protocolFee > 0) {
            require(IERC20(quoteToken).transfer(protocolWallet, protocolFee), "protocol");
        }

        balanceOf[msg.sender] -= tokensIn;
        require(IERC20(quoteToken).transfer(msg.sender, quoteOut), "send");
        emit Sold(msg.sender, tokensIn, quoteOut, fee);
    }

    /// Creator pulls the fees that accrued to it. Fees only — the backing is
    /// the curve's, and taking it here would drain the pool out from under every
    /// buyer still holding tokens.
    function claimFees() external nonReentrant returns (uint256) {
        require(msg.sender == creator, "creator");
        uint256 amount = totalFeesCreator;
        require(amount > 0, "none");
        totalFeesCreator = 0;
        realQuoteReserve -= amount;
        require(IERC20(quoteToken).transfer(msg.sender, amount), "send");
        emit FeesClaimed(msg.sender, amount);
        return amount;
    }

    /// The quote coin the curve holds, once the coin has graduated. Graduation
    /// is a signal, not a trapdoor: the creator decides when to move it on.
    // The creator's exit after graduation is THEIRS ALONE — their accrued fee,
    // never the pool's money. When this paid out the contract's whole balance it
    // looked correct until anyone added liquidity: one deposit and the creator
    // could withdraw every provider's coins and call it a payout. The LP claim is
    // a promise made to strangers, so it is not the creator's to spend.
    function withdraw() external nonReentrant returns (uint256) {
        require(msg.sender == creator, "creator");
        require(graduated, "not graduated");
        uint256 fees = totalFeesCreator;
        require(fees > 0 || totalLpShares == 0, "none");
        // lpValue() is read BEFORE the fee is zeroed. It subtracts the unpaid
        // fees to work out what is actually the pool's — so zeroing first makes
        // it return the whole balance, the fee gets counted twice, and the
        // transfer asks for money the contract does not have. Read, then clear.
        uint256 backing = totalLpShares == 0 ? lpValue() : 0;
        uint256 amount = fees + backing;
        totalFeesCreator = 0;
        realQuoteReserve -= backing;
        require(IERC20(quoteToken).transfer(msg.sender, amount), "send");
        emit Withdrawn(msg.sender, amount);
        return amount;
    }

    // Buy credit is a MINT into the buyer's own balance. The helper this replaced
    // required balanceOf[to] >= amount, which made every single buy revert —
    // a buyer starts at zero.
    function _mintTo(address to, uint256 amt) internal {
        balanceOf[to] += amt;
        emit Transfer(address(0), to, amt);
    }

    // Native ETH is gas only. This contract refuses it outright, so the promise
    // cannot rot into an accident: nothing can be sent here with value.
    receive() external payable { revert("gas only"); }
}
`;

// The human-readable ABI the app calls through. Kept beside the source it
// describes: a function the UI invokes but the ABI omits fails at runtime, in
// the browser, only when a user clicks.
export const PUMP_ABI = [
  'function name() view returns (string)',
  'function symbol() view returns (string)',
  'function decimals() view returns (uint8)',
  'function image() view returns (string)',
  'function description() view returns (string)',
  'function creator() view returns (address)',
  'function quoteToken() view returns (address)',
  'function quoteDecimals() view returns (uint8)',
  'function virtualQuote() view returns (uint256)',
  'function virtualTokens() view returns (uint256)',
  'function realQuoteReserve() view returns (uint256)',
  'function graduated() view returns (bool)',
  'function buy(uint256 quoteIn, uint256 minTokensOut) payable returns (uint256)',
  'function sell(uint256 tokensIn, uint256 minQuoteOut) returns (uint256)',
  'function claimFees() returns (uint256)',
  'function withdraw() returns (uint256)',
  'function totalFeesCreator() view returns (uint256)',
  'function totalSupply() view returns (uint256)',
  'function balanceOf(address owner) view returns (uint256)',
  'function lpShares(address provider) view returns (uint256)',
  'function totalLpShares() view returns (uint256)',
  'function lpValue() view returns (uint256)',
  'function positionOf(address provider) view returns (uint256 shares, uint256 value)',
  'function addLiquidity(uint256 quoteIn) returns (uint256 shares)',
  'function removeLiquidity(uint256 shares) returns (uint256 quoteOut)',
  'event Launched(address indexed creator, address indexed token, string name, string symbol)',
  'event Bought(address indexed buyer, uint256 quoteIn, uint256 tokensOut, uint256 fee)',
  'event Sold(address indexed seller, uint256 tokensIn, uint256 quoteOut, uint256 fee)',
  'event Graduated(uint256 realQuoteReserve)',
  'event FeesClaimed(address indexed creator, uint256 amount)',
  'event Withdrawn(address indexed creator, uint256 amount)',
  'event LiquidityAdded(address indexed provider, uint256 quoteIn, uint256 shares)',
  'event LiquidityRemoved(address indexed provider, uint256 quoteOut, uint256 shares)',
];
