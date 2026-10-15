// Bear Tool — js/dex/bear-source.js
// DEX V2 contracts (docs/DEX-V2.md): BearToken, BearPair, BearFactory.
//
// One source string, three artifacts — compiled once. The factory's bytecode
// embeds the token's and the pool's creation code (it `new`s them), so they
// come from ONE compilation and cannot drift apart. js/solc.js's compileContract
// hands back every deployable contract in the file via `contracts`, which is
// exactly what the launch flow needs.
//
// Rules that are properties of the code, not promises in a label:
//   - Native ETH never enters these contracts: receive()/fallback() revert on
//     all three (user order: "coin native eth itu buat gas fee aja only").
//   - One pool per token per factory: pairFor[token] IS the registry.
//   - A launch is atomic: deploy token + pool + seed + optional LP lock in ONE
//     transaction. There is no window where the token exists without a pool.
//   - LP shares owned by a locked address cannot move or burn before `until`.
//   - Swap fee is 0.3% (997/1000) and all of it stays in the pool for the LPs.
//     There is no protocol fee and no creator fee: the lock is the creator's
//     commitment, the pool is the market.
//
// Math parity: js/dex/pool-math.js mirrors getAmountOut / add / remove exactly
// (same floor rule, same fee), and tests assert the JS number equals the chain
// number. A display that floats is a display that lies.

export const BEAR_SOURCE = `// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

interface IErc20 {
    function balanceOf(address owner) external view returns (uint256);
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function approve(address spender, uint256 amount) external returns (bool);
    function allowance(address owner, address spender) external view returns (uint256);
}

contract BearToken {
    string public name;
    string public symbol;
    uint8 public constant decimals = 18;
    uint256 public totalSupply;
    string public image;
    string public description;

    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);

    constructor(
        string memory name_,
        string memory symbol_,
        string memory image_,
        string memory description_,
        uint256 supply
    ) {
        require(supply > 0, "supply");
        name = name_;
        symbol = symbol_;
        image = image_;
        description = description_;
        totalSupply = supply;
        balanceOf[msg.sender] = supply;
        emit Transfer(address(0), msg.sender, supply);
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        _move(msg.sender, to, amount);
        return true;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        emit Approval(msg.sender, spender, amount);
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        uint256 a = allowance[from][msg.sender];
        if (a != type(uint256).max) {
            require(a >= amount, "allowance");
            allowance[from][msg.sender] = a - amount;
        }
        _move(from, to, amount);
        return true;
    }

    function _move(address from, address to, uint256 amount) internal {
        require(to != address(0), "zero");
        uint256 b = balanceOf[from];
        require(b >= amount, "balance");
        unchecked { balanceOf[from] = b - amount; }
        balanceOf[to] += amount;
        emit Transfer(from, to, amount);
    }

    receive() external payable { revert("gas only"); }
    fallback() external { revert("gas only"); }
}

contract BearPair {
    IErc20 public immutable quote;
    IErc20 public immutable token;
    address public immutable factory;

    string public name;
    string public symbol;
    uint8 public constant decimals = 18;
    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    mapping(address => uint256) public lockedUntil;

    bool public initialized;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);
    event Mint(address indexed provider, uint256 quoteIn, uint256 tokenIn, uint256 shares);
    event Burn(address indexed provider, uint256 quoteOut, uint256 tokenOut, uint256 shares);
    event Swap(address indexed trader, bool quoteIn, uint256 amountIn, uint256 amountOut);
    event Lock(address indexed owner, uint256 until);

    uint256 private unlocked = 1;
    modifier nonReentrant() {
        require(unlocked == 1, "reentrant");
        unlocked = 2;
        _;
        unlocked = 1;
    }

    constructor(address token_, address quote_, address factory_) {
        require(token_ != address(0) && quote_ != address(0) && token_ != quote_, "addr");
        token = IErc20(token_);
        quote = IErc20(quote_);
        factory = factory_;
        name = "Bear LP";
        symbol = "BLP";
    }

    function reserves() external view returns (uint256 quoteReserve, uint256 tokenReserve) {
        return (quote.balanceOf(address(this)), token.balanceOf(address(this)));
    }

    // The launch seed. Factory-only, once: the factory has already moved the
    // quote and token side into this pair, so shares are minted from the real
    // balances (sqrt), then the creator's shares are locked atomically in the
    // same launch transaction. There is no unlocked window to rug.
    function mintInitial(address to, uint256 lockDuration) external nonReentrant {
        require(msg.sender == factory, "factory");
        require(!initialized, "init");
        initialized = true;
        uint256 q = quote.balanceOf(address(this));
        uint256 t = token.balanceOf(address(this));
        require(q > 0 && t > 0, "empty");
        uint256 shares = _sqrt(q * t);
        require(shares > 0, "shares");
        _mint(to, shares);
        if (lockDuration > 0) _lockTo(to, lockDuration);
    }

    // Post-launch liquidity. ts == 0 can only happen if every LP drained the
    // pool: seeding starts again from sqrt so the pair is never bricked.
    function addLiquidity(uint256 quoteIn, uint256 tokenIn, uint256 minShares)
        external
        nonReentrant
        returns (uint256 shares)
    {
        uint256 ts = totalSupply;
        if (ts == 0) {
            _pullTo(address(quote), msg.sender, address(this), quoteIn);
            _pullTo(address(token), msg.sender, address(this), tokenIn);
            shares = _sqrt(quoteIn * tokenIn);
        } else {
            uint256 qb = quote.balanceOf(address(this));
            uint256 tb = token.balanceOf(address(this));
            require(qb > 0 && tb > 0, "empty");
            _pullTo(address(quote), msg.sender, address(this), quoteIn);
            _pullTo(address(token), msg.sender, address(this), tokenIn);
            uint256 s1 = quoteIn * ts / qb;
            uint256 s2 = tokenIn * ts / tb;
            shares = s1 < s2 ? s1 : s2;
        }
        require(shares > 0 && shares >= minShares, "shares");
        _mint(msg.sender, shares);
        emit Mint(msg.sender, quoteIn, tokenIn, shares);
    }

    function removeLiquidity(uint256 shares, uint256 minQuote, uint256 minToken)
        external
        nonReentrant
        returns (uint256 quoteOut, uint256 tokenOut)
    {
        require(lockedUntil[msg.sender] <= block.timestamp, "locked");
        uint256 ts = totalSupply;
        require(shares > 0 && shares <= balanceOf[msg.sender], "shares");
        uint256 qb = quote.balanceOf(address(this));
        uint256 tb = token.balanceOf(address(this));
        quoteOut = shares * qb / ts;
        tokenOut = shares * tb / ts;
        require(quoteOut >= minQuote && tokenOut >= minToken, "min");
        require(quoteOut > 0 && tokenOut > 0, "dust");
        _burn(msg.sender, shares);
        require(quote.transfer(msg.sender, quoteOut), "send");
        require(token.transfer(msg.sender, tokenOut), "send");
        emit Burn(msg.sender, quoteOut, tokenOut, shares);
    }

    function swapQuoteForToken(uint256 amountIn, uint256 minOut)
        external
        nonReentrant
        returns (uint256 amountOut)
    {
        uint256 qb = quote.balanceOf(address(this));
        uint256 tb = token.balanceOf(address(this));
        _pullTo(address(quote), msg.sender, address(this), amountIn);
        amountOut = getAmountOut(amountIn, qb, tb);
        require(amountOut >= minOut, "slippage");
        require(amountOut < tb, "deep");
        require(token.transfer(msg.sender, amountOut), "send");
        _checkK(qb, tb);
        emit Swap(msg.sender, true, amountIn, amountOut);
    }

    function swapTokenForQuote(uint256 amountIn, uint256 minOut)
        external
        nonReentrant
        returns (uint256 amountOut)
    {
        uint256 qb = quote.balanceOf(address(this));
        uint256 tb = token.balanceOf(address(this));
        _pullTo(address(token), msg.sender, address(this), amountIn);
        amountOut = getAmountOut(amountIn, tb, qb);
        require(amountOut >= minOut, "slippage");
        require(amountOut < qb, "deep");
        require(quote.transfer(msg.sender, amountOut), "send");
        _checkK(qb, tb);
        emit Swap(msg.sender, false, amountIn, amountOut);
    }

    function getAmountOut(uint256 amountIn, uint256 reserveIn, uint256 reserveOut)
        public
        pure
        returns (uint256)
    {
        require(amountIn > 0 && reserveIn > 0 && reserveOut > 0, "reserve");
        uint256 inFee = amountIn * 997;
        return inFee * reserveOut / (reserveIn * 1000 + inFee);
    }

    // --- LP token (Bear LP / BLP), with locks ---

    function transfer(address to, uint256 amount) external returns (bool) {
        require(lockedUntil[msg.sender] <= block.timestamp, "locked");
        _moveLp(msg.sender, to, amount);
        return true;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        emit Approval(msg.sender, spender, amount);
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        require(lockedUntil[from] <= block.timestamp, "locked");
        uint256 a = allowance[from][msg.sender];
        if (a != type(uint256).max) {
            require(a >= amount, "allowance");
            allowance[from][msg.sender] = a - amount;
        }
        _moveLp(from, to, amount);
        return true;
    }

    // Lock the sender's shares for duration seconds (or forever with
    // type(uint256).max). Locks only ever extend: a second call can push the
    // date later, never earlier.
    function lockShares(uint256 duration) external {
        _lockTo(msg.sender, duration);
    }

    function _lockTo(address who, uint256 duration) internal {
        uint256 until = duration == type(uint256).max
            ? type(uint256).max
            : block.timestamp + duration;
        if (until > lockedUntil[who]) lockedUntil[who] = until;
        emit Lock(who, lockedUntil[who]);
    }

    function _mint(address to, uint256 amount) internal {
        require(to != address(0), "zero");
        totalSupply += amount;
        balanceOf[to] += amount;
        emit Transfer(address(0), to, amount);
    }

    function _burn(address from, uint256 amount) internal {
        uint256 b = balanceOf[from];
        require(b >= amount, "balance");
        unchecked { balanceOf[from] = b - amount; }
        totalSupply -= amount;
        emit Transfer(from, address(0), amount);
    }

    function _moveLp(address from, address to, uint256 amount) internal {
        require(to != address(0), "zero");
        uint256 b = balanceOf[from];
        require(b >= amount, "balance");
        unchecked { balanceOf[from] = b - amount; }
        balanceOf[to] += amount;
        emit Transfer(from, to, amount);
    }

    // --- internals ---

    // Pull amount and verify the pool actually received it: a token that
    // lies (fee-on-transfer, rebasing) reverts instead of corrupting reserves.
    function _pullTo(address erc, address from, address to, uint256 amount) internal {
        require(amount > 0, "amount");
        uint256 b0 = IErc20(erc).balanceOf(to);
        require(IErc20(erc).transferFrom(from, to, amount), "pull");
        require(IErc20(erc).balanceOf(to) - b0 == amount, "delta");
    }

    // 0.3% fee means k can only grow; floor rounding leaves the dust in the
    // pool too. A swap that would shrink k is a math bug and reverts here.
    function _checkK(uint256 qBefore, uint256 tBefore) internal view {
        require(
            quote.balanceOf(address(this)) * token.balanceOf(address(this)) >= qBefore * tBefore,
            "k"
        );
    }

    function _sqrt(uint256 y) internal pure returns (uint256 z) {
        if (y > 3) {
            z = y;
            uint256 x = y / 2 + 1;
            while (x < z) {
                z = x;
                x = (y / x + x) / 2;
            }
        } else if (y != 0) {
            z = 1;
        }
    }

    receive() external payable { revert("gas only"); }
    fallback() external { revert("gas only"); }
}

contract BearFactory {
    mapping(address => address) public pairFor;

    struct LaunchMeta {
        string name;
        string symbol;
        string image;
        string description;
    }

    event Launched(address indexed creator, address indexed token, address indexed pair, address quote);
    event PoolCreated(address indexed creator, address indexed token, address indexed pair, address quote);

    uint256 private unlocked = 1;
    modifier nonReentrant() {
        require(unlocked == 1, "reentrant");
        unlocked = 2;
        _;
        unlocked = 1;
    }

    function launch(
        LaunchMeta calldata meta,
        uint256 supply,
        address quote_,
        uint256 tokensForPool,
        uint256 quoteForPool,
        uint256 lockDuration
    ) external nonReentrant returns (address token, address pool) {
        require(supply > 0 && tokensForPool > 0 && tokensForPool <= supply && quoteForPool > 0, "seed");
        BearToken t = new BearToken(meta.name, meta.symbol, meta.image, meta.description, supply);
        token = address(t);
        pool = _openPool(token, quote_);
        _pullTo(quote_, msg.sender, pool, quoteForPool);
        require(t.transfer(pool, tokensForPool), "seed");
        if (supply > tokensForPool) require(t.transfer(msg.sender, supply - tokensForPool), "leftover");
        BearPair(payable(pool)).mintInitial(msg.sender, lockDuration);
        emit Launched(msg.sender, token, pool, quote_);
    }

    function createPool(
        address token,
        address quote_,
        uint256 tokensForPool,
        uint256 quoteForPool
    ) external nonReentrant returns (address pool) {
        require(token != address(0), "token");
        require(tokensForPool > 0 && quoteForPool > 0, "seed");
        pool = _openPool(token, quote_);
        _pullTo(quote_, msg.sender, pool, quoteForPool);
        _pullTo(token, msg.sender, pool, tokensForPool);
        BearPair(payable(pool)).mintInitial(msg.sender, 0);
        emit PoolCreated(msg.sender, token, pool, quote_);
    }

    function _openPool(address token, address quote_) internal returns (address pool) {
        require(pairFor[token] == address(0), "exists");
        require(quote_ != address(0) && quote_ != token, "quote");
        pool = address(new BearPair(token, quote_, address(this)));
        pairFor[token] = pool;
    }

    function _pullTo(address erc, address from, address to, uint256 amount) internal {
        require(amount > 0, "amount");
        uint256 b0 = IErc20(erc).balanceOf(to);
        require(IErc20(erc).transferFrom(from, to, amount), "pull");
        require(IErc20(erc).balanceOf(to) - b0 == amount, "delta");
    }

    receive() external payable { revert("gas only"); }
    fallback() external { revert("gas only"); }
}
`;

// Read-side ABIs (human-readable, ethers v6). Deploys use the compiled ABIs
// from compileContract() so the writer side always matches the bytecode.

export const BEAR_TOKEN_ABI = [
  'function name() view returns (string)',
  'function symbol() view returns (string)',
  'function decimals() view returns (uint8)',
  'function totalSupply() view returns (uint256)',
  'function balanceOf(address) view returns (uint256)',
  'function allowance(address, address) view returns (uint256)',
  'function transfer(address, uint256) returns (bool)',
  'function approve(address, uint256) returns (bool)',
  'function transferFrom(address, address, uint256) returns (bool)',
  'function image() view returns (string)',
  'function description() view returns (string)',
  'event Transfer(address indexed from, address indexed to, uint256 value)',
  'event Approval(address indexed owner, address indexed spender, uint256 value)',
];

export const BEAR_PAIR_ABI = [
  'function name() view returns (string)',
  'function symbol() view returns (string)',
  'function decimals() view returns (uint8)',
  'function totalSupply() view returns (uint256)',
  'function balanceOf(address) view returns (uint256)',
  'function allowance(address, address) view returns (uint256)',
  'function approve(address, uint256) returns (bool)',
  'function transfer(address, uint256) returns (bool)',
  'function transferFrom(address, address, uint256) returns (bool)',
  'function quote() view returns (address)',
  'function token() view returns (address)',
  'function factory() view returns (address)',
  'function initialized() view returns (bool)',
  'function lockedUntil(address) view returns (uint256)',
  'function reserves() view returns (uint256, uint256)',
  'function getAmountOut(uint256, uint256, uint256) pure returns (uint256)',
  'function addLiquidity(uint256, uint256, uint256) returns (uint256)',
  'function removeLiquidity(uint256, uint256, uint256) returns (uint256, uint256)',
  'function swapQuoteForToken(uint256, uint256) returns (uint256)',
  'function swapTokenForQuote(uint256, uint256) returns (uint256)',
  'function lockShares(uint256)',
  'event Mint(address indexed provider, uint256 quoteIn, uint256 tokenIn, uint256 shares)',
  'event Burn(address indexed provider, uint256 quoteOut, uint256 tokenOut, uint256 shares)',
  'event Swap(address indexed trader, bool quoteIn, uint256 amountIn, uint256 amountOut)',
  'event Lock(address indexed owner, uint256 until)',
  'event Transfer(address indexed from, address indexed to, uint256 value)',
];

export const BEAR_FACTORY_ABI = [
  'function pairFor(address) view returns (address)',
  'function launch((string,string,string,string), uint256, address, uint256, uint256, uint256) returns (address, address)',
  'function createPool(address, address, uint256, uint256) returns (address)',
  'event Launched(address indexed creator, address indexed token, address indexed pair, address quote)',
  'event PoolCreated(address indexed creator, address indexed token, address indexed pair, address quote)',
];
