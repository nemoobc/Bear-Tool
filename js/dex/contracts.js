// ═══════════════════════════════════════════════════════════════
// Bear Tool — js/dex/contracts.js (Dex v2)
//
// The whole engine, one file, no imports: three contracts written from zero
// (2026-10-17, user order: "hapus fitur dex, buat lagi dari 0 sampai jadi dan
// matang" — delete the dex, rebuild it from zero until mature). The shape
// carries the spec the user approved for this engine — ONE machine, REAL
// reserves, x*y=k, no bonding curve, no graduation — with the M2 decisions
// spelled out so the UI can never drift from them:
//
//   fee — every swap values the input at 997/1000. The creator's slice is
//   carved out of that 0.3%, never on top of it: the trader always pays
//   exactly 997/1000. The carve exists ONLY on the buy direction (quote →
//   token) and is bookkept in quote units, so totalFeesCreator is one clean
//   currency. LP keeps 0.3% − creatorFeeBps; at creatorFeeBps = 30 the whole
//   stream belongs to the creator and k' ≥ k still holds EXACTLY because of
//   that same cap — the cap is the invariant's binding constraint (proof in
//   the reserve-growth comment on swapQuoteForToken). Never raise it.
//
//   launch — ONE transaction: token + pair + seed + lock + socials happen
//   atomically. The full supply is minted to the factory, which forwards the
//   seed pair-side and hands the remainder to the launcher; the LP shares
//   minted by the pair land with the LAUNCHER, never with the factory.
//
//   LP lock — anti-rug as a first-class feature. A locked address's shares
//   cannot move or burn before its unlock time. Locks only extend.
//
//   native ETH — rejected everywhere. The quote coin is an ERC-20; in this
//   app ETH exists as gas only (the user's standing order, carried over).
//
// Pinned: tests/dex-contracts.test.js (real solc compile + ABI surface,
// offline) and tests/fork/dex-contracts.test.js (behaviour on a real chain:
// launch anatomy, exact swap maths, fee bookkeeping, LP lock.
// Compiled with the app's pinned solc 0.8.37 everywhere.
// ═══════════════════════════════════════════════════════════════

export const DEX_SOLIDITY = `// SPDX-License-Identifier: MIT
pragma solidity ^0.8.37;

interface IERC20 {
    function transfer(address to, uint256 value) external returns (bool);
    function transferFrom(address from, address to, uint256 value) external returns (bool);
    function balanceOf(address owner) external view returns (uint256);
    function approve(address spender, uint256 value) external returns (bool);
}

// ── BearToken ──────────────────────────────────────────────────────────────
// The coin itself. Supply ships COMPLETE at deploy — no mint, no burn, no
// owner with printing powers: everything lives with the factory for exactly
// one transaction, then splits (seed → pair, remainder → launcher).
// Metadata (image, description) is constructor-fixed; socials are written
// exactly once, by the factory, and then never again.
contract BearToken {
    // Tuple params keep the launch frame (which builds the whole pool) within
    // stack limits without via-IR; ABI-wise they are plain tuples.
    struct Meta {
        string name;
        string symbol;
        string image;
        string desc;
    }
    struct Socials {
        string twitter;
        string telegram;
        string website;
    }

    string public name;
    string public symbol;
    string public imageURI;
    string public description;

    string public twitter;
    string public telegram;
    string public website;
    bool public socialsSet;

    uint8 public constant decimals = 18;
    uint256 public totalSupply;
    address public immutable quoteToken;    // the ONE quote this coin trades against
    address public immutable factory;       // launch authority (socials; nothing else)

    mapping(address => uint256) public balances;
    mapping(address => mapping(address => uint256)) public allowances;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);
    event SocialsSet(string twitter, string telegram, string website);

    constructor(
        address factory_,
        Meta memory meta,
        uint256 totalSupply_,
        address quoteToken_
    ) {
        require(totalSupply_ > 0, "BEAR/SUPPLY-ZERO");
        require(quoteToken_ != address(0), "BEAR/QUOTE-ZERO");
        factory = factory_;
        name = meta.name;
        symbol = meta.symbol;
        totalSupply = totalSupply_;
        quoteToken = quoteToken_;
        imageURI = meta.image;
        description = meta.desc;
        balances[factory_] = totalSupply_;
        emit Transfer(address(0), factory_, totalSupply_);
    }

    function setSocials(Socials memory s) external {
        require(msg.sender == factory, "BEAR/SOCIALS-BY-FACTORY");
        require(!socialsSet, "BEAR/SOCIALS-ONCE");
        socialsSet = true;
        twitter = s.twitter;
        telegram = s.telegram;
        website = s.website;
        emit SocialsSet(s.twitter, s.telegram, s.website);
    }

    function balanceOf(address owner) external view returns (uint256) { return balances[owner]; }
    function allowance(address owner, address spender) external view returns (uint256) { return allowances[owner][spender]; }

    function approve(address spender, uint256 value) external returns (bool) {
        allowances[msg.sender][spender] = value;
        emit Approval(msg.sender, spender, value);
        return true;
    }

    function transfer(address to, uint256 value) external returns (bool) {
        _move(msg.sender, to, value);
        return true;
    }

    function transferFrom(address from, address to, uint256 value) external returns (bool) {
        uint256 a = allowances[from][msg.sender];
        if (a != type(uint256).max) {
            require(a >= value, "BEAR/ALLOWANCE");
            allowances[from][msg.sender] = a - value;
        }
        _move(from, to, value);
        return true;
    }

    function _move(address from, address to, uint256 value) internal {
        require(to != address(0), "BEAR/TRANSFER-TO-ZERO");
        uint256 b = balances[from];
        require(b >= value, "BEAR/BALANCE");
        balances[from] = b - value;
        balances[to] += value;
        emit Transfer(from, to, value);
    }
}

// ── BearPair ───────────────────────────────────────────────────────────────
// One pool: token ↔ quote, real reserves, x*y=k. LP shares are themselves a
// minimal ERC-20 (Bear LP / BLP) whose transfers and burns honour the lock
// map. Swaps pull the full amount in, price on 997/1000, and — on the buy
// direction only — carve the creator's slice (≤ 30 bps) out of the pool's
// incoming accounting: the carve never reduces what the curve weighs, so
// the trader's 997/1000 is exact, and the escrow keeps every fee unit inside
// the pool until the creator claims it.
contract BearPair {
    string public constant name = "Bear LP";
    string public constant symbol = "BLP";
    uint8 public constant decimals = 18;

    address public immutable token;         // the traded coin (this pool's subject)
    IERC20 public immutable quote;          // the ONE quote coin
    address public immutable creator;
    address public immutable factory;
    uint256 public immutable creatorFeeBps; // 0..30: basis points of the trade amount carved from LP's fee stream

    uint256 public totalFeesCreator;        // accrued since last claim, quote units
    mapping(address => uint256) public locks; // address → unlock timestamp; 0 = free. Locks only extend.

    uint256 private rQ;                     // quote reserve
    uint256 private rT;                     // token reserve
    uint256 public lastK;                   // product invariant, asserted to grow on every swap

    uint256 public totalSupply;             // LP share supply (ERC-20)
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    uint256 private _entered = 1;

    event Swap(address indexed who, address indexed to, uint256 amountIn, uint256 amountOut, bool quoteIn);
    event LiquidityAdded(address indexed who, uint256 shares);
    event LiquidityRemoved(address indexed who, uint256 shares);
    event Locked(address indexed who, uint64 until);
    event FeesClaimed(address indexed creator, uint256 amount);
    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);

    constructor(address factory_, address token_, IERC20 quote_, address creator_, uint256 creatorFeeBps_) {
        require(token_ != address(0) && creator_ != address(0) && address(quote_) != address(0), "BEAR/PAIR-ZERO");
        require(creatorFeeBps_ <= 30, "BEAR/FEE-CAP");
        factory = factory_;
        token = token_;
        quote = quote_;
        creator = creator_;
        creatorFeeBps = creatorFeeBps_;
    }

    modifier reentrancyGuard() {
        require(_entered == 1, "BEAR/REENTRANT");
        _entered = 0;
        _;
        _entered = 1;
    }

    function reserves() external view returns (uint256 quoteReserve, uint256 tokenReserve) {
        return (rQ, rT);
    }

    // ── pricing ─────────────────────────────────────────────────────────────
    // The view mirrors the executed path exactly. BUY: the creator's carve
    // never shrinks the curve's input (it leaks out of the reserve growth
    // instead), so pricing here and pricing inside swapQuoteForToken are the
    // same arithmetic. SELL: pure classic 997/1000.
    function getAmountOut(bool quoteIn, uint256 amountIn) external view returns (uint256 out) {
        require(amountIn > 0, "BEAR/ZERO-IN");
        uint256 curveIn = amountIn * 997 / 1000;
        require(curveIn > 0, "BEAR/ZERO-EFF");
        uint256 rIn = quoteIn ? rQ : rT;
        uint256 rOut = quoteIn ? rT : rQ;
        require(rIn > 0 && rOut > 0, "BEAR/EMPTY-POOL");
        out = curveIn * rOut / (rIn + curveIn);
    }

    // BUY (quote → token). Order matters: pull, carve-escrow, price from the
    // POST-pull pool, update reserves, verify the invariant, pay the token
    // out. Every step is in one guarded frame.
    function swapQuoteForToken(uint256 amountIn, uint256 minOut, address to) external reentrancyGuard returns (uint256 out) {
        require(amountIn > 0, "BEAR/ZERO-IN");
        require(to != address(0), "BEAR/SWAP-TO-ZERO");
        require(rQ > 0 && rT > 0, "BEAR/EMPTY-POOL");

        quote.transferFrom(msg.sender, address(this), amountIn);
        uint256 carve = amountIn * creatorFeeBps / 10_000;
        out = curveIn(amountIn) * rT / (rQ + curveIn(amountIn));
        require(out > 0, "BEAR/OUT-ZERO");

        uint256 kPrev = uint256(rQ) * uint256(rT);
        // Reserve growth keeps ALL non-escrow value in the pool:
        //   rQ' = rQ + (amountIn − carve)
        // = rQ + (997/1000)·amountIn + (0.3% − carve)  — LP's residual fee.
        rQ = rQ + amountIn - carve;
        rT = rT - out;
        _assertGrown(kPrev);

        totalFeesCreator += carve;
        IERC20(token).transfer(to, out);
        emit Swap(msg.sender, to, amountIn, out, true);
        require(out >= minOut, "BEAR/MIN-OUT");
    }

    // SELL (token → quote). No carve on this side — the creator fee exists
    // only on the quote-receiving direction, so totalFeesCreator stays one
    // currency. The 0.3% stays in the pool for the LPs (classic).
    function swapTokenForQuote(uint256 amountIn, uint256 minOut, address to) external reentrancyGuard returns (uint256 out) {
        require(amountIn > 0, "BEAR/ZERO-IN");
        require(to != address(0), "BEAR/SWAP-TO-ZERO");
        require(rQ > 0 && rT > 0, "BEAR/EMPTY-POOL");

        IERC20(token).transferFrom(msg.sender, address(this), amountIn);
        out = curveIn(amountIn) * rQ / (rT + curveIn(amountIn));
        require(out > 0, "BEAR/OUT-ZERO");

        uint256 kPrev = uint256(rQ) * uint256(rT);
        rT = rT + amountIn;
        rQ = rQ - out;
        _assertGrown(kPrev);

        IERC20(quote).transfer(to, out);
        emit Swap(msg.sender, to, amountIn, out, false);
        require(out >= minOut, "BEAR/MIN-OUT");
    }

    function curveIn(uint256 amountIn) private pure returns (uint256) {
        return amountIn * 997 / 1000;
    }

    function _assertGrown(uint256 kPrev) private view {
        require(uint256(rQ) * uint256(rT) >= kPrev, "BEAR/K-SHRANK");
    }

    // ── liquidity ───────────────────────────────────────────────────────────
    // First provider takes the geometric mean share of the (seeded) pool;
    // everyone after gets the MIN of the two ratio shares — an uneven deposit
    // can never mint value out of the pool, it can only donate.
    function addLiquidity(uint256 quoteAmt, uint256 tokenAmt, uint256 minShares) external reentrancyGuard returns (uint256 made) {
        require(quoteAmt > 0 && tokenAmt > 0, "BEAR/LIQ-ZERO");
        uint256 rQ0 = rQ;
        uint256 rT0 = rT;
        if (totalSupply == 0) {
            made = sqrt((rQ0 + quoteAmt) * (rT0 + tokenAmt));
        } else {
            uint256 mQ = quoteAmt * totalSupply / rQ0;
            uint256 mT = tokenAmt * totalSupply / rT0;
            made = mQ < mT ? mQ : mT;
        }
        require(made > 0, "BEAR/SHARES-ZERO");
        require(made >= minShares, "BEAR/SHARES-MIN");

        quote.transferFrom(msg.sender, address(this), quoteAmt);
        IERC20(token).transferFrom(msg.sender, address(this), tokenAmt);
        rQ = rQ0 + quoteAmt;
        rT = rT0 + tokenAmt;
        totalSupply += made;
        balanceOf[msg.sender] += made;
        emit LiquidityAdded(msg.sender, made);
        emit Transfer(address(0), msg.sender, made);
    }

    function removeLiquidity(uint256 shares, uint256 minQuote, uint256 minToken) external reentrancyGuard returns (uint256 outQuote, uint256 outToken) {
        require(shares > 0, "BEAR/SHARES-ZERO");
        require(block.timestamp >= locks[msg.sender], "BEAR/LP-LOCKED");
        uint256 bal = balanceOf[msg.sender];
        require(bal >= shares, "BEAR/SHARES");
        uint256 sup = totalSupply;
        outQuote = rQ * shares / sup;
        outToken = rT * shares / sup;
        require(outQuote >= minQuote && outToken >= minToken, "BEAR/LIQ-MIN");

        balanceOf[msg.sender] = bal - shares;
        totalSupply = sup - shares;
        rQ -= outQuote;
        rT -= outToken;
        emit LiquidityRemoved(msg.sender, shares);
        emit Transfer(msg.sender, address(0), shares);
        quote.transfer(msg.sender, outQuote);
        IERC20(token).transfer(msg.sender, outToken);
    }

    function sqrt(uint256 x) private pure returns (uint256 r) {
        if (x == 0) return 0;
        r = x;
        uint256 z = (x + 1) / 2;
        while (z < r) {
            r = z;
            z = (x / z + z) / 2;
        }
    }

    // ── LP locks (anti-rug) ─────────────────────────────────────────────────
    function lock(address who, uint64 until) external {
        require(msg.sender == factory || msg.sender == who, "BEAR/LOCK-AUTH");
        require(until > block.timestamp, "BEAR/LOCK-PAST");
        require(until > locks[who], "BEAR/LOCK-SHRINK");
        locks[who] = until;
        emit Locked(who, until);
    }

    function lockOf(address who) external view returns (uint64) {
        return uint64(locks[who]);
    }

    function approve(address spender, uint256 value) external returns (bool) {
        allowance[msg.sender][spender] = value;
        emit Approval(msg.sender, spender, value);
        return true;
    }

    function transfer(address to, uint256 value) external returns (bool) {
        _lpMove(msg.sender, to, value);
        return true;
    }

    function transferFrom(address from, address to, uint256 value) external returns (bool) {
        uint256 a = allowance[from][msg.sender];
        if (a != type(uint256).max) {
            require(a >= value, "BEAR/ALLOWANCE");
            allowance[from][msg.sender] = a - value;
        }
        _lpMove(from, to, value);
        return true;
    }

    function _lpMove(address from, address to, uint256 value) internal {
        require(to != address(0), "BEAR/LP-TO-ZERO");
        require(block.timestamp >= locks[from], "BEAR/LP-LOCKED");
        uint256 b = balanceOf[from];
        require(b >= value, "BEAR/LP-BALANCE");
        balanceOf[from] = b - value;
        balanceOf[to] += value;
        emit Transfer(from, to, value);
    }

    // ── creator fees ────────────────────────────────────────────────────────
    // No reentrancy surprises: pull was escrowed at the trade, so the claim is
    // a single ERC-20 transfer out of the pool's slack.
    function claimFees() external reentrancyGuard returns (uint256 paid) {
        require(msg.sender == creator, "BEAR/FEE-CLAIM");
        paid = totalFeesCreator;
        require(paid > 0, "BEAR/NO-FEE");
        totalFeesCreator = 0;
        quote.transfer(msg.sender, paid);
        emit FeesClaimed(msg.sender, paid);
    }

    // The pool is not a faucet. The quote coin is an ERC-20 terminal here.
    receive() external payable { revert("BEAR/NO-NATIVE"); }
    fallback() external payable { revert("BEAR/NO-NATIVE"); }
}

// ── BearFactory ────────────────────────────────────────────────────────────
// Launch = ONE transaction: token + pair + seed + lock + socials. Factory
// holds the whole supply for exactly this transaction, forwards the seed
// pair-side (pulling the seed quote from the launcher's allowance), hands the
// remainder to the launcher, then walks the LP shares out of its own name and
// into the launcher's. A token trades the second this tx commits.
contract BearFactory {
    IERC20 public immutable quote; // the ONE quote coin for everything the factory mints

    mapping(address => address) public pairOf;  // token → pair
    address[] public tokens;

    event Launched(
        address indexed token,
        address indexed pair,
        address indexed launcher,
        uint256 creatorFeeBps,
        uint64 lpLockUntil,
        uint256 lpShares
    );

    constructor(IERC20 quote_) {
        require(address(quote_) != address(0), "BEAR/FACTORY-QUOTE");
        quote = quote_;
    }

    function tokenCount() external view returns (uint256) { return tokens.length; }

    // One tuple keeps the launch call readable for the wizard AND keeps the
    // contract under stack limits with plain codegen (struct beats seven
    // string locals).
    struct LaunchMeta {
        string name;
        string symbol;
        string image;
        string desc;
        string twitter;
        string telegram;
        string website;
    }

    function launch(
        LaunchMeta calldata meta,
        uint256 totalSupply_,
        uint256 creatorFeeBps_,
        uint64 lpLockUntil,
        uint256 seedQuote,
        uint256 seedToken,
        uint256 minShares
    ) external reentrancyGuard returns (address tokenOut, address pairOut) {
        require(totalSupply_ > 0, "BEAR/SUPPLY-ZERO");
        require(seedQuote > 0 && seedToken > 0, "BEAR/SEED-ZERO");
        require(seedToken <= totalSupply_, "BEAR/SEED-OVER");
        require(creatorFeeBps_ <= 30, "BEAR/FEE-CAP");

        // The launcher pays the opening liquidity out of their own pocket, in
        // the same tx the pool is born. Factory pulls it directly.
        quote.transferFrom(msg.sender, address(this), seedQuote);

        BearToken tk = new BearToken(
            address(this),
            BearToken.Meta({
                name: meta.name, symbol: meta.symbol,
                image: meta.image, desc: meta.desc
            }),
            totalSupply_,
            address(quote)
        );
        BearPair pr = new BearPair(address(this), address(tk), quote, msg.sender, creatorFeeBps_);
        pairOf[address(tk)] = address(pr);
        tokens.push(address(tk));

        // Metadata and socials settle in the same tx; socials can never be
        // rewritten again (the token's own guard is the last word).
        tk.setSocials(BearToken.Socials({
            twitter: meta.twitter, telegram: meta.telegram, website: meta.website
        }));

        // The launcher keeps everything the seed doesn't take.
        tk.transfer(msg.sender, totalSupply_ - seedToken);

        tk.approve(address(pr), seedToken);
        quote.approve(address(pr), seedQuote);
        uint256 made = pr.addLiquidity(seedQuote, seedToken, minShares);
        require(made >= minShares, "BEAR/SHARES-MIN");

        if (lpLockUntil > 0) {
            pr.lock(msg.sender, lpLockUntil);
        }
        // Shares the pair minted to the factory walk one step: factory →
        // launcher. From here they lock or trade like any other LP's.
        pr.transfer(msg.sender, made);

        tokenOut = address(tk);
        pairOut = address(pr);
        emit Launched(tokenOut, pairOut, msg.sender, creatorFeeBps_, lpLockUntil, made);
    }

    modifier reentrancyGuard() {
        require(_entered == 1, "BEAR/REENTRANT");
        _entered = 0;
        _;
        _entered = 1;
    }
    uint256 private _entered = 1;
}
`;
