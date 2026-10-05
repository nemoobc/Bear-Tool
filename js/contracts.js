// ═══════════════════════════════════════════════════════════════
// Bear Tool — contracts.js
// Solidity templates for the deploy wizard + the form metadata that
// drives it. Every template is SELF-CONTAINED (no imports) because the
// in-browser compiler has no import resolver. Compiled for real by
// `solc.js` — nothing here is pre-baked bytecode.
// ═══════════════════════════════════════════════════════════════

const { ethers } = globalThis;

// ── ERC-20 ──
const ERC20_SOURCE = `// SPDX-License-Identifier: MIT
pragma solidity ^0.8.37;

contract BearERC20 {
    string public name;
    string public symbol;
    uint8 public immutable decimals;
    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);

    constructor(string memory _name, string memory _symbol, uint8 _decimals, uint256 _supply) {
        require(bytes(_name).length > 0, "ERC20: empty name");
        require(bytes(_symbol).length > 0, "ERC20: empty symbol");
        name = _name;
        symbol = _symbol;
        decimals = _decimals;
        totalSupply = _supply;
        balanceOf[msg.sender] = _supply;
        emit Transfer(address(0), msg.sender, _supply);
    }

    function transfer(address to, uint256 value) external returns (bool) {
        _transfer(msg.sender, to, value);
        return true;
    }

    function approve(address spender, uint256 value) external returns (bool) {
        allowance[msg.sender][spender] = value;
        emit Approval(msg.sender, spender, value);
        return true;
    }

    function transferFrom(address from, address to, uint256 value) external returns (bool) {
        uint256 allowed = allowance[from][msg.sender];
        require(allowed >= value, "ERC20: insufficient allowance");
        if (allowed != type(uint256).max) {
            allowance[from][msg.sender] = allowed - value;
        }
        _transfer(from, to, value);
        return true;
    }

    function _transfer(address from, address to, uint256 value) internal {
        require(to != address(0), "ERC20: transfer to zero address");
        uint256 bal = balanceOf[from];
        require(bal >= value, "ERC20: insufficient balance");
        unchecked { balanceOf[from] = bal - value; }
        balanceOf[to] += value;
        emit Transfer(from, to, value);
    }
}`;

// ── ERC-721 ──
const ERC721_SOURCE = `// SPDX-License-Identifier: MIT
pragma solidity ^0.8.37;

interface IERC721Receiver {
    function onERC721Received(address operator, address from, uint256 id, bytes calldata data) external returns (bytes4);
}

contract BearERC721 {
    string public name;
    string public symbol;
    string public baseURI;
    address public owner;
    uint256 public totalSupply;

    mapping(uint256 => address) private _owners;
    mapping(address => uint256) private _balances;
    mapping(uint256 => address) public getApproved;
    mapping(address => mapping(address => bool)) public isApprovedForAll;

    event Transfer(address indexed from, address indexed to, uint256 indexed tokenId);
    event Approval(address indexed owner, address indexed approved, uint256 indexed tokenId);
    event ApprovalForAll(address indexed owner, address indexed operator, bool approved);

    constructor(string memory _name, string memory _symbol, string memory _baseURI) {
        require(bytes(_name).length > 0, "ERC721: empty name");
        require(bytes(_symbol).length > 0, "ERC721: empty symbol");
        name = _name;
        symbol = _symbol;
        baseURI = _baseURI;
        owner = msg.sender;
    }

    modifier onlyOwner() {
        require(msg.sender == owner, "ERC721: caller is not owner");
        _;
    }

    function balanceOf(address account) external view returns (uint256) {
        return _balances[account];
    }

    function ownerOf(uint256 id) public view returns (address) {
        address holder = _owners[id];
        require(holder != address(0), "ERC721: nonexistent token");
        return holder;
    }

    function tokenURI(uint256 id) external view returns (string memory) {
        require(_owners[id] != address(0), "ERC721: nonexistent token");
        return string(abi.encodePacked(baseURI, _toString(id)));
    }

    function approve(address to, uint256 id) external {
        address holder = ownerOf(id);
        require(msg.sender == holder || isApprovedForAll[holder][msg.sender], "ERC721: not authorized");
        getApproved[id] = to;
        emit Approval(holder, to, id);
    }

    function setApprovalForAll(address operator, bool approved) external {
        isApprovedForAll[msg.sender][operator] = approved;
        emit ApprovalForAll(msg.sender, operator, approved);
    }

    function transferFrom(address from, address to, uint256 id) public {
        require(from == _owners[id], "ERC721: transfer of token that is not own");
        require(to != address(0), "ERC721: transfer to zero address");
        require(
            msg.sender == from || isApprovedForAll[from][msg.sender] || msg.sender == getApproved[id],
            "ERC721: not authorized"
        );
        unchecked { _balances[from] -= 1; }
        _balances[to] += 1;
        _owners[id] = to;
        delete getApproved[id];
        emit Transfer(from, to, id);
    }

    function safeTransferFrom(address from, address to, uint256 id) external {
        safeTransferFrom(from, to, id, "");
    }

    function safeTransferFrom(address from, address to, uint256 id, bytes memory data) public {
        transferFrom(from, to, id);
        if (to.code.length > 0) {
            require(
                IERC721Receiver(to).onERC721Received(msg.sender, from, id, data) == IERC721Receiver.onERC721Received.selector,
                "ERC721: unsafe recipient"
            );
        }
    }

    function mint(address to) external onlyOwner returns (uint256) {
        require(to != address(0), "ERC721: mint to zero address");
        uint256 id = ++totalSupply;
        _balances[to] += 1;
        _owners[id] = to;
        emit Transfer(address(0), to, id);
        return id;
    }

    function _toString(uint256 value) internal pure returns (string memory) {
        if (value == 0) return "0";
        uint256 temp = value;
        uint256 digits;
        while (temp != 0) { digits++; temp /= 10; }
        bytes memory buffer = new bytes(digits);
        while (value != 0) {
            digits--;
            buffer[digits] = bytes1(uint8(48 + value % 10));
            value /= 10;
        }
        return string(buffer);
    }
}`;

// ── ERC-1155 ──
const ERC1155_SOURCE = `// SPDX-License-Identifier: MIT
pragma solidity ^0.8.37;

interface IERC1155Receiver {
    function onERC1155Received(address operator, address from, uint256 id, uint256 value, bytes calldata data) external returns (bytes4);
    function onERC1155BatchReceived(address operator, address from, uint256[] calldata ids, uint256[] calldata values, bytes calldata data) external returns (bytes4);
}

contract BearERC1155 {
    string public name;
    string public symbol;
    string private _uri;
    address public owner;
    mapping(uint256 => mapping(address => uint256)) private _balances;
    mapping(address => mapping(address => bool)) public isApprovedForAll;

    event TransferSingle(address indexed operator, address indexed from, address indexed to, uint256 id, uint256 value);
    event TransferBatch(address indexed operator, address indexed from, address indexed to, uint256[] ids, uint256[] values);
    event ApprovalForAll(address indexed owner, address indexed operator, bool approved);

    constructor(string memory name_, string memory symbol_, string memory uri_) {
        require(bytes(name_).length > 0, "ERC1155: empty name");
        require(bytes(symbol_).length > 0, "ERC1155: empty symbol");
        name = name_;
        symbol = symbol_;
        _uri = uri_;
        owner = msg.sender;
    }

    modifier onlyOwner() {
        require(msg.sender == owner, "ERC1155: caller is not owner");
        _;
    }

    function uri(uint256) external view returns (string memory) {
        return _uri;
    }

    function balanceOf(address account, uint256 id) public view returns (uint256) {
        return _balances[id][account];
    }

    function balanceOfBatch(address[] calldata accounts, uint256[] calldata ids) external view returns (uint256[] memory) {
        require(accounts.length == ids.length, "ERC1155: length mismatch");
        uint256[] memory out = new uint256[](accounts.length);
        for (uint256 i = 0; i < accounts.length; i++) {
            out[i] = _balances[ids[i]][accounts[i]];
        }
        return out;
    }

    function setApprovalForAll(address operator, bool approved) external {
        isApprovedForAll[msg.sender][operator] = approved;
        emit ApprovalForAll(msg.sender, operator, approved);
    }

    function safeTransferFrom(address from, address to, uint256 id, uint256 value, bytes calldata data) external {
        require(from == msg.sender || isApprovedForAll[from][msg.sender], "ERC1155: not authorized");
        _move(from, to, id, value);
        if (to.code.length > 0) {
            require(
                IERC1155Receiver(to).onERC1155Received(msg.sender, from, id, value, data) == IERC1155Receiver.onERC1155Received.selector,
                "ERC1155: unsafe recipient"
            );
        }
    }

    function safeBatchTransferFrom(address from, address to, uint256[] calldata ids, uint256[] calldata values, bytes calldata data) external {
        require(ids.length == values.length, "ERC1155: length mismatch");
        require(from == msg.sender || isApprovedForAll[from][msg.sender], "ERC1155: not authorized");
        for (uint256 i = 0; i < ids.length; i++) {
            _move(from, to, ids[i], values[i]);
        }
        if (to.code.length > 0) {
            require(
                IERC1155Receiver(to).onERC1155BatchReceived(msg.sender, from, ids, values, data) == IERC1155Receiver.onERC1155BatchReceived.selector,
                "ERC1155: unsafe recipient"
            );
        }
        emit TransferBatch(msg.sender, from, to, ids, values);
    }

    function mint(address to, uint256 id, uint256 value) external onlyOwner {
        _move(address(0), to, id, value);
    }

    function _move(address from, address to, uint256 id, uint256 value) internal {
        require(to != address(0), "ERC1155: transfer to zero address");
        if (from != address(0)) {
            uint256 bal = _balances[id][from];
            require(bal >= value, "ERC1155: insufficient balance");
            unchecked { _balances[id][from] = bal - value; }
        }
        _balances[id][to] += value;
        emit TransferSingle(msg.sender, from, to, id, value);
    }
}`;

// ── feature-flag source builders (OZ-parity, self-contained) ──
// The OpenZeppelin wizard toggles burnable/mintable/pausable/cap/permit/
// votes/enumerable/uriStorage plus an access select (ownable/ownable2step/
// accessControl) — github.com/OpenZeppelin/contracts-wizard, README 2026-10-04.
// The browser solc has no import resolver, so Ownable/Pausable/AccessControl
// cannot be imported — the same features are generated INLINE onto the
// templates above. Flag-off ERC-20 output is byte-identical to the shipped
// template (the default path never changes); ERC-721/1155 always carry their
// owner, so they gain OZ-Ownable's transferOwnership unconditionally.

function erc20Source(f = {}) {
  const owner = Boolean(f.mintable || f.pausable);
  const capStr = String(f.cap ?? '').trim();
  const hasCap = /^\d+$/.test(capStr) && BigInt(capStr) > 0n;
  // Wizard "access" select (OZ parity): plain Ownable is the default and
  // generates the same code as before; Ownable2Step / AccessControl only
  // appear when chosen — and only when a feature actually creates an owner.
  // "managed" (report: "Akses Ownable/Roles/Managed") = OZ
  // AccessControlDefaultAdminRules flavour: MINTER/PAUSER roles administered
  // by a single defaultAdmin whose handover is TWO-STEP (begin/accept).
  const acl = owner && f.access === 'accesscontrol';
  const managed = owner && f.access === 'managed';
  const roles = acl || managed;
  const twoStep = owner && f.access === 'ownable2step';
  const mMint = roles ? 'onlyRole(MINTER_ROLE)' : 'onlyOwner';
  const mPause = roles ? 'onlyRole(PAUSER_ROLE)' : 'onlyOwner';
  let s = ERC20_SOURCE;

  if (owner || f.pausable || hasCap || f.permit || f.votes) {
    const state =
      (hasCap ? '    uint256 public immutable cap;\n' : '') +
      (roles
        ? `    bytes32 public constant DEFAULT_ADMIN_ROLE = 0x00;
    bytes32 public constant MINTER_ROLE = keccak256("MINTER_ROLE");
    bytes32 public constant PAUSER_ROLE = keccak256("PAUSER_ROLE");
    mapping(bytes32 => mapping(address => bool)) private _roles;
` + (managed ? `    address public defaultAdmin;
    address public pendingDefaultAdmin;
` : '')
        : owner
          ? (twoStep ? '    address public owner;\n    address public pendingOwner;\n' : '    address public owner;\n')
          : '') +
      (f.pausable ? '    bool public paused;\n' : '') +
      (f.permit ? `    mapping(address => uint256) public nonces;
    bytes32 private constant _PERMIT_TYPEHASH = keccak256("Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)");
` : '') +
      (f.votes ? `    mapping(address => address) public delegates;
    mapping(address => uint256) public votes;
    uint256 public totalVotes;
    struct Checkpoint { uint32 blockNumber; uint256 value; }
    mapping(address => Checkpoint[]) private _checkpoints;
    Checkpoint[] private _totalCheckpoints;
` : '');
    if (state) {
      s = s.replace('    uint256 public totalSupply;\n',
        '    uint256 public totalSupply;\n' + state);
    }
  }
  if (hasCap) {
    s = s.replace('uint8 _decimals, uint256 _supply)',
      'uint8 _decimals, uint256 _supply, uint256 _cap)');
  }
  if (owner || hasCap) {
    const ctor =
      (hasCap ? '        require(_cap >= _supply, "ERC20: cap below initial supply");\n        cap = _cap;\n' : '') +
      (roles
        ? (managed
          ? // Managed: DEFAULT_ADMIN_ROLE is DERIVED from defaultAdmin (OZ
            // AccessControlDefaultAdminRules), so it is never written to _roles.
            `        defaultAdmin = msg.sender;
` + (f.mintable ? '        _roles[MINTER_ROLE][msg.sender] = true;\n' : '') +
            (f.pausable ? '        _roles[PAUSER_ROLE][msg.sender] = true;\n' : '')
          : `        _roles[DEFAULT_ADMIN_ROLE][msg.sender] = true;
` + (f.mintable ? '        _roles[MINTER_ROLE][msg.sender] = true;\n' : '') +
            (f.pausable ? '        _roles[PAUSER_ROLE][msg.sender] = true;\n' : ''))
        : owner ? '        owner = msg.sender;\n' : '');
    s = s.replace('        totalSupply = _supply;', ctor + '        totalSupply = _supply;');
  }
  if (owner || f.pausable) {
    const mods =
      (owner ? (roles ? `
    modifier onlyRole(bytes32 role) {
        require(_roles[role][msg.sender], "ERC20: missing role");
        _;
    }
` + (managed ? `
    modifier onlyDefaultAdmin() {
        require(msg.sender == defaultAdmin, "ERC20: caller is not default admin");
        _;
    }
` : '') : `
    modifier onlyOwner() {
        require(msg.sender == owner, "ERC20: caller is not owner");
        _;
    }
`) : '') +
      (f.pausable ? `
    modifier whenNotPaused() {
        require(!paused, "ERC20: paused");
        _;
    }

    function pause() external ${mPause} {
        paused = true;
    }

    function unpause() external ${mPause} {
        paused = false;
    }
` : '') + '\n';
    s = s.replace('    function transfer(address to, uint256 value) external returns (bool) {',
      mods + '    function transfer(address to, uint256 value) external returns (bool) {');
  }
  if (f.pausable) {
    s = s.replace('function transfer(address to, uint256 value) external returns (bool)',
      'function transfer(address to, uint256 value) external whenNotPaused returns (bool)');
    s = s.replace('function transferFrom(address from, address to, uint256 value) external returns (bool)',
      'function transferFrom(address from, address to, uint256 value) external whenNotPaused returns (bool)');
  }

  if (f.votes) {
    // Balance changes flow through _transfer; hook the voting-power move
    // right where the balance actually moves (from==to nets zero anyway).
    s = s.replace('        balanceOf[to] += value;\n        emit Transfer(from, to, value);',
      '        balanceOf[to] += value;\n        _moveVotingPower(from, to, value);\n        emit Transfer(from, to, value);');
  }
  let extra = '';
  if (f.burnable) {
    extra += `
    function burn(uint256 value) external {
        uint256 bal = balanceOf[msg.sender];
        require(bal >= value, "ERC20: insufficient balance");
        unchecked { balanceOf[msg.sender] = bal - value; }
        totalSupply -= value;${f.votes ? '\n        _moveVotingPower(msg.sender, address(0), value);' : ''}
        emit Transfer(msg.sender, address(0), value);
    }
`;
  }
  if (f.mintable) {
    extra += `
    function mint(address to, uint256 value) external ${mMint} {
        require(to != address(0), "ERC20: mint to zero address");` +
      (hasCap ? `
        require(totalSupply + value <= cap, "ERC20: cap exceeded");` : '') + `
        totalSupply += value;
        balanceOf[to] += value;${f.votes ? '\n        _moveVotingPower(address(0), to, value);' : ''}
        emit Transfer(address(0), to, value);
    }
`;
  }
  if (owner && !roles) {
    // OZ Ownable has a single-step transferOwnership; Ownable2Step parks it
    // behind an accept — that IS the difference between the two choices.
    extra += twoStep ? `
    function transferOwnership(address to) external onlyOwner {
        require(to != address(0), "ERC20: zero address owner");
        pendingOwner = to;
    }

    function acceptOwnership() external {
        require(msg.sender == pendingOwner, "ERC20: not pending owner");
        owner = pendingOwner;
        pendingOwner = address(0);
    }
` : `
    function transferOwnership(address to) external onlyOwner {
        require(to != address(0), "ERC20: zero address owner");
        owner = to;
    }
`;
  }
  if (acl) {
    extra += `
    event RoleGranted(bytes32 indexed role, address indexed account, address indexed sender);
    event RoleRevoked(bytes32 indexed role, address indexed account, address indexed sender);

    function hasRole(bytes32 role, address account) public view returns (bool) {
        return _roles[role][account];
    }

    function grantRole(bytes32 role, address account) external onlyRole(DEFAULT_ADMIN_ROLE) {
        _roles[role][account] = true;
        emit RoleGranted(role, account, msg.sender);
    }

    function revokeRole(bytes32 role, address account) external onlyRole(DEFAULT_ADMIN_ROLE) {
        _roles[role][account] = false;
        emit RoleRevoked(role, account, msg.sender);
    }

    function renounceRole(bytes32 role) external {
        _roles[role][msg.sender] = false;
        emit RoleRevoked(role, msg.sender, msg.sender);
    }
`;
  }
  if (managed) {
    // Managed = roles + two-step default admin (OZ AccessControlDefaultAdminRules).
    // DEFAULT_ADMIN_ROLE is DERIVED from defaultAdmin (never stored), so a typo'd
    // address can never lock the roles out — propose → accept, then hand over.
    extra += `
    event RoleGranted(bytes32 indexed role, address indexed account, address indexed sender);
    event RoleRevoked(bytes32 indexed role, address indexed account, address indexed sender);

    function hasRole(bytes32 role, address account) public view returns (bool) {
        return role == DEFAULT_ADMIN_ROLE ? account == defaultAdmin : _roles[role][account];
    }

    function grantRole(bytes32 role, address account) external onlyDefaultAdmin {
        require(role != DEFAULT_ADMIN_ROLE, "ERC20: use beginDefaultAdminTransfer");
        _roles[role][account] = true;
        emit RoleGranted(role, account, msg.sender);
    }

    function revokeRole(bytes32 role, address account) external onlyDefaultAdmin {
        require(role != DEFAULT_ADMIN_ROLE, "ERC20: use beginDefaultAdminTransfer");
        _roles[role][account] = false;
        emit RoleRevoked(role, account, msg.sender);
    }

    function renounceRole(bytes32 role) external {
        require(role != DEFAULT_ADMIN_ROLE, "ERC20: default admin cannot renounce");
        _roles[role][msg.sender] = false;
        emit RoleRevoked(role, msg.sender, msg.sender);
    }

    function beginDefaultAdminTransfer(address newAdmin) external onlyDefaultAdmin {
        require(newAdmin != address(0), "ERC20: zero address admin");
        pendingDefaultAdmin = newAdmin;
    }

    function acceptDefaultAdminTransfer() external {
        require(msg.sender == pendingDefaultAdmin, "ERC20: not pending admin");
        defaultAdmin = pendingDefaultAdmin;
        pendingDefaultAdmin = address(0);
    }
`;
  }
  if (f.permit) {
    // EIP-2612 with the EIP-712 domain wallets actually sign against
    // (name + version "1" + chainId + verifyingContract — OZ ERC20Permit).
    // DOMAIN_SEPARATOR is recomputed, not cached, so chain forks stay valid.
    extra += `
    function DOMAIN_SEPARATOR() public view returns (bytes32) {
        return keccak256(abi.encode(
            keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
            keccak256(bytes(name)),
            keccak256(bytes("1")),
            block.chainid,
            address(this)
        ));
    }

    function permit(address owner_, address spender, uint256 value, uint256 deadline, uint8 v, bytes32 r, bytes32 s_) external {
        require(block.timestamp <= deadline, "ERC20: permit expired");
        bytes32 digest = keccak256(abi.encodePacked(
            hex"1901", DOMAIN_SEPARATOR(),
            keccak256(abi.encode(_PERMIT_TYPEHASH, owner_, spender, value, nonces[owner_]++, deadline))
        ));
        address recovered = ecrecover(digest, v, r, s_);
        require(recovered != address(0) && recovered == owner_, "ERC20: invalid signature");
        allowance[owner_][spender] = value;
        emit Approval(owner_, spender, value);
    }
`;
  }
  if (f.votes) {
    // ERC20Votes-lite: delegation + per-block checkpoints, no sig delegation
    // (delegateBySig) — the on-chain surface the Governor wizard needs.
    extra += `
    function delegate(address to) external {
        address current = delegates[msg.sender];
        require(current != to, "ERC20: already delegated");
        uint256 amount = balanceOf[msg.sender];
        if (current != address(0)) _writeVotes(current, false, amount);
        if (to != address(0)) _writeVotes(to, true, amount);
        delegates[msg.sender] = to;
    }

    function getVotes(address account) public view returns (uint256) {
        uint256 n = _checkpoints[account].length;
        return n > 0 ? _checkpoints[account][n - 1].value : 0;
    }

    function getPastVotes(address account, uint256 blockNumber) public view returns (uint256) {
        require(blockNumber < block.number, "ERC20: not yet mined");
        Checkpoint[] storage ck = _checkpoints[account];
        uint256 lo = 0;
        uint256 hi = ck.length;
        while (lo < hi) {
            uint256 mid = (lo + hi) / 2;
            if (ck[mid].blockNumber > blockNumber) hi = mid;
            else lo = mid + 1;
        }
        return lo == 0 ? 0 : ck[lo - 1].value;
    }

    function getPastTotalVotes(uint256 blockNumber) public view returns (uint256) {
        require(blockNumber < block.number, "ERC20: not yet mined");
        Checkpoint[] storage ck = _totalCheckpoints;
        uint256 lo = 0;
        uint256 hi = ck.length;
        while (lo < hi) {
            uint256 mid = (lo + hi) / 2;
            if (ck[mid].blockNumber > blockNumber) hi = mid;
            else lo = mid + 1;
        }
        return lo == 0 ? 0 : ck[lo - 1].value;
    }

    function _writeVotes(address account, bool add, uint256 amount) private {
        uint32 bn = uint32(block.number);
        uint256 n = _checkpoints[account].length;
        if (n > 0 && _checkpoints[account][n - 1].blockNumber == bn) {
            Checkpoint storage c = _checkpoints[account][n - 1];
            c.value = add ? c.value + amount : c.value - amount;
        } else {
            uint256 prev = n > 0 ? _checkpoints[account][n - 1].value : 0;
            _checkpoints[account].push(Checkpoint(bn, add ? prev + amount : prev - amount));
        }
    }

    function _writeTotal(bool add, uint256 amount) private {
        uint32 bn = uint32(block.number);
        uint256 n = _totalCheckpoints.length;
        if (n > 0 && _totalCheckpoints[n - 1].blockNumber == bn) {
            Checkpoint storage c = _totalCheckpoints[n - 1];
            c.value = add ? c.value + amount : c.value - amount;
        } else {
            uint256 prev = n > 0 ? _totalCheckpoints[n - 1].value : 0;
            _totalCheckpoints.push(Checkpoint(bn, add ? prev + amount : prev - amount));
        }
    }

    function _moveVotingPower(address from, address to, uint256 amount) private {
        if (amount == 0 || from == to) return;
        if (from == address(0)) _writeTotal(true, amount);
        else if (to == address(0)) _writeTotal(false, amount);
        address src = from == address(0) ? address(0) : delegates[from];
        address dst = to == address(0) ? address(0) : delegates[to];
        if (src != address(0)) _writeVotes(src, false, amount);
        if (dst != address(0)) _writeVotes(dst, true, amount);
    }
`;
  }
  // Report: "tombol Callback / Flash Minting".
  // Callback = ERC-1363 transferAndCall: balance moves through _transfer (so
  // zero-address/insufficient checks AND the votes hook come for free), then a
  // contract receiver must acknowledge with onTokenTransfer == true.
  // Guard after the transfer is deliberate: state already settled before the
  // external call (checks-effects-interactions).
  let tail = '';
  if (f.callback) {
    extra += `
    function transferAndCall(address to, uint256 value, bytes calldata data) external${f.pausable ? ' whenNotPaused' : ''} returns (bool) {
        _transfer(msg.sender, to, value);
        if (to.code.length > 0) {
            require(IERC1363Receiver(to).onTokenTransfer(msg.sender, value, data), "ERC20: callback rejected");
        }
        return true;
    }
`;
    tail += `

interface IERC1363Receiver {
    function onTokenTransfer(address from, uint256 value, bytes calldata data) external returns (bool);
}`;
  }
  // Flash Minting = ERC-3156 lender over the token's OWN supply: mint amount
  // to receiver, let its onFlashLoan callback run, then burn amount+fee (fee
  // = 0) straight back — if the receiver cannot cover it, the whole tx reverts.
  // Cap is honoured even mid-flash (totalSupply never exceeds cap).
  if (f.flashmint) {
    extra += `
    bytes32 private constant CALLBACK_SUCCESS = keccak256("ERC3156FlashBorrower.onFlashLoan");

    function maxFlashLoan(address token) external view returns (uint256) {
        if (token != address(this)) return 0;
        return type(uint256).max - totalSupply;
    }

    function flashFee(address token, uint256) external view returns (uint256) {
        require(token == address(this), "ERC20: unsupported token");
        return 0;
    }

    function flashLoan(address receiver, address token, uint256 amount, bytes calldata data) external${f.pausable ? ' whenNotPaused' : ''} {
        require(token == address(this), "ERC20: unsupported token");
        require(amount <= type(uint256).max - totalSupply, "ERC20: flash amount too high");` +
      (hasCap ? `
        require(totalSupply + amount <= cap, "ERC20: cap exceeded");` : '') + `
        totalSupply += amount;
        balanceOf[receiver] += amount;${f.votes ? '\n        _moveVotingPower(address(0), receiver, amount);' : ''}
        emit Transfer(address(0), receiver, amount);
        require(IERC3156Borrower(receiver).onFlashLoan(msg.sender, address(this), amount, 0, data) == CALLBACK_SUCCESS, "ERC20: flash mint not repaid");
        require(balanceOf[receiver] >= amount, "ERC20: flash mint not repaid");
        totalSupply -= amount;
        unchecked { balanceOf[receiver] -= amount; }${f.votes ? '\n        _moveVotingPower(receiver, address(0), amount);' : ''}
        emit Transfer(receiver, address(0), amount);
    }
`;
    tail += `

interface IERC3156Borrower {
    function onFlashLoan(address initiator, address token, uint256 amount, uint256 fee, bytes calldata data) external returns (bytes32);
}`;
  }
  if (extra) s = s.replace(/\n}$/, extra + '\n}');
  // Interfaces live OUTSIDE the contract (they are target types for the hooks).
  if (tail) s += tail + '\n';
  return s;
}

function erc721Source(f = {}) {
  // Wizard access select: default Ownable = the shipped code, 2-step and
  // role-based AccessControl only when chosen (OZ parity). "Managed" =
  // AccessControlDefaultAdminRules flavour: MINTER/PAUSER roles governed by a
  // defaultAdmin whose handover is two-step (begin/acceptDefaultAdminTransfer).
  const acl = f.access === 'accesscontrol';
  const managed = f.access === 'managed';
  const roles = acl || managed;
  const twoStep = f.access === 'ownable2step';
  const mMint = roles ? 'onlyRole(MINTER_ROLE)' : 'onlyOwner';
  const mPause = roles ? 'onlyRole(PAUSER_ROLE)' : 'onlyOwner';
  const mUri = roles ? 'onlyRole(MINTER_ROLE)' : 'onlyOwner';
  let s = ERC721_SOURCE;
  if (f.mintable === false) {
    s = s.replace(`    function mint(address to) external onlyOwner returns (uint256) {
        require(to != address(0), "ERC721: mint to zero address");
        uint256 id = ++totalSupply;
        _balances[to] += 1;
        _owners[id] = to;
        emit Transfer(address(0), to, id);
        return id;
    }

`, '');
  }
  // State (paused / enumerable / per-token URI) rides in behind totalSupply.
  const state =
    (f.pausable ? '    bool public paused;\n' : '') +
    (f.enumerable ? `    uint256 private _nextId;
    uint256[] private _allTokens;
    mapping(uint256 => uint256) private _allIndex;
    mapping(address => uint256[]) private _ownedTokens;
    mapping(uint256 => uint256) private _ownedIndex;
` : '') +
    (f.uriStorage ? '    mapping(uint256 => string) private _tokenURIs;\n' : '');
  if (state) {
    s = s.replace('    uint256 public totalSupply;\n',
      '    uint256 public totalSupply;\n' + state);
  }
  // Enumerable rewrites the id counter: _nextId hands out ids, totalSupply
  // becomes the LIVE count OZ's ERC721Enumerable promises (burn shrinks it).
  if (f.enumerable) {
    s = s.replace(`    function mint(address to) external onlyOwner returns (uint256) {
        require(to != address(0), "ERC721: mint to zero address");
        uint256 id = ++totalSupply;
        _balances[to] += 1;
        _owners[id] = to;
        emit Transfer(address(0), to, id);
        return id;
    }`, `    function mint(address to) external onlyOwner returns (uint256) {
        require(to != address(0), "ERC721: mint to zero address");
        uint256 id = ++_nextId;
        _balances[to] += 1;
        _owners[id] = to;
        totalSupply += 1;
        _ownedIndex[id] = _ownedTokens[to].length;
        _ownedTokens[to].push(id);
        _allIndex[id] = _allTokens.length;
        _allTokens.push(id);
        emit Transfer(address(0), to, id);
        return id;
    }`);
    s = s.replace(`        unchecked { _balances[from] -= 1; }
        _balances[to] += 1;
        _owners[id] = to;
        delete getApproved[id];`, `        unchecked { _balances[from] -= 1; }
        _balances[to] += 1;
        _owners[id] = to;
        _removeOwned(from, id);
        _addOwned(to, id);
        delete getApproved[id];`);
  }
  if (roles) {
    s = s.replace('    address public owner;\n', `    bytes32 public constant DEFAULT_ADMIN_ROLE = 0x00;
    bytes32 public constant MINTER_ROLE = keccak256("MINTER_ROLE");
    bytes32 public constant PAUSER_ROLE = keccak256("PAUSER_ROLE");
    mapping(bytes32 => mapping(address => bool)) private _roles;
` + (managed ? `    address public defaultAdmin;
    address public pendingDefaultAdmin;
` : ''));
    s = s.replace('        owner = msg.sender;', (managed
      ? `        defaultAdmin = msg.sender;
        _roles[MINTER_ROLE][msg.sender] = true;`
      : `        _roles[DEFAULT_ADMIN_ROLE][msg.sender] = true;
        _roles[MINTER_ROLE][msg.sender] = true;`) + (f.pausable ? `
        _roles[PAUSER_ROLE][msg.sender] = true;` : ''));
    s = s.replace(`    modifier onlyOwner() {
        require(msg.sender == owner, "ERC721: caller is not owner");
        _;
    }`, `    modifier onlyRole(bytes32 role) {
        require(_roles[role][msg.sender], "ERC721: missing role");
        _;
    }` + (managed ? `

    modifier onlyDefaultAdmin() {
        require(msg.sender == defaultAdmin, "ERC721: caller is not default admin");
        _;
    }` : ''));
    s = s.replace('function mint(address to) external onlyOwner returns (uint256)',
      `function mint(address to) external ${mMint} returns (uint256)`);
  }
  if (f.pausable) {
    s = s.replace('    function balanceOf(address account) external view returns (uint256) {', `    modifier whenNotPaused() {
        require(!paused, "ERC721: paused");
        _;
    }

    function pause() external ${mPause} {
        paused = true;
    }

    function unpause() external ${mPause} {
        paused = false;
    }

    function balanceOf(address account) external view returns (uint256) {`);
    s = s.replace('    function transferFrom(address from, address to, uint256 id) public {',
      '    function transferFrom(address from, address to, uint256 id) public whenNotPaused {');
  }
  if (f.uriStorage) {
    s = s.replace(`    function tokenURI(uint256 id) external view returns (string memory) {
        require(_owners[id] != address(0), "ERC721: nonexistent token");
        return string(abi.encodePacked(baseURI, _toString(id)));
    }`, `    function tokenURI(uint256 id) external view returns (string memory) {
        require(_owners[id] != address(0), "ERC721: nonexistent token");
        string memory custom = _tokenURIs[id];
        if (bytes(custom).length > 0) return custom;
        return string(abi.encodePacked(baseURI, _toString(id)));
    }

    function setTokenURI(uint256 id, string calldata newUri) external ${mUri} {
        require(_owners[id] != address(0), "ERC721: nonexistent token");
        _tokenURIs[id] = newUri;
    }`);
  }
  if (f.burnable) {
    s = s.replace(`        return string(buffer);
    }
}`, `        return string(buffer);
    }

    function burn(uint256 id) external {
        address holder = ownerOf(id);
        require(msg.sender == holder, "ERC721: burn from non-owner");
        delete _owners[id];
        unchecked { _balances[holder] -= 1; }${f.uriStorage ? '\n        delete _tokenURIs[id];' : ''}${f.enumerable ? '\n        totalSupply -= 1;\n        _removeOwned(holder, id);\n        _removeAll(id);' : (f.autoInc === false ? '\n        // Manual ids: totalSupply is a live count, so burning shrinks it.\n        unchecked { totalSupply -= 1; }' : '\n        // totalSupply doubles as the next-id counter; burned ids are never reused.')}
        emit Transfer(holder, address(0), id);
    }
}`);
  }
  let tail = '';
  // ── M8: fallback metadata image (report: "gambar NFT") ──
  // The URL rides in as the FOURTH constructor argument — only when set, so
  // the empty case compiles the exact 3-arg template that ships today.
  // tokenURI then falls back to a self-describing data:application/json
  // document (name + image) whenever Base URI is empty: an image URL alone is
  // enough for marketplaces to render the token. Nothing else is stored on
  // chain — no metadata blob, no per-token records.
  const image = String(f.image || '').trim();
  if (image) {
    s = s.replace('    string public baseURI;\n', '    string public baseURI;\n    string public image;\n');
    s = s.replace('constructor(string memory _name, string memory _symbol, string memory _baseURI) {',
      'constructor(string memory _name, string memory _symbol, string memory _baseURI, string memory _image) {');
    s = s.replace('        baseURI = _baseURI;', '        baseURI = _baseURI;\n        image = _image;');
    // Only the FINAL return is rewritten, so uriStorage's custom-URI early
    // return (applied above) keeps precedence over the data-URI fallback.
    s = s.replace('        return string(abi.encodePacked(baseURI, _toString(id)));',
`        if (bytes(baseURI).length == 0) {
            bytes memory json = abi.encodePacked('{"name":"', name, ' #', _toString(id), '","image":"', image, '"}');
            return string(abi.encodePacked("data:application/json;base64,", _base64(json)));
        }
        return string(abi.encodePacked(baseURI, _toString(id)));`);
    tail += `
    // Minimal Base64 (RFC 4648) — enough to inline the metadata JSON as a
    // data: URI. No external library: templates stay self-contained for the
    // in-browser solc.
    function _base64(bytes memory data) internal pure returns (string memory) {
        if (data.length == 0) return "";
        bytes memory tbl = bytes("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/");
        bytes memory out = new bytes(4 * ((data.length + 2) / 3));
        uint256 j = 0;
        for (uint256 i = 0; i < data.length; i += 3) {
            uint256 a = uint8(data[i]);
            uint256 b = i + 1 < data.length ? uint8(data[i + 1]) : 0;
            uint256 c = i + 2 < data.length ? uint8(data[i + 2]) : 0;
            out[j++] = tbl[(a >> 2) & 0x3F];
            out[j++] = tbl[((a & 0x3) << 4) | (b >> 4)];
            out[j++] = tbl[((b & 0xF) << 2) | (c >> 6)];
            out[j++] = tbl[c & 0x3F];
        }
        uint256 pad = (3 - data.length % 3) % 3;
        if (pad == 1) {
            out[out.length - 1] = '=';
            out[out.length - 2] = '=';
        } else if (pad == 2) {
            out[out.length - 1] = '=';
        }
        return string(out);
    }
`;
  }
  // ── M8: token id assignment ──
  // Default ON = the auto-incrementing mint that has always shipped. OFF =
  // mint(to, id) with zero-id and duplicate rejection. Applied LAST on
  // purpose: it rewrites whatever mint shape the enumerable + role rewrites
  // above produced (checklist order: enumerable → acl → autoInc).
  if (f.autoInc === false) {
    s = s.replace('function mint(address to) external', 'function mint(address to, uint256 id) external');
    const manualIds =
`        require(id > 0, "ERC721: id must be greater than 0");
        require(_owners[id] == address(0), "ERC721: id already minted");`;
    if (s.includes('uint256 id = ++_nextId;')) {
      // Enumerable: _nextId hands out ids → the caller does now, so the
      // counter (and its only reader) goes away entirely.
      s = s.replace('        uint256 id = ++_nextId;', manualIds);
    } else if (s.includes('uint256 id = ++totalSupply;')) {
      // Plain: totalSupply stopped being a counter — it is a live count now.
      s = s.replace('        uint256 id = ++totalSupply;', manualIds + '\n        totalSupply += 1;');
    }
    s = s.replace('    uint256 private _nextId;\n', '');
  }
  if (!roles) {
    tail += twoStep ? `
    function transferOwnership(address to) external onlyOwner {
        require(to != address(0), "ERC721: zero address owner");
        pendingOwner = to;
    }

    function acceptOwnership() external {
        require(msg.sender == pendingOwner, "ERC721: not pending owner");
        owner = pendingOwner;
        pendingOwner = address(0);
    }
` : `
    function transferOwnership(address to) external onlyOwner {
        require(to != address(0), "ERC721: zero address owner");
        owner = to;
    }
`;
  } else if (acl) {
    tail += `
    event RoleGranted(bytes32 indexed role, address indexed account, address indexed sender);
    event RoleRevoked(bytes32 indexed role, address indexed account, address indexed sender);

    function hasRole(bytes32 role, address account) public view returns (bool) {
        return _roles[role][account];
    }

    function grantRole(bytes32 role, address account) external onlyRole(DEFAULT_ADMIN_ROLE) {
        _roles[role][account] = true;
        emit RoleGranted(role, account, msg.sender);
    }

    function revokeRole(bytes32 role, address account) external onlyRole(DEFAULT_ADMIN_ROLE) {
        _roles[role][account] = false;
        emit RoleRevoked(role, account, msg.sender);
    }

    function renounceRole(bytes32 role) external {
        _roles[role][msg.sender] = false;
        emit RoleRevoked(role, msg.sender, msg.sender);
    }
`;
  } else {
    // Managed: DEFAULT_ADMIN_ROLE is derived from defaultAdmin (never stored),
    // admin handover = begin/accept — same shape as the ERC-20 variant.
    tail += `
    event RoleGranted(bytes32 indexed role, address indexed account, address indexed sender);
    event RoleRevoked(bytes32 indexed role, address indexed account, address indexed sender);

    function hasRole(bytes32 role, address account) public view returns (bool) {
        return role == DEFAULT_ADMIN_ROLE ? account == defaultAdmin : _roles[role][account];
    }

    function grantRole(bytes32 role, address account) external onlyDefaultAdmin {
        require(role != DEFAULT_ADMIN_ROLE, "ERC721: use beginDefaultAdminTransfer");
        _roles[role][account] = true;
        emit RoleGranted(role, account, msg.sender);
    }

    function revokeRole(bytes32 role, address account) external onlyDefaultAdmin {
        require(role != DEFAULT_ADMIN_ROLE, "ERC721: use beginDefaultAdminTransfer");
        _roles[role][account] = false;
        emit RoleRevoked(role, account, msg.sender);
    }

    function renounceRole(bytes32 role) external {
        require(role != DEFAULT_ADMIN_ROLE, "ERC721: default admin cannot renounce");
        _roles[role][msg.sender] = false;
        emit RoleRevoked(role, msg.sender, msg.sender);
    }

    function beginDefaultAdminTransfer(address newAdmin) external onlyDefaultAdmin {
        require(newAdmin != address(0), "ERC721: zero address admin");
        pendingDefaultAdmin = newAdmin;
    }

    function acceptDefaultAdminTransfer() external {
        require(msg.sender == pendingDefaultAdmin, "ERC721: not pending admin");
        defaultAdmin = pendingDefaultAdmin;
        pendingDefaultAdmin = address(0);
    }
`;
  }
  if (twoStep && !roles) {
    s = s.replace('    address public owner;',
      '    address public owner;\n    address public pendingOwner;');
  }
  if (f.enumerable) {
    tail += `
    function tokenByIndex(uint256 index) external view returns (uint256) {
        require(index < _allTokens.length, "ERC721: index out of range");
        return _allTokens[index];
    }

    function tokenOfOwnerByIndex(address account, uint256 index) external view returns (uint256) {
        require(index < _ownedTokens[account].length, "ERC721: index out of range");
        return _ownedTokens[account][index];
    }

    function _addOwned(address to, uint256 id) private {
        _ownedIndex[id] = _ownedTokens[to].length;
        _ownedTokens[to].push(id);
    }

    function _removeOwned(address account, uint256 id) private {
        uint256 idx = _ownedIndex[id];
        uint256 last = _ownedTokens[account].length - 1;
        if (idx != last) {
            uint256 moved = _ownedTokens[account][last];
            _ownedTokens[account][idx] = moved;
            _ownedIndex[moved] = idx;
        }
        _ownedTokens[account].pop();
        delete _ownedIndex[id];
    }

    function _removeAll(uint256 id) private {
        uint256 idx = _allIndex[id];
        uint256 last = _allTokens.length - 1;
        if (idx != last) {
            uint256 moved = _allTokens[last];
            _allTokens[idx] = moved;
            _allIndex[moved] = idx;
        }
        _allTokens.pop();
        delete _allIndex[id];
    }
`;
  }
  if (tail) s = s.replace(/\n}$/, tail + '\n}');
  return s;
}

function erc1155Source(f = {}) {
  // Same access quartet as ERC-20/721: Ownable default, Ownable2Step, Roles,
  // Managed (roles + two-step defaultAdmin).
  const acl = f.access === 'accesscontrol';
  const managed = f.access === 'managed';
  const roles = acl || managed;
  const twoStep = f.access === 'ownable2step';
  const mMint = roles ? 'onlyRole(MINTER_ROLE)' : 'onlyOwner';
  const mPause = roles ? 'onlyRole(PAUSER_ROLE)' : 'onlyOwner';
  let s = ERC1155_SOURCE;
  if (f.mintable === false) {
    s = s.replace(`    function mint(address to, uint256 id, uint256 value) external onlyOwner {
        _move(address(0), to, id, value);
    }

`, '');
  }
  // Paused state lands BEHIND the owner line — the access rewrite below
  // only swallows the owner line itself, paused keeps its place.
  if (f.pausable) {
    s = s.replace('    address public owner;\n', '    address public owner;\n    bool public paused;\n');
  }
  if (twoStep && !roles) {
    s = s.replace('    address public owner;\n', '    address public owner;\n    address public pendingOwner;\n');
  }
  if (roles) {
    s = s.replace('    address public owner;\n', `    bytes32 public constant DEFAULT_ADMIN_ROLE = 0x00;
    bytes32 public constant MINTER_ROLE = keccak256("MINTER_ROLE");
    bytes32 public constant PAUSER_ROLE = keccak256("PAUSER_ROLE");
    mapping(bytes32 => mapping(address => bool)) private _roles;
` + (managed ? `    address public defaultAdmin;
    address public pendingDefaultAdmin;
` : ''));
    s = s.replace('        owner = msg.sender;', (managed
      ? `        defaultAdmin = msg.sender;
        _roles[MINTER_ROLE][msg.sender] = true;`
      : `        _roles[DEFAULT_ADMIN_ROLE][msg.sender] = true;
        _roles[MINTER_ROLE][msg.sender] = true;`) + (f.pausable ? `
        _roles[PAUSER_ROLE][msg.sender] = true;` : ''));
    s = s.replace(`    modifier onlyOwner() {
        require(msg.sender == owner, "ERC1155: caller is not owner");
        _;
    }`, `    modifier onlyRole(bytes32 role) {
        require(_roles[role][msg.sender], "ERC1155: missing role");
        _;
    }` + (managed ? `

    modifier onlyDefaultAdmin() {
        require(msg.sender == defaultAdmin, "ERC1155: caller is not default admin");
        _;
    }` : ''));
    s = s.replace('function mint(address to, uint256 id, uint256 value) external onlyOwner {',
      `function mint(address to, uint256 id, uint256 value) external ${mMint} {`);
  }
  if (f.pausable) {
    s = s.replace('    function uri(uint256) external view returns (string memory) {', `    modifier whenNotPaused() {
        require(!paused, "ERC1155: paused");
        _;
    }

    function pause() external ${mPause} {
        paused = true;
    }

    function unpause() external ${mPause} {
        paused = false;
    }

    function uri(uint256) external view returns (string memory) {`);
    s = s.replace('function safeTransferFrom(address from, address to, uint256 id, uint256 value, bytes calldata data) external {',
      'function safeTransferFrom(address from, address to, uint256 id, uint256 value, bytes calldata data) external whenNotPaused {');
    s = s.replace('function safeBatchTransferFrom(address from, address to, uint256[] calldata ids, uint256[] calldata values, bytes calldata data) external {',
      'function safeBatchTransferFrom(address from, address to, uint256[] calldata ids, uint256[] calldata values, bytes calldata data) external whenNotPaused {');
  }
  if (f.burnable) {
    s = s.replace(`        emit TransferSingle(msg.sender, from, to, id, value);
    }
}`, `        emit TransferSingle(msg.sender, from, to, id, value);
    }

    function burn(uint256 id, uint256 value) external {
        address from = msg.sender;
        uint256 bal = _balances[id][from];
        require(bal >= value, "ERC1155: insufficient balance");
        unchecked { _balances[id][from] = bal - value; }
        emit TransferSingle(msg.sender, from, address(0), id, value);
    }
}`);
  }
  let tail = '';
  if (!roles) {
    tail += twoStep ? `
    function transferOwnership(address to) external onlyOwner {
        require(to != address(0), "ERC1155: zero address owner");
        pendingOwner = to;
    }

    function acceptOwnership() external {
        require(msg.sender == pendingOwner, "ERC1155: not pending owner");
        owner = pendingOwner;
        pendingOwner = address(0);
    }
` : `
    function transferOwnership(address to) external onlyOwner {
        require(to != address(0), "ERC1155: zero address owner");
        owner = to;
    }
`;
  } else if (acl) {
    tail += `
    event RoleGranted(bytes32 indexed role, address indexed account, address indexed sender);
    event RoleRevoked(bytes32 indexed role, address indexed account, address indexed sender);

    function hasRole(bytes32 role, address account) public view returns (bool) {
        return _roles[role][account];
    }

    function grantRole(bytes32 role, address account) external onlyRole(DEFAULT_ADMIN_ROLE) {
        _roles[role][account] = true;
        emit RoleGranted(role, account, msg.sender);
    }

    function revokeRole(bytes32 role, address account) external onlyRole(DEFAULT_ADMIN_ROLE) {
        _roles[role][account] = false;
        emit RoleRevoked(role, account, msg.sender);
    }

    function renounceRole(bytes32 role) external {
        _roles[role][msg.sender] = false;
        emit RoleRevoked(role, msg.sender, msg.sender);
    }
`;
  } else {
    // Managed: DEFAULT_ADMIN_ROLE derived from defaultAdmin; two-step handover.
    tail += `
    event RoleGranted(bytes32 indexed role, address indexed account, address indexed sender);
    event RoleRevoked(bytes32 indexed role, address indexed account, address indexed sender);

    function hasRole(bytes32 role, address account) public view returns (bool) {
        return role == DEFAULT_ADMIN_ROLE ? account == defaultAdmin : _roles[role][account];
    }

    function grantRole(bytes32 role, address account) external onlyDefaultAdmin {
        require(role != DEFAULT_ADMIN_ROLE, "ERC1155: use beginDefaultAdminTransfer");
        _roles[role][account] = true;
        emit RoleGranted(role, account, msg.sender);
    }

    function revokeRole(bytes32 role, address account) external onlyDefaultAdmin {
        require(role != DEFAULT_ADMIN_ROLE, "ERC1155: use beginDefaultAdminTransfer");
        _roles[role][account] = false;
        emit RoleRevoked(role, account, msg.sender);
    }

    function renounceRole(bytes32 role) external {
        require(role != DEFAULT_ADMIN_ROLE, "ERC1155: default admin cannot renounce");
        _roles[role][msg.sender] = false;
        emit RoleRevoked(role, msg.sender, msg.sender);
    }

    function beginDefaultAdminTransfer(address newAdmin) external onlyDefaultAdmin {
        require(newAdmin != address(0), "ERC1155: zero address admin");
        pendingDefaultAdmin = newAdmin;
    }

    function acceptDefaultAdminTransfer() external {
        require(msg.sender == pendingDefaultAdmin, "ERC1155: not pending admin");
        defaultAdmin = pendingDefaultAdmin;
        pendingDefaultAdmin = address(0);
    }
`;
  }
  if (tail) s = s.replace(/\n}$/, tail + '\n}');
  return s;
}

// Compose the source the deploy step compiles. `buildTokenSource(id)` with
// no flags returns exactly the shipped template (default path = today).
// ═══════════════ M9 — UPGRADEABILITY (ERC-1967 proxy) ═══════════════
//
// What the "Upgradeable" flag does to the generated code:
//   1. `constructor(args)` becomes `function initialize(args) external
//      initializer` — a proxy's storage starts at zero, so the initialisation
//      has to run THROUGH the proxy, not on the implementation.
//   2. `immutable` is dropped (decimals / cap): an immutable is baked into the
//      implementation's BYTECODE, and initialize() cannot assign one through
//      delegatecall — solc rejects that outright.
//   3. The implementation keeps its own no-arg constructor that locks
//      `_initialized = 1` (OZ: disableInitializers), so nobody can
//      pre-initialise the logic contract and squat on it.
//   4. UUPS: `upgradeToAndCall` lands IN the implementation, gated by the
//      contract's own authority (onlyOwner / the role admin) or — when the
//      token has no owner at all (all-off wizard) — by a dedicated,
//      transferable `upgrader`. A gate must exist: a UUPS proxy nobody can
//      upgrade is a dead end, and a UUPS proxy EVERYBODY can upgrade is a
//      takeover. Transparent: no upgrade code in the implementation; the
//      proxy's admin does it.
//   5. A minimal `ERC1967Proxy` is appended — one contract for both modes
//      (EIP-1967 implementation + admin slots, `ifAdmin` transparent rule).
//
// TWO TRANSACTIONS, and the second one is NOT "call initialize()": the proxy
// constructor delegatecalls initialize in the SAME transaction as the deploy.
// A separate initialise call would leave a publicly-callable, uninitialized
// proxy sitting there for one block — anybody could call initialize(first) and
// own the token. Deploy-impl then deploy-proxy-with-init-data = atomic.
export const PROXY_CONTRACT = 'ERC1967Proxy';
export const PROXY_TYPES = ['uups', 'transparent'];
export const PROXY_TYPE_OPTIONS = [
  { v: 'uups', label: 'UUPS — upgrade logic lives in the implementation' },
  { v: 'transparent', label: 'Transparent — upgrade logic lives in the proxy (admin)' },
];

// Index of the `}` closing `contract <name> {`. String- and comment-aware, so
// a `{id}` inside a metadata URI (ERC-1155) or a brace in a comment can never
// be mistaken for a code brace — that bug would splice code into the wrong place.
function contractEndIndex(s, name) {
  const head = new RegExp(`contract\\s+${name}\\s*\\{`).exec(s);
  if (!head) return -1;
  let i = head.index + head[0].length - 1;
  let depth = 0;
  let mode = 'code';
  for (; i < s.length; i++) {
    const c = s[i];
    const n = s[i + 1];
    if (mode === 'line') { if (c === '\n') mode = 'code'; continue; }
    if (mode === 'block') { if (c === '*' && n === '/') { mode = 'code'; i++; } continue; }
    if (mode === 'str') { if (c === '\\') { i++; continue; } if (c === '"') mode = 'code'; continue; }
    if (c === '/' && n === '/') { mode = 'line'; i++; continue; }
    if (c === '/' && n === '*') { mode = 'block'; i++; continue; }
    if (c === '"') { mode = 'str'; continue; }
    if (c === '{') depth++;
    else if (c === '}') { depth -= 1; if (depth === 0) return i; }
  }
  return -1;
}

// The guard (state + modifier + the implementation's own lock, plus the
// `upgrader` authority when the token has no owner to gate upgrades with).
function initializerGuard(needsUpgrader) {
  return `    // ── M9: initializer guard ─────────────────────────────────────────────
    // A proxy's storage starts at zero, so initialize() may run exactly once
    // through it. The implementation itself is locked by the constructor below.
    uint8 private _initialized;
    bool private _initializing;

    // Indexers see a proxy with no initialisation record otherwise — the event
    // is the only proof, from inside the contract, that the token was set up.
    event Initialized(uint64 version);

    modifier initializer() {
        require(!_initializing && _initialized == 0, "INIT: already initialized");
        _initializing = true;
        _initialized = 1;
        _;
        _initializing = false;
    }

    constructor() {
        _initialized = 1;
    }
` + (needsUpgrader ? `
    // Upgrade authority for a token with NO owner (all-off wizard): a
    // dedicated, transferable upgrader. Without it a UUPS proxy has no gate
    // at all; a permanent one would be an accidental lock-out.
    address public upgrader;
    event UpgraderChanged(address indexed previousUpgrader, address indexed newUpgrader);

    modifier onlyUpgrader() {
        require(msg.sender == upgrader, "UPG: caller is not the upgrader");
        _;
    }

    function setUpgrader(address newUpgrader) external onlyUpgrader {
        require(newUpgrader != address(0), "UPG: zero upgrader");
        emit UpgraderChanged(upgrader, newUpgrader);
        upgrader = newUpgrader;
    }
` : '');
}

// UUPS: the upgrade entry point, inside the implementation. Called through the
// proxy, the sstore lands in the PROXY's ERC-1967 implementation slot.
function uupsBlock(gate) {
  return `
    // ── M9: UUPS upgrade entry point ─────────────────────────────────────────
    // Every replacement implementation must keep this function, or the proxy
    // can never be upgraded again (that is the UUPS trade: the gate travels
    // with the code instead of living in the proxy).
    bytes32 private constant _IMPL_SLOT = 0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc;
    event Upgraded(address indexed implementation);

    function upgradeToAndCall(address newImplementation, bytes calldata data) external payable ${gate} {
        require(newImplementation != address(0), "UUPS: zero implementation");
        require(newImplementation.code.length > 0, "UUPS: implementation has no code");
        bytes32 slot = _IMPL_SLOT;
        assembly { sstore(slot, newImplementation) }
        if (data.length > 0) {
            (bool ok, bytes memory ret) = newImplementation.delegatecall(data);
            if (!ok) { assembly { revert(add(ret, 32), mload(ret)) } }
        }
        emit Upgraded(newImplementation);
    }
`;
}

// The minimal ERC-1967 proxy — one contract, both modes. admin = address(0)
// for UUPS (nobody is the admin, everything delegates); admin = the deployer
// for Transparent (the four admin selectors live on the proxy, and every other
// call — the admin's own included — is delegated, so the deployer stays a
// normal user of its token; see the fallback comment inside PROXY_SOURCE).
const PROXY_SOURCE = `
// ═══════════════ Minimal ERC-1967 proxy (M9) ═══════════════
contract ERC1967Proxy {
    bytes32 private constant _IMPL_SLOT = 0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc;
    bytes32 private constant _ADMIN_SLOT = 0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103;

    event Upgraded(address indexed implementation);
    event AdminChanged(address previousAdmin, address newAdmin);

    constructor(address implementation_, bytes memory data, address admin_) payable {
        require(implementation_ != address(0), "PROXY: zero implementation");
        require(implementation_.code.length > 0, "PROXY: implementation has no code");
        bytes32 iSlot = _IMPL_SLOT;
        bytes32 aSlot = _ADMIN_SLOT;
        assembly {
            sstore(iSlot, implementation_)
            sstore(aSlot, admin_)
        }
        emit AdminChanged(address(0), admin_);
        // The initialisation is part of the deploy: no block in which a proxy
        // exists and anyone can initialize it first.
        if (data.length > 0) {
            (bool ok, bytes memory ret) = implementation_.delegatecall(data);
            if (!ok) { assembly { revert(add(ret, 32), mload(ret)) } }
        }
        emit Upgraded(implementation_);
    }

    // EIP-1967 transparent rule: the admin reaches the four functions below,
    // everyone else falls through to the implementation — so a user hitting an
    // admin selector is simply a call to the token, not a special case.
    // The four names are the only selectors that live on the proxy, and none of
    // them may exist on the token itself (a clash would hide the token's own
    // function from everyone) — the tests check that.
    modifier ifAdmin() {
        if (msg.sender == _admin()) { _; }
        else { _delegate(_implementation()); }
    }

    function admin() external ifAdmin returns (address) { return _admin(); }
    function implementation() external ifAdmin returns (address) { return _implementation(); }

    function changeAdmin(address newAdmin) external ifAdmin {
        require(newAdmin != address(0), "PROXY: zero admin");
        emit AdminChanged(_admin(), newAdmin);
        bytes32 aSlot = _ADMIN_SLOT;
        assembly { sstore(aSlot, newAdmin) }
    }

    function upgradeTo(address newImplementation) external ifAdmin {
        _setImplementation(newImplementation);
    }

    function upgradeToAndCall(address newImplementation, bytes calldata data) external payable ifAdmin {
        _setImplementation(newImplementation);
        if (data.length > 0) {
            (bool ok, bytes memory ret) = newImplementation.delegatecall(data);
            if (!ok) { assembly { revert(add(ret, 32), mload(ret)) } }
        }
    }

    function _setImplementation(address newImplementation) internal {
        require(newImplementation != address(0), "PROXY: zero implementation");
        require(newImplementation.code.length > 0, "PROXY: implementation has no code");
        bytes32 iSlot = _IMPL_SLOT;
        assembly { sstore(iSlot, newImplementation) }
        emit Upgraded(newImplementation);
    }

    function _admin() internal view returns (address a) {
        bytes32 aSlot = _ADMIN_SLOT;
        assembly { a := sload(aSlot) }
    }

    function _implementation() internal view returns (address i) {
        bytes32 iSlot = _IMPL_SLOT;
        assembly { i := sload(iSlot) }
    }

    function _delegate(address implementation_) internal {
        assembly {
            calldatacopy(0, 0, calldatasize())
            let result := delegatecall(gas(), implementation_, 0, calldatasize(), 0, 0)
            returndatacopy(0, 0, returndatasize())
            switch result
            case 0 { revert(0, returndatasize()) }
            default { return(0, returndatasize()) }
        }
    }

    // Fallback delegates for EVERYONE — including the admin. This is a
    // deliberate, documented deviation from OZ's TransparentUpgradeableProxy,
    // which reverts here for the admin ("admin cannot fallback"): in this wallet
    // the admin IS the deployer, i.e. the account that must then mint, transfer
    // and burn its own token. Blocking that call would ship a token its owner
    // cannot spend. UUPS has no admin at all (address(0)), so this branch never
    // concerns it either way.
    fallback() external payable {
        _delegate(_implementation());
    }
}
`;

/**
 * Turn a generated token source into its upgradeable shape.
 * @param {string} source   output of erc20Source/erc721Source/erc1155Source
 * @param {string} contractName  the token contract to convert
 * @param {'uups'|'transparent'} [proxyType]
 * @returns {string} the token contract (converted) + ERC1967Proxy
 */
export function makeUpgradeable(source, contractName, proxyType = 'uups') {
  const type = PROXY_TYPES.includes(proxyType) ? proxyType : 'uups';
  let s = String(source).replace(/public immutable /g, 'public ');

  const findHead = () => {
    const m = new RegExp(`contract\\s+${contractName}\\s*\\{`).exec(s);
    if (!m) throw new Error(`makeUpgradeable: contract ${contractName} not found`);
    return m;
  };

  // The gate is read back from the code that was actually generated: the
  // wizard's access select decides which modifier exists, so the upgrade path
  // reuses the SAME authority instead of inventing a second one.
  const gate = /modifier onlyDefaultAdmin\(/.test(s) ? 'onlyDefaultAdmin'
    : /modifier onlyRole\(/.test(s) ? 'onlyRole(DEFAULT_ADMIN_ROLE)'
      : /modifier onlyOwner\(/.test(s) ? 'onlyOwner'
        : null;
  const needsUpgrader = type === 'uups' && gate === null;

  // constructor(...) { → function initialize(...) external initializer {
  const head1 = findHead();
  const at = s.indexOf('constructor(', head1.index);
  if (at < 0) throw new Error('makeUpgradeable: no constructor to turn into initialize()');
  let end = -1;
  let depth = 0;
  for (let j = at + 'constructor'.length; j < s.length; j++) {
    if (s[j] === '(') depth++;
    else if (s[j] === ')') { depth -= 1; if (depth === 0) { end = j; break; } }
  }
  if (end < 0) throw new Error('makeUpgradeable: unbalanced constructor parameters');
  const params = s.slice(at + 'constructor('.length, end);
  const braceAt = s.indexOf('{', end);
  if (braceAt < 0 || !/^\s*$/.test(s.slice(end + 1, braceAt))) {
    throw new Error('makeUpgradeable: constructor has modifiers — transform not supported');
  }
  // First statement is always the event (indexers need it), then — when there
  // is no owner to gate upgrades — the dedicated upgrader.
  const bodyLead = '\n        emit Initialized(1);'
    + (needsUpgrader ? '\n        upgrader = msg.sender;' : '');
  s = s.slice(0, at) + `function initialize(${params}) external initializer {${bodyLead}` + s.slice(braceAt + 1);

  // Guard (state + modifier + impl lock [+ upgrader]) right after the header.
  const head2 = findHead();
  const atHead = head2.index + head2[0].length;
  s = s.slice(0, atHead) + '\n' + initializerGuard(needsUpgrader) + s.slice(atHead);

  // UUPS entry point before the contract's closing brace.
  if (type === 'uups') {
    const endIdx = contractEndIndex(s, contractName);
    if (endIdx < 0) throw new Error(`makeUpgradeable: could not close contract ${contractName}`);
    s = s.slice(0, endIdx) + uupsBlock(gate || 'onlyUpgrader') + s.slice(endIdx);
  }

  return s + '\n\n' + PROXY_SOURCE;
}

export function buildTokenSource(standardId, flags = {}) {
  const std = getStandard(standardId);
  const base = standardId === 'erc721' ? erc721Source(flags)
    : standardId === 'erc1155' ? erc1155Source(flags)
      : erc20Source(flags);
  return flags.upgradeable ? makeUpgradeable(base, std.contract, flags.proxyType) : base;
}

// ── wizard metadata ──
// OZ wizard "access" select (ownable / ownable2step / accessControl) plus the
// Managed choice (2026-10-04 report: "Akses Ownable/Roles/Managed") —
// Managed = OZ AccessControlDefaultAdminRules flavour: MINTER/PAUSER roles
// administered by a defaultAdmin whose handover is TWO-STEP (begin/accept).
const ACCESS_OPTIONS = [
  { v: 'ownable', label: 'Ownable — single-step transferOwnership' },
  { v: 'ownable2step', label: 'Ownable2Step — transfer, then accept' },
  { v: 'accesscontrol', label: 'Roles — MINTER/PAUSER roles, admin role' },
  { v: 'managed', label: 'Managed — roles + defaultAdmin two-step transfer' },
];
// solc 0.8.37 accepted EVM versions (M6 matrix: all 14 compile, default =
// osaka). First option is the wizard default and passes 'osaka' explicitly —
// M6 proved explicit osaka ≡ compiler default (bitwise identical).
export const EVM_VERSIONS = [
  { v: 'osaka', label: 'Default (osaka)' },
  { v: 'prague', label: 'Prague' },
  { v: 'cancun', label: 'Cancun' },
  { v: 'shanghai', label: 'Shanghai' },
  { v: 'paris', label: 'Paris' },
  { v: 'london', label: 'London' },
  { v: 'berlin', label: 'Berlin' },
  { v: 'istanbul', label: 'Istanbul' },
  { v: 'petersburg', label: 'Petersburg' },
  { v: 'constantinople', label: 'Constantinople' },
  { v: 'byzantium', label: 'Byzantium' },
  { v: 'spuriousDragon', label: 'Spurious Dragon' },
  { v: 'tangerineWhistle', label: 'Tangerine Whistle' },
  { v: 'homestead', label: 'Homestead' }
];
const EVM_ALLOW = new Set(EVM_VERSIONS.map((o) => o.v));

// Read the compiler-configuration fields off a plan/form and return opts for
// compileContract(). Throws user-facing Errors on junk — empty/absent means
// "wizard default" (Solidity / osaka / optimizer on / 200 runs), so the flag-
// off path compiles exactly like before M7.
export function parseCompilerOptions({ language, evmVersion, optimizer, runs } = {}) {
  const lang = String(language ?? '').trim() || 'Solidity';
  if (lang !== 'Solidity') throw new Error('Language must be Solidity');
  const evm = String(evmVersion ?? '').trim() || 'osaka';
  if (!EVM_ALLOW.has(evm)) throw new Error(`Unsupported EVM version: ${evm}`);
  // Toggle absent from the form (older view / test seam) = enabled.
  const opt = optimizer === undefined || optimizer === null ? true : Boolean(optimizer);
  const runsStr = String(runs ?? '').trim() || '200';
  if (!/^\d+$/.test(runsStr)) throw new Error('Optimizer runs must be a whole number');
  const runsNum = Number(runsStr);
  if (!Number.isSafeInteger(runsNum) || runsNum > 4294967295) throw new Error('Optimizer runs must fit uint32 (0–4294967295)');
  return { language: lang, evmVersion: evm, optimizer: opt, runs: runsNum };
}

const accessField = () => ({
  id: 'deployAccess', label: 'Ownership access', type: 'select',
  value: 'ownable', options: ACCESS_OPTIONS
});
export const STANDARDS = {
  erc20: {
    id: 'erc20',
    label: 'ERC-20 (fungible token)',
    contract: 'BearERC20',
    source: ERC20_SOURCE,
    preview: 'ERC-20 Token Contract',
    icon: '🪙',
    fields: [
      // Premint presets (report: "preset 100m,500m,1b,100b") — pills fill the
      // manual input, which stays editable (custom supply still allowed).
      { id: 'deploySupply', label: 'Initial supply', type: 'number', placeholder: '1000000', value: '1000000',
        presets: [['100M', '100000000'], ['500M', '500000000'], ['1B', '1000000000'], ['100B', '100000000000']] },
      { id: 'deployDecimals', label: 'Decimals', type: 'number', value: '18', min: 0, max: 18 },
      { id: 'deployCap', label: 'Cap (max supply, empty = unlimited)', type: 'number', placeholder: 'none' },
      // OZ order (ERC20Controls.svelte): Mintable → Burnable → Pausable → Permit → Votes.
      { id: 'deployMintable', label: 'Mintable (owner can mint more)', type: 'checkbox' },
      { id: 'deployBurnable', label: 'Burnable (holders can burn their own)', type: 'checkbox' },
      { id: 'deployPausable', label: 'Pausable (owner can pause transfers)', type: 'checkbox' },
      { id: 'deployPermit', label: 'Permit (EIP-2612 gasless approvals)', type: 'checkbox' },
      { id: 'deployVotes', label: 'Votes (delegation + checkpoints for governance)', type: 'checkbox' },
      // Report: "tombol Callback / Flash Minting" — ERC-1363 transferAndCall
      // receiver hook + ERC-3156 flash minting of the token's own supply.
      { id: 'deployCallback', label: 'Callback (ERC-1363 transferAndCall hook)', type: 'checkbox' },
      { id: 'deployFlashMint', label: 'Flash Minting (ERC-3156 flash loans)', type: 'checkbox' },
      // Effective only when mintable/pausable give the contract an owner.
      accessField(),
      // M9 upgradeability: the proxy options come BEFORE the compiler block —
      // they change WHAT gets deployed (impl + proxy), not how it compiles.
      { type: 'section', label: 'Upgradeability' },
      { id: 'deployUpgradeable', label: 'Upgradeable (ERC-1967 proxy + initialize)', type: 'checkbox' },
      { id: 'deployProxyType', label: 'Proxy type', type: 'select', value: 'uups', options: PROXY_TYPE_OPTIONS, disabled: true },
      // Report: "fitur compiler configuration" — solc knobs on the wizard form
      // (deploy.js → parseCompilerOptions → compileContract passthrough, M6).
      { type: 'section', label: 'Compiler configuration' },
      { id: 'deployLanguage', label: 'Language', type: 'select', value: 'Solidity',
        options: [{ v: 'Solidity', label: 'Solidity' }] },
      { id: 'deployEvmVersion', label: 'EVM version', type: 'select', value: 'osaka',
        options: EVM_VERSIONS },
      { id: 'deployOptimizer', label: 'Optimization', type: 'toggle', value: true, inlineWith: 'deployRuns' },
      { id: 'deployRuns', label: 'Runs', type: 'number', value: '200', min: 0, max: 4294967295 }
    ]
  },
  erc721: {
    id: 'erc721',
    label: 'ERC-721 (NFT collection)',
    contract: 'BearERC721',
    source: ERC721_SOURCE,
    preview: 'ERC-721 NFT Contract',
    icon: '🖼️',
    fields: [
      { id: 'deployBaseUri', label: 'Base URI', type: 'text', placeholder: 'ipfs://…/' },
      // Report: image URL → on-chain fallback metadata (data:application/json
      // base64) when Base URI is empty. Empty = the shipped 3-arg template.
      { id: 'deployImage', label: 'Image URL (fallback metadata when Base URI is empty)', type: 'text', placeholder: 'https://…/bear.png' },
      { id: 'deployMintable', label: 'Mintable (owner can mint)', type: 'checkbox', value: true },
      // Token id assignment: ON = auto-increment (today's behaviour), OFF =
      // mint(to, id) so the deployer/community picks each id (allowlist, 1:1s).
      { id: 'deployAutoInc', label: 'Auto-increment ids (off = mint(to, id))', type: 'checkbox', value: true },
      { id: 'deployBurnable', label: 'Burnable (holders can burn)', type: 'checkbox' },
      { id: 'deployPausable', label: 'Pausable (owner can pause transfers)', type: 'checkbox' },
      { id: 'deployEnumerable', label: 'Enumerable (on-chain owner/index tracking)', type: 'checkbox' },
      { id: 'deployUriStorage', label: 'URI storage (custom tokenURI per token)', type: 'checkbox' },
      accessField(),
      // M9: same proxy options as ERC-20 (initialize + ERC-1967 proxy).
      { type: 'section', label: 'Upgradeability' },
      { id: 'deployUpgradeable', label: 'Upgradeable (ERC-1967 proxy + initialize)', type: 'checkbox' },
      { id: 'deployProxyType', label: 'Proxy type', type: 'select', value: 'uups', options: PROXY_TYPE_OPTIONS, disabled: true },
      // M8: the ERC-721 wizard gets the same solc knobs as ERC-20.
      { type: 'section', label: 'Compiler configuration' },
      { id: 'deployLanguage', label: 'Language', type: 'select', value: 'Solidity',
        options: [{ v: 'Solidity', label: 'Solidity' }] },
      { id: 'deployEvmVersion', label: 'EVM version', type: 'select', value: 'osaka',
        options: EVM_VERSIONS },
      { id: 'deployOptimizer', label: 'Optimization', type: 'toggle', value: true, inlineWith: 'deployRuns' },
      { id: 'deployRuns', label: 'Runs', type: 'number', value: '200', min: 0, max: 4294967295 }
    ]
  },
  erc1155: {
    id: 'erc1155',
    label: 'ERC-1155 (multi-token)',
    contract: 'BearERC1155',
    source: ERC1155_SOURCE,
    preview: 'ERC-1155 Multi-Token Contract',
    icon: '🎟️',
    fields: [
      { id: 'deployBaseUri', label: 'Metadata URI', type: 'text', placeholder: 'ipfs://…/{id}.json' },
      { id: 'deployMintable', label: 'Mintable (owner can mint)', type: 'checkbox', value: true },
      { id: 'deployBurnable', label: 'Burnable (holders can burn)', type: 'checkbox' },
      { id: 'deployPausable', label: 'Pausable (owner can pause transfers)', type: 'checkbox' },
      accessField(),
      // M9: ERC-1155 gets the same proxy options (it has no compiler block).
      { type: 'section', label: 'Upgradeability' },
      { id: 'deployUpgradeable', label: 'Upgradeable (ERC-1967 proxy + initialize)', type: 'checkbox' },
      { id: 'deployProxyType', label: 'Proxy type', type: 'select', value: 'uups', options: PROXY_TYPE_OPTIONS, disabled: true }
    ]
  }};

export function getStandard(id) {
  return STANDARDS[id] || STANDARDS.erc20;
}

// Markup for the per-standard extra fields (name/symbol stay in index.html).
export function extraFieldsHtml(id) {
  const std = getStandard(id);
  const out = [];
  const pills = [];
  const flushPills = () => {
    if (!pills.length) return;
    // One "Features" group (OZ's checkbox-group): toggles sit side by side
    // instead of each eating a full form row.
    out.push(`<div class="feature-group" role="group" aria-label="Features">${pills.join('')}</div>`);
    pills.length = 0;
  };
  // Optimizer toggle renders INSIDE the runs row (report: "tombol optimization
  // samping kolom input"), so its own field entry is skipped when reached.
  const inlinedToggles = new Set(std.fields.filter((f) => f.inlineWith).map((f) => f.id));
  for (const f of std.fields) {
    if (f.type === 'section') {
      // Report: "fitur compiler configuration" — a visible sub-heading, not a field.
      flushPills();
      out.push(`<div class="wizard-section-title" role="heading" aria-level="3">${f.label}</div>`);
      continue;
    }
    if (inlinedToggles.has(f.id)) continue;
    // Feature toggles (OZ parity): pill BUTTONS, not a naked checkbox —
    // live report: "kasih tombol aja jangan kotak". The input stays in the
    // DOM (deploy.js reads .checked, tests pin type=checkbox) but is visually
    // replaced by the label pill; the parenthetical description becomes a
    // tooltip, like the wizard's short name + HelpTooltip.
    if (f.type === 'checkbox') {
      const m = /^(.+?)\s*\((.+)\)$/.exec(f.label) || [null, f.label, null];
      pills.push(
        `<label class="toggle-pill" for="${f.id}"${m[2] ? ` title="${m[2]}"` : ''}>` +
        `<input type="checkbox" id="${f.id}"${f.value ? ' checked' : ''}> ${m[1]}</label>`);
      continue;
    }
    if (f.type === 'toggle') {
      // Standalone pill toggle that never reaches here (inlineWith) — kept
      // for completeness if a future toggle has no partner input.
      pills.push(
        `<label class="toggle-pill" for="${f.id}">` +
        `<input type="checkbox" id="${f.id}"${f.value ? ' checked' : ''}> ${f.label}</label>`);
      continue;
    }
    if (f.type === 'select') {
      // Wizard-style select (Ownership access): options carry their own
      // descriptions, so no pill parser — flush the pill group first.
      flushPills();
      out.push(`
      <div class="field">
        <label for="${f.id}">${f.label}</label>
        <select class="select" id="${f.id}"${f.disabled ? ' disabled' : ''}>` +
        (f.options || []).map((o) => `          <option value="${o.v}"${o.v === f.value ? ' selected' : ''}>${o.label}</option>`).join('\n') + `
        </select>
      </div>`);
      continue;
    }
    flushPills();
    // `x.inlineWith === f.id` = a toggle declared to sit beside THIS input
    // (report: "tombol optimization samping kolom input").
    const partner = std.fields.find((x) => x.inlineWith === f.id) || null;
    const presets = (f.presets || []).map(
      ([label, val]) => `<button type="button" class="toggle-pill preset-pill" data-preset-for="${f.id}" data-preset="${val}">${label}</button>`
    ).join('');
    const input = `
        <input class="input" id="${f.id}" type="${f.type}"
          ${f.placeholder ? `placeholder="${f.placeholder}"` : ''}
          ${f.value !== undefined ? `value="${f.value}"` : ''}
          ${f.min !== undefined ? `min="${f.min}"` : ''}
          ${f.max !== undefined ? `max="${f.max}"` : ''}>`;
    if (partner) {
      // One row: pill left, input right — same line, per the report.
      out.push(`
      <div class="field">
        <label for="${f.id}">${f.label}</label>
        <div class="field-inline">
          <label class="toggle-pill" for="${partner.id}"><input type="checkbox" id="${partner.id}"${partner.value ? ' checked' : ''}> ${partner.label}</label>${input}
        </div>
      </div>`);
      continue;
    }
    out.push(`
      <div class="field">
        ${presets ? `<div class="feature-group" role="group" aria-label="Premint presets">${presets}</div>` : ''}
        <label for="${f.id}">${f.label}</label>${input}
      </div>`);
  }
  flushPills();
  return out.join('');
}

// Validate the form and return { name, symbol, args, flags, compiler } for
// the constructor. Throws Error with a user-facing message — the wizard shows
// it as-is. `flags` drives buildTokenSource (OZ-parity feature toggles);
// `compiler` (language/evmVersion/optimizer/runs) feeds compileContract.
export function buildDeployPlan({ standard, name, symbol, supply, decimals, baseUri, cap, burnable, mintable, pausable, permit, votes, enumerable, uriStorage, access: accessIn, callback, flashmint, language, evmVersion, optimizer, runs, autoInc, image, upgradeable, proxyType }) {
  const std = getStandard(standard);
  // Unknown/absent access value falls back to the wizard default (Ownable).
  const access = ACCESS_OPTIONS.some((o) => o.v === accessIn) ? accessIn : 'ownable';
  const accessLabel = () => (ACCESS_OPTIONS.find((o) => o.v === access)?.label || '').split(' — ')[0];
  // Report: "Symbol (auto kapital semua)" — uppercased once, here, so every
  // consumer (args, summary, saveDeployed) sees the same value.
  const cleanName = String(name || '').trim();
  const cleanSymbol = String(symbol || '').trim().toUpperCase();
  if (!cleanName) throw new Error('Enter a token name');
  if (cleanName.length > 64) throw new Error('Name must be 64 characters or fewer');
  if (!cleanSymbol) throw new Error('Enter a token symbol');
  if (cleanSymbol.length > 16) throw new Error('Symbol must be 16 characters or fewer');
  if (!/^[A-Z0-9._-]+$/.test(cleanSymbol)) throw new Error('Symbol may only contain letters, digits, . _ -');
  // Compiler configuration (report: "fitur compiler configuration") — throws
  // on junk; absent fields = wizard defaults (Solidity/osaka/on/200).
  const compiler = parseCompilerOptions({ language, evmVersion, optimizer, runs });
  // M9 upgradeability. An unknown/absent proxy type falls back to UUPS (the
  // wizard default) — never to "no proxy": the flag said upgradeable, so a
  // proxy is what gets deployed.
  const upg = Boolean(upgradeable);
  const pType = PROXY_TYPES.includes(proxyType) ? proxyType : 'uups';
  const proxyLabel = upg ? `ERC-1967 (${pType === 'uups' ? 'UUPS' : 'Transparent'})` : '';

  if (std.id === 'erc20') {
    const dec = Number(decimals);
    if (!Number.isInteger(dec) || dec < 0 || dec > 18) throw new Error('Decimals must be a whole number from 0 to 18');
    const supplyStr = String(supply ?? '').trim();
    if (!/^\d+$/.test(supplyStr)) throw new Error('Initial supply must be a whole number');
    if (BigInt(supplyStr) <= 0n) throw new Error('Initial supply must be greater than zero');
    // Cap (OZ-parity): optional whole number, at least the premint — a cap
    // below supply would make the very first Transfer revert on-chain.
    const capRaw = String(cap ?? '').trim();
    const flags = {
      burnable: Boolean(burnable),
      mintable: Boolean(mintable),
      pausable: Boolean(pausable),
      permit: Boolean(permit),
      votes: Boolean(votes),
      // Report: "tombol Callback / Flash Minting" — ERC-1363 hook, ERC-3156.
      callback: Boolean(callback),
      flashmint: Boolean(flashmint),
      // M9: the proxy flags ride with the rest — they change the SOURCE too.
      upgradeable: upg,
      proxyType: pType,
      cap: capRaw,
      access
    };
    if (capRaw) {
      if (!/^\d+$/.test(capRaw)) throw new Error('Cap must be a whole number');
      if (BigInt(capRaw) <= 0n) throw new Error('Cap must be greater than zero');
      if (BigInt(capRaw) < BigInt(supplyStr)) throw new Error('Cap must be at least the initial supply');
    }
    const args = [cleanName, cleanSymbol, dec, ethers.parseUnits(supplyStr, dec)];
    if (capRaw) args.push(ethers.parseUnits(capRaw, dec));
    const summary = [
      { k: 'Standard', v: 'ERC-20' },
      { k: 'Name', v: cleanName },
      { k: 'Symbol', v: cleanSymbol },
      { k: 'Decimals', v: String(dec) },
      { k: 'Supply', v: `${supplyStr} ${cleanSymbol}` }
    ];
    if (capRaw) summary.push({ k: 'Cap', v: `${capRaw} ${cleanSymbol}` });
    if (flags.mintable || flags.pausable) summary.push({ k: 'Access', v: accessLabel() });
    const on = [flags.burnable && 'Burnable', flags.mintable && 'Mintable', flags.pausable && 'Pausable',
      flags.permit && 'Permit', flags.votes && 'Votes',
      flags.callback && 'Callback', flags.flashmint && 'Flash Minting'].filter(Boolean);
    if (on.length) summary.push({ k: 'Features', v: on.join(', ') });
    // M9: the proxy is part of what gets deployed — it belongs in the summary
    // the signer reads before approving the transaction.
    if (upg) summary.push({ k: 'Proxy', v: proxyLabel });
    return { standard: std.id, name: cleanName, symbol: cleanSymbol, args, flags, compiler, summary };
  }

  const uri = String(baseUri || '').trim();
  // NFT standards: mintable defaults ON (their template has always minted);
  // unchecked → false, checked/absent → true.
  const nftFlags = { mintable: mintable !== false, burnable: Boolean(burnable), pausable: Boolean(pausable), access, upgradeable: upg, proxyType: pType };
  if (std.id === 'erc721') {
    nftFlags.enumerable = Boolean(enumerable);
    nftFlags.uriStorage = Boolean(uriStorage);
    // Token id assignment (M8): checked/absent = the auto-incrementing mint
    // that ships today; unchecked = the deployer passes each id.
    nftFlags.autoInc = autoInc !== false;
    // Fallback metadata image (M8): escaped ONCE here so the generated JSON
    // can never be broken by a quote or backslash in the URL.
    const rawImage = String(image ?? '').trim();
    if (rawImage.length > 512) throw new Error('Image URL must be 512 characters or fewer');
    if (/["\\\u0000-\u001f]/.test(rawImage)) throw new Error('Image URL may not contain quotes, backslashes or control characters');
    nftFlags.image = rawImage;
  }
  const nftFeatures = [nftFlags.burnable && 'Burnable', nftFlags.mintable && 'Mintable', nftFlags.pausable && 'Pausable',
    nftFlags.enumerable && 'Enumerable', nftFlags.uriStorage && 'URI storage'].filter(Boolean);
  if (std.id === 'erc721') {
    if (!nftFlags.autoInc) nftFeatures.push('Manual ids');
    const summary = [
      { k: 'Standard', v: 'ERC-721' },
      { k: 'Name', v: cleanName },
      { k: 'Symbol', v: cleanSymbol },
      { k: 'Base URI', v: uri || '(empty)' }
    ];
    if (nftFlags.image) summary.push({ k: 'Fallback image', v: nftFlags.image });
    summary.push({ k: 'Access', v: accessLabel() });
    if (nftFeatures.length) summary.push({ k: 'Features', v: nftFeatures.join(', ') });
    if (upg) summary.push({ k: 'Proxy', v: proxyLabel });
    // The image rides in as the FOURTH constructor argument — only when set,
    // so the empty case compiles the exact 3-arg template that ships today.
    const args = [cleanName, cleanSymbol, uri];
    if (nftFlags.image) args.push(nftFlags.image);
    return { standard: std.id, name: cleanName, symbol: cleanSymbol, args, flags: nftFlags, compiler, summary };
  }
  const summary = [
    { k: 'Standard', v: 'ERC-1155' },
    { k: 'Name', v: cleanName },
    { k: 'Symbol', v: cleanSymbol },
    { k: 'Metadata URI', v: uri || '(empty)' }
  ];
  if (nftFeatures.length) summary.push({ k: 'Features', v: nftFeatures.join(', ') });
  if (upg) summary.push({ k: 'Proxy', v: proxyLabel });
  return { standard: std.id, name: cleanName, symbol: cleanSymbol, args: [cleanName, cleanSymbol, uri], flags: nftFlags, compiler, summary };
}
