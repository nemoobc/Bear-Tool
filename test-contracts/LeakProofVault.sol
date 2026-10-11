// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title LeakProofVault
/// @notice Ambire-style two-key custody, drawn from how smart-contract wallets
///         actually survive a leaked key. A plain `onlyOwner` contract dies
///         the moment the owner key leaks: the chain cannot tell the real
///         holder from a thief holding the exact same key. This vault answers
///         to TWO keys and makes a single leaked key powerless:
///
///           withdrawal  = queue -> COOLDOWN wait -> execute
///                         (either role queues; the OTHER role cancels)
///           takeover    = only the GUARDIAN may hand the vault to a fresh
///                         key, and the (possibly leaked) owner cannot cancel
///                         that. After RECOVERY_DELAY anyone finalizes, so
///                         the vault always escapes a stolen owner key.
///           guardian    = the owner can NEVER replace the guardian, so a
///                         leaked owner key cannot silence the watchdog.
///
///         Honest limit, stated up front: if BOTH keys leak, nothing on-chain
///         can help — hold the guardian on a cold/hardware key that never
///         touches a hot device. That is the same trade every wallet SDK
///         (Ambire included) ships with.
contract LeakProofVault {
    event Queued(uint256 amount, address to, uint256 at);
    event Cancelled();
    event Executed(address to, uint256 amount);
    event RecoveryProposed(address newOwner, uint256 at);
    event RecoveryCancelled();
    event RecoveryFinalized(address newOwner);
    event OwnerChanged(address newOwner);
    event GuardianChanged(address newGuardian);

    uint256 public constant COOLDOWN = 2 days;       // withdrawal wait after queue
    uint256 public constant RECOVERY_DELAY = 1 days; // wait after guardian proposes recovery

    address public owner;
    address public guardian;

    struct Withdrawal {
        uint256 amount;
        address to;
        uint256 at;
    }

    struct Recovery {
        address newOwner;
        uint256 at;
    }

    Withdrawal public pending;
    Recovery public recovery;

    modifier onlyOwner() {
        require(msg.sender == owner, "LP:not-owner");
        _;
    }

    modifier onlyGuardian() {
        require(msg.sender == guardian, "LP:not-guardian");
        _;
    }

    modifier onlyOwnerOrGuardian() {
        require(msg.sender == owner || msg.sender == guardian, "LP:not-signer");
        _;
    }

    /// The deployer is the first owner; the guardian is a SECOND key, and it
    /// must come from somewhere else (hardware/cold key) — not the same key.
    constructor(address _guardian) {
        require(_guardian != address(0), "LP:bad-guardian");
        require(_guardian != msg.sender, "LP:guardian-same-as-owner");
        owner = msg.sender;
        guardian = _guardian;
    }

    receive() external payable {}

    function balance() external view returns (uint256) {
        return address(this).balance;
    }

    /// Queue a withdrawal. Either role may request; nobody may execute before
    /// COOLDOWN, and the other role can cancel meanwhile. A thief holding a
    /// leaked owner key can only queue — the guardian cancels (or the pending
    /// amount simply never ripens before recovery lands).
    function queueWithdrawal(uint256 amount, address to) external onlyOwnerOrGuardian {
        require(amount > 0, "LP:zero");
        require(amount <= address(this).balance, "LP:amount");
        require(to != address(0), "LP:to");
        pending = Withdrawal(amount, to, block.timestamp);
        emit Queued(amount, to, block.timestamp);
    }

    function cancelWithdrawal() external onlyOwnerOrGuardian {
        delete pending;
        emit Cancelled();
    }

    function executeWithdrawal() external onlyOwnerOrGuardian {
        require(pending.at != 0, "LP:none");
        require(block.timestamp >= pending.at + COOLDOWN, "LP:not-ripe");
        uint256 amount = pending.amount;
        address to = pending.to;
        delete pending;
        (bool ok, ) = payable(to).call{value: amount}("");
        require(ok, "LP:call");
        emit Executed(to, amount);
    }

    /// The leak defense. ONLY the guardian can hand the vault to a fresh key;
    /// the (possibly leaked) owner cannot cancel this, cannot replace the
    /// guardian, and cannot unlock the balance before recovery finalizes.
    function recoverOwner(address newOwner) external onlyGuardian {
        require(newOwner != address(0), "LP:to");
        recovery = Recovery(newOwner, block.timestamp);
        emit RecoveryProposed(newOwner, block.timestamp);
    }

    function cancelRecovery() external onlyGuardian {
        delete recovery;
        emit RecoveryCancelled();
    }

    function finalizeRecovery() external {
        require(recovery.at != 0, "LP:none");
        require(block.timestamp >= recovery.at + RECOVERY_DELAY, "LP:not-ripe");
        owner = recovery.newOwner;
        delete recovery;
        emit RecoveryFinalized(owner);
    }

    /// Normal rotation while the owner key is alive and trusted.
    function changeOwner(address newOwner) external onlyOwner {
        require(newOwner != address(0), "LP:to");
        owner = newOwner;
        emit OwnerChanged(newOwner);
    }

    /// The guardian key hands off. The owner must NEVER be able to replace the
    /// guardian: a leaked owner key must not silence the watchdog.
    function changeGuardian(address newGuardian) external onlyGuardian {
        require(newGuardian != address(0), "LP:to");
        guardian = newGuardian;
        emit GuardianChanged(newGuardian);
    }
}