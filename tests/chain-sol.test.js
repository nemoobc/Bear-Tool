// tests/chain-sol.test.js — Solana message layout and signing.
//
// Built around ONE real mainnet transaction (slot 455795337), captured from a
// public RPC as base64:
//
//   AXybha68lrAkbcZS4X/zKu/UtRHOtriz7PUdLHlUyhv/fpJn8K7xb5YU6jozuHjckCXWt1WhyHRTzzbTm5F81AcBAAEDNqs6T+Hv6zgiPSk+nVarTLeYWrte5n/GC+wT8xUyU8J4Uhyxec67hYm1VqLV7JTSSYaC/fm7KvWtZOSRzEFT2gAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAuDMFXq78eSPJ/7ktHAGAJTNLWoh4zTMKPC6EPjiB9UwBAgIAAQwCAAAA6AMAAAAAAAA=
//
//   signature 3VVk9oT3LdgFqtuWo7TmiqMZ1Pd32R8jgBR1iGgPAtKe8T9acFqvxX8L72QXbjiE4fYuKqfQJccufKjGUGtpF4Qe
//   blockhash DQ396cE1gRbB5TCY3dj6rK4q4gTVEbMUPUWdu9hhDsgF
//   from      4gQT88rvHr6ay8XvmUUriL5FTjsSuvkvH8ybz3etVLBb   (writable signer)
//   to        96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5   (writable, not signer)
//   program   11111111111111111111111111111111               (read-only, not signer)
//   amount    1000 lamports
//
// A Solana address is the base58 of the 32-byte ed25519 public key, so the
// signature can be verified against the sender's ADDRESS — which means this
// file proves the entire wire format end to end: if the header, the account
// order, a length byte, the blockhash or the 12-byte payload were wrong, the
// message would differ and the published signature would not verify.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ethers } from 'ethers';

globalThis.ethers = ethers;
const sol = await import('../js/chain-sol.js');
const { ed25519Verify, solanaKeypair } = await import('../js/coin-trees.js');

const RAW_BASE64 = 'AXybha68lrAkbcZS4X/zKu/UtRHOtriz7PUdLHlUyhv/fpJn8K7xb5YU6jozuHjckCXWt1WhyHRTzzbTm5F81AcBAAEDNqs6T+Hv6zgiPSk+nVarTLeYWrte5n/GC+wT8xUyU8J4Uhyxec67hYm1VqLV7JTSSYaC/fm7KvWtZOSRzEFT2gAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAuDMFXq78eSPJ/7ktHAGAJTNLWoh4zTMKPC6EPjiB9UwBAgIAAQwCAAAA6AMAAAAAAAA=';
const SIGNATURE = '3VVk9oT3LdgFqtuWo7TmiqMZ1Pd32R8jgBR1iGgPAtKe8T9acFqvxX8L72QXbjiE4fYuKqfQJccufKjGUGtpF4Qe';
const BLOCKHASH = 'DQ396cE1gRbB5TCY3dj6rK4q4gTVEbMUPUWdu9hhDsgF';
const FROM = '4gQT88rvHr6ay8XvmUUriL5FTjsSuvkvH8ybz3etVLBb';
const TO = '96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5';
const PROGRAM = '11111111111111111111111111111111';
const LAMPORTS = 1000n;

const raw = sol.bytesFromBase64(RAW_BASE64);
const publishedSignature = raw.slice(1, 65);           // byte 0 is the signature count
const publishedMessage = raw.slice(65);
const publishedFromKey = sol.decodeSolAddress(FROM).publicKey;

test('the raw transaction splits the way a Solana node reads it', () => {
  assert.equal(raw[0], 1);                              // one signature
  assert.equal(sol.base58Encode(raw.slice(1, 65)), SIGNATURE);
  assert.equal(raw.length, 65 + publishedMessage.length);
});

test('the published message is rebuilt byte for byte from plain fields', () => {
  const rebuilt = sol.compileSolMessage({
    feePayer: FROM,
    instructions: [sol.systemTransferInstruction({ from: FROM, to: TO, lamports: LAMPORTS })],
    recentBlockhash: BLOCKHASH,
  });
  assert.equal(ethers.hexlify(rebuilt), ethers.hexlify(publishedMessage));
});

test('the header says one signer, no read-only signer, one read-only unsigned account', () => {
  assert.deepEqual([...publishedMessage.slice(0, 3)], [1, 0, 1]);
  assert.equal(publishedMessage[3], 3); // three account keys, compact-u16
});

test('the account keys are the sender, the receiver and the System Program, in that order', () => {
  const keys = publishedMessage.slice(4, 4 + 96);
  assert.equal(ethers.hexlify(keys.slice(0, 32)), ethers.hexlify(publishedFromKey));
  assert.equal(ethers.hexlify(keys.slice(32, 64)), ethers.hexlify(sol.decodeSolAddress(TO).publicKey));
  assert.equal(ethers.hexlify(keys.slice(64, 96)), ethers.hexlify(sol.decodeSolAddress(PROGRAM).publicKey));
  // the System Program really is 32 zero bytes
  assert.equal(ethers.hexlify(keys.slice(64, 96)), '0x' + '00'.repeat(32));
});

test('the blockhash sits right after the keys', () => {
  const at = 4 + 96;
  assert.equal(ethers.hexlify(publishedMessage.slice(at, at + 32)), ethers.hexlify(sol.decodeSolAddress(BLOCKHASH).publicKey));
});

test('the instruction is Transfer(2) for 1000 lamports, as 12 bytes', () => {
  // after header(3) + len(1) + keys(96) + blockhash(32) = 132
  const tail = publishedMessage.slice(132);
  assert.deepEqual([...tail.slice(0, 6)], [1, 2, 2, 0, 1, 12]); // 1 ix, program 2, 2 accounts [0,1], 12 data bytes
  assert.deepEqual([...tail.slice(6, 18)], [2, 0, 0, 0, 0xe8, 0x03, 0, 0, 0, 0, 0, 0]);
});

test('the PUBLISHED signature verifies over the rebuilt message with the sender address', () => {
  assert.equal(sol.base58Encode(publishedSignature), SIGNATURE);
  assert.equal(ed25519Verify(publishedFromKey, publishedMessage, publishedSignature), true);
  // and a single flipped byte must break it — a verifier that says yes to
  // everything would pass the line above and fail nothing else.
  const tampered = Uint8Array.from(publishedMessage);
  tampered[132 + 10] ^= 0x01;
  assert.equal(ed25519Verify(publishedFromKey, tampered, publishedSignature), false);
});

test('buildSolSend produces a transaction whose signature verifies', async () => {
  const seed = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
  const mine = solanaKeypair(seed, 0);
  const other = solanaKeypair(seed, 1);
  const built = sol.buildSolSend({
    privateKey: mine.privateKey,
    from: mine.address,
    to: other.address,
    lamports: 1000000n,
    recentBlockhash: BLOCKHASH,
  });
  const bytes = sol.bytesFromBase64(built.rawTransactionBase64);
  assert.equal(bytes[0], 1);
  const sig = bytes.slice(1, 65);
  const message = bytes.slice(65);
  assert.equal(ed25519Verify(sol.decodeSolAddress(mine.address).publicKey, message, sig), true);
  assert.equal(built.txid, built.signature);
  assert.equal(built.txid, sol.base58Encode(sig));
  // deterministic: same inputs, same bytes
  const again = sol.buildSolSend({ privateKey: mine.privateKey, from: mine.address, to: other.address, lamports: 1000000n, recentBlockhash: BLOCKHASH });
  assert.equal(again.rawTransactionBase64, built.rawTransactionBase64);
});

test('buildSolSend refuses an account this wallet does not control', async () => {
  const seed = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
  const mine = solanaKeypair(seed, 0);
  const other = solanaKeypair(seed, 1);
  assert.throws(() => sol.buildSolSend({
    privateKey: mine.privateKey, from: other.address, to: mine.address, lamports: 1000n, recentBlockhash: BLOCKHASH,
  }), /does not control the sending account/);
});

test('addresses: wrong length, junk and empty are refused', () => {
  assert.throws(() => sol.decodeSolAddress(''), /enter a destination/);
  assert.throws(() => sol.decodeSolAddress('not base58 0OIl'), /not a valid address/);
  assert.throws(() => sol.decodeSolAddress('1111'), /32 bytes/);   // four zero bytes
  assert.throws(() => sol.decodeSolAddress('abc'), /32 bytes/);
});

test('amounts are converted without floating point and refuse nonsense', () => {
  assert.equal(sol.solToLamports('1'), 1000000000n);
  assert.equal(sol.solToLamports('0.000000001'), 1n);
  assert.equal(sol.solToLamports('2.5'), 2500000000n);
  assert.equal(sol.lamportsToSol(2500000000n), '2.5');
  assert.equal(sol.lamportsToSol(1n), '0.000000001');
  assert.throws(() => sol.solToLamports('0.0000000001'), /9 decimal places/);
  assert.throws(() => sol.solToLamports('0'), /greater than zero/);
  assert.throws(() => sol.solToLamports('abc'), /enter an amount/);
});

test('a transaction with no instructions, no blockhash or no fee payer is refused', () => {
  const ix = sol.systemTransferInstruction({ from: FROM, to: TO, lamports: LAMPORTS });
  assert.throws(() => sol.compileSolMessage({ feePayer: FROM, instructions: [], recentBlockhash: BLOCKHASH }), /at least one instruction/);
  assert.throws(() => sol.compileSolMessage({ feePayer: FROM, instructions: [ix], recentBlockhash: '' }), /recent blockhash/);
  assert.throws(() => sol.compileSolMessage({ feePayer: '', instructions: [ix], recentBlockhash: BLOCKHASH }), /fee payer is required/);
  assert.throws(() => sol.systemTransferInstruction({ from: FROM, to: TO, lamports: 0 }), /greater than zero/);
});

test('compact-u16 matches the spec for both small and wide lengths', () => {
  assert.deepEqual([...sol.compactU16(0)], [0]);
  assert.deepEqual([...sol.compactU16(3)], [3]);
  assert.deepEqual([...sol.compactU16(127)], [127]);
  assert.deepEqual([...sol.compactU16(128)], [0x80, 0x01]);
  assert.deepEqual([...sol.compactU16(300)], [0xac, 0x02]);
  assert.throws(() => sol.compactU16(-1), /non-negative integer/);
});

test('duplicate accounts are listed once, with their flags merged', () => {
  // Sending to yourself: the payer appears as both signer and recipient.
  const message = sol.compileSolMessage({
    feePayer: FROM,
    instructions: [sol.systemTransferInstruction({ from: FROM, to: FROM, lamports: LAMPORTS })],
    recentBlockhash: BLOCKHASH,
  });
  assert.equal(message[3], 2); // FROM + program, not three keys
});
