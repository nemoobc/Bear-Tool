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
pragma solidity ^0.8.28;

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
pragma solidity ^0.8.28;

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
pragma solidity ^0.8.28;

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
// The OpenZeppelin wizard toggles burnable/mintable/pausable/cap
// (github.com/OpenZeppelin/contracts-wizard). The browser solc has no
// import resolver, so Ownable/Pausable cannot be imported — the same
// features are generated INLINE onto the templates above. Flag-off output
// is byte-identical to the shipped template, so the default path never
// changes. ERC-20 gains an owner only when mintable or pausable asks for
// one; the default ERC-20 stays ownerless like today.

function erc20Source(f = {}) {
  const owner = Boolean(f.mintable || f.pausable);
  const capStr = String(f.cap ?? '').trim();
  const hasCap = /^\d+$/.test(capStr) && BigInt(capStr) > 0n;
  let s = ERC20_SOURCE;

  if (owner || f.pausable || hasCap) {
    const state =
      (hasCap ? '    uint256 public immutable cap;\n' : '') +
      (owner ? '    address public owner;\n' : '') +
      (f.pausable ? '    bool public paused;\n' : '');
    s = s.replace('    uint256 public totalSupply;\n',
      '    uint256 public totalSupply;\n' + state);
  }
  if (hasCap) {
    s = s.replace('uint8 _decimals, uint256 _supply)',
      'uint8 _decimals, uint256 _supply, uint256 _cap)');
  }
  if (owner || hasCap) {
    const ctor =
      (hasCap ? '        require(_cap >= _supply, "ERC20: cap below initial supply");\n        cap = _cap;\n' : '') +
      (owner ? '        owner = msg.sender;\n' : '');
    s = s.replace('        totalSupply = _supply;', ctor + '        totalSupply = _supply;');
  }
  if (owner || f.pausable) {
    const mods =
      (owner ? `
    modifier onlyOwner() {
        require(msg.sender == owner, "ERC20: caller is not owner");
        _;
    }
` : '') +
      (f.pausable ? `
    modifier whenNotPaused() {
        require(!paused, "ERC20: paused");
        _;
    }

    function pause() external onlyOwner {
        paused = true;
    }

    function unpause() external onlyOwner {
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

  let extra = '';
  if (f.burnable) {
    extra += `
    function burn(uint256 value) external {
        uint256 bal = balanceOf[msg.sender];
        require(bal >= value, "ERC20: insufficient balance");
        unchecked { balanceOf[msg.sender] = bal - value; }
        totalSupply -= value;
        emit Transfer(msg.sender, address(0), value);
    }
`;
  }
  if (f.mintable) {
    extra += `
    function mint(address to, uint256 value) external onlyOwner {
        require(to != address(0), "ERC20: mint to zero address");` +
      (hasCap ? `
        require(totalSupply + value <= cap, "ERC20: cap exceeded");` : '') + `
        totalSupply += value;
        balanceOf[to] += value;
        emit Transfer(address(0), to, value);
    }
`;
  }
  if (extra) s = s.replace(/\n}$/, extra + '\n}');
  return s;
}

function erc721Source(f = {}) {
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
  if (f.burnable) {
    s = s.replace(`        return string(buffer);
    }
}`, `        return string(buffer);
    }

    function burn(uint256 id) external {
        address holder = ownerOf(id);
        require(msg.sender == holder, "ERC721: burn from non-owner");
        delete _owners[id];
        unchecked { _balances[holder] -= 1; }
        // totalSupply doubles as the next-id counter; burned ids are never reused.
        emit Transfer(holder, address(0), id);
    }
}`);
  }
  return s;
}

function erc1155Source(f = {}) {
  let s = ERC1155_SOURCE;
  if (f.mintable === false) {
    s = s.replace(`    function mint(address to, uint256 id, uint256 value) external onlyOwner {
        _move(address(0), to, id, value);
    }

`, '');
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
  return s;
}

// Compose the source the deploy step compiles. `buildTokenSource(id)` with
// no flags returns exactly the shipped template (default path = today).
export function buildTokenSource(standardId, flags = {}) {
  if (standardId === 'erc721') return erc721Source(flags);
  if (standardId === 'erc1155') return erc1155Source(flags);
  return erc20Source(flags);
}

// ── wizard metadata ──
export const STANDARDS = {
  erc20: {
    id: 'erc20',
    label: 'ERC-20 (fungible token)',
    contract: 'BearERC20',
    source: ERC20_SOURCE,
    preview: 'ERC-20 Token Contract',
    icon: '🪙',
    fields: [
      { id: 'deploySupply', label: 'Initial supply', type: 'number', placeholder: '1000000', value: '1000000' },
      { id: 'deployDecimals', label: 'Decimals', type: 'number', value: '18', min: 0, max: 18 },
      { id: 'deployCap', label: 'Cap (max supply, empty = unlimited)', type: 'number', placeholder: 'none' },
      // OZ order (ERC20Controls.svelte): Mintable → Burnable → Pausable.
      { id: 'deployMintable', label: 'Mintable (owner can mint more)', type: 'checkbox' },
      { id: 'deployBurnable', label: 'Burnable (holders can burn their own)', type: 'checkbox' },
      { id: 'deployPausable', label: 'Pausable (owner can pause transfers)', type: 'checkbox' }
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
      { id: 'deployMintable', label: 'Mintable (owner can mint)', type: 'checkbox', value: true },
      { id: 'deployBurnable', label: 'Burnable (holders can burn)', type: 'checkbox' }
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
      { id: 'deployBurnable', label: 'Burnable (holders can burn)', type: 'checkbox' }
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
  for (const f of std.fields) {
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
    flushPills();
    out.push(`
      <div class="field">
        <label for="${f.id}">${f.label}</label>
        <input class="input" id="${f.id}" type="${f.type}"
          ${f.placeholder ? `placeholder="${f.placeholder}"` : ''}
          ${f.value !== undefined ? `value="${f.value}"` : ''}
          ${f.min !== undefined ? `min="${f.min}"` : ''}
          ${f.max !== undefined ? `max="${f.max}"` : ''}>
      </div>`);
  }
  flushPills();
  return out.join('');
}

// Validate the form and return { name, symbol, args, flags } for the
// constructor. Throws Error with a user-facing message — the wizard shows it
// as-is. `flags` drives buildTokenSource (OZ-parity feature toggles).
export function buildDeployPlan({ standard, name, symbol, supply, decimals, baseUri, cap, burnable, mintable, pausable }) {
  const std = getStandard(standard);
  const cleanName = String(name || '').trim();
  const cleanSymbol = String(symbol || '').trim();
  if (!cleanName) throw new Error('Enter a token name');
  if (cleanName.length > 64) throw new Error('Name must be 64 characters or fewer');
  if (!cleanSymbol) throw new Error('Enter a token symbol');
  if (cleanSymbol.length > 16) throw new Error('Symbol must be 16 characters or fewer');
  if (!/^[A-Za-z0-9._-]+$/.test(cleanSymbol)) throw new Error('Symbol may only contain letters, digits, . _ -');

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
      cap: capRaw
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
    const on = [flags.burnable && 'Burnable', flags.mintable && 'Mintable', flags.pausable && 'Pausable'].filter(Boolean);
    if (on.length) summary.push({ k: 'Features', v: on.join(', ') });
    return { standard: std.id, name: cleanName, symbol: cleanSymbol, args, flags, summary };
  }

  const uri = String(baseUri || '').trim();
  // NFT standards: mintable defaults ON (their template has always minted);
  // unchecked → false, checked/absent → true.
  const nftFlags = { mintable: mintable !== false, burnable: Boolean(burnable) };
  const nftFeatures = [nftFlags.burnable && 'Burnable', nftFlags.mintable && 'Mintable'].filter(Boolean);
  if (std.id === 'erc721') {
    const summary = [
      { k: 'Standard', v: 'ERC-721' },
      { k: 'Name', v: cleanName },
      { k: 'Symbol', v: cleanSymbol },
      { k: 'Base URI', v: uri || '(empty)' }
    ];
    if (nftFeatures.length) summary.push({ k: 'Features', v: nftFeatures.join(', ') });
    return { standard: std.id, name: cleanName, symbol: cleanSymbol, args: [cleanName, cleanSymbol, uri], flags: nftFlags, summary };
  }
  const summary = [
    { k: 'Standard', v: 'ERC-1155' },
    { k: 'Name', v: cleanName },
    { k: 'Symbol', v: cleanSymbol },
    { k: 'Metadata URI', v: uri || '(empty)' }
  ];
  if (nftFeatures.length) summary.push({ k: 'Features', v: nftFeatures.join(', ') });
  return { standard: std.id, name: cleanName, symbol: cleanSymbol, args: [cleanName, cleanSymbol, uri], flags: nftFlags, summary };
}
