// Shared solc entry for the Dex contract tests. Pinned to the app's browser
// loader version (0.8.37) so a source compiled in this suite is byte-wise the
// surface the app ships — if the pinned version moves, this gate moves with
// it, never silently above or below it.
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const solc = require('solc');

function compileRaw(source, fileName, names) {
  const input = JSON.stringify({
    language: 'Solidity',
    sources: { [fileName]: { content: source } },
    settings: {
      optimizer: { enabled: true, runs: 200 },
      outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object'] } },
    },
  });
  const out = JSON.parse(solc.compile(input));
  const errors = (out.errors || []).filter((e) => e.severity === 'error');
  if (errors.length) {
    throw new Error('compile: ' + errors.map((e) => e.formattedMessage).join('\n'));
  }
  const pick = {};
  for (const name of names) {
    const c = out.contracts[fileName][name];
    if (!c?.evm?.bytecode?.object) throw new Error(`compile: no bytecode for ${name}`);
    pick[name] = { abi: c.abi, bytecode: '0x' + c.evm.bytecode.object };
  }
  return pick;
}

export function compileDex(DEX_SOLIDITY) {
  return compileRaw(DEX_SOLIDITY, 'BearExchange.sol', ['BearToken', 'BearPair', 'BearFactory']);
}

// A favourite ERC-20 for the quote side, test chains only. mint() is public —
// it is a testing coin, never a Bear artifact.
export const MOCK_SRC = `// SPDX-License-Identifier: MIT
pragma solidity ^0.8.37;

contract MockERC20 {
    string public constant name = "Bearer Quote";
    string public constant symbol = "QC";
    uint8 public constant decimals = 18;
    uint256 public totalSupply;
    mapping(address => uint256) public balances;
    mapping(address => mapping(address => uint256)) public allowances;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);

    constructor() { }

    function mint(address to, uint256 value) external {
        totalSupply += value;
        balances[to] += value;
        emit Transfer(address(0), to, value);
    }

    function balanceOf(address o) external view returns (uint256) { return balances[o]; }
    function allowance(address o, address s) external view returns (uint256) { return allowances[o][s]; }

    function approve(address s, uint256 v) external returns (bool) {
        allowances[msg.sender][s] = v;
        emit Approval(msg.sender, s, v);
        return true;
    }

    function transfer(address to, uint256 v) external returns (bool) {
        balances[msg.sender] -= v;
        balances[to] += v;
        emit Transfer(msg.sender, to, v);
        return true;
    }

    function transferFrom(address from, address to, uint256 v) external returns (bool) {
        uint256 a = allowances[from][msg.sender];
        if (a != type(uint256).max) {
            require(a >= v, "QC/ALLOWANCE");
            allowances[from][msg.sender] = a - v;
        }
        balances[from] -= v;
        balances[to] += v;
        emit Transfer(from, to, v);
        return true;
    }
}
`;

export function compileMock() {
  return compileRaw(MOCK_SRC, 'MockERC20.sol', ['MockERC20']);
}
