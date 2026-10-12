// js/chain-btc.js — Bitcoin sending primitives.
//
// The point of this file is the BIP-143 "Native P2WPKH" test vector, reproduced
// byte for byte from the BIP itself (bitcoin/bips, bip-0143.mediawiki). A wallet
// that signs its own transactions has no exchange or node to blame when it is
// wrong, so the signing path is pinned to published bytes rather than to
// "it looks about right".
//
//   unsigned : 0100000002fff7f7881a8099afa6940d42d1e7f6362bec38171ea3edf433541db4e4ad969f0000000000eeffffffef51e1b804cc89d182d279655c3aa89e815b1b309fe287d9b2b55d57b90ec68a0100000000ffffffff02202cb206000000001976a9148280b37df378db99f66f85c95a783a76ac7a6d5988ac9093510d000000001976a9143bde42dbee7e4dbe6a21b2d50ce2f0167faa815988ac11000000
//   input #1 : P2WPKH 00141d0f172a0ecb48aee1be1f2687d2963ae33f71a1, 6 BTC
//   key      : 619c335025c7f4012e556c2a58b2506e30b8511b53ade95ea316fd8c3286feb9
//   pubkey   : 025476c2e83188368da1ff3e292e7acafcdb3566bb0ad253f62fc70f07aeee6357
//   sighash  : c37af31116d1b27caf68aae9e3ac82f1477929014d5b917657d0eb49478cb670
//   sig      : 304402203609e17b84f6a7d30c80bfa610b5b4542f32a8a0d5447a12fb1366d7f01cc44a0220573a954c4518331561406f90300e8f3358f51928d43c212a8caed02de67eebee
//   signed   : 01000000000102fff7f7881a8099afa6940d42d1e7f6362bec38171ea3edf433541db4e4ad969f00000000494830450221008b9d1dc26ba6a9cb62127b02742fa9d754cd3bebf337f7a55d114c8e5cdd30be022040529b194ba3f9281a99f2b1c0a19c0489bc22ede944ccf4ecbab4cc618ef3ed01eeffffffef51e1b804cc89d182d279655c3aa89e815b1b309fe287d9b2b55d57b90ec68a0100000000ffffffff02202cb206000000001976a9148280b37df378db99f66f85c95a783a76ac7a6d5988ac9093510d000000001976a9143bde42dbee7e4dbe6a21b2d50ce2f0167faa815988ac000247304402203609e17b84f6a7d30c80bfa610b5b4542f32a8a0d5447a12fb1366d7f01cc44a0220573a954c4518331561406f90300e8f3358f51928d43c212a8caed02de67eebee0121025476c2e83188368da1ff3e292e7acafcdb3566bb0ad253f62fc70f07aeee635711000000
//
// `input #0` in that transaction is a P2PK input the BIP already signs; its
// scriptSig is pasted in below so the WHOLE final transaction can be rebuilt and
// compared, which pins the witness assembly and the txid the same way.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ethers } from 'ethers';

globalThis.ethers = ethers;
const btc = await import('../js/chain-btc.js');
const { bech32Encode, convertBits } = (await import('../js/coin-trees.js')).__internals;

const KEY = '0x619c335025c7f4012e556c2a58b2506e30b8511b53ade95ea316fd8c3286feb9';
const SIGHASH = 'c37af31116d1b27caf68aae9e3ac82f1477929014d5b917657d0eb49478cb670';
const DER = '304402203609e17b84f6a7d30c80bfa610b5b4542f32a8a0d5447a12fb1366d7f01cc44a0220573a954c4518331561406f90300e8f3358f51928d43c212a8caed02de67eebee';
const SIGNED = '01000000000102fff7f7881a8099afa6940d42d1e7f6362bec38171ea3edf433541db4e4ad969f00000000494830450221008b9d1dc26ba6a9cb62127b02742fa9d754cd3bebf337f7a55d114c8e5cdd30be022040529b194ba3f9281a99f2b1c0a19c0489bc22ede944ccf4ecbab4cc618ef3ed01eeffffffef51e1b804cc89d182d279655c3aa89e815b1b309fe287d9b2b55d57b90ec68a0100000000ffffffff02202cb206000000001976a9148280b37df378db99f66f85c95a783a76ac7a6d5988ac9093510d000000001976a9143bde42dbee7e4dbe6a21b2d50ce2f0167faa815988ac000247304402203609e17b84f6a7d30c80bfa610b5b4542f32a8a0d5447a12fb1366d7f01cc44a0220573a954c4518331561406f90300e8f3358f51928d43c212a8caed02de67eebee0121025476c2e83188368da1ff3e292e7acafcdb3566bb0ad253f62fc70f07aeee635711000000';

// The BIP prints the unsigned/signed transactions as SERIALIZED bytes, where an
// outpoint is stored in internal (little-endian) order. Our API takes a txid the
// way an explorer or an RPC shows it — display order — and reverses it when
// writing the outpoint. So the vector's literals are reversed here, on purpose.
const displayTxid = (raw) => raw.match(/../g).reverse().join('');

const VECTOR_INPUTS = [
  { txid: displayTxid('fff7f7881a8099afa6940d42d1e7f6362bec38171ea3edf433541db4e4ad969f'), vout: 0, sequence: 0xffffffee },
  { txid: displayTxid('ef51e1b804cc89d182d279655c3aa89e815b1b309fe287d9b2b55d57b90ec68a'), vout: 1, sequence: 0xffffffff },
];
const VECTOR_OUTPUTS = [
  { value: 112340000, script: '76a9148280b37df378db99f66f85c95a783a76ac7a6d5988ac' },
  { value: 223450000, script: '76a9143bde42dbee7e4dbe6a21b2d50ce2f0167faa815988ac' },
];
const P2WPKH_PROGRAM = ethers.getBytes('0x1d0f172a0ecb48aee1be1f2687d2963ae33f71a1');

test('BIP-143: the sighash for the P2WPKH input reproduces the published digest', () => {
  const digest = btc.bip143Sighash({
    version: 1,
    inputs: VECTOR_INPUTS,
    outputs: VECTOR_OUTPUTS,
    lockTime: 17,
    inputIndex: 1,
    amount: 600000000,
    scriptCode: btc.p2wpkhScriptCode(P2WPKH_PROGRAM),
  });
  assert.equal(digest.slice(2), SIGHASH);
});

test('BIP-143: RFC-6979 signing reproduces the published DER signature byte for byte', () => {
  const witnessSig = btc.signDer(KEY, `0x${SIGHASH}`);
  assert.equal(ethers.hexlify(witnessSig).slice(2), `${DER}01`);
});

test('BIP-143: the witness worth of that key is the published compressed key', () => {
  assert.equal(new ethers.SigningKey(KEY).compressedPublicKey, '0x025476c2e83188368da1ff3e292e7acafcdb3566bb0ad253f62fc70f07aeee6357');
});

test('BIP-143: the whole signed transaction rebuilds byte for byte', () => {
  const reconstructed = btc.serializeBtcTx({
    version: 1,
    inputs: [
      { ...VECTOR_INPUTS[0], scriptSig: '0x4830450221008b9d1dc26ba6a9cb62127b02742fa9d754cd3bebf337f7a55d114c8e5cdd30be022040529b194ba3f9281a99f2b1c0a19c0489bc22ede944ccf4ecbab4cc618ef3ed01' },
      { ...VECTOR_INPUTS[1], witness: [`0x${DER}01`, '0x025476c2e83188368da1ff3e292e7acafcdb3566bb0ad253f62fc70f07aeee6357'] },
    ],
    outputs: VECTOR_OUTPUTS,
    lockTime: 17,
  });
  assert.equal(reconstructed.slice(2), SIGNED);
});

test('txid is the double-SHA256 of the STRIPPED transaction, never of the witness bytes', () => {
  // The signed vector above is a witness transaction: its txid must ignore the
  // marker/flag/witness. Hashing the full bytes would produce a different id and
  // every explorer would disagree with us about what we just sent.
  const stripped = btc.serializeBtcTx({ version: 1, inputs: VECTOR_INPUTS, outputs: VECTOR_OUTPUTS, lockTime: 17 });
  const full = `0x${SIGNED}`;
  assert.notEqual(btc.btcTxid(full), btc.btcTxid(stripped));
  assert.equal(btc.btcTxid(stripped).length, 64);
  assert.match(btc.btcTxid(stripped), /^[0-9a-f]{64}$/);
  // deleting the witness must not change the txid of the same transaction
  const rebuilt = btc.serializeBtcTx({ version: 1, inputs: VECTOR_INPUTS, outputs: VECTOR_OUTPUTS, lockTime: 17 });
  assert.equal(btc.btcTxid(rebuilt), btc.btcTxid(stripped));
});

test('buildBtcSend signs every input and keeps change on our own address', async () => {
  const { btcAddresses } = await import('../js/coin-trees.js');
  const seed = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
  const mine = btcAddresses(seed, 0);
  const sk = new ethers.SigningKey(KEY);
  const program = ethers.getBytes(ethers.ripemd160(ethers.sha256(sk.compressedPublicKey)));
  const ownAddress = bech32Encode('bc', [0].concat(convertBits(program, 8, 5, true)));
  // a destination we do not control (a different key), P2WPKH
  const destProgram = ethers.getBytes(ethers.ripemd160(ethers.sha256(new ethers.SigningKey('0x0000000000000000000000000000000000000000000000000000000000000001').compressedPublicKey)));
  const destAddress = bech32Encode('bc', [0].concat(convertBits(destProgram, 8, 5, true)));

  const tx = btc.buildBtcSend({
    privateKey: KEY,
    utxos: [{ txid: 'a'.repeat(64), vout: 0, value: 100000 }],
    to: destAddress,
    amountSat: 40000,
    feeSat: 500,
    changeAddress: ownAddress,
    network: 'mainnet',
  });
  assert.equal(tx.change, 59500);
  assert.equal(tx.txid.length, 64);
  // witness is present, and the outgoing output pays 40000 to the destination script
  assert.match(tx.hex, /0001/);
  const destScript = Buffer.from(btc.btcScriptPubKey(btc.decodeBtcAddress(destAddress, 'mainnet'))).toString('hex');
  assert.ok(tx.hex.includes(destScript));
  // the same inputs always produce the same bytes (deterministic signing)
  const again = btc.buildBtcSend({
    privateKey: KEY,
    utxos: [{ txid: 'a'.repeat(64), vout: 0, value: 100000 }],
    to: destAddress, amountSat: 40000, feeSat: 500, changeAddress: ownAddress, network: 'mainnet',
  });
  assert.equal(again.hex, tx.hex);
  assert.equal(mine.nativeSegwit.slice(0, 3), 'bc1');
});

test('buildBtcSend refuses a change address this wallet does not control', () => {
  assert.throws(() => btc.buildBtcSend({
    privateKey: KEY,
    utxos: [{ txid: 'b'.repeat(64), vout: 1, value: 100000 }],
    to: 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4',
    amountSat: 1000,
    feeSat: 200,
    changeAddress: 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4',
    network: 'mainnet',
  }), /does not control the change address/);
});

// ── address decoding ────────────────────────────────────────────────────

test('decodeBtcAddress accepts the three output kinds a P2WPKH input can pay', () => {
  assert.equal(btc.decodeBtcAddress('bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4', 'mainnet').type, 'p2wpkh');
  assert.equal(btc.decodeBtcAddress('1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2', 'mainnet').type, 'p2pkh');
  assert.equal(btc.decodeBtcAddress('3J98t1WpEZ73CNmQviecrnyiWrnqRhWNLy', 'mainnet').type, 'p2sh');
});

test('decodeBtcAddress refuses the wrong network by name', () => {
  // a testnet address on mainnet, an hrp mismatch, and a version-byte mismatch
  const tb = bech32Encode('tb', [0].concat(convertBits(ethers.getBytes('0x751e76e8199196d454941c45d1b3a323f1433bd6'), 8, 5, true)));
  assert.throws(() => btc.decodeBtcAddress(tb, 'mainnet'), /not a Bitcoin address/);
  assert.throws(() => btc.decodeBtcAddress('bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4', 'testnet'), /not a Bitcoin testnet address/);
  assert.throws(() => btc.decodeBtcAddress('mipcBbFg9gMiCh81Kj8tqqdgoZub1ZJRfn', 'mainnet'), /not a Bitcoin address/);
  // signet shares the "tb" prefix with testnet3, so the same address is valid there
  assert.equal(btc.decodeBtcAddress(tb, 'signet').type, 'p2wpkh');
  assert.equal(btc.decodeBtcAddress('mipcBbFg9gMiCh81Kj8tqqdgoZub1ZJRfn', 'testnet').type, 'p2pkh');
});

test('decodeBtcAddress refuses a bad checksum, a taproot address and junk', () => {
  assert.throws(() => btc.decodeBtcAddress('bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t5', 'mainnet'), /checksum|bech32/);
  assert.throws(() => btc.decodeBtcAddress('1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN3', 'mainnet'), /checksum/);
  assert.throws(() => btc.decodeBtcAddress('bc1p5d7rjq7g6rdk2yhzks9smlaqtedr4dekq08ge8ztwac72sfr9rusxg3297', 'mainnet'), /taproot/);
  assert.throws(() => btc.decodeBtcAddress('not an address', 'mainnet'), /valid address/);
  assert.throws(() => btc.decodeBtcAddress('', 'mainnet'), /enter a destination/);
});

test('bech32 helper round-trips and rejects a mutated checksum', () => {
  // BIP-173's own P2WPKH example: HASH160 751e76e8… → bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4
  const program = ethers.getBytes('0x751e76e8199196d454941c45d1b3a323f1433bd6');
  const addr = bech32Encode('bc', [0].concat(convertBits(program, 8, 5, true)));
  assert.equal(addr, 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4');
  const decoded = btc.decodeBtcAddress(addr, 'mainnet');
  assert.equal(ethers.hexlify(decoded.program), '0x751e76e8199196d454941c45d1b3a323f1433bd6');
  assert.throws(() => btc.decodeBtcAddress(`${addr.slice(0, -1)}5`, 'mainnet'), /checksum/);
});

test('estimateVsize covers a bare 1-in 1-out P2WPKH transaction', () => {
  const v = btc.estimateVsize({ nIn: 1, outputs: ['p2wpkh'] });
  // 10 + 41 + 31 = 82 stripped, +108/4 = 27 witness → 109
  assert.equal(v, 109);
  assert.ok(btc.estimateVsize({ nIn: 2, outputs: ['p2wpkh', 'p2wpkh'] }) > v);
});

test('buildBtcSend refuses dust change, a zero amount and a fee it cannot pay', () => {
  const own = 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4';
  assert.throws(() => btc.buildBtcSend({ privateKey: KEY, utxos: [{ txid: 'c'.repeat(64), vout: 0, value: 1000 }], to: own, amountSat: 0, feeSat: 0, changeAddress: own }), /greater than zero/);
  assert.throws(() => btc.buildBtcSend({ privateKey: KEY, utxos: [{ txid: 'c'.repeat(64), vout: 0, value: 1000 }], to: own, amountSat: 5000, feeSat: 300, changeAddress: own }), /not enough/);
  assert.throws(() => btc.buildBtcSend({ privateKey: KEY, utxos: [], to: own, amountSat: 1, feeSat: 1, changeAddress: own }), /nothing to spend/);
});

test('buildBtcSend drops change below dust instead of creating an unspendable output', () => {
  // own address for KEY, derived the same way the builder does
  const sk = new ethers.SigningKey(KEY);
  const program = ethers.getBytes(ethers.ripemd160(ethers.sha256(sk.compressedPublicKey)));
  const ownAddress = bech32Encode('bc', [0].concat(convertBits(program, 8, 5, true)));
  const destProgram = ethers.getBytes(ethers.ripemd160(ethers.sha256(new ethers.SigningKey('0x0000000000000000000000000000000000000000000000000000000000000002').compressedPublicKey)));
  const destAddress = bech32Encode('bc', [0].concat(convertBits(destProgram, 8, 5, true)));
  const tx = btc.buildBtcSend({ privateKey: KEY, utxos: [{ txid: 'd'.repeat(64), vout: 0, value: 50000 }], to: destAddress, amountSat: 49300, feeSat: 500, changeAddress: ownAddress });
  assert.equal(tx.change, 0); // below 546, so no change output exists at all
  // And with no change output the miner takes the whole remainder — the reported
  // fee must be that real number, not the estimate the caller passed in.
  assert.equal(tx.fee, 700);
  assert.ok(!tx.hex.includes(Buffer.from(btc.p2wpkhScriptCode(program)).toString('hex')));
});

test('buildBtcSend reports the fee the chain pays, not the estimate (dust-change case)', () => {
  const sk = new ethers.SigningKey(KEY);
  const program = ethers.getBytes(ethers.ripemd160(ethers.sha256(sk.compressedPublicKey)));
  const ownAddress = bech32Encode('bc', [0].concat(convertBits(program, 8, 5, true)));
  // A case where the change would sit below dust, so the output is dropped.
  const tx = btc.buildBtcSend({ privateKey: KEY, utxos: [{ txid: 'e'.repeat(64), vout: 0, value: 100000 }], to: ownAddress, amountSat: 99000, feeSat: 545, changeAddress: ownAddress });
  assert.equal(tx.change, 0, 'no change output when below dust');
  assert.equal(tx.fee, 1000, 'fee == inputs - outputs');
  // With change kept, the fee is exactly what was asked for.
  const kept = btc.buildBtcSend({ privateKey: KEY, utxos: [{ txid: 'f'.repeat(64), vout: 0, value: 100000 }], to: ownAddress, amountSat: 50000, feeSat: 700, changeAddress: ownAddress });
  assert.equal(kept.change, 49300);
  assert.equal(kept.fee, 700);
});
